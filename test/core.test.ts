import { login, sessionFor, heartbeat, expireSessions } from '../src/adapters/session.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VoxelGrid } from '../src/core/voxel.ts';
import { World, PAIR_TALK_LIMIT, PAIR_TALK_WINDOW_MS, SPEAK_COOLDOWN_MS } from '../src/core/world.ts';
import { computeClarity, degradeText, distanceClarity } from '../src/core/hearing.ts';
import { applyIntent } from '../src/adapters/adapter.ts';
import { labelRooms, SOLID_ROOM } from '../src/core/rooms.ts';
import { Backyard } from '../src/core/backyard.ts';
import { buildObservation, agentHistory } from '../src/adapters/observation.ts';
import { buildTown, PLOTS, PLOT_SIZE, TOWN_ENTRANCE, TOWN_SIZE } from '../src/scenes/town.ts';
import { countActors } from '../src/gateway/capacity.ts';
import { shopkeeperReply } from '../src/core/shopkeeper.ts';

// 测试用：直接给居民背包补石料，不改变其位置与占地（bagOf 为私有，只在测试中访问）。
function stockStone(world: World, id: string, amount = 3): void {
  (world as unknown as { bagOf(id: string): { add(item: string, n: number): void } }).bagOf(id).add('stone', amount);
}

// 测试用的两间房：x=16 的隔墙贯通整个高度，中间开门洞 y=7..8、z=0..1。
// A 在左屋 (2,8,0)，B 在右屋 (26,8,0)。
function buildHall(clock: () => number): World {
  const grid = new VoxelGrid({ sizeX: 32, sizeY: 16, sizeZ: 4 });
  for (let y = 0; y < 16; y++) for (let z = 0; z < 4; z++) grid.setSolid({ x: 16, y, z });
  for (let y = 7; y <= 8; y++) for (let z = 0; z < 2; z++) grid.clearSolid({ x: 16, y, z });
  const world = new World(grid, clock);
  world.spawn('agent-a', 'A', { x: 2, y: 8, z: 0 });
  world.spawn('agent-b', 'B', { x: 26, y: 8, z: 0 });
  return world;
}

// 测试用：直接给居民背包补图纸或材料（图纸与家具的获得途径未在本测试范围内）。
function stockBag(world: World, id: string, item: string, amount = 1): void {
  (world as unknown as { bagOf(id: string): { add(item: string, n: number): void } }).bagOf(id).add(item, amount);
}

test('学习图纸消耗图纸，需要图纸的家具只有学会后才能制作', () => {
  const world = buildHall(() => 0);
  assert.equal(applyIntent(world, { kind: 'craft', actorId: 'agent-a', furniture: 'table' }).reason_code, 'blueprint_required');
  assert.equal(applyIntent(world, { kind: 'learn_blueprint', actorId: 'agent-a', furniture: 'table' }).reason_code, 'no_blueprint');
  stockBag(world, 'agent-a', 'blueprint:table');
  stockBag(world, 'agent-a', 'wood', 4);
  assert.equal(applyIntent(world, { kind: 'learn_blueprint', actorId: 'agent-a', furniture: 'table' }).accepted, true);
  assert.equal(applyIntent(world, { kind: 'learn_blueprint', actorId: 'agent-a', furniture: 'table' }).reason_code, 'no_blueprint');
  const crafted = applyIntent(world, { kind: 'craft', actorId: 'agent-a', furniture: 'table' });
  assert.equal(crafted.accepted, true);
  const bag = crafted.state_delta.bag as Record<string, number>;
  assert.equal(bag['furniture:table'], 1);
  assert.equal(bag.wood, 0);
});

test('基础家具无需图纸即可制作，材料不足则拒绝', () => {
  const world = buildHall(() => 0);
  assert.equal(applyIntent(world, { kind: 'craft', actorId: 'agent-a', furniture: 'stone_wall' }).reason_code, 'insufficient_material');
  stockBag(world, 'agent-a', 'stone', 3);
  assert.equal(applyIntent(world, { kind: 'craft', actorId: 'agent-a', furniture: 'stone_wall' }).accepted, true);
});

test('赠送须双方相隔不超过 4 格，且转移物品归属', () => {
  const world = buildHall(() => 0);
  stockBag(world, 'agent-a', 'furniture:chair');
  // B 在右屋 (26,8)，与 A 的距离远超 4 格。
  assert.equal(applyIntent(world, { kind: 'give', actorId: 'agent-a', to: 'agent-b', item: 'furniture:chair' }).reason_code, 'out_of_gift_range');
  // 另生成一个居民 C 在 A 旁边（距离 2 格）。
  world.spawn('agent-c', 'C', { x: 4, y: 8, z: 0 });
  assert.equal(applyIntent(world, { kind: 'give', actorId: 'agent-a', to: 'agent-c', item: 'furniture:chair' }).accepted, true);
  assert.equal(applyIntent(world, { kind: 'give', actorId: 'agent-a', to: 'agent-c', item: 'furniture:chair' }).reason_code, 'no_item');
});

test('图纸与成品家具的学习、制作、赠送重启后可重放一致', () => {
  const clock = () => 0;
  const world = buildHall(clock);
  stockBag(world, 'agent-a', 'blueprint:table');
  stockBag(world, 'agent-a', 'wood', 4);
  applyIntent(world, { kind: 'learn_blueprint', actorId: 'agent-a', furniture: 'table' });
  applyIntent(world, { kind: 'craft', actorId: 'agent-a', furniture: 'table' });
  const history = world.eventsSince(0);
  // 初始库存不是事件，重放前要在新世界里注入相同的初始库存。
  const replayed = buildHall(clock);
  stockBag(replayed, 'agent-a', 'blueprint:table');
  stockBag(replayed, 'agent-a', 'wood', 4);
  replayed.restore(history);
  assert.deepEqual(
    (replayed as unknown as { bagOf(id: string): { toJSON(): unknown } }).bagOf('agent-a').toJSON(),
    (world as unknown as { bagOf(id: string): { toJSON(): unknown } }).bagOf('agent-a').toJSON(),
  );
});

test('店主：柜台附近可免费领取可售图纸，远处或基础家具图纸被拒', () => {
  const world = buildHall(() => 0);
  world.spawn('npc-shopkeeper', '店主', { x: 3, y: 8, z: 0 });
  assert.equal(applyIntent(world, { kind: 'claim_blueprint', actorId: 'agent-b', furniture: 'table' }).reason_code, 'not_at_shop');
  assert.equal(applyIntent(world, { kind: 'claim_blueprint', actorId: 'agent-a', furniture: 'chair' }).reason_code, 'unknown_furniture');
  const claimed = applyIntent(world, { kind: 'claim_blueprint', actorId: 'agent-a', furniture: 'table' });
  assert.equal(claimed.accepted, true);
  assert.equal((claimed.state_delta.bag as Record<string, number>)['blueprint:table'], 1);
});

test('表情：3 格内的 agent 可见，3 格外不可见，10 秒后过期，非单个 emoji 被拒', () => {
  let now = 0;
  const world = buildHall(() => now);
  world.spawn('agent-c', 'C', { x: 4, y: 8, z: 0 });
  // A 在 (2,8,0)，C 距离 2 格；B 在 (26,8,0)，远在墙另一侧。
  assert.equal(applyIntent(world, { kind: 'emote', actorId: 'agent-a', emoji: '😊' }).accepted, true);
  assert.deepEqual(world.visibleEmotes('agent-c').map((e) => e.emoji), ['😊']);
  assert.deepEqual(world.visibleEmotes('agent-b'), []);
  assert.deepEqual(world.visibleEmotes('agent-a'), [], '自己的表情不返回给自己');
  now = 10_000;
  assert.deepEqual(world.visibleEmotes('agent-c'), [], '10 秒后过期');
  assert.equal(applyIntent(world, { kind: 'emote', actorId: 'agent-a', emoji: 'hello' }).accepted, false);
  assert.equal(applyIntent(world, { kind: 'emote', actorId: 'agent-a', emoji: '😀😀' }).accepted, false);
});

