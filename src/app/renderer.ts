/**
 * The renderer. GDD §16 (visual language) and §17 (motion and game feel).
 *
 * Dialect: blueprint structure, phosphor behaviour. The world draws like a
 * technical schematic — thin strokes, ticks, annotations — and behaves like a
 * living instrument: beam glow, phosphor trails, decay. No sprites, no textures,
 * ever (§24): every visual here is strokes, fills, glow and type.
 *
 * Two layers, because §16.1 says emissives bloom and structure doesn't:
 *   structure -> straight to screen (grid, ruins)
 *   emissive  -> render texture -> flat + blurred additive (BloomPipeline)
 *
 * The brightness hierarchy in §16.2 is a law, not a guideline: the player is the
 * only object at full luminance, so you can find yourself in any chaos.
 */
import { Application, Container, Graphics, Sprite, Text, Texture } from 'pixi.js';
import { TUNABLE } from '../sim/tunables';
import type { EnemyMark, Hue, LevelDef } from '../sim/types';
import type { Containment, TerminalKind, World } from '../sim/world';
import { enemy as getEnemy } from '../content/index';
import { Camera } from './camera';
import { BAND, HUE_COLOR, PALETTE, SHELL, VIEW, VISUAL, sampleGate } from './visual';
import { Glass, chromeGlass, type GlassSettings } from './ui';
import { PostPass } from './gfx/post';
import { LightField } from './gfx/lights';
import { MaskField } from './gfx/mask';
import { BloomPipeline } from './gfx/bloom';
import { GpuTimer } from './gfx/gputimer';
import { DisplayPass } from './gfx/display';
import { GFX, type GraphicsSettings } from './gfx/quality';
import {
  StructurePass,
  type MaterialZone,
  type ShellSeal,
  type ShellWall,
  type ShellWarp,
} from './gfx/structure';
import { ParticleField } from './gfx/particles';
import { ENEMY_PAINT, drawEnemyBody, drawEnemyMarks } from './gfx/enemy';
import { arcSegment, polygonPath, shapeCoreRadius, shapeOutline } from './gfx/shapes';

/**
 * The filament colour of a shot: its hue, most of the way to white.
 *
 * Not white itself. A pure white core reads as "a white dot with a coloured
 * glow" and loses the hue exactly where the eye is looking — which matters here,
 * because §16.3 makes hue mean *damage class*. Keeping a quarter of the hue in
 * the core is enough to tell a thermal bolt from a voltaic one at a glance while
 * still blowing past the tonemap's knee, which is what "hot" means optically.
 */
const HOT_CORE: Record<Hue, number> = {
  thermal: 0xffe6b0,
  voltaic: 0xd0fbff,
  void: 0xf0daff,
};

/** Most lights one Arc contributes, however many times it actually bounced. */
const CHAIN_LIGHT_HOPS = 6;

/**
 * How long a detonation's picture will wait for the grid. See `waitingForBeat`.
 *
 * 45ms is roughly where a visual delay stops being invisible and starts being
 * felt, and it is a third of a sixteenth at this tempo — so about a third of all
 * detonations get pulled onto the beat and the rest are untouched. Raising it
 * catches more of them and starts costing responsiveness; this is the trade, and
 * it is the reason the whole thing is a toggle.
 */
const BEAT_SNAP = 0.045;

const VIEW_HEIGHT = 900;
const VIEW_WIDTH_MIN = 1200;
const VIEW_WIDTH_MAX = 1900;

/**
 * §11.4 — how each Containment hazard draws.
 *
 * The sim half of this became a registry in `hazards.ts`; this is the other half
 * the old `if (c.kind === …)` chain was split across. Adding a hazard is now one
 * entry there and one here, and a coverage test asserts the two vocabularies
 * agree — a hazard the sim can spawn and the renderer cannot draw is invisible
 * damage, which is the worst failure this system has.
 */
interface HazardDrawCtx {
  g: Graphics;
  c: Containment;
  arena: { width: number; height: number };
  arming: boolean;
  alpha: number;
  width: number;
  color: number;
}

export const HAZARD_DRAW: Record<string, (d: HazardDrawCtx) => void> = {
  sweeper: ({ g, c, arena, alpha, width, color }) => {
    const horizontal = c.dirX !== 0;
    const half = TUNABLE.sweeperGapWidth / 2;
    if (horizontal) {
      g.moveTo(c.x, 0).lineTo(c.x, c.gapAt - half);
      g.moveTo(c.x, c.gapAt + half).lineTo(c.x, arena.height);
    } else {
      g.moveTo(0, c.y).lineTo(c.gapAt - half, c.y);
      g.moveTo(c.gapAt + half, c.y).lineTo(arena.width, c.y);
    }
    g.stroke({ width, color, alpha });
    // Mark the gap: the answer is always visible.
    if (horizontal) {
      g.moveTo(c.x - 14, c.gapAt - half).lineTo(c.x + 14, c.gapAt - half);
      g.moveTo(c.x - 14, c.gapAt + half).lineTo(c.x + 14, c.gapAt + half);
    } else {
      g.moveTo(c.gapAt - half, c.y - 14).lineTo(c.gapAt - half, c.y + 14);
      g.moveTo(c.gapAt + half, c.y - 14).lineTo(c.gapAt + half, c.y + 14);
    }
    g.stroke({ width: 1.5, color: PALETTE.beacon, alpha: BAND.inFlight });
  },

  cell: ({ g, c, alpha, width, color }) => {
    const segments = 48;
    for (let i = 0; i < segments; i++) {
      const a0 = (i / segments) * Math.PI * 2;
      const a1 = ((i + 1) / segments) * Math.PI * 2;
      const mid = (a0 + a1) / 2;
      if (c.gapAngles.some((gap) => Math.abs(angleDiff(mid, gap)) < 0.34)) continue;
      arcSegment(g, c.x, c.y, c.radius, a0, a1);
    }
    g.stroke({ width, color, alpha });
  },

  nullfront: ({ g, c, arena, arming, alpha, width, color }) => {
    const depth = c.advance;
    if (depth <= 1) return;
    if (c.dirX > 0) g.rect(0, 0, depth, arena.height);
    else if (c.dirX < 0) g.rect(arena.width - depth, 0, depth, arena.height);
    else if (c.dirY > 0) g.rect(0, 0, arena.width, depth);
    else g.rect(0, arena.height - depth, arena.width, depth);
    g.fill({ color: PALETTE.signal, alpha: 0.1 * (arming ? 0.3 : 1) });

    // Leading edge, drawn hard so the boundary is unmistakable.
    if (c.dirX > 0) g.moveTo(depth, 0).lineTo(depth, arena.height);
    else if (c.dirX < 0) g.moveTo(arena.width - depth, 0).lineTo(arena.width - depth, arena.height);
    else if (c.dirY > 0) g.moveTo(0, depth).lineTo(arena.width, depth);
    else g.moveTo(0, arena.height - depth).lineTo(arena.width, arena.height - depth);
    g.stroke({ width, color, alpha });
  },
};

export class Renderer {
  readonly app = new Application();
  /**
   * Every filed document drawn during a run — the engine editor, the draft, the
   * pause sheet, the report — on its own layer above the arena, wearing the
   * player's tube.
   *
   * Phosphor and scanlines used to be shell-only, so an operator on amber started
   * a shift and the run's own paperwork came back in colour on a flat panel. The
   * arena is deliberately *not* on this layer: see `uiglass.ts` for why a
   * monochrome arena would delete a channel the player reads threats with.
   */
  readonly chromeLayer = new Container();
  private readonly chromeTube = new Glass();
  /**
   * The same tube, over the arena.
   *
   * **The trade is accepted deliberately.** `PHOSPHOR` warns that on one phosphor
   * there is no difference between thermal and signal red, and §16.3 makes the fuel
   * hues *mean elements* — so an amber arena genuinely costs the player a channel
   * they read threats with. That is the point: the operator chose a monochrome
   * tube, and a monochrome tube is worse at this job. It is a setting, not a
   * difficulty, and the game does not get to quietly opt out of it on the one
   * surface where it would be felt.
   */
  private readonly arenaTube = new Glass();
  /** Whether the arena tube is worth its pass — false on the colour phosphor. */
  private arenaTubeOn = false;
  camera!: Camera;

  private bloom!: BloomPipeline;
  private readonly post = new PostPass();
  /**
   * §20.1 — the operator's panel, applied to the finished frame.
   *
   * On the *stage*, not on the world group, and that is the whole point of it
   * being a separate pass from `post`: post runs under the mass so that a light
   * cannot lift a slab from beneath it, which means everything post touches is
   * only part of the picture. A display correction that missed the mass, the
   * indicators and the sheets would be a correction that made the arena legible
   * and left the walls black.
   */
  private readonly display = new DisplayPass();
  private displayOn = false;
  private lights!: LightField;
  private masks!: MaskField;
  private readonly particles = new ParticleField();

  /** Non-blooming schematic: the arena's structure. */
  /** Everything that emits light. Lives inside the bloom pipeline. */
  private readonly worldLayer = new Container();
  private readonly screenLayer = new Container();

  /**
   * The shell: floor, grid, ruins and the arena wall, as one distance field —
   * rendered in two halves.
   *
   * The ground has to be under the ship and the mass has to be over it, so that
   * walking beneath an overhanging slab puts you beneath it. One sprite cannot
   * be on both sides of the entity layer, so the same field runs twice: the
   * floor pass opaque and below, the mass pass alpha-blended and above. The
   * floor pass never touches a block, so the second pass is most of the cost
   * either way.
   *
   * Both are full-screen sprites that exist only to carry a filter — the shader
   * ignores what it samples and writes the surface from scratch. They sit
   * outside the transformed layers because they do their own world mapping: the
   * camera arrives as two uniforms, so the pattern is anchored in world space
   * rather than dragged around by a transform.
   */
  private readonly shellFloor = new StructurePass();
  private readonly shellMass = new StructurePass();
  private readonly floorSprite = new Sprite(Texture.WHITE);
  private readonly massSprite = new Sprite(Texture.WHITE);
  /** A faint copy of every emissive, over the mass. See init. */
  private readonly ghostSprite = new Sprite();
  /**
   * Everything the post pass is allowed to touch.
   *
   * The filter used to be on the stage itself, which put the shell's mass
   * *inside* it — so `uLit` lit the slab from underneath by the player standing
   * beneath it, and haze went straight through it. Both are light, and light
   * has no business reaching the far side of a solid thing. The mass, the ghost
   * and the HUD are siblings of this group, above it and beyond its reach.
   */
  private readonly worldGroup = new Container();
  /** Per-gate opening animation, 0..1, keyed by gate id. Renderer-local. */
  private readonly gateOpen = new Map<string, number>();
  private readonly wallScratch: ShellWall[] = [];
  /** Shake asked for by a gate this frame, from its sequence. */
  private gateShake = 0;
  private readonly gBeacons = new Graphics();
  private readonly gContainment = new Graphics();
  private readonly gZones = new Graphics();
  private readonly gPickups = new Graphics();
  private readonly gPlaced = new Graphics();
  private readonly gDebris = new Graphics();
  private readonly gEnemies = new Graphics();
  private readonly gProjectiles = new Graphics();
  private readonly gFx = new Graphics();
  private readonly gPlayer = new Graphics();
  private readonly gIndicators = new Graphics();
  /**
   * An opaque backdrop, first in the stage.
   *
   * A filter renders its subject into a *transparent* texture before shading it.
   * Half this game composites additively, and additive blending against
   * transparency does not produce the same result as additive blending against
   * the opaque canvas — the accumulated alpha comes out low, so the whole scene
   * arrives faded and every enemy looks see-through. Painting a solid rectangle
   * underneath everything gives the filter something to blend onto and the
   * problem disappears.
   *
   * `renderer.background` cannot do this job: it clears the canvas, not the
   * filter's render target.
   */
  private readonly backdrop = new Sprite(Texture.WHITE);

  private viewWidth = VIEW_WIDTH_MIN;
  private readonly beaconLabels: Text[] = [];
  /** §17.1 — floating damage-taken numbers. Pooled: Text allocation is not free. */
  private readonly hurtLabels: { text: Text; life: number; x: number; y: number }[] = [];

  /** §17.2 — screenshake: tiny, frequent, hard ceiling regardless of chaos. */
  private shake = 0;
  private shakeX = 0;
  private shakeY = 0;
  private jitterSeed = 1;
  /** The avatar's drawn position: the sim's, interpolated across the tick. */
  private playerX = 0;
  private playerY = 0;
  /** Where world (0,0) sits on screen, and pixels per world unit. */
  private originX = 0;
  private originY = 0;
  private originScale = 1;
  /**
   * What the GPU actually costs. CPU timing around a draw call measures queuing,
   * not work — see gfx/gputimer.ts for the mistake that made this necessary.
   */
  gpu!: GpuTimer;
  /** §21b.4 — the background colour, easing toward the current biome's. */
  private tint: number = PALETTE.background;
  /**
   * Put the player's tube on the run's paperwork. Called at start and whenever the
   * configuration sheet moves — the same style the desk uses, from one function.
   */
  setChromeGlass(s: GlassSettings): void {
    this.chromeTube.set(chromeGlass(s));
    // The arena takes the phosphor but not the scanlines: the mass is already a
    // field of hairline blocks on a grid, and a scanline over it is moiré.
    const arena = chromeGlass(s);
    this.arenaTube.set({ mono: arena.mono, tint: arena.tint, scan: 0 });
    // A colour tube is the identity, and the identity is a full-screen pass
    // nobody should pay for — the same discipline display.ts holds itself to.
    this.arenaTubeOn = (arena.mono ?? 0) > 0;
    this.syncWorldFilters();
  }

  private syncWorldFilters(): void {
    this.worldGroup.filters = this.arenaTubeOn
      ? [this.post.filter, this.arenaTube.filter]
      : [this.post.filter];
  }

  /** Both halves of the shell, for the many settings they share. */
  private get shells(): readonly StructurePass[] {
    return [this.shellFloor, this.shellMass];
  }

  private shellTint: number = PALETTE.background;
  private shellTintAmount = 0;
  /** Monotonic quarter-notes, and the last in-bar reading it came from. */
  private quarter = 0;
  private lastQuarterInBar = -1;
  /** §16.6 — how far the camera has pulled back. See updateZoom. */
  private zoom = 1;
  /** Shared phase for the loot pulse — see drawPickups. Presentation only. */
  private lootPhase = 0;
  /**
   * The avatar's animation state (§16.4). Presentation only, and deliberately
   * *not* in the sim: a smoothed heading that fed back into movement would make
   * the run depend on frame timing, which is the one thing determinism forbids.
   */
  private facing = 0;
  private bank = 0;
  private thrust = 0;
  private pulsePhase = 0;
  /** Visible enemies this frame, and their outlines. Reused; see drawEnemies. */
  private readonly enemyScratch: World['enemies'] = [];
  private readonly outlineScratch: [number, number][][] = [];
  /** §11.2 — suppression fields, in screen pixels. Reused; see emitGlitchFields. */
  private readonly glitchFields: { x: number; y: number; radius: number; strength: number }[] = [];
  /**
   * Where the soundtrack is, this frame. Null when nothing is playing, which is
   * what makes every use of it degrade to "no pulse" rather than to a guess.
   */
  private beat: { beat: number; pulse: number; bpm: number } | null = null;
  /**
   * §18.2 — nudge a detonation's *picture* onto the next sixteenth.
   *
   * The sim resolves on time; only the flash waits. Presentation-only by
   * construction: nothing here reaches the sim, the world is not mutated, and
   * turning it off changes nothing but when a ring appears.
   *
   * It is a **snap window, not a quantizer**, and that distinction is the whole
   * design. A sixteenth at 112 BPM is 134ms — quantizing every detonation to the
   * grid would delay half of them by more than a tenth of a second, which is not
   * "feels musical", it is "feels broken". So: if a burst lands within
   * `BEAT_SNAP` of the next sixteenth it waits for it, and otherwise it draws
   * immediately. Near-misses get pulled into line, everything else is untouched,
   * and the worst case anyone ever waits is the window itself.
   */
  private beatSync = true;
  private readonly held = new Map<number, number>();
  /** Renderer-local seconds. Only ever compared against itself. */
  private clock = 0;

