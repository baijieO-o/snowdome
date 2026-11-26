import { hear, degradeText, MODES, type SpeakMode } from './hearing.ts';
import { VoxelGrid, cellDistance, cellKey, parseCellKey, type Cell } from './voxel.ts';
import { labelRooms } from './rooms.ts';
import { Backyard } from './backyard.ts';
import { calendarAt, DAY_MS } from './calendar.ts';
import { TOWN_RECT, PLOTS, PLOT_SIZE, plotEntrance, type Plot } from '../scenes/town.ts';

export interface Actor {
  id: string;
  name: string;
  position: Cell;
  lastSpeakAt: number;
  // 邻近分组：进入小镇时随机分配，每次回来都可能换邻居。
  group: string;
}

export interface Receipt {
  accepted: boolean;
  reason_code: string;
  state_delta: Record<string, unknown>;
  cooldown_ms: number;
}

export interface WorldEvent {
  seq: number;
  time: number;
  type: 'spawn' | 'move' | 'speak' | 'place' | 'pickup' | 'leave' | 'enter' | 'calendar' | 'day_start' | 'handoff_in' | 'identity' | 'commitment' | 'commitment_accept' | 'fulfillment' | 'breach' | 'plot_release' | 'learn_blueprint' | 'craft' | 'give' | 'claim_blueprint' | 'item_grant' | 'item_take' | 'emote' | 'mood' | 'purge';
  actorId: string;
  data: Record<string, unknown>;
}

// 居民断线后自留地保留的时长，默认 24 游戏日；本地开发可用 PLOT_HOLD_MS 环境变量缩短。
const PLOT_HOLD_MS = Number(process.env.PLOT_HOLD_MS ?? 24 * DAY_MS);

// 身份：由登录时的自我介绍决定，简介与外观由居民自己填写，服务端只截断长度。
export interface Identity {
  id: string;
  name: string;
  kind: 'visitor' | 'agent';
  source: string;
  appearance: string;
  bio: string;
  created_at: number;
}

export interface IdentityInput {
  name: string;
  kind: 'visitor' | 'agent';
  source: string;
  appearance: string;
  bio: string;
}

// 从 from 指向 to 的关系（有向、不对称）：只记录可观察的行为事实，不合成任何好感度分数。
// last_seq 指向最近一次相关事件的序号，便于追溯到具体经历。
// 承诺：promiser 对 counterparty 作出的声明。须对方确认后才生效（active），
// 之后只能由对方上报履约（fulfilled）或未履约（breached）。
export interface Commitment {
  id: number;
  promiser: string;
  counterparty: string;
  content: string;
  status: 'pending' | 'active' | 'fulfilled' | 'breached';
  created_seq: number;
  last_seq: number;
}

// 声誉按类计数，只呈现事实的数量，不合成总分（汇编 6.2）。
export interface ReputationView {
  id: string;
  commitments: number;
  fulfilled: number;
  breached: number;
}

export interface RelationView {
  id: string;
  meetings: number;
  talks: number;
  last_day: number | null;
  last_seq: number | null;
}

interface Relation {
  from: string;
  to: string;
  meetings: number;
  talks: number;
  last_day: number;
  last_seq: number;
}

export interface Heard {
  listenerId: string;
  speakerId: string;
  mode: SpeakMode;
  clarity: number;
  distance: number;
  walls: number;
  text: string;
}

// 一条对话记录：自己说的（kind: 'said'）或听到的（kind: 'heard'）。
export interface Utterance {
  kind: 'said' | 'heard';
  speakerId: string;
  mode: SpeakMode;
  clarity: number;
  text: string;
  time: number;
  // 全局递增序号，第三方凭 since 只拉取之后的新增对话。
  seq: number;
}

export const MAX_MOVE_STEP = 3;
// 赠送的最大距离：双方相隔不超过 4 格（用户决定）。
export const GIFT_RANGE = 4;
export const SPEAK_COOLDOWN_MS = 2000;
// 同一对居民在窗口内互相回应过多时，停止投递，防止“你好”来回循环。
export const PAIR_TALK_WINDOW_MS = 120_000;
export const PAIR_TALK_LIMIT = 6;
// 建造触及距离：只允许相邻的 6 个面方向（斜角距离 √2 > 1，不可达）。
export const BUILD_REACH = 1;
// 视野半径：在此距离内的居民互相可见，也是相遇的判定范围。
export const SIGHT_RADIUS = 24;
export const BIO_MAX = 200;
export const APPEARANCE_MAX = 32;
export const SOURCE_MAX = 32;

// 后院可建造的范围（后院是独立的小地块，与小镇网格分开）。
export const YARD_BOUNDS = { sizeX: 64, sizeY: 64, sizeZ: 16 };

function inRange(c: Cell, b: { sizeX: number; sizeY: number; sizeZ: number }): boolean {
  return c.x >= 0 && c.y >= 0 && c.z >= 0 && c.x < b.sizeX && c.y < b.sizeY && c.z < b.sizeZ;
}

// 小镇矩形（含墙）内的格子：这里禁止任何建造与拆除。
function inTown(c: Cell): boolean {
  return c.x >= TOWN_RECT.x0 && c.x <= TOWN_RECT.x1 && c.y >= TOWN_RECT.y0 && c.y <= TOWN_RECT.y1;
}

// 格子所在的自留地（不在任何自留地里则返回 undefined）。
function plotAt(c: Cell): Plot | undefined {
  return PLOTS.find((p) => c.x >= p.x0 && c.x < p.x0 + PLOT_SIZE && c.y >= p.y0 && c.y < p.y0 + PLOT_SIZE);
}

// 访客 id 形如 visitor-xxxxxxxx（见 adapters/session.ts），访客不能建造也不能占用自留地。
function isVisitor(id: string): boolean {
  return id.startsWith('visitor-');
}

function isReachable(from: Cell, to: Cell): boolean {
  return cellDistance(from, to) <= BUILD_REACH;
}

// 单个 emoji：一个图形字符（可含肤色、变体选择符、ZWJ 连接或旗帜区域码对），不接受普通文字或多个 emoji。
const EMOJI_PATTERN = /^(?:\p{Regional_Indicator}{2}|\p{Extended_Pictographic}(?:\p{Emoji_Modifier}|\uFE0F|\u20E3)*(?:\u200D\p{Extended_Pictographic}(?:\p{Emoji_Modifier}|\uFE0F)*)*)$/u;
export function isSingleEmoji(text: string): boolean {
  return typeof text === 'string' && EMOJI_PATTERN.test(text);
}
// 心情数值必须是 [-1, 1] 内的有限数。
function isUnitRange(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n >= -1 && n <= 1;
}
function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
const EVENT_LIMIT = 500;
const COMMITMENT_MAX = 200;
import { YIELD, type Material } from './backyard.ts';
import { FURNITURE, blueprintItem, canCraft, furnitureItem, isFurnitureKind, isGiftItem, type FurnitureKind } from './crafting.ts';
import { SHOP_BLUEPRINTS, isShopkeeper, shopkeeperReply } from './shopkeeper.ts';

// 背包：按材料种类堆叠的数量。材料只有数量，没有格数上限（决策：背包不限格数）。
export class Bag {
  private readonly items = new Map<string, number>();

  get(item: string): number {
    return this.items.get(item) ?? 0;
  }

  add(item: string, amount: number): void {
    this.items.set(item, this.get(item) + amount);
  }

  take(item: string, amount: number): void {
    this.items.set(item, this.get(item) - amount);
  }

  total(): number {
    let sum = 0;
    for (const n of this.items.values()) sum += n;
    return sum;
  }

  toJSON(): Record<string, number> {
    return Object.fromEntries(this.items);
  }
}

// 从快照或事件里的背包数据还原 Bag。旧版本的数字 bag 无法归类，忽略。
function bagFrom(data: Record<string, number> | number): Bag {
  const bag = new Bag();
  if (typeof data === 'object') for (const [item, amount] of Object.entries(data)) bag.add(item, amount);
  return bag;
}

// 可放置的材质：玩家能放下的只有有产出的材料（草块只能是地形，不能放下）。
const PLACEABLE: ReadonlySet<string> = new Set<Material>(['wood', 'fiber', 'stone', 'dirt']);
function isPlaceable(material?: string): material is Material {
  return material !== undefined && PLACEABLE.has(material);
}