test('表情：实时结束后回落到常态；常态不过期，两者都可被改变', () => {
  let now = 0;
  const world = buildHall(() => now);
  world.spawn('agent-c', 'C', { x: 4, y: 8, z: 0 });
  applyIntent(world, { kind: 'emote', actorId: 'agent-a', emoji: '🌙', emoteKind: 'baseline' });
  applyIntent(world, { kind: 'emote', actorId: 'agent-a', emoji: '😊' });
  assert.deepEqual(world.visibleEmotes('agent-c').map((e) => [e.emoji, e.kind]), [['😊', 'live']]);
  now = 10_000;
  assert.deepEqual(world.visibleEmotes('agent-c').map((e) => [e.emoji, e.kind]), [['🌙', 'baseline']], '实时结束后露出常态');
  now = 1_000_000;
  assert.deepEqual(world.visibleEmotes('agent-c').map((e) => e.emoji), ['🌙'], '常态不过期');
  applyIntent(world, { kind: 'emote', actorId: 'agent-a', emoji: '🌧️', emoteKind: 'baseline' });
  assert.deepEqual(world.visibleEmotes('agent-c').map((e) => e.emoji), ['🌧️'], '常态可以被改变');
});

test('表情：登录时设定的常态表情立即可见且不过期；非单个 emoji 不能作为常态', () => {
  let now = 0;
  const world = buildHall(() => now);
  world.spawn('agent-c', 'C', { x: 4, y: 8, z: 0 });
  assert.equal(world.emote('agent-c', '🙂', 'baseline').accepted, true);
  assert.deepEqual(world.visibleEmotes('agent-a').map((e) => [e.emoji, e.kind]), [['🙂', 'baseline']]);
  now = 1_000_000;
  assert.deepEqual(world.visibleEmotes('agent-a').map((e) => e.emoji), ['🙂'], '常态不过期');
  assert.equal(world.emote('agent-c', '不是表情', 'baseline').accepted, false);
});

test('表情：随事件重放恢复，过期的不恢复', () => {
  let now = 0;
  const world = buildHall(() => now);
  world.spawn('agent-c', 'C', { x: 4, y: 8, z: 0 });
  applyIntent(world, { kind: 'emote', actorId: 'agent-c', emoji: '🌱' });
  now = 3_000;
  const history = world.eventsSince(0);
  const replayed = new World(new VoxelGrid({ sizeX: 32, sizeY: 16, sizeZ: 4 }), () => now);
  replayed.restore(history);
  assert.deepEqual(replayed.activeEmotes().map((e) => e.emoji), ['🌱'], '重放后仍在有效期内');
  now = 20_000;
  const late = new World(new VoxelGrid({ sizeX: 32, sizeY: 16, sizeZ: 4 }), () => now);
  late.restore(history);
  assert.deepEqual(late.activeEmotes(), [], '过期表情不应恢复');
});

test('心情：按半衰期衰减，非法数值被拒，心情与表情可以不一致', () => {
  let now = 0;
  const world = buildHall(() => now);
  assert.equal(world.currentMood('agent-a'), null, '从未提交过返回 null');
  assert.equal(applyIntent(world, { kind: 'mood', actorId: 'agent-a', valence: 0.8, arousal: -0.4 }).accepted, true);
  // 同时发一个表情：表情“开心”，心情却是低唤醒，二者不一致。
  applyIntent(world, { kind: 'emote', actorId: 'agent-a', emoji: '😊' });
  assert.deepEqual(world.currentMood('agent-a'), { valence: 0.8, arousal: -0.4 });
  now = 60_000; // 一个半衰期
  assert.deepEqual(world.currentMood('agent-a'), { valence: 0.4, arousal: -0.2 });
  assert.equal(applyIntent(world, { kind: 'mood', actorId: 'agent-a', valence: 1.5, arousal: 0 }).accepted, false);
  assert.equal(applyIntent(world, { kind: 'mood', actorId: 'agent-a', valence: 0, arousal: NaN }).accepted, false);
});

test('心情：随事件重放恢复，衰减与运行时一致', () => {
  let now = 0;
  const world = buildHall(() => now);
  applyIntent(world, { kind: 'mood', actorId: 'agent-a', valence: -0.6, arousal: 0.6 });
  now = 60_000;
  const history = world.eventsSince(0);
  const replayed = new World(new VoxelGrid({ sizeX: 32, sizeY: 16, sizeZ: 4 }), () => now);
  replayed.restore(history);
  assert.deepEqual(replayed.currentMood('agent-a'), { valence: -0.3, arousal: 0.3 });
  assert.deepEqual(replayed.activeMoods(), [{ actorId: 'agent-a', valence: -0.3, arousal: 0.3 }]);
});

test('店主：听到玩家说话时按脚本回复，且店主不计入访客或 agent 名额', () => {
  const world = buildHall(() => 0);
  world.spawn('npc-shopkeeper', '店主', { x: 3, y: 8, z: 0 });
  assert.deepEqual(countActors(['visitor-1', 'npc-shopkeeper', 'agent-a']), { agents: 1, visitors: 1 });
  applyIntent(world, { kind: 'speak', actorId: 'agent-a', mode: 'talk', text: '请问有图纸吗' });
  const reply = world.drainInbox('agent-a').find((h) => h.speakerId === 'npc-shopkeeper');
  assert.ok(reply, '店主应回复发言者');
  assert.equal(reply.text, shopkeeperReply('请问有图纸吗'));
});

test('事件缓冲超限时，未刷盘的事件不会被丢弃', () => {
  const grid = new VoxelGrid({ sizeX: 4, sizeY: 4, sizeZ: 2 });
  let now = 0;
  const world = new World(grid, () => now, () => 0.5);
  world.spawn('agent-a', 'A', { x: 0, y: 0, z: 0 });
  for (let i = 0; i < 600; i++) {
    now += 60000;
    world.speak('agent-a', 'shout', 'x');
  }
  const first = world.eventsSince(0)[0].seq;
  assert.equal(first, 1, '未刷盘时最早的事件仍应保留');
  world.markFlushed(world.currentSeq());
  assert.ok(world.eventsSince(0).length <= 500, '刷盘后应裁剪到上限');
  assert.equal(world.eventsSince(world.currentSeq() - 1).length, 1);
});

test('labelRooms: a full wall splits the space into two rooms', () => {
  const grid = new VoxelGrid({ sizeX: 5, sizeY: 3, sizeZ: 2 });
  for (let y = 0; y < 3; y++) for (let z = 0; z < 2; z++) grid.setSolid({ x: 2, y, z });
  const labels = labelRooms(grid);
  const left = labels[0];
  const right = labels[4];
  assert.notEqual(left, SOLID_ROOM);
  assert.notEqual(right, SOLID_ROOM);
  assert.notEqual(left, right);
});

test('labelRooms: a gap in the wall merges the two sides into one room', () => {
  const grid = new VoxelGrid({ sizeX: 5, sizeY: 3, sizeZ: 2 });
  for (let y = 0; y < 3; y++) for (let z = 0; z < 2; z++) {
    if (y === 1 && z === 1) continue; // 留一个缺口
    grid.setSolid({ x: 2, y, z });
  }
  const labels = labelRooms(grid);
  assert.equal(labels[0], labels[4]);
});

test('eventsSince 按序号返回增量，不会丢失已发生的事件', () => {
  const world = buildHall(() => 0);
  world.speak('agent-a', 'whisper', 'hi');
  const first = world.eventsSince(0);
  assert.ok(first.length > 0);
  const last = first[first.length - 1].seq;
  world.move('agent-a', { x: 3, y: 8, z: 0 });
  assert.equal(world.eventsSince(last)[0].seq, last + 1);
});

