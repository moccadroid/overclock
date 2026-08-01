/**
 * A stable digest of simulation state, used to assert determinism in tests and
 * to detect divergence between a live run and its replay.
 *
 * Floats are quantised to 1e-4 before hashing: the sim is deterministic in exact
 * IEEE arithmetic, but the digest should not be so brittle that a harmless
 * refactor of evaluation order in *rendering* code looks like a sim change.
 */
import type { World } from './world';

function fnv(hash: number, value: number): number {
  let h = hash ^ (value | 0);
  h = Math.imul(h, 16777619);
  return h >>> 0;
}

function q(v: number): number {
  return Math.round(v * 1e4);
}

export function hashWorld(world: World): string {
  let h = 2166136261 >>> 0;
  h = fnv(h, world.tickCount);
  h = fnv(h, q(world.time));
  h = fnv(h, q(world.player.x));
  h = fnv(h, q(world.player.y));
  h = fnv(h, q(world.player.integrity));
  h = fnv(h, q(world.budget.heat));
  h = fnv(h, q(world.budget.available));
  h = fnv(h, world.stats.events);
  h = fnv(h, world.stats.kills);
  h = fnv(h, world.stats.fires);
  h = fnv(h, world.enemies.length);
  h = fnv(h, world.projectiles.length);
  h = fnv(h, world.pickups.length);
  h = fnv(h, q(world.score));

  for (const e of world.enemies) {
    h = fnv(h, e.id);
    h = fnv(h, q(e.x));
    h = fnv(h, q(e.y));
    h = fnv(h, q(e.hp));
  }
  for (const p of world.projectiles) {
    h = fnv(h, p.id);
    h = fnv(h, q(p.x));
    h = fnv(h, q(p.y));
    h = fnv(h, q(p.damage));
  }
  for (const p of world.pickups) {
    h = fnv(h, p.id);
    h = fnv(h, q(p.x));
    h = fnv(h, q(p.y));
  }
  for (const z of world.zones) {
    h = fnv(h, z.id);
    h = fnv(h, q(z.x));
    h = fnv(h, q(z.y));
    h = fnv(h, q(z.life));
  }
  for (const b of world.beacons) {
    h = fnv(h, b.id);
    h = fnv(h, q(b.x));
    h = fnv(h, q(b.progress));
  }
  for (const state of world.rng.save()) h = fnv(h, state);

  return (h >>> 0).toString(16).padStart(8, '0');
}
