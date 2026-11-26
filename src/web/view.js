// 2.5D 等距视图。只读：只从 /api 拉取状态并绘制。
// 视图操作：滚轮缩放、拖动平移、Q/E 旋转、按钮与快捷键重置/居中。
const canvas = document.getElementById('view');
const ctx = canvas.getContext('2d');
const statusEl = document.getElementById('status');
const logEl = document.getElementById('log');
const zoomEl = document.getElementById('zoomLabel');

let state = null;
let lastSeq = 0;
const ripples = []; // { x, y, z, start, range, text, clarity }
const BASE_TILE = 14; // 缩放为 1 时每格屏幕像素
const ZOOM_MIN = 0.3;
const ZOOM_MAX = 4;

// 可调设置，保存在本地浏览器（localStorage），由设置面板修改
const DEFAULT_SETTINGS = {
  showGrid: true, // 地板网格
  showDaylight: true, // 昼夜与季节色调
  showClock: true, // 左下角时钟与季节标签
  showNames: true, // 居民名字
  showMoodGlow: true, // 心情光晕
  bubbleMs: 2500, // 说话气泡显示时长
  moveMs: 450, // 居民移动动画时长
  replaySpeed: 1, // 回放速度倍率
  logLimit: 20, // 侧栏保留的事件条数
};
const settings = loadSettings();

function loadSettings() {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem('snowdomeSettings') || '{}') };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings() {
  localStorage.setItem('snowdomeSettings', JSON.stringify(settings));
}

// 视图状态：缩放、平移（屏幕像素）、旋转（0-3，每次 90°）
const view = { zoom: 1, panX: 0, panY: 0, rot: 0 };
let follow = null; // 跟随的居民 id，null 表示不跟随

// 居民移动动画：每次移动从当前显示位置滑到新格子；连续移动会排队，不会跳过中间步。
const visuals = new Map(); // actorId -> { fx, fy, tx, ty, start, end }

// 算出居民此刻的显示位置（小数坐标）
function actorPos(a, now) {
  const v = visuals.get(a.id);
  if (!v) return { x: a.position.x, y: a.position.y };
  const t = Math.min(1, Math.max(0, (now - v.start) / settings.moveMs));
  const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  return {
    x: v.fx + (v.tx - v.fx) * e,
    y: v.fy + (v.ty - v.fy) * e,
  };
}

function queueMove(a, to) {
  const now = Date.now();
  const prev = visuals.get(a.id);
  const from = prev ? { x: prev.tx, y: prev.ty } : { x: a.position.x, y: a.position.y };
  const start = prev ? Math.max(now, prev.end) : now;
  visuals.set(a.id, { fx: from.x, fy: from.y, tx: to.x, ty: to.y, start, end: start + settings.moveMs });
}

// 把世界坐标按当前旋转转换为等距平面坐标
function rotate(x, y) {
  const { sizeX, sizeY } = state.bounds;
  switch (view.rot) {
    case 1: return [y, sizeX - 1 - x];
    case 2: return [sizeX - 1 - x, sizeY - 1 - y];
    case 3: return [sizeY - 1 - y, x];
    default: return [x, y];
  }
}

function tile() {
  return BASE_TILE * view.zoom;
}

// 屏幕上越靠下、越靠近观察者，越晚绘制
function depth(x, y, z) {
  const [rx, ry] = rotate(x, y);
  return rx + ry + z;
}

function project(x, y, z) {
  const T = tile();
  const [rx, ry] = rotate(x, y);
  const sx = (rx - ry) * T * 0.866;
  const sy = (rx + ry) * T * 0.5 - z * T;
  return [sx, sy];
}

// 格子 (x,y) 在地面(z=0)的菱形中心：drawFloor 以 project(x,y,0) 为菱形顶点。
function cellCenter(x, y, z) {
  const [sx, sy] = project(x, y, z);
  return [sx, sy + tile() * 0.5];
}

// 画布像素尺寸只在窗口变化时调整，避免布局反复放大。
function resize() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = canvas.clientWidth * dpr;
  canvas.height = canvas.clientHeight * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
resize();
window.addEventListener('resize', resize);

// 屏幕原点：把玻璃球中心放到画布中心，再加上用户平移量
function origin() {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  const b = state.bounds;
  const T = tile();
  const [cx, cy] = project((b.sizeX - 1) / 2, (b.sizeY - 1) / 2, b.sizeZ / 2);
  return [w / 2 - cx + view.panX, h / 2 - cy + view.panY];
}

// 屏幕坐标 -> 世界格子：project 的逆变换，在 z = level 的平面上求解，再还原旋转。
function screenToCell(clientX, clientY, level) {
  const rect = canvas.getBoundingClientRect();
  const [ox, oy] = origin();
  const T = tile();
  const px = clientX - rect.left - ox;
  const py = clientY - rect.top - oy + level * T;
  const a = px / (T * 0.866);
  const b = py / (T * 0.5);
  const rx = (a + b) / 2;
  const ry = (b - a) / 2;
  const { sizeX, sizeY } = state.bounds;
  switch (view.rot) {
    case 1: return { x: sizeX - 1 - ry, y: rx };
    case 2: return { x: sizeX - 1 - rx, y: sizeY - 1 - ry };
    case 3: return { x: ry, y: sizeY - 1 - rx };
    default: return { x: rx, y: ry };
  }
}

// 点击地图：目标格取整；若超出每步距离则拆成多段，逐段发送（服务端每次最多 MAX_MOVE_STEP 格）。
const STEP_LIMIT = 3;
let walking = false;

