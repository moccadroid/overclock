/**
 * How a deterministic reference pilot *moves*.
 *
 * It is not meant to play well — it exists so balance sweeps measure the engine
 * rather than the operator. It kites the nearest threat, drifts toward the
 * densest pickup, and dashes off cooldown when something is close.
 *
 * What it *wants* — which cards it takes, when it Recompiles, what it burns —
 * lives in pilots.ts as data, because that half is a balance input rather than
 * operator skill: the draft reacts to what you own and what you refuse, so the
 * pool a run sees depends on how that run drafts. Movement is still written
 * here, and is still one policy; if a reading ever turns out to hinge on kiting
 * distance rather than on the Engine, this is the next thing to lift out.
 */
import { TUNABLE } from '../sim/tunables';
import type { InputState, World } from '../sim/world';
import type { DraftCard } from '../sim/draft';
import { hypot } from '../sim/num';
import { ACTIVE_PILOT, pilotDraftChoice, type PilotDef } from './pilots';

export type { RecompilePolicy, BurnPolicy, PilotDef } from './pilots';

export function botInput(world: World, def: PilotDef = ACTIVE_PILOT): InputState {
  const recompilePolicy = def.recompile;
  const p = world.player;
  let ax = 0;
  let ay = 0;

  // Repel from nearby enemies, weighted by proximity.
  let threatDist = Infinity;
  for (const e of world.enemies) {
    const dx = p.x - e.x;
    const dy = p.y - e.y;
    const d2 = dx * dx + dy * dy;
    if (d2 > 260 * 260 || d2 < 1e-6) continue;
    const d = Math.sqrt(d2);
    if (d < threatDist) threatDist = d;
    const w = (260 - d) / 260;
    ax += (dx / d) * w * 2.2;
    ay += (dy / d) * w * 2.2;
  }

  // Attract to the nearest pickup so the fuel economy actually gets exercised.
  let best: { dx: number; dy: number; d: number } | null = null;
  for (const item of world.pickups) {
    const dx = item.x - p.x;
    const dy = item.y - p.y;
    const d = hypot(dx, dy);
    if (d > 420) continue;
    if (!best || d < best.d) best = { dx, dy, d };
  }
  if (best && best.d > 1) {
    ax += (best.dx / best.d) * 0.85;
    ay += (best.dy / best.d) * 0.85;
  }

  // Stay off the walls — being cornered is an operator failure, not a build one.
  const margin = 200;
  const { width, height } = world.arena;
  if (p.x < margin) ax += (margin - p.x) / margin;
  if (p.x > width - margin) ax -= (p.x - (width - margin)) / margin;
  if (p.y < margin) ay += (margin - p.y) / margin;
  if (p.y > height - margin) ay -= (p.y - (height - margin)) / margin;

  // Route to a beacon when one is reasonably close — the greed line is part of
  // what the harness should be exercising (§12.3).
  let channelling = false;
  // §9.2 says Recompiling at your peak beats hoarding, so the reference pilot
  // takes it — but only when there is actually an Engine worth converting and
  // enough Integrity to survive being empty. A bot that recompiles the instant a
  // terminal appears measures recklessness, not the mechanic.
  const healthy = p.integrity > p.maxIntegrity * 0.6;
  // §9.2 describes 2-3 Recompiles across a run, taken at the Engine's peak — not
  // one every time a terminal happens to appear. A policy without a cooldown
  // measures a pilot resetting itself to the Axiom every 70 seconds, which is
  // nobody's play pattern.
  const sinceLast = world.time - world.lastRecompileTime;
  const worthConverting =
    recompilePolicy === 'never'
      ? false
      : recompilePolicy === 'eager'
        ? sinceLast > 240
        : sinceLast > 240 && world.outputAverage > 20 && p.integrity > p.maxIntegrity * 0.7;
  const target =
    (worthConverting
      ? world.terminals.find((t) => t.kind === 'recompile' && t.alive)
      : undefined) ??
    (healthy ? world.terminals.find((t) => t.kind === 'beacon' && t.alive) : undefined) ??
    // §12.4 — a Cache is a free draft paid for with a hard wave, so the bot takes
    // one only while it is in shape to survive the bill. Without this the probe
    // never exercises the POI at all.
    (healthy && p.integrity > p.maxIntegrity * 0.75
      ? world.terminals.find((t) => t.kind === 'cache' && t.alive)
      : undefined) ??
    // §21b.5 — a gate is the map opening, and the reference pilot has to take
    // one or the whole map layer goes untested by the harness.
    //
    // Not before the Engine is worth anything, though. Holding ground for
    // twenty-two seconds is the most dangerous thing in the game, and a pilot
    // that walks off to do it at minute one with a starter row is measuring
    // recklessness — the same mistake the Recompile policy above already made
    // once. It also stopped a zone-cap test from ever reaching its fight.
    (healthy && world.time > 120 && p.integrity > p.maxIntegrity * 0.8
      ? world.terminals.find((t) => t.kind === 'gate' && t.alive)
      : undefined);

  if (target) {
    const dx = target.x - p.x;
    const dy = target.y - p.y;
    const d = hypot(dx, dy);
    const range =
      target.kind === 'recompile' ? 2200 : target.kind === 'gate' ? 4000 : target.kind === 'cache' ? 1800 : 900;
    // The pull has to survive a crowd. `threatDist > 150` meant the bot only
    // approached a POI when nothing was near it, and at this game's densities
    // that is never: measured across three full runs, the reference pilot
    // channelled *zero* beacons and zero Caches, so every POI in the game went
    // untested by the harness. It still backs off when something is right on
    // top of it — that is dodging, not ignoring.
    if (d < range && threatDist > 60) {
      ax += (dx / (d || 1)) * 1.4;
      ay += (dy / (d || 1)) * 1.4;
    }
    // A gate is held by standing anywhere inside its ring, not by pressing E
    // at arm's length, so "arrived" is a different distance for it.
    const hold = target.holdRadius ? target.holdRadius * 0.5 : TUNABLE.beaconRadius;
    if (d < hold) channelling = true;
  }

  const len = hypot(ax, ay);
  if (len > 1) {
    ax /= len;
    ay /= len;
  }

  return {
    moveX: channelling ? 0 : ax,
    moveY: channelling ? 0 : ay,
    dash: threatDist < 90 && p.dashCooldown <= 0,
    interact: channelling,
  };
}

/**
 * Which card the pilot takes. The scoring is data — see pilots.ts.
 *
 * Kept as a function here so every existing call site reads the same, and so
 * "the pilot" is still one thing from the harness's point of view even though
 * its taste and its movement now live in different files.
 */
export function botDraftChoice(
  world: World,
  cards: readonly DraftCard[],
  def: PilotDef = ACTIVE_PILOT,
): number {
  return pilotDraftChoice(world, cards, def);
}

export const BOT_TUNING_NOTE = `dash below 90u; magnet radius ${TUNABLE.collectRadius}u`;