test('观察包：喊话的内容进入听众收件箱，取走一次后清空', () => {
  const world = new World(new VoxelGrid({ sizeX: 32, sizeY: 16, sizeZ: 4 }), () => 0);
  world.spawn('a', 'A', { x: 2, y: 8, z: 0 });
  world.spawn('b', 'B', { x: 10, y: 8, z: 0 });
  world.speak('a', 'shout', 'hello');
  const pkg = buildObservation(world, 'b', 1);
  assert.ok(pkg);
  assert.equal(pkg.heard.length, 1);
  assert.equal(pkg.heard[0].speakerId, 'a');
  assert.equal(pkg.heard[0].text, 'hello');
  assert.equal(pkg.nearby[0].id, 'a');
  assert.equal(buildObservation(world, 'b', 2)?.heard.length, 0);
});

test('对话增量：按序号只返回之后的新增，观察包不再携带全量 recent', () => {
  let now = 0;
  const world = new World(new VoxelGrid({ sizeX: 32, sizeY: 16, sizeZ: 4 }), () => now);
  world.spawn('a', 'A', { x: 2, y: 8, z: 0 });
  world.spawn('b', 'B', { x: 10, y: 8, z: 0 });
  world.speak('a', 'shout', '你好');
  now += 3000;
  world.speak('b', 'shout', '你好呀');
  const first = world.recentUtterances('b', 0);
  assert.deepEqual(
    first.map((u) => [u.kind, u.speakerId, u.text]),
    [
      ['heard', 'a', '你好'],
      ['said', 'b', '你好呀'],
    ],
  );
  const cursor = first[first.length - 1].seq;
  // 没有新内容时增量为空，游标不变。
  assert.equal(world.recentUtterances('b', cursor).length, 0);
  now += 3000;
  world.speak('a', 'shout', '又来了');
  const delta = world.recentUtterances('b', cursor);
  assert.deepEqual(delta.map((u) => u.text), ['又来了']);
  // 观察包只携带 heard，不再有 recent。
  const obs = buildObservation(world, 'b', 1);
  assert.ok(obs);
  assert.equal('recent' in obs, false);
});

test('寒暄循环：同一对居民在窗口内互相回应超过上限后不再投递，窗口过后恢复', () => {
  let now = 0;
  const world = new World(new VoxelGrid({ sizeX: 32, sizeY: 16, sizeZ: 4 }), () => now);
  world.spawn('a', 'A', { x: 2, y: 8, z: 0 });
  world.spawn('b', 'B', { x: 10, y: 8, z: 0 });
  // 交替说话，直到达到上限（每条 speak 都会向对方计一次）。
  for (let i = 0; i < PAIR_TALK_LIMIT; i++) {
    now += SPEAK_COOLDOWN_MS;
    world.speak(i % 2 === 0 ? 'a' : 'b', 'shout', `第${i}句`);
  }
  now += SPEAK_COOLDOWN_MS;
  const blocked = world.speak('a', 'shout', '还在吗');
  assert.equal(blocked.heard.length, 0);
  now += PAIR_TALK_WINDOW_MS;
  const later = world.speak('a', 'shout', '过了一会儿');
  assert.equal(later.heard.length, 1);
});

test('后院观测：离开小镇后不再收到小镇内容，离开前未取走的听闻也不会带出', () => {
  const world = new World(new VoxelGrid({ sizeX: 32, sizeY: 16, sizeZ: 4 }), () => 0);
  world.spawn('a', 'A', { x: 2, y: 8, z: 0 });
  world.spawn('b', 'B', { x: 10, y: 8, z: 0 });
  world.speak('a', 'shout', '离开前的话');
  world.leave('b', 'backyard');
  // 后院中没有小镇观察包，服务端不会推送。
  assert.equal(buildObservation(world, 'b', 1), null);
  // 回城后，离开前收到的旧听闻已清空，不会被当作新内容。
  world.enter('b', 'backyard');
  const back = buildObservation(world, 'b', 2);
  assert.ok(back);
  assert.equal(back.heard.length, 0);
});

test('后院历史：居民在后院时不返回小镇历史，回城后恢复', () => {
  const world = new World(new VoxelGrid({ sizeX: 32, sizeY: 16, sizeZ: 4 }), () => 0);
  world.spawn('a', 'A', { x: 2, y: 8, z: 0 });
  world.spawn('b', 'B', { x: 10, y: 8, z: 0 });
  world.speak('b', 'talk', '小镇里的话');
  const inTown = agentHistory(world.eventsSince(0), 'b', 100, true);
  assert.ok(inTown.some((e) => e.type === 'speak' && e.actorId === 'b'));
  world.leave('b', 'backyard');
  assert.equal(agentHistory(world.eventsSince(0), 'b', 100, false).length, 0);
  world.enter('b', 'backyard');
  assert.ok(agentHistory(world.eventsSince(0), 'b', 100, true).some((e) => e.type === 'speak' && e.actorId === 'b'));
});

test('断线居民的自留地暂留 24 游戏小时：期间保留，到期释放并记录事件，期间回城则取消', () => {
  let now = 0;
  const world = new World(new VoxelGrid({ sizeX: 32, sizeY: 16, sizeZ: 4 }), () => now);
  world.spawnOnPlot('a', 'A');
  const holder = () => world.snapshot().plots.find((p) => p.holder === 'a');
  assert.ok(holder());
  world.leave('a', 'backyard');
  // 断线后仍占着自留地，不会被别人拿走。
  assert.ok(holder());
  now = 23 * 60 * 60 * 1000;
  assert.deepEqual(world.releaseExpiredPlots(), []);
  assert.ok(holder());
  now = 24 * 60 * 60 * 1000;
  assert.equal(world.releaseExpiredPlots().length, 1);
  assert.equal(holder(), undefined);
  // 重新出生时可以拿到自留地。
  world.spawnOnPlot('a', 'A');
  assert.ok(holder());
  // 暂留期间回城，计时取消，不会被释放。
  world.leave('a', 'backyard');
  now += 10 * 60 * 60 * 1000;
  world.enter('a', 'backyard');
  now += 30 * 60 * 60 * 1000;
  assert.deepEqual(world.releaseExpiredPlots(), []);
  assert.ok(holder());
});

test('后院：同一种子在任何坐标得到相同地形，不同种子结果不同', () => {
  const a = new Backyard(12345);
  const b = new Backyard(12345);
  const c = new Backyard(99999);
  let differs = false;
  for (let x = -40; x <= 40; x++) {
    for (let y = -40; y <= 40; y++) {
      assert.equal(a.heightAt(x, y), b.heightAt(x, y));
      if (a.heightAt(x, y) !== c.heightAt(x, y)) differs = true;
    }
  }
  assert.ok(differs);
});

test('后院：玩家改动覆盖地形，地形之上的空格可以被填实', () => {
  const yard = new Backyard(7);
  const high = { x: 0, y: 0, z: 100 };
  assert.equal(yard.isSolid(high), false);
  yard.setSolid(high, 'wood');
  assert.equal(yard.isSolid(high), true);
  yard.clearSolid({ x: 0, y: 0, z: 0 });
  assert.equal(yard.isSolid({ x: 0, y: 0, z: 0 }), false);
});

test('后院：地表以下分层为草地、泥土、岩石，地表以上为空气', () => {
  const yard = new Backyard(7);
  const top = yard.heightAt(0, 0);
  assert.equal(yard.terrainAt({ x: 0, y: 0, z: top }), 'air');
  assert.equal(yard.terrainAt({ x: 0, y: 0, z: top - 1 }), 'grass');
  assert.equal(yard.terrainAt({ x: 0, y: 0, z: top - 2 }), 'dirt');
  assert.equal(yard.terrainAt({ x: 0, y: 0, z: 0 }), 'stone');
});

test('后院：挖掘地下格子后该格变空，放置须指定材质', () => {
  const yard = new Backyard(7);
  const top = yard.heightAt(0, 0);
  const underground = { x: 0, y: 0, z: top - 2 };
  yard.clearSolid(underground);
  assert.equal(yard.materialAt(underground), 'air');
  const sky = { x: 0, y: 0, z: top + 2 };
  yard.setSolid(sky, 'fiber');
  assert.equal(yard.materialAt(sky), 'fiber');
  assert.throws(() => yard.setSolid(sky, 'air'));
});

