/**
 * The emissive layer, and the mip chain its bloom is read from (§16.1).
 *
 * "Dark field, additive glow. Maximum chaos must resolve into *light*, not soup."
 * and "emissives bloom, structure doesn't" — so the scene is split in two. The
 * structure layer (grid, ruins, annotations) draws straight to the screen. The
 * emissive layer renders into a texture, and everything that used to composite
 * that texture — flat copy, hot copy, three blurred additive copies, two
 * aberration fringes — now happens in the post pass, which reads the buffers
 * this class maintains.
 *
 * The blurred copies were the expensive half. Three independent Gaussian
 * `BlurFilter` chains re-blurred the full emissive texture at widening radii
 * every frame — around eighteen full passes and seven full-screen composite
 * quads before a single entity was drawn. A glow is low-frequency by
 * definition, and the cheap way to make low frequencies is to *remove the high
 * ones*: downsample. Each mip is a bilinear halving of the one before, so the
 * chain costs a third of one half-resolution pass in total fill, and the wide
 * mips come out smoother than a large Gaussian run at 0.4 resolution ever did.
 *
 * The emissive container is deliberately NOT a child of the stage. It is
 * rendered manually into the target each frame; adding it to the stage as well
 * would draw everything twice.
 */
import {
  type Application,
  BlurFilter,
  Container,
  RenderTexture,
  Sprite,
  type Texture,
} from 'pixi.js';

/** Mip levels: 1/2 down to 1/32 of the emissive buffer. */
export const BLOOM_MIPS = 5;

export class BloomPipeline {
  /** Put everything that should glow in here. */
  readonly emissive = new Container();

  private texture: RenderTexture;
  private readonly mips: RenderTexture[] = [];
  /** One sprite, re-pointed for every downsample. A pass is a draw, not a node. */
  private readonly mipSprite = new Sprite();
  /**
   * A light blur at every halving. Plain bilinear downsampling leaves each mip
   * with square box artefacts that read as smearing rather than glow; a small
   * blur per level compounds down the chain into a properly smooth pyramid —
   * the wide mips come out Gaussian-soft for the cost of two passes over
   * textures that are already tiny.
   */
  private readonly mipBlur = new BlurFilter({ strength: 2, quality: 1 });
  /**
   * How many mips compose() refreshes — the bloom quality knob. Zero is bloom
   * off: the emissive still renders (entities live in it), the glow just has
   * no spread. The post pass masks the matching weights to zero, so a stale
   * mip is never read.
   */
  private active = BLOOM_MIPS;

  constructor(private readonly app: Application) {
    this.texture = RenderTexture.create({
      width: Math.max(1, app.screen.width),
      height: Math.max(1, app.screen.height),
      resolution: 1,
    });
    this.allocMips();
    this.mipSprite.filters = [this.mipBlur];
  }

  /**
   * The raw emissive layer, before any spread. Everything that glows, once.
   * The post pass composites it; the shell's ghost sprite additively revives
   * whatever the mass occludes.
   */
  get source(): Texture {
    return this.texture;
  }

  /** The mip chain, largest first. Length is always BLOOM_MIPS; see `active`. */
  get mipTextures(): readonly Texture[] {
    return this.mips;
  }

  get activeMips(): number {
    return this.active;
  }

  /** Quality: how many mips are refreshed. Clamped to [0, BLOOM_MIPS]. */
  setQuality(mips: number): void {
    this.active = Math.max(0, Math.min(BLOOM_MIPS, Math.floor(mips)));
  }

  private allocMips(): void {
    let w = Math.max(1, this.app.screen.width);
    let h = Math.max(1, this.app.screen.height);
    for (let i = 0; i < BLOOM_MIPS; i++) {
      w = Math.max(1, Math.round(w / 2));
      h = Math.max(1, Math.round(h / 2));
      this.mips.push(RenderTexture.create({ width: w, height: h, resolution: 1 }));
    }
  }

  resize(): void {
    const width = Math.max(1, this.app.screen.width);
    const height = Math.max(1, this.app.screen.height);
    if (this.texture.width === width && this.texture.height === height) return;
    this.texture.destroy(true);
    this.texture = RenderTexture.create({ width, height, resolution: 1 });
    for (const mip of this.mips) mip.destroy(true);
    this.mips.length = 0;
    this.allocMips();
  }

  /** Render the emissive layer and refresh the mip chain. Call once per frame. */
  compose(): void {
    this.app.renderer.render({
      container: this.emissive,
      target: this.texture,
      clear: true,
    });
    let src: Texture = this.texture;
    for (let i = 0; i < this.active; i++) {
      const target = this.mips[i]!;
      this.mipSprite.texture = src;
      this.mipSprite.width = target.width;
      this.mipSprite.height = target.height;
      this.app.renderer.render({ container: this.mipSprite, target, clear: true });
      src = target;
    }
  }
}
