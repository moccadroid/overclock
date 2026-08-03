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
import type { EnemyMark, Hue } from '../sim/types';
import type { TerminalKind, World } from '../sim/world';
import { enemy as getEnemy } from '../content/index';
import { Camera } from './camera';
import { BAND, PALETTE, VIEW, VISUAL } from './visual';
import { PostPass } from './gfx/post';
import { LightField } from './gfx/lights';
import { BloomPipeline } from './gfx/bloom';
import { ParticleField } from './gfx/particles';
import { shapeCoreRadius, shapeOutline } from './gfx/shapes';

const HUE_COLOR: Record<Hue, number> = {
  thermal: PALETTE.thermal,
  voltaic: PALETTE.voltaic,
  void: PALETTE.void,
};

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

/**
 * Something that bends the grid. `pull` is a radial displacement in world units,
 * negative to push outward; `swirl` is a tangential rotation in radians at the
 * centre. Both fall off to nothing at `radius`.
 */
interface WarpSource {
  x: number;
  y: number;
  radius: number;
  pull: number;
  swirl: number;
}

const VIEW_HEIGHT = 900;
const VIEW_WIDTH_MIN = 1200;
const VIEW_WIDTH_MAX = 1900;
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

export class Renderer {
  readonly app = new Application();
  camera!: Camera;

  private bloom!: BloomPipeline;
  private readonly post = new PostPass();
  private lights!: LightField;
  private readonly particles = new ParticleField();

  /** Non-blooming schematic: the arena's structure. */
  private readonly structureLayer = new Container();
  /** Everything that emits light. Lives inside the bloom pipeline. */
  private readonly worldLayer = new Container();
  private readonly screenLayer = new Container();

  private readonly gGrid = new Graphics();
  private readonly gRuins = new Graphics();
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
  private world!: World;
  private readonly beaconLabels: Text[] = [];
  /** §17.1 — floating damage-taken numbers. Pooled: Text allocation is not free. */
  private readonly hurtLabels: { text: Text; life: number; x: number; y: number }[] = [];

  /** §17.2 — screenshake: tiny, frequent, hard ceiling regardless of chaos. */
  private shake = 0;
  private shakeX = 0;
  private shakeY = 0;
  private jitterSeed = 1;
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

  async init(mount: HTMLElement, world: World): Promise<void> {
    this.world = world;
    this.camera = new Camera(world.arena);

    await this.app.init({
      background: PALETTE.background,
      resizeTo: window,
      antialias: true,
      autoDensity: true,
      resolution: Math.min(2, window.devicePixelRatio || 1),
    });
    mount.appendChild(this.app.canvas);

    this.bloom = new BloomPipeline(this.app);
    this.lights = new LightField(this.app);
    this.post.setLightTexture(this.lights.source);

    this.structureLayer.addChild(this.gGrid, this.gRuins);
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
    this.app.stage.addChild(
      this.backdrop,
      this.structureLayer,
      this.bloom.output,
      this.screenLayer,
    );

    this.drawRuins();
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
    this.bloom.resize();
    this.lights?.resize();
    if (this.lights) this.post.setLightTexture(this.lights.source);
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

    for (const layer of [this.structureLayer, this.worldLayer]) {
      layer.scale.set(scale);
      layer.position.set(offsetX + worldX * scale, offsetY + worldY * scale);
    }
    this.screenLayer.scale.set(scale);
    this.screenLayer.position.set(offsetX, offsetY);
  }

  // ------------------------------------------------------------------- frame

