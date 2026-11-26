// 家具、图纸与配方的固定规则。服务端只认这里的表，不接受外部提交的配方数值。
// 设计与成品分离：图纸是游戏内物品，学会后才能按配方制作成品家具。

export const FURNITURE = {
  chair: { cost: { wood: 2, fiber: 1 } },
  table: { cost: { wood: 4 } },
  bed: { cost: { wood: 4, fiber: 2 } },
  stone_wall: { cost: { stone: 3 } },
  flowerpot: { cost: { dirt: 1, fiber: 1 } },
} as const satisfies Record<string, { cost: Record<string, number> }>;

export type FurnitureKind = keyof typeof FURNITURE;

// 基础家具：人人可做，不需要图纸。其余家具必须先学会对应图纸。
export const BASIC_FURNITURE: ReadonlySet<FurnitureKind> = new Set<FurnitureKind>(['chair', 'stone_wall', 'flowerpot']);

// 图纸物品名与家具的对应关系。图纸只为需要它的家具存在。
export function blueprintItem(kind: FurnitureKind): string {
  return `blueprint:${kind}`;
}

export function isFurnitureKind(value: unknown): value is FurnitureKind {
  return typeof value === 'string' && Object.hasOwn(FURNITURE, value);
}

// 成品家具在背包里的物品名。
export function furnitureItem(kind: FurnitureKind): string {
  return `furniture:${kind}`;
}

// 可赠送的物品：图纸或成品家具。其它背包材料不能赠送。
export function isGiftItem(item: string): boolean {
  const [prefix, kind] = item.split(':', 2);
  if (prefix !== 'blueprint' && prefix !== 'furniture') return false;
  return isFurnitureKind(kind);
}

// 能否制作：基础家具直接可做，其余需要学过图纸（学习后仍保留配方记录）。
export function canCraft(kind: FurnitureKind, learned: ReadonlySet<FurnitureKind>): boolean {
  return BASIC_FURNITURE.has(kind) || learned.has(kind);
}