  async init(mount: HTMLElement, world: World, graphics: GraphicsSettings): Promise<void> {
    this.camera = new Camera(world.arena);

    await this.app.init({
      background: PALETTE.background,
      resizeTo: window,
      // MSAA is off unless asked for. The world is composed from render
      // textures, so multisampling the canvas was resolving a retina
      // framebuffer to antialias a dozen quad edges and the indicator strokes
      // — see gfx/quality.ts. A context attribute, so it holds for the run.
      antialias: graphics.msaa,
      autoDensity: true,
      resolution: Math.min(Math.max(1, graphics.renderScale), window.devicePixelRatio || 1),
      // We present the frame ourselves, from the game loop, so the GPU timer can
      // bracket exactly one frame's passes. Pixi's own ticker would also fire
      // between our passes — bloom and the light field each call `render()` into
      // a texture — and a timer query cannot nest.
      autoStart: false,
    });
    this.app.ticker.stop();
    mount.appendChild(this.app.canvas);

    this.bloom = new BloomPipeline(this.app);
    this.gpu = new GpuTimer(this.app);

    this.lights = new LightField(this.app);
    this.post.setLightTexture(this.lights.source);
    this.masks = new MaskField(this.app);
    this.post.setMaskTexture(this.masks.source);
    this.post.setBloomTextures(this.bloom.source, this.bloom.mipTextures);

    this.floorSprite.filters = [this.shellFloor.filter];
    this.massSprite.filters = [this.shellMass.filter];
    for (const shell of this.shells) {
      shell.setPalette(PALETTE.structure, PALETTE.background, PALETTE.mass);
      shell.setStyle(SHELL);
      shell.setArena(world.arena.width, world.arena.height);
      shell.setMaterialZones(
        {
          oil: SHELL.oil,
          fray: SHELL.fray,
          dissolve: SHELL.dissolve + siteFloor(world),
          decay: SHELL.decay,
          shred: SHELL.shred,
        },
        materialZonesFor(world),
      );
    }
    this.shellFloor.setMode(0);
    this.shellMass.setMode(1);
    this.shellMass.setLight(
      this.lights.source,
      SHELL.massLit,
      this.app.screen.width,
      this.app.screen.height,
    );

    // §16.2 — you must always be able to find yourself.
    //
    // The mass is drawn over the entities so an overhang occludes what walks
    // under it, and that worked too well: the ship disappeared outright while
    // its light carried on through, because the light field is added later over
    // everything. A silhouette that vanishes while its glow does not is worse
    // than either alone.
    //
    // So a faint additive copy of the whole emissive layer sits on top of the
    // mass. Under a slab it is the only thing visible and reads as an outline;
    // over open floor it lands on strokes that are already drawn and does
    // nothing but lift them a little. One sprite, and it treats the player and
    // the enemies identically, which is the point — both are under there.
    this.ghostSprite.texture = this.bloom.source;
    this.ghostSprite.blendMode = 'add';
    this.ghostSprite.alpha = SHELL.ghost;

    this.worldLayer.addChild(
      this.gBeacons,
      this.gContainment,
      this.gZones,
      this.gPickups,
      this.gPlaced,
      this.gDebris,
      this.gFx,
      this.gEnemies,
      this.gProjectiles,
      this.gPlayer,
    );
    this.bloom.emissive.addChild(this.worldLayer);
    this.screenLayer.addChild(this.gIndicators);

    this.backdrop.tint = PALETTE.background;
    // Everything the post pass may touch goes in the group; everything that must
    // stay beyond the reach of light goes above it. The emissive layer is no
    // longer a child — the post pass composites it from the bloom buffers, so
    // the group is just the opaque underlay: backdrop and floor.
    this.worldGroup.addChild(this.backdrop, this.floorSprite);
    this.app.stage.addChild(
      this.worldGroup,
      // Above the entities *and* above post, so an overhanging slab occludes the
      // ship walking beneath it and no amount of light can lift it from below.
      this.massSprite,
      this.ghostSprite,
      this.screenLayer,
      this.chromeLayer,
    );
    this.chromeLayer.filters = [this.chromeTube.filter];
    // Everything the run draws that is not paperwork. Post always runs — it is
    // the compositor now, not an effect — and the arena's tube joins it only
    // when the phosphor is actually monochrome; installed here once, because a
    // per-frame filters assignment was how the tube got silently stomped.
    this.syncWorldFilters();

    this.layout();
    this.camera.snapTo(world.player.x, world.player.y);
    window.addEventListener('resize', () => this.layout());
  }

  private layout(): void {
    const aspect = this.app.screen.width / Math.max(1, this.app.screen.height);
    this.viewWidth = Math.min(VIEW_WIDTH_MAX, Math.max(VIEW_WIDTH_MIN, VIEW_HEIGHT * aspect));
    this.camera.setViewSize(this.viewWidth, VIEW_HEIGHT);
    this.backdrop.width = this.app.screen.width;
    this.backdrop.height = this.app.screen.height;
    for (const sprite of [this.floorSprite, this.massSprite]) {
      sprite.width = this.app.screen.width;
      sprite.height = this.app.screen.height;
    }
    this.bloom.resize();
    this.lights?.resize();
    this.masks?.resize();
    // The bloom buffers are recreated on resize, so everything holding one has
    // to be re-pointed or it keeps drawing the old frame forever.
    if (this.bloom) {
      this.ghostSprite.texture = this.bloom.source;
      this.post.setBloomTextures(this.bloom.source, this.bloom.mipTextures);
    }
    if (this.lights) this.post.setLightTexture(this.lights.source);
    if (this.lights) {
      this.shellMass.setLight(
        this.lights.source,
        SHELL.massLit,
        this.app.screen.width,
        this.app.screen.height,
      );
    }
    if (this.masks) this.post.setMaskTexture(this.masks.source);
  }

  /** Visible world size right now, zoom included. */
  private get viewW(): number {
    return this.viewWidth * this.zoom;
  }

  private get viewH(): number {
    return VIEW_HEIGHT * this.zoom;
  }

  private get scale(): number {
    return Math.min(this.app.screen.width / this.viewW, this.app.screen.height / this.viewH);
  }

  /**
   * §16.6 — the camera gives ground as the Engine takes it.
   *
   * A recorded run measured 2,368 EPS with a beam build, and most of what it
   * killed died off-screen: somewhere around four minutes the arena the player
   * could see stopped containing the fight. Much shorter base ranges are the
   * real fix; this is the other half, because an Engine that has drafted Reach
   * three times has *bought* its reach and should get to watch it work.
   *
   * So the view widens with output, and barely: twelve per cent at full tilt,
   * approached over seconds. Enough that a busy screen breathes, far too little
   * to read as the camera moving — which it must not, since §16.2's whole
   * bargain is that the player can always find themselves.
   */
  private updateZoom(world: World, dt: number): void {
    const load = Math.min(1, world.eps / 400);
    const target = 1 + load * 0.12;
    this.zoom += (target - this.zoom) * Math.min(1, dt * 0.6);
    this.camera.setViewSize(this.viewW, this.viewH);
  }

  /** Apply the shared world->screen transform to every layer that needs it. */
  private applyTransform(): void {
    const scale = this.scale;
    const offsetX = (this.app.screen.width - this.viewW * scale) / 2 + this.shakeX;
    const offsetY = (this.app.screen.height - this.viewH * scale) / 2 + this.shakeY;
    const worldX = this.viewW / 2 - this.camera.x;
    const worldY = this.viewH / 2 - this.camera.y;

    for (const layer of [this.worldLayer]) {
      layer.scale.set(scale);
      layer.position.set(offsetX + worldX * scale, offsetY + worldY * scale);
    }
    this.screenLayer.scale.set(scale);
    this.screenLayer.position.set(offsetX, offsetY);

    // The same mapping the layers just took, kept as numbers for the shell —
    // which has no transform and needs the camera as uniforms.
    this.originX = offsetX + worldX * scale;
    this.originY = offsetY + worldY * scale;
    this.originScale = scale;
  }

  // ------------------------------------------------------------------- frame

  /**
   * Hand the renderer the audio clock. Presentation reading presentation — the
   * sim never learns any of this exists, which is the same wall §18 already has.
   */
  setBeat(beat: { beat: number; pulse: number; bpm: number } | null): void {
    this.beat = beat;
  }

  /**
   * A monotonic count of quarter-notes, which the audio clock does not provide.
   *
   * `beat.beat` is sixteenths *within the bar*, so it wraps to zero four times a
   * measure — hand that straight to the shell and every block in the arena
   * re-rolls to the same four values forever. Unwrapping it here is what lets
   * the architecture keep going somewhere instead of looping.
   *
   * With the audio off it free-runs at the arrangement's base tempo, because a
   * muted player should still see the room move.
   */
  private advanceQuarter(dt: number): void {
    const beat = this.beat;
    if (!beat) {
      this.quarter += (dt * 112) / 60;
      this.lastQuarterInBar = -1;
      return;
    }
    const inBar = beat.beat / 4;
    if (this.lastQuarterInBar >= 0) {
      const step = inBar - this.lastQuarterInBar;
      // A negative step is the bar wrapping; anything else is ordinary progress.
      this.quarter += step < 0 ? step + 4 : step;
    }
    this.lastQuarterInBar = inBar;
  }

  setBeatSync(on: boolean): void {
    this.beatSync = on;
    if (!on) this.held.clear();
  }

  /**
   * Is this detonation's picture still waiting for the grid?
   *
   * First sighting registers a release time; every frame after that compares
   * against it. With nothing playing there is no grid to wait for, so it returns
   * false immediately and the effect is exactly as it was before this existed.
   */
  private waitingForBeat(id: number): boolean {
    if (!this.beatSync || !this.beat) return false;
    let release = this.held.get(id);
    if (release === undefined) {
      const step = 60 / this.beat.bpm / 4;
      const toNext = (1 - (this.beat.beat % 1)) * step;
      release = this.clock + (toNext <= BEAT_SNAP ? toNext : 0);
      this.held.set(id, release);
    }
    return this.clock < release;
  }

  /** Ids whose moment has long passed. Bounded without touching the sim. */
  private pruneHeld(): void {
    if (this.held.size < 256) return;
    for (const [id, release] of this.held) {
      if (this.clock - release > 2) this.held.delete(id);
    }
  }

  /**
   * `alpha` is how far into the current simulation tick the display is, 0..1.
   *
   * Everything the sim owns moves in 60Hz steps; the display runs at whatever
   * the monitor does. The avatar is the one object on screen the player's eye is
   * locked to, and it sits still in the middle of a world that slides — so its
   * 60Hz stepping reads as *the character* being laggy while the horde looks
   * fine. Interpolating between the last two ticks fixes it, and interpolating
   * rather than extrapolating means never showing a position the run did not
   * actually have.
   */
  render(world: World, frameDt: number, cameraActive: boolean, alpha = 1): void {
    // The bracket opens here rather than in present() so the light, mask,
    // emissive and mip passes are inside it — they are GPU work this frame
    // asked for, and a timer that misses them once reported a clean 0.93ms
    // while the pre-passes did whatever they liked.
    this.gpu.begin();
    // The live quality — the governor's rung in auto mode, the player's exact
    // knobs in custom. Cheap to apply every frame, and applying it every frame
    // is what makes a mid-run settings change land without a hook.
    this.bloom.setQuality(GFX.bloomMips);
    this.lights.setBudget(GFX.lightBudget);

    const p = world.player;
    this.playerX = p.prevX + (p.x - p.prevX) * alpha;
    this.playerY = p.prevY + (p.y - p.prevY) * alpha;
    if (cameraActive) {
      this.camera.follow(this.playerX, this.playerY, p.dirX, p.dirY, frameDt);
    }

    this.clock += frameDt;
    this.pruneHeld();
    this.drainDeaths(world);
    this.drainHurts(world, frameDt);
    this.trackDash(world);
    this.particles.update(frameDt);
    this.lootPhase += frameDt * 3.6;
    this.updateShake(frameDt);
    this.updateZoom(world, frameDt);
    this.applyTransform();

    const heat = Math.min(1, world.budget.heat / 100);
    const tier = world.budget.tier;

    this.gateShake = 0;
    this.updateLevelBounds(world);
    this.updateShell(world, frameDt);
    this.drawTerminals(world);
    this.drawContainment(world);
    this.drawZones(world);
    this.drawPickups(world);
    this.drawPlaced(world);
    this.drawDebris();
    this.drawEnemies(world);
    this.drawProjectiles(world, tier);
    this.drawFx(world);
    this.drawPlayer(world, heat, frameDt);
    this.drawIndicators(world);

    // §16.7 — one ordered ladder serves both Heat (temporary, local) and
    // Meltdown (permanent, escalating). Meltdown intensity climbs without limit
    // and the renderer becomes the doom clock (§13.2).
    const melt = world.phase === 'meltdown' ? Math.min(1.6, world.meltdownTime / 360) : 0;

    this.post.setAberrationFringe(Math.min(1, (tier >= 2 ? 0.5 + 0.5 * heat : 0) + melt * 0.55));
    this.post.setTear(world.budget.stalled ? (this.jitter(1) > 0 ? 1 : -1) * 0.6 : melt * 0.12);
    this.post.setBloom(
      VISUAL.bloomIntensity * VIEW.bloom * (1 + heat * 0.35 + melt * 0.5),
      this.bloom.activeMips,
    );
    this.post.setGlow(VIEW.glow);
    // Step 5: the background lightens toward white as the final minutes approach.
    // The world overexposes.
    // §21b.4 — the biome you are standing in tints the world. Approached rather
    // than snapped, so crossing a boundary reads as walking into somewhere.
    // §21b — the room you are in colours its structure. A biome overrides the
    // level when you are standing in one, so a Freezer inside a level still
    // reads as the Freezer.
    const biome = world.biome;
    const level = world.currentLevel;
    const biomeTint = biome?.tint ?? level?.tint ?? PALETTE.background;
    this.tint = mix(this.tint, biomeTint, Math.min(1, frameDt * 1.5));
    // The shell takes the biome as a colour over the whole surface, so a biome
    // is the room being a different room rather than a slightly different black
    // showing through the gaps in the grid.
    //
    // LEVELS §3.2 — the ramp keys on the *level's* tint as well as the biome's.
    // It used to key on biomes alone, and no shipped arena has ever authored a
    // biome, so every per-level tint in arenas.json was validated, loaded, and
    // then mixed at amount zero: authored, and visually inert. Levels ramp to a
    // gentler amount than biomes — a room is a place, a biome is a rule.
    this.shellTint = mix(this.shellTint, biomeTint, Math.min(1, frameDt * 1.5));
    const tintAmount = biome ? 0.5 : level?.tint !== undefined ? 0.35 : 0;
    this.shellTintAmount += (tintAmount - this.shellTintAmount) * Math.min(1, frameDt * 1.5);
    for (const shell of this.shells) shell.setTint(this.shellTint, this.shellTintAmount);
    this.applyRoomStyle(level);

    // The screen-space "biome field" programs (frost, ember, static) were
    // removed per STORY-AND-TONE §8.1 — they read as a cartoon, and authored
    // set-dressing does not belong on the lens. The descent lives ON the ruins
    // (structure shader), and screen space gets exactly one honest category:
    // weather, built in the effects pass that replaced this block.
    const background = mix(this.tint, 0x243044, Math.min(0.85, melt * 0.55));
    this.app.renderer.background.color = background;
    this.backdrop.tint = background;
    // §16.7 — the degradation ladder pushes whatever preset the player chose
    // further than they asked, which is how Heat and Meltdown stay legible as
    // *damage to the picture* rather than as a separate effect.
    this.emitGlitchFields(world);
    this.emitLights(world, heat, melt, frameDt);
    this.emitState(world);
    this.post.update(
      VIEW,
      Math.max(heat * 0.6, melt),
      frameDt,
      this.app.screen.width,
      this.app.screen.height,
    );
    // The pass always runs now — it is the compositor that puts the emissive
    // layer and its bloom over the floor, not an optional effect. The old "all
    // effects off" skip has nothing left to skip: with every knob at zero the
    // shader is a composite and a handful of dead branches.

    this.bloom.compose();
  }

