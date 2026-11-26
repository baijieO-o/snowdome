import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendCheckpoint, loadCheckpoints, shouldCheckpoint, townCutBeforeDay, truncateTownEvents } from '../src/core/checkpoint.ts';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorldEvent } from '../src/core/world.ts';

function ev(seq: number, type: WorldEvent['type'], data: Record<string, unknown> = {}): WorldEvent {
  return { seq, time: seq, type, actorId: 'world', data };
}

const log: WorldEvent[] = [
  ev(1, 'day_start', { day: 1 }),
  ev(2, 'move', { to: { x: 1, y: 0, z: 0 } }),
  ev(3, 'day_start', { day: 2 }),
  ev(4, 'speak', { text: 'hi' }),
  ev(5, 'day_start', { day: 3 }),
];

test('回滚到第 2 日：截到第 2 日 day_start 之前', () => {
  assert.equal(townCutBeforeDay(log, 2), 2);
  assert.deepEqual(truncateTownEvents(log, 2).map((e) => e.seq), [1, 2]);
});

test('目标日不在日志中：返回 null，不截断', () => {
  assert.equal(townCutBeforeDay(log, 9), null);
});

test('同一游戏日只记录一次，检查点往返可读回', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cp-'));
  try {
    const path = join(dir, 'checkpoints.jsonl');
    const first = { day: 2, townSeq: 3, ledgerId: 7, at: 1 };
    await appendCheckpoint(path, first);
    const existing = await loadCheckpoints(path);
    assert.deepEqual(existing, [first]);
    assert.equal(shouldCheckpoint(existing, 2), false);
    assert.equal(shouldCheckpoint(existing, 3), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('回滚到第 1 日：只保留空前缀', () => {
  assert.equal(townCutBeforeDay(log, 1), 0);
  assert.deepEqual(truncateTownEvents(log, 0), []);
});