// 逐段发送：以每次回执的 position 为准推进，不等待 WebSocket 推送。
async function walkTo(target) {
  if (walking) return;
  walking = true;
  try {
    let pos = { x: visitorPos.x, y: visitorPos.y, z: visitorPos.z };
    while (pos.x !== target.x || pos.y !== target.y) {
      const dx = target.x - pos.x;
      const dy = target.y - pos.y;
      const next = {
        x: pos.x + Math.sign(dx) * Math.min(Math.abs(dx), STEP_LIMIT),
        y: pos.y + Math.sign(dy) * Math.min(Math.abs(dy), STEP_LIMIT),
        z: pos.z,
      };
      const receipt = await sendIntent({ kind: 'move', target: next });
      // 被拒绝（墙、占用、自留地等）则停止后续步骤
      if (!receipt || receipt.accepted === false || !receipt.position) break;
      pos = { ...receipt.position };
    }
  } finally {
    walking = false;
  }
}

function handleCanvasClick(e) {
  if (!state || !visitorPos) return setLoginMsg('请先登录并等待位置');
  const cell = screenToCell(e.clientX, e.clientY, 1);
  const target = { x: Math.round(cell.x), y: Math.round(cell.y), z: visitorPos.z };
  const b = state.bounds;
  if (target.x < 0 || target.y < 0 || target.x >= b.sizeX || target.y >= b.sizeY) return;
  if (target.x === visitorPos.x && target.y === visitorPos.y) return;
  walkTo(target);
}

// 房间配色：按房间编号轮流取色，便于区分
const ROOM_COLORS = ['#16283a', '#1d2f2a', '#2c2238', '#2e2a1c'];

function drawFloor(ox, oy) {
  const b = state.bounds;
  const T = tile();
  for (let x = 0; x < b.sizeX; x++) {
    for (let y = 0; y < b.sizeY; y++) {
      const [sx, sy] = project(x, y, 0);
      const px = ox + sx;
      const py = oy + sy;
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(px + T * 0.866, py + T * 0.5);
      ctx.lineTo(px, py + T);
      ctx.lineTo(px - T * 0.866, py + T * 0.5);
      ctx.closePath();
      // rooms 为三维展平数组，地板只取 z=0 层
      const room = state.rooms ? state.rooms[x + b.sizeX * y] : 0;
      ctx.fillStyle = ROOM_COLORS[room % ROOM_COLORS.length] ?? '#16283a';
      ctx.fill();
      if (settings.showGrid) {
        ctx.strokeStyle = '#1f3850';
        ctx.stroke();
      }
    }
  }
}

// 自留地铺在小镇外圈：用暖色底色区分，东南角标出后院入口
function drawPlots(ox, oy) {
  if (!state.plots) return;
  const T = tile();
  for (const p of state.plots) {
    for (let dx = 0; dx < p.size; dx++) {
      for (let dy = 0; dy < p.size; dy++) {
        const [sx, sy] = project(p.x0 + dx, p.y0 + dy, 0);
        const px = ox + sx;
        const py = oy + sy;
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.lineTo(px + T * 0.866, py + T * 0.5);
        ctx.lineTo(px, py + T);
        ctx.lineTo(px - T * 0.866, py + T * 0.5);
        ctx.closePath();
        ctx.fillStyle = p.holder ? '#3a3024' : '#2a3320';
        ctx.fill();
      }
    }
    const [gx, gy] = project(p.gate.x, p.gate.y, 0);
    ctx.fillStyle = '#f5c26b';
    ctx.beginPath();
    ctx.arc(ox + gx, oy + gy + T * 0.5, T * 0.22, 0, Math.PI * 2);
    ctx.fill();
  }
}

// 玩家建造的方块按放置者着色；场景原有的墙用默认颜色
const OWNER_PALETTE = [
  ['#e8a87c', '#b5714a', '#94583a'],
  ['#9bd39a', '#6aa369', '#557f54'],
  ['#c9a7e8', '#9470b8', '#7a5a9a'],
  ['#f0d870', '#b8a04e', '#9a8440'],
];
const DEFAULT_BLOCK = ['#8fa9c2', '#3f566c', '#4c6781'];

function ownerColors(actorId) {
  if (!state || !state.owners) return DEFAULT_BLOCK;
  const o = state.owners.find((x) => x.actorId === actorId);
  if (!o) return DEFAULT_BLOCK;
  const idx = state.actors.findIndex((a) => a.id === actorId);
  return OWNER_PALETTE[Math.max(0, idx) % OWNER_PALETTE.length];
}

function blockOwner(x, y, z) {
  if (!state || !state.owners) return null;
  const o = state.owners.find((c) => c.x === x && c.y === y && c.z === z);
  return o ? o.actorId : null;
}

function drawBlock(x, y, z, ox, oy) {
  const T = tile();
  const [sx, sy] = project(x, y, z + 1);
  const px = ox + sx;
  const py = oy + sy;
  const hw = T * 0.866;
  const hh = T * 0.5;
  const H = T;
  const [topColor, leftColor, rightColor] = ownerColors(blockOwner(x, y, z));
  // 顶面、左面、右面三段绘制
  ctx.fillStyle = topColor;
  ctx.beginPath();
  ctx.moveTo(px, py);
  ctx.lineTo(px + hw, py + hh);
  ctx.lineTo(px, py + 2 * hh);
  ctx.lineTo(px - hw, py + hh);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = leftColor;
  ctx.beginPath();
  ctx.moveTo(px - hw, py + hh);
  ctx.lineTo(px, py + 2 * hh);
  ctx.lineTo(px, py + 2 * hh + H);
  ctx.lineTo(px - hw, py + hh + H);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = rightColor;
  ctx.beginPath();
  ctx.moveTo(px + hw, py + hh);
  ctx.lineTo(px, py + 2 * hh);
  ctx.lineTo(px, py + 2 * hh + H);
  ctx.lineTo(px + hw, py + hh + H);
  ctx.closePath();
  ctx.fill();
}

