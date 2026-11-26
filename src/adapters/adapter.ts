import type { Cell } from '../core/voxel.ts';
import type { World, Receipt } from '../core/world.ts';
import type { SpeakMode } from '../core/hearing.ts';

// 适配器（Adapter）：把外部输入翻译成对 World 的意图调用。
// 世界只认这里的 Intent，不认任何外部协议细节。
// 第一版暂不挂载任何真实 Agent，适配器只作为接口存在。
export type Intent =
  | { kind: 'move'; actorId: string; target: Cell }
  | { kind: 'speak'; actorId: string; mode: SpeakMode; text: string }
  | { kind: 'place'; actorId: string; target: Cell; material?: string }
  | { kind: 'pickup'; actorId: string; target: Cell }
  | { kind: 'leave'; actorId: string; destination: string }
  | { kind: 'enter'; actorId: string; from: string }
  | { kind: 'learn_blueprint'; actorId: string; furniture: string }
  | { kind: 'craft'; actorId: string; furniture: string }
  | { kind: 'give'; actorId: string; to: string; item: string }
  | { kind: 'claim_blueprint'; actorId: string; furniture: string }
  | { kind: 'emote'; actorId: string; emoji: string; emoteKind?: 'live' | 'baseline' }
  | { kind: 'mood'; actorId: string; valence: number; arousal: number };

export function applyIntent(world: World, intent: Intent): Receipt {
  if (intent.kind === 'move') return world.move(intent.actorId, intent.target);
  // 离开只能从自己自留地的后院入口走出去（掉线路径直接调用 world.leave，不经过这里）。
  if (intent.kind === 'leave') {
    const check = world.canLeaveFrom(intent.actorId);
    if (!check.accepted) return check;
    return world.leave(intent.actorId, intent.destination);
  }
  if (intent.kind === 'enter') return world.enter(intent.actorId, intent.from);
  if (intent.kind === 'place') return world.place(intent.actorId, intent.target, intent.material);
  if (intent.kind === 'pickup') return world.pickup(intent.actorId, intent.target);
  if (intent.kind === 'learn_blueprint') return world.learnBlueprint(intent.actorId, intent.furniture);
  if (intent.kind === 'craft') return world.craft(intent.actorId, intent.furniture);
  if (intent.kind === 'give') return world.give(intent.actorId, intent.to, intent.item);
  if (intent.kind === 'claim_blueprint') return world.claimBlueprint(intent.actorId, intent.furniture);
  if (intent.kind === 'emote') return world.emote(intent.actorId, intent.emoji, intent.emoteKind ?? 'live');
  if (intent.kind === 'mood') return world.mood(intent.actorId, intent.valence, intent.arousal);
  return world.speak(intent.actorId, intent.mode, intent.text);
}
