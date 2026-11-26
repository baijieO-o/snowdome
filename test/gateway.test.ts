import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickTown, pickAgentTown, pickVisitorTown, countActors } from '../src/gateway/capacity.ts';
import { yearIndexAt, DAY_MS, SEASON_DAYS } from '../src/core/calendar.ts';
import { World, type HandoffSnapshot } from '../src/core/world.ts';
import { VoxelGrid } from '../src/core/voxel.ts';

test('调度：第一个 agent 未满的小镇优先，全满返回 undefined', () => {
  const towns = [
    { id: 'a', port: 3001, agents: 8, visitors: 0 },
    { id: 'b', port: 3002, agents: 7, visitors: 0 },
    { id: 'c', port: 3003, agents: 0, visitors: 0 },
  ];
  assert.equal(pickTown(towns, 8)?.id, 'b');
  assert.equal(pickTown([{ id: 'a', port: 3001, agents: 8, visitors: 0 }], 8), undefined);
});

test('容量：访客不计入 agent 名额，agent 也不占访客名额', () => {
  assert.deepEqual(countActors(['agent-a', 'visitor-1', 'visitor-2']), { agents: 1, visitors: 2 });
  // 镇上有 8 个访客但 agent 只有 1 个：agent 仍可进入，访客满后不再分配。
  const town = { id: 'a', port: 3001, agents: 1, visitors: 8 };
  assert.equal(pickTown([town], 8)?.id, 'a');
  assert.equal(pickVisitorTown([town], 8), undefined);
  assert.equal(pickVisitorTown([{ ...town, visitors: 7 }], 8)?.id, 'a');
});

test('交接：离开的居民快照经 JSON 往返后，在另一小镇恢复后院种子、背包与方块', () => {
  const makeWorld = () => new World(new VoxelGrid({ sizeX: 70, sizeY: 42, sizeZ: 4 }), () => 0, () => 0.5);
  const from = makeWorld();
  from.spawnOnPlot('agent-x', 'X');
  from.leave('agent-x', 'backyard');
  from.enter('agent-x', 'backyard');
  from.leave('agent-x', 'backyard');
  // 拆掉底层石头得到石材 2，再把这块放回去（扣回 2）。
  from.pickupInYard('agent-x', { x: 3, y: 3, z: 0 });
  from.placeInYard('agent-x', { x: 3, y: 3, z: 0 }, 'stone');
  const snap = from.exportHandoff('agent-x') as HandoffSnapshot;
  const wire = JSON.parse(JSON.stringify(snap)) as HandoffSnapshot;

  const to = makeWorld();
  to.importHandoff(wire);
  const back = to.exportHandoff('agent-x');
  assert.deepEqual(back, snap);
});

