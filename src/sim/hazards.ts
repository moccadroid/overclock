/**
 * §11.4 — Containment, the Meltdown antagonists, as a registry.
 *
 * The same disease as enemy behaviour, one system over. `Containment` is a wide
 * struct where `dirX/dirY/gapAt` mean something only to a Sweeper, `radius` and
 * `gapAngles` only to a Cell, and `advance` only to a Null Front — and every
 * one of the three was reached by an `if (c.kind === …)` chain in *two* files.
 *
 * The chain is the smaller problem. The real one is that this is the system the
 * next arenas are supposed to go wild with, and its cost to extend was: widen
 * the struct, add a branch to the spawner, a branch to the updater, a branch to
 * the hit test and a branch to the renderer, none of which the compiler would
 * remind you about.
 *
 * A hazard is one entry here now — spawn, update, test — and one entry in the
 * renderer's table. The `HAZARDS` keys are the vocabulary; anything not in it is
 * not a hazard, which a coverage test can and does assert.
 *
 * Geometry stays code on purpose. A wall that crosses the arena, a ring that
 * closes and an edge that advances are three genuinely different shapes, and a
 * data language expressive enough to describe all three would be a worse
 * language than TypeScript. What moves to data is the *numbers* — every one of
 * these reads its speed, reach, damage and timing from `TUNABLE`, so the shape
 * is code and the balance is a knob.
 */
import { hypot, atan2 as patan2, sin as psin } from './num';
import { TUNABLE } from './tunables';
import type { Containment, DamageSource } from './world';

/** What a hazard may touch. Deliberately narrow, like the trait contract. */
export interface HazardCtx {
  readonly player: { x: number; y: number; maxIntegrity: number };
  readonly arena: { width: number; height: number };
  /** Deterministic PRNG. Draw order is part of the run's identity — see §0. */
  chance(p: number): boolean;
  range(lo: number, hi: number): number;
  next(): number;
  hurt(amount: number, cause: DamageSource): void;
}

/** The mutable half of a fresh hazard; the spawner fills in the rest. */
export type HazardSeed = Partial<Containment> & { life: number; maxLife: number };

export interface HazardDef {
  /** Position, direction and lifetime. Runs inside the sim's RNG stream. */
  spawn(c: HazardCtx): HazardSeed;
  /** Advance one tick. Motion only — the hit test is separate and gated. */
  update(h: Containment, c: HazardCtx, dt: number): void;
  /** Does it have the player right now? Only called once armed (§17.1). */
  test(h: Containment, c: HazardCtx): void;
}

function angleDelta(a: number, b: number): number {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

export const HAZARDS: Record<string, HazardDef> = {
  /**
   * A wall crossing the whole arena with one gap. A positional test that ignores
   * DPS entirely — you cannot shoot your way out of geometry.
   */
  sweeper: {
    spawn: (c) => {
      const horizontal = c.chance(0.5);
      const fromStart = c.chance(0.5);
      const travel = horizontal ? c.arena.width : c.arena.height;
      const life = travel / TUNABLE.sweeperSpeed + 2.5;
      return {
        x: horizontal ? (fromStart ? -60 : c.arena.width + 60) : c.arena.width / 2,
        y: horizontal ? c.arena.height / 2 : fromStart ? -60 : c.arena.height + 60,
        dirX: horizontal ? (fromStart ? 1 : -1) : 0,
        dirY: horizontal ? 0 : fromStart ? 1 : -1,
        gapAt: c.range(
          TUNABLE.sweeperGapWidth,
          (horizontal ? c.arena.height : c.arena.width) - TUNABLE.sweeperGapWidth,
        ),
        life,
        maxLife: life,
      };
    },
    update: (h, _c, dt) => {
      h.x += h.dirX * TUNABLE.sweeperSpeed * dt;
      h.y += h.dirY * TUNABLE.sweeperSpeed * dt;
    },
    test: (h, c) => {
      const p = c.player;
      const along = h.dirX !== 0 ? p.y : p.x;
      const across = h.dirX !== 0 ? p.x - h.x : p.y - h.y;
      const inGap = Math.abs(along - h.gapAt) < TUNABLE.sweeperGapWidth / 2;
      if (!inGap && Math.abs(across) < 22 + TUNABLE.playerRadius) {
        c.hurt(TUNABLE.sweeperDamage, {
          id: 'sweeper',
          label: 'Sweeper',
          mode: 'containment',
        });
      }
    },
  },

  /** An expanding cage. Standing in one of its gaps is how you get out. */
  cell: {
    spawn: (c) => {
      const gaps: number[] = [];
      for (let i = 0; i < TUNABLE.cellGaps; i++) gaps.push(c.next() * Math.PI * 2);
      const life = TUNABLE.cellDuration + 2.4;
      return {
        x: c.player.x,
        y: c.player.y,
        radius: TUNABLE.cellStartRadius,
        gapAngles: gaps,
        telegraph: 1.4,
        life,
        maxLife: life,
      };
    },
    update: (h) => {
      const t = Math.min(1, Math.max(0, (h.age - h.telegraph) / TUNABLE.cellDuration));
      h.radius = TUNABLE.cellStartRadius + (TUNABLE.cellEndRadius - TUNABLE.cellStartRadius) * t;
    },
    test: (h, c) => {
      const p = c.player;
      const dx = p.x - h.x;
      const dy = p.y - h.y;
      const d = hypot(dx, dy);
      if (Math.abs(d - h.radius) > 20 + TUNABLE.playerRadius) return;
      const angle = patan2(dy, dx);
      for (const gap of h.gapAngles) {
        if (Math.abs(angleDelta(angle, gap)) < 0.34) return;
      }
      c.hurt(p.maxIntegrity * TUNABLE.cellDamagePercent, {
        id: 'cell',
        label: 'Containment Cell',
        mode: 'containment',
      });
    },
  },

  /** §11.4 — shrinks the playable arena, forcing motion. */
  nullfront: {
    spawn: (c) => {
      const horizontal = c.chance(0.5);
      const fromStart = c.chance(0.5);
      const life = TUNABLE.nullFrontDuration + 2.6;
      return {
        x: horizontal ? (fromStart ? 0 : c.arena.width) : c.arena.width / 2,
        y: horizontal ? c.arena.height / 2 : fromStart ? 0 : c.arena.height,
        dirX: horizontal ? (fromStart ? 1 : -1) : 0,
        dirY: horizontal ? 0 : fromStart ? 1 : -1,
        life,
        maxLife: life,
      };
    },
    update: (h) => {
      // A swell rather than a ramp: it comes in, holds, and recedes, so the
      // arena is given back rather than permanently smaller.
      const t = Math.min(1, Math.max(0, (h.age - h.telegraph) / TUNABLE.nullFrontDuration));
      h.advance = TUNABLE.nullFrontDepth * psin(t * Math.PI);
    },
    test: (h, c) => {
      const p = c.player;
      let inside = false;
      if (h.dirX > 0) inside = p.x < h.advance;
      else if (h.dirX < 0) inside = p.x > c.arena.width - h.advance;
      else if (h.dirY > 0) inside = p.y < h.advance;
      else inside = p.y > c.arena.height - h.advance;
      if (inside) {
        c.hurt(TUNABLE.nullFrontDamage, {
          id: 'nullfront',
          label: 'Null Front',
          mode: 'containment',
        });
      }
    },
  },
};

/** The vocabulary. Order is the roll order, so it is part of §0's determinism. */
export const HAZARD_KINDS = Object.keys(HAZARDS);