  /**
   * Hand the renderer the audio clock. Presentation reading presentation — the
   * sim never learns any of this exists, which is the same wall §18 already has.
   */
  setBeat(beat: { beat: number; pulse: number; bpm: number } | null): void {
    this.beat = beat;
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

  render(world: World, frameDt: number, cameraActive: boolean): void {
    if (cameraActive) {
      this.camera.follow(
        world.player.x,
        world.player.y,
        world.player.dirX,
        world.player.dirY,
        frameDt,
      );
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

    this.drawGrid(world);
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

    this.bloom.setAberration(Math.min(1, (tier >= 2 ? 0.5 + 0.5 * heat : 0) + melt * 0.55));
    this.bloom.setTear(world.budget.stalled ? (this.jitter(1) > 0 ? 1 : -1) * 0.6 : melt * 0.12);
    this.bloom.setBloom(VISUAL.bloomIntensity * VIEW.bloom * (1 + heat * 0.35 + melt * 0.5));
    this.bloom.setGlow(VIEW.glow);
    // Step 5: the background lightens toward white as the final minutes approach.
    // The world overexposes.
    const background = mix(PALETTE.background, 0x243044, Math.min(0.85, melt * 0.55));
    this.app.renderer.background.color = background;
    this.backdrop.tint = background;
    // §16.7 — the degradation ladder pushes whatever preset the player chose
    // further than they asked, which is how Heat and Meltdown stay legible as
    // *damage to the picture* rather than as a separate effect.
    this.emitGlitchFields(world);
    this.emitLights(world, heat, melt, frameDt);
    this.post.update(
      VIEW,
      Math.max(heat * 0.6, melt),
      frameDt,
      this.app.screen.width,
      this.app.screen.height,
    );
    // A suppression field lives entirely in this pass, so the pass has to run
    // even for a player who turned every effect off — otherwise Suppressors
    // become invisible on a Schematic preset, which is worse than the ring was.
    const off =
      PostPass.isOff(VIEW) && heat < 0.02 && melt < 0.02 && this.glitchFields.length === 0;
    this.app.stage.filters = off ? [] : [this.post.filter];

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
        lights.point(proj.x, proj.y, 95, hue, 0.16);
        lights.point(proj.x, proj.y, 26, HOT_CORE[proj.hue], 0.85);
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
    const magnitude = this.shake * VISUAL.degradationIntensity * VIEW.shake;
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
   * §16.5 — the grid is an instrument. It brightens and distorts around the
   * avatar in proportion to dynamic Cycle load: your engine's draw is visible in
   * the fabric of the world. During Overheat it tears locally.
   */
  private drawGrid(world: World): void {
    const g = this.gGrid;
    g.clear();

    const view = this.camera.view;
    const step = VISUAL.gridSpacing;
    const load = world.budget.staticFraction;
    const arena = world.arena;

    // Everything that bends the world, in one list. The avatar pushes space
    // outward under load; a vortex pulls it in and twists it. Drawing Pull as a
    // distortion of the grid rather than a wad of strokes on top of it is the
    // difference between "an ugly thing is here" and "space is wrong here".
    const sources: WarpSource[] = [
      {
        x: world.player.x,
        y: world.player.y,
        radius: VISUAL.gridWarpRadius,
        pull: -VISUAL.gridWarpAmount * load * VISUAL.degradationIntensity,
        swirl: 0,
      },
    ];
    for (const z of world.zones) {
      if (z.force <= 0) continue;
      const t = Math.max(0, z.life / z.maxLife);
      // Peaks just after it lands and eases off as it dies, like the pull itself.
      const strength = Math.sin(Math.min(1, (1 - t) * 3) * Math.PI * 0.5) * t;
      sources.push({
        x: z.x,
        y: z.y,
        radius: z.radius * 1.35,
        pull: 64 * strength,
        swirl: 1.15 * strength,
      });
    }
    const warping = sources.some((s) => Math.abs(s.pull) > 0.05);

    const x0 = Math.max(0, Math.floor(view.x / step) * step);
    const x1 = Math.min(arena.width, view.x + view.width + step);
    const y0 = Math.max(0, Math.floor(view.y / step) * step);
    const y1 = Math.min(arena.height, view.y + view.height + step);

    // Vertical lines, subdivided so they can bend around the avatar.
    for (let x = x0; x <= x1; x += step) {
      this.warpedLine(g, x, Math.max(0, view.y - step), x, Math.min(arena.height, y1), sources, warping);
    }
    for (let y = y0; y <= y1; y += step) {
      this.warpedLine(g, Math.max(0, view.x - step), y, Math.min(arena.width, x1), y, sources, warping);
    }
    // §18.2, read backwards. The grid breathes on the quarter note.
    //
    // This is the cheapest possible version of "the picture is on the beat" and
    // by far the highest-value: nothing new is drawn, an existing alpha just
    // takes its ripple from the audio clock instead of from nothing. Play with
    // the sound off and this is invisible; play with it on and the whole arena
    // is entrained before a single detonation lands.
    //
    // It lives on the grid specifically because §16.2 reserves the bright bands
    // for things that matter. Structure is the one layer that can pulse without
    // ever competing with a threat, and the amount is small enough that it reads
    // as the room having a pulse rather than as the grid flashing at you.
    const pulse = this.beat ? this.beat.pulse : 0;
    g.stroke({
      width: 1,
      color: PALETTE.structure,
      alpha: BAND.structure * (0.75 + load * 0.9) * (1 + pulse * 0.85),
    });

    g.rect(0, 0, arena.width, arena.height).stroke({
      width: 2,
      color: PALETTE.structure,
      alpha: BAND.structure * 1.6 * (1 + pulse * 0.5),
    });
  }

  private warpedLine(
    g: Graphics,
    ax: number,
    ay: number,
    bx: number,
    by: number,
    sources: WarpSource[],
    warping: boolean,
  ): void {
    if (!warping) {
      g.moveTo(ax, ay).lineTo(bx, by);
      return;
    }
    // Subdivide by length, not by a fixed count: a 260-unit warp radius needs
    // vertices inside it, and the grid line may span the whole arena.
    const length = Math.hypot(bx - ax, by - ay);
    const steps = Math.max(VISUAL.gridSubdivisions, Math.ceil(length / VISUAL.gridWarpStep));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const bareX = ax + (bx - ax) * t;
      const bareY = ay + (by - ay) * t;
      let x = bareX;
      let y = bareY;
      for (const s of sources) {
        if (Math.abs(s.pull) < 0.05) continue;
        const dx = bareX - s.x;
        const dy = bareY - s.y;
        const d = Math.hypot(dx, dy);
        if (d >= s.radius || d < 0.001) continue;
        // Radial displacement, strongest at the centre and vanishing at the rim.
        const falloff = (1 - d / s.radius) ** 2;
        const shift = (falloff * s.pull) / d;
        x -= dx * shift;
        y -= dy * shift;
        // Tangential twist. This is what makes a vortex read as a vortex: the
        // straight lines of the world visibly wind up around it.
        if (s.swirl !== 0) {
          const twist = falloff * s.swirl;
          const c = Math.cos(twist);
          const sn = Math.sin(twist);
          x += (dx * c - dy * sn - dx);
          y += (dx * sn + dy * c - dy);
        }
      }
      if (i === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
  }

  /** §22 — structure ruins. Blueprint hatching, not a filled block. */
  private drawRuins(): void {
    const g = this.gRuins;
    g.clear();
    for (const r of this.world.arena.ruins) {
      g.rect(r.x, r.y, r.w, r.h);
    }
    g.fill({ color: PALETTE.structure, alpha: 0.16 });

    for (const r of this.world.arena.ruins) {
      g.rect(r.x, r.y, r.w, r.h);
      // Interior scanline hatch — reads as material, stays at band 5.
      for (let y = r.y + 9; y < r.y + r.h; y += 9) {
        g.moveTo(r.x + 3, y).lineTo(r.x + r.w - 3, y);
      }
      // Dimension ticks at the corners: the schematic annotation vocabulary.
      const t = 7;
      g.moveTo(r.x, r.y - t).lineTo(r.x, r.y);
      g.moveTo(r.x + r.w, r.y - t).lineTo(r.x + r.w, r.y);
      g.moveTo(r.x - t, r.y).lineTo(r.x, r.y);
      g.moveTo(r.x - t, r.y + r.h).lineTo(r.x, r.y + r.h);
    }
    g.stroke({ width: 1, color: PALETTE.structure, alpha: BAND.structure * 1.5 });
  }

  // ---------------------------------------------------------------- entities

  /** §16.4 — terminals are blueprint-annotated structures: ticks, label, sweep. */
  private drawTerminals(world: World): void {
    const g = this.gBeacons;
    g.clear();
    this.syncTerminalLabels(world);

    for (const t of world.terminals) {
      const r = TUNABLE.beaconRadius;
      const color = TERMINAL_COLOR[t.kind];

      g.rect(t.x - r, t.y - r, r * 2, r * 2).stroke({ width: 2, color, alpha: BAND.entity });
      // Recompile gets a second, inset frame; Extract a heavier outer bracket —
      // they must be tellable apart from across the arena.
      if (t.kind === 'recompile') {
        g.rect(t.x - r + 6, t.y - r + 6, (r - 6) * 2, (r - 6) * 2);
        g.stroke({ width: 1, color, alpha: BAND.inFlight });
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
      // §12.4 — a POI whose price is a fight has to say so *before* it is paid.
      // "HOLD E" on a Cache would be a trap, and §17.1 does not allow traps.
      const prompt = t.kind === 'cache' ? 'HOLD  E  —  THEY WAKE UP' : 'HOLD  E';
      label.text = near
        ? moving
          ? 'HOLD STILL'
          : prompt
        : `${t.kind.toUpperCase()}_${String(t.id).padStart(2, '0')}`;
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

      if (c.kind === 'sweeper') {
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
      } else if (c.kind === 'cell') {
        const segments = 48;
        for (let i = 0; i < segments; i++) {
          const a0 = (i / segments) * Math.PI * 2;
          const a1 = ((i + 1) / segments) * Math.PI * 2;
          const mid = (a0 + a1) / 2;
          if (c.gapAngles.some((gap) => Math.abs(angleDiff(mid, gap)) < 0.34)) continue;
          arcSegment(g, c.x, c.y, c.radius, a0, a1);
        }
        g.stroke({ width, color, alpha });
      } else {
        const depth = c.advance;
        if (depth > 1) {
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
        }
      }
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
      if (any) g.stroke({ width: 2.2, color, alpha: BAND.entity });

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
        if (filled) g.fill({ color, alpha: 0.08 * ((step + 0.5) / STEPS) });
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
      if (cored) g.stroke({ width: 1.5, color, alpha: BAND.inFlight });
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
        const verts = outlines[vi]!;
        // Draw-in: only trace `born` of the perimeter, so it writes itself on.
        tracePolyline(g, verts, born);
        g.stroke({
          width: flashing ? 3 : 2.2,
          color,
          alpha: (flashing ? BAND.player : BAND.entity) * born,
        });

        if (born >= 1) {
          g.beginPath();
          polygonPath(g, verts);
          g.fill({ color, alpha: 0.08 * health });
        }

        const core = shapeCoreRadius(def.shape, r);
        if (core > 0) {
          g.circle(e.x, e.y, core).stroke({ width: 1.5, color, alpha: BAND.inFlight * born });
        }
      }

      if (e.enriched) {
        g.circle(e.x, e.y, r + 6).stroke({
          width: 1,
          color: PALETTE.beacon,
          alpha: BAND.structure * born,
        });
      }

      // §10.2 Bulwark — the shield arc has to be visible, or "flank it" is not
      // advice, it is a guess.
      if (def.shieldArc) {
        arcSegment(g, e.x, e.y, r + 7, facing - def.shieldArc / 2, facing + def.shieldArc / 2);
        g.stroke({ width: 4, color, alpha: BAND.telegraph * born });
      }

      // §10.2 Suppressor / §10.3 Anchored — the zone where your triggers die.
      //
      // The field itself is a *signal fault* now, drawn by the post pass — see
      // PostPass.setGlitchFields. What stays here is a thin boundary, because
      // the fault has to have a findable edge and a broken region with no rim is
      // just a broken screen. The filled disc and the rotating dashes are gone:
      // twenty of those on screen at once was the arena whiting out.
      const zone = e.affixes.includes('anchored')
        ? TUNABLE.affixAnchoredZone
        : (def.zoneRadius ?? 0);
      if (zone > 0) {
        g.circle(e.x, e.y, zone).stroke({
          width: 1,
          color: 0x6d7b8c,
          alpha: BAND.structure * 1.4 * born,
        });
      }

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
    for (const f of world.fx) {
      if (!this.camera.isVisible(f.x, f.y, f.radius + 60)) continue;
      // Detonations only. A chain is a path between two things that already
      // happened, and holding it would disconnect it from them.
      if ((f.kind === 'burst' || f.kind === 'rupture') && this.waitingForBeat(f.id)) continue;
      const t = Math.max(0, f.life / f.maxLife);
      const color = HUE_COLOR[f.hue];

      if (f.kind === 'burst') {
        // Expanding ring plus radial ticks — a detonation drawn as a schematic.
        const radius = f.radius * (1.08 - t * 0.28);
        g.circle(f.x, f.y, radius).stroke({ width: 2 + 2 * t, color, alpha: BAND.entity * t });
        for (let i = 0; i < 12; i++) {
          const a = (i / 12) * Math.PI * 2;
          g.moveTo(f.x + Math.cos(a) * radius * 0.82, f.y + Math.sin(a) * radius * 0.82).lineTo(
            f.x + Math.cos(a) * radius,
            f.y + Math.sin(a) * radius,
          );
        }
        g.stroke({ width: 1, color, alpha: BAND.inFlight * t });
      } else if (f.kind === 'chain') {
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
    const p = world.player;
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

  /** Diagnostics for the HUD. */
  get debrisCount(): number {
    return this.particles.count;
  }
}

const HUE_ORDER: readonly Hue[] = ['thermal', 'voltaic', 'void'];

/** Terminals are told apart by colour as well as by frame (§16.4). */
const TERMINAL_COLOR: Record<TerminalKind, number> = {
  beacon: PALETTE.beacon,
  recompile: PALETTE.void,
  extract: PALETTE.thermal,
  // §12.4 — the Cache is voltaic: it is the one POI that hands you a card, and
  // voltaic is the hue this game already uses for "your side of the fight".
  cache: PALETTE.voltaic,
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

function polygonPath(g: Graphics, points: readonly [number, number][]): void {
  points.forEach(([x, y], i) => (i === 0 ? g.moveTo(x, y) : g.lineTo(x, y)));
  const first = points[0];
  if (first) g.lineTo(first[0], first[1]);
}

/**
 * §17.1 — "entities draw themselves in: stroke traces the outline over 200ms".
 * Walks `progress` of the closed perimeter, cutting the final edge partway.
 */
function tracePolyline(g: Graphics, points: readonly [number, number][], progress: number): void {
  if (points.length === 0) return;
  if (progress >= 1) {
    polygonPath(g, points);
    return;
  }
  const closed = [...points, points[0]!];
  let total = 0;
  for (let i = 0; i + 1 < closed.length; i++) {
    total += Math.hypot(closed[i + 1]![0] - closed[i]![0], closed[i + 1]![1] - closed[i]![1]);
  }
  let remaining = total * progress;
  g.moveTo(closed[0]![0], closed[0]![1]);
  for (let i = 0; i + 1 < closed.length && remaining > 0; i++) {
    const [ax, ay] = closed[i]!;
    const [bx, by] = closed[i + 1]!;
    const len = Math.hypot(bx - ax, by - ay);
    if (len <= remaining) {
      g.lineTo(bx, by);
      remaining -= len;
    } else {
      const t = remaining / len;
      g.lineTo(ax + (bx - ax) * t, ay + (by - ay) * t);
      remaining = 0;
    }
  }
}

/**
 * Pixi v8 follows canvas path semantics: arc() connects from the path's current
 * point, which is (0, 0) on a fresh path — an unguarded arc trails a line back
 * to the world origin. Always seed the subpath.
 */
function arcSegment(
  g: Graphics,
  cx: number,
  cy: number,
  r: number,
  start: number,
  end: number,
): void {
  g.moveTo(cx + Math.cos(start) * r, cy + Math.sin(start) * r);
  g.arc(cx, cy, r, start, end);
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
