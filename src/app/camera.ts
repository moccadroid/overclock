/**
 * Camera. Presentation only — the simulation has no idea this exists, and must
 * not: a sim that knows the viewport would produce different runs on different
 * monitors from the same seed.
 *
 * Follows the player with a little lookahead, smoothed, and clamps to the arena
 * — but deliberately overshoots it, so the wall outside the world is visible.
 */
import { CAMERA } from '../sim/tunables';
import type { ArenaDef } from '../sim/types';

/**
 * How far the view may travel *past* the arena rectangle, in world units.
 *
 * The clamp used to stop dead on the arena line, with the comment "so the world
 * never shows a void beyond its own edge". That was true when beyond the edge
 * was a void. It is the shell wall now — the black mass lives entirely outside
 * the arena rect — so the clamp was making the one thing it was written to hide
 * structurally impossible to see. Every attempt to fix that from the shell side
 * failed for the same reason: it was working on the wrong side of a boundary the
 * camera would not cross.
 *
 * Whatever wall you did see before this came from the letterbox. The render
 * scale is the smaller of the two axis fits, so unless the window matches the
 * view's aspect there are bars on two sides — and the shell shader paints the
 * whole canvas, bars included. Which sides showed wall therefore depended on the
 * window shape and moved when it was resized. This makes it deliberate and
 * symmetric instead.
 *
 * Y is a fraction of X on purpose: the arena is three times wider than it is
 * tall, so the same margin top and bottom would eat a much larger share of the
 * vertical play space.
 *
 * The player still cannot leave the arena. Only the camera goes further.
 */
const EDGE_MARGIN_X = 180;
const EDGE_MARGIN_Y = 80;

export interface ViewRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export class Camera {
  x = 0;
  y = 0;
  /**
   * The rectangle the view is confined to — the union of the levels you have
   * unlocked, not the whole arena.
   *
   * This is what makes a gate a reveal rather than a door. Until it is held, the
   * next room is not merely walled off, it is somewhere the camera cannot look;
   * when it opens, the bounds grow and the room is *shown* to you. Defaults to
   * the arena so an arena with no levels behaves exactly as before.
   */
  private bounds = { x: 0, y: 0, w: 0, h: 0 };
  /** Visible world size, in world units. Set by the renderer on resize. */
  viewWidth: number = CAMERA.viewWidth;
  viewHeight: number = CAMERA.viewHeight;

  constructor(arena: ArenaDef) {
    this.x = arena.spawnX;
    this.y = arena.spawnY;
    this.setBounds(0, 0, arena.width, arena.height);
  }

  /** Confine the view. Called by the renderer as levels unlock. */
  setBounds(x: number, y: number, w: number, h: number): void {
    this.bounds.x = x;
    this.bounds.y = y;
    this.bounds.w = w;
    this.bounds.h = h;
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
    const halfW = this.viewWidth / 2 - EDGE_MARGIN_X;
    const halfH = this.viewHeight / 2 - EDGE_MARGIN_Y;
    const b = this.bounds;
    // If the region is narrower than the view, centre it rather than clamping.
    this.x =
      b.w <= this.viewWidth
        ? b.x + b.w / 2
        : Math.min(b.x + b.w - halfW, Math.max(b.x + halfW, this.x));
    this.y =
      b.h <= this.viewHeight
        ? b.y + b.h / 2
        : Math.min(b.y + b.h - halfH, Math.max(b.y + halfH, this.y));
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
