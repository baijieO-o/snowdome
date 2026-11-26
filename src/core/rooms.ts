import type { VoxelGrid } from './voxel.ts';

export const SOLID_ROOM = -1;

// 用洪水填充（广度优先）给每个空气格子标房间编号。
// 只沿上下左右前后 6 个方向相连；实心方块编号为 -1。
// 返回的数组下标为 x + sizeX * (y + sizeY * z)。
export function labelRooms(grid: VoxelGrid): Int32Array {
  const { sizeX, sizeY, sizeZ } = grid.bounds;
  const labels = new Int32Array(sizeX * sizeY * sizeZ).fill(SOLID_ROOM);
  const index = (x: number, y: number, z: number) => x + sizeX * (y + sizeY * z);
  const dirs = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  let next = 0;

  for (let z = 0; z < sizeZ; z++) {
    for (let y = 0; y < sizeY; y++) {
      for (let x = 0; x < sizeX; x++) {
        if (labels[index(x, y, z)] !== SOLID_ROOM || grid.isSolid({ x, y, z })) continue;
        const id = next++;
        const queue = [[x, y, z]];
        labels[index(x, y, z)] = id;
        while (queue.length) {
          const [cx, cy, cz] = queue.pop()!;
          for (const [dx, dy, dz] of dirs) {
            const nx = cx + dx;
            const ny = cy + dy;
            const nz = cz + dz;
            if (nx < 0 || ny < 0 || nz < 0 || nx >= sizeX || ny >= sizeY || nz >= sizeZ) continue;
            const i = index(nx, ny, nz);
            if (labels[i] !== SOLID_ROOM || grid.isSolid({ x: nx, y: ny, z: nz })) continue;
            labels[i] = id;
            queue.push([nx, ny, nz]);
          }
        }
      }
    }
  }
  return labels;
}
