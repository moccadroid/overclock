/**
 * A deterministic reference pilot for headless runs.
 *
 * It is not meant to play well — it exists so balance sweeps measure the *engine*
 * rather than the operator. It kites the nearest threat, drifts toward the
 * densest pickup, and dashes off cooldown when something is close.
 */
import { ARENA, TUNABLE } from '../sim/tunables';
import type { InputState, World } from '../sim/world';
import type { DraftCard } from '../sim/draft';
import { NODE_BY_ID } from '../content/index';

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
    const d = Math.hypot(dx, dy);
    if (d > 420) continue;
    if (!best || d < best.d) best = { dx, dy, d };
  }
  if (best && best.d > 1) {
    ax += (best.dx / best.d) * 0.85;
    ay += (best.dy / best.d) * 0.85;
  }

  // Stay off the walls — being cornered is an operator failure, not a build one.
  const margin = 140;
  if (p.x < margin) ax += (margin - p.x) / margin;
  if (p.x > ARENA.width - margin) ax -= (p.x - (ARENA.width - margin)) / margin;
  if (p.y < margin) ay += (margin - p.y) / margin;
  if (p.y > ARENA.height - margin) ay -= (p.y - (ARENA.height - margin)) / margin;

  const len = Math.hypot(ax, ay);
  if (len > 1) {
    ax /= len;
    ay /= len;
  }

  return {
    moveX: ax,
    moveY: ay,
    dash: threatDist < 90 && p.dashCooldown <= 0,
  };
}

/**
 * Greedy auto-draft. Completing a dead row beats everything (a half-built Program
 * produces nothing); capacity matters only when static load is crowding the cap.
 */
export function botDraftChoice(world: World, cards: readonly DraftCard[]): number {
  const needsTrigger = world.engine.programs.some((p) => p.triggerId === null && p.actionId);
  const needsAction = world.engine.programs.some((p) => p.actionId === null && p.triggerId);
  const headroomTight = world.engine.staticLoad > world.budget.capacity * 0.75;

  let bestIndex = 0;
  let bestScore = -Infinity;
  cards.forEach((card, i) => {
    let score: number;
    if (card.kind === 'capacity') {
      score = headroomTight ? 9 : 2;
    } else if (card.kind === 'program_slot') {
      score = headroomTight ? 0.5 : 3;
    } else {
      const node = NODE_BY_ID.get(card.nodeId);
      if (!node) score = 0;
      else if (node.kind === 'trigger') score = needsTrigger ? 8 : 4;
      else if (node.kind === 'action') score = needsAction ? 8 : 4;
      else score = headroomTight ? 3 : 6;
    }
    if (score > bestScore) {
      bestScore = score;
      bestIndex = i;
    }
  });
  return bestIndex;
}

export const BOT_TUNING_NOTE = `dash below 90u; magnet radius ${TUNABLE.collectRadius}u`;