// 同一格的居民：圆点只画一次，名字纵向错开排列，避免文字叠成一团。
const LABEL_MAX_PER_TILE = 4;
function drawActorGroup(group, ox, oy, now) {
  const first = actorPos(group[0], now);
  // 圆点最下沿对齐所在格子的菱形中心，圆心因此上移一个半径；阴影即该格高亮。
  const r = Math.max(3, 6 * view.zoom);
  const [gcx, gcy] = cellCenter(first.x, first.y, 0);
  const px = ox + gcx;
  const py = oy + gcy - r;
  const followed = group.some((a) => follow === a.id);
  const [gx, gy] = project(first.x, first.y, 0);
  const T = tile();
  const hw = T * 0.866;
  const hh = T * 0.5;
  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  ctx.beginPath();
  ctx.moveTo(ox + gx, oy + gy);
  ctx.lineTo(ox + gx + hw, oy + gy + hh);
  ctx.lineTo(ox + gx, oy + gy + 2 * hh);
  ctx.lineTo(ox + gx - hw, oy + gy + hh);
  ctx.closePath();
  ctx.fill();
  // 圆点颜色取同格居民中第一个有心情的人的心情色；居民无心情记录时使用中间值（0,0），访客与 NPC 保持白色。
  const found = (state.moods ?? []).find((m) => group.some((a) => a.id === m.actorId));
  const isAgent = (id) => (state.identities || []).some((i) => i.id === id && i.kind === 'agent');
  const resident = group.some((a) => isAgent(a.id));
  const mood = found ?? { valence: 0, arousal: 0 };
  const base = found || resident ? moodColor(mood.valence, mood.arousal) : '#ffffff';
  // 心情光晕：同色外发光，心情越强越明显（中间值或无心情时不发光）。
  const glow = found && settings.showMoodGlow ? Math.min(1, Math.hypot(mood.valence, mood.arousal)) : 0;
  ctx.save();
  if (glow > 0) {
    ctx.shadowColor = base;
    ctx.shadowBlur = r * (0.6 + glow * 1.6);
  }
  ctx.fillStyle = base;
  ctx.beginPath();
  ctx.arc(px, py, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  // 上下渐变：上半渐亮、下半渐暗，中线附近平滑过渡。
  const tone = ctx.createLinearGradient(px, py - r, px, py + r);
  tone.addColorStop(0, 'rgba(255,255,255,0.4)');
  tone.addColorStop(0.5, 'rgba(255,255,255,0)');
  tone.addColorStop(1, 'rgba(0,0,0,0.3)');
  ctx.fillStyle = tone;
  ctx.beginPath();
  ctx.arc(px, py, r, 0, Math.PI * 2);
  ctx.fill();
  if (followed) {
    ctx.strokeStyle = '#ffd966';
    ctx.lineWidth = 2;
    ctx.stroke();
  }
  const size = Math.round(12 * Math.max(0.8, view.zoom));
  const lineH = size + 6;
  ctx.font = `${size}px "Microsoft YaHei"`;
  ctx.textBaseline = 'alphabetic';
  const shown = settings.showNames ? group.slice(0, LABEL_MAX_PER_TILE) : [];
  const extra = group.length - shown.length;
  const names = extra > 0 ? [...shown.map((a) => a.name), `…等${group.length}人`] : shown.map((a) => a.name);
  names.forEach((name, i) => {
    const y = py - 10 - i * lineH;
    const x = px + 8;
    const w = ctx.measureText(name).width + 8;
    ctx.fillStyle = 'rgba(11,17,25,0.82)';
    ctx.beginPath();
    ctx.roundRect(x - 4, y - size, w, size + 4, 4);
    ctx.fill();
    ctx.fillStyle = '#9fd3ff';
    ctx.fillText(name, x, y);
  });
  // 表情以小徽标贴在圆点右上角：实时表情优先，实时结束后露出常态表情。
  // 服务端已按有效期过滤，这里只做兜底：实时表情过期则回落到常态。
  const mine = (state.emotes ?? []).filter((e) => group.some((a) => a.id === e.actorId));
  const emote = mine.find((e) => e.kind === 'live' && e.expiresAt > Date.now()) ?? mine.find((e) => e.kind === 'baseline');
  if (emote) {
    const badge = Math.round(size * 0.9);
    ctx.font = `${badge}px "Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji",sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(emote.emoji, px + r * 0.9, py - r * 0.9);
    ctx.textAlign = 'start';
    ctx.textBaseline = 'alphabetic';
  }
}

// 按格子分组，同格只画一组
function groupActorsByTile(actors, now) {
  const groups = new Map();
  for (const a of actors) {
    const p = actorPos(a, now);
    const key = `${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(a);
  }
  return [...groups.values()];
}

function drawRipples(ox, oy, now) {
  const T = tile();
  for (const r of ripples) {
    const t = (now - r.start) / settings.bubbleMs;
    if (t < 0 || t > 1) continue;
    const [sx, sy] = project(r.x, r.y, 0.5);
    const radius = (r.range * T * 0.6) * t;
    ctx.strokeStyle = `rgba(160,220,255,${(1 - t) * 0.7})`;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.ellipse(ox + sx, oy + sy, radius * 1.7, radius * 0.9, 0, 0, Math.PI * 2);
    ctx.stroke();
  }
}

// 说话气泡：深色底 + 文字，随时间淡出
function drawHeardLabels(ox, oy, now) {
  for (const r of ripples) {
    const t = (now - r.start) / settings.bubbleMs;
    if (t < 0 || t > 1) continue;
    const [sx, sy] = project(r.x, r.y, 2);
    const x = ox + sx + 6;
    const y = oy + sy - 14 - t * 10;
    ctx.font = '13px "Microsoft YaHei"';
    const w = ctx.measureText(r.text).width + 14;
    const h = 22;
    ctx.globalAlpha = 1 - t;
    ctx.fillStyle = 'rgba(11,17,25,0.85)';
    ctx.beginPath();
    ctx.roundRect(x - 7, y - h + 6, w, h, 6);
    ctx.fill();
    ctx.fillStyle = '#fff3cc';
    ctx.fillText(r.text, x, y);
    ctx.globalAlpha = 1;
  }
}

// 昼夜与季节遮罩：夜里压暗，季节用一层淡色调区分。
const SEASON_TINT = { spring: '120,200,120', summer: '255,200,80', autumn: '210,120,50', winter: '150,180,230' };
function drawDaylight() {
  const cal = state.calendar;
  if (!cal) return;
  const night = 1 - cal.daylight;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (night > 0.02) {
    ctx.fillStyle = `rgba(5,8,20,${(night * 0.6).toFixed(3)})`;
    ctx.fillRect(0, 0, w, h);
  }
  ctx.fillStyle = `rgba(${SEASON_TINT[cal.season] ?? '255,255,255'},0.08)`;
  ctx.fillRect(0, 0, w, h);
  const label = `${SEASON_NAMES[cal.season] ?? cal.season} 第${cal.seasonDay}天 · ${PHASE_NAMES[cal.phase] ?? cal.phase}`;
  ctx.font = '13px sans-serif';
  ctx.fillStyle = 'rgba(11,17,25,0.7)';
  ctx.fillRect(8, h - 30, ctx.measureText(label).width + 16, 22);
  ctx.fillStyle = '#fff3cc';
  ctx.fillText(label, 16, h - 14);
  if (settings.showClock) drawClock(cal, 16 + 44, h - 98);
}

// 左下角昼夜时钟：圆盘外圈按 24 小时着色（夜暗昼亮），指针指向当前时刻。
function drawClock(cal, cx, cy) {
  const r = 44;
  const frac = cal.dayFraction ?? 0;
  // 0 点在底部，正午在顶部，与 daylight 的走向一致
  const angle = frac * Math.PI * 2 + Math.PI / 2;
  ctx.save();
  ctx.fillStyle = 'rgba(11,17,25,0.75)';
  ctx.beginPath();
  ctx.arc(cx, cy, r + 4, 0, Math.PI * 2);
  ctx.fill();
  // 昼夜弧：按 daylight 从暗蓝到暖黄渐变
  const grad = ctx.createRadialGradient(cx, cy, 2, cx, cy, r);
  const day = cal.daylight ?? 0.5;
  grad.addColorStop(0, `rgba(255,${Math.round(200 + 40 * day)},120,${(0.25 + 0.5 * day).toFixed(2)})`);
  grad.addColorStop(1, `rgba(20,30,70,${(0.6 + 0.3 * (1 - day)).toFixed(2)})`);
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  // 刻度：每 6 小时一格
  ctx.strokeStyle = 'rgba(255,243,204,0.6)';
  ctx.lineWidth = 1;
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 2;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * (r - 6), cy + Math.sin(a) * (r - 6));
    ctx.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
    ctx.stroke();
  }
  // 指针
  ctx.strokeStyle = '#fff3cc';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx + Math.cos(angle) * (r - 10), cy + Math.sin(angle) * (r - 10));
  ctx.stroke();
  ctx.fillStyle = '#fff3cc';
  ctx.beginPath();
  ctx.arc(cx, cy, 3, 0, Math.PI * 2);
  ctx.fill();
  // 时刻文字
  const hh = Math.floor(frac * 24);
  const mm = Math.floor((frac * 24 - hh) * 60);
  ctx.font = '12px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(`${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`, cx, cy + r + 14);
  ctx.restore();
}
const SEASON_NAMES = { spring: '春', summer: '夏', autumn: '秋', winter: '冬' };
const PHASE_NAMES = { dawn: '清晨', day: '白天', dusk: '傍晚', night: '夜里' };

