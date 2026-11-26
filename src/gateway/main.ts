import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { countActors, MAX_VISITORS_PER_TOWN, pickAgentTown, pickVisitorTown, type TownSlot } from './capacity.ts';
import { calendarAt, yearIndexAt } from '../core/calendar.ts';
import { authenticate, changePassword, loadAccounts, setBinding, type AccountStore } from './accounts.ts';
import { balanceOf, issue, loadLedger, WELCOME_GOLD } from './ledger.ts';
import { cancelOrder, expireOrders, fillOrder, newMarket, postOrder, type ItemPort, type Market } from './market.ts';
import { appendCheckpoint, loadCheckpoints, shouldCheckpoint, type Checkpoint } from '../core/checkpoint.ts';

// 网关：对外监听 PORT（默认 3000），把请求路由到若干小镇进程。小镇进程从 TOWN_BASE_PORT（默认 3001）起，每个一个端口。
const PORT = Number(process.env.PORT ?? 3000);
const TOWN_BASE_PORT = Number(process.env.TOWN_BASE_PORT ?? 3001);
const root = fileURLToPath(new URL('../../', import.meta.url));
const townEntry = fileURLToPath(new URL('../server.ts', import.meta.url));

interface Town {
  index: number;
  port: number;
  child: ChildProcess;
}

const towns: Town[] = [];
// 网关与小镇之间的内部令牌：每次网关启动随机生成并经环境变量传给小镇，小镇据此拒绝绕过网关的管理请求。
const ADMIN_INTERNAL_TOKEN = randomBytes(24).toString('hex');
// 网关正在关闭时，小镇退出不再自动重启。
let shuttingDown = false;
// token -> 小镇端口（登录时记录），actorId -> 小镇端口（用于 /agent 订阅路由）。
const tokenRoutes = new Map<string, number>();
// token -> actorId，用于管理员删除居民时精确清理该居民的 token。
const tokenOwners = new Map<string, string>();
// 访客 token 对应的账号名，市场按账号识别买卖双方（决策 8）。
const tokenAccounts = new Map<string, string>();
// 账号名 -> 当前 actorId。访客 actorId 在小镇重启后会变，因此每次登录更新。
const accountActors = new Map<string, string>();
const actorRoutes = new Map<string, number>();
// 第三方居民（agent-<agentId>）上次所在的小镇端口：断线重连时优先换到别的小镇（轮换）。
// 居民上次所在的小镇端口，以及当时的游戏年序号（用于判断是否需要年度轮换）。
const lastTown = new Map<string, { port: number; year: number }>();
// 第三方居民的 /agent 连接：到游戏年时用来强制断开，让适配器重登并换镇。
const agentConnections = new Map<string, Set<WebSocket>>();

// 启动一个小镇进程。第 1 个沿用原来的 data/（历史不迁移），之后的用 data/town-<n>/。
// 第 2 个及之后的小镇不放居民 A。
function startTown(): Town {
  const index = towns.length + 1;
  const port = TOWN_BASE_PORT + index - 1;
  const dataDir = index === 1 ? join(root, 'data') : join(root, 'data', `town-${index}`);
  const town: Town = { index, port, child: spawnTownProcess(index, port, dataDir) };
  towns.push(town);
  console.log(`启动小镇 ${index}：端口 ${port}，数据目录 ${dataDir}`);
  return town;
}

// 小镇异常退出时按原端口与数据目录拉起，并更新 town.child 指向新进程。
function spawnTownProcess(index: number, port: number, dataDir: string): ChildProcess {
  const child = spawn(process.execPath, ['--experimental-strip-types', townEntry], {
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, SEED_AGENT_A: index === 1 ? '1' : '0', ADMIN_INTERNAL_TOKEN },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  child.on('exit', (code) => {
    console.log(`小镇 ${index}（端口 ${port}）已退出，代码 ${code}`);
    if (shuttingDown) return;
    const town = towns.find((t) => t.index === index);
    if (town) town.child = spawnTownProcess(index, port, dataDir);
    console.log(`小镇 ${index}（端口 ${port}）已自动重启`);
  });
  return child;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitReady(port: number): Promise<void> {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://localhost:${port}/api/state`);
      if (res.ok) return;
    } catch { /* 还没启动好，继续等 */ }
    await sleep(300);
  }
  throw new Error(`小镇端口 ${port} 启动超时`);
}

