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
import { Application, Container, Graphics, Text } from 'pixi.js';
import { TUNABLE } from '../sim/tunables';
import type { Hue } from '../sim/types';
import type { World } from '../sim/world';
import { enemy as getEnemy } from '../content/index';
import { Camera } from './camera';
import { BAND, PALETTE, VISUAL } from './visual';
import { BloomPipeline } from './gfx/bloom';
import { ParticleField } from './gfx/particles';

const HUE_COLOR: Record<Hue, number> = {
  thermal: PALETTE.thermal,
  voltaic: PALETTE.voltaic,
  void: PALETTE.void,
};

const VIEW_HEIGHT = 900;
const VIEW_WIDTH_MIN = 1200;
const VIEW_WIDTH_MAX = 1900;

export class Renderer {
  readonly app = new Application();
  camera!: Camera;

  private bloom!: BloomPipeline;
  private readonly particles = new ParticleField();

  /** Non-blooming schematic: the arena's structure. */
  private readonly structureLayer = new Container();
  /** Everything that emits light. Lives inside the bloom pipeline. */
  private readonly worldLayer = new Container();
  private readonly screenLayer = new Container();

  private readonly gGrid = new Graphics();
  private readonly gRuins = new Graphics();
  private readonly gBeacons = new Graphics();
  private readonly gZones = new Graphics();
  private readonly gPickups = new Graphics();
  private readonly gDebris = new Graphics();
  private readonly gEnemies = new Graphics();
  private readonly gProjectiles = new Graphics();
  private readonly gFx = new Graphics();
  private readonly gPlayer = new Graphics();
  private readonly gIndicators = new Graphics();

  private viewWidth = VIEW_WIDTH_MIN;
  private world!: World;
  private readonly beaconLabels: Text[] = [];

  /** §17.2 — screenshake: tiny, frequent, hard ceiling regardless of chaos. */
  private shake = 0;
  private shakeX = 0;
  private shakeY = 0;
  private jitterSeed = 1;

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

    this.structureLayer.addChild(this.gGrid, this.gRuins);
    this.worldLayer.addChild(
      this.gBeacons,
      this.gZones,
      this.gPickups,
      this.gDebris,
      this.gFx,
      this.gEnemies,
      this.gProjectiles,
      this.gPlayer,
    );
    this.bloom.emissive.addChild(this.worldLayer);
    this.screenLayer.addChild(this.gIndicators);

    this.app.stage.addChild(this.structureLayer, this.bloom.output, this.screenLayer);