// WASD 按住连续平移（像素/秒）
const PAN_SPEED = 600;
const heldKeys = new Set();
let lastFrame = performance.now();

function panByKeys(dtSec) {
  let dx = 0;
  let dy = 0;
  if (heldKeys.has('a')) dx += 1;
  if (heldKeys.has('d')) dx -= 1;
  if (heldKeys.has('w')) dy += 1;
  if (heldKeys.has('s')) dy -= 1;
  if (!dx && !dy) return;
  view.panX += dx * PAN_SPEED * dtSec;
  view.panY += dy * PAN_SPEED * dtSec;
  follow = null; // 手动平移后取消跟随
  syncFollowButtons();
}

function render() {
  requestAnimationFrame(render);
  const frameNow = performance.now();
  panByKeys(Math.min(0.1, (frameNow - lastFrame) / 1000));
  lastFrame = frameNow;
  if (!state) return;
  const now = Date.now();
  if (follow) centerOn(follow);
  ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
  const [ox, oy] = origin();
  drawFloor(ox, oy);
  drawPlots(ox, oy);
  // 按深度排序绘制（前后遮挡关系）
  // 深度必须基于旋转后的坐标，否则转动后遮挡顺序会错
  const items = [
    ...state.solids.map((c) => ({ kind: 'block', c, d: depth(c.x, c.y, c.z) })),
    ...groupActorsByTile(state.actors, now).map((group) => {
      const p = actorPos(group[0], now);
      return { kind: 'actor', group, d: depth(p.x, p.y, 0.5) };
    }),
  ].sort((p, q) => p.d - q.d);
  for (const it of items) {
    if (it.kind === 'block') drawBlock(it.c.x, it.c.y, it.c.z, ox, oy);
    else drawActorGroup(it.group, ox, oy, now);
  }
  drawRipples(ox, oy, now);
  drawHeardLabels(ox, oy, now);
  if (settings.showDaylight) drawDaylight();
  zoomEl.textContent = `${Math.round(view.zoom * 100)}%`;
}

// 把指定居民移到画布中心
function centerOn(id) {
  const a = state.actors.find((x) => x.id === id);
  if (!a) return;
  const p = actorPos(a, Date.now());
  const [sx, sy] = cellCenter(p.x, p.y, 0);
  const b = state.bounds;
  const [cx, cy] = project((b.sizeX - 1) / 2, (b.sizeY - 1) / 2, b.sizeZ / 2);
  view.panX = -(sx - cx);
  view.panY = -(sy - cy);
}