// 读取某个小镇当前在场的居民 id 与占用的自留地数；小镇不可用时返回 undefined。
async function townState(port: number): Promise<{ ids: string[]; plotsHeld: number } | undefined> {
  try {
    const res = await fetch(`http://localhost:${port}/api/state`);
    const state = (await res.json()) as { actors: { id: string }[]; plots: { holder: string | null }[] };
    return {
      ids: state.actors.map((a) => a.id),
      plotsHeld: state.plots.filter((p) => p.holder !== null).length,
    };
  } catch {
    return undefined;
  }
}

async function refreshActorRoutes(): Promise<void> {
  for (const town of towns) {
    const state = await townState(town.port);
    for (const id of state?.ids ?? []) actorRoutes.set(id, town.port);
  }
}

// 各小镇当前的 agent 与访客人数；agent 数取在场人数与占用自留地数的较大值，暂留的地块同样占名额。
// 小镇不可用时视为满员，避免把人分到坏掉的镇上。
async function townSlots(): Promise<TownSlot[]> {
  const slots: TownSlot[] = [];
  for (const town of towns) {
    const state = await townState(town.port);
    if (!state) {
      slots.push({ id: String(town.index), port: town.port, agents: Number.POSITIVE_INFINITY, visitors: Number.POSITIVE_INFINITY });
      continue;
    }
    const counts = countActors(state.ids);
    slots.push({ id: String(town.index), port: town.port, agents: Math.max(counts.agents, state.plotsHeld), visitors: counts.visitors });
  }
  return slots;
}

// 为 agent 选一个未满的小镇；全部满员时新开一个。
async function pickAgentPort(origin: { port: number; year: number } | undefined): Promise<number> {
  // 同一游戏年内重连优先回原镇；跨年则强制换镇（年度轮换）。
  const rotate = origin !== undefined && origin.year !== yearIndexAt(Date.now());
  const slot = pickAgentTown(await townSlots(), origin?.port, rotate);
  if (slot) return slot.port;
  const town = startTown();
  await waitReady(town.port);
  return town.port;
}

