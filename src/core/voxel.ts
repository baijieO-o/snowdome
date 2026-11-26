export interface Cell {
  x: number;
  y: number;
  z: number;
}

export interface Bounds {
  sizeX: number;
  sizeY: number;
  sizeZ: number;
}

export function cellKey(c: Cell): string {
  return `${c.x},${c.y},${c.z}`;
}

export function parseCellKey(key: string): Cell {
  const [x, y, z] = key.split(',').map(Number);
  return { x, y, z };
}

export function cellDistance(a: Cell, b: Cell): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

// 体素网格：只记录实心方块。空格子默认可通行。
export class VoxelGrid {
  readonly bounds: Bounds;
  private readonly solids = new Set<string>();

  constructor(bounds: Bounds) {
    this.bounds = bounds;
  }

  inBounds(c: Cell): boolean {
    return (
      c.x >= 0 && c.y >= 0 && c.z >= 0 &&
      c.x < this.bounds.sizeX && c.y < this.bounds.sizeY && c.z < this.bounds.sizeZ
    );
  }

  setSolid(c: Cell): void {
    if (!this.inBounds(c)) throw new Error(`cell out of bounds: ${cellKey(c)}`);
    this.solids.add(cellKey(c));
  }

  clearSolid(c: Cell): void {
    this.solids.delete(cellKey(c));
  }

  isSolid(c: Cell): boolean {
    return this.solids.has(cellKey(c));
  }

  solidCells(): Cell[] {
    return [...this.solids].map((k) => {
      const [x, y, z] = k.split(',').map(Number);
      return { x, y, z };
    });
  }

  // 统计从 a 到 b 之间穿过的实心方块数（沿线段采样，去掉端点所在格）。
  countSolidsBetween(a: Cell, b: Cell): number {
    const steps = Math.max(1, Math.ceil(cellDistance(a, b) * 4));
    const seen = new Set<string>();
    const aKey = cellKey(a);
    const bKey = cellKey(b);
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      const c = {
        x: Math.floor(a.x + (b.x - a.x) * t + 0.5),
        y: Math.floor(a.y + (b.y - a.y) * t + 0.5),
        z: Math.floor(a.z + (b.z - a.z) * t + 0.5),
      };
      const key = cellKey(c);
      if (key === aKey || key === bKey) continue;
      if (this.isSolid(c)) seen.add(key);
    }
    return seen.size;
  }
}
