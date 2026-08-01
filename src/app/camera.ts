/**
 * Camera. Presentation only — the simulation has no idea this exists, and must
 * not: a sim that knows the viewport would produce different runs on different
 * monitors from the same seed.
 *
 * Follows the player with a little lookahead, smoothed, and clamps to the arena
 * so the world never shows a void beyond its own edge.
 */
import { CAMERA } from '../sim/tunables';
import type { ArenaDef } from '../sim/types';

export interface ViewRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export class Camera {
  x = 0;
  y = 0;
  /** Visible world size, in world units. Set by the renderer on resize. */
  viewWidth: number = CAMERA.viewWidth;
  viewHeight: number = CAMERA.viewHeight;

  constructor(private readonly arena: ArenaDef) {
    this.x = arena.spawnX;
    this.y = arena.spawnY;
  }

  setViewSize(width: number, height: number): void {
    this.viewWidth = width;
    this.viewHeight = height;
  }

  /** `dt` is real frame time — camera motion is presentation, not simulation. */
  follow(px: number, py: number, dirX: number, dirY: number, dt: number): void {
    const targetX = px + dirX * CAMERA.lookahead;
    const targetY = py + dirY * CAMERA.lookahead;
    // Frame-rate independent exponential smoothing.
    const t = 1 - Math.pow(CAMERA.smoothing, dt);
    this.x += (targetX - this.x) * t;
    this.y += (targetY - this.y) * t;
    this.clamp();
  }

  snapTo(px: number, py: number): void {
    this.x = px;
    this.y = py;
    this.clamp();
  }

  private clamp(): void {
    const halfW = this.viewWidth / 2;
    const halfH = this.viewHeight / 2;
    // If the arena is narrower than the view, centre it rather than clamping.
    this.x =
      this.arena.width <= this.viewWidth
        ? this.arena.width / 2
        : Math.min(this.arena.width - halfW, Math.max(halfW, this.x));
    this.y =
      this.arena.height <= this.viewHeight
        ? this.arena.height / 2
        : Math.min(this.arena.height - halfH, Math.max(halfH, this.y));
  }

  /** World-space rectangle currently visible. Used for culling and indicators. */
  get view(): ViewRect {
    return {
      x: this.x - this.viewWidth / 2,
      y: this.y - this.viewHeight / 2,
      width: this.viewWidth,
      height: this.viewHeight,
    };
  }

  /** Cull test with a margin so entities do not pop at the exact edge. */
  isVisible(x: number, y: number, margin = 60): boolean {
    return (
      x >= this.x - this.viewWidth / 2 - margin &&
      x <= this.x + this.viewWidth / 2 + margin &&
      y >= this.y - this.viewHeight / 2 - margin &&
      y <= this.y + this.viewHeight / 2 + margin
    );
  }
}
