/**
 * The light field. GDD §16.1 — "dark field, additive glow."
 *
 * The bloom pass makes bright things bleed into their *own* pixels. That is not
 * the same as a bolt lighting up the grid it flies over, and no amount of blur
 * gets you there: blur can only spread what a pixel already had. Illumination
 * needs the light to exist as its own quantity, separate from the thing that
 * emitted it.
 *
 * So: every emissive entity writes a radial falloff into a light buffer, at a
 * quarter resolution because light is low-frequency and nobody has ever noticed
 * a soft gradient being soft. The post shader then samples that buffer and does
 * two different things with it:
 *
 *   1. **Surfaces catch it.** `colour += colour * light` — a stroke brightens in
 *      proportion to how much light falls on it *and* how reflective it already
 *      is, so the grid glows near a detonation and stays dark far from one. This
 *      is the part that makes the world feel lit rather than decorated.
 *   2. **The light is visible in the air.** `colour += light` — a soft haze
 *      around every source, which is what sells neon.
 *
 * One draw call for the whole field: every light is the same pre-baked radial
 * texture, tinted and scaled. A thousand lights cost a thousand quads, which is
 * nothing.
 */
import {
  Application,
  Container,
  RenderTexture,
  Sprite,
  Texture,
  type ColorSource,
} from 'pixi.js';

/** Quarter res. Light is low-frequency; nobody has noticed a soft glow being soft. */
const LIGHT_SCALE = 0.25;
/** A budget, not a design number — 600 lights is already more than a screen holds. */
const MAX_LIGHTS = 600;

/**
 * A radial falloff, baked once.
 *
 * The curve is deliberately not linear: `(1 - r)^2` has a hot core and a long
 * tail, which is how a point source in air actually reads. A linear ramp looks
 * like a sprite of a circle, because it is one.
 */
function radialTexture(): Texture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;

  const image = ctx.createImageData(size, size);
  const half = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x - half) / half;
      const dy = (y - half) / half;
      const r = Math.min(1, Math.sqrt(dx * dx + dy * dy));
      // A sharper core and a longer tail than a plain falloff. At small radii
      // the exponent barely matters; at the 300+ unit radius of a Field or a
      // detonation it is the difference between a lamp and a painted circle.
      const v = Math.pow(1 - r, 3.2);
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

export class LightField {
  /** Rendered separately, never added to the stage. */
  private readonly container = new Container();
  private readonly pool: Sprite[] = [];
  private readonly falloff = radialTexture();
  private used = 0;
  private texture: RenderTexture;

  constructor(private readonly app: Application) {
    this.texture = RenderTexture.create({
      width: Math.max(1, Math.ceil(app.screen.width * LIGHT_SCALE)),
      height: Math.max(1, Math.ceil(app.screen.height * LIGHT_SCALE)),
      resolution: 1,
    });
  }

  get source(): Texture {
    return this.texture;
  }

  resize(): void {
    const width = Math.max(1, Math.ceil(this.app.screen.width * LIGHT_SCALE));
    const height = Math.max(1, Math.ceil(this.app.screen.height * LIGHT_SCALE));
    if (this.texture.width === width && this.texture.height === height) return;
    this.texture.destroy(true);
    this.texture = RenderTexture.create({ width, height, resolution: 1 });
  }

  /** Start a frame. Sprites are pooled — a light is a quad, not an allocation. */
  begin(): void {
    this.used = 0;
  }

  /**
   * Add a light in *world* space.
   *
   * `intensity` is allowed above 1: additive blending means an overlapping pair
   * of bright sources genuinely blows out, which is what a cascade should do to
   * a room.
   */
  add(x: number, y: number, radius: number, color: number, intensity: number): void {
    if (this.used >= MAX_LIGHTS || intensity <= 0.01) return;

    let sprite = this.pool[this.used];
    if (!sprite) {
      sprite = new Sprite(this.falloff);
      sprite.anchor.set(0.5);
      sprite.blendMode = 'add';
      this.container.addChild(sprite);
      this.pool[this.used] = sprite;
    }

    sprite.visible = true;
    sprite.position.set(x, y);
    sprite.width = radius * 2;
    sprite.height = radius * 2;
    sprite.tint = color as ColorSource;
    sprite.alpha = Math.min(1, intensity);
    this.used++;
  }

  /**
   * Render the field. `transform` is the same world-to-screen mapping the world
   * layer uses, scaled down to the buffer — lights have to land exactly where
   * their emitters drew, or the whole illusion collapses into a smear that
   * follows the camera a frame late.
   */
  render(scale: number, offsetX: number, offsetY: number): void {
    for (let i = this.used; i < this.pool.length; i++) {
      const sprite = this.pool[i];
      if (sprite) sprite.visible = false;
    }

    this.container.scale.set(scale * LIGHT_SCALE);
    this.container.position.set(offsetX * LIGHT_SCALE, offsetY * LIGHT_SCALE);

    this.app.renderer.render({
      container: this.container,
      target: this.texture,
      clear: true,
    });
  }
}