  /**
   * §16.1 — everything that emits, emitting.
   *
   * The rule for what gets a light and how big: it is the *thing itself*, at
   * roughly the size it occupies, with brightness standing in for how much it
   * matters. A detonation is enormous and brief; a fuel mote is tiny and
   * constant; the player is the only steady source in the arena, which is the
   * §16.2 brightness hierarchy expressed as illumination rather than as alpha.
   *
   * Skipped entirely when the preset asks for no lighting — a Schematic run
   * should not pay for a buffer nobody samples.
   */
  private emitLights(world: World, heat: number, melt: number, dt: number): void {
    if (VIEW.lit <= 0 && VIEW.haze <= 0) return;
    const lights = this.lights;
    lights.begin();

    // Every light here is deliberately faint, and every one of them is culled
    // against the camera. The field's exposure will pull a busy frame back on
    // its own, but exposure spends its range on *overlap*, and a light that is
    // off screen contributes nothing but load.
    //
    // The player is wide and dim: it is on screen every frame in the same place,
    // so a hot core would be a permanent hole in the middle of the picture.
    //
    // Its halo is the one light on the beat. Small — a tenth on the quarter —
    // but it is the light you are always looking at, so it is where an entrained
    // pulse is felt rather than noticed.
    const pulse = this.beat ? this.beat.pulse : 0;
    lights.point(
      world.player.x,
      world.player.y,
      340 * (1 + pulse * 0.06),
      PALETTE.player,
      (0.2 + heat * 0.12) * (1 + pulse * 0.28),
    );

    // Detonations and impacts. Short-lived and huge — a Nova should visibly
    // flood the room it went off in, which is most of what "excitement" means.
    for (const fx of world.fx) {
      if (!fx.alive) continue;
      const t = Math.max(0, fx.life / fx.maxLife);

      // An Arc is a polyline, and lighting it as a disc at its origin throws
      // away the only interesting thing about it. Each hop lights the air it
      // crossed, which is what makes a chain read as something that *travelled*.
      if (fx.kind === 'chain') {
        const points = fx.points;
        const hops = Math.max(1, points.length / 2 - 1);
        // A deep Echo chain can be forty hops long, and forty hops times forty
        // simultaneous chains is where a light *field* turns into a light *list*.
        // Sampling every nth hop keeps the arc lit end to end at a bounded cost;
        // the ones in between are a few pixels from a segment that is already
        // lighting them.
        const stride = Math.max(1, Math.ceil(hops / CHAIN_LIGHT_HOPS)) * 2;
        for (let i = 0; i + 3 < points.length; i += stride) {
          const x0 = points[i]!;
          const y0 = points[i + 1]!;
          const x1 = points[i + 2]!;
          const y1 = points[i + 3]!;
          if (!this.camera.isVisible((x0 + x1) / 2, (y0 + y1) / 2, 320)) continue;
          lights.beam(x0, y0, x1, y1, 110, HUE_COLOR[fx.hue], t * t * 0.5);
        }
        continue;
      }

      if (!this.camera.isVisible(fx.x, fx.y, fx.radius * 2 + 160)) continue;
      // Held with its ring, or the room would light up before the thing lighting
      // it appeared.
      if ((fx.kind === 'burst' || fx.kind === 'rupture') && this.waitingForBeat(fx.id)) continue;
      // Big and brief. A detonation's light should be gone before the next one
      // lands, or a fast engine simply holds the whole arena at maximum.
      //
      // A point, not an area, and that distinction is the difference between the
      // old flat blob and something worth looking at. A detonation is *hottest
      // at its centre*, and it is that gradient which survives fourteen of them
      // overlapping — an even disc has no interior left to lose, so a wall of
      // them is one shape. Areas are for things that genuinely are regions.
      const radius = Math.max(70, fx.radius * 1.7) * (1.3 - t * 0.3);
      lights.point(fx.x, fx.y, radius, HUE_COLOR[fx.hue], t * t * 0.5);
    }

    // Every shot is a lamp, and a lamp moving at 1400 units/s covers twenty-odd
    // units between frames. Lighting the disc it stopped in gives a dotted line
    // of glows; lighting the streak gives a shot that draws light behind it.
    //
    // Two lights per shot, not one, and that is the whole difference between a
    // glowing pellet and something *hot*. A wide, dim, hue-coloured halo is what
    // the air around a bolt does; a narrow, fierce, near-white core is the bolt
    // itself. One light can be either but never both — widen it and the shot
    // turns into a soft cloud, brighten it and the cloud turns into a flat disc.
    // Real emitters read as hot because their centre is *out of range* of the
    // film while their surroundings are not, and stacking these two gives the
    // tonemap exactly that: a core that clips to white over a halo that keeps
    // its colour.
    for (const proj of world.projectiles) {
      if (!proj.alive || !this.camera.isVisible(proj.x, proj.y, 200)) continue;
      const speed = Math.sqrt(proj.vx * proj.vx + proj.vy * proj.vy);
      const trail = Math.min(190, speed * 0.055);
      const hue = HUE_COLOR[proj.hue];
      if (trail < 24) {
        // Sized to the shot, not to a constant.
        //
        // This was a flat radius 95 halo whatever the projectile was, so a slow
        // one — a Siphon, anything Slugged — became a round blob several times
        // its own body with a hard bright dot in the middle, while the identical
        // projectile moving faster took the streak branch and looked like a
        // shot. Same object, two completely different readings, decided by a
        // speed threshold the player cannot see.
        const halo = Math.max(34, proj.radius * 7);
        lights.point(proj.x, proj.y, halo, hue, 0.13);
        lights.point(proj.x, proj.y, Math.max(9, proj.radius * 1.9), HOT_CORE[proj.hue], 0.75);
      } else {
        const k = trail / Math.max(1, speed);
        const tx = proj.x - proj.vx * k;
        const ty = proj.y - proj.vy * k;
        lights.beam(tx, ty, proj.x, proj.y, 150, hue, 0.13);
        // The core is shorter than the halo as well as thinner: the filament is
        // at the head, and the streak behind it is what the filament left.
        lights.beam(
          proj.x - proj.vx * k * 0.45,
          proj.y - proj.vy * k * 0.45,
          proj.x,
          proj.y,
          22,
          HOT_CORE[proj.hue],
          0.8,
        );
      }
    }

    for (const zone of world.zones) {
      if (!zone.alive || !this.camera.isVisible(zone.x, zone.y, zone.radius + 200)) continue;
      const t = Math.max(0, zone.life / zone.maxLife);
      lights.area(zone.x, zone.y, zone.radius * 1.4, HUE_COLOR[zone.hue], 0.17 * t);
    }

    for (const m of world.mines) {
      if (!m.alive || !this.camera.isVisible(m.x, m.y, 140)) continue;
      lights.point(m.x, m.y, 80, HUE_COLOR[m.hue], m.arm <= 0 ? 0.16 : 0.07);
    }

    for (const o of world.orbitals) {
      const ox = world.player.x + Math.cos(o.angle) * o.orbitRadius;
      const oy = world.player.y + Math.sin(o.angle) * o.orbitRadius;
      lights.point(ox, oy, 85, HUE_COLOR[o.hue], 0.16);
    }

    // Enemies carry their own dim glow, so a horde lights the ground it walks
    // over. This is the one that makes a crowd feel like a crowd.
    for (const e of world.enemies) {
      if (!e.alive || !this.camera.isVisible(e.x, e.y, 120)) continue;
      lights.point(e.x, e.y, e.radius * 4, HUE_COLOR[e.hue], e.flash > 0 ? 0.35 : 0.09);

      // §10.2 Lancer — the corridor is the whole threat, so it is the one enemy
      // telegraph that lights the room. It brightens as the charge completes,
      // which puts the warning in the light rather than only in the line.
      if (e.beamActive > 0) {
        const range = TUNABLE.lancerBeamRange;
        const charge = 1 - e.beamActive / (getEnemy(e.defId).windup ?? 0.9);
        lights.beam(
          e.x,
          e.y,
          e.x + Math.cos(e.facing) * range,
          e.y + Math.sin(e.facing) * range,
          90,
          HUE_COLOR[e.hue],
          0.05 + charge * charge * 0.3,
        );
      }
    }

    for (const item of world.pickups) {
      if (!item.alive || !this.camera.isVisible(item.x, item.y, 90)) continue;
      if (item.kind === 'magnet') {
        // A lighthouse, deliberately. It is the only thing on the floor worth
        // walking towards, so it should be visible before it is identifiable.
        const beat = 1 + Math.sin(item.age * 4) * 0.25;
        lights.point(item.x, item.y, 260 * beat, PALETTE.voltaic, 0.5);
        lights.point(item.x, item.y, 40, HOT_CORE.voltaic, 0.9);
        continue;
      }
      lights.point(item.x, item.y, 48, PALETTE.xp, 0.1);
    }

    // §21b.5 — the lock in a sealed gate lights its own doorway, so the red is
    // in the air of the passage rather than a decal on the floor. A dead gate
    // has no lock and lights nothing.
    for (const gate of world.arena.gates ?? []) {
      if (!gate.opens || !gate.barrier) continue;
      if (world.openBiomes.has(gate.opens)) continue;
      if (world.terminals.some((t) => t.alive && t.gateId === gate.id && t.dead)) continue;
      const bar = gate.barrier;
      const cx = bar.x + bar.w / 2;
      const cy = bar.y + bar.h / 2;
      if (!this.camera.isVisible(cx, cy, 300)) continue;
      // The flood. This is the whole effect — the seam is nothing, the room
      // being full of red is everything.
      //
      // Sized against the exposure limiter, not by eye.
      //
      // The first attempt asked for radius 620 at 0.85, which carries the energy
      // of a Nova — the field's limiter saw a frame about to clip, ducked to its
      // floor, and took the entire picture down to a fifth with it. The gate lit
      // nothing and everything else went dark. Energy is intensity times area,
      // so radius is the expensive term: two modest areas and one tight core
      // read as a flood and leave the limiter alone.
      const swell = 0.82 + 0.18 * Math.sin(this.clock * 1.15);
      // Thrown out of the mouth, not from inside the door.
      //
      // Centred on the seam, almost all of it landed on the frame — and mass
      // only takes `massLit` of the light field, so the flood went into the one
      // surface built to swallow it. Pushed a little into the room it lands on
      // open floor instead, which is both what the reference does and what the
      // light is physically doing: leaking out of a gap.
      const ox = cx - bar.w * 0.75;
      lights.area(ox, cy, 480 * swell, PALETTE.signal, 0.42 * swell);
      lights.area(ox, cy, 250 * swell, PALETTE.signal, 0.5 * swell);
      lights.point(cx, cy, 120, 0xff6a58, 1.1 * swell);
    }

    // §13.2 — Meltdown lights the whole arena from nowhere, which is the world
    // overexposing rather than any object getting brighter. An area, not a
    // point: the whole screen is lit, not a lamp standing where the player is.
    if (melt > 0) {
      lights.area(world.player.x, world.player.y, 2200, 0xffb000, melt * 0.16);
    }

    const scale = this.scale;
    const offsetX = (this.app.screen.width - this.viewW * scale) / 2 + this.shakeX;
    const offsetY = (this.app.screen.height - this.viewH * scale) / 2 + this.shakeY;
    const worldX = this.viewW / 2 - this.camera.x;
    const worldY = this.viewH / 2 - this.camera.y;
    lights.render(scale, offsetX + worldX * scale, offsetY + worldY * scale, dt);
  }

  /**
   * §10.4 — write this frame's state field.
   *
   * The rule for what earns a channel: it must be something the player has to
   * *act differently* about, and it must be a property of the creature rather
   * than of the fight. A Charged Mote is not a Mote with a symbol on it — the
   * air over it is moving, and that is visible from further away than any glyph
   * at band 5 could ever be.
   *
   * Everything here is culled against the camera and capped by the field. A
   * hundred charged enemies is one shimmering region, which is correct.
   */
  private emitState(world: World): void {
    const masks = this.masks;
    masks.begin();

    for (const e of world.enemies) {
      if (!this.camera.isVisible(e.x, e.y, e.radius + 90)) continue;
      const def = getEnemy(e.defId);
      let charge = 0;
      let corrupt = 0;
      let phase = 0;

      if (def.marks?.includes('charge')) {
        // Breathes, so it reads as building rather than as being hot.
        charge = 0.55 + 0.25 * Math.sin(this.clock * 5 + e.id);
      }
      // A Charger mid-wind-up is the same statement with a timer on it, and the
      // one moment in the game where "get out of the way" has to arrive early.
      if (e.state === 'windup') charge = Math.max(charge, 0.75);
      // Volatile is a detonation that has not happened yet.
      if (e.affixes.includes('volatile')) charge = Math.max(charge, 0.5);

      // §12.4 — out of a Cache, or wearing affixes. Both mean "this one does not
      // obey the numbers the rest of its family obeys".
      if (e.hardened) corrupt = 0.6;
      if (e.affixes.length > 0) corrupt = Math.max(corrupt, 0.35 + e.affixes.length * 0.2);

      // Half-there, and looking it.
      if (e.phased) phase = 0.85;
      else if (def.marks?.includes('phase')) phase = 0.4;

      // The radius is generous on purpose: these are regions of air, and a mark
      // the size of the creature would just be a differently-coloured creature.
      masks.mark(e.x, e.y, e.radius * 3.4 + 26, charge, corrupt, phase);
    }

    const scale = this.scale;
    const offsetX = (this.app.screen.width - this.viewW * scale) / 2 + this.shakeX;
    const offsetY = (this.app.screen.height - this.viewH * scale) / 2 + this.shakeY;
    const worldX = this.viewW / 2 - this.camera.x;
    const worldY = this.viewH / 2 - this.camera.y;
    masks.render(scale, offsetX + worldX * scale, offsetY + worldY * scale);
    this.post.setMaskTexture(masks.source);
    this.post.setState(masks.empty ? 0 : VISUAL.degradationIntensity);
  }

  /**
   * §11.2 — hand the post pass this frame's suppression fields.
   *
   * A Suppressor's zone is the one hostile region in the game that does nothing
   * you can see: it switches your Triggers off, and an engine that has stopped
   * firing looks exactly like an engine with nothing in range. It used to be
   * announced with a filled disc and a rotating hatch, which worked for one and
   * whited the arena out at twenty.
   *
   * So the field is a fault in the *signal* instead of a thing in the world.
   * Nothing is drawn; the picture inside the zone comes apart. That reads as
   * "don't go in there" at any count, and it costs one shader branch.
   */
  private emitGlitchFields(world: World): void {
    this.glitchFields.length = 0;
    const scale = this.scale;
    const offsetX = (this.app.screen.width - this.viewW * scale) / 2 + this.shakeX;
    const offsetY = (this.app.screen.height - this.viewH * scale) / 2 + this.shakeY;
    const worldX = this.viewW / 2 - this.camera.x;
    const worldY = this.viewH / 2 - this.camera.y;

    for (const e of world.enemies) {
      if (!e.alive) continue;
      const def = getEnemy(e.defId);
      const zone = e.affixes.includes('anchored')
        ? TUNABLE.affixAnchoredZone
        : (def.zoneRadius ?? 0);
      if (zone <= 0) continue;
      if (!this.camera.isVisible(e.x, e.y, zone)) continue;
      // Fades up with the spawn, like every other §17.1 arrival — a field that
      // snaps on full strength reads as a rendering bug.
      const born = Math.min(1, e.spawnAge / VISUAL.drawInTime);
      this.glitchFields.push({
        x: offsetX + (worldX + e.x) * scale,
        y: offsetY + (worldY + e.y) * scale,
        radius: zone * scale,
        strength: 0.85 * born,
      });
      if (this.glitchFields.length >= 8) break;
    }
    this.post.setGlitchFields(this.glitchFields);
  }

