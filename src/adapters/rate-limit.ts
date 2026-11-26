// 动作频率上限：每个居民每秒最多 1 次，每 10 秒最多 5 次。超出即拒绝，不排队。
export const RATE_LIMITS = [
  { windowMs: 1000, max: 1 },
  { windowMs: 10_000, max: 5 },
] as const;

const history = new Map<string, number[]>();

// 记录一次动作尝试。通过返回 true 并计入窗口；超限返回 false 且不计入。
export function admitAction(actorId: string, now: number = Date.now()): boolean {
  const recent = (history.get(actorId) ?? []).filter((t) => now - t < RATE_LIMITS[1].windowMs);
  for (const { windowMs, max } of RATE_LIMITS) {
    if (recent.filter((t) => now - t < windowMs).length >= max) {
      history.set(actorId, recent);
      return false;
    }
  }
  recent.push(now);
  history.set(actorId, recent);
  return true;
}

export function forgetActor(actorId: string): void {
  history.delete(actorId);
}
