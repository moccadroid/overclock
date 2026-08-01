/**
 * PLACEHOLDER RENDERER — still flat and ugly on purpose.
 *
 * No bloom, no phosphor trails, no stroke-in spawns, no decomposition deaths, no
 * degradation ladder. That is §16/§17 work and lands with the real shader
 * pipeline. What this now does carry is the structure that pipeline needs: a
 * camera over a world larger than the view, viewport culling, and the off-screen
 * indicator layer (§19.4) that only means anything once there is an off-screen.
 */
import { Application, Container, Graphics } from 'pixi.js';
import { TUNABLE } from '../sim/tunables';
import type { Hue } from '../sim/types';
import type { World } from '../sim/world';
import { enemy as getEnemy } from '../content/index';
import { Camera } from './camera';

const HUE_COLOR: Record<Hue, number> = {
  thermal: 0xffb000,
  voltaic: 0x00e5ff,
  void: 0xb44cff,
};

const COLOR = {
  background: 0x060a12,
  structure: 0x2a3a52,
  player: 0xffffff,
  signal: 0xff2a3c,
  xp: 0xdfe8f5,
  beacon: 0x9fd0ff,
} as const;

/**
 * The vertical extent is fixed so everyone sees the same amount of the world
 * top-to-bottom; the horizontal extent follows the window's aspect within a
 * clamp, then letterboxes. Ultrawide monitors get a wider field but not an
 * unbounded one. See DECISIONS D-13.
 */
const VIEW_HEIGHT = 900;
const VIEW_WIDTH_MIN = 1200;
const VIEW_WIDTH_MAX = 1900;

export class Renderer {
  readonly app = new Application();
  camera!: Camera;

  private readonly stage = new Container();
  private readonly worldLayer = new Container();
  private readonly screenLayer = new Container();

  private readonly gArena = new Graphics();
  private readonly gBeacons = new Graphics();
  private readonly gZones = new Graphics();
  private readonly gPickups = new Graphics();
  private readonly gEnemies = new Graphics();
  private readonly gProjectiles = new Graphics();
  private readonly gFx = new Graphics();
  private readonly gPlayer = new Graphics();
  private readonly gIndicators = new Graphics();

  private viewWidth = VIEW_HEIGHT;
  private world!: World;

  async init(mount: HTMLElement, world: World): Promise<void> {
    this.world = world;
    this.camera = new Camera(world.arena);

    await this.app.init({
      background: COLOR.background,
      resizeTo: window,
      antialias: true,
      autoDensity: true,
      resolution: Math.min(2, window.devicePixelRatio || 1),
    });
    mount.appendChild(this.app.canvas);

    this.worldLayer.addChild(
      this.gArena,
      this.gBeacons,
      this.gZones,
      this.gPickups,
      this.gFx,
      this.gEnemies,
      this.gProjectiles,
      this.gPlayer,
    );
    this.screenLayer.addChild(this.gIndicators);
    this.stage.addChild(this.worldLayer, this.screenLayer);
    this.app.stage.addChild(this.stage);

    this.drawArena();
    this.layout();
    this.camera.snapTo(world.player.x, world.player.y);
    window.addEventListener('resize', () => this.layout());
  }

  private layout(): void {
    const aspect = this.app.screen.width / Math.max(1, this.app.screen.height);
    this.viewWidth = Math.min(VIEW_WIDTH_MAX, Math.max(VIEW_WIDTH_MIN, VIEW_HEIGHT * aspect));
    this.camera.setViewSize(this.viewWidth, VIEW_HEIGHT);

    const scale = Math.min(
      this.app.screen.width / this.viewWidth,
      this.app.screen.height / VIEW_HEIGHT,
    );
    this.stage.scale.set(scale);
    this.stage.position.set(
      (this.app.screen.width - this.viewWidth * scale) / 2,
      (this.app.screen.height - VIEW_HEIGHT * scale) / 2,
    );
  }

  /** Static arena geometry: grid, bounds, and the structure ruins (§22). */
  private drawArena(): void {
    const g = this.gArena;
    const arena = this.world.arena;
    g.clear();

    const step = 120;
    for (let x = 0; x <= arena.width; x += step) g.moveTo(x, 0).lineTo(x, arena.height);
    for (let y = 0; y <= arena.height; y += step) g.moveTo(0, y).lineTo(arena.width, y);
    g.stroke({ width: 1, color: COLOR.structure, alpha: 0.3 });

    for (const r of arena.ruins) {
      g.rect(r.x, r.y, r.w, r.h);
    }
    g.fill({ color: COLOR.structure, alpha: 0.22 });
    for (const r of arena.ruins) {
      g.rect(r.x, r.y, r.w, r.h);
    }
    g.stroke({ width: 2, color: COLOR.structure });

    g.rect(0, 0, arena.width, arena.height).stroke({ width: 3, color: COLOR.structure });
  }

