/**
 * Uniform spatial hash over the arena. Rebuilt every tick.
 *
 * Iteration order is insertion order within a cell and row-major across cells,
 * so every query resolves ties identically on every run — required for the
 * determinism guarantee (nearest-enemy targeting must never depend on hash order).
 */
export interface SpatialItem {
  x: number;
  y: number;
  alive: boolean;
}

export class SpatialGrid<T extends SpatialItem> {
  private readonly cellSize: number;
  private readonly cols: number;
  private readonly rows: number;
  private readonly cells: T[][];

  constructor(width: number, height: number, cellSize = 90) {
    this.cellSize = cellSize;
    this.cols = Math.ceil(width / cellSize) + 2;
    this.rows = Math.ceil(height / cellSize) + 2;
    this.cells = Array.from({ length: this.cols * this.rows }, () => []);
  }

  clear(): void {
    for (const cell of this.cells) cell.length = 0;
  }

  private indexOf(x: number, y: number): number {
    const cx = Math.min(this.cols - 1, Math.max(0, Math.floor(x / this.cellSize) + 1));
    const cy = Math.min(this.rows - 1, Math.max(0, Math.floor(y / this.cellSize) + 1));
    return cy * this.cols + cx;
  }

  insert(item: T): void {
    this.cells[this.indexOf(item.x, item.y)]!.push(item);
  }

  rebuild(items: readonly T[]): void {
    this.clear();
    for (const item of items) if (item.alive) this.insert(item);
  }

  /** Visit every item within `radius` of (x, y). Callback may kill items. */
  queryRadius(x: number, y: number, radius: number, visit: (item: T) => void): void {
    const r = Math.ceil(radius / this.cellSize);
    const cx = Math.floor(x / this.cellSize) + 1;
    const cy = Math.floor(y / this.cellSize) + 1;
    const r2 = radius * radius;
    for (let gy = cy - r; gy <= cy + r; gy++) {
      if (gy < 0 || gy >= this.rows) continue;
      for (let gx = cx - r; gx <= cx + r; gx++) {
        if (gx < 0 || gx >= this.cols) continue;
        const cell = this.cells[gy * this.cols + gx]!;
        for (let i = 0; i < cell.length; i++) {
          const item = cell[i]!;
          if (!item.alive) continue;
          const dx = item.x - x;
          const dy = item.y - y;
          if (dx * dx + dy * dy <= r2) visit(item);
        }
      }
    }
  }

  /**
   * Nearest live item to (x, y), searching outward in rings so we can stop early.
   * Ties break on insertion order, which is stable across runs.
   */
  nearest(x: number, y: number, maxRadius = Infinity, exclude?: (item: T) => boolean): T | null {
    const cx = Math.floor(x / this.cellSize) + 1;
    const cy = Math.floor(y / this.cellSize) + 1;
    const maxRing = Number.isFinite(maxRadius)
      ? Math.ceil(maxRadius / this.cellSize)
      : Math.max(this.cols, this.rows);

    let best: T | null = null;
    let bestD2 = Number.isFinite(maxRadius) ? maxRadius * maxRadius : Infinity;

    for (let ring = 0; ring <= maxRing; ring++) {
      // Once we have a hit, one extra ring guarantees correctness.
      if (best && ring > Math.ceil(Math.sqrt(bestD2) / this.cellSize) + 1) break;
      let touched = false;
      for (let gy = cy - ring; gy <= cy + ring; gy++) {
        if (gy < 0 || gy >= this.rows) continue;
        for (let gx = cx - ring; gx <= cx + ring; gx++) {
          if (gx < 0 || gx >= this.cols) continue;
          // Only the ring boundary is new.
          if (ring > 0 && Math.abs(gy - cy) !== ring && Math.abs(gx - cx) !== ring) continue;
          touched = true;
          const cell = this.cells[gy * this.cols + gx]!;
          for (let i = 0; i < cell.length; i++) {
            const item = cell[i]!;
            if (!item.alive) continue;
            if (exclude?.(item)) continue;
            const dx = item.x - x;
            const dy = item.y - y;
            const d2 = dx * dx + dy * dy;
            if (d2 < bestD2) {
              bestD2 = d2;
              best = item;
            }
          }
        }
      }
      if (!touched && ring > Math.max(this.cols, this.rows)) break;
    }
    return best;
  }
}
