/**
 * PLACEHOLDER RENDERER — Milestone 1.
 *
 * Deliberately flat and ugly: no bloom, no phosphor trails, no stroke-in spawns,
 * no decomposition deaths, no degradation ladder, no grid instrument. All of that
 * is §16/§17 work and lands in Milestone 2 with the real Pixi shader pipeline.
 *
 * Its only job is to make the *grammar* legible enough to judge: what fired, what
 * died, where the cascades are. It uses the §16.3 palette because doing so is
 * free, not because this is the look.
 */
import { Application, Container, Graphics } from 'pixi.js';
import { ARENA, TUNABLE } from '../sim/tunables';
import type { Hue } from '../sim/types';
import type { World } from '../sim/world';
import { enemy as getEnemy } from '../content/index';

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
} as const;

export class Renderer {
  readonly app = new Application();
  private readonly stage = new Container();
  private readonly gArena = new Graphics();
  private readonly gPickups = new Graphics();
  private readonly gEnemies = new Graphics();
  private readonly gProjectiles = new Graphics();
  private readonly gFx = new Graphics();
  private readonly gPlayer = new Graphics();

  async init(mount: HTMLElement): Promise<void> {
    await this.app.init({
      background: COLOR.background,
      resizeTo: window,
      antialias: true,
      autoDensity: true,
      resolution: Math.min(2, window.devicePixelRatio || 1),
    });
    mount.appendChild(this.app.canvas);

    this.stage.addChild(
      this.gArena,
      this.gPickups,
      this.gFx,
      this.gEnemies,
      this.gProjectiles,
      this.gPlayer,
    );
    this.app.stage.addChild(this.stage);

    this.drawArena();
    this.layout();
    window.addEventListener('resize', () => this.layout());
  }

  /** Letterbox the fixed arena into the window. No camera in M1 (§22, The Heap). */
  private layout(): void {
    const scale = Math.min(
      this.app.screen.width / ARENA.width,
      this.app.screen.height / ARENA.height,
    );
    this.stage.scale.set(scale);
    this.stage.position.set(
      (this.app.screen.width - ARENA.width * scale) / 2,
      (this.app.screen.height - ARENA.height * scale) / 2,
    );
  }

  private drawArena(): void {
    const g = this.gArena;
    g.clear();
    const step = 100;
    for (let x = 0; x <= ARENA.width; x += step) {
      g.moveTo(x, 0).lineTo(x, ARENA.height);
    }
    for (let y = 0; y <= ARENA.height; y += step) {
      g.moveTo(0, y).lineTo(ARENA.width, y);
    }
    g.stroke({ width: 1, color: COLOR.structure, alpha: 0.35 });
    g.rect(0, 0, ARENA.width, ARENA.height).stroke({ width: 2, color: COLOR.structure });
  }

  render(world: World): void {
    this.drawPickups(world);
    this.drawEnemies(world);
    this.drawProjectiles(world);
    this.drawFx(world);
    this.drawPlayer(world);
  }

  private drawPickups(world: World): void {
    const g = this.gPickups;
    g.clear();
    for (const item of world.pickups) {
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
      const def = getEnemy(e.defId);
      const color = e.flash > 0 ? 0xffffff : HUE_COLOR[e.hue];
      const r = e.radius;

      switch (def.shape) {
        case 'dot':
          g.circle(e.x, e.y, r);
          break;
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

      // Damage state without an HP bar — the outline dims as it takes damage.
      const health = e.hp / e.maxHp;
      if (health < 1) {
        g.circle(e.x, e.y, r * 0.45).fill({ color, alpha: 0.15 + 0.35 * health });
      }

      // Charger telegraph: §17.1 — every avoidable hit is preceded by a drawn line.
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
      const color = p.corrupted ? COLOR.signal : HUE_COLOR[p.hue];
      const len = 10;
      const speed = Math.hypot(p.vx, p.vy) || 1;
      g.moveTo(p.x, p.y)
        .lineTo(p.x - (p.vx / speed) * len, p.y - (p.vy / speed) * len)
        .stroke({ width: 2, color });
    }
  }

  private drawFx(world: World): void {
    const g = this.gFx;
    g.clear();
    for (const f of world.fx) {
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

    // The Ring (§19.4): static reserve as a solid arc, dynamic load as the fill,
    // Heat reddening it. Placeholder geometry, correct information.
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
  const r = Math.round(ar + (br - ar) * t);
  const gg = Math.round(ag + (bg - ag) * t);
  const bl = Math.round(ab + (bb - ab) * t);
  return (r << 16) | (gg << 8) | bl;
}

export { HUE_COLOR, COLOR };