test('handoff: leaving removes buildings, and replaying history restores both sides', () => {
  const makeWorld = () => new World(new VoxelGrid({ sizeX: 70, sizeY: 42, sizeZ: 4 }), () => 0, () => 0.5);
  const from = makeWorld();
  from.spawnOnPlot('agent-r', 'R');
  from.pickupInYard('agent-r', { x: 3, y: 3, z: 0 });
  from.placeInYard('agent-r', { x: 3, y: 3, z: 0 }, 'stone');
  from.leave('agent-r', 'backyard');
  const snap = from.exportHandoff('agent-r') as HandoffSnapshot;
  assert.equal(snap.buildCells.length, 0);

  const to = makeWorld();
  const wire = JSON.parse(JSON.stringify(snap)) as HandoffSnapshot;
  to.importHandoff(wire);
  const before = JSON.stringify(to.exportHandoff('agent-r'));
  const replayed = makeWorld();
  replayed.restore(to.eventsSince(-1));
  assert.equal(JSON.stringify(replayed.exportHandoff('agent-r')), before);
});
test('交接：自留地跟随居民；原地块被占时分配空闲地块，重放结果一致', () => {
  const makeWorld = () => new World(new VoxelGrid({ sizeX: 70, sizeY: 42, sizeZ: 4 }), () => 0, () => 0.5);
  const from = makeWorld();
  from.spawnOnPlot('agent-p', 'P');
  from.leave('agent-p', 'backyard');
  const snap = from.exportHandoff('agent-p') as HandoffSnapshot;
  assert.equal(snap.plotId, 'nw');

  // 目标镇的 nw 已被别人占用：应分到另一块空地（n）。
  const to = makeWorld();
  to.spawnOnPlot('agent-other', 'O');
  to.importHandoff(JSON.parse(JSON.stringify(snap)) as HandoffSnapshot);
  assert.equal(to.exportHandoff('agent-p')?.plotId, 'n');

  const replayed = makeWorld();
  replayed.restore(to.eventsSince(-1));
  assert.equal(replayed.exportHandoff('agent-p')?.plotId, 'n');
});
test('handoff: buildings imported into a town are removed on leave and restored by replay', () => {
  const makeWorld = () => new World(new VoxelGrid({ sizeX: 70, sizeY: 42, sizeZ: 4 }), () => 0, () => 0.5);
  const source: HandoffSnapshot = { id: 'agent-b', name: 'B', seed: 1, bag: {}, yardCells: [], buildCells: ['20,20,0'] };
  const town = makeWorld();
  town.importHandoff(source);
  town.spawnOnPlot('agent-b', 'B');
  town.leave('agent-b', 'backyard');
  const snap = town.exportHandoff('agent-b') as HandoffSnapshot;
  assert.deepEqual(snap.buildCells, ['20,20,0']);

  const replayed = makeWorld();
  replayed.restore(town.eventsSince(-1));
  assert.deepEqual(replayed.exportHandoff('agent-b'), snap);
});
test('杞崲锛歱ickTown 浼樺厛閬垮紑涓婃鎵€鍦ㄥ皬闀囷紝鍙湁鍘熼晣鏈夌┖浣嶆椂鐣欏湪鍘熼晣', () => {
  const towns = [
    { id: 'a', port: 3001, agents: 3, visitors: 0 },
    { id: 'b', port: 3002, agents: 3, visitors: 0 },
  ];
  assert.equal(pickTown(towns, 8, 3001)?.id, 'b');
  const onlyOld = [
    { id: 'a', port: 3001, agents: 3, visitors: 0 },
    { id: 'b', port: 3002, agents: 8, visitors: 0 },
  ];
  assert.equal(pickTown(onlyOld, 8, 3001)?.id, 'a');
});

test('agent scheduling: same-year reconnect returns to origin town while it has room', () => {
  const towns = [
    { id: 'a', port: 3001, agents: 7, visitors: 0 },
    { id: 'b', port: 3002, agents: 0, visitors: 0 },
  ];
  // 原镇 a 未满（7 < 8），即使 b 更空也回 a。
  assert.equal(pickAgentTown(towns, 3001, false)?.id, 'a');
  // 原镇满员：回落到别的镇。
  const full = [{ ...towns[0], agents: 8 }, towns[1]];
  assert.equal(pickAgentTown(full, 3001, false)?.id, 'b');
  // 没有原镇记录：选第一个未满的镇。
  assert.equal(pickAgentTown(towns, undefined, false)?.id, 'a');
});

test('agent scheduling: year rotation forces a different town when one exists', () => {
  const towns = [
    { id: 'a', port: 3001, agents: 3, visitors: 0 },
    { id: 'b', port: 3002, agents: 3, visitors: 0 },
  ];
  assert.equal(pickAgentTown(towns, 3001, true)?.id, 'b');
  // 只有原镇有空位：返回 undefined，调用方应新开小镇。
  const onlyOrigin = [{ ...towns[0] }, { ...towns[1], agents: 8 }];
  assert.equal(pickAgentTown(onlyOrigin, 3001, true), undefined);
});

test('娓告垙骞达細yearIndexAt 鍦ㄥ勾杈圭晫鍙樺寲', () => {
  const yearMs = DAY_MS * SEASON_DAYS * 4;
  assert.equal(yearIndexAt(yearMs - 1), 0);
  assert.equal(yearIndexAt(yearMs), 1);
});