  /** Turn the sim's death list into decomposing line segments (§17.1). */
  private drainDeaths(world: World): void {
    if (world.visualDeaths.length === 0) return;
    // §20.1 particle density never changes gameplay — it only bounds this budget.
    const budget = 900;
    for (const death of world.visualDeaths) {
      if (!this.camera.isVisible(death.x, death.y, 80)) continue;
      this.particles.decompose(
        death.x,
        death.y,
        death.radius,
        death.shape,
        HUE_COLOR[death.hue],
        budget,
      );
      this.shake = Math.min(VISUAL.shakeMax, this.shake + VISUAL.shakePerKill * 0.12);
    }
    world.visualDeaths.length = 0;
  }

  /**
   * Damage numbers, but only for damage taken.
   *
   * A number over every kill is eight thousand numbers a run and none of them
   * gets read. A number over every blow *you* take is at most two a second —
   * i-frames see to that — and it is the one piece of combat information the
   * game never gave you. It is also the answer to "why am I suddenly dead": you
   * see the 12 land, and which shape sent it.
   */
  private drainHurts(world: World, frameDt: number): void {
    for (const hurt of world.visualHurts) {
      const entry =
        this.hurtLabels.find((h) => h.life <= 0) ??
        (this.hurtLabels.length < 24
          ? (() => {
              const text = new Text({
                text: '',
                style: {
                  fontFamily: 'monospace',
                  fontSize: 15,
                  fill: PALETTE.signal,
                  letterSpacing: 1,
                },
              });
              text.anchor.set(0.5, 1);
              this.worldLayer.addChild(text);
              const made = { text, life: 0, x: 0, y: 0 };
              this.hurtLabels.push(made);
              return made;
            })()
          : this.hurtLabels[0]!);

      // The name rides along, because "12" tells you how bad and the label tells
      // you what to do about it next time.
      entry.text.text = `−${Math.round(hurt.amount)}  ${hurt.label.toUpperCase()}`;
      entry.text.style.fontSize = 13 + Math.min(1, hurt.severity * 4) * 9;
      entry.life = 1.1;
      // Offset so consecutive hits do not stack into an unreadable pile.
      entry.x = hurt.x + this.jitter(26);
      entry.y = hurt.y - 34;
    }
    world.visualHurts.length = 0;

    for (const h of this.hurtLabels) {
      if (h.life <= 0) {
        h.text.visible = false;
        continue;
      }
      h.life -= frameDt;
      h.y -= frameDt * 26;
      h.text.visible = true;
      h.text.position.set(h.x, h.y);
      h.text.alpha = Math.min(1, h.life * 2.2);
    }
  }

  private trackDash(world: World): void {
    if (world.player.dashTimer <= 0) return;
    this.particles.pushAfterimage(
      world.player.x,
      world.player.y,
      Math.atan2(world.player.dirY, world.player.dirX),
    );
  }

  addShake(amount: number): void {
    this.shake = Math.min(VISUAL.shakeMax, this.shake + amount);
  }

  private updateShake(dt: number): void {
    this.shake = Math.max(0, this.shake - VISUAL.shakeDecay * dt);
    // A gate asks for shake by score rather than by event, so it is added here
    // rather than decayed: the sequence says how much is wanted *now*, and when
    // the sequence ends it says zero and stops on its own.
    const magnitude =
      (this.shake + this.gateShake * VISUAL.shakeMax * SHELL.gateShake) *
      VISUAL.degradationIntensity *
      VIEW.shake;
    this.shakeX = this.jitter(magnitude);
    this.shakeY = this.jitter(magnitude);
  }

  /** Cheap symmetric noise. Cosmetic only — never used by the simulation. */
  private jitter(magnitude: number): number {
    this.jitterSeed = (Math.imul(this.jitterSeed, 1103515245) + 12345) >>> 0;
    return ((this.jitterSeed / 4294967296) * 2 - 1) * magnitude;
  }

  // --------------------------------------------------------------- structure

  /**
   * §21b.5 — the thing holding the door shut.
   *
   * A sealed gate needs something to be *doing* the sealing, or the wall is just
   * a wall in a fancy frame and the terminal is a floating instruction. So there
   * is a seal in the middle of the door, in signal red because §16.2 reserves
   * that hue for "this is against you" and a door you cannot pass is exactly
   * that.
   *
   * This used to be three nested rectangles in the emissive layer and it never
   * once looked like it was burning. The reason was structural rather than a
   * matter of brightness: the emissive layer composites *under* the mass, and
   * the seal is embedded in a door made of mass. Its bloom was being painted
   * over by the very thing it was supposed to be melting through. So nothing is
   * drawn here now — the seal goes to the mass pass as four numbers and burns
   * there, above the door, where it also gets to warp the blocks around it.
   *
   * It breathes on its own slow clock and quickens with the beat, and it is gone
   * the instant the gate opens, because by then it has lost.
   */
  private collectSeals(world: World): ShellSeal[] {
    const seals: ShellSeal[] = [];
    const beat = this.beat ? this.beat.pulse : 0;
    for (const gate of world.arena.gates ?? []) {
      if (!gate.opens || !gate.barrier) continue;
      if (world.openBiomes.has(gate.opens)) continue;
      // STORY-AND-TONE §7.2 — a dead gate has no light. The seal burning above
      // a door is the door being powered; the wall over a dead one is just wall.
      const terminal = world.terminals.find((t) => t.alive && t.gateId === gate.id);
      if (terminal?.dead) continue;
      const b = gate.barrier;
      const cx = b.x + b.w / 2;
      const cy = b.y + b.h / 2;
      if (!this.camera.isVisible(cx, cy, 520)) continue;
      const breathe = 0.86 + 0.14 * Math.sin(this.clock * 1.15);
      seals.push({
        x: cx,
        y: cy,
        radius: b.h * SHELL.sealRadius,
        intensity: SHELL.sealGlow * breathe * (1 + beat * 0.35),
        halfW: b.w / 2,
        halfH: b.h / 2,
        jambGlow: SHELL.jambGlow,
        motes: SHELL.gateMotes,
      });
    }
    return seals;
  }

