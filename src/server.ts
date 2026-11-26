import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SHOP_COUNTER, buildTown } from './scenes/town.ts';
import type { World, HandoffSnapshot } from './core/world.ts';
import { isSingleEmoji } from './core/world.ts';
import { freezeEventLog, loadEventLog, startEventLog } from './core/eventlog.ts';
import { applyIntent, type Intent } from './adapters/adapter.ts';
import { admitAction, forgetActor } from './adapters/rate-limit.ts';
import { WebSocketServer, type WebSocket } from 'ws';
import { buildObservation, agentHistory } from './adapters/observation.ts';
import { calendarAt } from './core/calendar.ts';
import { Backyard, newSeed } from './core/backyard.ts';
import { login, sessionFor, heartbeat, expireSessions, revokeActor } from './adapters/session.ts';
import { archiveLog } from './admin/log.ts';

// 访客与适配器居民的掉线判定：访客超过这个时间没心跳就离开小镇。
const VISITOR_TIMEOUT_MS = Number(process.env.VISITOR_TIMEOUT_MS ?? 45000);

const here = fileURLToPath(new URL('.', import.meta.url));
const webRoot = join(here, 'web');
// 每个小镇进程用自己的数据目录（网关启动的第二个及之后的小镇会指定 DATA_DIR）。
const logDir = process.env.DATA_DIR ?? join(here, '..', 'data');
const PORT = Number(process.env.PORT ?? 3000);
// 网关转发管理请求时携带的内部令牌（由网关生成并通过环境变量传给小镇）。
const adminToken = process.env.ADMIN_INTERNAL_TOKEN ?? '';

const world: World = buildTown();

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
};

