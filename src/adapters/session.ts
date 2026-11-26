import { randomBytes } from 'node:crypto';

// 本地登录：只填昵称即可进入，不设密码，不涉及真实账号。
// 登录后得到 token，之后的动作请求带上它才会被接受。
// 未登录的访客只能观察，并自动分配"游客N"的名字。
export interface Session {
  token: string;
  name: string;
  guest: boolean;
  // 登录后在世界里对应的访客居民 id；游客为空。
  actorId: string;
  // 访客绑定的 agent 居民 id（用于监控）；未绑定为空。绑定只存在于会话中，不改变 agent 的身份。
  boundAgentId?: string;
}

const NAME_MAX = 16;
const sessions = new Map<string, Session>();
// 每个 token 最近一次心跳的时间（毫秒）。超时未心跳的访客会被清出小镇。
const lastSeen = new Map<string, number>();
let guestCount = 0;
// 账号名 -> 最近一次登录得到的访客 actorId。同一账号再次登录时沿用它，避免小镇里出现两个同名访客。
const visitorByAccount = new Map<string, string>();

// kind 为 'agent' 时是第三方 agent 适配器登录，按居民处理（分配自留地）；否则是网页访客。
// agentId 为适配器提供的稳定身份：同一 agentId 每次登录得到同一个 actorId，快照据此找回。
export function login(rawName: string, kind: 'visitor' | 'agent' = 'visitor', now = Date.now(), agentId?: string, boundAgentId?: string): { ok: true; session: Session } | { ok: false; reason: string } {
  const name = rawName.trim();
  if (!name) return { ok: false, reason: 'empty_name' };
  if (name.length > NAME_MAX) return { ok: false, reason: 'name_too_long' };
  const stable = kind === 'agent' && agentId && /^[\w-]{1,64}$/.test(agentId);
  // 访客同账号重复登录：沿用上次的 actorId（小镇里仍是同一位访客），旧 token 失效。
  const reused = kind === 'visitor' ? visitorByAccount.get(name) : undefined;
  const actorId = stable ? `agent-${agentId}` : reused ?? `${kind === 'agent' ? 'agent' : 'visitor'}-${randomBytes(4).toString('hex')}`;
  if (reused) {
    for (const [token, old] of sessions) if (old.actorId === reused) { sessions.delete(token); lastSeen.delete(token); }
  }
  if (kind === 'visitor') visitorByAccount.set(name, actorId);
  const session: Session = { token: randomBytes(16).toString('hex'), name, guest: false, actorId };
  if (kind === 'visitor' && boundAgentId) session.boundAgentId = boundAgentId;
  sessions.set(session.token, session);
  // agent 不发心跳，靠 WebSocket 断线离开，因此不进入超时扫描。
  if (kind === 'visitor') lastSeen.set(session.token, now);
  return { ok: true, session };
}

// 心跳：刷新 token 的最后活跃时间。token 不存在时返回 false。agent 的心跳只确认有效，不计入超时。
export function heartbeat(token: string, now = Date.now()): boolean {
  const session = sessions.get(token);
  if (!session) return false;
  if (session.actorId.startsWith('visitor-')) lastSeen.set(token, now);
  return true;
}

// 取出超时未心跳的访客会话并删除，返回它们的 actorId 供调用方让居民离开。
export function expireSessions(timeoutMs: number, now = Date.now()): string[] {
  const gone: string[] = [];
  for (const [token, seen] of lastSeen) {
    if (now - seen < timeoutMs) continue;
    const session = sessions.get(token);
    if (session) gone.push(session.actorId);
    sessions.delete(token);
    lastSeen.delete(token);
  }
  return gone;
}

// 游客：没有 token 时自动分配名字，只能观察。
export function guestSession(): Session {
  guestCount += 1;
  return { token: '', name: `游客${guestCount}`, guest: true, actorId: '' };
}

// 管理员踢人或删除：吊销该居民的全部 token，返回被吊销的数量。访客的同名账号映射一并清除。
export function revokeActor(actorId: string): number {
  let count = 0;
  for (const [token, session] of sessions) {
    if (session.actorId !== actorId) continue;
    sessions.delete(token);
    lastSeen.delete(token);
    count += 1;
  }
  for (const [name, id] of visitorByAccount) if (id === actorId) visitorByAccount.delete(name);
  return count;
}

export function sessionFor(token: string | null | undefined): Session | undefined {
  if (!token) return undefined;
  return sessions.get(token);
}