  /** `frameDt` is real elapsed seconds — camera smoothing is presentation. */
  render(world: World, frameDt: number, cameraActive: boolean): void {
    if (cameraActive) {
      this.camera.follow(world.player.x, world.player.y, world.player.dirX, world.player.dirY, frameDt);
    }
    this.worldLayer.position.set(
      this.viewWidth / 2 - this.camera.x,
      VIEW_HEIGHT / 2 - this.camera.y,
    );

    this.drawBeacons(world);
    this.drawZones(world);
    this.drawPickups(world);
    this.drawEnemies(world);
    this.drawProjectiles(world);
    this.drawFx(world);
    this.drawPlayer(world);
    this.drawIndicators(world);
  }

  private drawBeacons(world: World): void {
    const g = this.gBeacons;
    g.clear();
    for (const b of world.beacons) {
      const r = TUNABLE.beaconRadius;
      g.rect(b.x - r, b.y - r, r * 2, r * 2).stroke({ width: 2, color: COLOR.beacon, alpha: 0.9 });
      // Slow radar sweep — a blueprint structure that is clearly interactive.
      const sweep = (b.age * 1.6) % (Math.PI * 2);
      g.moveTo(b.x, b.y)
        .lineTo(b.x + Math.cos(sweep) * r, b.y + Math.sin(sweep) * r)
        .stroke({ width: 1, color: COLOR.beacon, alpha: 0.55 });
      g.circle(b.x, b.y, r + 12).stroke({ width: 1, color: COLOR.beacon, alpha: 0.25 });
      if (b.progress > 0) {
        g.arc(b.x, b.y, r + 12, -Math.PI / 2, -Math.PI / 2 + b.progress * Math.PI * 2).stroke({
          width: 4,
          color: COLOR.beacon,
        });
      }
    }
  }

  private drawZones(world: World): void {
    const g = this.gZones;
    g.clear();
    for (const z of world.zones) {
      if (!this.camera.isVisible(z.x, z.y, z.radius)) continue;
      const t = Math.max(0, z.life / z.maxLife);
      // Dashed ring, approximated with arc segments (§16.4 fields are dashed).
      const segments = 24;
      for (let i = 0; i < segments; i += 2) {
        const a0 = (i / segments) * Math.PI * 2 + z.life;
        const a1 = ((i + 1) / segments) * Math.PI * 2 + z.life;
        g.arc(z.x, z.y, z.radius, a0, a1);
      }
      g.stroke({ width: 2, color: HUE_COLOR[z.hue], alpha: 0.35 + 0.45 * t });
      g.circle(z.x, z.y, z.radius).fill({ color: HUE_COLOR[z.hue], alpha: 0.06 * t });
    }
  }

  private drawPickups(world: World): void {
    const g = this.gPickups;
    g.clear();
    for (const item of world.pickups) {
      if (!this.camera.isVisible(item.x, item.y, 20)) continue;
      if (item.kind === 'xp') {
        g.rect(item.x - 2, item.y - 2, 4, 4).fill({ color: COLOR.xp, alpha: 0.8 });
      } else {
        g.circle(item.x, item.y, 3).fill({ color: HUE_COLOR[item.hue], alpha: 0.85 });
      }
    }
  }

  private drawEnemies(world: World): void {
    const g = this.gEnemies;
    g.clear();
    for (const e of world.enemies) {
      if (!this.camera.isVisible(e.x, e.y, e.radius + 20)) continue;
      const def = getEnemy(e.defId);
      const color = e.flash > 0 ? 0xffffff : HUE_COLOR[e.hue];
      const r = e.radius;

      switch (def.shape) {
        case 'dot':
        case 'circle':
          g.circle(e.x, e.y, r);
          break;
        case 'triangle':
          polygon(g, e.x, e.y, r, 3, Math.atan2(e.aimY, e.aimX));
          break;
        case 'square':
          polygon(g, e.x, e.y, r, 4, Math.PI / 4);
          break;
        case 'hexagon':
          polygon(g, e.x, e.y, r, 6, 0);
          break;
      }
      g.stroke({ width: 2, color });

      const health = e.hp / e.maxHp;
      if (health < 1) {
        g.circle(e.x, e.y, r * 0.45).fill({ color, alpha: 0.15 + 0.35 * health });
      }
      if (e.enriched) {
        g.circle(e.x, e.y, r + 5).stroke({ width: 1, color: COLOR.beacon, alpha: 0.5 });
      }
      // §17.1 — every avoidable hit is preceded by a drawn line.
      if (e.state === 'windup') {
        g.moveTo(e.x, e.y)
          .lineTo(e.x + e.aimX * 300, e.y + e.aimY * 300)
          .stroke({ width: 1, color: COLOR.signal, alpha: 0.7 });
      }
    }
  }

  private drawProjectiles(world: World): void {
    const g = this.gProjectiles;
    g.clear();
    for (const p of world.projectiles) {
      if (!this.camera.isVisible(p.x, p.y, 20)) continue;
      const color = p.corrupted ? COLOR.signal : HUE_COLOR[p.hue];
      const speed = Math.hypot(p.vx, p.vy) || 1;
      g.moveTo(p.x, p.y)
        .lineTo(p.x - (p.vx / speed) * 10, p.y - (p.vy / speed) * 10)
        .stroke({ width: 2, color });
    }
  }

