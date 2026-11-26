// 后院演示：三维多层地形，等距视角与观察页一致。改动只存在本页，不写入世界。
const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d');
const info = document.getElementById('info');
const seedInput = document.getElementById('seed');
const seedInfo = document.getElementById('seedInfo');
const layerInput = document.getElementById('layer');
const layerLabel = document.getElementById('layerLabel');

const BASE_TILE = 14;
const SPAN = 32;
const ZMIN = 0;
const ZMAX = 14;

let seed = 0;
let grid = null; // { origin, size, zmin, zmax, materials[z][i][j] }
let mode = 'dig';
let layer = 6;
// 本页改动：键 "x,y,z" -> true(放置) / false(挖空)
const edits = new Map();
const view = { zoom: 1, panX: 0, panY: 0, rot: 0 };
let drag = null;

const MATERIAL_COLORS = {
  grass: ['#7fc48a', '#4d8a5a', '#3a6a44'],
  dirt: ['#b08760', '#8a6a45', '#6e5336'],
  stone: ['#8d969e', '#6f7880', '#565d64'],
  wood: ['#a9784a', '#8a5f38', '#6b4727'],
  fiber: ['#d8c27a', '#b9a25c', '#948246'],
  placed: ['#e6c47a', '#c9a55a', '#a6843f'],
};

function tile() {
  return BASE_TILE * view.zoom;
}

function rotate(x, y) {
  const n = SPAN;
  switch (view.rot) {
    case 1: return [y, n - 1 - x];
    case 2: return [n - 1 - x, n - 1 - y];
    case 3: return [n - 1 - y, x];
    default: return [x, y];
  }
}

function depth(x, y, z) {
  const [rx, ry] = rotate(x, y);
  return rx + ry + z;
}

function project(x, y, z) {
  const T = tile();
  const [rx, ry] = rotate(x, y);
  return [(rx - ry) * T * 0.866, (rx + ry) * T * 0.5 - z * T];
}

function size() {
  return { w: canvas.clientWidth, h: canvas.clientHeight };
}

function origin() {
  const { w, h } = size();
  const [cx, cy] = project((SPAN - 1) / 2, (SPAN - 1) / 2, layer);
  return [w / 2 - cx + view.panX, h / 2 - cy + view.panY];
}

function resize() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = canvas.clientWidth * dpr;
  canvas.height = canvas.clientHeight * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  draw();
}

// 按 (x, y, z) 返回格子材质：玩家改动优先；超出加载范围视为空。
function materialAt(x, y, z) {
  const e = edits.get(`${x},${y},${z}`);
  const terrain = terrainAt(x, y, z);
  if (e === true) return terrain === 'air' ? 'placed' : terrain;
  if (e === false) return 'air';
  return terrain;
}

function terrainAt(x, y, z) {
  if (!grid) return 'air';
  const i = y - grid.origin.y;
  const j = x - grid.origin.x;
  const k = z - grid.zmin;
  if (i < 0 || j < 0 || i >= grid.size || j >= grid.size || k < 0 || k >= grid.materials.length) return 'air';
  return grid.materials[k][i][j];
}

// 三面绘制：顶、左、右，与观察页 drawBlock 相同。投影后的坐标即方块顶面菱形中心。
function drawBlock(ox, oy, x, y, z, colors) {
  const T = tile();
  const [sx, sy] = project(x, y, z);
  const cx = ox + sx;
  const cy = oy + sy;
  ctx.beginPath();
  ctx.moveTo(cx, cy - T * 0.5);
  ctx.lineTo(cx + T * 0.866, cy);
  ctx.lineTo(cx, cy + T * 0.5);
  ctx.lineTo(cx - T * 0.866, cy);
  ctx.closePath();
  ctx.fillStyle = colors[0];
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(cx - T * 0.866, cy);
  ctx.lineTo(cx, cy + T * 0.5);
  ctx.lineTo(cx, cy + T * 0.5 + T);
  ctx.lineTo(cx - T * 0.866, cy + T);
  ctx.closePath();
  ctx.fillStyle = colors[1];
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(cx + T * 0.866, cy);
  ctx.lineTo(cx, cy + T * 0.5);
  ctx.lineTo(cx, cy + T * 0.5 + T);
  ctx.lineTo(cx + T * 0.866, cy + T);
  ctx.closePath();
  ctx.fillStyle = colors[2];
  ctx.fill();
}

function draw() {
  if (!grid) return;
  const { w, h } = size();
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#0d1620';
  ctx.fillRect(0, 0, w, h);

  const [ox, oy] = origin();
  const blocks = [];
  // 绘制全部高度层，地下与悬空的方块都可见。当前层以上的方块半透明，便于看清当前层的挖掘结果。
  for (let z = ZMIN; z <= ZMAX; z++) {
    for (let x = 0; x < SPAN; x++) {
      for (let y = 0; y < SPAN; y++) {
        const m = materialAt(gx(x), gy(y), z);
        if (m === 'air') continue;
        blocks.push({ x: gx(x), y: gy(y), z, m, d: depth(gx(x), gy(y), z) });
      }
    }
  }
  blocks.sort((a, b) => a.d - b.d);
  for (const b of blocks) {
    ctx.globalAlpha = b.z > layer ? 0.35 : 1;
    drawBlock(ox, oy, b.x, b.y, b.z, MATERIAL_COLORS[b.m]);
  }
  ctx.globalAlpha = 1;
}

// 本页的 x,y 从 origin 开始，这里把视图内的局部坐标换算为世界坐标。
function gx(j) { return grid.origin.x + j; }
function gy(i) { return grid.origin.y + i; }