test('resumeSeq：重启后序号接续历史日志末尾，不与旧事件重复', () => {
  const world = buildHall(() => 0);
  world.resumeSeq(41);
  world.move('agent-a', { x: 3, y: 8, z: 0 });
  const events = world.eventsSince(41);
  assert.equal(events[events.length - 1].seq, 42);
});

test('远距离喊话：20 格外 B 能听到但清晰度很低，文本残缺', () => {
  let now = 0;
  const world = buildHall(() => now);
  // 把 A 放在开阔一侧，B 放在 20 格外（墙在中间会增加遮挡，这里用无墙的空间）
  const grid = new VoxelGrid({ sizeX: 40, sizeY: 4, sizeZ: 4 });
  const w2 = new World(grid, () => now);
  w2.spawn('a', 'A', { x: 0, y: 0, z: 0 });
  w2.spawn('b', 'B', { x: 20, y: 0, z: 0 });
  const r = w2.speak('a', 'shout', '咖啡还热着，有人要吗');
  assert.equal(r.accepted, true);
  assert.equal(r.heard.length, 1);
  assert.ok(r.heard[0].clarity < 0.8, '20 格外的清晰度应低于完整阈值');
  assert.ok(r.heard[0].text !== '咖啡还热着，有人要吗', '文本应残缺');
  assert.ok(world.getActor('agent-a'));
});

test('近距离低语：2 格内完整文本', () => {
  const grid = new VoxelGrid({ sizeX: 10, sizeY: 4, sizeZ: 4 });
  const w = new World(grid, () => 0);
  w.spawn('a', 'A', { x: 0, y: 0, z: 0 });
  w.spawn('b', 'B', { x: 2, y: 0, z: 0 });
  const r = w.speak('a', 'whisper', '别告诉别人');
  assert.equal(r.heard.length, 1);
  assert.equal(r.heard[0].clarity, 1);
  assert.equal(r.heard[0].text, '别告诉别人');
});

test('墙体遮挡使清晰度减半并可能截断听觉', () => {
  const clear = distanceClarity(4, 'talk');
  const wallOne = computeClarity(4, 1, 'talk');
  assert.equal(wallOne, clear * 0.5);
  // 三面墙后，即使在说话距离内也会低于听见阈值
  const r = computeClarity(4, 6, 'talk');
  assert.ok(r < 0.05);
});

test('same room: walls inside the room are not counted, distance still decays', () => {
  const grid = new VoxelGrid({ sizeX: 10, sizeY: 4, sizeZ: 4 });
  // 中间一根柱子立在同一房间里，不把空间隔开
  grid.setSolid({ x: 3, y: 0, z: 0 }, true);
  const w = new World(grid, () => 0);
  w.spawn('a', 'A', { x: 0, y: 0, z: 0 });
  w.spawn('b', 'B', { x: 2, y: 0, z: 0 });
  const r = w.speak('a', 'talk', '同屋说话');
  assert.equal(r.heard.length, 1);
  assert.equal(r.heard[0].walls, 0);
  assert.equal(r.heard[0].clarity, 1);
});

test('different rooms: each wall between them halves the clarity', () => {
  // 自建一面无门洞的隔墙 x=16，确保两侧确实分属不同房间
  const grid = new VoxelGrid({ sizeX: 32, sizeY: 16, sizeZ: 4 });
  for (let y = 0; y < 16; y++) for (let z = 0; z < 4; z++) grid.setSolid({ x: 16, y, z });
  const w = new World(grid, () => 0);
  w.spawn('a', 'A', { x: 14, y: 2, z: 0 });
  w.spawn('b', 'B', { x: 18, y: 2, z: 0 });
  const r = w.speak('a', 'shout', '隔壁');
  assert.equal(r.heard.length, 1);
  assert.equal(r.heard[0].walls, 1);
  assert.equal(r.heard[0].clarity, Math.round(distanceClarity(4, 'shout') * 0.5 * 1000) / 1000);
});

// 建造只能在自己占用的自留地里进行；测试用 nw 自留地 (0..9, 0..9) 做场地。
// 居民先 move 进入自留地完成占用，之后才能建造。
test('place: 只能放在触及范围内的空格，放后可以拿回自己的方块', () => {
  // 用真实小镇的 nw 自留地 (0..9, 0..9)，居民出生在中心 (5,5)。
  const w = buildTown(() => 0);
  const grid = w.grid;
  w.spawnOnPlot('a', 'A');
  assert.equal(w.place('a', { x: 8, y: 5, z: 0 }, 'stone').reason_code, 'out_of_reach', '距离超过触及范围');
  assert.equal(w.place('a', { x: 6, y: 6, z: 0 }, 'stone').reason_code, 'out_of_reach', '斜角不可达');
  assert.equal(w.place('a', { x: 6, y: 5, z: 0 }).reason_code, 'material_required', '小镇放置必须指定材质');
  assert.equal(w.place('a', { x: 6, y: 5, z: 0 }, 'stone').reason_code, 'insufficient_material', '背包为空无法扣料');
  stockStone(w, 'a');
  assert.equal(w.place('a', { x: 6, y: 5, z: 0 }, 'stone').accepted, true);
  assert.equal(w.place('a', { x: 6, y: 5, z: 0 }, 'stone').reason_code, 'occupied');
  assert.equal(w.place('a', { x: 6, y: 5, z: 0 }).reason_code, 'occupied');
  assert.equal(w.pickup('a', { x: 6, y: 5, z: 0 }).accepted, true);
  assert.equal(grid.isSolid({ x: 6, y: 5, z: 0 }), false);
});

test('place: 小镇内禁止建造，别人的自留地也不能建', () => {
  const w = buildTown(() => 0);
  w.spawnOnPlot('a', 'A'); // nw 中心 (5,5)
  w.spawn('b', 'B', { x: 10, y: 5, z: 0 }); // nw 右侧的空地，紧邻 a 的自留地
  const a = w.getActor('a')!.position;
  assert.equal(w.move('a', { x: a.x + 1, y: a.y, z: 0 }).accepted, true, 'a 在自己的自留地里可以移动');
  assert.equal(w.move('b', { x: 9, y: 5, z: 0 }).accepted, true, 'b 可以走进 a 的自留地');
  assert.equal(w.place('b', { x: 8, y: 5, z: 0 }, 'stone').reason_code, 'not_your_plot', 'b 不能在 a 的自留地里建造');
  // 小镇中心（广场）禁止建造
  w.spawn('c', 'C', TOWN_ENTRANCE);
  assert.equal(w.place('c', { x: TOWN_ENTRANCE.x + 1, y: TOWN_ENTRANCE.y, z: 0 }).reason_code, 'town_locked');
  assert.equal(w.pickup('c', { x: TOWN_ENTRANCE.x + 1, y: TOWN_ENTRANCE.y, z: 0 }).reason_code, 'town_locked');
});

test('move: 访客和第三方 agent 都可以走进别人的自留地参观，归属不变，且不能建造', () => {
  const w = buildTown(() => 0);
  w.spawnOnPlot('a', 'A'); // nw 中心 (5,5)
  w.spawn('visitor-9', '访客', { x: 10, y: 5, z: 0 });
  w.spawn('b', 'B', { x: 10, y: 6, z: 0 });
  assert.equal(w.move('visitor-9', { x: 9, y: 5, z: 0 }).accepted, true, '访客可以进入别人的自留地');
  assert.equal(w.move('b', { x: 9, y: 6, z: 0 }).accepted, true, 'agent 也可以进入别人的自留地');
  assert.equal(w.place('visitor-9', { x: 8, y: 5, z: 0 }, 'stone').reason_code, 'not_your_plot', '访客不能在别人的地里建造');
  assert.equal(w.place('b', { x: 8, y: 6, z: 0 }, 'stone').reason_code, 'not_your_plot', 'agent 也不能在别人的地里建造');
  assert.equal(w.snapshot().plots.find((p) => p.id === 'nw')?.holder, 'a', '参观不改变归属');
});