function resetView() {
  view.zoom = 1;
  view.panX = 0;
  view.panY = 0;
  view.rot = 0;
  follow = null;
  syncFollowButtons();
}

function setZoom(z, anchorX, anchorY) {
  const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
  if (anchorX !== undefined) {
    // 以鼠标位置为中心缩放
    const ratio = next / view.zoom;
    view.panX = anchorX - (anchorX - view.panX) * ratio;
    view.panY = anchorY - (anchorY - view.panY) * ratio;
  }
  view.zoom = next;
}

function rotateBy(step) {
  view.rot = (view.rot + step + 4) % 4;
}

function syncFollowButtons() {
  for (const btn of document.querySelectorAll('[data-follow]')) {
    btn.classList.toggle('active', btn.dataset.follow === follow);
  }
}

function toggleFollow(id) {
  follow = follow === id ? null : id;
  syncFollowButtons();
}

// —— 交互 ——
let dragging = false;
let lastX = 0;
let lastY = 0;
let downX = 0;
let downY = 0;

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const rect = canvas.getBoundingClientRect();
  const ax = e.clientX - rect.left - canvas.clientWidth / 2;
  const ay = e.clientY - rect.top - canvas.clientHeight / 2;
  const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
  setZoom(view.zoom * factor, ax, ay);
}, { passive: false });

canvas.addEventListener('mousedown', (e) => {
  dragging = true;
  lastX = e.clientX;
  lastY = e.clientY;
  downX = e.clientX;
  downY = e.clientY;
  canvas.style.cursor = 'grabbing';
});
window.addEventListener('mouseup', (e) => {
  // 位移很小视为点击（否则是拖动平移）
  if (dragging && Math.hypot(e.clientX - downX, e.clientY - downY) < 4) {
    handleCanvasClick(e);
  }
  dragging = false;
  canvas.style.cursor = 'grab';
});
window.addEventListener('mousemove', (e) => {
  if (!dragging) return;
  view.panX += e.clientX - lastX;
  view.panY += e.clientY - lastY;
  lastX = e.clientX;
  lastY = e.clientY;
  follow = null; // 手动平移后取消跟随
  syncFollowButtons();
});
canvas.style.cursor = 'grab';

document.getElementById('zoomIn').onclick = () => setZoom(view.zoom * 1.25);
document.getElementById('zoomOut').onclick = () => setZoom(view.zoom / 1.25);
document.getElementById('rotL').onclick = () => rotateBy(-1);
document.getElementById('rotR').onclick = () => rotateBy(1);
document.getElementById('reset').onclick = resetView;
document.getElementById('toggleGrid').onclick = () => {
  setSetting('showGrid', !settings.showGrid);
};
for (const btn of document.querySelectorAll('[data-follow]')) {
  btn.onclick = () => toggleFollow(btn.dataset.follow);
}

const PAN_KEYS = new Set(['w', 'a', 's', 'd']);
window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  const k = e.key.toLowerCase();
  if (PAN_KEYS.has(k)) {
    heldKeys.add(k);
    return;
  }
  switch (e.key) {
    case '+': case '=': setZoom(view.zoom * 1.25); break;
    case '-': case '_': setZoom(view.zoom / 1.25); break;
    case 'q': case 'Q': rotateBy(-1); break;
    case 'e': case 'E': rotateBy(1); break;
    case 'r': case 'R': resetView(); break;
    case 'g': case 'G': setSetting('showGrid', !settings.showGrid); break;
    default: return;
  }
});

window.addEventListener('keyup', (e) => heldKeys.delete(e.key.toLowerCase()));
// 窗口失焦时清空，避免松键事件丢失导致一直平移
window.addEventListener('blur', () => heldKeys.clear());

function syncGridButton() {
  document.getElementById('toggleGrid').classList.toggle('active', settings.showGrid);
}

// 修改单项设置：保存到本地，并同步按钮状态与设置面板
function setSetting(key, value) {
  settings[key] = value;
  saveSettings();
  syncGridButton();
  window.dispatchEvent(new CustomEvent('settingschange', { detail: key }));
}

// 根据事件同步状态，并把居民按钮列表保持最新。只列出在线（在镇内）的居民：访客与店主不在列表中。
function syncActorButtons() {
  const box = document.getElementById('actorButtons');
  if (!state) return;
  box.replaceChildren();
  for (const a of state.actors) {
    if (!a.id.startsWith('agent-')) continue;
    const btn = document.createElement('button');
    btn.textContent = `跟随 ${a.name}`;
    btn.dataset.follow = a.id;
    btn.onclick = () => toggleFollow(a.id);
    box.appendChild(btn);
  }
  syncFollowButtons();
}

// —— 事件回放 ——
// 事件按原始时间间隔依次播放（页面打开时会回放历史），间隔限制在 [MIN, MAX] 之间，便于观察。
const REPLAY_MIN_GAP_MS = 200;
const REPLAY_MAX_GAP_MS = 1000;
const REPLAY_BACKLOG = 10; // 待播放超过这个数量时加快回放
// 回放速度倍率作用于间隔：倍率越大，间隔越短
let fetchSeq = 0; // 已从服务端取过的最大序号
let playQueue = []; // 等待播放的事件
let nextDue = 0; // 下一条事件最早播放的时间戳

// 积压较多时加快回放，让画面尽快追上实时
function replayGap(prev, next, backlog) {
  const speed = settings.replaySpeed || 1;
  if (backlog > REPLAY_BACKLOG) return REPLAY_MIN_GAP_MS / speed;
  const gap = next.time - prev.time;
  return Math.min(REPLAY_MAX_GAP_MS, Math.max(REPLAY_MIN_GAP_MS, gap)) / speed;
}

// 把事件真正应用到画面和日志
// 访客当前位置，供移动按钮计算目标格
function updateVisitorPos() {
  const a = state && state.actors.find((x) => x.id === visitorId);
  if (a) visitorPos = a.position;
}

