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
  type Application,
  BlurFilter,
  Container,
  RenderTexture,
  Sprite,
  type Texture,
  type ColorSource,
} from 'pixi.js';
import { VISUAL } from '../visual';

export class BloomPipeline {
  /** Put everything that should glow in here. */
  readonly emissive = new Container();
  /** Composited output, in screen space. Add this to the stage. */
  readonly output = new Container();

  private texture: RenderTexture;

  /**
   * The raw emissive layer, before any blur. Everything that glows, once.
   *
   * Exposed so the shell's mass pass can be given a faint additive copy of it
   * on top: standing under an overhang should occlude you, but vanishing
   * completely while your own light carries on through is worse than either.
   */
  get source(): Texture {
    return this.texture;
  }
  private readonly base = new Sprite();
  /** An unblurred additive copy — see setGlow. */
  private readonly hot = new Sprite();
  /**
   * Three additive glow copies at widening blur radii.
   *
   * One sprite could not get brighter than `alpha = 1`, so every bloom setting
   * above 1x was silently doing nothing — the "more bloom" slider was a placebo.
   * Stacking additive copies is how bloom actually escalates: the tight one
   * gives edges their halo, and the wide ones are what turn a screen full of
   * light into §16.1's "chaos resolving into light" rather than into soup.
   */
  private readonly glow = new Sprite();
  private readonly glowWide = new Sprite();
  private readonly glowHuge = new Sprite();
  private readonly blur = new BlurFilter();
  private readonly blurWide = new BlurFilter();
  private readonly blurHuge = new BlurFilter();
  /** §16.7 step 2 — chromatic aberration, as two offset tinted copies. */
  private readonly fringeR = new Sprite();
  private readonly fringeB = new Sprite();

  constructor(private readonly app: Application) {
    this.texture = RenderTexture.create({
      width: Math.max(1, app.screen.width),
      height: Math.max(1, app.screen.height),
      resolution: 1,
    });

    for (const [filter, scale] of [
      [this.blur, 1],
      [this.blurWide, 3.2],
      [this.blurHuge, 7],
    ] as const) {
      filter.strength = VISUAL.bloomStrength * scale;
      filter.quality = 3;
      filter.resolution = VISUAL.bloomResolution;
    }

    for (const sprite of [
      this.base,
      this.hot,
      this.glow,
      this.glowWide,
      this.glowHuge,
      this.fringeR,
      this.fringeB,
    ]) {
      sprite.texture = this.texture;
    }
    this.hot.blendMode = 'add';
    this.hot.alpha = 0;
    this.glow.filters = [this.blur];
    this.glowWide.filters = [this.blurWide];
    this.glowHuge.filters = [this.blurHuge];
    for (const sprite of [this.glow, this.glowWide, this.glowHuge]) {
      sprite.blendMode = 'add';
    }
    this.glow.alpha = VISUAL.bloomIntensity;
    this.glowWide.alpha = 0;
    this.glowHuge.alpha = 0;

    this.fringeR.blendMode = 'add';
    this.fringeB.blendMode = 'add';
    this.fringeR.tint = 0xff4040 as ColorSource;
    this.fringeB.tint = 0x4080ff as ColorSource;
    this.fringeR.alpha = 0;
    this.fringeB.alpha = 0;

    this.output.addChild(
      this.base,
      this.hot,
      this.fringeR,
      this.fringeB,
      this.glow,
      this.glowWide,
      this.glowHuge,
    );
  }

  resize(): void {
    const width = Math.max(1, this.app.screen.width);
    const height = Math.max(1, this.app.screen.height);
    if (this.texture.width === width && this.texture.height === height) return;
    this.texture.destroy(true);
    this.texture = RenderTexture.create({ width, height, resolution: 1 });
    for (const sprite of [
      this.base,
      this.hot,
      this.glow,
      this.glowWide,
      this.glowHuge,
      this.fringeR,
      this.fringeB,
    ]) {
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

  /**
   * Bloom past 1x spills into the wider copies rather than being thrown away.
   * 1 is the tuned §16 baseline; 4 is a deliberate excess and looks like one.
   */
  /**
   * How hot the emissive layer burns before any of it spreads.
   *
   * Applied as an extra additive copy of the *unblurred* scene rather than as
   * alpha on the layer itself. Alpha can only ever make something dimmer — it
   * was being used to make things brighter, which is why raising it faded the
   * picture instead. Adding the scene to itself is what actually brightens it.
   */
  setGlow(amount: number): void {
    this.base.alpha = 1;
    this.hot.alpha = Math.max(0, amount - 1);
  }

  setBloom(intensity: number): void {
    this.glow.alpha = Math.min(1.4, intensity);
    this.glowWide.alpha = Math.max(0, Math.min(1.1, intensity - 1.2)) * 0.75;
    this.glowHuge.alpha = Math.max(0, Math.min(1, intensity - 2.4)) * 0.6;
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
    for (const sprite of [this.glow, this.glowWide, this.glowHuge]) {
      sprite.position.x = shift;
    }
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