// 每个居民的收件箱上限：没有订阅者时只保留最近的内容，避免无限增长。
const INBOX_LIMIT = 50;
// 表情：10 游戏秒后消失，3 格（欧氏距离）内的 agent 与访客可见。
const EMOTE_TTL_MS = 10_000;
const EMOTE_RANGE = 3;
export type EmoteKind = 'live' | 'baseline';
// 每个居民的表情状态：常态（不过期，可被改变）与实时（过期后回落到常态）。
interface EmoteSlot { baseline: string | null; live: { emoji: string; expiresAt: number } | null }
// 心情（效价-唤醒度）：valence 负面到正面，arousal 平静到激动，取值均为 [-1, 1]。
// 没有新提交时按半衰期回归中性（0, 0）。
const MOOD_HALF_LIFE_MS = 60_000;
// 每个居民保留的最近对话条数，随观察包一起给 AI，让它知道上文。
const TRANSCRIPT_LIMIT = 12;
// 一个邻近分组最多容纳的居民数。
export const MAX_GROUP_SIZE = 8;

// 跨小镇交接快照：离开时的后院状态，可序列化为 JSON。yardCells 为 cellKey 字符串。
export interface HandoffSnapshot {
  id: string;
  name: string;
  seed: number;
  // 背包：材料种类 -> 数量。旧版本的数字 bag 无法映射到种类，导入时忽略。
  bag: Record<string, number> | number;
  yardCells: string[];
  // 小镇里该居民放置的建筑格子（cellKey 字符串），整块随居民搬到新小镇。
  buildCells: string[];
  // 离开时占用的自留地 id（可选，旧快照没有）。导入时若该地块已被占用，改分配空闲地块。
  plotId?: string;
}
// 目前唯一的离开去处：后院。
const DESTINATIONS = ['backyard'];

// 世界权威：所有位置与听觉结果都在这里计算，外部只能提交意图。
export class World {
  readonly grid: VoxelGrid;
  private readonly actors = new Map<string, Actor>();
  // 离开小镇的居民（不在地图上）：id -> 名字与分组，回来时用。
  private readonly away = new Map<string, { name: string; group: string }>();
  // 每位居民的后院（离开时创建，种子由事件记录决定）与从后院带回的方块数。
  private readonly yards = new Map<string, Backyard>();
  // 后院里由该居民放下的方块（只能拿起自己放的）。
  private readonly yardOwners = new Map<string, Set<string>>();
  private readonly bags = new Map<string, Bag>();
  // 离开时被移出小镇的建筑格子，供交接快照导出。
  private readonly lastBuildCells = new Map<string, string[]>();
  // 离开时占用的自留地 id，供交接快照导出。
  private readonly lastPlotIds = new Map<string, string | undefined>();
  private events: WorldEvent[] = [];
  private seq = 0;
  private groupCount = 0;
  private readonly clock: () => number;
  private readonly random: () => number;
  // 回城时的出生点（小镇广场）。
  readonly entrance: Cell;
  // 房间编号；每次建造或拆除后重算。
  private rooms: Int32Array;
  // 玩家建造的方块归属：格子键 -> 放置者 id。场景原有的墙没有归属，不能被拿走。
  private readonly owners = new Map<string, string>();
  // 小镇内建造的方块材质：格子键 -> 材质。拆除时据此产出背包，并在此删除。
  private readonly townMaterials = new Map<string, Material>();
  // 已学会的家具图纸：居民 id -> 家具种类集合。学习后保留配方记录。
  private readonly learned = new Map<string, Set<FurnitureKind>>();
  // 自留地占用：自留地 id -> 占用者 id。先到先得，占用者离开小镇即释放。
  private readonly plotOwners = new Map<string, string>();
  // 离开小镇（断线）后暂留的自留地：自留地 id -> 离开时刻（墙钟毫秒）。到期才真正释放。
  private readonly pendingPlots = new Map<string, number>();
  // 每个居民听到的话，等待观察包取走。
  private readonly inbox = new Map<string, Heard[]>();
  private readonly emotes = new Map<string, EmoteSlot>();
  // 心情：最近一次提交的效价与唤醒度，以及提交时刻（用于衰减）。
  private readonly moods = new Map<string, { valence: number; arousal: number; at: number }>();
  // 每个居民最近的对话上下文，不随取走而清空。
  private readonly transcripts = new Map<string, Utterance[]>();
  private utteranceSeq = 0;
  // 身份表：居民 id -> 身份。离开小镇不删除，回来时仍可读。
  private readonly identities = new Map<string, Identity>();
  // 关系表：有向记录，键为 from|to。由事件投影得出，重放时同样重建。
  private readonly relations = new Map<string, Relation>();
  // 无方向的居民对 -> 近期说话时间戳（仅内存，由事件重放恢复）。
  private readonly pairTalks = new Map<string, number[]>();
  // 承诺表：键为提出承诺的事件序号。状态只记录事实，不判断对错。
  private readonly commitments = new Map<number, Commitment>();
  private readonly listeners = new Set<(event: WorldEvent) => void>();

  constructor(grid: VoxelGrid, clock: () => number = Date.now, random: () => number = Math.random, entrance: Cell = { x: 0, y: 0, z: 0 }) {
    this.grid = grid;
    this.clock = clock;
    this.random = random;
    this.entrance = { ...entrance };
    this.rooms = labelRooms(grid);
  }

  // 放置：目标必须是相邻格（6 方向之一，或原地上下一格），在范围内、为空、没有居民站着。
  // 小镇内禁止建造；只能在自己占用的自留地里建造。
  place(id: string, target: Cell, material?: string): Receipt {
    if (this.away.has(id)) return this.placeInYard(id, target, material);
    const actor = this.actors.get(id);
    if (!actor) return reject('unknown_actor');
    if (!this.grid.inBounds(target)) return reject('out_of_bounds');
    if (inTown(target)) return reject('town_locked');
    if (!this.canBuildOnPlot(id, target)) return reject('not_your_plot');
    if (this.grid.isSolid(target)) return reject('occupied');
    if (!isReachable(actor.position, target)) return reject('out_of_reach', { max_reach: BUILD_REACH });
    if (this.isOccupiedByActor(target)) return reject('occupied_by_actor');
    if (!isPlaceable(material)) return reject('material_required');
    const cost = YIELD[material];
    const bag = this.bagOf(id);
    if (bag.get(cost.item) < cost.amount) return reject('insufficient_material', { item: cost.item, need: cost.amount });
    bag.take(cost.item, cost.amount);
    this.grid.setSolid(target);
    this.owners.set(cellKey(target), id);
    this.townMaterials.set(cellKey(target), material);
    this.rooms = labelRooms(this.grid);
    this.record('place', id, { target, material });
    return accept({ target, material, cost: { item: cost.item, amount: cost.amount } });
  }

  // 拿起：小镇内只能拿自己放的方块，且必须在触及范围内；后院里地形与自己放的方块都可拆。
  pickup(id: string, target: Cell): Receipt {
    if (this.away.has(id)) return this.pickupInYard(id, target);
    const actor = this.actors.get(id);
    if (!actor) return reject('unknown_actor');
    if (!this.grid.inBounds(target)) return reject('out_of_bounds');
    if (inTown(target)) return reject('town_locked');
    if (!this.grid.isSolid(target)) return reject('nothing_there');
    if (this.owners.get(cellKey(target)) !== id) return reject('not_owner');
    if (!isReachable(actor.position, target)) return reject('out_of_reach', { max_reach: BUILD_REACH });
    const material = this.townMaterials.get(cellKey(target));
    this.grid.clearSolid(target);
    this.owners.delete(cellKey(target));
    this.townMaterials.delete(cellKey(target));
    this.rooms = labelRooms(this.grid);
    const gain = material ? YIELD[material] : undefined;
    if (gain) this.bagOf(id).add(gain.item, gain.amount);
    this.record('pickup', id, { target, material });
    return accept({ target, bag: this.bagOf(id).toJSON() });
  }

  // 只有占用该自留地的居民才能在里面建造；访客与别人的自留地一律不行。
  private canBuildOnPlot(id: string, c: Cell): boolean {
    if (isVisitor(id)) return false;
    const plot = plotAt(c);
    return plot !== undefined && this.plotOwners.get(plot.id) === id;
  }

  // 释放该居民占用的自留地（立即）。只用于访客或已被明确放弃的情况。
  private releasePlots(id: string): void {
    for (const [plotId, holder] of this.plotOwners) {
      if (holder === id) {
        this.plotOwners.delete(plotId);
        this.pendingPlots.delete(plotId);
      }
    }
  }

