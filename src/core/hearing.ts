import { cellDistance, type Cell } from './voxel.ts';

export type SpeakMode = 'whisper' | 'talk' | 'shout';

export interface ModeSpec {
  // 超过 maxRange 完全听不见
  maxRange: number;
  // 不超过 fullRange 时清晰度为 1
  fullRange: number;
}

// 距离单位：1 格 = 1 米。数值为用户确认的取值（2026-11 策划确认）。
export const MODES: Record<SpeakMode, ModeSpec> = {
  whisper: { maxRange: 2, fullRange: 2 },
  talk: { maxRange: 6, fullRange: 5 },
  shout: { maxRange: 24, fullRange: 10 },
};

export const FULL_TEXT_THRESHOLD = 0.8;
export const HEAR_THRESHOLD = 0.05;
// 每穿过一个实心方块，清晰度乘以该系数
export const WALL_FACTOR = 0.5;

export function distanceClarity(distance: number, mode: SpeakMode): number {
  const spec = MODES[mode];
  if (distance > spec.maxRange) return 0;
  if (distance <= spec.fullRange) return 1;
  return (spec.maxRange - distance) / (spec.maxRange - spec.fullRange);
}

export function computeClarity(distance: number, wallCount: number, mode: SpeakMode): number {
  return distanceClarity(distance, mode) * Math.pow(WALL_FACTOR, wallCount);
}

// 清晰度不够时，每个字按保留比例随机决定是否替换为省略号。
// rng 可注入，便于测试；默认 Math.random。
export function degradeText(text: string, clarity: number, rng: () => number = Math.random): string {
  if (clarity >= FULL_TEXT_THRESHOLD) return text;
  const keepRatio = Math.max(0, clarity / FULL_TEXT_THRESHOLD);
  return [...text]
    .map((ch) => {
      if (ch === ' ') return ch;
      return rng() < keepRatio ? ch : '…';
    })
    .join('');
}

export interface HearingResult {
  heard: boolean;
  clarity: number;
  distance: number;
  walls: number;
}

export function hear(
  speaker: Cell,
  listener: Cell,
  mode: SpeakMode,
  wallsBetween: (a: Cell, b: Cell) => number,
): HearingResult {
  const distance = cellDistance(speaker, listener);
  const walls = wallsBetween(speaker, listener);
  const clarity = computeClarity(distance, walls, mode);
  return { heard: clarity >= HEAR_THRESHOLD, clarity, distance, walls };
}