// 为访客选一个访客名额未满的小镇；全部满员不新开小镇，返回 undefined（由调用方回 409）。
async function pickVisitorPort(): Promise<{ port: number } | { full: TownSlot[] }> {
  const slots = await townSlots();
  const slot = pickVisitorTown(slots);
  return slot ? { port: slot.port } : { full: slots };
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

// 把请求原样转发给某个小镇，并把响应写回客户端。
async function forward(req: IncomingMessage, res: ServerResponse, port: number, body: Buffer, extra?: Record<string, unknown>): Promise<{ status: number; payload: Buffer }> {
  const headers: Record<string, string> = {};
  const contentType = req.headers['content-type'];
  if (contentType) headers['content-type'] = contentType;
  const upstream = await fetch(`http://localhost:${port}${req.url ?? '/'}`, {
    method: req.method,
    headers,
    body: body.length > 0 ? body : undefined,
  });
  let payload = Buffer.from(await upstream.arrayBuffer());
  // 网关附加的字段（如登录所在实例端口）只在成功响应中加入，不改变小镇返回的其他内容。
  if (extra && upstream.status === 200) {
    payload = Buffer.from(JSON.stringify({ ...JSON.parse(payload.toString()), ...extra }));
  }
  const outHeaders: Record<string, string> = { 'cache-control': 'no-store' };
  const outType = upstream.headers.get('content-type');
  if (outType) outHeaders['content-type'] = outType;
  res.writeHead(upstream.status, outHeaders);
  res.end(payload);
  return { status: upstream.status, payload };
}

// 登录串行化：避免两个并发登录同时看到同一个小镇有空位，导致超出容量。
let loginChain: Promise<unknown> = Promise.resolve();
function serializeLogin(task: () => Promise<void>): Promise<void> {
  const run = loginChain.then(task);
  loginChain = run.catch(() => undefined);
  return run;
}

const defaultPort = () => towns[0].port;

// 账号库：所有小镇共享，存在 data/accounts.json，启动时读取一次。
const accountsPath = join(root, 'data', 'accounts.json');
const accounts: AccountStore = await loadAccounts(accountsPath);
// 中心账本：游戏币记账，归网关所有（决策 8）。
const ledger = await loadLedger(join(root, 'data', 'ledger.jsonl'));
// 检查点：每个游戏日记录一次，回滚时同时截断小镇事件与账本（由网关生成，决策 9）。
const checkpointPath = join(root, 'data', 'checkpoints.jsonl');
const checkpoints = await loadCheckpoints(checkpointPath);

// 游标取各小镇的最小值，保证回滚时不会遗漏任何小镇的事件。
async function recordCheckpointIfNewDay(): Promise<void> {
  const cursors = await townAdmin('GET', '/api/admin/cursor');
  const live = cursors.filter((c) => c.data !== undefined);
  if (live.length === 0) return;
  const days = new Set(live.map((c) => Number(c.data?.day ?? 0)));
  // 只有所有在线小镇都已进入同一游戏日才记录，避免跨日时游标落在日界线两侧。
  if (days.size !== 1) return;
  const day = [...days][0];
  if (!shouldCheckpoint(checkpoints, day)) return;
  const townSeq = Math.min(...live.map((c) => Number(c.data?.seq ?? 0)));
  const cp: Checkpoint = { day, townSeq, ledgerId: ledger.entries.at(-1)?.id ?? 0, at: Date.now() };
  await appendCheckpoint(checkpointPath, cp);
  checkpoints.push(cp);
}
setInterval(() => { recordCheckpointIfNewDay().catch(() => {}); }, 60_000).unref();

// 市场订单簿：网关持有，随账本一起管理（决策 8）。挂单过期按游戏日判定，每分钟检查一次。
const market: Market = newMarket();
setInterval(() => { expireOrders(market, calendarAt(Date.now()).day); }, 60_000).unref();

// 物品 port：通过小镇内部接口增减背包；小镇不可用或拒绝时返回 false。
function itemPort(actorId: string, port: number): ItemPort {
  return {
    async move(id, item, amount, op) {
      try {
        const res = await fetch(`http://localhost:${port}/api/admin/items`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-admin-token': ADMIN_INTERNAL_TOKEN },
          body: JSON.stringify({ actorId: id, item, amount, op }),
        });
        return res.ok;
      } catch {
        return false;
      }
    },
  };
}

// 按账号解析当前 actorId 与小镇端口；账号未在线或路由已失效时返回 undefined。
function resolveAccount(name: string): { actorId: string; port: number } | undefined {
  const actorId = accountActors.get(name);
  const port = actorId ? actorRoutes.get(actorId) : undefined;
  return actorId && port !== undefined ? { actorId, port } : undefined;
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(payload));
}

// 管理页：独立静态页面，不在观察页与地图上。
const adminPagePath = fileURLToPath(new URL('../web/admin.html', import.meta.url));
async function serveAdminPage(res: ServerResponse): Promise<void> {
  const html = await readFile(adminPagePath, 'utf8');
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(html);
}

// 交接快照目录：居民离开的快照存成 <actorId>.json，下次登录时读取并导入目标小镇。
const snapshotDir = join(root, 'data', 'snapshots');
const snapshotPath = (actorId: string) => join(snapshotDir, `${actorId.replace(/[^\w-]/g, '_')}.json`);

// 登录后若存在快照，导入到目标小镇，并删除快照文件（只导入一次）。
async function restoreSnapshot(actorId: string, port: number): Promise<void> {
  let text: string;
  try {
    text = await readFile(snapshotPath(actorId), 'utf8');
  } catch {
    return;
  }
  const res = await fetch(`http://localhost:${port}/api/handoff/import`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: text,
  });
  if (res.ok) await rm(snapshotPath(actorId), { force: true });
}

// 管理员入口：密码来自环境变量 ADMIN_PASSWORD；未设置时整个管理入口关闭。
// 登录后签发仅存于内存的管理会话（重启即失效），密码之后不再随请求发送。
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? '';
const adminSessions = new Map<string, number>();
const ADMIN_SESSION_MS = 8 * 60 * 60 * 1000;

function passwordMatches(input: unknown): boolean {
  if (!ADMIN_PASSWORD || typeof input !== 'string') return false;
  const a = createHash('sha256').update(input).digest();
  const b = createHash('sha256').update(ADMIN_PASSWORD).digest();
  return timingSafeEqual(a, b);
}

