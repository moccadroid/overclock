/**
 * The light field. GDD §16.1 — "dark field, additive glow."
 *
 * The bloom pass makes bright things bleed into their *own* pixels. That is not
 * the same as a bolt lighting up the grid it flies over, and no amount of blur
 * gets you there: blur can only spread what a pixel already had. Illumination
 * needs the light to exist as its own quantity, separate from the thing that
 * emitted it.
 *
 * So: every emissive entity writes a falloff into a light buffer, at a quarter
 * resolution because light is low-frequency and nobody has ever noticed a soft
 * gradient being soft. The post shader then samples that buffer and does two
 * different things with it:
 *
 *   1. **Surfaces catch it.** `colour += colour * light` — a stroke brightens in
 *      proportion to how much light falls on it *and* how reflective it already
 *      is, so the grid glows near a detonation and stays dark far from one.
 *   2. **The light is visible in the air.** `colour += light` — a soft haze
 *      around every source, which is what sells neon.
 *
 * Three things make this hold up under a real Engine rather than a test scene:
 *
 * **Shapes.** A light is a point, a capsule or an area, because the things that
 * emit light in this game are not all round. A bolt at 1400 units/s covers
 * twenty units between frames and should light the whole streak, not the disc
 * where it happened to stop. An Arc is a polyline and should light along it. A
 * Field is a region, and lighting it with a radial makes a bright dot inside a
 * dark ring rather than a lit floor.
 *
 * **Exposure.** The buffer is 8-bit and additive: once a region sums past 1.0
 * it clips, and a clipped region has *no variation left in it at all*. Forty
 * overlapping thermal sources stop being forty lights and become one flat
 * yellow blob with a soft edge — which is less impressive than one light, not
 * more. So the field measures how much light it is being asked to emit and
 * scales the whole frame down when that would clip. Ducks fast, recovers slow.
 * It is a limiter, and for exactly the reason the audio bus has one: the fix
 * for "too much at once" is never to let the loud thing through and clip, it is
 * to make room for it.
 *
 * **A budget, not a cap.** Lights are collected as requests and submitted at
 * the end of the frame, so when there are more than the budget allows the field
 * keeps the *important* ones rather than the first ones it happened to see. A
 * screen with 900 lights on it drops pickups and keeps the Nova.
 */
import {
  type Application,
  Container,
  RenderTexture,
  Sprite,
  Texture,
  type ColorSource,
} from 'pixi.js';

/** Quarter res. Light is low-frequency; nobody has noticed a soft glow being soft. */
const LIGHT_SCALE = 0.25;

/**
 * How many quads reach the buffer. Past this the frame is fill-rate bound, not
 * draw-call bound, so raising it buys nothing — the budget picks better lights
 * instead.
 */
const MAX_LIGHTS = 512;

/**
 * Where the exposure starts pulling back, and the hardest it is ever allowed to
 * pull.
 *
 * Measured rather than guessed: a 57-EPS run sits at 0.17 for half its frames
 * and touches 0.41 at its busiest, so a target of 0.2 leaves ordinary play
 * completely untouched and starts trimming only on the frames that were about
 * to clip. The floor is what a wall of simultaneous detonations gets — dark
 * enough to keep every one of them distinguishable, never dark enough to read
 * as the screen dimming.
 */
const EXPOSURE_TARGET = 0.2;
const EXPOSURE_FLOOR = 0.22;

/** How fast exposure ducks and recovers, as a fraction reached per second. */
const DUCK_RATE = 9;
const RECOVER_RATE = 0.9;

/**
 * Energy bins for the over-budget selection, one per power of two. A pickup's
 * halo lands around bin 8 and a Meltdown's arena-wide wash around bin 22, so
 * this covers the whole range with room at both ends.
 */
const BINS = 32;

function binOf(energy: number): number {
  const bin = Math.log2(energy) | 0;
  return bin < 0 ? 0 : bin > BINS - 1 ? BINS - 1 : bin;
}

const POINT = 0;
const BEAM = 1;
const AREA = 2;
type Shape = typeof POINT | typeof BEAM | typeof AREA;

interface Request {
  shape: Shape;
  x: number;
  y: number;
  /** Full extent along the sprite's local axes, in world units. */
  w: number;
  h: number;
  rotation: number;
  color: number;
  intensity: number;
  /** Bounding-box area times intensity. Ranks the budget. */
  energy: number;
}

