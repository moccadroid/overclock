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
import type { Hue } from '../sim/types';
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
  /** Shared phase for the loot pulse — see drawPickups. Presentation only. */
  private lootPhase = 0;
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

  private get scale(): number {
    return Math.min(this.app.screen.width / this.viewWidth, this.app.screen.height / VIEW_HEIGHT);
  }

  /** Apply the shared world->screen transform to every layer that needs it. */
  private applyTransform(): void {
    const scale = this.scale;
    const offsetX = (this.app.screen.width - this.viewWidth * scale) / 2 + this.shakeX;
    const offsetY = (this.app.screen.height - VIEW_HEIGHT * scale) / 2 + this.shakeY;
    const worldX = this.viewWidth / 2 - this.camera.x;
    const worldY = VIEW_HEIGHT / 2 - this.camera.y;

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
    this.drawPlayer(world, heat);
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
    this.emitLights(world, heat, melt, frameDt);
    this.post.update(
      VIEW,
      Math.max(heat * 0.6, melt),
      frameDt,
      this.app.screen.width,
      this.app.screen.height,
    );
    const off = PostPass.isOff(VIEW) && heat < 0.02 && melt < 0.02;
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
    for (const proj of world.projectiles) {
      if (!proj.alive || !this.camera.isVisible(proj.x, proj.y, 200)) continue;
      const speed = Math.sqrt(proj.vx * proj.vx + proj.vy * proj.vy);
      const trail = Math.min(190, speed * 0.055);
      if (trail < 24) {
        lights.point(proj.x, proj.y, 95, HUE_COLOR[proj.hue], 0.16);
      } else {
        const k = trail / Math.max(1, speed);
        lights.beam(
          proj.x - proj.vx * k,
          proj.y - proj.vy * k,
          proj.x,
          proj.y,
          150,
          HUE_COLOR[proj.hue],
          0.13,
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
      const colour = item.kind === 'xp' ? PALETTE.xp : HUE_COLOR[item.hue];
      lights.point(item.x, item.y, 48, colour, 0.1);
    }

    // §13.2 — Meltdown lights the whole arena from nowhere, which is the world
    // overexposing rather than any object getting brighter. An area, not a
    // point: the whole screen is lit, not a lamp standing where the player is.
    if (melt > 0) {
      lights.area(world.player.x, world.player.y, 2200, 0xffb000, melt * 0.16);
    }

    const scale = this.scale;
    const offsetX = (this.app.screen.width - this.viewWidth * scale) / 2 + this.shakeX;
    const offsetY = (this.app.screen.height - VIEW_HEIGHT * scale) / 2 + this.shakeY;
    const worldX = this.viewWidth / 2 - this.camera.x;
    const worldY = VIEW_HEIGHT / 2 - this.camera.y;
    lights.render(scale, offsetX + worldX * scale, offsetY + worldY * scale, dt);
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
    const load = world.budget.dynamicFraction;
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
      alpha: BAND.structure * (0.75 + load * 0.9) * (1 + pulse * 0.34),
    });

    g.rect(0, 0, arena.width, arena.height).stroke({
      width: 2,
      color: PALETTE.structure,
      alpha: BAND.structure * 1.6 * (1 + pulse * 0.22),
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
      label.text = near
        ? moving
          ? 'HOLD STILL'
          : 'HOLD  E'
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
    let anyXp = false;
    for (const item of world.pickups) {
      if (item.kind !== 'xp') continue;
      if (!this.camera.isVisible(item.x, item.y, 20)) continue;
      const y = item.y + Math.sin(item.age * 3.4 + item.id) * 1.8;
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

    for (const hue of HUE_ORDER) {
      const color = HUE_COLOR[hue];

      let any = false;
      for (const item of world.pickups) {
        if (item.kind === 'xp' || item.hue !== hue) continue;
        if (!this.camera.isVisible(item.x, item.y, 20)) continue;
        const y = item.y + Math.sin(item.age * 3.4 + item.id) * 1.8;
        const s = pickupScale(item.value);
        const inner = 2.6 * s;
        const outer = (6.5 + pulse * 1.6) * s;
        g.moveTo(item.x - outer, y).lineTo(item.x - inner, y);
        g.moveTo(item.x + inner, y).lineTo(item.x + outer, y);
        g.moveTo(item.x, y - outer).lineTo(item.x, y - inner);
        g.moveTo(item.x, y + inner).lineTo(item.x, y + outer);
        any = true;
      }
      if (any) g.stroke({ width: 1.4, color, alpha: BAND.inFlight * pulse });

      any = false;
      for (const item of world.pickups) {
        if (item.kind === 'xp' || item.hue !== hue) continue;
        if (!this.camera.isVisible(item.x, item.y, 20)) continue;
        const y = item.y + Math.sin(item.age * 3.4 + item.id) * 1.8;
        g.circle(item.x, y, 3.4 * pickupScale(item.value));
        any = true;
      }
      // Band 4, not band 1: §16.2 reserves full luminance for the player alone,
      // and loot popping is not worth breaking the one rule that lets you find
      // yourself in chaos.
      if (any) g.fill({ color, alpha: BAND.entity });
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
    for (const e of world.enemies) {
      if (!this.camera.isVisible(e.x, e.y, e.radius + 24)) continue;
      const def = getEnemy(e.defId);
      const born = Math.min(1, e.spawnAge / VISUAL.drawInTime);
      const flashing = e.flash > 0;
      // §11.1 — desaturated in proportion to how resistant it is to your hue.
      const resist = Math.max(world.resistance[e.hue], e.adaptive[e.hue]);
      const color = flashing ? PALETTE.player : desaturate(HUE_COLOR[e.hue], resist);
      const r = e.radius;
      const health = e.hp / e.maxHp;
      // §10.3 Phasing — untargetable, and it has to look it.
      if (e.phased && !flashing) {
        g.circle(e.x, e.y, r + 3).stroke({ width: 1, color, alpha: BAND.structure * born });
        continue;
      }

      const facing =
        def.behavior === 'lance' || def.shieldArc
          ? e.beamActive > 0 || def.shieldArc
            ? Math.atan2(world.player.y - e.y, world.player.x - e.x)
            : e.facing
          : Math.atan2(e.aimY, e.aimX);
      const verts = shapeOutline(def.shape, e.x, e.y, r, facing);
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
      const zone = e.affixes.includes('anchored')
        ? TUNABLE.affixAnchoredZone
        : (def.zoneRadius ?? 0);
      if (zone > 0) {
        const segments = 40;
        for (let i = 0; i < segments; i += 2) {
          const a0 = (i / segments) * Math.PI * 2 - e.spawnAge * 0.4;
          const a1 = ((i + 1) / segments) * Math.PI * 2 - e.spawnAge * 0.4;
          arcSegment(g, e.x, e.y, zone, a0, a1);
        }
        g.stroke({ width: 2, color: 0x6d7b8c, alpha: BAND.inFlight * born });
        g.circle(e.x, e.y, zone).fill({ color: 0x2a3138, alpha: 0.22 * born });
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
        g.circle(p.x, p.y, 1.7);
        heads = true;
      }
      if (heads) g.fill({ color, alpha: BAND.entity });
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

  /** §16.2 — the player is the only full-brightness object in the universe. */
  private drawPlayer(world: World, heat: number): void {
    const g = this.gPlayer;
    g.clear();
    const p = world.player;
    if (!p.alive) return;

    this.particles.drawAfterimages(g, TUNABLE.playerRadius, (gg, x, y, r, angle) => {
      polygonPath(gg, shapeOutline('triangle', x, y, r, angle));
    });

    // The Ring (§19.4): static reserve, dynamic load, Heat reddening and
    // jittering it. The player's most important instrument lives on the player.
    const ringR = TUNABLE.playerRadius + 12;
    const ringColor = heat > 0.01 ? mix(PALETTE.structure, PALETTE.signal, heat) : PALETTE.structure;
    const wobble = heat > 0.3 ? this.jitter(heat * 1.6 * VISUAL.degradationIntensity) : 0;

    g.circle(p.x + wobble, p.y, ringR).stroke({
      width: 3,
      color: ringColor,
      alpha: BAND.structure * 2.2,
    });

    const staticArc = world.budget.staticFraction * Math.PI * 2;
    if (staticArc > 0.001) {
      arcSegment(g, p.x + wobble, p.y, ringR, -Math.PI / 2, -Math.PI / 2 + staticArc);
      g.stroke({ width: 3, color: 0x7f98bb, alpha: BAND.inFlight });
    }
    const dynArc = world.budget.dynamicFraction * Math.PI * 2;
    if (dynArc > 0.001) {
      arcSegment(g, p.x + wobble, p.y, ringR + 4, -Math.PI / 2, -Math.PI / 2 + dynArc);
      g.stroke({
        width: 2,
        color: heat > 0.4 ? PALETTE.signal : PALETTE.voltaic,
        alpha: BAND.entity,
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

    // Compass-needle avatar: triangle in a circle, pure white, band 1.
    const angle = Math.atan2(p.dirY, p.dirX);
    polygonPath(g, shapeOutline('triangle', p.x, p.y, TUNABLE.playerRadius, angle));
    g.stroke({ width: 3, color: PALETTE.player, alpha: BAND.player });
    g.circle(p.x, p.y, TUNABLE.playerRadius).stroke({
      width: 1,
      color: PALETTE.player,
      alpha: BAND.inFlight,
    });
    if (p.iframes > 0) {
      g.circle(p.x, p.y, TUNABLE.playerRadius + 5).stroke({
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
    const cx = this.viewWidth / 2;
    const cy = VIEW_HEIGHT / 2;

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
};

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
function desaturate(color: number, amount: number): number {
  const r = (color >> 16) & 0xff;
  const g = (color >> 8) & 0xff;
  const b = color & 0xff;
  const grey = Math.round(0.3 * r + 0.59 * g + 0.11 * b);
  const mixTo = (c: number): number => Math.round(c + (grey - c) * amount);
  return (mixTo(r) << 16) | (mixTo(g) << 8) | mixTo(b);
}

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