function adminSessionValid(req: IncomingMessage): boolean {
  const token = req.headers['x-admin-session'];
  if (typeof token !== 'string') return false;
  const expires = adminSessions.get(token);
  if (expires === undefined || expires < Date.now()) {
    adminSessions.delete(token);
    return false;
  }
  return true;
}

// 向所有小镇发起内部管理请求，返回各小镇的响应（小镇不可用时记为 undefined）。
async function townAdmin(method: string, path: string, body?: unknown): Promise<Array<{ port: number; data: Record<string, unknown> | undefined }>> {
  return Promise.all(towns.map(async (town) => {
    try {
      const res = await fetch(`http://localhost:${town.port}${path}`, {
        method,
        headers: { 'content-type': 'application/json', 'x-admin-token': ADMIN_INTERNAL_TOKEN },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { port: town.port, data: (await res.json()) as Record<string, unknown> };
    } catch {
      return { port: town.port, data: undefined };
    }
  }));
}

// 删除居民后清理网关路由：该居民的 token 与 actor 路由一并移除。
function forgetRoutes(actorId: string): void {
  actorRoutes.delete(actorId);
  lastTown.delete(actorId);
  for (const [token, owner] of tokenOwners) {
    if (owner !== actorId) continue;
    tokenOwners.delete(token);
    tokenRoutes.delete(token);
    tokenAccounts.delete(token);
  }
  for (const [name, id] of accountActors) if (id === actorId) accountActors.delete(name);
}

async function handleAdmin(req: IncomingMessage, res: ServerResponse, url: URL, body: Buffer): Promise<void> {
  if (!ADMIN_PASSWORD) return sendJson(res, 503, { error: 'admin_disabled' });
  if (req.method === 'POST' && url.pathname === '/api/admin/login') {
    const parsed = JSON.parse(body.toString() || '{}') as { password?: unknown };
    if (!passwordMatches(parsed.password)) return sendJson(res, 403, { accepted: false, reason_code: 'wrong_password' });
    const token = randomBytes(24).toString('hex');
    adminSessions.set(token, Date.now() + ADMIN_SESSION_MS);
    return sendJson(res, 200, { accepted: true, token });
  }
  if (!adminSessionValid(req)) return sendJson(res, 401, { error: 'admin_login_required' });

  if (req.method === 'GET' && url.pathname === '/api/admin/residents') {
    const results = await townAdmin('GET', '/api/admin/residents');
    const residents = results.flatMap((r) => ((r.data?.residents as Array<Record<string, unknown>> | undefined) ?? []).map((resident) => ({ ...resident, town: r.port })));
    return sendJson(res, 200, { residents, towns: results.map((r) => ({ port: r.port, ok: r.data !== undefined })) });
  }
  if (req.method === 'POST' && url.pathname === '/api/admin/purge') {
    const parsed = JSON.parse(body.toString() || '{}') as { actorId?: unknown };
    const actorId = typeof parsed.actorId === 'string' ? parsed.actorId : '';
    if (!actorId) return sendJson(res, 400, { error: 'bad_message' });
    const results = await townAdmin('POST', '/api/admin/purge', { actorId });
    const purged = results.some((r) => r.data?.purged === true);
    // 账号本身保留（账号与居民是两回事）；这里只清除居民在网关的路由与交接快照。
    if (purged) {
      forgetRoutes(actorId);
      await rm(snapshotPath(actorId), { force: true });
    }
    return sendJson(res, 200, { purged, towns: results.map((r) => ({ port: r.port, ok: r.data !== undefined })) });
  }
  if (req.method === 'POST' && url.pathname === '/api/admin/clear-log') {
    // 每个小镇各自的日志：归档后清空，然后小镇退出，由网关自动拉起（内存与日志保持一致）。
    const results = await townAdmin('POST', '/api/admin/clear-log');
    return sendJson(res, 200, { towns: results.map((r) => ({ port: r.port, ok: r.data !== undefined, archived: r.data?.archived ?? null })) });
  }
  return sendJson(res, 404, { error: 'not_found' });
}

// 市场接口：挂单/取消/成交都要求访客登录（带 token），身份由 token 对应的账号决定。
async function handleMarket(req: IncomingMessage, res: ServerResponse, url: URL, body: Buffer): Promise<void> {
  if (req.method === 'GET' && url.pathname === '/api/market/orders') {
    return sendJson(res, 200, { orders: market.orders.filter((o) => o.status === 'open') });
  }
  if (req.method !== 'POST') return sendJson(res, 404, { error: 'not_found' });
  const parsed = JSON.parse(body.toString() || '{}') as Record<string, unknown>;
  const token = typeof parsed.token === 'string' ? parsed.token : '';
  const account = tokenAccounts.get(token);
  if (!account || !tokenRoutes.has(token)) return sendJson(res, 401, { accepted: false, reason_code: 'login_required' });

  if (url.pathname === '/api/market/post') {
    const { item, amount, price, expiresDay } = parsed as { item?: unknown; amount?: unknown; price?: unknown; expiresDay?: unknown };
    if (typeof item !== 'string' || !item) return sendJson(res, 400, { accepted: false, reason_code: 'bad_item' });
    if (typeof amount !== 'number' || typeof price !== 'number' || typeof expiresDay !== 'number') {
      return sendJson(res, 400, { accepted: false, reason_code: 'bad_message' });
    }
    try {
      const order = postOrder(market, { seller: account, item, amount, price, expiresDay });
      return sendJson(res, 200, { accepted: true, order });
    } catch (error) {
      return sendJson(res, 400, { accepted: false, reason_code: error instanceof Error ? error.message : 'bad_message' });
    }
  }
  if (url.pathname === '/api/market/cancel') {
    const id = Number(parsed.id);
    const cancelled = cancelOrder(market, id, account);
    return sendJson(res, cancelled ? 200 : 409, { accepted: cancelled });
  }
  if (url.pathname === '/api/market/fill') {
    const id = Number(parsed.id);
    const buyer = resolveAccount(account);
    const order = market.orders.find((o) => o.id === id);
    const seller = order ? resolveAccount(order.seller) : undefined;
    if (!buyer || !seller) return sendJson(res, 409, { accepted: false, reason_code: 'party_offline' });
    const result = await fillOrder(
      market,
      ledger,
      { seller: itemPort(seller.actorId, seller.port), buyer: itemPort(buyer.actorId, buyer.port) },
      id,
      { key: account, actorId: buyer.actorId },
      { actorId: seller.actorId },
    );
    return sendJson(res, result.ok ? 200 : 409, result.ok ? { accepted: true, order: result.order } : { accepted: false, reason_code: result.reason });
  }
  return sendJson(res, 404, { error: 'not_found' });
}

const server = createServer(async (req, res) => {
  try {
    let body = await readBody(req);
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname.startsWith('/api/admin/')) return await handleAdmin(req, res, url, body);
    if (req.method === 'GET' && url.pathname === '/admin') {
      return void (await serveAdminPage(res));
    }
    if (req.method === 'POST' && url.pathname === '/api/login') {
      let accountName = '';
      await serializeLogin(async () => {
        // 快照只属于 agent：先选镇（同年内优先回原镇；跨年换镇），再导入快照，最后由小镇登录逻辑让居民返回。
        const parsed = JSON.parse(body.toString() || '{}') as { kind?: unknown; agentId?: unknown };
        const agentActorId = parsed.kind === 'agent' && typeof parsed.agentId === 'string' && /^[\w-]{1,64}$/.test(parsed.agentId)
          ? `agent-${parsed.agentId}`
          : undefined;
        let port: number;
        if (agentActorId) {
          port = await pickAgentPort(lastTown.get(agentActorId));
        } else {
          // 访客：先校验账号密码（错误密码不占名额），再检查访客名额；满了直接回 409，不转发到小镇。
          const parsedLogin = JSON.parse(body.toString() || '{}') as { name?: unknown; password?: unknown; bindAgentId?: unknown };
          const name = typeof parsedLogin.name === 'string' ? parsedLogin.name.trim() : '';
          if (name) {
            const auth = await authenticate(accounts, name, parsedLogin.password);
            if (!auth.ok) return sendJson(res, auth.reason === 'wrong_password' ? 403 : 400, { accepted: false, reason_code: auth.reason });
            // 欢迎金只在首次注册时发一次。
            if (auth.created) await issue(ledger, 'welcome', name, WELCOME_GOLD);
            // 未指定绑定时沿用账号上次绑定的 agent；指定了就以新值为准并持久化。
            if (parsedLogin.bindAgentId === undefined && auth.account.boundAgentId) {
              body = Buffer.from(JSON.stringify({ ...parsedLogin, bindAgentId: auth.account.boundAgentId.replace(/^agent-/, '') }));
            }
            accountName = name;
          }
          const picked = await pickVisitorPort();
          if (!('port' in picked)) {
            res.writeHead(409, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
            res.end(JSON.stringify({
              accepted: false,
              reason_code: 'town_full',
              hint: '当前小镇访客已满，请换一个实例或稍后再试',
              instances: picked.full.map((t) => ({ id: t.id, port: t.port, visitors: t.visitors, max: MAX_VISITORS_PER_TOWN })),
            }));
            return;
          }
          port = picked.port;
        }
        if (agentActorId) await restoreSnapshot(agentActorId, port);
        const up = await forward(req, res, port, body, { port });
        if (up.status !== 200) return;
        const data = JSON.parse(up.payload.toString()) as { token: string; actorId: string };
        tokenRoutes.set(data.token, port);
        tokenOwners.set(data.token, data.actorId);
        actorRoutes.set(data.actorId, port);
        if (accountName) {
          tokenAccounts.set(data.token, accountName);
          accountActors.set(accountName, data.actorId);
        }
        if (agentActorId) lastTown.set(agentActorId, { port, year: yearIndexAt(Date.now()) });
        // 访客登录成功且带了绑定：写入账号，之后重新登录自动恢复。
        if (accountName) {
          const bound = JSON.parse(body.toString() || '{}') as { bindAgentId?: unknown };
          if (typeof bound.bindAgentId === 'string') await setBinding(accounts, accountName, `agent-${bound.bindAgentId}`);
        }
      });
      return;
    }
    if (url.pathname.startsWith('/api/market/')) return await handleMarket(req, res, url, body);
    if (req.method === 'GET' && url.pathname === '/api/ledger/balance') {
      const name = (url.searchParams.get('name') ?? '').trim();
      if (!name) return sendJson(res, 400, { accepted: false, reason_code: 'name_required' });
      return sendJson(res, 200, { name, balance: balanceOf(ledger, name) });
    }
    if (req.method === 'POST' && url.pathname === '/api/account/password') {
      const parsed = JSON.parse(body.toString() || '{}') as { name?: unknown; oldPassword?: unknown; newPassword?: unknown };
      const name = typeof parsed.name === 'string' ? parsed.name.trim() : '';
      const result = name
        ? await changePassword(accounts, name, parsed.oldPassword, parsed.newPassword)
        : { ok: false as const, reason: 'wrong_password' as const };
      if (!result.ok) return sendJson(res, result.reason === 'wrong_password' ? 403 : 400, { accepted: false, reason_code: result.reason });
      return sendJson(res, 200, { accepted: true });
    }
    if (req.method === 'GET' && (url.pathname === '/api/agent/history' || url.pathname === '/api/agent/recent' || url.pathname === '/api/visitor/monitor')) {
      // 按 token 路由到该居民所在的小镇（与 visitor 接口一致）；401 时丢弃过期路由。
      const token = url.searchParams.get('token') ?? '';
      const up = await forward(req, res, tokenRoutes.get(token) ?? defaultPort(), body);
      if (up.status === 401) tokenRoutes.delete(token);
      return;
    }
    if (req.method === 'POST' && (url.pathname === '/api/visitor/action' || url.pathname === '/api/visitor/heartbeat' || url.pathname.startsWith('/api/agent/commitment'))) {
      const token = url.searchParams.get('token') ?? '';
      const up = await forward(req, res, tokenRoutes.get(token) ?? defaultPort(), body);
      if (up.status === 401) tokenRoutes.delete(token);
      return;
    }
    await forward(req, res, defaultPort(), body);
  } catch {
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'upstream_unavailable' }));
    }
  }
});