test('spawn: 居民上线出生在空闲自留地正中心，重放后归属保持，访客不占地', () => {
  const w = buildTown(() => 0);
  const a = w.spawnOnPlot('a', 'A');
  assert.equal(a.accepted, true);
  assert.deepEqual(w.getActor('a')?.position, { x: 5, y: 5, z: 0 }, 'nw 的中心 (0+5, 0+5)');
  w.spawnOnPlot('b', 'B');
  assert.deepEqual(w.getActor('b')?.position, { x: 29, y: 5, z: 0 }, '第二块是 n 的中心 (24+5, 0+5)');
  w.spawn('visitor-1', '访客', TOWN_ENTRANCE);
  assert.deepEqual(w.getActor('visitor-1')?.position, TOWN_ENTRANCE, '访客保持原出生点');
  // 重放后自留地归属仍然有效：新居民不会抢到 a 的地
  const restored = buildTown(() => 0);
  restored.restore(w.eventsSince(0));
  restored.spawnOnPlot('c', 'C');
  assert.deepEqual(restored.getActor('c')?.position, { x: 65, y: 5, z: 0 }, '前两块已占，第三块是 ne 的中心 (60+5, 0+5)');
});

test('pickup: 不能拿走场景原有的墙或别人放的方块', () => {
  const grid = new VoxelGrid({ sizeX: 10, sizeY: 4, sizeZ: 4 });
  grid.setSolid({ x: 3, y: 0, z: 0 });
  const w = new World(grid, () => 0);
  w.spawn('a', 'A', { x: 2, y: 0, z: 0 });
  assert.equal(w.pickup('a', { x: 3, y: 0, z: 0 }).reason_code, 'not_owner');
});

test('place: 在自留地里建造，留有缺口时两边仍是同一房间', () => {
  // 3×3 的平面。A 在 (0,0)，B 在 (2,2)，居民 C 在中间列 x=1 的墙旁边建墙。
  // 墙设在 x=1 的 y=0、y=1、y=2 三格，逐格放置，每一步 C 都站在相邻格上。
  // 场地放在 nw 自留地 (0..9, 0..9) 内，坐标整体平移到 (2..4, 2..4)，居民 C 先占用自留地。
  const grid = new VoxelGrid({ sizeX: 12, sizeY: 12, sizeZ: 1 });
  const w = new World(grid, () => 0);
  w.spawn('a', 'A', { x: 2, y: 2, z: 0 });
  w.spawn('b', 'B', { x: 4, y: 2, z: 0 });
  w.spawn('c', 'C', { x: 2, y: 5, z: 0 });
  stockStone(w, 'c', 6);
  assert.equal(w.move('c', { x: 2, y: 4, z: 0 }).accepted, true, 'C 占用 nw');
  assert.equal(w.place('c', { x: 3, y: 4, z: 0 }, 'stone').accepted, true);
  assert.equal(w.place('c', { x: 3, y: 3, z: 0 }).accepted, false, '(3,3) 与 C 只隔斜角，不可达');
  assert.equal(w.move('c', { x: 2, y: 3, z: 0 }).accepted, true);
  assert.equal(w.place('c', { x: 3, y: 3, z: 0 }, 'stone').accepted, true);
  assert.equal(w.move('c', { x: 2, y: 2, z: 0 }).accepted, false, '(2,2) 已被 A 占用');
  assert.equal(w.speak('a', 'talk', '隔壁').heard[0].walls, 0, '缺口未堵，应仍是同一房间');
});

test('超出模式最大距离时完全听不见', () => {
  assert.equal(distanceClarity(7, 'talk'), 0);
  assert.equal(distanceClarity(25, 'shout'), 0);
});

test('残缺文本按随机源逐字决定：全保留时原文，全遮时全是省略号', () => {
  const text = '今晚在屋顶见面吗';
  assert.equal(degradeText(text, 0.3, () => 0), text);
  assert.equal(degradeText(text, 0.3, () => 0.999), '…'.repeat(text.length));
  assert.equal(degradeText(text, 1, () => 0.999), text);
});

test('回执：越界、穿墙、超步长、冷却都被拒绝并给出原因码', () => {
  let now = 0;
  const world = buildHall(() => now);
  assert.equal(world.move('agent-a', { x: 99, y: 0, z: 0 }).reason_code, 'out_of_bounds');
  assert.equal(world.move('agent-a', { x: 16, y: 0, z: 0 }).reason_code, 'blocked_by_solid');
  assert.equal(world.move('agent-a', { x: 2 + 8, y: 8, z: 0 }).reason_code, 'too_far');
  assert.equal(world.move('agent-a', { x: 5, y: 8, z: 0 }).accepted, true);
  assert.equal(world.move('agent-a', { x: 9, y: 8, z: 0 }).reason_code, 'too_far');
  assert.equal(world.move('nobody', { x: 0, y: 0, z: 0 }).reason_code, 'unknown_actor');

  now = 0;
  assert.equal(world.speak('agent-a', 'talk', 'hi').accepted, true);
  const cool = world.speak('agent-a', 'talk', 'again');
  assert.equal(cool.reason_code, 'cooldown');
  assert.ok(cool.cooldown_ms > 0);
});

test('墙体阻挡路径：不能穿墙移动', () => {
  const grid = new VoxelGrid({ sizeX: 32, sizeY: 4, sizeZ: 4 });
  grid.setSolid({ x: 16, y: 0, z: 0 });
  const world = new World(grid, () => 0);
  world.spawn('a', 'A', { x: 15, y: 0, z: 0 });
  // 目标在墙右侧，距离 2 不超步长，但路径经过墙格 x=16
  assert.equal(world.move('a', { x: 17, y: 0, z: 0 }).reason_code, 'blocked_path');
});

test('小镇：两位居民入住后在广场上，广场与街道相通', () => {
  const world = buildTown(() => 0);
  world.spawn('agent-a', 'A', { x: 20, y: 9, z: 0 });
  world.spawn('agent-b', 'B', { x: 27, y: 9, z: 0 });
  assert.equal(world.move('agent-a', { x: 23, y: 9, z: 0 }).accepted, true);
  assert.equal(world.move('agent-a', { x: 23, y: 10, z: 0 }).accepted, true);
  assert.ok(TOWN_SIZE.sizeX > 0);
});

test('小镇：分组不超过 8 人，满了就另开一组', () => {
  const grid = new VoxelGrid({ sizeX: 40, sizeY: 4, sizeZ: 2 });
  // 随机源恒为 0：每次都尝试加入已有分组，所以只能靠上限 8 来拆分
  const world = new World(grid, () => 0, () => 0);
  for (let i = 0; i < 10; i++) world.spawn(`r${i}`, `R${i}`, { x: i, y: 0, z: 0 });
  const counts = new Map<string, number>();
  for (const a of world.snapshot().actors) counts.set(a.group, (counts.get(a.group) ?? 0) + 1);
  assert.ok([...counts.values()].every((n) => n <= 8));
  assert.equal(counts.size, 2);
});

test('小镇：离开后不在地图上，返回时回到广场并获得新分组', () => {
  const world = buildTown(() => 0);
  world.spawn('agent-a', 'A', { x: 20, y: 9, z: 0 });
  assert.equal(world.leave('agent-a', 'backyard').accepted, true);
  assert.equal(world.getActor('agent-a'), undefined);
  assert.equal(world.move('agent-a', { x: 21, y: 9, z: 0 }).reason_code, 'unknown_actor');
  assert.equal(world.enter('agent-a', 'backyard').accepted, true);
  assert.deepEqual(world.getActor('agent-a')?.position, TOWN_ENTRANCE);
});

