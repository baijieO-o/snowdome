import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { WorldEvent } from './world.ts';

// 检查点：按游戏日记录，回滚时把小镇事件与账本一起截断到该日开始前。
export interface Checkpoint {
  day: number;
  // 小镇事件：保留 seq <= townSeq 的事件。
  townSeq: number;
  // 账本：保留 id <= ledgerId 的分录。
  ledgerId: number;
  at: number;
}

// 返回游戏日 day 开始前最后一条事件的 seq；若日志中尚无该日的 day_start，返回 null。
// 游戏日界线以 day_start 事件为准，day_start 本身被截掉，回滚后该日会重新开始。
export function townCutBeforeDay(events: WorldEvent[], day: number): number | null {
  const start = events.find((e) => e.type === 'day_start' && Number((e.data as { day?: unknown }).day) >= day);
  if (!start) return null;
  return start.seq - 1;
}

export function truncateTownEvents(events: WorldEvent[], townSeq: number): WorldEvent[] {
  return events.filter((e) => e.seq <= townSeq);
}

// 每个游戏日只记录一次检查点；已存在则返回 false，不覆盖。
export function shouldCheckpoint(existing: Checkpoint[], day: number): boolean {
  return !existing.some((c) => c.day === day);
}

export async function loadCheckpoints(path: string): Promise<Checkpoint[]> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return [];
  }
  return text.split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line) as Checkpoint);
}

export async function appendCheckpoint(path: string, cp: Checkpoint): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, JSON.stringify(cp) + '\n', 'utf8');
}
