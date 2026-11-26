// 小镇容量与调度：agent 与访客分别计数。
// agent 每镇最多 MAX_PER_TOWN 个，满员后新开小镇；访客每镇最多 MAX_VISITORS_PER_TOWN 个，满员不新开小镇，而是提示换一个实例。
export const MAX_PER_TOWN = Number(process.env.MAX_PER_TOWN ?? 8);
export const MAX_VISITORS_PER_TOWN = Number(process.env.MAX_VISITORS_PER_TOWN ?? 12);

export interface TownSlot {
  id: string;
  port: number;
  agents: number;
  visitors: number;
}

// 从小镇在场居民 id 中分别统计 agent 与访客（visitor- 为访客，npc- 为店主等设施 NPC 不计入，其余为 agent）。
export function countActors(ids: string[]): { agents: number; visitors: number } {
  let visitors = 0;
  let npcs = 0;
  for (const id of ids) {
    if (id.startsWith('visitor-')) visitors++;
    else if (id.startsWith('npc-')) npcs++;
  }
  return { agents: ids.length - visitors - npcs, visitors };
}

// 选第一个 agent 未满的小镇；全部满员返回 undefined（由调用方新开小镇）。
// avoidPort 指定时优先选别的小镇（轮换用），没有别的空位才回落到它。
export function pickTown(towns: TownSlot[], max = MAX_PER_TOWN, avoidPort?: number): TownSlot | undefined {
  const open = towns.filter((t) => t.agents < max);
  return open.find((t) => t.port !== avoidPort) ?? (avoidPort === undefined ? undefined : open[0]);
}

// agent 选镇：rotate=false 时（同一游戏年内重连）优先回原镇，原镇未满即回；
// 原镇满员或 rotate=true（年度轮换）时，选别的未满小镇；没有别的空位才回落到原镇，由调用方决定是否新开。
export function pickAgentTown(towns: TownSlot[], origin: number | undefined, rotate: boolean, max = MAX_PER_TOWN): TownSlot | undefined {
  const open = towns.filter((t) => t.agents < max);
  if (!rotate && origin !== undefined) {
    const home = open.find((t) => t.port === origin);
    if (home) return home;
  }
  return open.find((t) => t.port !== origin) ?? (origin === undefined || rotate ? undefined : open[0]);
}

// 选第一个访客未满的小镇；全部满员返回 undefined（访客不新开小镇）。
export function pickVisitorTown(towns: TownSlot[], max = MAX_VISITORS_PER_TOWN): TownSlot | undefined {
  return towns.find((t) => t.visitors < max);
}