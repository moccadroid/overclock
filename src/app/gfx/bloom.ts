/**
 * The single bloom pass (§16.1).
 *
 * "Dark field, additive glow. Maximum chaos must resolve into *light*, not soup."
 * and "emissives bloom, structure doesn't" — so the scene is split in two. The
 * structure layer (grid, ruins, annotations) draws straight to the screen. The
 * emissive layer renders into a texture, which is then composited twice: once
 * flat, once blurred and additive.
 *
 * The emissive layer is deliberately NOT a child of the stage. It is rendered
 * manually into the target each frame; adding it to the stage as well would draw
 * everything twice.
 */
import {
  Application,
  BlurFilter,
  Container,
  RenderTexture,
  Sprite,
  Texture,
  type ColorSource,
} from 'pixi.js';
import { VISUAL } from '../visual';

export class BloomPipeline {
  /** Put everything that should glow in here. */
  readonly emissive = new Container();
  /** Composited output, in screen space. Add this to the stage. */
  readonly output = new Container();

  private texture: RenderTexture;
  private readonly base = new Sprite();
  private readonly glow = new Sprite();
  private readonly blur = new BlurFilter();
  /** §16.7 step 2 — chromatic aberration, as two offset tinted copies. */
  private readonly fringeR = new Sprite();
  private readonly fringeB = new Sprite();

  constructor(private readonly app: Application) {
    this.texture = RenderTexture.create({
      width: Math.max(1, app.screen.width),
      height: Math.max(1, app.screen.height),
      resolution: 1,
    });

    this.blur.strength = VISUAL.bloomStrength;
    this.blur.quality = 3;
    this.blur.resolution = VISUAL.bloomResolution;

    for (const sprite of [this.base, this.glow, this.fringeR, this.fringeB]) {
      sprite.texture = this.texture;
    }
    this.glow.filters = [this.blur];
    this.glow.blendMode = 'add';
    this.glow.alpha = VISUAL.bloomIntensity;

    this.fringeR.blendMode = 'add';
    this.fringeB.blendMode = 'add';
    this.fringeR.tint = 0xff4040 as ColorSource;
    this.fringeB.tint = 0x4080ff as ColorSource;
    this.fringeR.alpha = 0;
    this.fringeB.alpha = 0;

    this.output.addChild(this.base, this.fringeR, this.fringeB, this.glow);
  }

  resize(): void {
    const width = Math.max(1, this.app.screen.width);
    const height = Math.max(1, this.app.screen.height);
    if (this.texture.width === width && this.texture.height === height) return;
    this.texture.destroy(true);
    this.texture = RenderTexture.create({ width, height, resolution: 1 });
    for (const sprite of [this.base, this.glow, this.fringeR, this.fringeB]) {
      sprite.texture = this.texture as Texture;
    }
  }

  /** Intensity of the aberration step, 0..1. Scaled by the photosensitivity setting. */
  setAberration(amount: number): void {
    const safe = amount * VISUAL.degradationIntensity;
    const offset = safe * VISUAL.aberrationInstability2;
    this.fringeR.alpha = safe * 0.5;
    this.fringeB.alpha = safe * 0.5;
    this.fringeR.position.set(-offset, 0);
    this.fringeB.position.set(offset, 0);
  }

  setBloom(intensity: number): void {
    this.glow.alpha = intensity;
  }

  /**
   * §16.7 step 4 — Overheat tears the frame. Approximated by displacing the
   * composited scene horizontally; the real per-band tear wants a shader and can
   * come with the Meltdown ladder.
   */
  setTear(amount: number): void {
    const safe = amount * VISUAL.degradationIntensity;
    const shift = safe * VISUAL.tearAmount;
    this.base.position.x = shift;
    this.glow.position.x = shift;
  }

  /** Render the emissive layer into the texture. Call once per frame. */
  compose(): void {
    this.app.renderer.render({
      container: this.emissive,
      target: this.texture,
      clear: true,
    });
  }
}