// 屏幕坐标 -> 当前层格子坐标（逆投影）。
function cellAt(px, py) {
  const [ox, oy] = origin();
  const T = tile();
  const sx = px - ox;
  const sy = py - oy + layer * T;
  // 求解 (rx - ry)*T*0.866 = sx, (rx + ry)*T*0.5 = sy
  const a = sx / (T * 0.866);
  const b = sy / (T * 0.5);
  const rx = (a + b) / 2;
  const ry = (b - a) / 2;
  const n = SPAN;
  let x, y;
  switch (view.rot) {
    case 1: x = n - 1 - ry; y = rx; break;
    case 2: x = n - 1 - rx; y = n - 1 - ry; break;
    case 3: x = ry; y = n - 1 - rx; break;
    default: x = rx; y = ry;
  }
  return { x: Math.floor(x + 0.5), y: Math.floor(y + 0.5) };
}

async function load(newSeed) {
  const q = new URLSearchParams({
    size: String(SPAN),
    x: '0',
    y: '0',
    zmin: String(ZMIN),
    zmax: String(ZMAX),
  });
  if (newSeed !== undefined && newSeed !== '') q.set('seed', newSeed);
  const res = await fetch('/api/backyard?' + q.toString());
  const data = await res.json();
  grid = {
    origin: data.origin,
    size: data.size,
    zmin: data.zmin,
    zmax: data.zmax,
    materials: data.materials,
  };
  seed = data.seed;
  seedInput.value = String(seed);
  seedInfo.textContent = `种子 ${seed}（${grid.size}×${grid.size}，高度 ${grid.zmin}–${grid.zmax}）`;
  edits.clear();
  view.zoom = 1;
  view.panX = 0;
  view.panY = 0;
  draw();
}

function setLayer(z) {
  layer = Math.min(ZMAX, Math.max(ZMIN, z));
  layerInput.value = String(layer);
  layerLabel.textContent = `当前层 z = ${layer}（${layer < 0 ? '地下' : '地表'}参照）`;
  draw();
}

// 只作用于当前层。挖掘：把该格设为空；放置：把该格设为实心。
function toggle(x, y) {
  if (!grid) return;
  const i = y - grid.origin.y;
  const j = x - grid.origin.x;
  if (i < 0 || j < 0 || i >= grid.size || j >= grid.size) return;
  edits.set(`${x},${y},${layer}`, mode === 'place');
  draw();
}

function setMode(m) {
  mode = m;
  document.getElementById('modeDig').classList.toggle('on', m === 'dig');
  document.getElementById('modePlace').classList.toggle('on', m === 'place');
}

canvas.addEventListener('mousedown', (ev) => {
  drag = { x: ev.clientX, y: ev.clientY, moved: false };
});
window.addEventListener('mouseup', (ev) => {
  if (drag && !drag.moved && grid) {
    const r = canvas.getBoundingClientRect();
    const c = cellAt(ev.clientX - r.left, ev.clientY - r.top);
    toggle(c.x, c.y);
  }
  drag = null;
});
window.addEventListener('mousemove', (ev) => {
  if (drag) {
    const dx = ev.clientX - drag.x;
    const dy = ev.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
    view.panX += dx;
    view.panY += dy;
    drag.x = ev.clientX;
    drag.y = ev.clientY;
    draw();
  }
  if (grid) {
    const r = canvas.getBoundingClientRect();
    const c = cellAt(ev.clientX - r.left, ev.clientY - r.top);
    const inside = c.x >= grid.origin.x && c.y >= grid.origin.y &&
      c.x < grid.origin.x + grid.size && c.y < grid.origin.y + grid.size;
    info.textContent = inside
      ? `(${c.x}, ${c.y}, ${layer})  ${materialName(materialAt(c.x, c.y, layer))}`
      : `(${c.x}, ${c.y}, ${layer})  超出已加载范围`;
  }
});
canvas.addEventListener('wheel', (ev) => {
  ev.preventDefault();
  view.zoom = Math.min(4, Math.max(0.3, view.zoom * (ev.deltaY < 0 ? 1.1 : 0.9)));
  draw();
}, { passive: false });

function materialName(m) {
  return { air: '空', grass: '草地', dirt: '泥土', stone: '岩石', wood: '木材', fiber: '纤维', placed: '玩家放置' }[m] ?? m;
}

function rotateView(step) {
  view.rot = (view.rot + step + 4) % 4;
  draw();
}

window.addEventListener('keydown', (ev) => {
  if (ev.key === 'q' || ev.key === 'Q') rotateView(-1);
  if (ev.key === 'e' || ev.key === 'E') rotateView(1);
  if (ev.key === 'r' || ev.key === 'R') resetView();
});

function resetView() {
  view.zoom = 1; view.panX = 0; view.panY = 0; view.rot = 0;
  draw();
}

layerInput.addEventListener('input', () => setLayer(Number(layerInput.value)));
document.getElementById('modeDig').onclick = () => setMode('dig');
document.getElementById('modePlace').onclick = () => setMode('place');
document.getElementById('apply').onclick = () => load(seedInput.value.trim());
document.getElementById('randomize').onclick = () => load('');
document.getElementById('reset').onclick = () => { edits.clear(); draw(); };
document.getElementById('rotL').onclick = () => rotateView(-1);
document.getElementById('rotR').onclick = () => rotateView(1);
document.getElementById('resetView').onclick = resetView;
window.addEventListener('resize', resize);

resize();
setLayer(layer);
load('');
