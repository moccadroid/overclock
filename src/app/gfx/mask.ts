/**
 * The state field. GDD §10.4, §16.7.
 *
 * A screen-space buffer that says, for every pixel, *what kind of thing is
 * happening there*. Not light — light is `gfx/lights.ts` and answers "how
 * bright". This answers "how wrong", in three independent channels:
 *
 *   R — **charge**. Something here is cooking: a Charged variant, a Charger
 *       winding up, a Volatile a moment from detonating.
 *   G — **corruption**. Something here is an elite, hardened, or otherwise not
 *       playing by the rules the base creature plays by.
 *   B — **cold**. Something here is slowed, frozen or suppressed.
 *
 * The post pass reads it and deforms the finished picture accordingly: heat
 * shimmer over charge, channel separation over corruption, a desaturated
 * crystalline cast over cold. That indirection is the entire point. A variant
 * mark drawn as a glyph costs a tessellation per enemy and only ever *labels*
 * the thing; a channel written into a quarter-resolution buffer costs one quad,
 * merges correctly when twenty of them overlap, and makes the creature look
 * like what it is.
 *
 * It is the same architecture as the Suppressor's glitch field — which is the
 * bar this is trying to hit — except addressed by a texture rather than by
 * eight uniforms, so the count is unbounded.
 */
import { type Application, Container, RenderTexture, Sprite, Texture } from 'pixi.js';

/** Quarter res. These are soft regions, not edges. */
const MASK_SCALE = 0.25;

/**
 * Past this, the frame is fill-bound rather than draw-bound and the extra quads
 * buy nothing legible: a screen with four hundred charged enemies on it is one
 * shimmering screen either way.
 */
const MAX_MARKS = 384;

interface Request {
  x: number;
  y: number;
  radius: number;
  r: number;
  g: number;
  b: number;
}

/**
 * A soft disc, baked once.
 *
 * Squared falloff rather than linear: the region has to have a *centre* that
 * the effect is clearly strongest at, or overlapping marks average into an even
 * wash and stop pointing at anything.
 */
function bake(size: number): Texture {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const image = ctx.createImageData(size, size);
  const half = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x + 0.5 - half) / half;
      const dy = (y + 0.5 - half) / half;
      const d = Math.sqrt(dx * dx + dy * dy);
      const v = d >= 1 ? 0 : (1 - d) * (1 - d);
      const i = (y * size + x) * 4;
      image.data[i] = 255;
      image.data[i + 1] = 255;
      image.data[i + 2] = 255;
      image.data[i + 3] = Math.round(v * 255);
    }
  }
  ctx.putImageData(image, 0, 0);
  return Texture.from(canvas);
}

export class MaskField {
  private readonly container = new Container();
  private readonly pool: Sprite[] = [];
  private readonly requests: Request[] = [];
  private count = 0;
  private disc: Texture | null = null;
  private texture: RenderTexture;

  constructor(private readonly app: Application) {
    this.texture = RenderTexture.create({
      width: Math.max(1, Math.ceil(app.screen.width * MASK_SCALE)),
      height: Math.max(1, Math.ceil(app.screen.height * MASK_SCALE)),
      resolution: 1,
    });
  }

  get source(): Texture {
    return this.texture;
  }

  /** True when nothing was submitted, so the post pass can skip the sample. */
  get empty(): boolean {
    return this.count === 0;
  }

  resize(): void {
    const width = Math.max(1, Math.ceil(this.app.screen.width * MASK_SCALE));
    const height = Math.max(1, Math.ceil(this.app.screen.height * MASK_SCALE));
    if (this.texture.width === width && this.texture.height === height) return;
    this.texture.destroy(true);
    this.texture = RenderTexture.create({ width, height, resolution: 1 });
  }

  begin(): void {
    this.count = 0;
  }

  /**
   * Mark a region. The three amounts are independent — a hardened Charged Mote
   * writes charge *and* corruption, and gets both effects at once, which is
   * exactly what it should look like.
   */
  mark(x: number, y: number, radius: number, r: number, g: number, b: number): void {
    if (this.count >= MAX_MARKS) return;
    if (radius <= 0 || (r <= 0.01 && g <= 0.01 && b <= 0.01)) return;
    let request = this.requests[this.count];
    if (!request) {
      request = { x, y, radius, r, g, b };
      this.requests[this.count] = request;
    } else {
      request.x = x;
      request.y = y;
      request.radius = radius;
      request.r = r;
      request.g = g;
      request.b = b;
    }
    this.count++;
  }

  /**
   * Render the field, using the same world-to-screen mapping the world layer
   * took. Additive, and the shader clamps — three overlapping charges are one
   * hotter region rather than three separate ones, which is what a region
   * effect should do.
   */
  render(scale: number, offsetX: number, offsetY: number): void {
    if (!this.disc) this.disc = bake(64);
    for (let i = 0; i < this.count; i++) {
      const request = this.requests[i]!;
      let sprite = this.pool[i];
      if (!sprite) {
        sprite = new Sprite(this.disc);
        sprite.anchor.set(0.5);
        sprite.blendMode = 'add';
        this.container.addChild(sprite);
        this.pool[i] = sprite;
      }
      sprite.visible = true;
      sprite.position.set(request.x, request.y);
      sprite.width = request.radius * 2;
      sprite.height = request.radius * 2;
      // Tint carries the channel mix; alpha carries the overall strength, so a
      // faint corruption and a strong one are the same colour at different
      // weights rather than two different colours.
      const peak = Math.max(request.r, request.g, request.b);
      sprite.tint =
        (Math.round((request.r / peak) * 255) << 16) |
        (Math.round((request.g / peak) * 255) << 8) |
        Math.round((request.b / peak) * 255);
      sprite.alpha = Math.min(1, peak);
    }
    for (let i = this.count; i < this.pool.length; i++) {
      const sprite = this.pool[i];
      if (sprite) sprite.visible = false;
    }

    this.container.scale.set(scale * MASK_SCALE);
    this.container.position.set(offsetX * MASK_SCALE, offsetY * MASK_SCALE);
    this.app.renderer.render({ container: this.container, target: this.texture, clear: true });
  }
}