  // 暂留自留地：居民仍是该地的占用者，但不在小镇里。到期后由 releaseExpiredPlots 释放。
  private holdPlots(id: string, time: number): void {
    for (const [plotId, holder] of this.plotOwners) {
      if (holder === id) this.pendingPlots.set(plotId, time);
    }
  }

  // 释放所有暂留超过 PLOT_HOLD_MS 的自留地，并记录事件（重放时同样释放）。返回释放的自留地 id。
  releaseExpiredPlots(): string[] {
    const now = this.clock();
    const released: string[] = [];
    for (const [plotId, since] of [...this.pendingPlots]) {
      if (now - since < PLOT_HOLD_MS) continue;
      const holder = this.plotOwners.get(plotId);
      this.pendingPlots.delete(plotId);
      if (holder === undefined) continue;
      this.plotOwners.delete(plotId);
      this.record('plot_release', holder, { plotId });
      released.push(plotId);
    }
    return released;
  }

  private isOccupiedByActor(c: Cell): boolean {
    for (const a of this.actors.values()) {
      if (a.position.x === c.x && a.position.y === c.y && a.position.z === c.z) return true;
    }
    return false;
  }

  // 居民上线：先到先得认领一块空闲自留地，出生在它的正中心；没有空地则退回到小镇入口。
  // 第三方 agent 返回小镇后分配自留地：移到第一块空自留地中心；没有空地或已在自留地则不动。
  claimPlot(id: string): Receipt {
    const actor = this.actors.get(id);
    if (!actor) return reject('unknown_actor');
    if (plotAt(actor.position)) return accept({ position: actor.position });
    // 已经占有自留地的居民（走出地外后返回）：回到自己的地中心，不再占第二块。
    const owned = PLOTS.find((p) => this.plotOwners.get(p.id) === id);
    const plot = owned ?? PLOTS.find((p) => !this.plotOwners.has(p.id));
    if (!plot) return accept({ position: actor.position });
    const target = { x: plot.x0 + Math.floor(PLOT_SIZE / 2), y: plot.y0 + Math.floor(PLOT_SIZE / 2), z: 0 };
    if (this.grid.isSolid(target)) return accept({ position: actor.position });
    this.plotOwners.set(plot.id, id);
    const from = actor.position;
    const before = this.seenFrom(id, from);
    actor.position = { ...target };
    const event = this.record('move', id, { from, to: actor.position });
    this.meetNew(id, before, this.seenFrom(id, actor.position), event.time);
    return accept({ position: actor.position });
  }

  spawnOnPlot(id: string, name: string): Receipt {
    if (this.actors.has(id)) return reject('duplicate_id');
    // 已占有自留地的居民（断线暂留或交接导入）回到自己的地块，不再占第二块。
    const plot = PLOTS.find((p) => this.plotOwners.get(p.id) === id) ?? PLOTS.find((p) => !this.plotOwners.has(p.id));
    if (!plot) return this.spawn(id, name, this.entrance);
    this.plotOwners.set(plot.id, id);
    const center = { x: plot.x0 + Math.floor(PLOT_SIZE / 2), y: plot.y0 + Math.floor(PLOT_SIZE / 2), z: 0 };
    return this.spawn(id, name, center);
  }

  spawn(id: string, name: string, position: Cell): Receipt {
    if (this.actors.has(id)) return reject('duplicate_id');
    if (!this.grid.inBounds(position) || this.grid.isSolid(position)) return reject('invalid_spawn_cell');
    const spot = { ...position };
    const group = this.pickGroup();
    const actor: Actor = { id, name, position: spot, lastSpeakAt: -Infinity, group };
    this.actors.set(id, actor);
    const event = this.record('spawn', id, { name, position: actor.position, group });
    this.meetNew(id, new Set(), this.seenFrom(id, spot), event.time);
    return accept({ position: actor.position, group });
  }

  // 居民能否从当前位置离开：必须站在自己占用的自留地的后院入口上。
  canLeaveFrom(id: string): Receipt {
    const actor = this.actors.get(id);
    if (!actor) return reject('unknown_actor');
    const plot = plotAt(actor.position);
    if (!plot || this.plotOwners.get(plot.id) !== id) return reject('not_at_yard_gate');
    const gate = plotEntrance(plot);
    if (gate.x !== actor.position.x || gate.y !== actor.position.y) return reject('not_at_yard_gate');
    return accept({});
  }

  // 离开小镇：居民从地图上消失，进入后院。后院种子随事件记录，重放时地形一致。
  leave(id: string, destination: string): Receipt {
    const actor = this.actors.get(id);
    if (!actor) return reject('unknown_actor');
    if (!DESTINATIONS.includes(destination)) return reject('unknown_destination');
    const seed = this.random() * 2 ** 32 >>> 0;
    const buildCells = this.buildCellsOf(id);
    const plotId = this.plotIdOf(id);
    this.lastBuildCells.set(id, buildCells);
    this.lastPlotIds.set(id, plotId);
    this.actors.delete(id);
    // 访客离开即释放自留地；居民（agent）暂留自留地，等待回来或到期释放。
    if (isVisitor(id)) this.releasePlots(id);
    else this.holdPlots(id, this.clock());
    this.removeBuildings(id);
    this.away.set(id, { name: actor.name, group: actor.group });
    this.yards.set(id, new Backyard(seed));
    this.inbox.delete(id);
    this.transcripts.delete(id);
    this.record('leave', id, { name: actor.name, from: 'town', to: destination, last: actor.position, seed, buildCells, plotId });
    return accept({ destination });
  }

  hasAway(id: string): boolean {
    return this.away.has(id);
  }

  // 返回小镇：回到广场，重新随机分组（可能换邻居）。后院里自己放过的方块随身带回背包。
  enter(id: string, from: string): Receipt {
    const gone = this.away.get(id);
    if (!gone) return reject('not_away');
    // 入口被占时就近找空位，避免长时间排队被拒。
    const spot = this.isOccupiedByActor(this.entrance) ? this.freeCellNear(this.entrance) : { ...this.entrance };
    if (!spot) return reject('entrance_occupied');
    this.away.delete(id);
    // 回到小镇：暂留的自留地恢复为正常占用，不再计时释放。
    for (const [plotId, holder] of this.plotOwners) if (holder === id) this.pendingPlots.delete(plotId);
    const group = this.pickGroup();
    const actor: Actor = { id, name: gone.name, position: { ...spot }, lastSpeakAt: -Infinity, group };
    this.actors.set(id, actor);
    this.yards.delete(id);
    const bag = this.bagOf(id).toJSON();
    const event = this.record('enter', id, { name: gone.name, from, to: 'town', position: actor.position, group, bag });
    this.meetNew(id, new Set(), this.seenFrom(id, actor.position), event.time);
    return accept({ position: actor.position, group, bag });
  }

  // 该居民当前占用的自留地 id（没有则 undefined）。
  private plotIdOf(id: string): string | undefined {
    for (const [plotId, holder] of this.plotOwners) if (holder === id) return plotId;
    return undefined;
  }

  // 该居民在小镇里放置的建筑格子（cellKey 字符串）。
  private buildCellsOf(id: string): string[] {
    return [...this.owners].filter(([, owner]) => owner === id).map(([key]) => key);
  }

  // 从小镇网格移除该居民的建筑（离开时调用）。
  private removeBuildings(id: string): void {
    for (const key of this.buildCellsOf(id)) {
      const cell = parseCellKey(key);
      this.grid.clearSolid(cell);
      this.owners.delete(key);
    }
    this.rooms = labelRooms(this.grid);
  }

  // 把建筑写回网格（迁入时调用）。格子被占用则跳过，并返回实际写入的数量。
  private addBuildings(id: string, keys: string[]): number {
    let added = 0;
    for (const key of keys) {
      const cell = parseCellKey(key);
      if (!this.grid.inBounds(cell) || this.grid.isSolid(cell)) continue;
      this.grid.setSolid(cell);
      this.owners.set(key, id);
      added += 1;
    }
    this.rooms = labelRooms(this.grid);
    return added;
  }

  // 交接快照：居民离开时导出其后院种子、背包、后院方块与小镇建筑，用于跨小镇进程迁移。
  exportHandoff(id: string): HandoffSnapshot | undefined {
    const gone = this.away.get(id);
    const yard = this.yards.get(id);
    if (!gone || !yard) return undefined;
    return {
      id,
      name: gone.name,
      seed: yard.seed,
      bag: this.bagOf(id).toJSON(),
      yardCells: [...this.yardOwned(id)],
      buildCells: this.lastBuildCells.get(id) ?? [],
      plotId: this.lastPlotIds.get(id),
    };
  }