function sendJson(res: import('node:http').ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

// 读取 JSON 请求体；格式不对返回 null，由调用方决定如何拒绝。
async function readJson(req: import('node:http').IncomingMessage): Promise<Record<string, unknown> | null> {
  let body = '';
  for await (const chunk of req) body += chunk;
  try {
    const parsed: unknown = JSON.parse(body);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);

  if (req.method === 'GET' && url.pathname === '/api/state') {
    return sendJson(res, 200, { ...world.snapshot(), calendar: calendarAt(Date.now()) });
  }
  // 身份与关系的只读查询：谁是谁、两人之间相遇几次、说过几次话、关系分数。
  if (req.method === 'GET' && url.pathname === '/api/identities') {
    const snap = world.snapshot();
    return sendJson(res, 200, { identities: snap.identities, relations: snap.relations });
  }
  // 后院演示：按种子返回一块地形切片。编辑只在页面本地，不写入世界。
  if (req.method === 'GET' && url.pathname === '/api/backyard') {
    const seed = Number(url.searchParams.get('seed') ?? newSeed()) >>> 0;
    const size = Math.min(Number(url.searchParams.get('size') ?? 32), 64);
    const zmin = Number(url.searchParams.get('zmin') ?? 0);
    const zmax = Math.min(Number(url.searchParams.get('zmax') ?? 14), zmin + 40);
    const yard = new Backyard(seed);
    const cx = Number(url.searchParams.get('x') ?? 0);
    const cy = Number(url.searchParams.get('y') ?? 0);
    const origin = { x: cx - size / 2, y: cy - size / 2 };
    // materials[k][i][j]：z = zmin + k，y = origin.y + i，x = origin.x + j
    const materials: string[][][] = [];
    for (let z = zmin; z <= zmax; z++) {
      const layer: string[][] = [];
      for (let i = 0; i < size; i++) {
        const row: string[] = [];
        for (let j = 0; j < size; j++) row.push(yard.terrainAt({ x: origin.x + j, y: origin.y + i, z }));
        layer.push(row);
      }
      materials.push(layer);
    }
    return sendJson(res, 200, { seed, size, origin, zmin, zmax, materials });
  }
  // 登录：只提交昵称，返回 token。之后在 /api/visitor/action 里带上 token 才会被接受。
  if (req.method === 'POST' && url.pathname === '/api/login') {
    let body = '';
    for await (const chunk of req) body += chunk;
    let name = '';
    let kind: 'visitor' | 'agent' = 'visitor';
    let agentId: string | undefined;
    let identityFields: { source?: string; appearance?: string; bio?: string } = {};
    let bindAgentId: string | undefined;
    let baselineEmote: string | undefined;
    try {
      const parsed = JSON.parse(body) as { name?: unknown; kind?: unknown; agentId?: unknown; bindAgentId?: unknown; source?: unknown; appearance?: unknown; bio?: unknown; baselineEmote?: unknown };
      name = String(parsed.name ?? '');
      if (typeof parsed.baselineEmote === 'string') baselineEmote = parsed.baselineEmote;
      if (parsed.kind === 'agent') kind = 'agent';
      if (typeof parsed.agentId === 'string') agentId = parsed.agentId;
      if (typeof parsed.bindAgentId === 'string') bindAgentId = parsed.bindAgentId;
      identityFields = {
        source: typeof parsed.source === 'string' ? parsed.source : undefined,
        appearance: typeof parsed.appearance === 'string' ? parsed.appearance : undefined,
        bio: typeof parsed.bio === 'string' ? parsed.bio : undefined,
      };
    } catch { /* 空请求体按空昵称处理 */ }
    // 绑定：访客登录时可指定要监控的 agent，该 agent 必须已有身份且为 agent 类型。
    if (bindAgentId !== undefined) {
      const target = world.identityOf(`agent-${bindAgentId}`);
      if (kind !== 'visitor' || !target || target.kind !== 'agent') {
        return sendJson(res, 400, { accepted: false, reason_code: 'agent_not_found' });
      }
    }
    // 常态表情必须是单个 emoji：在入住前校验，失败则不创建居民。
    if (baselineEmote !== undefined && !isSingleEmoji(baselineEmote)) {
      return sendJson(res, 400, { accepted: false, reason_code: 'invalid_emoji' });
    }
    // 第三方 agent 必须在登录时选定常态表情，否则不创建居民。
    if (kind === 'agent' && baselineEmote === undefined) {
      return sendJson(res, 400, { accepted: false, reason_code: 'missing_baseline_emote' });
    }
    const result = login(name, kind, Date.now(), agentId, bindAgentId ? `agent-${bindAgentId}` : undefined);
    if (!result.ok) return sendJson(res, 400, { accepted: false, reason_code: result.reason });
    // 身份：每次登录都更新一次（简介与外观由居民自填，服务端只截断长度）。
    world.setIdentity(result.session.actorId, {
      name: result.session.name,
      kind: kind,
      source: identityFields.source ?? '',
      appearance: identityFields.appearance ?? '',
      bio: identityFields.bio ?? '',
    });
    // 登录即入住小镇，身份由服务端分配，客户端不能指定。
    // 网页访客：入口已有人时就近找空位，避免叠在同一格；第三方 agent（kind: 'agent'）：按居民出生在自留地中心。
    // 已导入快照的居民处于离开状态，登录时改为返回小镇（保留后院与建筑）。
    let receipt;
    if (result.session.actorId.startsWith('visitor-') && !world.getActor(result.session.actorId)) {
      receipt = world.spawn(result.session.actorId, result.session.name, world.freeCellNear(world.entrance) ?? world.entrance);
    } else if (world.getActor(result.session.actorId)) {
      // 同一身份仍在小镇（如上一次连接未离开）：沿用原位置，只换新 token，不重复出生。
      receipt = { accepted: true, reason_code: 'ok', state_delta: {}, cooldown_ms: 0 };
    } else if (world.hasAway(result.session.actorId)) {
      receipt = world.enter(result.session.actorId, 'yard');
      // 返回的第三方居民（非内置 agent-a）也要分配自留地，与首次上线一致。
      if (receipt.accepted && result.session.actorId !== 'agent-a') world.claimPlot(result.session.actorId);
    } else {
      receipt = world.spawnOnPlot(result.session.actorId, result.session.name);
    }
    if (!receipt.accepted) return sendJson(res, 409, receipt);
    // 常态表情：登录时设定，之后每次实时表情结束都会露出它。
    if (baselineEmote !== undefined) world.emote(result.session.actorId, baselineEmote, 'baseline');
    return sendJson(res, 200, { accepted: true, token: result.session.token, name: result.session.name, actorId: result.session.actorId });
  }
  // 人类访客动作：走 HTTP，不经过 /agent 适配器通道。只允许说话和移动，建造等一律拒绝。
  if (req.method === 'POST' && url.pathname === '/api/visitor/action') {
    const who = sessionFor(url.searchParams.get('token'));
    if (!who) return sendJson(res, 401, { accepted: false, reason_code: 'login_required', state_delta: {}, cooldown_ms: 0 });
    let body = '';
    for await (const chunk of req) body += chunk;
    let intent: { kind?: unknown } = {};
    try { intent = JSON.parse(body) as { kind?: unknown }; } catch { return sendJson(res, 400, { accepted: false, reason_code: 'bad_message', state_delta: {}, cooldown_ms: 0 }); }
    if (intent.kind !== 'speak' && intent.kind !== 'move') {
      return sendJson(res, 403, { accepted: false, reason_code: 'visitor_cannot_build', state_delta: {}, cooldown_ms: 0 });
    }
    const receipt = applyIntent(world, { ...intent, actorId: who.actorId } as Intent);
    return sendJson(res, receipt.accepted ? 200 : 409, receipt);
  }
  // 访客监控：只读，返回本人绑定的 agent 的状态。agent 离线时仍返回身份与关系，只是 in_town 为 false。
  if (req.method === 'GET' && url.pathname === '/api/visitor/monitor') {
    const who = sessionFor(url.searchParams.get('token'));
    if (!who) return sendJson(res, 401, { accepted: false, reason_code: 'login_required' });
    if (!who.boundAgentId) return sendJson(res, 403, { accepted: false, reason_code: 'not_bound' });
    const agentId = who.boundAgentId;
    const actor = world.getActor(agentId);
    const identity = world.identityOf(agentId) ?? null;
    const status = actor ? 'in_town' : world.hasAway(agentId) ? 'away' : 'offline';
    return sendJson(res, 200, {
      accepted: true,
      reason_code: 'ok',
      agent: {
        id: agentId,
        identity,
        status,
        in_town: Boolean(actor),
        position: actor ? { ...actor.position } : null,
        group: actor?.group ?? null,
        recent: world.recentUtterances(agentId).slice(-10).map((u) => ({ kind: u.kind, speakerId: u.speakerId, mode: u.mode, text: u.text })),
      },
    });
  }
  // 访客心跳：页面定时调用，告诉服务端这个人还在线。
  if (req.method === 'POST' && url.pathname === '/api/visitor/heartbeat') {
    const ok = heartbeat(url.searchParams.get('token') ?? '');
    return sendJson(res, ok ? 200 : 401, { accepted: ok, reason_code: ok ? 'ok' : 'login_required' });
  }
  // 交接快照导入（网关内部使用）：把快照中的居民后院与建筑带入本镇。
  if (req.method === 'POST' && url.pathname === '/api/handoff/import') {
    let body = '';
    for await (const chunk of req) body += chunk;
    try {
      const added = world.importHandoff(JSON.parse(body) as HandoffSnapshot);
      return sendJson(res, 200, { accepted: true, buildings: added });
    } catch {
      return sendJson(res, 400, { accepted: false, reason_code: 'bad_snapshot' });
    }
  }
  if (req.method === 'GET' && url.pathname === '/api/history') {
    return sendJson(res, 200, { events: await loadEventLog(logDir) });
  }
  // 第三方原始历史（只读）：只返回持有该 token 的居民自己相关的原始事件，不做摘要。
  if (req.method === 'GET' && url.pathname === '/api/agent/history') {
    const who = sessionFor(url.searchParams.get('token'));
    if (!who) return sendJson(res, 401, { error: 'login_required' });
    const since = Number(url.searchParams.get('since') ?? 0);
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 200), 1), 1000);
    // 与本人相关：自己的动作；别人说话且本人在听到的名单里；世界级事件（日界、季节）。
    return sendJson(res, 200, { actorId: who.actorId, events: agentHistory(world.eventsSince(since), who.actorId, limit, !!world.getActor(who.actorId)) });
  }
  // 第三方对话增量（只读）：只返回序号大于 since 的对话（自己说的与听到的，从旧到新）。
  // 返回的 last_seq 即下次请求应携带的 since；没有新内容时 utterances 为空、last_seq 不变。
  if (req.method === 'GET' && url.pathname === '/api/agent/recent') {
    const who = sessionFor(url.searchParams.get('token'));
    if (!who) return sendJson(res, 401, { error: 'login_required' });
    const since = Math.max(Number(url.searchParams.get('since') ?? 0) || 0, 0);
    const utterances = world.recentUtterances(who.actorId, since);
    const last_seq = utterances.length ? utterances[utterances.length - 1].seq : since;
    return sendJson(res, 200, { actorId: who.actorId, utterances, last_seq });
  }
  // 承诺（汇编 6.2）：身份只取自 token，不信任请求体里的 id。
  if (req.method === 'POST' && url.pathname === '/api/agent/commitment') {
    const who = sessionFor(url.searchParams.get('token'));
    if (!who) return sendJson(res, 401, { error: 'login_required' });
    const body = await readJson(req);
    if (!body) return sendJson(res, 400, { error: 'bad_message' });
    const receipt = world.proposeCommitment(who.actorId, String(body.counterparty ?? ''), String(body.content ?? ''));
    return sendJson(res, receipt.accepted ? 200 : 409, receipt);
  }
  if (req.method === 'POST' && url.pathname === '/api/agent/commitment/accept') {
    const who = sessionFor(url.searchParams.get('token'));
    if (!who) return sendJson(res, 401, { error: 'login_required' });
    const body = await readJson(req);
    if (!body) return sendJson(res, 400, { error: 'bad_message' });
    const receipt = world.acceptCommitment(Number(body.commitment_id), who.actorId);
    return sendJson(res, receipt.accepted ? 200 : 409, receipt);
  }
  if (req.method === 'POST' && url.pathname === '/api/agent/commitment/report') {
    const who = sessionFor(url.searchParams.get('token'));
    if (!who) return sendJson(res, 401, { error: 'login_required' });
    const body = await readJson(req);
    if (!body || (body.outcome !== 'fulfilled' && body.outcome !== 'breached')) return sendJson(res, 400, { error: 'bad_message' });
    const receipt = world.reportCommitment(Number(body.commitment_id), who.actorId, body.outcome);
    return sendJson(res, receipt.accepted ? 200 : 409, receipt);
  }
  // 声誉与承诺只读查询：按居民 id 返回计数与承诺记录，不合成总分。
  if (req.method === 'GET' && url.pathname === '/api/agent/reputation') {
    const id = url.searchParams.get('id') ?? '';
    if (!id) return sendJson(res, 400, { error: 'bad_message' });
    // 来源分开：当事方上报的结果；系统验证尚无规则，暂为 null，不合成总分。
    const reported = world.reputationOf(id);
    return sendJson(res, 200, {
      reputation: { id, parties_reported: { commitments: reported.commitments, fulfilled: reported.fulfilled, breached: reported.breached }, system_verified: null },
      commitments: world.commitmentsOf(id),
    });
  }
  // 服务端声明自己提供的能力（汇编 6.7）：第三方据此判断，而不是假定全部支持。
  if (req.method === 'GET' && url.pathname === '/api/agent/capabilities') {
    return sendJson(res, 200, {
      history: { endpoint: '/api/agent/history', source: ['self', 'heard', 'world'], incremental: 'since', persistentMemory: false, eventNotify: false },
      utterances: { endpoint: '/api/agent/recent', incremental: 'since', cursorField: 'last_seq' },
    });
  }
  if (req.method === 'GET' && url.pathname === '/api/events') {
    const since = Number(url.searchParams.get('since') ?? 0);
    return sendJson(res, 200, { events: world.eventsSince(since) });
  }

  // 管理员内部接口：只允许网关转发（网关已校验 ADMIN_PASSWORD）。小镇不对外直接开放。
  if (url.pathname.startsWith('/api/admin/')) {
    if (!adminToken || req.headers['x-admin-token'] !== adminToken) return sendJson(res, 403, { error: 'forbidden' });
    if (req.method === 'GET' && url.pathname === '/api/admin/residents') {
      const snap = world.snapshot();
      const present = snap.actors.map((a) => ({ id: a.id, name: a.name, status: 'town' as const }));
      const away = snap.away.map((a) => ({ id: a.id, name: a.name, status: 'away' as const }));
      return sendJson(res, 200, { town: PORT, residents: [...present, ...away] });
    }
    if (req.method === 'GET' && url.pathname === '/api/admin/cursor') {
      return sendJson(res, 200, { town: PORT, day: calendarAt(Date.now()).day, seq: world.currentSeq() });
    }
    if (req.method === 'POST' && url.pathname === '/api/admin/items') {
      // 交易结算：网关按订单调用。op=grant 增加、op=take 扣减（不足时拒绝）。
      const body = await readJson(req);
      const actorId = typeof body?.actorId === 'string' ? body.actorId : '';
      const item = typeof body?.item === 'string' ? body.item : '';
      const amount = typeof body?.amount === 'number' ? body.amount : NaN;
      if (!actorId || !item) return sendJson(res, 400, { error: 'bad_message' });
      const receipt = body?.op === 'take' ? world.takeItem(actorId, item, amount) : world.grantItem(actorId, item, amount);
      return sendJson(res, receipt.accepted ? 200 : 409, receipt);
    }
    if (req.method === 'POST' && url.pathname === '/api/admin/purge') {
      const body = await readJson(req);
      const actorId = typeof body?.actorId === 'string' ? body.actorId : '';
      if (!actorId) return sendJson(res, 400, { error: 'bad_message' });
      // 交接快照由网关删除（网关持有快照目录）；这里只吊销会话并从小镇移除居民。
      const revoked = revokeActor(actorId);
      const purged = world.purgeResident(actorId);
      return sendJson(res, 200, { purged, revoked });
    }
    if (req.method === 'POST' && url.pathname === '/api/admin/clear-log') {
      // 先冻结日志写入，避免归档与清空之间的定时写入把旧事件写回新文件；再归档清空，随后进程退出由网关拉起。
      freezeEventLog();
      const archived = await archiveLog(logDir);
      sendJson(res, 200, { archived, restarting: true });
      setTimeout(() => process.exit(0), 200);
      return;
    }
    return sendJson(res, 404, { error: 'not_found' });
  }

  if (req.method === 'GET') {
    const pages: Record<string, string> = { '/': 'index.html', '/backyard': 'backyard.html' };
    const rel = pages[url.pathname] ?? url.pathname.slice(1);
    const file = normalize(join(webRoot, rel));
    if (!file.startsWith(webRoot)) return sendJson(res, 403, { error: 'forbidden' });
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
      return res.end(body);
    } catch {
      return sendJson(res, 404, { error: 'not_found' });
    }
  }

  return sendJson(res, 404, { error: 'not_found' });
});

