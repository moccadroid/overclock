/**
 * A deterministic reference pilot for headless runs.
 *
 * It is not meant to play well — it exists so balance sweeps measure the *engine*
 * rather than the operator. It kites the nearest threat, drifts toward the
 * densest pickup, and dashes off cooldown when something is close.
 */
import { TUNABLE } from '../sim/tunables';
import type { InputState, World } from '../sim/world';
import type { DraftCard } from '../sim/draft';
import { NODE_BY_ID } from '../content/index';
import { hypot } from '../sim/num';

/**
 * Recompile policy, so the harness can A/B the §9.2 claim directly rather than
 * inferring it from one blended pilot.
 *   never  — hoard the engine to the end
 *   eager  — take every terminal the moment it appears
 *   smart  — take it when there is output worth converting and health to spare
 */
export type RecompilePolicy = 'never' | 'eager' | 'smart';
let recompilePolicy: RecompilePolicy = 'smart';

export function setRecompilePolicy(policy: RecompilePolicy): void {
  recompilePolicy = policy;
}

export function botInput(world: World): InputState {
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
      : undefined);

  if (target) {
    const dx = target.x - p.x;
    const dy = target.y - p.y;
    const d = hypot(dx, dy);
    const range = target.kind === 'recompile' ? 2200 : target.kind === 'cache' ? 1800 : 900;
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
    if (d < TUNABLE.beaconRadius) channelling = true;
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
 * Greedy auto-draft. Completing a dead row beats everything (a half-built Program
 * produces nothing); capacity matters only when static load is crowding the cap.
 */
export function botDraftChoice(world: World, cards: readonly DraftCard[]): number {
  // A Program needs BOTH a Trigger and an Action to fire, so "needs" has to
  // include the empty-engine case. Written as "has an action but no trigger" it
  // is false for a freshly Recompiled Engine, and the pilot then drafts
  // modifiers onto nothing forever — which is exactly what it did.
  const liveRows = world.engine.compiled.filter((c) => c.live).length;
  const live = liveRows > 0;
  // Widen before deepening: a second and third firing row beats a third modifier
  // stacked on the first. Without this the pilot ended seven-minute runs holding
  // a single weapon even when Actions were a third of the pool.
  const wantMoreRows = liveRows < 3;
  const needsTrigger = world.engine.programs.some((p) => p.triggerId === null);
  const needsAction = world.engine.programs.some((p) => p.actionId === null);
  const rebuilding = !live;
  // Capacity is the only lever this pilot has against Heat — it never scraps.
  const headroomTight =
    live && (world.engine.staticLoad > world.budget.capacity * 0.45 || world.budget.heat > 35);

  let bestIndex = 0;
  let bestScore = -Infinity;
  cards.forEach((card, i) => {
    let score: number;
    if (card.kind === 'capacity') {
      score = headroomTight ? 9 : 2;
    } else if (card.kind === 'program_slot') {
      score = headroomTight ? 0.5 : 3;
    } else if (card.kind === 'stat') {
      // §8.2 calls the stat pool deliberately boring; this pilot treats it as
      // the floor it is meant to be.
      score = rebuilding ? 0.5 : 2.5;
    } else if (card.kind === 'tool') {
      // The pilot never rerolls and never purges — it has no read on the pool to
      // narrow toward. Scoring these near zero keeps the harness measuring the
      // game rather than a strategy it cannot execute.
      score = 0.2;
    } else {
      const node = NODE_BY_ID.get(card.nodeId);
      if (!node) score = 0;
      // While rebuilding, completing a firing Program beats everything.
      else if (node.kind === 'trigger') {
        score = rebuilding ? 20 : needsTrigger ? 8 : wantMoreRows ? 7 : 4;
      } else if (node.kind === 'action') {
        score = rebuilding ? 20 : needsAction ? 8 : wantMoreRows ? 7 : 4;
        // A Convert occupies an Action slot but deals no damage. This pilot has
        // no economy strategy, so it treats them as a last resort rather than
        // filling its Engine with cards that produce nothing.
        if (node.primitive === 'convert') score = 0.5;
        // §11.1 — a pilot that never diversifies gets taxed to 60% resistance on
        // its only hue, which measures the tax rather than the game. Prefer hues
        // the engine is currently light on.
        score += (1 - hueShare(world, node.hue)) * 5;
      } else score = rebuilding ? 1 : headroomTight ? 3 : 6;
    }
    if (score > bestScore) {
      bestScore = score;
      bestIndex = i;
    }
  });
  return bestIndex;
}

/** Fraction of the Engine's live Actions that already use this hue. */
function hueShare(world: World, hue: string): number {
  let total = 0;
  let matching = 0;
  for (const p of world.engine.programs) {
    if (!p.actionId) continue;
    const node = NODE_BY_ID.get(p.actionId);
    if (!node || node.kind !== 'action') continue;
    total++;
    if (node.hue === hue) matching++;
  }
  return total === 0 ? 0 : matching / total;
}

export const BOT_TUNING_NOTE = `dash below 90u; magnet radius ${TUNABLE.collectRadius}u`;
