import type { Cell } from '../core/voxel.ts';
import { SIGHT_RADIUS, type Identity, type RelationView, type World, type WorldEvent } from '../core/world.ts';
import { calendarAt, type CalendarState } from '../core/calendar.ts';

// 观察包：服务端按 tick 推给 Agent 的感知内容。只读，由世界状态组装而成。

export interface Observation {
  tick: number;
  time: number;
  // 当前季节与昼夜段（由时间推导，见 core/calendar.ts）。
  calendar: CalendarState;
  // 第三方常用的扁平时间字段：第几天（从 0 开始）、季节、当日进度（0 为午夜）、昼夜段。
  day_index: number;
  season: CalendarState['season'];
  day_fraction: number;
  phase: CalendarState['phase'];
  self: { id: string; position: Cell; room: number; group: string; identity: Identity | null };
  // 附近居民，附带其身份（简介与外观由其自填）与我与对方的关系。
  nearby: { id: string; name: string; position: Cell; distance: number; identity: Identity | null; relation: RelationView }[];
  heard: { speakerId: string; mode: string; clarity: number; distance: number; walls: number; text: string }[];
  // 3 格内附近居民当前露出的表情（不含自己）。kind=live 为实时（有 expiresAt），baseline 为常态（expiresAt 为 null）。
  emotes: { actorId: string; emoji: string; kind: 'live' | 'baseline'; expiresAt: number | null }[];
}

// 组装观察包；取走收件箱，所以同一条听闻只会送达一次。
export function buildObservation(world: World, actorId: string, tick: number): Observation | null {
  const me = world.getActor(actorId);
  if (!me) return null;
  const calendar = calendarAt(world.now());
  return {
    tick,
    time: world.now(),
    calendar,
    day_index: calendar.day,
    season: calendar.season,
    day_fraction: calendar.dayFraction,
    phase: calendar.phase,
    self: { id: me.id, position: { ...me.position }, room: world.roomAt(me.position), group: me.group, identity: world.identityOf(me.id) ?? null },
    nearby: world.nearbyActors(actorId, SIGHT_RADIUS).map((n) => ({
      ...n,
      identity: world.identityOf(n.id) ?? null,
      relation: world.relationView(actorId, n.id),
    })),
    emotes: world.visibleEmotes(actorId),
    heard: world.drainInbox(actorId).map((h) => ({
      speakerId: h.speakerId,
      mode: h.mode,
      clarity: h.clarity,
      distance: h.distance,
      walls: h.walls,
      text: h.text,
    })),
  };
}

// 第三方原始历史：只挑出与该居民相关的原始事件（自己的动作、别人说话时它在听者名单里、世界级事件），不做摘要。
// 返回最近 limit 条，按时间从旧到新。
// 来源只按服务端能确定的事实标注：self（本人动作）、heard（本人在听到名单里）、world（世界级事件）。
// 服务端不记录谁“目睹”了移动，因此不伪造 witnessed，见汇编 6.4。
export type HistorySource = 'self' | 'heard' | 'world';

export function historySource(e: WorldEvent, actorId: string): HistorySource | undefined {
  if (e.actorId === actorId) return 'self';
  if (e.actorId === 'world') return 'world';
  const heard = (e.data as { heard?: { listenerId: string }[] }).heard;
  if (e.type === 'speak' && Array.isArray(heard) && heard.some((h) => h.listenerId === actorId)) return 'heard';
  return undefined;
}

// 居民在后院时（不在小镇中）不返回小镇历史，后院是私人空间。
export function agentHistory(events: WorldEvent[], actorId: string, limit: number, inTown = true): (WorldEvent & { source: HistorySource })[] {
  if (!inTown) return [];
  const own = events.flatMap((e) => {
    const source = historySource(e, actorId);
    return source ? [{ ...e, source }] : [];
  });
  return own.slice(-limit);
}