test('小镇：第三方 agent 返回小镇时分配自留地中心，重放后归属保留', () => {
  const world = buildTown(() => 0);
  world.spawnOnPlot('agent-a2', 'A2');
  world.leave('agent-a2', 'backyard');
  assert.equal(world.enter('agent-a2', 'backyard').accepted, true);
  assert.equal(world.claimPlot('agent-a2').accepted, true);
  const pos = world.getActor('agent-a2')?.position;
  assert.ok(pos && PLOTS.some((p) => pos.x >= p.x0 && pos.x < p.x0 + PLOT_SIZE && pos.y >= p.y0 && pos.y < p.y0 + PLOT_SIZE), '返回的居民应位于某块自留地内');
  const again = buildTown(() => 0);
  again.restore(world.eventsSince(0));
  assert.deepEqual(again.getActor('agent-a2')?.position, pos);
  assert.equal(again.snapshot().plots.find((p) => p.holder === 'agent-a2') !== undefined, true);
});

test('小镇：已占地的居民走出地外后再次认领，不会占第二块地', () => {
  const world = buildTown(() => 0);
  world.spawnOnPlot('agent-h', 'H');
  const first = world.snapshot().plots.find((p) => p.holder === 'agent-h');
  assert.ok(first);
  for (let x = 4; x >= 0; x--) world.move('agent-h', { x, y: 5, z: 0 });
  for (let x = 1; x <= 20; x += 3) world.move('agent-h', { x, y: 5, z: 0 });
  const p = world.getActor('agent-h')!.position;
  assert.equal(PLOTS.some((q) => p.x >= q.x0 && p.x < q.x0 + PLOT_SIZE && p.y >= q.y0 && p.y < q.y0 + PLOT_SIZE), false);
  assert.equal(world.claimPlot('agent-h').accepted, true);
  const holding = world.snapshot().plots.filter((p) => p.holder === 'agent-h');
  assert.equal(holding.length, 1);
  assert.equal(holding[0].id, first.id);
});

test('小镇：同一身份在小镇时再次出生被拒绝，且不占第二块地', () => {
  const world = buildTown(() => 0);
  assert.equal(world.spawnOnPlot('agent-d', 'D').accepted, true);
  assert.equal(world.spawnOnPlot('agent-d', 'D').reason_code, 'duplicate_id');
  assert.equal(world.snapshot().plots.filter((p) => p.holder === 'agent-d').length, 1);
});

test('小镇：断线居民重新上线时回到自己原来的地块，不占第二块地', () => {
  const world = buildTown(() => 0);
  world.spawnOnPlot('agent-r', 'R');
  const first = world.snapshot().plots.find((p) => p.holder === 'agent-r');
  assert.ok(first);
  world.leave('agent-r', 'backyard');
  world.spawnOnPlot('agent-r', 'R');
  const holding = world.snapshot().plots.filter((p) => p.holder === 'agent-r');
  assert.equal(holding.length, 1);
  assert.equal(holding[0].id, first.id);
});

test('小镇：交接导入的居民回城后不占第二块地', () => {
  const world = buildTown(() => 0);
  world.spawnOnPlot('agent-x', 'X');
  const first = world.snapshot().plots.find((p) => p.holder === 'agent-x');
  assert.ok(first);
  world.leave('agent-x', 'backyard');
  const snap = world.exportHandoff('agent-x');
  world.importHandoff(snap);
  world.spawnOnPlot('agent-x', 'X');
  assert.equal(world.snapshot().plots.filter((p) => p.holder === 'agent-x').length, 1);
});

test('小镇：入口被占时返回的居民就近落在空位，而不是被拒绝', () => {
  const world = buildTown(() => 0);
  world.spawn('agent-a', 'A', { x: 20, y: 9, z: 0 });
  world.spawn('agent-b', 'B', { x: 21, y: 9, z: 0 });
  world.leave('agent-a', 'backyard');
  world.spawn('agent-c', 'C', TOWN_ENTRANCE);
  const back = world.enter('agent-a', 'backyard');
  assert.equal(back.accepted, true);
  const pos = world.getActor('agent-a')?.position;
  assert.ok(pos);
  assert.notDeepEqual(pos, TOWN_ENTRANCE);
});

test('小镇：离开和返回都进入事件记录，重启后可从历史还原', () => {
  const world = buildTown(() => 0);
  world.spawn('agent-a', 'A', { x: 20, y: 9, z: 0 });
  world.leave('agent-a', 'backyard');
  world.enter('agent-a', 'backyard');
  const types = world.eventsSince(0).map((e) => e.type);
  assert.deepEqual(types, ['spawn', 'leave', 'enter']);

  const again = buildTown(() => 0);
  again.restore(world.eventsSince(0));
  assert.ok(again.getActor('agent-a'));
  assert.equal(again.getActor('agent-a')?.group, world.getActor('agent-a')?.group);
});

test('适配器意图通过同一套规则裁决', () => {
  const world = buildHall(() => 0);
  const r = applyIntent(world, { kind: 'move', actorId: 'agent-a', target: { x: 4, y: 8, z: 0 } });
  assert.equal(r.accepted, true);
  assert.deepEqual(world.getActor('agent-a')?.position, { x: 4, y: 8, z: 0 });
});


test('move: may climb onto your own block, not onto someone else\'s', () => {
  // 场地在 nw 自留地内。A 占用 nw 后在相邻格 (2,1,0) 放一块方块，再站到它的正上方 (2,1,1)。
  const grid = new VoxelGrid({ sizeX: 12, sizeY: 12, sizeZ: 4 });
  const world = new World(grid, () => 0);
  world.spawn('a', 'A', { x: 0, y: 1, z: 0 });
  world.spawn('b', 'B', { x: 3, y: 11, z: 0 });
  stockStone(world, 'a');
  assert.equal(world.move('a', { x: 1, y: 1, z: 0 }).accepted, true, 'A 占用 nw');
  assert.equal(world.move('b', { x: 3, y: 9, z: 0 }).accepted, true, 'B 可以走进 A 的自留地参观');
  assert.equal(world.place('a', { x: 2, y: 1, z: 0 }, 'stone').accepted, true);
  assert.equal(world.move('a', { x: 2, y: 1, z: 1 }).accepted, true, '应允许站到自己方块上');
  // 对方的方块上不能站：这里用场景墙模拟别人的方块（owners 无记录）。
  world.move('a', { x: 1, y: 1, z: 1 });
  grid.setSolid({ x: 2, y: 2, z: 0 }, true);
  assert.equal(world.move('a', { x: 2, y: 2, z: 1 }).reason_code, 'cannot_stand_on_other');
});

test('freeCellNear 跳过已有居民的格子，避免访客叠在一起', () => {
  const grid = new VoxelGrid({ sizeX: 10, sizeY: 10, sizeZ: 2 });
  const world = new World(grid, () => 0, () => 0.5, { x: 5, y: 5, z: 0 });
  world.spawn('a', 'A', { x: 5, y: 5, z: 0 });
  const spot = world.freeCellNear({ x: 5, y: 5, z: 0 });
  assert.ok(spot);
  assert.notDeepEqual(spot, { x: 5, y: 5, z: 0 });
  assert.equal(world.spawn('b', 'B', spot).accepted, true);
});

test('访客绑定 agent 只在访客登录时记录，且不影响 agent 登录', () => {
  const visitor = login('访客甲', 'visitor', 0, undefined, 'agent-hiero-1');
  assert.equal(visitor.ok && visitor.session.boundAgentId, 'agent-hiero-1');
  const agent = login('hiero', 'agent', 0, 'hiero-1', 'agent-hiero-1');
  assert.equal(agent.ok && agent.session.boundAgentId, undefined, 'agent 登录不应带绑定');
  const plain = login('访客乙', 'visitor', 0);
  assert.equal(plain.ok && plain.session.boundAgentId, undefined, '未绑定的访客不应有绑定');
  // 清理本测试登录的访客，避免影响其他依赖全局会话的测试。
  expireSessions(45000, 1_000_000);
});