  // 接收交接快照：在本进程重建后院、建筑与自留地（不产生事件，由调用方决定是否记录）。
  // 返回实际写入的建筑数量。
  importHandoff(snapshot: HandoffSnapshot): number {
    // 自留地在导入时决定最终位置，并写进事件，保证重放得到同一结果。
    const plotId = this.claimPlotForHandoff(snapshot.id, snapshot.plotId);
    const added = this.applyHandoff({ ...snapshot, plotId });
    const bag = typeof snapshot.bag === 'object' ? snapshot.bag : {};
    this.record('handoff_in', snapshot.id, { name: snapshot.name, seed: snapshot.seed, bag, yardCells: snapshot.yardCells, buildCells: snapshot.buildCells, plotId });
    return added;
  }

  // 原地块空闲则占用；已被别人占用则分配第一块空闲地块（plot_relocated 由事件里的 plotId 体现）。
  // 没有空地时返回 undefined，居民回到小镇后再由 claimPlot 处理。
  private claimPlotForHandoff(id: string, preferred: string | undefined): string | undefined {
    // 快照里没有自留地（例如居民离开前未占地）：不在这里分配，由回城时的 claimPlot 处理。
    if (preferred === undefined) return undefined;
    // 该居民已占有某块地（例如重复导入）：保持原地块，不再占第二块。
    const held = PLOTS.find((p) => this.plotOwners.get(p.id) === id);
    if (held) return held.id;
    const wanted = PLOTS.find((p) => p.id === preferred && !this.plotOwners.has(p.id));
    const plot = wanted ?? PLOTS.find((p) => !this.plotOwners.has(p.id));
    if (!plot) return undefined;
    this.plotOwners.set(plot.id, id);
    return plot.id;
  }

  // 只改内存，供实时导入与重放共用。
  private applyHandoff(snapshot: HandoffSnapshot): number {
    this.lastPlotIds.set(snapshot.id, snapshot.plotId);
    this.away.set(snapshot.id, { name: snapshot.name, group: this.pickGroup() });
    this.yards.set(snapshot.id, new Backyard(snapshot.seed));
    this.bags.set(snapshot.id, bagFrom(snapshot.bag));
    const owned = this.yardOwned(snapshot.id);
    owned.clear();
    for (const key of snapshot.yardCells) owned.add(key);
    return this.addBuildings(snapshot.id, snapshot.buildCells);
  }

  // 后院建造：放下须指定材质，并扣除该材质拆除时的产出数量（不足则拒绝）。
  // 只能拿起自己放过的方块，拆除后按材质产出材料进背包，回城时带回。
  placeInYard(id: string, target: Cell, material?: string): Receipt {
    const yard = this.yards.get(id);
    if (!yard) return reject('not_in_yard');
    if (!isPlaceable(material)) return reject('material_required');
    if (!inRange(target, YARD_BOUNDS)) return reject('out_of_bounds');
    if (yard.isSolid(target)) return reject('occupied');
    const cost = YIELD[material];
    if (!cost) return reject('material_required');
    const bag = this.bagOf(id);
    if (bag.get(cost.item) < cost.amount) return reject('insufficient_material', { item: cost.item, need: cost.amount });
    bag.take(cost.item, cost.amount);
    yard.setSolid(target, material);
    this.yardOwned(id).add(cellKey(target));
    this.record('place', id, { target, yard: true, material });
    return accept({ target, material, cost: { item: cost.item, amount: cost.amount } });
  }

  // 拆除：自己放的方块与后院地形都可以拆，按材质产出材料。
  pickupInYard(id: string, target: Cell): Receipt {
    const yard = this.yards.get(id);
    if (!yard) return reject('not_in_yard');
    if (!yard.isSolid(target)) return reject('empty');
    const material = yard.materialAt(target);
    yard.clearSolid(target);
    this.yardOwned(id).delete(cellKey(target));
    const gain = YIELD[material];
    if (gain) this.bagOf(id).add(gain.item, gain.amount);
    this.record('pickup', id, { target, yard: true });
    return accept({ target, bag: this.bagOf(id).toJSON() });
  }

  // 向店主领取图纸：店主免费发放，居民需在店主附近（GIFT_RANGE 格内）。店主只发 SHOP_BLUEPRINTS 里的图纸。
  claimBlueprint(id: string, kind: string): Receipt {
    const actor = this.actors.get(id);
    if (!actor) return reject('unknown_actor');
    if (!isFurnitureKind(kind) || !SHOP_BLUEPRINTS.includes(kind)) return reject('unknown_furniture');
    const shop = this.findShopkeeper();
    if (!shop || cellDistance(actor.position, shop.position) > GIFT_RANGE) return reject('not_at_shop');
    this.bagOf(id).add(blueprintItem(kind), 1);
    this.record('claim_blueprint', id, { kind, from: shop.id });
    return accept({ kind, bag: this.bagOf(id).toJSON() });
  }

  // 店主是否在场：店主也是普通居民，位置由 spawn 决定，id 以 npc- 开头。
  private findShopkeeper(): Actor | undefined {
    for (const actor of this.actors.values()) if (isShopkeeper(actor.id)) return actor;
    return undefined;
  }

  // 学习图纸：消耗背包里的图纸物品，之后可以制作该家具。基础家具不需要图纸，无需学习。
  learnBlueprint(id: string, kind: string): Receipt {
    if (!this.actors.has(id)) return reject('unknown_actor');
    if (!isFurnitureKind(kind)) return reject('unknown_furniture');
    const item = blueprintItem(kind);
    if (this.bagOf(id).get(item) < 1) return reject('no_blueprint', { item });
    this.bagOf(id).take(item, 1);
    this.learnedOf(id).add(kind);
    this.record('learn_blueprint', id, { kind });
    return accept({ kind, bag: this.bagOf(id).toJSON() });
  }

  // 制作家具：需要已学图纸（基础家具除外），扣除材料，产出家具物品。
  craft(id: string, kind: string): Receipt {
    if (!this.actors.has(id)) return reject('unknown_actor');
    if (!isFurnitureKind(kind)) return reject('unknown_furniture');
    if (!canCraft(kind, this.learnedOf(id))) return reject('blueprint_required', { kind });
    const bag = this.bagOf(id);
    const cost = FURNITURE[kind].cost;
    for (const [item, amount] of Object.entries(cost)) {
      if (bag.get(item) < amount) return reject('insufficient_material', { item, need: amount });
    }
    for (const [item, amount] of Object.entries(cost)) bag.take(item, amount);
    bag.add(furnitureItem(kind), 1);
    this.record('craft', id, { kind });
    return accept({ kind, bag: bag.toJSON() });
  }

  // 赠送：把一件图纸或家具转移给对方。双方须在同一小镇内，且相隔不超过 GIFT_RANGE 格。
  give(id: string, toId: string, item: string): Receipt {
    const from = this.actors.get(id);
    const to = this.actors.get(toId);
    if (!from) return reject('unknown_actor');
    if (!to) return reject('recipient_not_here');
    if (id === toId) return reject('self_gift');
    if (cellDistance(from.position, to.position) > GIFT_RANGE) return reject('out_of_gift_range', { max_range: GIFT_RANGE });
    if (!isGiftItem(item)) return reject('unknown_item', { item });
    if (this.bagOf(id).get(item) < 1) return reject('no_item', { item });
    this.bagOf(id).take(item, 1);
    this.bagOf(toId).add(item, 1);
    this.record('give', id, { to: toId, item });
    return accept({ item, to: toId });
  }

  // 学会的图纸记录：由 learn_blueprint 事件重建，不随背包消耗而删除。
  private learnedOf(id: string): Set<FurnitureKind> {
    let set = this.learned.get(id);
    if (!set) {
      set = new Set();
      this.learned.set(id, set);
    }
    return set;
  }

  private bagOf(id: string): Bag {
    let bag = this.bags.get(id);
    if (!bag) {
      bag = new Bag();
      this.bags.set(id, bag);
    }
    return bag;
  }

  private yardOwned(id: string): Set<string> {
    let set = this.yardOwners.get(id);
    if (!set) {
      set = new Set();
      this.yardOwners.set(id, set);
    }
    return set;
  }

  // 还原历史分组时，保证之后新开的分组编号不与旧的重复。
  private bumpGroup(group: string): void {
    const n = Number(group.slice(1));
    if (Number.isFinite(n) && n > this.groupCount) this.groupCount = n;
  }

