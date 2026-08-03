/**
 * Navigation flow field.
 *
 * Enemies need to get around the arena's structure ruins (§22). Per-enemy A* is
 * the wrong tool here: at several hundred simultaneous seekers all heading for
 * the same target, one shared field is both cheaper and better-behaved. We run a
 * single Dijkstra outward from the player over a coarse grid, store a direction
 * per cell, and let every enemy sample it.
 *
 * Deterministic: a pure function of the player's position and the static ruins,
 * recomputed on a fixed tick cadence. No wall-clock, no randomness.
 *
 * **Windowed.** The Dijkstra runs over a box around the player, not the whole
 * arena, because the arena is about to get much bigger. Measured on a full-arena
 * rebuild at 60-unit cells, five times a second:
 *
 *     4200x2400   6 screens    1.0ms
 *     8000x4500  21 screens    3.4ms
 *    12000x7000  49 screens    8.2ms   — a visible hitch at 144Hz
 *    16000x9000  83 screens   15.0ms
 *
 * The window makes that constant. Enemies outside it get a zero vector and fall
 * back to a direct seek, which is correct: they are far off screen, and the
 * only thing pathing buys is going *around* structure the player can see.
 */
import type { ArenaDef } from './types';
import { hypot } from './num';

// Written out rather than Math.SQRT2: the spec calls that value
// implementation-approximated too, and this file is inside the determinism
// boundary. See num.ts.
const SQRT2 = 1.4142135623730951;

/** 8-neighbour offsets with their step costs. */
const NEIGHBOURS: readonly [number, number, number][] = [
  [1, 0, 1],
  [-1, 0, 1],
  [0, 1, 1],
  [0, -1, 1],
  [1, 1, SQRT2],
  [1, -1, SQRT2],
  [-1, 1, SQRT2],
  [-1, -1, SQRT2],
];

export class FlowField {
  readonly cols: number;
  readonly rows: number;
  readonly cellSize: number;

  private readonly blocked: Uint8Array;
  private readonly dist: Float64Array;
  /** Unit direction per cell, interleaved [x0, y0, x1, y1, ...]. */
  private readonly flow: Float32Array;
  private readonly heap: number[] = [];
  private readonly heapKey: number[] = [];

  private lastTargetCell = -1;

  /** Cell bounds of the window built by the last update. */
  private winX0 = 0;
  private winY0 = 0;
  private winX1 = -1;
  private winY1 = -1;

  constructor(
    private readonly arena: ArenaDef,
    cellSize = 60,
    /** Ruins are inflated by roughly an enemy radius so paths clear the corners. */
    private readonly clearance = 16,
    /**
     * Half-width of the window, in cells. 28 cells at 60 units is 1680 either
     * side of the player; the far corner of a 1920x900 view is 1060 away, so
     * everything on screen — and half a screen past it — steers on a live field,
     * and nothing else needs to.
     */
    private readonly windowCells = 28,
  ) {
    this.cellSize = cellSize;
    this.cols = Math.ceil(arena.width / cellSize);
    this.rows = Math.ceil(arena.height / cellSize);
    const count = this.cols * this.rows;

    this.blocked = new Uint8Array(count);
    this.dist = new Float64Array(count);
    this.flow = new Float32Array(count * 2);

    this.rebuild(arena.ruins);
  }

  /**
   * Re-bake the blocked cells from a list of ruins.
   *
   * Called once at construction, and again whenever a §21b.5 barrier comes down
   * — a gate opening is a ruin being removed, and the field has to hear about it
   * or every enemy will keep walking around a wall that is no longer there.
   */
  rebuild(ruins: readonly { x: number; y: number; w: number; h: number }[]): void {
    this.blocked.fill(0);
    for (let cy = 0; cy < this.rows; cy++) {
      for (let cx = 0; cx < this.cols; cx++) {
        const x0 = cx * this.cellSize - this.clearance;
        const y0 = cy * this.cellSize - this.clearance;
        const x1 = (cx + 1) * this.cellSize + this.clearance;
        const y1 = (cy + 1) * this.cellSize + this.clearance;
        for (const r of ruins) {
          if (x0 < r.x + r.w && x1 > r.x && y0 < r.y + r.h && y1 > r.y) {
            this.blocked[cy * this.cols + cx] = 1;
            break;
          }
        }
      }
    }
    // Whatever field was built described a different arena.
    this.lastTargetCell = -1;
  }