    this.drawRuins();
    this.layout();
    this.camera.snapTo(world.player.x, world.player.y);
    window.addEventListener('resize', () => this.layout());
  }

  private layout(): void {
    const aspect = this.app.screen.width / Math.max(1, this.app.screen.height);
    this.viewWidth = Math.min(VIEW_WIDTH_MAX, Math.max(VIEW_WIDTH_MIN, VIEW_HEIGHT * aspect));
    this.camera.setViewSize(this.viewWidth, VIEW_HEIGHT);
    this.bloom.resize();
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

    this.drainDeaths(world);
    this.trackDash(world);
    this.particles.update(frameDt);
    this.updateShake(frameDt);
    this.applyTransform();

    const heat = Math.min(1, world.budget.heat / 100);
    const tier = world.budget.tier;

    this.drawGrid(world);
    this.drawBeacons(world);
    this.drawZones(world);
    this.drawPickups(world);
    this.drawDebris();
    this.drawEnemies(world);
    this.drawProjectiles(world, tier);
    this.drawFx(world);
    this.drawPlayer(world, heat);
    this.drawIndicators(world);

    // §16.7 — the degradation ladder, driven by Heat now and by Meltdown later.
    this.bloom.setAberration(tier >= 2 ? 0.5 + 0.5 * heat : 0);
    this.bloom.setTear(world.budget.stalled ? (this.jitter(1) > 0 ? 1 : -1) * 0.6 : 0);
    this.bloom.setBloom(VISUAL.bloomIntensity * (1 + heat * 0.35));
    this.bloom.compose();
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
    const magnitude = this.shake * VISUAL.degradationIntensity;
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
    const warp = VISUAL.gridWarpAmount * load * VISUAL.degradationIntensity;
    const radius = VISUAL.gridWarpRadius;
    const px = world.player.x;
    const py = world.player.y;
    const arena = world.arena;

    const x0 = Math.max(0, Math.floor(view.x / step) * step);
    const x1 = Math.min(arena.width, view.x + view.width + step);
    const y0 = Math.max(0, Math.floor(view.y / step) * step);
    const y1 = Math.min(arena.height, view.y + view.height + step);

    // Vertical lines, subdivided so they can bend around the avatar.
    for (let x = x0; x <= x1; x += step) {
      this.warpedLine(g, x, Math.max(0, view.y - step), x, Math.min(arena.height, y1), px, py, radius, warp, true);
    }
    for (let y = y0; y <= y1; y += step) {
      this.warpedLine(g, Math.max(0, view.x - step), y, Math.min(arena.width, x1), y, px, py, radius, warp, false);
    }
    g.stroke({
      width: 1,
      color: PALETTE.structure,
      alpha: BAND.structure * (0.75 + load * 0.9),
    });

    g.rect(0, 0, arena.width, arena.height).stroke({
      width: 2,
      color: PALETTE.structure,
      alpha: BAND.structure * 1.6,
    });
  }

  private warpedLine(
    g: Graphics,
    ax: number,
    ay: number,
    bx: number,
    by: number,
    px: number,
    py: number,
    radius: number,
    warp: number,
    vertical: boolean,
  ): void {
    if (warp < 0.05) {
      g.moveTo(ax, ay).lineTo(bx, by);
      return;
    }
    const steps = VISUAL.gridSubdivisions;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      let x = ax + (bx - ax) * t;
      let y = ay + (by - ay) * t;
      const d = Math.hypot(x - px, y - py);
      if (d < radius) {
        // Push the line away from the avatar, strongest at the centre.
        const push = (1 - d / radius) ** 2 * warp;
        if (vertical) x += Math.sign(x - px || 1) * push;
        else y += Math.sign(y - py || 1) * push;
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

  private drawBeacons(world: World): void {
    const g = this.gBeacons;
    g.clear();
    this.syncBeaconLabels(world);

    for (const b of world.beacons) {
      const r = TUNABLE.beaconRadius;
      g.rect(b.x - r, b.y - r, r * 2, r * 2).stroke({
        width: 2,
        color: PALETTE.beacon,
        alpha: BAND.entity,
      });
      const sweep = (b.age * 1.6) % (Math.PI * 2);
      arcSegment(g, b.x, b.y, r + 12, sweep, sweep + 0.9);
      g.stroke({ width: 2, color: PALETTE.beacon, alpha: BAND.inFlight });
      for (const [sx, sy] of CORNERS) {
        g.moveTo(b.x + sx * r, b.y + sy * r).lineTo(b.x + sx * (r + 7), b.y + sy * (r + 7));
      }
      g.stroke({ width: 1, color: PALETTE.beacon, alpha: BAND.structure * 2 });
      if (b.progress > 0) {
        arcSegment(g, b.x, b.y, r + 12, -Math.PI / 2, -Math.PI / 2 + b.progress * Math.PI * 2);
        g.stroke({ width: 4, color: PALETTE.beacon, alpha: BAND.telegraph });
      }
    }
  }

  private syncBeaconLabels(world: World): void {
    while (this.beaconLabels.length < world.beacons.length) {
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
      const beacon = world.beacons[i];
      if (!beacon) {
        label.visible = false;
        continue;
      }
      const near =
        Math.hypot(world.player.x - beacon.x, world.player.y - beacon.y) <
        TUNABLE.beaconRadius + TUNABLE.playerRadius;
      label.visible = true;
      label.text = near ? 'HOLD  E' : `BEACON_${String(beacon.id).padStart(2, '0')}`;
      label.alpha = near ? BAND.telegraph : BAND.inFlight;
      label.position.set(beacon.x, beacon.y + TUNABLE.beaconRadius + 20);
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
      const segments = 26;
      for (let i = 0; i < segments; i += 2) {
        const a0 = (i / segments) * Math.PI * 2 + spin;
        const a1 = ((i + 1) / segments) * Math.PI * 2 + spin;
        arcSegment(g, z.x, z.y, z.radius, a0, a1);
      }
      g.stroke({ width: 2, color, alpha: BAND.inFlight * (0.5 + 0.5 * t) });

      // Faint interior scanline hatch, clipped to the circle by chord maths.
      for (let y = -z.radius + 10; y < z.radius; y += 14) {
        const half = Math.sqrt(Math.max(0, z.radius * z.radius - y * y));
        if (half < 2) continue;
        g.moveTo(z.x - half, z.y + y).lineTo(z.x + half, z.y + y);
      }
      g.stroke({ width: 1, color, alpha: BAND.structure * 0.55 * t });
    }
  }

  /** §16.4 — pickups are 1px dashed micro-shapes with a gentle sine bob. */
  private drawPickups(world: World): void {
    const g = this.gPickups;
    g.clear();
    for (const item of world.pickups) {
      if (!this.camera.isVisible(item.x, item.y, 20)) continue;
      const bob = Math.sin(item.age * 3.4 + item.id) * 1.6;
      const y = item.y + bob;
      if (item.kind === 'xp') {
        // White dashed shard: reads as "small player-stuff" (§16.3).
        g.moveTo(item.x - 3, y).lineTo(item.x, y - 3);
        g.moveTo(item.x + 1, y - 1).lineTo(item.x + 3, y + 1);
        g.moveTo(item.x, y + 3).lineTo(item.x - 2, y + 1);
        g.stroke({ width: 1, color: PALETTE.xp, alpha: BAND.inFlight });
      } else {
        const color = HUE_COLOR[item.hue];
        for (let i = 0; i < 3; i++) {
          const a = (i / 3) * Math.PI * 2 + item.age * 1.1;
          arcSegment(g, item.x, y, 3.6, a, a + 1.1);
        }
        g.stroke({ width: 1.4, color, alpha: BAND.inFlight });
      }
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
      const color = flashing ? PALETTE.player : HUE_COLOR[e.hue];
      const r = e.radius;
      const health = e.hp / e.maxHp;

      const verts = shapeOutline(def.shape, e.x, e.y, r, Math.atan2(e.aimY, e.aimX));
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

      if (e.enriched) {
        g.circle(e.x, e.y, r + 6).stroke({
          width: 1,
          color: PALETTE.beacon,
          alpha: BAND.structure * born,
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

    for (const b of world.beacons) {
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

      polygonPath(g, shapeOutline('triangle', ix, iy, 9, angle));
      g.stroke({ width: 2, color: PALETTE.beacon, alpha: BAND.entity });

      const dist = Math.hypot(dx, dy);
      const ticks = Math.min(4, Math.max(1, Math.round(2400 / Math.max(400, dist))));
      for (let i = 0; i < ticks; i++) {
        g.circle(
          ix - Math.cos(angle) * (16 + i * 6),
          iy - Math.sin(angle) * (16 + i * 6),
          1.4,
        ).fill({ color: PALETTE.beacon, alpha: BAND.inFlight });
      }
    }
  }

  /** Diagnostics for the HUD. */
  get debrisCount(): number {
    return this.particles.count;
  }
}

const HUE_ORDER: readonly Hue[] = ['thermal', 'voltaic', 'void'];

const CORNERS = [
  [-1, -1],
  [1, -1],
  [-1, 1],
  [1, 1],
] as const;

/** §10.1 — shape is behaviour, so the outline is the identity of an enemy. */
function shapeOutline(
  shape: string,
  cx: number,
  cy: number,
  r: number,
  rotation: number,
): [number, number][] {
  const sides =
    shape === 'triangle' ? 3 : shape === 'square' ? 4 : shape === 'hexagon' ? 6 : shape === 'dot' ? 6 : 14;
  const rot = shape === 'square' ? Math.PI / 4 : shape === 'triangle' ? rotation : 0;
  const points: [number, number][] = [];
  for (let i = 0; i < sides; i++) {
    const a = rot + (i / sides) * Math.PI * 2;
    points.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
  }
  return points;
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