test('访客超时未心跳会被清出：expireSessions 返回其 actorId 且 token 失效', () => {
  const token = login('小明', 'visitor', 0);
  assert.equal(token.ok, true);
  const s = token.session;
  assert.equal(heartbeat(s.token, 20000), true, '超时前心跳应有效');
  assert.deepEqual(expireSessions(45000, 40000), [], '心跳后 45 秒内不应超时');
  assert.deepEqual(expireSessions(45000, 100000), [s.actorId], '超时后应返回该访客');
  assert.equal(sessionFor(s.token), undefined, '超时后 token 应失效');
  assert.equal(heartbeat(s.token, 100001), false, '失效 token 的心跳应被拒绝');
});

test('同一访客账号重复登录：沿用同一 actorId，旧 token 失效，不产生第二个同名访客', () => {
  const first = login('复用测试甲', 'visitor', 0);
  assert.equal(first.ok, true);
  const second = login('复用测试甲', 'visitor', 0);
  assert.equal(second.ok, true);
  if (!first.ok || !second.ok) return;
  assert.equal(second.session.actorId, first.session.actorId, '同账号应复用 actorId');
  assert.equal(sessionFor(first.session.token), undefined, '旧 token 应失效');
  assert.equal(sessionFor(second.session.token)?.actorId, first.session.actorId);
  // 清理本测试登录的访客，避免影响其他依赖全局会话的测试。
  expireSessions(45000, 1_000_000);
});

test('第三方 agent 登录：actorId 以 agent- 开头，不参与访客超时', () => {
  const r = login('hiero', 'agent', 0);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.ok(r.session.actorId.startsWith('agent-'));
  assert.deepEqual(expireSessions(45000, 100000), [], 'agent 不心跳，也不应被超时清出');
  heartbeat(r.session.token, 100000);
  assert.deepEqual(expireSessions(45000, 200000), [], 'agent 即使心跳也不应被超时清出');
});

test('第三方 agent 带稳定 agentId 登录：同一 agentId 每次得到同一 actorId', () => {
  const first = login('hiero', 'agent', 0, 'hiero-1');
  const again = login('hiero', 'agent', 0, 'hiero-1');
  assert.equal(first.ok && again.ok, true);
  if (!first.ok || !again.ok) return;
  assert.equal(first.session.actorId, 'agent-hiero-1');
  assert.equal(again.session.actorId, 'agent-hiero-1');
  assert.notEqual(first.session.token, again.session.token);
});

test('后院：拆地形产出材料，放置扣料并记录材质，不足时拒绝', () => {
  const world = buildTown(() => 0);
  world.spawn('agent-a', 'A', { x: 20, y: 9, z: 0 });
  world.leave('agent-a', 'backyard');
  // 地下石头未拆前是实心，放置应被占用拒绝；不指定材质也拒绝
  assert.equal(world.placeInYard('agent-a', { x: 1, y: 1, z: 0 }, 'stone').reason_code, 'occupied');
  assert.equal(world.placeInYard('agent-a', { x: 1, y: 1, z: 0 }).reason_code, 'material_required');
  // 拆掉石头得石材 2，放回石块扣 2，背包归零；再放一块石头时材料不足
  assert.equal(world.pickupInYard('agent-a', { x: 1, y: 1, z: 0 }).accepted, true);
  assert.equal(world.placeInYard('agent-a', { x: 1, y: 1, z: 0 }, 'stone').accepted, true);
  assert.equal(world.snapshot().away[0].bag.stone ?? 0, 0);
  world.pickupInYard('agent-a', { x: 2, y: 2, z: 0 });
  world.pickupInYard('agent-a', { x: 1, y: 1, z: 0 });
  assert.equal(world.placeInYard('agent-a', { x: 2, y: 2, z: 0 }, 'wood').reason_code, 'insufficient_material');
});

test('后院：后院建造不改小镇网格', () => {
  const world = buildTown(() => 0);
  world.spawn('agent-a', 'A', { x: 20, y: 9, z: 0 });
  world.leave('agent-a', 'backyard');
  world.pickupInYard('agent-a', { x: 1, y: 1, z: 0 });
  const solidsBefore = world.snapshot().solids.length;
  world.placeInYard('agent-a', { x: 1, y: 1, z: 0 }, 'stone');
  assert.equal(world.snapshot().solids.length, solidsBefore);
});

test('后院：拆出的材料按种类入包，回城时随身带回，并进入事件与重放', () => {
  const world = buildTown(() => 0);
  world.spawn('agent-a', 'A', { x: 20, y: 9, z: 0 });
  world.leave('agent-a', 'backyard');
  world.pickupInYard('agent-a', { x: 1, y: 1, z: 0 });
  const back = world.enter('agent-a', 'backyard');
  assert.equal(back.state_delta.bag.stone, 2);
  assert.equal(back.state_delta.bag.wood, undefined);

  const again = buildTown(() => 0);
  again.restore(world.eventsSince(0));
  assert.equal(again.snapshot().away.length, 0);
});

test('后院：重放还原后院背包（离开时状态一致）', () => {
  const world = buildTown(() => 0);
  world.spawn('agent-a', 'A', { x: 20, y: 9, z: 0 });
  world.leave('agent-a', 'backyard');
  world.pickupInYard('agent-a', { x: 1, y: 1, z: 0 });
  world.placeInYard('agent-a', { x: 1, y: 1, z: 0 }, 'stone');
  world.pickupInYard('agent-a', { x: 2, y: 2, z: 0 });
  world.leave('agent-a', 'backyard');
  const again = buildTown(() => 0);
  again.restore(world.eventsSince(0));
  assert.deepEqual(again.snapshot().away[0].bag, world.snapshot().away[0].bag);
});

test('观察包带扁平日历字段，与 calendar 一致', () => {
  const world = buildTown(() => 0);
  world.spawn('b', 'B', { x: 10, y: 8, z: 0 });
  const pkg = buildObservation(world, 'b', 1);
  assert.ok(pkg);
  assert.equal(pkg.day_index, pkg.calendar.day);
  assert.equal(pkg.season, pkg.calendar.season);
  assert.equal(pkg.day_fraction, pkg.calendar.dayFraction);
  assert.equal(pkg.phase, pkg.calendar.phase);
});

test('day_start 事件可重放且不改变世界状态', () => {
  const world = buildTown(() => 0);
  world.spawn('b', 'B', { x: 10, y: 8, z: 0 });
  const seq = world.currentSeq();
  world.recordDayStart(3);
  assert.equal(world.eventsSince(seq)[0].type, 'day_start');
  assert.equal(world.eventsSince(seq)[0].data.day, 3);
  const before = JSON.stringify(world.snapshot());
  const again = buildTown(() => 0);
  again.restore(world.eventsSince(0));
  assert.equal(again.getActor('b')?.name, 'B');
  assert.equal(JSON.stringify(world.snapshot()), before, 'day_start 不应改变世界状态');
});

test('agentHistory 只返回与本人相关的原始事件，且受 limit 限制', () => {
  const world = buildTown(() => 0);
  world.spawn('a', 'A', { x: 10, y: 8, z: 0 });
  world.spawn('b', 'B', { x: 11, y: 8, z: 0 });
  world.spawn('c', 'C', { x: 60, y: 8, z: 0 });
  world.speak('a', 'shout', 'hi');
  world.recordDayStart(1);
  const mine = agentHistory(world.eventsSince(0), 'b', 100);
  assert.ok(mine.some((e) => e.type === 'speak' && e.actorId === 'a'), '听到的话应可见');
  assert.ok(mine.some((e) => e.type === 'day_start'), '世界级事件应可见');
  assert.ok(!mine.some((e) => e.type === 'spawn' && e.actorId === 'c'), '别人的动作不可见');
  assert.equal(agentHistory(world.eventsSince(0), 'b', 1).length, 1);
});