function applyEvent(e) {
  lastSeq = Math.max(lastSeq, e.seq);
  if (e.type === 'speak') {
    const origin = e.data.origin;
    ripples.push({ x: origin.x, y: origin.y, z: origin.z, start: Date.now(), range: e.data.range, text: e.data.text });
  }
  if (e.type === 'move') {
    const a = state.actors.find((x) => x.id === e.actorId);
    if (a) {
      queueMove(a, e.data.to);
      a.position = e.data.to;
      if (a.id === visitorId) visitorPos = e.data.to;
    }
  }
  // 入住、离开与返回会改变地图上的居民，建造会改变方块，同样回读状态
  if (['spawn', 'place', 'pickup', 'leave', 'enter'].includes(e.type)) refreshState();
  // 表情只持续约 10 秒，收到即回读，避免在 5 秒刷新间隔里错过
  if (e.type === 'emote') refreshState();
  logEl.appendChild(eventRow(e));
  while (logEl.childElementCount > settings.logLimit) logEl.firstElementChild.remove();
  logEl.scrollTop = logEl.scrollHeight;
}

// 事件类型的图标与中文说明
const EVENT_LABEL = {
  spawn: { icon: '✦', cls: 'spawn', text: '入住小镇' },
  move: { icon: '→', cls: 'move', text: '走到' },
  speak: { icon: '💬', cls: 'speak', text: '说' },
  place: { icon: '▣', cls: 'place', text: '放下方块' },
  pickup: { icon: '▢', cls: 'pickup', text: '拿起方块' },
  leave: { icon: '⇥', cls: 'leave', text: '离开小镇，前往' },
  enter: { icon: '⇤', cls: 'enter', text: '回到小镇' },
};
const MODE_LABEL = { whisper: '悄悄话', talk: '说话', shout: '大喊' };
const MATERIAL_LABEL = { wood: '木材', fiber: '纤维', stone: '岩石', dirt: '泥土', grass: '草地' };