  /**
   * §21b — confine the camera to the levels that are open.
   *
   * The next room is walled off *and* off camera until its gate is held, so
   * opening one is a reveal rather than a door. The bounds are eased rather than
   * snapped: the moment the wall comes down the view can travel further, and
   * watching that reach happen is most of the moment.
   */
  private updateLevelBounds(world: World): void {
    const levels = world.unlockedLevels;
    if (levels.length === 0) return;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const l of levels) {
      x0 = Math.min(x0, l.x);
      y0 = Math.min(y0, l.y);
      x1 = Math.max(x1, l.x + l.w);
      y1 = Math.max(y1, l.y + l.h);
    }
    // Gates sit *on* a level boundary, so clamping to the level alone pinned the
    // doorway to the edge of the frame — you could never look straight at the
    // thing you were being asked to stand in and hold. Every barrier is unioned
    // in, which buys exactly enough travel to centre it and no more.
    for (const gate of world.arena.gates ?? []) {
      const b = gate.barrier;
      if (!b) continue;
      x0 = Math.min(x0, b.x);
      y0 = Math.min(y0, b.y);
      x1 = Math.max(x1, b.x + b.w);
      y1 = Math.max(y1, b.y + b.h);
    }
    this.camera.setBounds(x0, y0, x1 - x0, y1 - y0);
  }

  /**
   * §16.5, §21b — hand this frame's world to the shell shader.
   *
   * Nothing is drawn here. The walls are culled to the view, the things that
   * bend space are collected, the gate animation is advanced, and all of it
   * goes across as uniforms; the surface itself is one full-screen pass.
   */
  private updateShell(world: World, dt: number): void {
    this.advanceQuarter(dt);
    const view = this.camera.view;
    const load = world.budget.staticFraction;

    // Everything that bends the world, in one list. The avatar pushes space
    // outward under load; a vortex pulls it in and twists it. Drawing Pull as a
    // distortion of the ground rather than a wad of strokes on top of it is the
    // difference between "an ugly thing is here" and "space is wrong here".
    const warp: ShellWarp[] = [
      {
        x: world.player.x,
        y: world.player.y,
        radius: VISUAL.gridWarpRadius,
        pull: -VISUAL.gridWarpAmount * load * VISUAL.degradationIntensity,
        swirl: 0,
      },
    ];
    for (const z of world.zones) {
      if (z.force <= 0 || warp.length >= 6) continue;
      const t = Math.max(0, z.life / z.maxLife);
      // Peaks just after it lands and eases off as it dies, like the pull itself.
      const strength = Math.sin(Math.min(1, (1 - t) * 3) * Math.PI * 0.5) * t;
      warp.push({
        x: z.x,
        y: z.y,
        radius: z.radius * 1.35,
        pull: 64 * strength,
        swirl: 1.15 * strength,
      });
    }
    for (const shell of this.shells) shell.setWarp(warp);
    this.shellMass.setSeals(this.collectSeals(world));

    // Walls: the live ruin list, culled to what can be on screen. The shader
    // loops over these per pixel, so what is off-camera must not be paid for.
    const walls = this.wallScratch;
    walls.length = 0;
    const pad = 120;
    const vx0 = view.x - pad;
    const vy0 = view.y - pad;
    const vx1 = view.x + view.width + pad;
    const vy1 = view.y + view.height + pad;

    // Gates first, and deliberately so. `setWalls` keeps only the first
    // fourteen, and a screen busy enough to fill that is exactly the screen a
    // gate is opening on — put the barrier last and the one wall the player is
    // watching is the one that gets dropped.
    // §21b.5 — a gate does not delete its wall, it opens it.
    //
    // The sim removes the barrier ruin the instant the hold completes, because
    // collision and pathing must agree immediately. The picture is allowed to
    // disagree for a few seconds: the barrier keeps being submitted while
    // GATE_SEQUENCE plays out over it. The renderer only advances a clock and
    // reads the score — what the beats *are* lives in visual.ts.
    for (const gate of world.arena.gates ?? []) {
      if (!gate.opens || !gate.barrier) continue;
      if (!world.openBiomes.has(gate.opens)) continue;
      const t = (this.gateOpen.get(gate.id) ?? 0) + dt;
      this.gateOpen.set(gate.id, t);
      const step = sampleGate(t);
      if (step.done) continue;
      this.gateShake = Math.max(this.gateShake, step.shake);
      // The cut burns the colour of the room it opens into — light from the
      // other side belongs to the other side.
      const into = (world.arena.levels ?? []).find((l) => l.id === gate.opens);
      this.shellMass.setCutColor(into?.light ?? PALETTE.beacon);
      const b = gate.barrier;
      if (b.x > vx1 || b.x + b.w < vx0 || b.y > vy1 || b.y + b.h < vy0) continue;
      walls.push({
        x: b.x,
        y: b.y,
        w: b.w,
        h: b.h,
        open: step.open,
        glow: step.glow,
        reach: reachFor(b.w, b.h),
      });
    }
    for (const r of world.ruins) {
      if (r.x > vx1 || r.x + r.w < vx0 || r.y > vy1 || r.y + r.h < vy0) continue;
      walls.push({ x: r.x, y: r.y, w: r.w, h: r.h, open: 0, glow: 0, reach: reachFor(r.w, r.h) });
    }
    for (const shell of this.shells) shell.setWalls(walls, view);

    for (const shell of this.shells) {
      shell.setCamera(this.originX, this.originY, this.originScale, this.playerX, this.playerY);
      shell.update(this.beat ? this.beat.pulse : 0, this.quarter, load, dt);
    }
  }

  /** Which room's shell style the uniforms currently hold. */
  private roomStyleId: string | null = null;

  /**
   * LEVELS §3.2 — a room may re-style the mass shader: block sizes, churn
   * tempo, amplitude. The Archive is nearly still; the deep rooms churn hard.
   * Numeric overrides only — the arrays (sizes, shades…) always come from
   * SHELL, because `LevelDef.shell` is a plain number record so the sim never
   * has to know a rendering type. Uniforms are rewritten only on room change.
   *
   * `oil` and `fray` ride in the same `shell` block but are *not* applied here —
   * see `setMaterialZones`. They are placed in the world, because switching them
   * on a room change repaints the room the player just left.
   */
  private applyRoomStyle(level: LevelDef | null): void {
    const id = level?.shell ? level.id : null;
    if (id === this.roomStyleId) return;
    this.roomStyleId = id;
    const style = level?.shell ? ({ ...SHELL, ...level.shell } as typeof SHELL) : SHELL;
    for (const shell of this.shells) shell.setStyle(style);
  }

  // ---------------------------------------------------------------- entities

  /** §16.4 — terminals are blueprint-annotated structures: ticks, label, sweep. */
  private drawTerminals(world: World): void {
    const g = this.gBeacons;
    g.clear();
    this.syncTerminalLabels(world);

    for (const t of world.terminals) {
      const r = TUNABLE.beaconRadius;
      // Dead gates draw in structure grey: furniture, not invitation.
      const color = t.dead ? 0x2a3a52 : TERMINAL_COLOR[t.kind];

      g.rect(t.x - r, t.y - r, r * 2, r * 2).stroke({ width: 2, color, alpha: BAND.entity });
      // Recompile gets a second, inset frame; Extract a heavier outer bracket —
      // they must be tellable apart from across the arena.
      if (t.kind === 'recompile') {
        g.rect(t.x - r + 6, t.y - r + 6, (r - 6) * 2, (r - 6) * 2);
        g.stroke({ width: 1, color, alpha: BAND.inFlight });
      } else if (t.kind === 'gate') {
        // §21b.5 — a gate is ground you hold, so it is drawn as ground: a wide
        // ring you can see from across the arena, filling as you stand in it.
        const gate = world.arena.gates?.find((x) => x.id === t.gateId);
        const hold = gate?.radius ?? 240;
        // Markings on the floor, and nothing else.
        //
        // This used to fill the disc, which put a pale wash across the whole
        // mouth of the gate — the one place in the game with a coloured light
        // worth looking at. Paint over a light and you have neither. So: a ring,
        // a progress arc, and hatch ticks that thicken as it fills. It reads as
        // ground you have to stand on because that is what it is drawn as.
        g.circle(t.x, t.y, hold).stroke({ width: 2, color, alpha: BAND.structure * 2.2 });
        const ticks = 24;
        for (let i = 0; i < ticks; i++) {
          const a = (i / ticks) * Math.PI * 2;
          const lit = i / ticks <= t.progress;
          const len = lit ? 16 : 8;
          const ca = Math.cos(a);
          const sa = Math.sin(a);
          g.moveTo(t.x + ca * (hold - len), t.y + sa * (hold - len));
          g.lineTo(t.x + ca * hold, t.y + sa * hold);
        }
        g.stroke({ width: 2, color, alpha: BAND.structure * 2 });
        if (t.progress > 0) {
          arcSegment(g, t.x, t.y, hold, -Math.PI / 2, -Math.PI / 2 + t.progress * Math.PI * 2);
          g.stroke({ width: 6, color, alpha: BAND.telegraph });
        }
        // Chevrons pointing at the wall it opens: where this goes, before you
        // have paid for it. §21b.5 — a gate you can see is a promise.
        for (let i = 0; i < 3; i++) {
          const ox = r + 14 + i * 13;
          g.moveTo(t.x + ox - 7, t.y - 11).lineTo(t.x + ox, t.y).lineTo(t.x + ox - 7, t.y + 11);
        }
        g.stroke({ width: 2, color, alpha: BAND.entity * (0.4 + t.progress * 0.6) });
      } else if (t.kind === 'cooler') {
        // §21b.4 — a place, not a button: the field it works in *is* the object.
        g.circle(t.x, t.y, TUNABLE.coolerRadius).stroke({
          width: 2,
          color,
          alpha: BAND.structure * 2,
        });
        const breath = 0.5 + 0.5 * Math.sin(t.age * 1.6);
        g.circle(t.x, t.y, TUNABLE.coolerRadius * (0.35 + breath * 0.12)).stroke({
          width: 1.5,
          color,
          alpha: BAND.inFlight * (0.5 + breath * 0.5),
        });
        for (let i = 0; i < 6; i++) {
          const a = (i / 6) * Math.PI * 2 - t.age * 0.35;
          g.moveTo(t.x + Math.cos(a) * (r + 4), t.y + Math.sin(a) * (r + 4)).lineTo(
            t.x + Math.cos(a) * (r + 16),
            t.y + Math.sin(a) * (r + 16),
          );
        }
        g.stroke({ width: 2, color, alpha: BAND.entity });
      } else if (t.kind === 'cache') {
        // §12.4 — a Cache is a box with something in it, and a ring of teeth to
        // say the something bites. Read from across the arena: the teeth turn.
        g.circle(t.x, t.y, r - 5).stroke({ width: 1.5, color, alpha: BAND.inFlight });
        for (let i = 0; i < 8; i++) {
          const a = (i / 8) * Math.PI * 2 + t.age * 0.5;
          g.moveTo(t.x + Math.cos(a) * (r + 3), t.y + Math.sin(a) * (r + 3)).lineTo(
            t.x + Math.cos(a) * (r + 9),
            t.y + Math.sin(a) * (r + 9),
          );
        }
        g.stroke({ width: 2, color, alpha: BAND.entity });
      } else if (t.kind === 'extract') {
        for (const [sx, sy] of CORNERS) {
          g.moveTo(t.x + sx * (r + 10), t.y + sy * (r + 2)).lineTo(
            t.x + sx * (r + 10),
            t.y + sy * (r + 10),
          );
          g.lineTo(t.x + sx * (r + 2), t.y + sy * (r + 10));
        }
        g.stroke({ width: 2, color, alpha: BAND.entity });
      } else if (t.kind === 'station') {
        // LEVELS §6 — a station is a sheet on a post: three ruled lines inside
        // the frame, the glyph for "there is text here".
        for (let i = 0; i < 3; i++) {
          const y = t.y - 8 + i * 8;
          g.moveTo(t.x - r + 8, y).lineTo(t.x + r - 8 - (i === 2 ? 10 : 0), y);
        }
        g.stroke({ width: 1.5, color, alpha: BAND.inFlight });
      } else if (t.kind === 'fragment') {
        // LEVELS §6 — a fragment is a dog-eared page: inner rect, folded corner.
        g.rect(t.x - r + 9, t.y - r + 9, (r - 9) * 2, (r - 9) * 2)
          .stroke({ width: 1.5, color, alpha: BAND.inFlight });
        g.moveTo(t.x + r - 18, t.y - r + 9)
          .lineTo(t.x + r - 9, t.y - r + 18)
          .stroke({ width: 1.5, color, alpha: BAND.entity });
      }

      const sweep = (t.age * 1.6) % (Math.PI * 2);
      arcSegment(g, t.x, t.y, r + 12, sweep, sweep + 0.9);
      g.stroke({ width: 2, color, alpha: BAND.inFlight });

      for (const [sx, sy] of CORNERS) {
        g.moveTo(t.x + sx * r, t.y + sy * r).lineTo(t.x + sx * (r + 7), t.y + sy * (r + 7));
      }
      g.stroke({ width: 1, color, alpha: BAND.structure * 2 });

      if (t.progress > 0) {
        arcSegment(g, t.x, t.y, r + 12, -Math.PI / 2, -Math.PI / 2 + t.progress * Math.PI * 2);
        g.stroke({ width: 4, color, alpha: BAND.telegraph });
      }
    }
  }

  private syncTerminalLabels(world: World): void {
    while (this.beaconLabels.length < world.terminals.length) {
      const label = new Text({
        text: '',
        style: { fontFamily: 'monospace', fontSize: 13, fill: PALETTE.beacon, letterSpacing: 2 },
      });
      label.anchor.set(0.5, 0);
      this.worldLayer.addChild(label);
      this.beaconLabels.push(label);
    }
    for (let i = 0; i < this.beaconLabels.length; i++) {
      const label = this.beaconLabels[i]!;
      const t = world.terminals[i];
      if (!t) {
        label.visible = false;
        continue;
      }
      const near =
        Math.hypot(world.player.x - t.x, world.player.y - t.y) <
        TUNABLE.beaconRadius + TUNABLE.playerRadius;
      const moving = t.requiresStillness && Math.hypot(world.player.vx, world.player.vy) > 12;
      label.visible = true;
      // §21b.5 — a gate is held by standing, so its label is a state, not an
      // instruction, and it is legible from outside the ring.
      if (t.kind === 'gate') {
        const gate = world.terminals[i] ? world.arena.gates?.find((x) => x.id === t.gateId) : null;
        label.visible = true;
        // STORY-AND-TONE §7.2 — a dead gate says so, in the site's own dull
        // grey, and nothing about it invites standing in the circle.
        label.text = t.dead
          ? `${(gate?.name ?? 'GATE').toUpperCase()}  —  NO POWER`
          : t.progress > 0
            ? `${(gate?.name ?? 'GATE').toUpperCase()}  ${Math.round(t.progress * 100)}%`
            : `${(gate?.name ?? 'GATE').toUpperCase()}  —  STAND HERE`;
        label.alpha = t.dead ? BAND.inFlight : BAND.telegraph;
        label.style.fill = t.dead ? 0x44546a : TERMINAL_COLOR.gate;
        label.position.set(t.x, t.y + (gate?.radius ?? 240) + 18);
        continue;
      }
      if (t.kind === 'cooler') {
        label.visible = true;
        label.text = near ? 'VENTING' : 'COOLER';
        label.alpha = near ? BAND.telegraph : BAND.inFlight;
        label.style.fill = TERMINAL_COLOR.cooler;
        label.position.set(t.x, t.y + TUNABLE.coolerRadius + 14);
        continue;
      }
      // §12.4 — a POI whose price is a fight has to say so *before* it is paid.
      // "HOLD E" on a Cache would be a trap, and §17.1 does not allow traps.
      const prompt = t.kind === 'cache' ? 'HOLD  E  —  THEY WAKE UP' : 'HOLD  E';
      // LEVELS §6 — authored POIs name themselves; the far label is authored
      // too. A station says STATION, a file says FILE, not FRAGMENT_07.
      const far = t.label ?? `${t.kind.toUpperCase()}_${String(t.id).padStart(2, '0')}`;
      label.text = near ? (moving ? 'HOLD STILL' : prompt) : far;
      label.alpha = near ? BAND.telegraph : BAND.inFlight;
      label.style.fill = moving && near ? PALETTE.signal : TERMINAL_COLOR[t.kind];
      label.position.set(t.x, t.y + TUNABLE.beaconRadius + 20);
    }
  }

  /**
   * §11.4 — Containment. Every one of these is a geometry problem the player
   * solves with position, not damage, so all three are drawn as hard, legible
   * boundaries with their safe passage visibly marked.
   */
  private drawContainment(world: World): void {
    const g = this.gContainment;
    g.clear();
    const arena = world.arena;

    for (const c of world.containment) {
      const arming = c.age < c.telegraph;
      // §17.1 — the telegraph is a drawn line before it is a threat.
      const alpha = arming ? BAND.telegraph * (0.3 + 0.7 * (c.age / c.telegraph)) : BAND.telegraph;
      const width = arming ? 1.5 : 4;
      const color = arming ? PALETTE.beacon : PALETTE.signal;

      HAZARD_DRAW[c.kind]?.({ g, c, arena, arming, alpha, width, color });
    }
  }

  /** §16.4 — fields are fill-less dashed outlines with a slow-rotating dash. */
  private drawZones(world: World): void {
    const g = this.gZones;
    g.clear();
    for (const z of world.zones) {
      if (!this.camera.isVisible(z.x, z.y, z.radius)) continue;
      const t = Math.max(0, z.life / z.maxLife);
      const color = HUE_COLOR[z.hue];
      const spin = z.life * 0.9;
      // A vortex must not look like a Field: one is a place that hurts, the other
      // is a place that *moves you*. The distortion lives in drawGrid — space
      // itself winds up around the point. All that belongs here is the singularity
      // it winds around, small and bright, and a rim marking where it stops.
      if (z.force > 0) {
        const core = 4 + t * 7;
        g.circle(z.x, z.y, core).fill({ color, alpha: BAND.entity * (0.5 + 0.5 * t) });
        g.circle(z.x, z.y, core * 2.1).stroke({ width: 1.5, color, alpha: BAND.inFlight * t });
        // Two short arcs at the boundary: an annotation, not a fence.
        for (let i = 0; i < 2; i++) {
          const a = spin * 1.6 + i * Math.PI;
          arcSegment(g, z.x, z.y, z.radius * (0.94 - (1 - t) * 0.35), a, a + 0.5);
        }
        g.stroke({ width: 1, color, alpha: BAND.structure * 1.4 * t });
        continue;
      }

      // A persistent Action has to be obvious that it is there and working —
      // the first pass was faint enough to be reported as "Field never appeared"
      // when it was in fact firing thirty times a minute.
      g.circle(z.x, z.y, z.radius).fill({ color, alpha: 0.13 * t });

      const segments = 26;
      for (let i = 0; i < segments; i += 2) {
        const a0 = (i / segments) * Math.PI * 2 + spin;
        const a1 = ((i + 1) / segments) * Math.PI * 2 + spin;
        arcSegment(g, z.x, z.y, z.radius, a0, a1);
      }
      g.stroke({ width: 3, color, alpha: BAND.entity * (0.6 + 0.4 * t) });

      // Interior scanline hatch, clipped to the circle by chord maths.
      for (let y = -z.radius + 10; y < z.radius; y += 14) {
        const half = Math.sqrt(Math.max(0, z.radius * z.radius - y * y));
        if (half < 2) continue;
        g.moveTo(z.x - half, z.y + y).lineTo(z.x + half, z.y + y);
      }
      g.stroke({ width: 1, color, alpha: BAND.inFlight * 0.5 * t });

      // A pulse on every damage tick, so you can see it working.
      const tickPhase = 1 - (z.tickTimer / z.tickInterval || 0);
      if (tickPhase > 0.75) {
        g.circle(z.x, z.y, z.radius * (0.55 + tickPhase * 0.45)).stroke({
          width: 2,
          color,
          alpha: BAND.telegraph * (tickPhase - 0.75) * 4,
        });
      }
    }
  }

  /**
   * §16.4 — pickups bob gently. Batched by kind and drawn as solid glowing
   * marks: at 1px dashed micro-shapes a hundred of them read as static rather
   * than as loot, which is the opposite of what a pickup should communicate.
   */
  private drawPickups(world: World): void {
    const g = this.gPickups;
    g.clear();

    // XP shards: white diamonds, one fill for the lot.
    //
    // A shard called in by a Magnet stops bobbing and grows a streak — the same
    // trick the projectiles use, for the same reason: at 1,600 units a second a
    // dot is a dot, and what you want to see is the arena draining.
    let anyStreak = false;
    for (const item of world.pickups) {
      if (!item.called || item.kind !== 'xp') continue;
      if (!this.camera.isVisible(item.x, item.y, 40)) continue;
      const dx = world.player.x - item.x;
      const dy = world.player.y - item.y;
      const d = Math.hypot(dx, dy) || 1;
      const len = Math.min(46, 12 + d * 0.06);
      g.moveTo(item.x, item.y).lineTo(item.x - (dx / d) * len, item.y - (dy / d) * len);
      anyStreak = true;
    }
    if (anyStreak) g.stroke({ width: 1.2, color: PALETTE.voltaic, alpha: BAND.inFlight });

    let anyXp = false;
    for (const item of world.pickups) {
      if (item.kind !== 'xp') continue;
      if (!this.camera.isVisible(item.x, item.y, 20)) continue;
      const y = item.called ? item.y : item.y + Math.sin(item.age * 3.4 + item.id) * 1.8;
      // §7.3 consolidation merges drops into fewer, richer ones — so a merged
      // shard has to *look* richer, or a big kill reads as loot going missing.
      const s = pickupScale(item.value);
      g.moveTo(item.x, y - 4 * s)
        .lineTo(item.x + 3 * s, y)
        .lineTo(item.x, y + 4 * s)
        .lineTo(item.x - 3 * s, y)
        .lineTo(item.x, y - 4 * s);
      anyXp = true;
    }
    if (anyXp) g.fill({ color: PALETTE.xp, alpha: BAND.inFlight });

    // Fuel motes: a filled core inside an upright cross, batched per hue.
    //
    // Loot and enemies share the three hues, so hue cannot be the tell — §16.3
    // spends colour on Thermal/Voltaic/Void and has none left over. The tell is
    // *behaviour*:
    //
    //   Living things rotate and each keeps its own phase.
    //   Objects hold their orientation and breathe on a shared clock.
    //
    // So the spark no longer spins — it is a fixed upright cross, an axis-
    // aligned form no enemy silhouette in §10.1 owns — and every pickup on
    // screen pulses together off one global phase. A field of marks blinking in
    // unison is not something the eye ever reads as a swarm, and it separates
    // at a glance even when the screen is full.
    const pulse = 0.78 + 0.22 * Math.sin(this.lootPhase);

    // §7.3 The Magnet. The one pickup worth crossing the arena for, so it is the
    // one pickup allowed to shout: a counter-rotating pair of rings, three
    // orbiting sparks, and a hot core. Everything about it moves, because every
    // other object on this layer holds still and breathes on a shared clock —
    // the tell for "this is not ordinary loot" is motion, not size.
    for (const item of world.pickups) {
      if (item.kind !== 'magnet') continue;
      if (!this.camera.isVisible(item.x, item.y, 60)) continue;
      const t = item.age;
      const y = item.y + Math.sin(t * 2.2) * 2.4;
      const breathe = 1 + Math.sin(t * 4) * 0.09;

      // Outer ring, spinning one way, drawn as six arcs so the rotation reads.
      for (let i = 0; i < 6; i += 2) {
        const a0 = (i / 6) * Math.PI * 2 + t * 1.6;
        arcSegment(g, item.x, y, 15 * breathe, a0, a0 + Math.PI / 3.4);
      }
      g.stroke({ width: 2, color: PALETTE.voltaic, alpha: BAND.entity });

      // Inner ring, spinning the other.
      for (let i = 0; i < 6; i += 2) {
        const a0 = (i / 6) * Math.PI * 2 - t * 2.4;
        arcSegment(g, item.x, y, 9.5 * breathe, a0, a0 + Math.PI / 2.6);
      }
      g.stroke({ width: 1.5, color: PALETTE.beacon, alpha: BAND.entity });

      // Three sparks in orbit.
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * Math.PI * 2 + t * 3.1;
        g.circle(item.x + Math.cos(a) * 21, y + Math.sin(a) * 21, 1.9);
      }
      g.fill({ color: PALETTE.beacon, alpha: BAND.telegraph });

      // The core, and the radiating spikes that make it read at a distance.
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2 + t * 0.7;
        const reach = 24 + Math.sin(t * 6 + i) * 4;
        g.moveTo(item.x + Math.cos(a) * 17, y + Math.sin(a) * 17).lineTo(
          item.x + Math.cos(a) * reach,
          y + Math.sin(a) * reach,
        );
      }
      g.stroke({ width: 1, color: PALETTE.voltaic, alpha: BAND.inFlight * pulse });
      g.circle(item.x, y, 4.5 * breathe).fill({ color: HOT_CORE.voltaic, alpha: BAND.telegraph });
    }
  }

  /** §5.4 Mine and Orbital — persistent bodies the player placed. */
  private drawPlaced(world: World): void {
    const g = this.gPlaced;
    g.clear();

    for (const m of world.mines) {
      if (!this.camera.isVisible(m.x, m.y, m.radius)) continue;
      const color = HUE_COLOR[m.hue];
      const armed = m.arm <= 0;
      // Unarmed reads as dashed and dim; armed as a solid mark with a live
      // trigger ring, so "this will go off if something touches it" is visible.
      const r = 9;
      polygonPath(g, shapeOutline('diamond', m.x, m.y, r, 0));
      g.stroke({ width: 2, color, alpha: armed ? BAND.entity : BAND.structure * 2 });

      if (armed) {
        const pulse = 0.5 + 0.5 * Math.sin(m.life * 6);
        g.circle(m.x, m.y, m.triggerRadius).stroke({
          width: 1,
          color,
          alpha: BAND.structure * (0.8 + pulse * 0.7),
        });
        g.circle(m.x, m.y, r * 0.4).fill({ color, alpha: BAND.entity * pulse });
      }
    }

    // Orbitals must not read as enemies. Enemies are *outlined polygons* from a
    // fixed shape grammar (§10.1); an outlined circle is a Drifter. So orbitals
    // are drawn as filled four-point stars — a silhouette no enemy owns — riding
    // a visible orbit track, which also says "this belongs to you".
    const seenTracks = new Set<number>();
    for (const o of world.orbitals) {
      const track = Math.round(o.orbitRadius);
      if (!seenTracks.has(track)) {
        seenTracks.add(track);
        g.circle(world.player.x, world.player.y, o.orbitRadius);
      }
    }
    if (seenTracks.size > 0) {
      g.stroke({ width: 1, color: PALETTE.player, alpha: BAND.structure * 0.9 });
    }

    // Each orbital is a thick, tapering arc *of its own orbit* with a bright
    // leading head. It reads as a body riding a track rather than a creature,
    // it stays legible when a dozen of them stack, and no enemy owns the shape.
    for (const o of world.orbitals) {
      if (!this.camera.isVisible(o.x, o.y, o.orbitRadius + 24)) continue;
      const color = HUE_COLOR[o.hue];
      const fade = Math.min(1, o.life / 1.5);
      const px = world.player.x;
      const py = world.player.y;

      const segments = 5;
      const span = 0.34;
      for (let s = 0; s < segments; s++) {
        const f0 = s / segments;
        const f1 = (s + 1) / segments;
        arcSegment(g, px, py, o.orbitRadius, o.angle - span * f1, o.angle - span * f0);
        g.stroke({
          width: 1 + (1 - f0) * 4,
          color,
          alpha: BAND.entity * (1 - f0) * fade,
        });
      }
      g.circle(o.x, o.y, 3.4).fill({ color: PALETTE.player, alpha: BAND.entity * fade });
    }
  }

  private drawDebris(): void {
    const g = this.gDebris;
    g.clear();
    this.particles.draw(g, (x, y, m) => this.camera.isVisible(x, y, m));
  }

  /**
   * §16.4 — enemies are 2–2.5px stroke outlines of their shape with a faint
   * interior fill. §17.1 — they trace themselves in on spawn, and shed detail as
   * they take damage, so health reads without an HP bar.
   */
  private drawEnemies(world: World): void {
    const g = this.gEnemies;
    g.clear();

    // ---- the common case, batched -----------------------------------------
    //
    // Measured: at 620 enemies, drawing them cost 2.29ms of a 2.83ms frame —
    // 81% of it, and 3.7µs per enemy. The cause was one `stroke()` per enemy:
    // every stroke is a separate tessellation and upload, so a screen full of
    // Drifters was six hundred of them. The projectile pass learned this a while
    // ago and batches by hue; this is the same fix.
    //
    // Grouping is by colour and by a quantised health step, because those are
    // the only two things that change the paint. Everything unusual — a
    // half-drawn spawn, a damage flash, a phase, an elite's rings — falls
    // through to the per-enemy pass below, and there are never many of those.
    const visible = this.enemyScratch;
    const outlines = this.outlineScratch;
    visible.length = 0;
    outlines.length = 0;
    for (const e of world.enemies) {
      if (!this.camera.isVisible(e.x, e.y, e.radius + 24)) continue;
      visible.push(e);
      // Built once and reused by the stroke, the fill and the per-enemy pass.
      // shapeOutline allocates, and building the same polygon three times per
      // enemy per frame was 1,900 throwaway arrays a frame at this density.
      const def = getEnemy(e.defId);
      outlines.push(shapeOutline(def.shape, e.x, e.y, e.radius, facingOf(world, e, def)));
    }

    const STEPS = 4;
    for (const hue of HUE_ORDER) {
      const color = HUE_COLOR[hue];
      // Outlines: one stroke for every ordinary enemy of this hue.
      let any = false;
      for (let i = 0; i < visible.length; i++) {
        const e = visible[i]!;
        if (e.hue !== hue || e.flash > 0 || e.phased) continue;
        if (e.spawnAge < VISUAL.drawInTime) continue;
        polygonPath(g, outlines[i]!);
        any = true;
      }
      if (any) g.stroke({ width: ENEMY_PAINT.outline, color, alpha: BAND.entity });

      // Interior fills, one per health step. §17.1 — an enemy sheds its interior
      // as it takes damage, which is the HP bar the game does not draw.
      for (let step = 0; step < STEPS; step++) {
        let filled = false;
        for (let i = 0; i < visible.length; i++) {
          const e = visible[i]!;
          if (e.hue !== hue || e.flash > 0 || e.phased) continue;
          if (e.spawnAge < VISUAL.drawInTime) continue;
          const health = e.maxHp > 0 ? e.hp / e.maxHp : 1;
          if (Math.min(STEPS - 1, Math.floor(health * STEPS)) !== step) continue;
          polygonPath(g, outlines[i]!);
          filled = true;
        }
        if (filled) g.fill({ color, alpha: ENEMY_PAINT.fill * ((step + 0.5) / STEPS) });
      }

      // Cores.
      let cored = false;
      for (const e of visible) {
        if (e.hue !== hue || e.flash > 0 || e.phased) continue;
        if (e.spawnAge < VISUAL.drawInTime) continue;
        const core = shapeCoreRadius(getEnemy(e.defId).shape, e.radius);
        if (core <= 0) continue;
        g.circle(e.x, e.y, core);
        cored = true;
      }
      if (cored) g.stroke({ width: ENEMY_PAINT.core, color, alpha: BAND.inFlight });
    }

    // ---- everything else, one at a time ------------------------------------
    for (let vi = 0; vi < visible.length; vi++) {
      const e = visible[vi]!;
      const def = getEnemy(e.defId);
      const born = Math.min(1, e.spawnAge / VISUAL.drawInTime);
      const flashing = e.flash > 0;
      // §16.3 — hue is threat class now: thermal rushes, voltaic harasses,
      // void anchors. Full saturation always; the old desaturation carried
      // adaptive resistance, which is retired.
      const color = flashing ? PALETTE.player : HUE_COLOR[e.hue];
      const r = e.radius;
      const health = e.maxHp > 0 ? e.hp / e.maxHp : 1;
      const ordinary = born >= 1 && !flashing && !e.phased;
      // §10.3 Phasing — untargetable, and it has to look it.
      if (e.phased && !flashing) {
        g.circle(e.x, e.y, r + 3).stroke({ width: 1, color, alpha: BAND.structure * born });
        continue;
      }

      const facing = facingOf(world, e, def);
      if (!ordinary) {
        drawEnemyBody(g, def, e.x, e.y, r, facing, {
          colour: color,
          born,
          health,
          flash: flashing,
          outline: outlines[vi]!,
        });
      }

      if (e.enriched) {
        g.circle(e.x, e.y, r + 6).stroke({
          width: 1,
          color: PALETTE.beacon,
          alpha: BAND.structure * born,
        });
      }

      // §10.2 Bulwark's shield arc, and the §10.2 Suppressor / §10.3 Anchored
      // field boundary.
      //
      // The field itself is a *signal fault* now, drawn by the post pass — see
      // PostPass.setGlitchFields. What stays here is a thin boundary, because
      // the fault has to have a findable edge and a broken region with no rim is
      // just a broken screen. The filled disc and the rotating dashes are gone:
      // twenty of those on screen at once was the arena whiting out.
      drawEnemyMarks(g, def, e.x, e.y, r, facing, {
        colour: color,
        born,
        zone: e.affixes.includes('anchored') ? TUNABLE.affixAnchoredZone : undefined,
      });

      // §10.2 — a Glutton, full. It has stopped eating and is now a bomb: the
      // outline doubles and shivers, and a fuse ring shows the blast radius it
      // will leave when something kills it. The player earned this by spraying
      // projectiles, so they are owed a way to see it coming.
      if (e.meals >= TUNABLE.interceptorMaxMeals) {
        const shiver = this.jitter(2.4);
        polygonPath(g, shapeOutline(def.shape, e.x + shiver, e.y, e.radius * 1.08, e.spawnAge));
        g.stroke({ width: 2, color: PALETTE.signal, alpha: BAND.telegraph });
        const blast = e.radius * TUNABLE.interceptorBlastScale;
        const segments = 24;
        for (let i = 0; i < segments; i += 2) {
          const a0 = (i / segments) * Math.PI * 2 + world.time * 0.9;
          arcSegment(g, e.x, e.y, blast, a0, a0 + (Math.PI * 2) / segments);
        }
        g.stroke({ width: 1, color: PALETTE.signal, alpha: BAND.structure * 2 });
      }

      // §12.4 — out of a Cache. Four times the health and a harder hit, so it
      // gets the crown whatever its family is: the player opted into this and
      // has to be able to tell which ones they bought.
      if (e.hardened) ENEMY_MARKS.crown(g, e, r, born, color, world.time, (a) => this.jitter(a));

      // §10.4 — variant marks. One table, one entry per mark: the whole reason a
      // new variant is a JSON edit rather than a renderer edit.
      if (def.marks) {
        for (const mark of def.marks) {
          ENEMY_MARKS[mark]?.(g, e, r, born, color, world.time, (a) => this.jitter(a));
        }
      }

      // §10.3 — elites wear their affixes.
      if (e.affixes.length > 0) {
        for (let i = 0; i < e.affixes.length; i++) {
          g.circle(e.x, e.y, r + 10 + i * 4).stroke({
            width: 1,
            color: PALETTE.signal,
            alpha: BAND.structure * 1.6 * born,
          });
        }
      }

      // §10.2 Lancer — the beam draws as a 1px guide, then flashes to full width.
      if (e.beamActive > 0) {
        const windup = def.windup ?? 0.9;
        const charge = 1 - e.beamActive / windup;
        const range = TUNABLE.lancerBeamRange;
        const ux = Math.cos(e.facing);
        const uy = Math.sin(e.facing);
        const ex = e.x + ux * range;
        const ey = e.y + uy * range;

        // The danger corridor, drawn at its true width from the first frame.
        // A hairline that only thickens at the end tells you where the beam was
        // going a moment too late to matter — §17.1 asks for a line you can act
        // on, which means one you can see while there is still time.
        const half = 16 + TUNABLE.playerRadius;
        const nx = -uy * half;
        const ny = ux * half;
        g.moveTo(e.x + nx, e.y + ny)
          .lineTo(ex + nx, ey + ny)
          .lineTo(ex - nx, ey - ny)
          .lineTo(e.x - nx, e.y - ny)
          .closePath();
        g.fill({ color: PALETTE.signal, alpha: BAND.structure * 0.9 * (0.4 + charge * 0.6) });
        g.stroke({ width: 1, color: PALETTE.signal, alpha: BAND.telegraph * 0.5 });

        // The charge itself runs the corridor: a bright core that fills toward
        // the far end, so "how long have I got" is readable without a number.
        g.moveTo(e.x, e.y).lineTo(e.x + ux * range * charge, e.y + uy * range * charge);
        g.stroke({
          width: 1 + charge * charge * 6,
          color: PALETTE.signal,
          alpha: BAND.telegraph * (0.55 + charge * 0.45),
        });
      }

      // §17.1 — every avoidable hit is preceded by a drawn line. The telegraph
      // completes itself, then flashes to full width at commitment.
      if (e.state === 'windup') {
        const progress = 1 - Math.max(0, e.timer) / (def.windup ?? 0.6);
        g.moveTo(e.x, e.y).lineTo(e.x + e.aimX * 320 * progress, e.y + e.aimY * 320 * progress);
        g.stroke({
          width: 1 + progress * 2,
          color: PALETTE.signal,
          alpha: BAND.telegraph * (0.45 + progress * 0.55),
        });
      }
    }
  }

  /**
   * §16.4 — 1px strokes with phosphor trails; trail length proportional to speed.
   *
   * Batched by (hue × trail band) rather than per projectile. A stroke() is a
   * draw call, and the naive version issued five per projectile — four thousand
   * a frame at full chaos. This issues at most a couple of dozen, which is what
   * makes §16.1's "maximum chaos" budget reachable.
   */
  private drawProjectiles(world: World, tier: number): void {
    const g = this.gProjectiles;
    g.clear();
    const jitter = tier >= 1 ? VISUAL.jitterInstability1 * VISUAL.degradationIntensity : 0;
    const bands = VISUAL.trailSegments;

    for (const hue of HUE_ORDER) {
      const color = HUE_COLOR[hue];
      for (let band = 0; band < bands; band++) {
        const t0 = band / bands;
        const t1 = (band + 1) / bands;
        let any = false;
        for (const p of world.projectiles) {
          if (p.corrupted || p.hue !== hue) continue;
          if (!this.camera.isVisible(p.x, p.y, 40)) continue;
          const speed = Math.hypot(p.vx, p.vy) || 1;
          const length = speed * VISUAL.trailSeconds;
          const ux = (p.vx / speed) * length;
          const uy = (p.vy / speed) * length;
          const jx = jitter ? this.jitter(jitter) : 0;
          const jy = jitter ? this.jitter(jitter) : 0;
          g.moveTo(p.x + jx - ux * t0, p.y + jy - uy * t0).lineTo(
            p.x + jx - ux * t1,
            p.y + jy - uy * t1,
          );
          any = true;
        }
        if (any) {
          g.stroke({
            width: 1.6 * (1 - t0 * 0.7),
            color,
            alpha: BAND.inFlight * (1 - t0) * (1 - t0) + 0.05,
          });
        }
      }

      // Bright heads, one fill per hue.
      let heads = false;
      for (const p of world.projectiles) {
        if (p.corrupted || p.hue !== hue) continue;
        if (!this.camera.isVisible(p.x, p.y, 40)) continue;
        g.circle(p.x, p.y, 2.3);
        heads = true;
      }
      if (heads) g.fill({ color, alpha: BAND.entity });

      // The filament: a hot near-white core at the head, and a short hot streak
      // trailing it. Two more draw calls per hue, total, and they are what make a
      // shot read as something burning rather than as a coloured dot — the head
      // is the brightest part of the bolt, and before this the head and its trail
      // were the same colour at the same width.
      //
      // Still under BAND.player: §16.2's floor is that nothing outrank the
      // player, and HOT_CORE is a tinted white rather than the real thing.
      if (heads) {
        const hot = HOT_CORE[hue];
        for (const p of world.projectiles) {
          if (p.corrupted || p.hue !== hue) continue;
          if (!this.camera.isVisible(p.x, p.y, 40)) continue;
          g.circle(p.x, p.y, 1.05);
        }
        g.fill({ color: hot, alpha: BAND.telegraph });

        for (const p of world.projectiles) {
          if (p.corrupted || p.hue !== hue) continue;
          if (!this.camera.isVisible(p.x, p.y, 40)) continue;
          const speed = Math.hypot(p.vx, p.vy) || 1;
          const length = speed * VISUAL.trailSeconds * 0.3;
          g.moveTo(p.x, p.y).lineTo(p.x - (p.vx / speed) * length, p.y - (p.vy / speed) * length);
        }
        g.stroke({ width: 0.9, color: hot, alpha: BAND.inFlight * 0.8 });
      }
    }

    // §16.7 step 3 — corrupted projectiles render glitch-dashed in signal red.
    let corrupted = false;
    for (const p of world.projectiles) {
      if (!p.corrupted) continue;
      if (!this.camera.isVisible(p.x, p.y, 40)) continue;
      const speed = Math.hypot(p.vx, p.vy) || 1;
      const length = speed * VISUAL.trailSeconds;
      const ux = (p.vx / speed) * length;
      const uy = (p.vy / speed) * length;
      for (let band = 0; band < bands; band += 2) {
        const t0 = band / bands;
        const t1 = (band + 1) / bands;
        g.moveTo(p.x - ux * t0, p.y - uy * t0).lineTo(p.x - ux * t1, p.y - uy * t1);
      }
      corrupted = true;
    }
    if (corrupted) g.stroke({ width: 2, color: PALETTE.signal, alpha: BAND.telegraph });
  }

  private drawFx(world: World): void {
    const g = this.gFx;
    g.clear();

    // Bursts, batched by hue and by how far through their life they are.
    //
    // Each one used to issue two strokes of its own, so a cascade was thousands
    // of separate tessellations and the bill arrived in the bloom composite
    // (measured: 57.8ms of a 65ms frame). Grouping by paint fixes that — but the
    // *paint* has to survive the grouping, and in the first version it did not:
    // the ring and its twelve radial ticks got folded into one stroke, which
    // made the 1px ticks 4px and turned every detonation into a fat dashed
    // circle. Two passes, one per weight, is still a couple of dozen strokes for
    // a screen full of explosions.
    const BANDS = 6;
    for (const hue of HUE_ORDER) {
      const color = HUE_COLOR[hue];
      for (let band = 0; band < BANDS; band++) {
        const t = (band + 0.5) / BANDS;
        // The ring.
        let any = false;
        for (const f of world.fx) {
          if (f.kind !== 'burst' || f.hue !== hue) continue;
          if (!this.camera.isVisible(f.x, f.y, f.radius + 60)) continue;
          if (this.waitingForBeat(f.id)) continue;
          const life = Math.max(0, f.life / f.maxLife);
          if (Math.min(BANDS - 1, Math.floor(life * BANDS)) !== band) continue;
          g.circle(f.x, f.y, f.radius * (1.08 - life * 0.28));
          any = true;
        }
        if (any) g.stroke({ width: 2 + 2 * t, color, alpha: BAND.entity * t });

        // The ticks, at their own weight.
        any = false;
        for (const f of world.fx) {
          if (f.kind !== 'burst' || f.hue !== hue) continue;
          if (!this.camera.isVisible(f.x, f.y, f.radius + 60)) continue;
          if (this.waitingForBeat(f.id)) continue;
          const life = Math.max(0, f.life / f.maxLife);
          if (Math.min(BANDS - 1, Math.floor(life * BANDS)) !== band) continue;
          const radius = f.radius * (1.08 - life * 0.28);
          for (let i = 0; i < 12; i++) {
            const a = (i / 12) * Math.PI * 2;
            g.moveTo(f.x + Math.cos(a) * radius * 0.82, f.y + Math.sin(a) * radius * 0.82).lineTo(
              f.x + Math.cos(a) * radius,
              f.y + Math.sin(a) * radius,
            );
          }
          any = true;
        }
        if (any) g.stroke({ width: 1, color, alpha: BAND.inFlight * t });
      }
    }

    for (const f of world.fx) {
      if (f.kind === 'burst') continue;
      if (!this.camera.isVisible(f.x, f.y, f.radius + 60)) continue;
      // Detonations only. A chain is a path between two things that already
      // happened, and holding it would disconnect it from them.
      if (f.kind === 'rupture' && this.waitingForBeat(f.id)) continue;
      const t = Math.max(0, f.life / f.maxLife);
      const color = HUE_COLOR[f.hue];

      if (f.kind === 'chain') {
        // Chain lightning: a bright core with a wider, dimmer halo so it reads
        // as an arc rather than a stray line.
        for (const [width, alpha] of [
          [4, 0.22],
          [1.4, 1],
        ] as const) {
          for (let i = 0; i + 3 < f.points.length; i += 2) {
            g.moveTo(f.points[i]!, f.points[i + 1]!).lineTo(f.points[i + 2]!, f.points[i + 3]!);
          }
          g.stroke({ width, color, alpha: BAND.entity * t * alpha });
        }
      } else if (f.kind === 'rupture') {
        // §17.1 — a Rupture is a drawn mark that closes on itself before it
        // detonates, so the hit is telegraphed rather than arbitrary.
        const closing = 1 - t;
        g.circle(f.x, f.y, f.radius * (0.35 + closing * 0.65)).stroke({
          width: 1.5,
          color,
          alpha: BAND.inFlight,
        });
        for (let i = 0; i < 4; i++) {
          const a = (i / 4) * Math.PI * 2 + closing * 2;
          const rr = f.radius * (0.35 + closing * 0.65);
          g.moveTo(f.x + Math.cos(a) * rr * 0.7, f.y + Math.sin(a) * rr * 0.7).lineTo(
            f.x + Math.cos(a) * rr,
            f.y + Math.sin(a) * rr,
          );
        }
        g.stroke({ width: 2, color, alpha: BAND.telegraph * closing });
      } else if (f.kind === 'crit') {
        // A crit reads as a white starburst: unmistakable, and it does not need
        // damage numbers to be legible (§19.4 keeps those off by default).
        for (let i = 0; i < 6; i++) {
          const a = (i / 6) * Math.PI * 2 + f.life * 3;
          const inner = f.radius * (0.4 + (1 - t) * 0.5);
          const outer = f.radius * (0.9 + (1 - t) * 0.7);
          g.moveTo(f.x + Math.cos(a) * inner, f.y + Math.sin(a) * inner).lineTo(
            f.x + Math.cos(a) * outer,
            f.y + Math.sin(a) * outer,
          );
        }
        g.stroke({ width: 2, color: PALETTE.player, alpha: BAND.telegraph * t });
      } else if (f.kind === 'hurt') {
        g.circle(f.x, f.y, TUNABLE.playerRadius + 18 * (1 - t)).stroke({
          width: 3,
          color: PALETTE.signal,
          alpha: BAND.telegraph * t,
        });
      }
    }
  }

  /**
   * §16.2 — the player is the only full-brightness object in the universe.
   *
   * The chassis, and what the rings around it mean. Both were wrong.
   *
   * **The hull** was a triangle pointed along `dirX/dirY`, which is a *digital*
   * direction — eight values, straight from the keyboard — so the avatar snapped
   * through 45° steps while everything else in the game moved smoothly. And it
   * was the only thing on screen that never animated: enemies trace themselves
   * in, projectiles trail, debris decomposes, and the player was a static
   * outline. Facing is now smoothed here in the renderer (never in the sim — a
   * presentation angle must not feed back into a deterministic run), the hull
   * banks into its turns, and it burns a thruster whose length follows speed.
   *
   * **The rings** were two arcs that both drew `staticFraction` — the same
   * number twice, one of them by mistake — and static Cycle reservation is the
   * one quantity on the HUD that *cannot change while you play*. A dial that
   * never moves is decoration. So the ring is Heat now: the number that can end
   * the run, that changes every second, and that the player would otherwise have
   * to look away from their character to read. Tier thresholds are marked, so
   * "how close am I" is answerable at a glance rather than by arithmetic.
   */
  private drawPlayer(world: World, heat: number, dt: number): void {
    const g = this.gPlayer;
    g.clear();
    // A shallow copy at the interpolated position: everything below reads `p.x`
    // and `p.y`, and the avatar has to be drawn where the *display* says it is,
    // not where the last 60Hz tick left it. See render().
    const p = { ...world.player, x: this.playerX, y: this.playerY };
    if (!p.alive) return;

    // ---- animation state -------------------------------------------------
    //
    // All of it derived from sim state and wall-clock, none of it fed back.
    const speed = Math.hypot(p.vx, p.vy);
    const moving = speed > 1;
    const target = moving ? Math.atan2(p.vy, p.vx) : this.facing;
    // Exponential approach, framerate-independent. Fast enough that the ship
    // still feels responsive (the turn completes in about 90 ms), slow enough
    // that a diagonal tap sweeps instead of teleporting.
    const turn = angleDiff(target, this.facing);
    const k = 1 - Math.exp(-dt * 26);
    this.facing += turn * k;
    // Wrapped rather than left to accumulate: turning is unbounded and the angle
    // is only ever consumed as a sine and a cosine, so there is no reason for it
    // to grow all run.
    if (this.facing > Math.PI) this.facing -= Math.PI * 2;
    else if (this.facing < -Math.PI) this.facing += Math.PI * 2;
    // Banking: how hard it is turning right now, smoothed and clamped. This is
    // the cue that makes a turn *readable* — the silhouette changes shape, so
    // you see the manoeuvre and not just the new heading.
    const rate = dt > 0 ? (turn * k) / dt : 0;
    this.bank += (Math.max(-1, Math.min(1, rate / 9)) - this.bank) * Math.min(1, dt * 12);
    const thrustTarget = moving ? Math.min(1, speed / (TUNABLE.playerMoveSpeed * 1.05)) : 0;
    this.thrust += (thrustTarget - this.thrust) * Math.min(1, dt * 14);
    this.pulsePhase += dt;

    this.particles.drawAfterimages(g, TUNABLE.playerRadius, (gg, x, y, r, angle) => {
      polygonPath(gg, shapeOutline('triangle', x, y, r, angle));
    });

    // ---- the Heat ring (§19.4) -------------------------------------------
    const ringR = TUNABLE.playerRadius + 12;
    const wobble = heat > 0.3 ? this.jitter(heat * 1.6 * VISUAL.degradationIntensity) : 0;

    g.circle(p.x + wobble, p.y, ringR).stroke({
      width: 2,
      color: PALETTE.structure,
      alpha: BAND.structure * 1.8,
    });

    // The tier thresholds used to be two tick marks across the track, and they
    // read as "what are these two lines?" — a mark that has to be explained is
    // worse than no mark. The *arc itself* changes colour at each tier instead:
    // one instrument, three states, nothing extra drawn.

    const heatArc = heat * Math.PI * 2;
    if (heatArc > 0.001) {
      const tierColour =
        heat >= 0.7 ? PALETTE.signal : heat >= 0.4 ? 0xd59a3c : PALETTE.voltaic;
      arcSegment(g, p.x + wobble, p.y, ringR, -Math.PI / 2, -Math.PI / 2 + heatArc);
      g.stroke({ width: 3, color: tierColour, alpha: BAND.entity });
    }

    // Dash: a short arc across the bottom, never a second full ring.
    //
    // Two concentric rings around the avatar is what made the old version
    // unreadable — a ring is a *shape*, and two of them read as one ornament
    // rather than as two instruments. A 120° arc pinned to the bottom of the
    // screen (it does not rotate with the hull) cannot be mistaken for the Heat
    // ring above it, and it fills from the middle out, so "ready" is a symmetric
    // bar and anything else is visibly partial.
    const dashSpan = Math.PI * 0.66;
    const dashMid = Math.PI / 2;
    const dashMax = TUNABLE.dashCooldown / (1 + world.bonuses.dashHaste);
    const ready = p.dashCooldown > 0 ? 1 - p.dashCooldown / dashMax : 1;
    arcSegment(g, p.x, p.y, ringR + 6, dashMid - dashSpan / 2, dashMid + dashSpan / 2);
    g.stroke({ width: 1, color: PALETTE.structure, alpha: BAND.structure * 1.6 });
    if (ready > 0.001) {
      const half = (dashSpan / 2) * ready;
      arcSegment(g, p.x, p.y, ringR + 6, dashMid - half, dashMid + half);
      g.stroke({
        width: 2,
        color: ready >= 1 ? 0x9fd0ff : 0x7f98bb,
        alpha: ready >= 1 ? BAND.inFlight : BAND.structure * 2.2,
      });
    }

    if (world.budget.stalled) {
      g.circle(p.x, p.y, ringR + 10).stroke({
        width: 2,
        color: PALETTE.signal,
        alpha: BAND.telegraph,
      });
    }

    // §11.2 — inside a Suppressor's zone the Ring greys out and spurs, so the
    // player can see their engine is offline without reading the HUD.
    if (world.suppressedNow) {
      g.circle(p.x, p.y, ringR + 7).stroke({ width: 2, color: 0x8b98a6, alpha: BAND.inFlight });
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2 + world.time * 0.8;
        g.moveTo(p.x + Math.cos(a) * (ringR + 4), p.y + Math.sin(a) * (ringR + 4)).lineTo(
          p.x + Math.cos(a) * (ringR + 11),
          p.y + Math.sin(a) * (ringR + 11),
        );
      }
      g.stroke({ width: 1, color: 0x8b98a6, alpha: BAND.inFlight });
    }

    // §18.2 — the beat grid, made visible. Quantize pays a bonus for firing on
    // the beat, which is meaningless if the beat cannot be perceived; until
    // audio exists the Ring carries it. Shown only when a row actually uses it,
    // so it is information rather than decoration.
    if (world.engine.compiled.some((c) => c.live && c.ctx.quantize > 0)) {
      const step = 60 / TUNABLE.beatsPerMinute / 4;
      const phase = (world.time % step) / step;
      const swell = phase < 0.25 ? 1 - phase * 4 : phase > 0.75 ? (phase - 0.75) * 4 : 0;
      if (swell > 0) {
        g.circle(p.x, p.y, ringR + 16 + swell * 6).stroke({
          width: 1.5,
          color: PALETTE.voltaic,
          alpha: BAND.inFlight * swell,
        });
      }
    }

    // ---- the chassis -----------------------------------------------------
    //
    // Drawn in the hull's own frame and rotated once, rather than as a triangle
    // primitive, because every part of it needs to move independently: the
    // wings sweep with the bank, the intake breathes, the thruster burns. The
    // silhouette is still an arrowhead — it has to read as "you, pointing that
    // way" in a screenshot full of chaos (§23.3) — but it is now a *machine*
    // with a front, a spine and an exhaust, which is what gives later chassis
    // somewhere to differ.
    const r = TUNABLE.playerRadius;
    const a = this.facing;
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    // Local x is forward, local y is right.
    const at = (fx: number, fy: number): [number, number] => [
      p.x + fx * cos - fy * sin,
      p.y + fx * sin + fy * cos,
    ];
    const bank = this.bank;

    // The exhaust, behind everything. Its length is thrust plus a fast flicker,
    // which is the cheapest possible thing that reads as *combustion* rather
    // than as a shape that got longer.
    if (this.thrust > 0.02) {
      const flicker = 0.82 + 0.18 * Math.sin(this.pulsePhase * 47);
      // Kept inside the Heat ring: an exhaust that pokes through the player's
      // own instrument turns the avatar into a two-part shape at a glance.
      const len = r * (0.3 + this.thrust * 0.8) * flicker;
      const [tx, ty] = at(-r * 0.72, 0);
      const [ex, ey] = at(-r * 0.72 - len, 0);
      const [l1x, l1y] = at(-r * 0.72, -r * 0.3);
      const [l2x, l2y] = at(-r * 0.72, r * 0.3);
      g.moveTo(l1x, l1y).lineTo(ex, ey).lineTo(l2x, l2y);
      g.stroke({ width: 2, color: HOT_CORE.thermal, alpha: BAND.inFlight * this.thrust });
      g.moveTo(tx, ty).lineTo(ex, ey);
      g.stroke({ width: 1, color: PALETTE.player, alpha: BAND.entity * this.thrust });
    }

    // Hull: a swept arrowhead. The trailing corners move opposite the bank, so
    // the ship visibly leans through a turn.
    const nose = at(r * 1.18, 0);
    const right = at(-r * 0.62, r * (0.86 + bank * 0.22));
    const tail = at(-r * 0.34, 0);
    const left = at(-r * 0.62, -r * (0.86 - bank * 0.22));
    g.moveTo(nose[0], nose[1])
      .lineTo(right[0], right[1])
      .lineTo(tail[0], tail[1])
      .lineTo(left[0], left[1])
      .lineTo(nose[0], nose[1]);
    g.stroke({ width: 2.5, color: PALETTE.player, alpha: BAND.player });

    // The core: the Engine, seen through the hull. It breathes when idle and
    // spins up with Heat, so the thing that kills you is legible on the avatar
    // itself and not only on the ring around it.
    const spin = this.pulsePhase * (1.1 + heat * 7);
    const coreR = r * (0.3 + 0.05 * Math.sin(this.pulsePhase * 2.2) + heat * 0.1);
    const coreColour = heat > 0.01 ? mix(PALETTE.player, PALETTE.signal, heat * 0.8) : PALETTE.player;
    for (let i = 0; i < 3; i++) {
      const t0 = spin + (i / 3) * Math.PI * 2;
      const [x0, y0] = at(Math.cos(t0) * coreR, Math.sin(t0) * coreR);
      const t1 = spin + ((i + 1) / 3) * Math.PI * 2;
      const [x1, y1] = at(Math.cos(t1) * coreR, Math.sin(t1) * coreR);
      g.moveTo(x0, y0).lineTo(x1, y1);
    }
    g.stroke({ width: 1.5, color: coreColour, alpha: BAND.entity });

    if (p.dashTimer > 0) {
      // Mid-dash: the hull streaks. Reads as speed, and marks the i-frames.
      const [bx, by] = at(-r * 2.2, 0);
      g.moveTo(nose[0], nose[1]).lineTo(bx, by);
      g.stroke({ width: 1, color: PALETTE.player, alpha: BAND.inFlight });
    }
    if (p.iframes > 0) {
      g.circle(p.x, p.y, r + 5).stroke({
        width: 1,
        color: PALETTE.player,
        alpha: BAND.entity,
      });
    }
  }

  /** §19.4 — off-screen indicators. Never for regular enemies. */
  private drawIndicators(world: World): void {
    const g = this.gIndicators;
    g.clear();
    const margin = 34;
    const cx = this.viewW / 2;
    const cy = this.viewH / 2;

    for (const b of world.terminals) {
      if (this.camera.isVisible(b.x, b.y, 0)) continue;
      const dx = b.x - this.camera.x;
      const dy = b.y - this.camera.y;
      const angle = Math.atan2(dy, dx);
      const scale = Math.min(
        (cx - margin) / Math.max(1e-3, Math.abs(Math.cos(angle))),
        (cy - margin) / Math.max(1e-3, Math.abs(Math.sin(angle))),
      );
      const ix = cx + Math.cos(angle) * scale;
      const iy = cy + Math.sin(angle) * scale;

      const color = TERMINAL_COLOR[b.kind];
      polygonPath(g, shapeOutline('triangle', ix, iy, 9, angle));
      g.stroke({ width: 2, color, alpha: BAND.entity });

      const dist = Math.hypot(dx, dy);
      const ticks = Math.min(4, Math.max(1, Math.round(2400 / Math.max(400, dist))));
      for (let i = 0; i < ticks; i++) {
        g.circle(
          ix - Math.cos(angle) * (16 + i * 6),
          iy - Math.sin(angle) * (16 + i * 6),
          1.4,
        ).fill({ color, alpha: BAND.inFlight });
      }
    }

    // §7.3 — and the Magnet, which is the only pickup that gets one. A rare
    // object you never learn about is a rare object that does not exist, and it
    // lands wherever the kill happened rather than somewhere the designer put
    // it. The chevron pulses so it cannot be mistaken for a terminal.
    for (const item of world.pickups) {
      if (item.kind !== 'magnet' || !item.alive) continue;
      if (this.camera.isVisible(item.x, item.y, 40)) continue;
      const dx = item.x - this.camera.x;
      const dy = item.y - this.camera.y;
      const angle = Math.atan2(dy, dx);
      const scale = Math.min(
        (cx - margin) / Math.max(1e-3, Math.abs(Math.cos(angle))),
        (cy - margin) / Math.max(1e-3, Math.abs(Math.sin(angle))),
      );
      const ix = cx + Math.cos(angle) * scale;
      const iy = cy + Math.sin(angle) * scale;
      const beat = 0.6 + 0.4 * Math.sin(item.age * 5);

      polygonPath(g, shapeOutline('triangle', ix, iy, 10 + beat * 3, angle));
      g.stroke({ width: 2, color: PALETTE.voltaic, alpha: BAND.telegraph });
      g.circle(ix, iy, 3.5).fill({ color: HOT_CORE.voltaic, alpha: BAND.telegraph * beat });
    }
  }

  /**
   * Draw the frame to the screen, timed.
   *
   * Called by the game loop after `render()` has built the scene. The timer
   * bracket opens at the top of `render()` — the light, mask, emissive and mip
   * passes are this frame's GPU work as much as the composite is — and closes
   * here, so `gpu.lastMs` is finally the whole frame rather than the flattering
   * half of it.
   */
  present(): void {
    this.syncDisplay();
    this.app.render();
    this.gpu.end();
  }

  /**
   * The canvas resolution cap, live. Clamped to the display's actual ratio —
   * asking for 2x on a 1x panel is just memory. The world is composed at CSS
   * resolution regardless (see gfx/bloom.ts), so this is the sheets' text
   * sharpness and the final composite's pixel count, and dropping it mid-run
   * is safe: every buffer is keyed to the CSS size, which does not change.
   */
  setResolution(scale: number): void {
    const target = Math.min(Math.max(1, scale), window.devicePixelRatio || 1);
    if (Math.abs(this.app.renderer.resolution - target) < 0.01) return;
    this.app.renderer.resolution = target;
    this.app.resize();
  }

  /**
   * Install the display transform, or take it back off.
   *
   * Inside the timer's bracket rather than at init, because a stage filter is a
   * fullscreen copy and a gamma of 1 is the identity — a player whose screen is
   * already right must not pay a pass for the setting merely existing. One
   * uniform write per frame is the price of never having to remember to call
   * this when the setting moves.
   */
  private syncDisplay(): void {
    const want = this.display.sync();
    if (want === this.displayOn) return;
    this.displayOn = want;
    this.app.stage.filters = want ? [this.display.filter] : [];
  }

  /** Diagnostics for the HUD. */
  get debrisCount(): number {
    return this.particles.count;
  }
}

