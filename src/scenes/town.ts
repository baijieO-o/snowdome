import { World } from '../core/world.ts';
import { VoxelGrid, type Cell } from '../core/voxel.ts';

// 中心小镇：十字街道 + 8 个房间。
// 小镇本体在网格 x 11..58、y 11..30（原 0..47、0..19 整体平移 OFFSET），z 0..3（z=0 是地面层，墙高 4 层）。
// 街道和中央广场的相对位置不变，房间用墙围住，墙上开门洞通向街道；房间之间不互通。
// 小镇外圈环绕 8 块 10×10 的自留地，居民可在自留地里自由建造；每块东南角一格是后院入口。
const OFFSET = 11;
// 网格需要容纳外圈的八块自留地：东到 x=69，南到 y=41。
export const TOWN_SIZE = { sizeX: 70, sizeY: 42, sizeZ: 4 };
export const TOWN_ENTRANCE: Cell = { x: 23 + OFFSET, y: 9 + OFFSET, z: 0 };
// 小镇所在的矩形（含墙），建造与拆除在这里一律禁止。
export const TOWN_RECT = { x0: OFFSET, y0: OFFSET, x1: 47 + OFFSET, y1: 19 + OFFSET };
// 店铺房间（南左 2）：店主站在这里售卖图纸。范围为房间内部，不含墙与门。
export const SHOP_ROOM = { x0: 8 + OFFSET, y0: 13 + OFFSET, x1: 14 + OFFSET, y1: 18 + OFFSET };
export const SHOP_COUNTER: Cell = { x: 11 + OFFSET, y: 16 + OFFSET, z: 0 };

export const PLOT_SIZE = 10;
export interface Plot { id: string; x0: number; y0: number }
// 八个方位的自留地左上角坐标（网格坐标）；小镇矩形 x 11..58、y 11..30 之外，与小镇之间留 1 格空地。
export const PLOTS: Plot[] = [
  { id: 'nw', x0: 0, y0: 0 },
  { id: 'n', x0: 24, y0: 0 },
  { id: 'ne', x0: 60, y0: 0 },
  { id: 'w', x0: 0, y0: 16 },
  { id: 'e', x0: 60, y0: 16 },
  { id: 'sw', x0: 0, y0: 32 },
  { id: 's', x0: 24, y0: 32 },
  { id: 'se', x0: 60, y0: 32 },
];
// 后院入口：每块自留地东南角的那一格。
export function plotEntrance(plot: Plot): Cell {
  return { x: plot.x0 + PLOT_SIZE - 1, y: plot.y0 + PLOT_SIZE - 1, z: 0 };
}

const WALL_HEIGHT = 4;

// 在 z=0..WALL_HEIGHT-1 之间画一段墙（沿 x 或 y 方向的闭区间）。
// 下面的墙、门坐标都是小镇本地坐标，这里统一加上 OFFSET。
function wall(grid: VoxelGrid, x0: number, y0: number, x1: number, y1: number): void {
  for (let x = x0; x <= x1; x++) {
    for (let y = y0; y <= y1; y++) {
      for (let z = 0; z < WALL_HEIGHT; z++) grid.setSolid({ x: x + OFFSET, y: y + OFFSET, z });
    }
  }
}

// 清掉一段门洞（两格高，与墙同方向）。
function door(grid: VoxelGrid, x0: number, y0: number, x1: number, y1: number): void {
  for (let x = x0; x <= x1; x++) {
    for (let y = y0; y <= y1; y++) {
      for (let z = 0; z < 2; z++) grid.clearSolid({ x: x + OFFSET, y: y + OFFSET, z });
    }
  }
}

export function buildTown(clock: () => number = Date.now, random: () => number = Math.random): World {
  const grid = new VoxelGrid(TOWN_SIZE);

  // 外墙
  wall(grid, 0, 0, 47, 0);
  wall(grid, 0, 19, 47, 19);
  wall(grid, 0, 0, 0, 19);
  wall(grid, 47, 0, 47, 19);

  // 横墙：北排房间与街道之间 y=7，南排房间与街道之间 y=12。
  wall(grid, 1, 7, 14, 7);
  wall(grid, 33, 7, 46, 7);
  wall(grid, 1, 12, 14, 12);
  wall(grid, 33, 12, 46, 12);
  // 中央广场两侧的竖墙（广场 x 15..32 中间开放）。
  wall(grid, 15, 1, 15, 6);
  wall(grid, 32, 1, 32, 6);
  wall(grid, 15, 13, 15, 18);
  wall(grid, 32, 13, 32, 18);
  // 北排、南排之间的竖墙，把房间分开（x=15、32 已在上面）。
  wall(grid, 7, 1, 7, 6);
  wall(grid, 24, 1, 24, 6);
  wall(grid, 40, 1, 40, 6);
  wall(grid, 7, 13, 7, 18);
  wall(grid, 24, 13, 24, 18);
  wall(grid, 40, 13, 40, 18);

  // 门洞：每个房间朝街道开一扇门。
  door(grid, 4, 7, 5, 7);     // 北左 1
  door(grid, 10, 7, 11, 7);   // 北左 2
  door(grid, 36, 7, 37, 7);   // 北右 1
  door(grid, 43, 7, 44, 7);   // 北右 2
  door(grid, 4, 12, 5, 12);   // 南左 1
  door(grid, 10, 12, 11, 12); // 南左 2（店铺，见 SHOP）
  door(grid, 36, 12, 37, 12); // 南右 1
  door(grid, 43, 12, 44, 12); // 南右 2

  // 中央广场的竖墙门洞：让广场与两侧街道相通。
  door(grid, 15, 9, 15, 10);
  door(grid, 32, 9, 32, 10);

  // 四个对外出口：外墙正中各开一扇门，分别通向北、南、西、东。
  door(grid, 23, 0, 24, 0);   // 北
  door(grid, 23, 19, 24, 19); // 南
  door(grid, 0, 9, 0, 10);    // 西
  door(grid, 47, 9, 47, 10);  // 东

  // 清出两个出生点（广场中央），避免开局卡在墙里。
  for (const c of [TOWN_ENTRANCE, { x: 20 + OFFSET, y: 9 + OFFSET, z: 0 }]) grid.clearSolid(c);

  return new World(grid, clock, random, TOWN_ENTRANCE);
}
