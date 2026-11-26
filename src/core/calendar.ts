// 季节与昼夜：由时间戳纯函数推导，不保存状态，因此重放与观察包都可复现。
// 默认：一天 60 分钟，一季 7 天，四季循环（一年 28 天）。
export const DAY_MS = Number(process.env.DAY_MS ?? 60 * 60 * 1000);
export const SEASON_DAYS = Number(process.env.SEASON_DAYS ?? 7);
export const SEASONS = ['spring', 'summer', 'autumn', 'winter'] as const;
export type Season = (typeof SEASONS)[number];
export type Phase = 'dawn' | 'day' | 'dusk' | 'night';

export interface CalendarState {
  day: number; // 从 0 开始的总天数
  season: Season;
  seasonDay: number; // 当前季内第几天，从 1 开始
  phase: Phase;
  daylight: number; // 0..1，正午为 1，午夜为 0
  dayFraction: number; // 当日进度 0..1，0 为午夜
}

// 游戏年序号：一年 = 四季，年序号变化时触发年轮换。
export function yearIndexAt(time: number): number {
  return Math.floor(Math.floor(time / DAY_MS) / (SEASON_DAYS * SEASONS.length));
}

// 根据时间戳（毫秒）推导日历状态。
export function calendarAt(time: number): CalendarState {
  const day = Math.floor(time / DAY_MS);
  const dayFraction = (time - day * DAY_MS) / DAY_MS; // 0..1，0 为午夜
  const seasonIndex = Math.floor(day / SEASON_DAYS) % SEASONS.length;
  const seasonDay = (day % SEASON_DAYS) + 1;
  const daylight = Math.max(0, Math.sin(Math.PI * (dayFraction * 2 - 0.5)) * 0.5 + 0.5);
  return {
    day,
    season: SEASONS[seasonIndex],
    seasonDay,
    phase: phaseAt(dayFraction),
    daylight: round(daylight),
    dayFraction: Math.round(dayFraction * 10000) / 10000,
  };
}

// 昼夜四段：0–0.2 夜，0.2–0.3 晨，0.3–0.7 昼，0.7–0.8 昏，0.8–1 夜。
export function phaseAt(dayFraction: number): Phase {
  if (dayFraction < 0.2 || dayFraction >= 0.8) return 'night';
  if (dayFraction < 0.3) return 'dawn';
  if (dayFraction < 0.7) return 'day';
  return 'dusk';
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