const HUE_ORDER: readonly Hue[] = ['thermal', 'voltaic', 'void'];

/**
 * How far a wall's blocks may churn past it, in world units.
 *
 * Proportional to the wall's short side and hard-capped. A barrier ninety units
 * across cannot grow by two hundred and still describe where the collision is —
 * and since the mass only ever dilates, the excursion is the whole error budget
 * between what you see and what you walk into.
 */
function reachFor(w: number, h: number): number {
  return Math.min(SHELL.ruinReachMax, Math.min(w, h) * SHELL.ruinReach);
}

/**
 * STORY-AND-TONE §8.3 — every room that declares a material, as a region.
 *
 * Read straight off the arena, so a room says what it is made of in the same
 * `shell` block where it says how fast it churns, and nothing else has to know.
 * Built once per run: rooms do not move.
 */
/**
 * How much decomposition the campaign adds on top of whatever a room authored.
 *
 * Additive and clamped rather than a maximum: a floor that only lifted the
 * *quietest* rooms would leave the Cell — already terminal — unchanged, and the
 * point is that the whole building is further gone, the deep rooms included.
 */
function siteFloor(world: World): number {
  return Math.max(0, Math.min(1, world.config.siteDecay ?? 0)) * 0.6;
}

function materialZonesFor(world: World): MaterialZone[] {
  const zones: MaterialZone[] = [];
  const floor = siteFloor(world);
  for (const level of world.arena.levels ?? []) {
    const oil = (level.shell?.['oil'] as number | undefined) ?? SHELL.oil;
    const fray = (level.shell?.['fray'] as number | undefined) ?? SHELL.fray;
    const authored = (level.shell?.['dissolve'] as number | undefined) ?? SHELL.dissolve;
    const dissolve = Math.min(2, authored + floor);
    const decay = (level.shell?.['decay'] as number | undefined) ?? SHELL.decay;
    const shred = (level.shell?.['shred'] as number | undefined) ?? SHELL.shred;
    if (
      oil === SHELL.oil &&
      fray === SHELL.fray &&
      dissolve === SHELL.dissolve &&
      decay === SHELL.decay &&
      shred === SHELL.shred
    ) {
      continue;
    }
    zones.push({ x: level.x, y: level.y, w: level.w, h: level.h, oil, fray, dissolve, decay, shred });
  }
  return zones;
}