  private cellIndex(x: number, y: number): number {
    const cx = Math.min(this.cols - 1, Math.max(0, Math.floor(x / this.cellSize)));
    const cy = Math.min(this.rows - 1, Math.max(0, Math.floor(y / this.cellSize)));
    return cy * this.cols + cx;
  }

  isBlocked(x: number, y: number): boolean {
    return this.blocked[this.cellIndex(x, y)] === 1;
  }

  /**
   * Rebuild the field toward (tx, ty). Cheap enough to call at ~10Hz; returns
   * false and does nothing if the target has not left its cell.
   */
  update(tx: number, ty: number, force = false): boolean {
    const target = this.cellIndex(tx, ty);
    if (!force && target === this.lastTargetCell) return false;
    this.lastTargetCell = target;

    // The window, clamped to the arena.
    const tcx0 = target % this.cols;
    const tcy0 = (target - tcx0) / this.cols;
    this.winX0 = Math.max(0, tcx0 - this.windowCells);
    this.winY0 = Math.max(0, tcy0 - this.windowCells);
    this.winX1 = Math.min(this.cols - 1, tcx0 + this.windowCells);
    this.winY1 = Math.min(this.rows - 1, tcy0 + this.windowCells);

    // Clear only the window. `dist.fill(Infinity)` over the whole arena is
    // itself O(area) and would put the cost straight back.
    for (let cy = this.winY0; cy <= this.winY1; cy++) {
      const row = cy * this.cols;
      for (let cx = this.winX0; cx <= this.winX1; cx++) {
        this.dist[row + cx] = Infinity;
        this.flow[(row + cx) * 2] = 0;
        this.flow[(row + cx) * 2 + 1] = 0;
      }
    }

    this.heap.length = 0;
    this.heapKey.length = 0;

    // If the player is standing inside a blocked cell (pushed against a ruin),
    // seed from its open neighbours so the field is still well-formed.
    if (this.blocked[target] === 1) {
      const tcx = target % this.cols;
      const tcy = (target - tcx) / this.cols;
      for (const [dx, dy] of NEIGHBOURS) {
        const nx = tcx + dx;
        const ny = tcy + dy;
        if (!this.inWindow(nx, ny)) continue;
        const ni = ny * this.cols + nx;
        if (this.blocked[ni] === 1) continue;
        this.dist[ni] = 0;
        this.push(ni, 0);
      }
    } else {
      this.dist[target] = 0;
      this.push(target, 0);
    }

    while (this.heap.length > 0) {
      const current = this.pop();
      const d = this.dist[current]!;
      const cx = current % this.cols;
      const cy = (current - cx) / this.cols;

      for (const [dx, dy, cost] of NEIGHBOURS) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (!this.inWindow(nx, ny)) continue;
        const ni = ny * this.cols + nx;
        if (this.blocked[ni] === 1) continue;
        // Do not let diagonals slip through the corner between two blocked cells.
        if (dx !== 0 && dy !== 0) {
          if (this.blocked[cy * this.cols + nx] === 1 && this.blocked[ny * this.cols + cx] === 1) {
            continue;
          }
        }
        const nd = d + cost;
        if (nd < this.dist[ni]!) {
          this.dist[ni] = nd;
          this.push(ni, nd);
        }
      }
    }

