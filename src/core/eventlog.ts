import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { World, WorldEvent } from './world.ts';

const FLUSH_MS = 1000;

// 管理员清空日志时置位：之后不再把内存事件写回日志，避免清空后旧事件重新出现。
let frozen = false;
export function freezeEventLog(): void {
  frozen = true;
}

// 事件实时追加到一个 JSONL 文件，每行一条事件。服务重启后历史仍可回放。
export function startEventLog(world: World, dir: string, flushedSeq = 0): () => void {
  const file = join(dir, 'events.jsonl');
  let flushed = flushedSeq; // 已写入日志的最大序号
  const flush = async (): Promise<void> => {
    if (frozen) return;
    const fresh = world.eventsSince(flushed);
    if (fresh.length === 0) return;
    await mkdir(dir, { recursive: true });
    await appendFile(file, fresh.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
    flushed = fresh[fresh.length - 1].seq;
    world.markFlushed(flushed);
  };
  const timer = setInterval(() => void flush(), FLUSH_MS);
  return () => {
    clearInterval(timer);
    void flush();
  };
}

// 读取全部历史事件。文件不存在时返回空数组。
export async function loadEventLog(dir: string): Promise<WorldEvent[]> {
  try {
    const text = await readFile(join(dir, 'events.jsonl'), 'utf8');
    return text
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as WorldEvent);
  } catch {
    return [];
  }
}