/**
 * Bake a falloff into a texture.
 *
 * `plateau` is how much of the half-extent stays at full brightness before the
 * curve starts, and `pad` is how much of the width is cap rather than body — a
 * capsule with 12.5% caps stretches its body without stretching its ends much,
 * which is close enough to a true swept disc at the lengths this game uses and
 * costs one quad instead of three.
 *
 * The curve is deliberately not linear. `(1 - r)^3.2` has a hot core and a long
 * tail, which is how a point source in air actually reads; a linear ramp looks
 * like a sprite of a circle, because it is one.
 */
function bake(width: number, height: number, plateau: number, pad: number): Texture {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  const image = ctx.createImageData(width, height);

  const halfW = width / 2;
  const halfH = height / 2;
  // The central segment the distance is measured to. For a point or an area
  // this is a single pixel and the result is radial; for a beam it is a line
  // and the result is a capsule.
  const spine = Math.max(0, halfW - pad * width);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dx = x - halfW;
      const dy = (y - halfH) / halfH;
      // Distance to the spine rather than to the centre.
      const ox = Math.max(0, Math.abs(dx) - spine) / Math.max(1, halfW - spine);
      const r = Math.min(1, Math.sqrt(ox * ox + dy * dy));
      const t = plateau >= 1 ? 0 : Math.max(0, (r - plateau) / (1 - plateau));
      const v = Math.pow(1 - t, 3.2);
      const i = (y * width + x) * 4;
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
  private readonly textures: Record<Shape, Texture>;

  /** Reused every frame — a light is a quad, not an allocation. */
  private readonly requests: Request[] = [];
  private count = 0;
  private pressure = 0;
  /** Scratch for the over-budget selection. Grown, never shrunk. */
  private order: number[] = [];
  private readonly bins = new Int32Array(BINS);

  private load = 0;
  private texture: RenderTexture;

  constructor(private readonly app: Application) {
    this.textures = {
      // A point: radial, hot core, no plateau.
      [POINT]: bake(128, 128, 0, 0.5),
      // A capsule: falloff measured to a horizontal spine, 12.5% caps.
      [BEAM]: bake(256, 64, 0, 0.125),
      // An area: flat to 55% of the radius, then rolls off. A Field lights its
      // floor evenly instead of being a lamp at its own centre.
      [AREA]: bake(128, 128, 0.55, 0.5),
    };
    this.texture = RenderTexture.create({
      width: Math.max(1, Math.ceil(app.screen.width * LIGHT_SCALE)),
      height: Math.max(1, Math.ceil(app.screen.height * LIGHT_SCALE)),
      resolution: 1,
    });
  }

  get source(): Texture {
    return this.texture;
  }

  /** How hard the exposure is currently pulling back. 1 is untouched. */
  get exposure(): number {
    return Math.max(EXPOSURE_FLOOR, Math.min(1, EXPOSURE_TARGET / Math.max(0.0001, this.load)));
  }

  resize(): void {
    const width = Math.max(1, Math.ceil(this.app.screen.width * LIGHT_SCALE));
    const height = Math.max(1, Math.ceil(this.app.screen.height * LIGHT_SCALE));
    if (this.texture.width === width && this.texture.height === height) return;
    this.texture.destroy(true);
    this.texture = RenderTexture.create({ width, height, resolution: 1 });
  }

  begin(): void {
    this.count = 0;
    this.pressure = 0;
  }

  private push(
    shape: Shape,
    x: number,
    y: number,
    w: number,
    h: number,
    rotation: number,
    color: number,
    intensity: number,
  ): void {
    if (intensity <= 0.005 || w <= 0 || h <= 0) return;
    const energy = intensity * w * h;
    // The exposure counts intensity *squared*, which is the whole reason it
    // reads as a camera rather than as a dimmer.
    //
    // What clips is bright things overlapping. Four hundred fuel motes glowing
    // at 0.1 across the whole arena never clip anything — but they carry more
    // raw energy than the Nova going off in the middle of them, so a linear
    // metric let a floor covered in loot pull the brightness *out* of the
    // explosion. Squaring makes a source's pull on the exposure scale with how
    // close it is to clipping on its own, so ambience is nearly free and the
    // things that actually blow out are the things that pay.
    this.pressure += intensity * energy;

    let request = this.requests[this.count];
    if (!request) {
      request = { shape, x, y, w, h, rotation, color, intensity, energy };
      this.requests[this.count] = request;
    } else {
      request.shape = shape;
      request.x = x;
      request.y = y;
      request.w = w;
      request.h = h;
      request.rotation = rotation;
      request.color = color;
      request.intensity = intensity;
      request.energy = energy;
    }
    this.count++;
  }

  /**
   * A round source. `intensity` is allowed above 1 — additive blending means an
   * overlapping pair of bright sources genuinely blows out, and the exposure
   * decides whether the frame can afford it.
   */
  point(x: number, y: number, radius: number, color: number, intensity: number): void {
    this.push(POINT, x, y, radius * 2, radius * 2, 0, color, intensity);
  }

  /**
   * A capsule between two points — a shot's streak, a segment of an Arc, a
   * Lancer's corridor. `width` is the full thickness of the lit band.
   */
  beam(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    width: number,
    color: number,
    intensity: number,
  ): void {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const length = Math.sqrt(dx * dx + dy * dy);
    // A degenerate segment is a point, and drawing it as a zero-length capsule
    // would collapse the caps into a sliver.
    if (length < 1) {
      this.point(x0, y0, width * 0.5, color, intensity);
      return;
    }
    this.push(
      BEAM,
      (x0 + x1) * 0.5,
      (y0 + y1) * 0.5,
      length + width,
      width,
      Math.atan2(dy, dx),
      color,
      intensity,
    );
  }

  /** A lit region rather than a source: flat in the middle, soft at the rim. */
  area(x: number, y: number, radius: number, color: number, intensity: number): void {
    this.push(AREA, x, y, radius * 2, radius * 2, 0, color, intensity);
  }

  /**
   * Render the field. `transform` is the same world-to-screen mapping the world
   * layer uses, scaled down to the buffer — lights have to land exactly where
   * their emitters drew, or the whole illusion collapses into a smear that
   * follows the camera a frame late.
   */
  render(scale: number, offsetX: number, offsetY: number, dt: number): void {
    // Exposure is measured against the *visible* world, so zooming out does not
    // read as the arena getting brighter.
    const visible =
      (this.app.screen.width / Math.max(0.01, scale)) *
      (this.app.screen.height / Math.max(0.01, scale));
    const load = this.pressure / Math.max(1, visible);

    // Ducks fast, recovers slow. The other way round and a Nova going off would
    // pump the whole arena darker a frame *after* it lit it, which reads as the
    // screen flinching rather than as a room being overexposed.
    const rate = load > this.load ? DUCK_RATE : RECOVER_RATE;
    this.load += (load - this.load) * Math.min(1, rate * dt);
    const gain = this.exposure;

    const submitted = this.select();
    for (let i = 0; i < submitted; i++) {
      const request = this.requests[this.order[i]!]!;
      let sprite = this.pool[i];
      if (!sprite) {
        sprite = new Sprite();
        sprite.anchor.set(0.5);
        sprite.blendMode = 'add';
        this.container.addChild(sprite);
        this.pool[i] = sprite;
      }
      sprite.visible = true;
      sprite.texture = this.textures[request.shape];
      sprite.position.set(request.x, request.y);
      sprite.width = request.w;
      sprite.height = request.h;
      sprite.rotation = request.rotation;
      sprite.tint = request.color as ColorSource;
      sprite.alpha = Math.min(1, request.intensity * gain);
    }
    for (let i = submitted; i < this.pool.length; i++) {
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

  /**
   * Choose which requests to submit, writing indices into `order`.
   *
   * Under budget this is the identity. Over budget it keeps the brightest, so
   * what gets dropped is a pickup's 48-unit halo rather than the detonation that
   * just took out half the screen.
   *
   * Selection is a histogram rather than a sort, because the frame that needs it
   * is by definition the frame that can least afford one: a 700-EPS cascade
   * measured thirteen thousand requests, and sorting thirteen thousand entries
   * every frame is precisely the "it only breaks when it matters" failure this
   * budget exists to prevent. Binning by the exponent of the energy is one
   * linear pass, no allocation, and the cutoff it finds is within a factor of
   * two of the true one — which is far finer than the difference between the
   * lights worth keeping and the lights worth dropping.
   */
  private select(): number {
    const count = this.count;
    while (this.order.length < count) this.order.push(0);
    if (count <= MAX_LIGHTS) {
      for (let i = 0; i < count; i++) this.order[i] = i;
      return count;
    }

    const requests = this.requests;
    const bins = this.bins;
    bins.fill(0);
    for (let i = 0; i < count; i++) {
      bins[binOf(requests[i]!.energy)]!++;
    }

    // Walk down from the brightest bin until the next one would overflow. Every
    // bin above the cutoff is taken whole; the cutoff bin fills the remainder.
    let cut = BINS - 1;
    let kept = 0;
    for (; cut > 0; cut--) {
      const next = kept + bins[cut]!;
      if (next > MAX_LIGHTS) break;
      kept = next;
    }

    let n = 0;
    for (let i = 0; i < count && n < MAX_LIGHTS; i++) {
      if (binOf(requests[i]!.energy) >= cut) this.order[n++] = i;
    }
    return n;
  }
}