    this.buildFlow();
    return true;
  }

  /** Is this cell inside the window the last update built? */
  private inWindow(cx: number, cy: number): boolean {
    return cx >= this.winX0 && cx <= this.winX1 && cy >= this.winY0 && cy <= this.winY1;
  }

  /** Each open cell points at whichever neighbour is closest to the target. */
  private buildFlow(): void {
    for (let cy = this.winY0; cy <= this.winY1; cy++) {
      for (let cx = this.winX0; cx <= this.winX1; cx++) {
        const i = cy * this.cols + cx;
        this.flow[i * 2] = 0;
        this.flow[i * 2 + 1] = 0;
        if (this.blocked[i] === 1 || !Number.isFinite(this.dist[i]!)) continue;

        let bestD = this.dist[i]!;
        let bx = 0;
        let by = 0;
        for (const [dx, dy] of NEIGHBOURS) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (!this.inWindow(nx, ny)) continue;
          const ni = ny * this.cols + nx;
          if (this.blocked[ni] === 1) continue;
          const nd = this.dist[ni]!;
          if (nd < bestD) {
            bestD = nd;
            bx = dx;
            by = dy;
          }
        }
        const len = hypot(bx, by);
        if (len > 0) {
          this.flow[i * 2] = bx / len;
          this.flow[i * 2 + 1] = by / len;
        }
      }
    }
  }

  /**
   * Sample the field, bilinearly interpolated between cell centres so movement
   * reads as smooth steering rather than grid-snapping. Returns a zero vector
   * where the field is undefined; callers should fall back to a direct seek.
   */
  sample(x: number, y: number, out: { x: number; y: number }): void {
    // Outside the window there is no field, and saying so is better than
    // returning a stale direction from wherever the player used to be.
    if (!this.inWindow(Math.floor(x / this.cellSize), Math.floor(y / this.cellSize))) {
      out.x = 0;
      out.y = 0;
      return;
    }
    const gx = x / this.cellSize - 0.5;
    const gy = y / this.cellSize - 0.5;
    const x0 = Math.floor(gx);
    const y0 = Math.floor(gy);
    const fx = gx - x0;
    const fy = gy - y0;

    let vx = 0;
    let vy = 0;
    for (let j = 0; j <= 1; j++) {
      for (let i = 0; i <= 1; i++) {
        const cx = Math.min(this.cols - 1, Math.max(0, x0 + i));
        const cy = Math.min(this.rows - 1, Math.max(0, y0 + j));
        const idx = (cy * this.cols + cx) * 2;
        const w = (i === 0 ? 1 - fx : fx) * (j === 0 ? 1 - fy : fy);
        vx += this.flow[idx]! * w;
        vy += this.flow[idx + 1]! * w;
      }
    }

    const len = hypot(vx, vy);
    if (len > 1e-4) {
      out.x = vx / len;
      out.y = vy / len;
    } else {
      out.x = 0;
      out.y = 0;
    }
  }

  // ---- binary min-heap over cell indices ----

  private push(cell: number, key: number): void {
    this.heap.push(cell);
    this.heapKey.push(key);
    let i = this.heap.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.heapKey[parent]! <= this.heapKey[i]!) break;
      this.swap(i, parent);
      i = parent;
    }
  }

  private pop(): number {
    const top = this.heap[0]!;
    const lastCell = this.heap.pop()!;
    const lastKey = this.heapKey.pop()!;
    if (this.heap.length > 0) {
      this.heap[0] = lastCell;
      this.heapKey[0] = lastKey;
      let i = 0;
      for (;;) {
        const left = i * 2 + 1;
        const right = left + 1;
        let smallest = i;
        if (left < this.heap.length && this.heapKey[left]! < this.heapKey[smallest]!) smallest = left;
        if (right < this.heap.length && this.heapKey[right]! < this.heapKey[smallest]!) smallest = right;
        if (smallest === i) break;
        this.swap(i, smallest);
        i = smallest;
      }
    }
    return top;
  }

  private swap(a: number, b: number): void {
    const c = this.heap[a]!;
    this.heap[a] = this.heap[b]!;
    this.heap[b] = c;
    const k = this.heapKey[a]!;
    this.heapKey[a] = this.heapKey[b]!;
    this.heapKey[b] = k;
  }

  /** Debug/telemetry: fraction of the arena that is navigable. */
  get openFraction(): number {
    let open = 0;
    for (let i = 0; i < this.blocked.length; i++) if (this.blocked[i] === 0) open++;
    return open / this.blocked.length;
  }

  get arenaRef(): ArenaDef {
    return this.arena;
  }
}