  // 随机分组：优先加入未满的已有分组，否则新开一组。每组最多 MAX_GROUP_SIZE 人。
  private pickGroup(): string {
    const counts = new Map<string, number>();
    for (const a of this.actors.values()) counts.set(a.group, (counts.get(a.group) ?? 0) + 1);
    const open = [...counts].filter(([, n]) => n < MAX_GROUP_SIZE).map(([g]) => g);
    if (open.length > 0 && this.random() < 0.8) return open[Math.floor(this.random() * open.length)];
    this.groupCount += 1;
    return `g${this.groupCount}`;
  }

  // 从 origin 开始，在同一层的近处找一个既没有方块也没有居民的格子（按曼哈顿距离由近到远）。
  freeCellNear(origin: Cell, maxRadius = 6): Cell | undefined {
    for (let r = 0; r <= maxRadius; r++) {
      for (let dx = -r; dx <= r; dx++) {
        for (let dy = -r; dy <= r; dy++) {
          if (Math.abs(dx) + Math.abs(dy) !== r) continue;
          const c = { x: origin.x + dx, y: origin.y + dy, z: origin.z };
          if (!this.grid.inBounds(c) || this.grid.isSolid(c) || this.isOccupiedByActor(c)) continue;
          return c;
        }
      }
    }
    return undefined;
  }

  getActor(id: string): Actor | undefined {
    return this.actors.get(id);
  }

  // 移动：每次最多 MAX_MOVE_STEP 格，只能走到空格子，路径上不能有墙。
  move(id: string, target: Cell): Receipt {
    const actor = this.actors.get(id);
    if (!actor) return reject('unknown_actor');
    if (!this.grid.inBounds(target)) return reject('out_of_bounds');
    if (this.grid.isSolid(target)) return reject('blocked_by_solid');
    if (this.isOccupiedByActor(target)) return reject('occupied_by_actor');
    if (cellDistance(actor.position, target) > MAX_MOVE_STEP) {
      return reject('too_far', { max_step: MAX_MOVE_STEP });
    }
    if (this.grid.countSolidsBetween(actor.position, target) > 0) return reject('blocked_path');
    // 站在方块上：只能站在自己放的方块正上方一格；别人的方块上不能站。
    const below = { x: target.x, y: target.y, z: target.z - 1 };
    if (this.grid.inBounds(below) && this.grid.isSolid(below) && this.owners.get(cellKey(below)) !== id) {
      return reject('cannot_stand_on_other');
    }
    // 进入自留地：空地先到先得占用；别人的地可以走进去参观，但不改变归属，且不能在里面建造。访客不占用空地。
    const plot = plotAt(target);
    if (plot) {
      const holder = this.plotOwners.get(plot.id);
      if (holder === undefined && !isVisitor(id)) this.plotOwners.set(plot.id, id);
    }
    const from = actor.position;
    const before = this.seenFrom(id, from);
    actor.position = { ...target };
    const event = this.record('move', id, { from, to: actor.position });
    this.meetNew(id, before, this.seenFrom(id, actor.position), event.time);
    return accept({ position: actor.position });
  }

  // 说话：服务器计算每个听众的清晰度与文本。
  speak(id: string, mode: SpeakMode, text: string): Receipt & { heard: Heard[] } {
    const speaker = this.actors.get(id);
    if (!speaker) return { ...reject('unknown_actor'), heard: [] };
    if (!(mode in MODES)) return { ...reject('invalid_mode'), heard: [] };
    if (!text || text.trim() === '') return { ...reject('empty_text'), heard: [] };
    const now = this.clock();
    const wait = speaker.lastSpeakAt + SPEAK_COOLDOWN_MS - now;
    if (wait > 0) return { ...reject('cooldown', { cooldown_ms: Math.ceil(wait) }), cooldown_ms: Math.ceil(wait), heard: [] };
    speaker.lastSpeakAt = now;

    const heard: Heard[] = [];
    for (const listener of this.actors.values()) {
      if (listener.id === id) continue;
      // 同房间：不计墙，仍按距离衰减；跨房间：每堵墙清晰度减半。
      const sameRoom = this.roomOf(speaker.position) === this.roomOf(listener.position);
      const r = hear(speaker.position, listener.position, mode, (a, b) =>
        sameRoom ? 0 : this.grid.countSolidsBetween(a, b),
      );
      if (!r.heard) continue;
      if (this.pairTalkLimited(id, listener.id, now)) continue;
      const item: Heard = {
        listenerId: listener.id,
        speakerId: id,
        mode,
        clarity: round(r.clarity),
        distance: round(r.distance),
        walls: r.walls,
        text: degradeText(text, r.clarity),
      };
      heard.push(item);
      this.notePairTalk(id, listener.id, now);
      this.deliver(listener.id, item);
      this.remember(listener.id, { kind: 'heard', speakerId: id, mode, clarity: item.clarity, text: item.text, time: now });
    }
    this.remember(id, { kind: 'said', speakerId: id, mode, clarity: 1, text, time: now });
    const event = this.record('speak', id, {
      mode,
      text,
      origin: speaker.position,
      range: MODES[mode].maxRange,
      heard: heard.map((h) => ({ listenerId: h.listenerId, clarity: h.clarity })),
    });
    for (const h of heard) this.bumpTalk(id, h.listenerId, event);
    this.shopkeeperAnswer(id, text, heard);
    return { ...accept({ heard: heard.length }), heard };
  }

  // 表情分两种：实时（kind=live，EMOTE_TTL_MS 后结束）与常态（kind=baseline，不过期）。
  // 实时表情结束后露出常态表情；两者都可以被居民随时改变。只有 EMOTE_RANGE 内的 agent 与访客能看到。
  emote(id: string, emoji: string, kind: EmoteKind = 'live'): Receipt {
    const speaker = this.actors.get(id);
    if (!speaker) return reject('unknown_actor');
    if (!isSingleEmoji(emoji)) return reject('invalid_emoji');
    const now = this.clock();
    if (kind === 'baseline') {
      const slot = this.emotes.get(id) ?? { baseline: null, live: null };
      slot.baseline = emoji;
      this.emotes.set(id, slot);
      this.record('emote', id, { emoji, kind, expiresAt: null });
      return accept({ emoji, kind, expiresAt: null });
    }
    const expiresAt = now + EMOTE_TTL_MS;
    const slot = this.emotes.get(id) ?? { baseline: null, live: null };
    slot.live = { emoji, expiresAt };
    this.emotes.set(id, slot);
    this.record('emote', id, { emoji, kind, expiresAt });
    return accept({ emoji, kind, expiresAt });
  }

  // 心情：居民自己提交效价与唤醒度（都在 [-1, 1] 内）。心情与表情互相独立，可以不一致。
  mood(id: string, valence: number, arousal: number): Receipt {
    if (!this.actors.has(id) && !this.away.has(id)) return reject('unknown_actor');
    if (!isUnitRange(valence) || !isUnitRange(arousal)) return reject('invalid_mood');
    const at = this.clock();
    this.moods.set(id, { valence, arousal, at });
    this.record('mood', id, { valence, arousal });
    return accept({ valence, arousal });
  }

  // 当前心情：按半衰期从上次提交衰减回 (0, 0)。从未提交过返回 null。
  currentMood(id: string): { valence: number; arousal: number } | null {
    const m = this.moods.get(id);
    if (!m) return null;
    const factor = Math.pow(0.5, (this.clock() - m.at) / MOOD_HALF_LIFE_MS);
    return { valence: round3(m.valence * factor), arousal: round3(m.arousal * factor) };
  }

  // 所有居民的当前心情，仅供观察页使用（不进入观察包）。
  activeMoods(): { actorId: string; valence: number; arousal: number }[] {
    const out: { actorId: string; valence: number; arousal: number }[] = [];
    for (const actorId of this.moods.keys()) {
      const m = this.currentMood(actorId);
      if (m) out.push({ actorId, ...m });
    }
    return out;
  }

  // 每个在场居民当前露出的表情：实时未过期则用实时，否则用常态（没有则不返回）。
  activeEmotes(): { actorId: string; emoji: string; kind: EmoteKind; expiresAt: number | null }[] {
    const now = this.clock();
    const out: { actorId: string; emoji: string; kind: EmoteKind; expiresAt: number | null }[] = [];
    for (const [actorId, slot] of this.emotes) {
      if (!this.actors.has(actorId)) continue;
      if (slot.live && slot.live.expiresAt > now) {
        out.push({ actorId, emoji: slot.live.emoji, kind: 'live', expiresAt: slot.live.expiresAt });
      } else if (slot.baseline) {
        out.push({ actorId, emoji: slot.baseline, kind: 'baseline', expiresAt: null });
      }
    }
    return out;
  }