  private drawFx(world: World): void {
    const g = this.gFx;
    g.clear();
    for (const f of world.fx) {
      if (!this.camera.isVisible(f.x, f.y, f.radius + 40)) continue;
      const t = Math.max(0, f.life / f.maxLife);
      if (f.kind === 'burst') {
        g.circle(f.x, f.y, f.radius * (1.05 - t * 0.25)).stroke({
          width: 2,
          color: HUE_COLOR[f.hue],
          alpha: t,
        });
      } else if (f.kind === 'chain') {
        for (let i = 0; i + 3 < f.points.length; i += 2) {
          g.moveTo(f.points[i]!, f.points[i + 1]!).lineTo(f.points[i + 2]!, f.points[i + 3]!);
        }
        g.stroke({ width: 2, color: HUE_COLOR[f.hue], alpha: t });
      } else if (f.kind === 'hurt') {
        g.circle(f.x, f.y, TUNABLE.playerRadius + 14 * (1 - t)).stroke({
          width: 3,
          color: COLOR.signal,
          alpha: t,
        });
      }
    }
  }

  private drawPlayer(world: World): void {
    const g = this.gPlayer;
    g.clear();
    const p = world.player;
    if (!p.alive) return;

    // The Ring (§19.4): static reserve, dynamic load, Heat reddening it.
    const ringR = TUNABLE.playerRadius + 12;
    const heat = Math.min(1, world.budget.heat / 100);
    const ringColor = heat > 0.01 ? mix(COLOR.structure, COLOR.signal, heat) : COLOR.structure;
    g.circle(p.x, p.y, ringR).stroke({ width: 3, color: ringColor, alpha: 0.55 });

    const staticArc = world.budget.staticFraction * Math.PI * 2;
    if (staticArc > 0.001) {
      g.arc(p.x, p.y, ringR, -Math.PI / 2, -Math.PI / 2 + staticArc).stroke({
        width: 3,
        color: 0x6f86a8,
      });
    }
    const dynArc = world.budget.dynamicFraction * Math.PI * 2;
    if (dynArc > 0.001) {
      g.arc(p.x, p.y, ringR + 4, -Math.PI / 2, -Math.PI / 2 + dynArc).stroke({
        width: 2,
        color: heat > 0.4 ? COLOR.signal : 0x00e5ff,
        alpha: 0.9,
      });
    }
    if (world.budget.stalled) {
      g.circle(p.x, p.y, ringR + 10).stroke({ width: 2, color: COLOR.signal, alpha: 0.8 });
    }

    // §16.2 — the player is the only full-brightness object.
    polygon(g, p.x, p.y, TUNABLE.playerRadius, 3, Math.atan2(p.dirY, p.dirX));
    g.stroke({ width: 3, color: COLOR.player });
    g.circle(p.x, p.y, TUNABLE.playerRadius).stroke({
      width: 1,
      color: COLOR.player,
      alpha: 0.5,
    });
    if (p.iframes > 0) {
      g.circle(p.x, p.y, TUNABLE.playerRadius + 5).stroke({
        width: 1,
        color: COLOR.player,
        alpha: 0.6,
      });
    }
  }

  /**
   * §19.4 — off-screen indicators for Beacons and terminals. Never for regular
   * enemies: the edge of the screen is reserved for things worth travelling to.
   */
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

      // Project onto the view rectangle's border.
      const halfW = cx - margin;
      const halfH = cy - margin;
      const scale = Math.min(
        halfW / Math.max(1e-3, Math.abs(Math.cos(angle))),
        halfH / Math.max(1e-3, Math.abs(Math.sin(angle))),
      );
      const ix = cx + Math.cos(angle) * scale;
      const iy = cy + Math.sin(angle) * scale;

      polygon(g, ix, iy, 9, 3, angle);
      g.stroke({ width: 2, color: COLOR.beacon, alpha: 0.9 });

      const dist = Math.round(Math.hypot(dx, dy));
      const ticks = Math.min(4, Math.max(1, Math.round(2200 / Math.max(400, dist))));
      for (let i = 0; i < ticks; i++) {
        g.circle(ix - Math.cos(angle) * (16 + i * 6), iy - Math.sin(angle) * (16 + i * 6), 1.4).fill({
          color: COLOR.beacon,
          alpha: 0.6,
        });
      }
    }
  }
}

function polygon(
  g: Graphics,
  cx: number,
  cy: number,
  r: number,
  sides: number,
  rotation: number,
): void {
  for (let i = 0; i <= sides; i++) {
    const a = rotation + (i / sides) * Math.PI * 2;
    const x = cx + Math.cos(a) * r;
    const y = cy + Math.sin(a) * r;
    if (i === 0) g.moveTo(x, y);
    else g.lineTo(x, y);
  }
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

export { HUE_COLOR, COLOR };