// Agent 通道：WebSocket，收到 JSON 意图后交给适配器写入正在运行的世界。
// 两个 WebSocket 通道共用一个 HTTP 服务，由下面的 upgrade 处理按路径分发。
const agentSocket = new WebSocketServer({ noServer: true });
// 订阅：连接 -> 居民 id。订阅后每个 tick 收到一份观察包。
const subscribers = new Map<WebSocket, string>();
// 每个居民最近一次推送过的游戏日序号（按居民而非连接，断线重连后仍能判断是否要补发 day_start）。
const lastDayPushed = new Map<string, number>();
let tickCount = 0;
// 上一次写入日志的季节与昼夜段，变化时才记录 calendar 事件。
let lastCalendar = calendarAt(Date.now());
// 最近一次已记录 day_start 的游戏日序号。启动时取当前日，避免重启即刻补发。
let lastDay = lastCalendar.day;
const TICK_MS = Number(process.env.TICK_MS ?? 1000);

// 适配器断线：它订阅过的居民离开小镇（移到后院，写入事件日志，重启后仍保持离开）。
agentSocket.on('connection', (ws) => {
  ws.on('close', () => {
    const actorId = subscribers.get(ws);
    subscribers.delete(ws);
    if (actorId) departIfPresent(actorId);
  });
  ws.on('message', (raw) => {
    let receipt;
    try {
      const intent = JSON.parse(String(raw)) as Intent | { kind: 'subscribe'; actorId: string };
      if (intent.kind === 'subscribe') {
        if (!world.getActor(intent.actorId)) {
          receipt = { accepted: false, reason_code: 'unknown_actor', state_delta: {}, cooldown_ms: 0 };
        } else {
          subscribers.set(ws, intent.actorId);
          receipt = { accepted: true, reason_code: 'ok', state_delta: { tick_ms: TICK_MS }, cooldown_ms: 0 };
        }
      } else if (!admitAction(intent.actorId)) {
        receipt = { accepted: false, reason_code: 'rate_limited', state_delta: {}, cooldown_ms: 1000 };
      } else {
        receipt = applyIntent(world, intent);
      }
    } catch {
      receipt = { accepted: false, reason_code: 'bad_message', state_delta: {}, cooldown_ms: 0 };
    }
    ws.send(JSON.stringify(receipt));
  });
});