  // 观察者能看到的表情：3 格内、不包括自己与店主。与 emote 写入时的 viewers 规则一致。
  visibleEmotes(viewerId: string): { actorId: string; emoji: string; kind: EmoteKind; expiresAt: number | null }[] {
    const me = this.actors.get(viewerId);
    if (!me) return [];
    return this.activeEmotes().filter((e) => {
      if (e.actorId === viewerId || isShopkeeper(e.actorId)) return false;
      const other = this.actors.get(e.actorId);
      return other !== undefined && cellDistance(me.position, other.position) <= EMOTE_RANGE;
    });
  }

  // 店主听到玩家说话时，按固定脚本回复。店主的回复也是一条普通的 speak 事件，重放时自然恢复。
  private shopkeeperAnswer(speakerId: string, text: string, heard: Heard[]): void {
    const shop = this.findShopkeeper();
    if (!shop || !heard.some((h) => h.listenerId === shop.id)) return;
    const reply = shopkeeperReply(text);
    const item: Heard = {
      listenerId: speakerId,
      speakerId: shop.id,
      mode: 'talk',
      clarity: 1,
      distance: 0,
      walls: 0,
      text: reply,
    };
    this.deliver(speakerId, item);
    this.record('speak', shop.id, { mode: 'talk', text: reply, origin: shop.position, range: MODES.talk.maxRange, heard: [{ listenerId: speakerId, clarity: 1 }] });
  }

  snapshot() {
    return {
      bounds: this.grid.bounds,
      solids: this.grid.solidCells(),
      rooms: [...this.rooms],
      owners: [...this.owners].map(([key, actorId]) => {
        const [x, y, z] = key.split(',').map(Number);
        return { x, y, z, actorId };
      }),
      actors: [...this.actors.values()].map((a) => ({ id: a.id, name: a.name, position: a.position, group: a.group })),
      identities: [...this.identities.values()],
      relations: this.relationPairs(),
      away: [...this.away].map(([id, a]) => ({ id, name: a.name, group: a.group, bag: this.bags.get(id)?.toJSON() ?? {} })),
      plots: PLOTS.map((p) => ({
        id: p.id,
        x0: p.x0,
        y0: p.y0,
        size: PLOT_SIZE,
        holder: this.plotOwners.get(p.id) ?? null,
        gate: plotEntrance(p),
      })),
      emotes: this.activeEmotes(),
      moods: this.activeMoods(),
      lastSeq: this.seq,
    };
  }

  // 服务重启时调用：把序号接续到历史日志的末尾，避免与旧事件重复。
  resumeSeq(lastSeq: number): void {
    if (lastSeq > this.seq) this.seq = lastSeq;
  }

  currentSeq(): number {
    return this.seq;
  }

  // 按历史日志重建状态（居民位置、建造的方块与归属）。只改内存，不写新事件。
  restore(history: WorldEvent[]): void {
    for (const e of history) {
      const d = e.data as { position?: Cell; to?: Cell; from?: Cell; target?: Cell; name?: string; group?: string; last?: Cell; seed?: number; yard?: boolean; material?: string; bag?: Record<string, number> | number; buildCells?: string[]; plotId?: string; yardCells?: string[]; heard?: { listenerId: string }[] };
      if (e.type === 'identity') {
        this.applyIdentity(e.actorId, e.data as unknown as IdentityInput, e.time);
      } else if (e.type === 'commitment' || e.type === 'commitment_accept' || e.type === 'fulfillment' || e.type === 'breach') {
        this.applyCommitment(e);
      } else if (e.type === 'speak' && d.heard) {
        // 事件里的 heard 只含实际投递的听者，重放时只需还原计数。
        for (const h of d.heard) {
          this.notePairTalk(e.actorId, h.listenerId, e.time);
          this.bumpTalk(e.actorId, h.listenerId, e);
        }
      } else if ((e.type === 'spawn' || e.type === 'enter') && d.position) {
        const name = d.name ?? e.actorId;
        const group = d.group ?? 'g0';
        this.away.delete(e.actorId);
        this.yards.delete(e.actorId);
        for (const [plotId, holder] of this.plotOwners) if (holder === e.actorId) this.pendingPlots.delete(plotId);
        this.actors.set(e.actorId, { id: e.actorId, name, position: { ...d.position }, lastSpeakAt: -Infinity, group });
        this.bumpGroup(group);
        if (d.bag !== undefined) this.bags.set(e.actorId, bagFrom(d.bag));
        this.meetNew(e.actorId, new Set(), this.seenFrom(e.actorId, d.position), e.time);
        // 出生或返回时位于自留地中心的居民需要恢复自留地归属，否则重启后会被重复分配。
        const plot = plotAt(d.position);
        if ((e.type === 'spawn' || e.type === 'enter') && plot && !isVisitor(e.actorId)) this.plotOwners.set(plot.id, e.actorId);
      } else if (e.type === 'leave') {
        const actor = this.actors.get(e.actorId);
        this.away.set(e.actorId, { name: d.name ?? e.actorId, group: actor?.group ?? 'g0' });
        this.actors.delete(e.actorId);
        this.lastPlotIds.set(e.actorId, d.plotId ?? this.plotIdOf(e.actorId));
        if (isVisitor(e.actorId)) this.releasePlots(e.actorId);
        else this.holdPlots(e.actorId, e.time);
        this.lastBuildCells.set(e.actorId, this.buildCellsOf(e.actorId));
        this.removeBuildings(e.actorId);
        if (d.seed !== undefined) this.yards.set(e.actorId, new Backyard(d.seed));
      } else if (e.type === 'learn_blueprint' && isFurnitureKind(e.data.kind)) {
        // 与运行时一致：先消耗图纸，再记录已学。
        const kind = e.data.kind;
        this.bagOf(e.actorId).take(blueprintItem(kind), 1);
        this.learnedOf(e.actorId).add(kind);
      } else if (e.type === 'craft' && isFurnitureKind(e.data.kind)) {
          const kind = e.data.kind;
        for (const [item, amount] of Object.entries(FURNITURE[kind].cost)) this.bagOf(e.actorId).take(item, amount);
        this.bagOf(e.actorId).add(furnitureItem(kind), 1);
      } else if (e.type === 'claim_blueprint' && isFurnitureKind(e.data.kind)) {
        this.bagOf(e.actorId).add(blueprintItem(e.data.kind), 1);
      } else if (e.type === 'item_grant' && typeof e.data.item === 'string' && typeof e.data.amount === 'number') {
        this.bagOf(e.actorId).add(e.data.item, e.data.amount);
      } else if (e.type === 'item_take' && typeof e.data.item === 'string' && typeof e.data.amount === 'number') {
        this.bagOf(e.actorId).take(e.data.item, e.data.amount);
      } else if (e.type === 'give' && typeof e.data.to === 'string' && typeof e.data.item === 'string' && isGiftItem(e.data.item)) {
        this.bagOf(e.actorId).take(e.data.item, 1);
        this.bagOf(e.data.to).add(e.data.item, 1);
      } else if (e.type === 'emote' && typeof e.data.emoji === 'string') {
        // 重放：常态永久保留；实时只在仍有效时保留（过期的不必恢复）。
        const slot = this.emotes.get(e.actorId) ?? { baseline: null, live: null };
        if (e.data.kind === 'baseline') slot.baseline = e.data.emoji;
        else if (typeof e.data.expiresAt === 'number') slot.live = { emoji: e.data.emoji, expiresAt: e.data.expiresAt };
        this.emotes.set(e.actorId, slot);
      } else if (e.type === 'mood' && isUnitRange(e.data.valence) && isUnitRange(e.data.arousal)) {
        // 重放时保留提交时刻，衰减仍按墙钟计算，与运行时一致。
        this.moods.set(e.actorId, { valence: e.data.valence, arousal: e.data.arousal, at: e.time });
      } else if (e.type === 'plot_release' && d.plotId) {
        this.plotOwners.delete(d.plotId);
        this.pendingPlots.delete(d.plotId);
      } else if (e.type === 'purge') {
        this.dropResident(e.actorId);
      } else if (e.type === 'handoff_in') {
        // 自留地以事件里记录的结果为准，不重新分配。
        if (d.plotId) this.plotOwners.set(d.plotId, e.actorId);
        this.applyHandoff({
          id: e.actorId,
          name: d.name ?? e.actorId,
          seed: d.seed ?? 0,
          bag: d.bag ?? {},
          yardCells: d.yardCells ?? [],
          buildCells: d.buildCells ?? [],
          plotId: d.plotId,
        });
      } else if (d.yard && d.target && (e.type === 'place' || e.type === 'pickup')) {
        this.replayYard(e.actorId, e.type, d.target, d.material);
      } else if (e.type === 'move' && d.to) {
        const actor = this.actors.get(e.actorId);
        const before = d.from ? this.seenFrom(e.actorId, d.from) : new Set<string>();
        if (actor) actor.position = { ...d.to };
        if (actor) this.meetNew(e.actorId, before, this.seenFrom(e.actorId, d.to), e.time);
        // 与运行时一致：空地先到先得，访客不占用，重放时同样恢复归属。
        const plot = plotAt(d.to);
        if (plot && !this.plotOwners.has(plot.id) && !isVisitor(e.actorId)) this.plotOwners.set(plot.id, e.actorId);
      } else if (e.type === 'place' && d.target) {
        // 涓庤繍琛屾椂涓€鑷达細鍏堟墸鏂欏啀鏀剧疆锛涙棤鏉愯川鐨勬棫浜嬩欢璺宠繃銆?
        if (!isPlaceable(d.material)) continue;
        const cost = YIELD[d.material];
        this.bagOf(e.actorId).take(cost.item, cost.amount);
        this.grid.setSolid(d.target);
        this.owners.set(cellKey(d.target), e.actorId);
        this.townMaterials.set(cellKey(d.target), d.material);
      } else if (e.type === 'pickup' && d.target) {
        const gained = this.townMaterials.get(cellKey(d.target));
        this.grid.clearSolid(d.target);
        this.owners.delete(cellKey(d.target));
        this.townMaterials.delete(cellKey(d.target));
        const gain = gained ? YIELD[gained] : undefined;
        if (gain) this.bagOf(e.actorId).add(gain.item, gain.amount);
      }
    }
    this.rooms = labelRooms(this.grid);
  }