function actorName(id) {
  const a = state && state.actors.find((x) => x.id === id);
  return a ? a.name : id;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// 把一条事件渲染成人类可读的一行
function eventRow(e) {
  const meta = EVENT_LABEL[e.type] || { icon: '·', cls: '', text: e.type };
  let detail = '';
  if (e.type === 'speak') {
    detail = `<span class="mode">${MODE_LABEL[e.data.mode] || e.data.mode}</span> <span class="say">“${escapeHtml(e.data.text)}”</span>`;
  } else if (e.type === 'move') {
    detail = `(${e.data.to.x}, ${e.data.to.y})`;
  } else if (e.type === 'place' || e.type === 'pickup') {
    const t = e.data.target;
    const where = e.data.yard ? '后院 ' : '';
    const kind = e.data.material ? ` ${MATERIAL_LABEL[e.data.material] || e.data.material}` : '';
    detail = `${where}(${t.x}, ${t.y}, ${t.z})${kind}`;
  } else if (e.type === 'leave') {
    detail = e.data.to === 'backyard' ? '后院' : e.data.to;
  }
  const row = document.createElement('div');
  row.className = `ev ${meta.cls}`;
  row.innerHTML = `<span class="seq">#${e.seq}</span><span>${meta.icon}</span>` +
    `<span><span class="who">${escapeHtml(actorName(e.actorId))}</span> <span class="what">${meta.text}</span> ${detail}</span>`;
  return row;
}

// 只刷新方块、归属和房间，保留居民当前的画面位置，避免回放被打断
async function refreshState() {
  try {
    const fresh = await (await fetch('/api/state')).json();
    if (!state) return;
    state.solids = fresh.solids;
    state.owners = fresh.owners;
    state.rooms = fresh.rooms;
    state.actors = fresh.actors;
    state.calendar = fresh.calendar;
    state.identities = fresh.identities;
    state.relations = fresh.relations;
    state.moods = fresh.moods;
    state.emotes = fresh.emotes;
    syncActorButtons();
    renderRelations();
    renderMoods();
    updateVisitorPos();
  } catch {
    // 下一次建造事件到来时会再次尝试
  }
}

function pump() {
  const now = Date.now();
  if (!state) return;
  while (playQueue.length && now >= nextDue) {
    const e = playQueue.shift();
    applyEvent(e);
    nextDue = playQueue.length ? now + replayGap(e, playQueue[0], playQueue.length) : 0;
  }
  if (playQueue.length) {
    setStatus('replay', `回放中 · 剩余 ${playQueue.length} 条`);
  } else if (lastSeq > 0) {
    setStatus('live', `实时 · 已发生 ${lastSeq} 件事`);
  }
}

function setStatus(mode, text) {
  statusEl.dataset.mode = mode;
  statusEl.textContent = text;
}

function skipReplay() {
  while (playQueue.length) applyEvent(playQueue.shift());
  nextDue = 0;
}

// 把一条新事件加入播放队列；序号已见过的直接忽略（断线重连时可能重复）
function enqueue(e) {
  if (e.seq <= fetchSeq) return;
  fetchSeq = e.seq;
  playQueue.push(e);
}

// 首次加载：直接显示服务端当前状态（地图与居民位置），不回放历史；日志只放最近 settings.logLimit 条
async function loadInitial() {
  state = await (await fetch('/api/state')).json();
  syncActorButtons();
  renderRelations();
  renderMoods();
  updateVisitorPos();
  const historyEvents = (await (await fetch('/api/history')).json()).events;
  const memoryEvents = (await (await fetch('/api/events?since=0')).json()).events;
  const seen = new Set();
  const history = [...historyEvents, ...memoryEvents].filter((e) => {
    if (seen.has(e.seq)) return false;
    seen.add(e.seq);
    return true;
  }).sort((a, b) => a.seq - b.seq);
  for (const e of history.slice(-settings.logLimit)) {
    logEl.appendChild(eventRow(e));
  }
  if (history.length) {
    fetchSeq = history[history.length - 1].seq;
    lastSeq = fetchSeq;
  }
  logEl.scrollTop = logEl.scrollHeight;
}

// 断线重连后补齐漏掉的事件
async function catchUp() {
  const res = await (await fetch(`/api/events?since=${fetchSeq}`)).json();
  for (const e of res.events) enqueue(e);
}

// 推送通道：服务端每发生一件事就立刻收到，断开后自动重连
function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/view`);
  ws.onopen = () => {
    catchUp().catch(() => {});
    setStatus('live', '实时 · 已连接');
  };
  ws.onmessage = (msg) => {
    const data = JSON.parse(msg.data);
    if (data.kind === 'event') enqueue(data.event);
  };
  ws.onclose = () => {
    setStatus('error', '连接断开，正在重连…');
    setTimeout(connect, 1000);
  };
}

// 访客登录：昵称换 token，之后说话和移动通过 HTTP /api/visitor/action 发送（不走 /agent 适配器通道）。
let token = localStorage.getItem('snowdomeToken') || '';
let visitorPos = null;
let visitorId = localStorage.getItem('snowdomeActor') || '';

function setLoginMsg(text) {
  document.getElementById('loginMsg').textContent = text;
  document.getElementById('overlayMsg').textContent = text;
}

// 居民关系列表：有向显示“甲 → 乙”，只展示行为事实（相遇、对话次数与最近互动日），按最近互动排序。
function renderRelations() {
  const el = document.getElementById('relations');
  if (!el || !state) return;
  const names = new Map((state.identities || []).map((i) => [i.id, i.name]));
  const rows = (state.relations || []).slice().sort((a, b) => (b.last_seq ?? 0) - (a.last_seq ?? 0)).slice(0, 10);
  el.textContent = '';
  for (const r of rows) {
    const line = document.createElement('div');
    line.className = 'relation-row';
    line.textContent = `${names.get(r.from) || r.from} → ${names.get(r.to) || r.to}：相遇${r.meetings} 对话${r.talks} 最近第${r.last_day ?? '-'}日`;
    el.appendChild(line);
  }
}

// 心情颜色：效价决定色相（负面偏冷蓝、正面偏暖橙），唤醒度决定饱和度（平静发灰、激动鲜艳）。
function moodColor(valence, arousal) {
  const hue = 220 + ((valence + 1) / 2) * 170; // 220(蓝) → 390(经紫、红到橙)
  const sat = 25 + ((arousal + 1) / 2) * 65;
  return `hsl(${Math.round(hue) % 360} ${Math.round(sat)}% 55%)`;
}

// 居民心情列表：只在观察页显示，不进入观察包。效价与唤醒度按当前衰减后的值显示。
function renderMoods() {
  const el = document.getElementById('moods');
  if (!el || !state) return;
  const names = new Map((state.identities || []).map((i) => [i.id, i.name]));
  const actorNames = new Map((state.actors || []).map((a) => [a.id, a.name]));
  el.textContent = '';
  for (const m of state.moods || []) {
    const line = document.createElement('div');
    line.className = 'mood-row';
    const name = names.get(m.actorId) || actorNames.get(m.actorId) || m.actorId;
    line.textContent = `${name}：效价 ${m.valence.toFixed(2)} · 唤醒 ${m.arousal.toFixed(2)}`;
    const swatch = document.createElement('span');
    swatch.className = 'mood-swatch';
    swatch.style.background = moodColor(m.valence, m.arousal);
    line.prepend(swatch);
    el.appendChild(line);
  }
}

function showIdentity(name) {
  document.getElementById('identity').textContent = '当前：' + name;
  document.getElementById('sayBox').hidden = false;
  document.getElementById('moveBox').hidden = false;
  document.getElementById('logoutBtn').hidden = false;
  document.getElementById('pwdBox').hidden = false;
  document.getElementById('loginOverlay').hidden = true;
}

// 未登录时全屏登录界面覆盖整个页面；离开或登录状态失效时再次显示。
function showLoginOverlay() {
  document.getElementById('loginOverlay').hidden = false;
  document.getElementById('nameInput').focus();
}

function clearLocalLogin() {
  token = '';
  visitorId = '';
  localStorage.removeItem('snowdomeToken');
  localStorage.removeItem('snowdomeActor');
  localStorage.removeItem('snowdomeName');
  document.getElementById('identity').textContent = '当前：游客（只能观察）';
  document.getElementById('sayBox').hidden = true;
  document.getElementById('moveBox').hidden = true;
  document.getElementById('logoutBtn').hidden = true;
  document.getElementById('pwdBox').hidden = true;
}

const LOGIN_REASON_TEXT = {
  password_required: '请输入密码',
  password_too_short: '密码至少 4 个字符',
  password_too_long: '密码最多 64 个字符',
  wrong_password: '密码不正确（该昵称已被注册）',
  town_full: '当前小镇访客已满，请换一个实例或稍后再试',
  invalid_emoji: '常态表情无效，请重新选择',
};

// 登录时可选的常态表情。登录必须选一个，之后实时表情结束时露出它。
const BASELINE_EMOTE_CHOICES = ['🙂', '😀', '😎', '🤔', '😴', '👋'];
let pickedBaselineEmote = '';
function renderEmotePicker() {
  const box = document.getElementById('emotePick');
  box.innerHTML = '';
  for (const emoji of BASELINE_EMOTE_CHOICES) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = emoji;
    b.title = '选为常态表情';
    b.className = emoji === pickedBaselineEmote ? 'picked' : '';
    b.onclick = () => { pickedBaselineEmote = emoji; renderEmotePicker(); };
    box.appendChild(b);
  }
}
renderEmotePicker();

async function login() {
  const name = document.getElementById('nameInput').value.trim();
  const password = document.getElementById('passwordInput').value;
  if (!name) return setLoginMsg('请输入昵称');
  if (!pickedBaselineEmote) return setLoginMsg('请选择一个常态表情');
  const res = await fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, password, baselineEmote: pickedBaselineEmote }) });
  const data = await res.json();
  if (!data.accepted) return setLoginMsg('登录失败：' + (LOGIN_REASON_TEXT[data.reason_code] || data.reason_code || '未知'));
  token = data.token;
  visitorId = data.actorId;
  localStorage.setItem('snowdomeToken', token);
  localStorage.setItem('snowdomeActor', visitorId);
  localStorage.setItem('snowdomeName', data.name);
  showIdentity(data.name);
  setLoginMsg('已进入小镇');
}

async function sendIntent(intent) {
  if (!token) return setLoginMsg('请先登录');
  const res = await fetch(`/api/visitor/action?token=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(intent),
  });
  const r = await res.json();
  if (r.accepted === false) setLoginMsg('操作未被接受：' + r.reason_code);
  else setLoginMsg('');
  return r;
}