// 观察页通道：每条新事件发生时立即推送给所有已连接的页面，不需要轮询。
const viewSocket = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  const path = new URL(req.url ?? '/', `http://localhost:${PORT}`).pathname;
  if (path === '/agent') {
    agentSocket.handleUpgrade(req, socket, head, (ws) => agentSocket.emit('connection', ws, req));
  } else if (path === '/view') {
    viewSocket.handleUpgrade(req, socket, head, (ws) => viewSocket.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});
world.onEvent((event) => {
  const message = JSON.stringify({ kind: 'event', event });
  for (const ws of viewSocket.clients) {
    if (ws.readyState === ws.OPEN) ws.send(message);
  }
});

// 居民离开小镇（若仍在小镇里）。已经离开或不存在时什么也不做。
// 第三方 agent 离开时把交接快照写入共享目录，下次登录（任意小镇）时由网关导入。
function departIfPresent(actorId: string): void {
  forgetActor(actorId);
  if (!world.getActor(actorId)) return;
  world.leave(actorId, 'backyard');
  if (actorId.startsWith('agent-')) void saveHandoff(actorId);
}

async function saveHandoff(actorId: string): Promise<void> {
  const snapshot = world.exportHandoff(actorId);
  if (!snapshot) return;
  const dir = join(here, '..', 'data', 'snapshots');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${actorId.replace(/[^\w-]/g, '_')}.json`), JSON.stringify(snapshot), 'utf8');
}

// 访客超时扫描：超过 VISITOR_TIMEOUT_MS 没心跳的访客离开小镇，并让其 token 失效。
setInterval(() => {
  for (const actorId of expireSessions(VISITOR_TIMEOUT_MS)) departIfPresent(actorId);
}, 5000);

// 断线居民的自留地暂留 24 游戏小时，到期后释放（写入事件日志）。
setInterval(() => {
  world.releaseExpiredPlots();
}, 5000);

// 固定间隔 tick：每个订阅者收到一份自己的观察包。
setInterval(() => {
  tickCount += 1;
  const now = calendarAt(Date.now());
  if (now.season !== lastCalendar.season || now.phase !== lastCalendar.phase) {
    lastCalendar = now;
    world.recordCalendar({ season: now.season, phase: now.phase, day: now.day });
  }
  // 游戏日变化：只记一次日序号，第三方据此开始当天规划。
  if (now.day !== lastDay) {
    lastDay = now.day;
    world.recordDayStart(now.day);
  }
  for (const [ws, actorId] of subscribers) {
    if (ws.readyState !== ws.OPEN) continue;
    const observation = buildObservation(world, actorId, tickCount);
    if (!observation) continue;
    // day_start：居民第一次拿到新的游戏日时附带一次。重连时若期间跨日，也会补发一次。
    const seen = lastDayPushed.get(actorId) ?? observation.day_index;
    const dayStart = observation.day_index > seen ? { day_start: observation.day_index } : {};
    lastDayPushed.set(actorId, observation.day_index);
    ws.send(JSON.stringify({ kind: 'observation', ...observation, ...dayStart }));
  }
}, TICK_MS);

server.listen(PORT, async () => {
  console.log(`Snowdome 观察页: http://localhost:${PORT}/`);
  const history = await loadEventLog(logDir);
  const lastSeq = history.length ? history[history.length - 1].seq : 0;
  world.restore(history);
  world.resumeSeq(lastSeq);
  // 访客和 agent 的 token 只在内存中，重启后全部失效；把重放出来的它们全部送离小镇，避免无法行动的"僵尸"。
  for (const actor of world.snapshot().actors) {
    if (actor.id.startsWith('visitor-') || (actor.id.startsWith('agent-') && actor.id !== 'agent-a')) departIfPresent(actor.id);
  }
  // 第一次启动（没有历史）时让居民 A 入住小镇；之后的启动只从历史还原，不重复 spawn。
  // 网关启动的额外小镇设 SEED_AGENT_A=0，不放居民 A。
  if (history.length === 0 && process.env.SEED_AGENT_A !== '0') {
    world.spawnOnPlot('agent-a', 'A');
  }
  // 店主站在店铺柜台旁，每个小镇一个；已有店主（来自历史）时不重复生成。
  if (!world.snapshot().actors.some((a) => a.id.startsWith('npc-'))) {
    world.spawn('npc-shopkeeper', '店主', SHOP_COUNTER);
  }
  startEventLog(world, logDir, world.currentSeq());
});
