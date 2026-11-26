import { randomInt } from 'node:crypto';
import { cellKey, type Cell } from './voxel.ts';

// 后院：每个 Agent 的本地无限沙盒。地形完全由种子决定，同一种子在任何坐标都得到相同结果。
// 地表高度在 BASE_HEIGHT 到 BASE_HEIGHT + HEIGHT_RANGE 之间起伏，低于高度的格子为实心。

const BASE_HEIGHT = 4;
const HEIGHT_RANGE = 8;
const LARGE_CELL = 8;
const SMALL_CELL = 3;
const DIRT_DEPTH = 3;

// 木块、纤维块是玩家放下的材质，不出现在地形里。
export type Material = 'air' | 'grass' | 'dirt' | 'stone' | 'wood' | 'fiber';

// 拆除方块产出的材料（种类与数量）。草的产出是纤维。放置时扣除同等数量。
// 纤维块的产出与草相同（它本身就是纤维），因此放置纤维块扣 2 纤维。
export const YIELD: Partial<Record<Material, { item: string; amount: number }>> = {
  wood: { item: 'wood', amount: 4 },
  grass: { item: 'fiber', amount: 2 },
  fiber: { item: 'fiber', amount: 2 },
  stone: { item: 'stone', amount: 2 },
  dirt: { item: 'dirt', amount: 2 },
};

// 创号时生成的 32 位种子。
export function newSeed(): number {
  return randomInt(0, 2 ** 32);
}

// 整数坐标 + 种子 -> [0, 1) 的伪随机数。
function hash2(seed: number, x: number, y: number): number {
  let h = seed ^ Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

// 二维值噪声：在格点之间平滑插值，格点取值由种子决定。
function valueNoise(seed: number, x: number, y: number, cell: number): number {
  const gx = Math.floor(x / cell);
  const gy = Math.floor(y / cell);
  const fx = (x - gx * cell) / cell;
  const fy = (y - gy * cell) / cell;
  const u = fx * fx * (3 - 2 * fx);
  const v = fy * fy * (3 - 2 * fy);
  const a = hash2(seed, gx, gy);
  const b = hash2(seed, gx + 1, gy);
  const c = hash2(seed, gx, gy + 1);
  const d = hash2(seed, gx + 1, gy + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

export class Backyard {
  readonly seed: number;
  // 玩家在后院里的改动，覆盖地形。键为格子坐标，值为该格是否实心。
  private readonly edits = new Map<string, boolean>();

  constructor(seed: number) {
    this.seed = seed >>> 0;
  }

  // 地表高度：该列地表方块的 z 值；z 小于它的都是地下，等于它的那层是草地，之上为空气。
  heightAt(x: number, y: number): number {
    const broad = valueNoise(this.seed, x, y, LARGE_CELL);
    const fine = valueNoise(this.seed ^ 0x9e3779b9, x, y, SMALL_CELL);
    return BASE_HEIGHT + Math.round((broad * 0.7 + fine * 0.3) * HEIGHT_RANGE);
  }

  // 地形材质（不含玩家改动）。地表那层为草地，之下 DIRT_DEPTH 层为泥土，更深为岩石。
  terrainAt(c: Cell): Material {
    const top = this.heightAt(c.x, c.y);
    if (c.z >= top) return 'air';
    if (c.z === top - 1) return 'grass';
    if (c.z >= top - 1 - DIRT_DEPTH) return 'dirt';
    return 'stone';
  }

  // 最终材质：玩家改动优先。放下的方块带材质；没有改动时为地形材质。
  materialAt(c: Cell): Material {
    const edited = this.edits.get(cellKey(c));
    if (edited === undefined) return this.terrainAt(c);
    return edited;
  }

  isSolid(c: Cell): boolean {
    return this.materialAt(c) !== 'air';
  }

  // 放下材质为 material 的方块（必须指定，不能是 air）。
  setSolid(c: Cell, material: Material): void {
    if (material === 'air') throw new Error('setSolid 不能放置空气');
    this.edits.set(cellKey(c), material);
  }

  clearSolid(c: Cell): void {
    this.edits.set(cellKey(c), 'air');
  }
}