document.getElementById('loginForm').onsubmit = (e) => {
  e.preventDefault();
  login().catch((err) => setLoginMsg('登录出错：' + err.message));
};
document.getElementById('pwdBtn').onclick = async () => {
  const name = localStorage.getItem('snowdomeName') || '';
  const oldPassword = document.getElementById('oldPwdInput').value;
  const newPassword = document.getElementById('newPwdInput').value;
  if (!name) return setLoginMsg('请先登录');
  const res = await fetch('/api/account/password', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, oldPassword, newPassword }),
  });
  const data = await res.json();
  if (!data.accepted) return setLoginMsg('修改失败：' + (LOGIN_REASON_TEXT[data.reason_code] || data.reason_code || '未知'));
  document.getElementById('oldPwdInput').value = '';
  document.getElementById('newPwdInput').value = '';
  setLoginMsg('密码已修改');
};
document.getElementById('logoutBtn').onclick = () => {
  clearLocalLogin();
  setLoginMsg('');
  showLoginOverlay();
};
document.getElementById('sayBtn').onclick = () => {
  const input = document.getElementById('sayInput');
  const text = input.value.trim();
  if (!text) return;
  sendIntent({ kind: 'speak', mode: 'talk', text });
  input.value = '';
};
document.getElementById('sayInput').onkeydown = (e) => { if (e.key === 'Enter') document.getElementById('sayBtn').click(); };
// 移动：相对于访客当前位置走一步（最多 3 格，见 adapter-api）
for (const btn of document.querySelectorAll('#moveBox button')) {
  btn.onclick = () => {
    if (!visitorPos) return setLoginMsg('还没有位置，请稍等');
    const dx = Number(btn.dataset.dx || 0);
    const dy = Number(btn.dataset.dy || 0);
    sendIntent({ kind: 'move', target: { x: visitorPos.x + dx, y: visitorPos.y + dy, z: visitorPos.z } });
  };
}

// —— 设置面板 ——
// 每个设置项对应一个控件；控件变化写入 settings，其他地方改设置时也回填控件。
const SETTING_CONTROLS = {
  showGrid: 'checkbox', showDaylight: 'checkbox', showClock: 'checkbox',
  showNames: 'checkbox', showMoodGlow: 'checkbox',
  bubbleMs: 'range', moveMs: 'range', replaySpeed: 'range', logLimit: 'number',
};
const settingsOverlay = document.getElementById('settingsOverlay');

function syncSettingsPanel() {
  for (const [key, kind] of Object.entries(SETTING_CONTROLS)) {
    const input = document.getElementById(`set-${key}`);
    if (kind === 'checkbox') input.checked = !!settings[key];
    else input.value = settings[key];
    const out = document.getElementById(`out-${key}`);
    if (out) out.textContent = key === 'replaySpeed' ? `${settings[key]}×` : `${settings[key]} ms`;
  }
}

for (const [key, kind] of Object.entries(SETTING_CONTROLS)) {
  const input = document.getElementById(`set-${key}`);
  input.oninput = () => {
    let value;
    if (kind === 'checkbox') value = input.checked;
    else if (kind === 'number') value = Math.min(200, Math.max(5, Math.round(Number(input.value) || DEFAULT_SETTINGS[key])));
    else value = Number(input.value);
    setSetting(key, value);
    syncSettingsPanel();
  };
}
window.addEventListener('settingschange', syncSettingsPanel);
document.getElementById('settingsBtn').onclick = () => {
  syncSettingsPanel();
  settingsOverlay.hidden = false;
};
document.getElementById('settingsClose').onclick = () => { settingsOverlay.hidden = true; };
settingsOverlay.addEventListener('click', (e) => { if (e.target === settingsOverlay) settingsOverlay.hidden = true; });
window.addEventListener('keydown', (e) => { if (e.key === 'Escape') settingsOverlay.hidden = true; });
document.getElementById('settingsReset').onclick = () => {
  Object.assign(settings, DEFAULT_SETTINGS);
  saveSettings();
  syncGridButton();
  syncSettingsPanel();
};
syncGridButton();

loadInitial()
  .then(() => {
    connect();
    if (token) {
      // 刷新页面后仍保持登录：沿用本地保存的 token 与昵称
      showIdentity(localStorage.getItem('snowdomeName') || '访客');
    } else {
      showLoginOverlay();
    }
  })
  .catch((err) => setStatus('error', '加载失败：' + err.message));
setInterval(pump, 50);
// 昼夜与季节随时间推进，没有对应事件，定时回读；入场若漏收事件也能补上
setInterval(refreshState, 5000);
// 访客心跳：每 15 秒告诉服务端还在线，超时未心跳会被清出小镇。
setInterval(() => {
  if (!token) return;
  fetch(`/api/visitor/heartbeat?token=${encodeURIComponent(token)}`, { method: 'POST' })
    .then((res) => {
      if (res.status !== 401) return;
      // 服务端已让访客离开，本地登录状态作废，重新显示登录界面。
      clearLocalLogin();
      setLoginMsg('因长时间离线已离开小镇，请重新登录');
      showLoginOverlay();
    })
    .catch(() => {});
}, 15000);
document.getElementById('skipReplay').onclick = skipReplay;
requestAnimationFrame(render);