// 到小镇的 WebSocket 连接：连接建立前的消息先排队，建立后按序发送。
interface Upstream {
  send(text: string): void;
  close(): void;
}
function openUpstream(port: number, path: string, onMessage: (text: string) => void, onClose: () => void): Upstream {
  const up = new WebSocket(`ws://localhost:${port}${path}`);
  const queue: string[] = [];
  let open = false;
  up.on('open', () => {
    open = true;
    for (const text of queue.splice(0)) up.send(text);
  });
  up.on('message', (data) => onMessage(data.toString()));
  up.on('close', onClose);
  up.on('error', onClose);
  return {
    send(text) {
      if (open) up.send(text);
      else queue.push(text);
    },
    close() {
      up.close();
    },
  };
}

// Agent 通道：第一条订阅消息决定转发到哪个小镇（按 actorId 查路由）。
const agentSocket = new WebSocketServer({ noServer: true });
agentSocket.on('connection', (ws) => {
  let upstream: Upstream | undefined;
  let subscribed: string | undefined;
  const buffered: string[] = [];
  let draining = false;
  ws.on('close', () => {
    if (subscribed) agentConnections.get(subscribed)?.delete(ws);
  });
  const reply = (reason: string) => {
    ws.send(JSON.stringify({ accepted: false, reason_code: reason, state_delta: {}, cooldown_ms: 0 }));
  };
  const drain = async () => {
    if (draining) return;
    draining = true;
    while (!upstream && buffered.length > 0) {
      const raw = buffered.shift() as string;
      let actorId: string | undefined;
      try {
        const intent = JSON.parse(raw) as { kind?: unknown; actorId?: unknown };
        if (intent.kind === 'subscribe' && typeof intent.actorId === 'string') actorId = intent.actorId;
      } catch { /* 非 JSON 视为未订阅 */ }
      if (actorId === undefined) {
        reply('not_subscribed');
        continue;
      }
      let port = actorRoutes.get(actorId);
      if (port === undefined) {
        await refreshActorRoutes();
        port = actorRoutes.get(actorId);
      }
      if (port === undefined) {
        reply('unknown_actor');
        continue;
      }
      upstream = openUpstream(port, '/agent', (text) => ws.send(text), () => ws.close());
      upstream.send(raw);
      subscribed = actorId;
      if (!agentConnections.has(actorId)) agentConnections.set(actorId, new Set());
      agentConnections.get(actorId)?.add(ws);
    }
    if (upstream) for (const text of buffered.splice(0)) upstream.send(text);
    draining = false;
  };
  ws.on('message', (data) => {
    const text = data.toString();
    if (upstream) upstream.send(text);
    else {
      buffered.push(text);
      void drain();
    }
  });
  ws.on('close', () => upstream?.close());
});