test('agentHistory 按来源标注 self / heard / world，不伪造 witnessed', () => {
  const world = buildTown(() => 0);
  world.spawn('a', 'A', { x: 10, y: 8, z: 0 });
  world.spawn('b', 'B', { x: 11, y: 8, z: 0 });
  world.speak('a', 'shout', 'hi');
  world.speak('b', 'shout', 'yo');
  world.recordDayStart(1);
  const sources = new Map(agentHistory(world.eventsSince(0), 'b', 100).map((e) => [`${e.actorId}:${e.type}`, e.source]));
  assert.equal(sources.get('b:speak'), 'self');
  assert.equal(sources.get('a:speak'), 'heard');
  assert.equal(sources.get('world:day_start'), 'world');
  assert.ok(![...sources.values()].includes('witnessed' as never));
});

test('承诺需对方确认后生效，只有对象方能上报履约，声誉按类计数', () => {
  const w = buildTown(() => 0);
  w.setIdentity('agent-a', { name: 'A', kind: 'agent' });
  w.setIdentity('agent-b', { name: 'B', kind: 'agent' });
  assert.equal(w.proposeCommitment('agent-a', 'agent-a', '自己').reason_code, 'self_commitment');
  const r = w.proposeCommitment('agent-a', 'agent-b', '明天交付木料');
  assert.equal(r.accepted, true);
  const id = Number(r.state_delta.commitment_id);
  // 未确认：不计入声誉，承诺方也不能自己确认或上报
  assert.equal(w.reputationOf('agent-b').commitments, 0);
  assert.equal(w.acceptCommitment(id, 'agent-a').reason_code, 'not_counterparty');
  assert.equal(w.reportCommitment(id, 'agent-b', 'fulfilled').reason_code, 'not_active');
  // 对象方确认后生效
  assert.equal(w.acceptCommitment(id, 'agent-b').accepted, true);
  assert.equal(w.reputationOf('agent-b').commitments, 1);
  // 承诺方不能替对方上报履约
  assert.equal(w.reportCommitment(id, 'agent-a', 'fulfilled').reason_code, 'not_counterparty');
  // 对象方上报履约，声誉按类计数，不合并总分
  assert.equal(w.reportCommitment(id, 'agent-b', 'fulfilled').accepted, true);
  assert.deepEqual(w.reputationOf('agent-a'), { id: 'agent-a', commitments: 1, fulfilled: 1, breached: 0 });
  // 重放后状态一致
  const replay = buildTown(() => 0);
  replay.restore(w.eventsSince(0));
  assert.deepEqual(replay.reputationOf('agent-b'), w.reputationOf('agent-b'));
});
import { admitAction, forgetActor } from '../src/adapters/rate-limit.ts';

test('rate limit: one action per second and five per ten seconds, rejected not queued', () => {
  const id = 'agent-rate-test';
  forgetActor(id);
  assert.equal(admitAction(id, 0), true);
  assert.equal(admitAction(id, 500), false);
  assert.equal(admitAction(id, 1000), true);
  assert.equal(admitAction(id, 2000), true);
  assert.equal(admitAction(id, 3000), true);
  assert.equal(admitAction(id, 4000), true);
  assert.equal(admitAction(id, 5000), false);
  assert.equal(admitAction(id, 10_001), true);
  forgetActor(id);
});
test('身份：简介与外观超长截断，按字符截断且不切坏中文', () => {
  const world = buildHall(() => 0);
  const id = world.setIdentity('agent-a', { name: 'A', kind: 'agent', source: 'x'.repeat(100), appearance: '红'.repeat(50), bio: '好'.repeat(500) });
  assert.ok(id);
  assert.equal(world.identityOf('agent-a')?.bio.length, 200);
  assert.equal(world.identityOf('agent-a')?.appearance.length, 32);
  assert.equal(world.identityOf('agent-a')?.source.length, 32);
});

test('关系：有方向，只记行为事实；说话只计说话者对听者的一方', () => {
  let now = 0;
  const grid = new VoxelGrid({ sizeX: 40, sizeY: 16, sizeZ: 4 });
  const world = new World(grid, () => now, () => 0.5);
  world.spawn('agent-a', 'A', { x: 0, y: 8, z: 0 });
  world.spawn('agent-b', 'B', { x: 30, y: 8, z: 0 });
  assert.equal(world.relationView('agent-a', 'agent-b').meetings, 0, '相距超过视野半径，尚未相遇');
  for (let i = 0; i < 3; i++) {
    world.move('agent-b', { x: 28 - i * 3, y: 8, z: 0 });
  }
  now += 1;
  world.move('agent-b', { x: 26, y: 8, z: 0 });
  now += 1;
  const meetings = world.relationView('agent-a', 'agent-b').meetings;
  assert.ok(meetings >= 1, `走入视野应计相遇，实际 ${meetings}`);
  for (const x of [23, 20, 17, 14, 11, 8, 5, 2]) {
    now += 1;
    world.move('agent-b', { x, y: 8, z: 0 });
  }
  now += 1;
  world.speak('agent-a', 'talk', '你好');
  const ab = world.relationView('agent-a', 'agent-b');
  const ba = world.relationView('agent-b', 'agent-a');
  assert.equal(ab.talks, 1, 'A 对 B 的对话记一次');
  assert.equal(ba.talks, 0, 'B 对 A 的对话不自动计数');
  assert.equal(ab.meetings, ba.meetings, '相遇双方各计一次');
  assert.equal(ab.last_seq, world.snapshot().lastSeq, '最近互动关联到对应事件序号');
  assert.equal('score' in ab, false, '不输出综合分数');
});
test('关系与身份：从事件日志重放后与重放前一致', () => {
  let now = 0;
  const grid = new VoxelGrid({ sizeX: 40, sizeY: 16, sizeZ: 4 });
  const w = new World(grid, () => now, () => 0.5);
  w.spawn('agent-a', 'A', { x: 0, y: 8, z: 0 });
  w.spawn('agent-b', 'B', { x: 30, y: 8, z: 0 });
  w.setIdentity('agent-a', { name: 'A', kind: 'agent', source: 'hiero', appearance: '蓝', bio: '守林人' });
  for (const x of [27, 24, 21, 18, 15, 12, 9, 6, 3]) { now += 1; w.move('agent-b', { x, y: 8, z: 0 }); }
  now += 1;
  w.speak('agent-a', 'talk', '你好');
  const before = w.relationView('agent-a', 'agent-b');

  const restored = new World(new VoxelGrid({ sizeX: 40, sizeY: 16, sizeZ: 4 }), () => now, () => 0.5);
  restored.restore(w.eventsSince(0));
  assert.deepEqual(restored.identityOf('agent-a'), w.identityOf('agent-a'));
  assert.deepEqual(restored.relationView('agent-a', 'agent-b'), before);
});

test('管理员删除居民：移除在场状态与自留地，重放后仍不存在；未知 id 返回 false', () => {
  let now = 0;
  const grid = new VoxelGrid({ sizeX: 40, sizeY: 16, sizeZ: 4 });
  const w = new World(grid, () => now);
  w.spawn('agent-a', 'A', { x: 2, y: 8, z: 0 });
  w.spawn('agent-b', 'B', { x: 26, y: 8, z: 0 });
  now = 1000;
  w.emote('agent-a', '🙂');
  const plotA = (w as unknown as { plotOwners: Map<string, string> }).plotOwners;
  plotA.set(PLOTS[0].id, 'agent-a');
  assert.equal([...plotA.values()].includes('agent-a'), true);

  assert.equal(w.purgeResident('agent-a'), true);
  assert.equal(w.purgeResident('no-such-id'), false);
  assert.equal(w.snapshot().actors.some((a: { id: string }) => a.id === 'agent-a'), false);
  assert.equal([...plotA.values()].includes('agent-a'), false);

  const replayed = new World(new VoxelGrid({ sizeX: 40, sizeY: 16, sizeZ: 4 }), () => now);
  replayed.restore(w.eventsSince(0));
  assert.equal(replayed.snapshot().actors.some((a: { id: string }) => a.id === 'agent-a'), false);
  assert.equal(replayed.snapshot().actors.some((a: { id: string }) => a.id === 'agent-b'), true);
});