/** Terminals are told apart by colour as well as by frame (§16.4). */
const TERMINAL_COLOR: Record<TerminalKind, number> = {
  beacon: PALETTE.beacon,
  recompile: PALETTE.void,
  extract: PALETTE.thermal,
  // §12.4 — the Cache is voltaic: it is the one POI that hands you a card, and
  // voltaic is the hue this game already uses for "your side of the fight".
  cache: PALETTE.voltaic,
  // §21b.5 — a gate is the map itself opening, so it takes the beacon blue the
  // game already uses for "a place worth going to", at full brightness.
  gate: 0x9fd0ff,
  // §21b.4 — the Cooler is the one POI that is a place rather than a button.
  cooler: PALETTE.voltaic,
  // LEVELS §6 — Bureau furniture, not services: a desaturated paper-blue that
  // sits below every service POI in urgency. Stations and files are the two
  // things on the map that will still be there in a minute.
  station: 0x7f9cbf,
  fragment: 0xa8c2de,
};

/**
 * §16.4 — the mark vocabulary, as a table.
 *
 * A variant is a known silhouette plus one added glyph, and the point of the
 * table is that adding the twentieth one costs a line here and a line of JSON.
 * Every mark obeys the same three rules: it sits *outside* the body so it never
 * hides the shape, it uses form rather than a new colour (hue is spoken for by
 * threat class, §16.3), and it fades in with `born` like everything else.
 */