// 观察页通道：转发到默认小镇（第 1 个）。观察页目前只显示一个小镇。
const viewSocket = new WebSocketServer({ noServer: true });
viewSocket.on('connection', (ws) => {
  const up = openUpstream(defaultPort(), '/view', (text) => {
    if (ws.readyState === ws.OPEN) ws.send(text);
  }, () => ws.close());
  ws.on('close', () => up.close());
});

server.on('upgrade', (req, socket, head) => {
  const path = new URL(req.url ?? '/', 'http://localhost').pathname;
  if (path === '/agent') {
    agentSocket.handleUpgrade(req, socket, head, (ws) => agentSocket.emit('connection', ws, req));
  } else if (path === '/view') {
    viewSocket.handleUpgrade(req, socket, head, (ws) => viewSocket.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});

// 游戏年轮换：年序号变化时，断开所有第三方居民的连接。小镇侧会把他们送离并写快照，适配器重登后按轮换规则换镇。
let currentYear = yearIndexAt(Date.now());
setInterval(() => {
  const year = yearIndexAt(Date.now());
  if (year === currentYear) return;
  currentYear = year;
  for (const sockets of agentConnections.values()) {
    for (const ws of sockets) ws.close();
  }
  agentConnections.clear();
  console.log(`游戏年 ${year} 开始，第三方居民轮换到新小镇`);
}, 60000);

const shutdown = () => {
  shuttingDown = true;
  for (const town of towns) town.child.kill();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

const first = startTown();
await waitReady(first.port);
await refreshActorRoutes();
server.listen(PORT, () => {
  console.log(`Snowdome 网关: http://localhost:${PORT}/`);
});
