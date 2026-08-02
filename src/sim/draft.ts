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

/** §8.2 — the deliberately boring floor that keeps a draft from being dead. */
export type StatKind = 'crit' | 'magnet' | 'speed' | 'integrity';

export type DraftCard =
  | { kind: 'node'; nodeId: string }
  | { kind: 'capacity'; amount: number }
  | { kind: 'program_slot' }
  | { kind: 'stat'; stat: StatKind };

export const STAT_CARDS: Record<StatKind, { title: string; body: string; apply: (w: World) => void }> =
  {
    crit: {
      title: 'Precision',
      body: '+4% crit chance. Crits hit for double and fire On Crit.',
      apply: (w) => {
        w.bonuses.crit += 0.04;
      },
    },
    magnet: {
      title: 'Collector',
      body: '+30% pickup radius.',
      apply: (w) => {
        w.bonuses.magnet += 0.3;
      },
    },
    speed: {
      title: 'Servo',
      body: '+8% move speed.',
      apply: (w) => {
        w.bonuses.speed += 0.08;
      },
    },
    integrity: {
      title: 'Plating',
      body: '+25 max Integrity, and repairs that much now.',
      apply: (w) => {
        w.player.maxIntegrity += 25;
        w.player.integrity = Math.min(w.player.maxIntegrity, w.player.integrity + 25);
      },
    },
  };

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

  // With 16 modifiers, 10 triggers and 10 actions, a flat base put Actions at
  // under a fifth of the pool — a full run could hand out a single weapon. The
  // roster is lopsided by design (§22 ships 14 modifiers), so the weights have
  // to compensate rather than mirror it.
  let base = node.kind === 'modifier' ? 10 : node.kind === 'trigger' ? 13 : 24;

  // §8.2 — "pool weighted by what the player owns". An empty slot pulls its own
  // kind toward you, so a half-built Engine finishes itself.
  const programs = world.engine.programs;
  if (node.kind === 'action' && programs.some((p) => p.actionId === null && p.triggerId)) base *= 2;
  if (node.kind === 'trigger' && programs.some((p) => p.triggerId === null && p.actionId)) base *= 2;

  return base * (byId ?? byHue ?? 1) * (node.poolWeight ?? 1);
}

/** Roll a fresh set of draft cards. */
export function rollDraft(world: World): DraftOffer {
  const pool: NodeDef[] = [...TRIGGERS, ...ACTIONS, ...MODIFIERS].filter(
    (n) => !world.purged.has(n.id) && placeable(world, n) && affordable(world, n),
  );

  const cards: DraftCard[] = [];
  const taken = new Set<string>();

  // §9.1 — the next few drafts after a Recompile offer four cards, and §13.3
  // shifts the Meltdown pool toward capacity so a big Engine can keep running.
  const cardCount = world.surgeDrafts > 0 ? TUNABLE.rebuildSurgeCards : TUNABLE.draftCards;

  while (cards.length < cardCount) {
    const remaining = pool.filter((n) => !taken.has(n.id));

    // §8.2 — capacity upgrades and (here) a Program slot are the floor that keeps
    // a draft from ever being dead.
    const slotAvailable = world.engine.programs.length < LOADBEARING.programSlotsMax;
    const fillerWeight =
      remaining.length === 0 ? 1 : world.phase === 'meltdown' ? 0.34 : 0.18;
    const rollFiller = remaining.length === 0 || world.rng.chance(fillerWeight);

    if (rollFiller) {
      const roll = world.rng.next();
      if (slotAvailable && roll < 0.25) {
        cards.push({ kind: 'program_slot' });
      } else if (roll < 0.62) {
        // §8.2 — a small, deliberately boring stat pool.
        const stats: StatKind[] = ['crit', 'magnet', 'speed', 'integrity'];
        cards.push({ kind: 'stat', stat: world.rng.pick(stats) });
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
  if (card.kind === 'stat') {
    const stat = STAT_CARDS[card.stat];
    return { title: stat.title, body: stat.body, tag: 'STAT' };
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
  } else if (card.kind === 'stat') {
    STAT_CARDS[card.stat].apply(world);
  } else {
    landed = world.engine.autoSlot(card.nodeId);
  }

  world.syncBudget();
  if (world.pendingDrafts > 0) world.pendingDrafts--;
  if (world.surgeDrafts > 0) world.surgeDrafts--;
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
