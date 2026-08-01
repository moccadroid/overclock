/**
 * The Draft. GDD §8.
 *
 * Deterministic: every roll draws from the World's Rng, so a replayed run offers
 * the same cards in the same order. Cards that cannot be placed are never
 * offered — §17.3 requires a drafted node to visibly fire within 2s, and a
 * modifier that lands nowhere breaks that promise.
 */
import { ACTIONS, MODIFIERS, TRIGGERS, NODE_BY_ID } from '../content/index';
import type { NodeDef } from './types';
import { LOADBEARING, TUNABLE } from './tunables';
import type { World } from './world';
import { axiom as getAxiom } from '../content/index';

export type DraftCard =
  | { kind: 'node'; nodeId: string }
  | { kind: 'capacity'; amount: number }
  | { kind: 'program_slot' };

export interface DraftOffer {
  cards: DraftCard[];
  rerolls: number;
  purges: number;
}

function hueOf(node: NodeDef): string | null {
  return node.kind === 'action' ? node.hue : null;
}

/** Can this node land somewhere right now? */
function placeable(world: World, node: NodeDef): boolean {
  const programs = world.engine.programs;
  if (node.kind === 'trigger') return programs.some((p) => p.triggerId === null);
  if (node.kind === 'action') return programs.some((p) => p.actionId === null);
  return programs.some((p) => p.modifierIds.some((m) => m === null));
}

/**
 * §6.1 — static load can never exceed capacity. Rather than let the player draft
 * a node they cannot afford to run, we check first and drop it from the pool.
 */
function affordable(world: World, node: NodeDef): boolean {
  const snapshot = world.engine.programs.map((p) => ({
    triggerId: p.triggerId,
    actionId: p.actionId,
    modifierIds: [...p.modifierIds],
  }));
  const landed = world.engine.autoSlot(node.id);
  const load = world.engine.staticLoad;
  // Restore.
  world.engine.programs.forEach((p, i) => {
    const s = snapshot[i]!;
    p.triggerId = s.triggerId;
    p.actionId = s.actionId;
    p.modifierIds = s.modifierIds;
  });
  world.engine.recompile();
  return landed !== null && load <= world.budget.capacity;
}

function weightFor(world: World, node: NodeDef): number {
  const bias = getAxiom(world.config.axiomId).poolBias;
  const hue = hueOf(node);
  const byId = bias[node.id];
  const byHue = hue ? bias[hue] : undefined;
  const base = node.kind === 'modifier' ? 12 : 10;
  return base * (byId ?? byHue ?? 1);
}

/** Roll a fresh set of draft cards. */
export function rollDraft(world: World): DraftOffer {
  const pool: NodeDef[] = [...TRIGGERS, ...ACTIONS, ...MODIFIERS].filter(
    (n) => !world.purged.has(n.id) && placeable(world, n) && affordable(world, n),
  );

  const cards: DraftCard[] = [];
  const taken = new Set<string>();

  while (cards.length < TUNABLE.draftCards) {
    const remaining = pool.filter((n) => !taken.has(n.id));

    // §8.2 — capacity upgrades and (here) a Program slot are the floor that keeps
    // a draft from ever being dead.
    const slotAvailable = world.engine.programs.length < LOADBEARING.programSlotsMax;
    const fillerWeight = remaining.length === 0 ? 1 : 0.18;
    const rollFiller = remaining.length === 0 || world.rng.chance(fillerWeight);

    if (rollFiller) {
      if (slotAvailable && world.rng.chance(0.35)) {
        cards.push({ kind: 'program_slot' });
      } else {
        cards.push({ kind: 'capacity', amount: TUNABLE.capacityUpgradeAmount });
      }
      continue;
    }

    const node = world.rng.pickWeighted(
      remaining,
      remaining.map((n) => weightFor(world, n)),
    );
    taken.add(node.id);
    cards.push({ kind: 'node', nodeId: node.id });
  }

  return { cards, rerolls: world.rerolls, purges: world.purges };
}

export function describeCard(card: DraftCard): { title: string; body: string; tag: string } {
  if (card.kind === 'capacity') {
    return {
      title: 'Capacity',
      body: `+${card.amount} Cycles.`,
      tag: 'UPGRADE',
    };
  }
  if (card.kind === 'program_slot') {
    return {
      title: 'Program Slot',
      body: 'Adds one empty Program row to the Engine.',
      tag: 'UPGRADE',
    };
  }
  const node = NODE_BY_ID.get(card.nodeId);
  if (!node) return { title: card.nodeId, body: '', tag: '?' };
  const cost =
    node.kind === 'modifier' ? `x${node.cycleMult} Cycles` : `${node.cycleCost} Cycles`;
  const hue = node.kind === 'action' ? ` · ${node.hue}` : '';
  return {
    title: node.name,
    body: `${node.description}  [${cost}${hue}]`,
    tag: node.kind.toUpperCase(),
  };
}

/** Apply a chosen card. Returns the Program row it landed in, if any. */
export function applyDraft(world: World, card: DraftCard): number | null {
  let landed: number | null = null;

  if (card.kind === 'capacity') {
    world.budget.capacity += card.amount;
  } else if (card.kind === 'program_slot') {
    world.engine.addProgramSlot();
  } else {
    landed = world.engine.autoSlot(card.nodeId);
  }

  world.syncBudget();
  if (world.pendingDrafts > 0) world.pendingDrafts--;
  return landed;
}

/** §8.3 — Purge permanently removes a card from this run's pool. */
export function purgeCard(world: World, card: DraftCard): boolean {
  if (card.kind !== 'node') return false;
  if (world.purges <= 0) return false;
  world.purges--;
  world.purged.add(card.nodeId);
  return true;
}

export function useReroll(world: World): boolean {
  if (world.rerolls <= 0) return false;
  world.rerolls--;
  return true;
}