type MarkDraw = (
  g: Graphics,
  e: World['enemies'][number],
  r: number,
  born: number,
  color: number,
  time: number,
  jitter: (amount: number) => number,
) => void;

const ENEMY_MARKS: Record<EnemyMark, MarkDraw> = {
  // Armour on the leading edge. Answers single-target spam: flank it or use area.
  shield: (g, e, r, born, color) => {
    const facing = Math.atan2(e.aimY, e.aimX);
    arcSegment(g, e.x, e.y, r + 5, facing - 1.1, facing + 1.1);
    g.stroke({ width: 3, color, alpha: BAND.telegraph * born });
  },
  // A charge building toward a detonation. Brightens as it nears the player, so
  // "do not kill this one next to you" is legible before it is a lesson.
  charge: (g, e, r, born, color, time) => {
    const pulse = 0.55 + 0.45 * Math.sin(time * 5 + e.id);
    g.circle(e.x, e.y, r * 0.45).fill({ color: PALETTE.signal, alpha: 0.5 * pulse * born });
    g.circle(e.x, e.y, r + 3 + pulse * 2).stroke({
      width: 1,
      color: PALETTE.signal,
      alpha: BAND.structure * 2 * pulse * born,
    });
    void color;
  },
  // Phases. Drawn as a dashed ring, so the rhythm is readable while it is solid.
  phase: (g, e, r, born, color, time) => {
    for (let i = 0; i < 8; i += 2) {
      const a0 = (i / 8) * Math.PI * 2 + time * 1.4;
      arcSegment(g, e.x, e.y, r + 4, a0, a0 + Math.PI / 8);
    }
    g.stroke({ width: 1.5, color, alpha: BAND.inFlight * born });
  },
  // Carries children. A second outline just inside the first: something in there.
  brood: (g, e, r, born, color: number) => {
    g.circle(e.x, e.y, r * 0.62).stroke({ width: 1.5, color, alpha: BAND.inFlight * born });
    g.circle(e.x, e.y, r * 0.34).stroke({ width: 1, color, alpha: BAND.structure * 2 * born });
  },
  // Elite of its family. Three spikes above, the genre's oldest shorthand.
  crown: (g, e, r, born) => {
    for (let i = -1; i <= 1; i++) {
      const a = -Math.PI / 2 + i * 0.42;
      g.moveTo(e.x + Math.cos(a) * (r + 3), e.y + Math.sin(a) * (r + 3)).lineTo(
        e.x + Math.cos(a) * (r + 10),
        e.y + Math.sin(a) * (r + 10),
      );
    }
    g.stroke({ width: 2, color: PALETTE.beacon, alpha: BAND.entity * born });
  },
  // Hurts to touch, more than its size suggests.
  spines: (g, e, r, born, color, time, jitter) => {
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + time * 0.6;
      const out = r + 6 + jitter(1.5);
      g.moveTo(e.x + Math.cos(a) * r, e.y + Math.sin(a) * r).lineTo(
        e.x + Math.cos(a) * out,
        e.y + Math.sin(a) * out,
      );
    }
    g.stroke({ width: 1.5, color, alpha: BAND.entity * born });
  },
};

/**
 * Which way an enemy is pointing.
 *
 * A Lancer and a Bulwark face what they are aimed at; everything else faces the
 * way it is travelling. Lifted out of drawEnemies so the batched pass and the
 * per-enemy pass cannot disagree about it.
 */
function facingOf(
  world: World,
  e: World['enemies'][number],
  def: { behavior?: string; shieldArc?: number },
): number {
  if (def.behavior === 'lance' || def.shieldArc) {
    if (e.beamActive > 0 || def.shieldArc) {
      return Math.atan2(world.player.y - e.y, world.player.x - e.x);
    }
    return e.facing;
  }
  return Math.atan2(e.aimY, e.aimX);
}

/** Shortest signed distance between two angles. */
function angleDiff(a: number, b: number): number {
  let d = (a - b) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

const CORNERS = [
  [-1, -1],
  [1, -1],
  [-1, 1],
  [1, 1],
] as const;

/**
 * §10.1 — shape is behaviour. A player who has never seen an enemy must predict
 * what it does from silhouette alone, so every behaviour gets its own outline
 * and none of them share one.
 */
/**
 * §11.1 — enemies visibly desaturate toward the hue you have been over-using, so
 * adaptive resistance is legible in the world rather than only in the HUD.
 */

/** Merged drops carry more value, so they draw bigger. Sub-linear, and capped
 *  tighter now that merging is rare — a merged pile should read as chunky, not
 *  as a single object that ate the others. */
function pickupScale(value: number): number {
  return Math.min(1.9, 1 + Math.log2(Math.max(1, value)) * 0.26);
}

function mix(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 0xff;
  const ag = (a >> 8) & 0xff;
  const ab = a & 0xff;
  const br = (b >> 16) & 0xff;
  const bg = (b >> 8) & 0xff;
  const bb = b & 0xff;
  return (
    (Math.round(ar + (br - ar) * t) << 16) |
    (Math.round(ag + (bg - ag) * t) << 8) |
    Math.round(ab + (bb - ab) * t)
  );
}

export { HUE_COLOR };
export const COLOR = PALETTE;