  // 重放后院里的建造与拿起：只改后院与背包，不动小镇网格。
  private replayYard(id: string, type: WorldEvent['type'], target: Cell, material?: string): void {
    const yard = this.yards.get(id);
    if (!yard) return;
    if (type === 'place') {
      // 与运行时一致：先扣料再放置。历史事件都带材质，缺失则无法还原，跳过。
      if (!isPlaceable(material)) return;
      const cost = YIELD[material];
      if (!cost) return;
      this.bagOf(id).take(cost.item, cost.amount);
      yard.setSolid(target, material);
      this.yardOwned(id).add(cellKey(target));
    } else {
      // 拆除时的材质以后院当前记录为准（与运行时 pickupInYard 一致）。
      const gained = yard.materialAt(target);
      yard.clearSolid(target);
      this.yardOwned(id).delete(cellKey(target));
      const gain = YIELD[gained];
      if (gain) this.bagOf(id).add(gain.item, gain.amount);
    }
  }

  // 返回序号大于 seq 的事件。事件按序号升序排列，用二分查找定位起点。
  eventsSince(seq: number): WorldEvent[] {
    let lo = 0;
    let hi = this.events.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.events[mid].seq <= seq) lo = mid + 1;
      else hi = mid;
    }
    return this.events.slice(lo);
  }

  // 日志刷盘后调用：丢弃已写入日志的旧事件，只保留最近的 EVENT_LIMIT 条。
  // 未刷盘的事件始终保留，避免日志来不及写入时丢失。
  markFlushed(seq: number): void {
    const excess = this.events.length - EVENT_LIMIT;
    if (excess <= 0) return;
    let drop = 0;
    while (drop < excess && this.events[drop].seq <= seq) drop += 1;
    if (drop > 0) this.events.splice(0, drop);
  }

  // 取走并清空居民听到的内容。
  drainInbox(id: string): Heard[] {
    const items = this.inbox.get(id) ?? [];
    this.inbox.set(id, []);
    return items;
  }

  // 距离 radius 以内的其他居民，按距离升序。
  nearbyActors(id: string, radius: number): { id: string; name: string; position: Cell; distance: number }[] {
    const me = this.actors.get(id);
    if (!me) return [];
    return [...this.actors.values()]
      .filter((a) => a.id !== id)
      .map((a) => ({ id: a.id, name: a.name, position: { ...a.position }, distance: round(cellDistance(me.position, a.position)) }))
      .filter((a) => a.distance <= radius)
      .sort((a, b) => a.distance - b.distance);
  }

  // 读取居民序号大于 since 的对话（只读副本，按时间从旧到新）。
  recentUtterances(id: string, since = 0): Utterance[] {
    return (this.transcripts.get(id) ?? []).filter((u) => u.seq > since).map((u) => ({ ...u }));
  }

  private remember(id: string, u: Omit<Utterance, 'seq'>): void {
    const list = this.transcripts.get(id) ?? [];
    list.push({ ...u, seq: ++this.utteranceSeq });
    if (list.length > TRANSCRIPT_LIMIT) list.splice(0, list.length - TRANSCRIPT_LIMIT);
    this.transcripts.set(id, list);
  }

  private deliver(listenerId: string, item: Heard): void {
    const box = this.inbox.get(listenerId) ?? [];
    box.push(item);
    if (box.length > INBOX_LIMIT) box.splice(0, box.length - INBOX_LIMIT);
    this.inbox.set(listenerId, box);
  }

  roomAt(cell: Cell): number {
    const { sizeX, sizeY } = this.grid.bounds;
    return this.rooms[cell.x + sizeX * (cell.y + sizeY * cell.z)];
  }

  private roomOf(cell: Cell): number {
    return this.roomAt(cell);
  }

  // 每条新事件发生时调用一次，用于推送给观察页。返回取消订阅的函数。
  // 季节或昼夜段变化时由服务端调用，写入日志（只读状态，重放时忽略）。
  recordCalendar(data: { season: string; phase: string; day: number }): void {
    this.record('calendar', 'world', data);
  }

  // 游戏日变化时写入，第三方据此生成当天计划；只含日序号，不替第三方决定做什么。
  recordDayStart(day: number): void {
    this.record('day_start', 'world', { day });
  }

  onEvent(listener: (event: WorldEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // 身份：登录时写入。简介与外观由居民自填，超长截断。
  setIdentity(id: string, input: IdentityInput): Identity | undefined {
    const fields: IdentityInput = {
      name: clip(input.name, 16),
      kind: input.kind,
      source: clip(input.source, SOURCE_MAX),
      appearance: clip(input.appearance, APPEARANCE_MAX),
      bio: clip(input.bio, BIO_MAX),
    };
    const event = this.record('identity', id, { ...fields });
    this.applyIdentity(id, fields, event.time);
    return this.identities.get(id);
  }

  identityOf(id: string): Identity | undefined {
    return this.identities.get(id);
  }

  // 提出承诺：只有承诺方能发起，内容截断。返回新承诺的 id（即事件序号）。
  proposeCommitment(promiser: string, counterparty: string, content: string): Receipt {
    if (promiser === counterparty) return reject('self_commitment');
    if (!this.identities.has(promiser) || !this.identities.has(counterparty)) return reject('identity_required');
    const text = clip(content, COMMITMENT_MAX);
    if (!text) return reject('empty_commitment');
    const event = this.record('commitment', promiser, { promiser, counterparty, content: text });
    this.applyCommitment(event);
    return accept({ commitment_id: event.seq, status: 'pending' });
  }

  // 对方确认承诺：承诺生效。
  acceptCommitment(id: number, by: string): Receipt {
    const c = this.commitments.get(id);
    if (!c) return reject('unknown_commitment');
    if (c.counterparty !== by) return reject('not_counterparty');
    if (c.status !== 'pending') return reject('not_pending');
    const event = this.record('commitment_accept', by, { commitment_id: id });
    this.applyCommitment(event);
    return accept({ commitment_id: id, status: 'active' });
  }

  // 对方上报履约结果：只记录事件，不判断对错。
  reportCommitment(id: number, by: string, outcome: 'fulfilled' | 'breached'): Receipt {
    const c = this.commitments.get(id);
    if (!c) return reject('unknown_commitment');
    if (c.counterparty !== by) return reject('not_counterparty');
    if (c.status !== 'active') return reject('not_active');
    const event = this.record(outcome === 'fulfilled' ? 'fulfillment' : 'breach', by, { commitment_id: id });
    this.applyCommitment(event);
    return accept({ commitment_id: id, status: outcome });
  }

  commitmentsOf(id: string): Commitment[] {
    return [...this.commitments.values()].filter((c) => c.promiser === id || c.counterparty === id);
  }

  // 声誉计数：按对象方统计已确认的承诺与其结果，不合并。
  reputationOf(id: string): ReputationView {
    const mine = [...this.commitments.values()].filter((c) => c.counterparty === id || c.promiser === id);
    return {
      id,
      commitments: mine.filter((c) => c.status !== 'pending').length,
      fulfilled: mine.filter((c) => c.status === 'fulfilled').length,
      breached: mine.filter((c) => c.status === 'breached').length,
    };
  }

  private applyCommitment(e: WorldEvent): void {
    const d = e.data as { promiser?: string; counterparty?: string; content?: string; commitment_id?: number };
    if (e.type === 'commitment' && d.promiser && d.counterparty) {
      this.commitments.set(e.seq, {
        id: e.seq,
        promiser: d.promiser,
        counterparty: d.counterparty,
        content: d.content ?? '',
        status: 'pending',
        created_seq: e.seq,
        last_seq: e.seq,
      });
      return;
    }
    const c = d.commitment_id !== undefined ? this.commitments.get(d.commitment_id) : undefined;
    if (!c) return;
    if (e.type === 'commitment_accept') c.status = 'active';
    else if (e.type === 'fulfillment') c.status = 'fulfilled';
    else if (e.type === 'breach') c.status = 'breached';
    c.last_seq = e.seq;
  }

  private applyIdentity(id: string, fields: IdentityInput, time: number): void {
    const prev = this.identities.get(id);
    this.identities.set(id, { id, ...fields, created_at: prev?.created_at ?? time });
  }

  now(): number {
    return this.clock();
  }

  // x 对 y 的关系（有向）。从未相遇时返回全零。
  relationView(x: string, y: string): RelationView {
    const r = this.relations.get(relationKey(x, y));
    if (!r) return { id: y, meetings: 0, talks: 0, last_day: null, last_seq: null };
    return { id: y, meetings: r.meetings, talks: r.talks, last_day: r.last_day, last_seq: r.last_seq };
  }

  private relationPairs(): (RelationView & { from: string; to: string })[] {
    return [...this.relations.values()].map((r) => ({ from: r.from, to: r.to, ...this.relationView(r.from, r.to) }));
  }

  // 视野内的其他居民（以 pos 为中心，半径 SIGHT_RADIUS）。
  private seenFrom(id: string, pos: Cell): Set<string> {
    const seen = new Set<string>();
    for (const a of this.actors.values()) {
      if (a.id !== id && cellDistance(pos, a.position) <= SIGHT_RADIUS) seen.add(a.id);
    }
    return seen;
  }

  // 新进入视野的居民：双方各自的“相遇”记录都加一次（有向，各算各的）。
  private meetNew(id: string, before: Set<string>, after: Set<string>, time: number, seq = this.seq): void {
    for (const other of after) {
      if (before.has(other)) continue;
      this.bumpMeeting(id, other, time, seq);
      this.bumpMeeting(other, id, time, seq);
    }
  }

  private bumpMeeting(from: string, to: string, time: number, seq: number): void {
    const r = this.touchRelation(from, to, time, seq);
    r.meetings += 1;
  }

  // 同一对居民（无方向）在窗口内的说话次数达到上限则不再投递。时间取自事件时间戳，重放结果一致。
  private pairTalkLimited(a: string, b: string, now: number): boolean {
    const key = pairKey(a, b);
    const times = (this.pairTalks.get(key) ?? []).filter((t) => now - t < PAIR_TALK_WINDOW_MS);
    this.pairTalks.set(key, times);
    return times.length >= PAIR_TALK_LIMIT;
  }

  private notePairTalk(a: string, b: string, time: number): void {
    const key = pairKey(a, b);
    const times = this.pairTalks.get(key) ?? [];
    times.push(time);
    this.pairTalks.set(key, times);
  }

  // 说话：说话者对每个听者的“对话”记录加一次，听者对说话者不自动计数。
  private bumpTalk(from: string, to: string, event: WorldEvent): void {
    const r = this.touchRelation(from, to, event.time, event.seq);
    r.talks += 1;
  }

  private touchRelation(from: string, to: string, time: number, seq: number): Relation {
    const key = relationKey(from, to);
    const r = this.relations.get(key) ?? { from, to, meetings: 0, talks: 0, last_day: 0, last_seq: 0 };
    r.last_day = calendarAt(time).day;
    r.last_seq = seq;
    this.relations.set(key, r);
    return r;
  }

  // 管理员删除居民：清掉其全部状态（在场或离开、后院、自留地、身份、关系、表情、心情等）并记录事件，重放时同样删除。
  // 返回 false 表示该 id 从未出现过。
  // 交易结算用：增减背包物品。不足时拒绝，保证库存不为负。
  grantItem(id: string, item: string, amount: number): Receipt {
    if (!this.actors.has(id) && !this.away.has(id)) return reject('unknown_actor');
    if (!Number.isInteger(amount) || amount <= 0) return reject('bad_amount');
    this.bagOf(id).add(item, amount);
    this.record('item_grant', id, { item, amount });
    return accept({ item, amount, bag: this.bagOf(id).toJSON() });
  }

  takeItem(id: string, item: string, amount: number): Receipt {
    if (!this.actors.has(id) && !this.away.has(id)) return reject('unknown_actor');
    if (!Number.isInteger(amount) || amount <= 0) return reject('bad_amount');
    if (this.bagOf(id).get(item) < amount) return reject('insufficient_material', { item, need: amount });
    this.bagOf(id).take(item, amount);
    this.record('item_take', id, { item, amount });
    return accept({ item, amount, bag: this.bagOf(id).toJSON() });
  }

  purgeResident(id: string): boolean {
    if (!this.knowsResident(id)) return false;
    this.dropResident(id);
    this.record('purge', id, {});
    return true;
  }

  private knowsResident(id: string): boolean {
    return this.actors.has(id) || this.away.has(id) || this.identities.has(id) || this.yards.has(id) || this.bags.has(id);
  }

  // 删除居民的内存状态（不记事件）。小镇里若在场，会先移除建筑与自留地占用。
  private dropResident(id: string): void {
    if (this.actors.has(id)) this.removeBuildings(id);
    this.actors.delete(id);
    this.away.delete(id);
    this.yards.delete(id);
    this.yardOwners.delete(id);
    this.bags.delete(id);
    this.lastBuildCells.delete(id);
    this.lastPlotIds.delete(id);
    this.learned.delete(id);
    this.inbox.delete(id);
    this.transcripts.delete(id);
    this.emotes.delete(id);
    this.moods.delete(id);
    this.commitments.forEach((c, key) => { if (c.promiser === id || c.counterparty === id) this.commitments.delete(key); });
    this.identities.delete(id);
    for (const key of [...this.relations.keys()]) {
      const r = this.relations.get(key);
      if (r && (r.from === id || r.to === id)) this.relations.delete(key);
    }
    for (const key of [...this.pairTalks.keys()]) {
      if (key.split('|').includes(id)) this.pairTalks.delete(key);
    }
    this.releasePlots(id);
  }

  private record(type: WorldEvent['type'], actorId: string, data: Record<string, unknown>): WorldEvent {
    this.seq += 1;
    const event: WorldEvent = { seq: this.seq, time: this.clock(), type, actorId, data };
    this.events.push(event);
    for (const listener of this.listeners) listener(event);
    return event;
  }
}

function relationKey(from: string, to: string): string {
  return `${from}|${to}`;
}

// 无方向的居民对键，A 说给 B 与 B 说给 A 计入同一组。
function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

// 按字符（而非字节）截断，中文不会被切坏。
function clip(s: unknown, max: number): string {
  return typeof s === 'string' ? [...s.trim()].slice(0, max).join('') : '';
}

function accept(state_delta: Record<string, unknown>): Receipt {
  return { accepted: true, reason_code: 'ok', state_delta, cooldown_ms: 0 };
}

function reject(reason_code: string, state_delta: Record<string, unknown> = {}): Receipt {
  return { accepted: false, reason_code, state_delta, cooldown_ms: 0 };
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
