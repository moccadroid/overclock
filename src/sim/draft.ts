/**
 * The Draft. GDD §8.
 *
 * Deterministic: every roll draws from the World's Rng, so a replayed run offers
 * the same cards in the same order. Cards that cannot be placed are never
 * offered — §17.3 requires a drafted node to visibly fire within 2s, and a
 * modifier that lands nowhere breaks that promise.
 */
import { ACTIONS, MODIFIERS, TRIGGERS, NODE_BY_ID } from '../content/index';
import type { NodeDef, NodeKind } from './types';
import { LOADBEARING, TUNABLE } from './tunables';
import { inertFields, TAG_GLYPH, tagRequiredBy, tagsOf, type Tag } from './engine';
import type { World } from './world';
import { axiom as getAxiom } from '../content/index';

/**
 * §8.2 — the floor that keeps a draft from being dead, and, now, three cards
 * that are not boring at all.
 *
 * The first five are deliberately small: +8% damage, +25 Integrity. They exist
 * so a draft always has something legal in it, and measured across a real run
 * they were the cards you passed — four Gains offered and four refused.
 *
 * The last three are the class stats, and they only pay if your Engine is
 * focused. +1 Pierce and +15% projectile speed is nothing to a Nova build and a
 * great deal to a Bolt build. That makes them the first stats in the game that
 * are a *decision* rather than a small number, and it gives a non-cascade build
 * something to scale into — which is most of the answer to "what if I never draw
 * On Hit".
 */
export type StatKind =
  | 'crit'
  | 'magnet'
  | 'speed'
  | 'integrity'
  | 'power'
  | 'reach'
  | 'dashHaste'
  | 'coolant'
  | 'capacitor'
  | 'salvage'
  | 'momentum'
  | 'travels'
  | 'area'
  | 'lingers';

/** §8.3 — the draft economy, drafted. */
export type ToolKind = 'reroll' | 'purge';

export type DraftCard =
  | { kind: 'node'; nodeId: string }
  | { kind: 'capacity'; amount: number }
  | { kind: 'program_slot' }
  | { kind: 'stat'; stat: StatKind }
  | { kind: 'tool'; tool: ToolKind };

export const STAT_CARDS: Record<StatKind, { title: string; body: string; apply: (w: World) => void }> =
  {
    crit: {
      title: 'Precision',
      body: '+10% crit chance. A crit deals double damage and fires On Crit.',
      apply: (w) => {
        w.bonuses.crit += 0.1;
      },
    },
    magnet: {
      title: 'Collector',
      body: '+50% pickup radius.',
      apply: (w) => {
        w.bonuses.magnet += 0.5;
      },
    },
    speed: {
      title: 'Servo',
      body: '+15% move speed.',
      apply: (w) => {
        w.bonuses.speed += 0.15;
      },
    },
    // The scaling that lets a deliberately weak Action become monstrous by the
    // end of a run. Base numbers are tuned for act one; this is how act three
    // gets its ×3. It multiplies *everything*, so it stays small per card.
    power: {
      title: 'Gain',
      body: '+20% damage on every Action you own.',
      apply: (w) => {
        w.bonuses.power += 0.2;
      },
    },
    // §7.x Reach — the stat that moves you.
    //
    // Base ranges are short on purpose: a Bolt crosses 430 units and the visible
    // arena is nearly two thousand across, so an unaugmented Engine kills things
    // you can see. Reach is how a build buys the screen back, and unlike every
    // other stat here it changes *where you stand* rather than what a number
    // says — which makes it the first stat with a downside worth thinking about,
    // since standing further away is also standing alone.
    reach: {
      title: 'Reach',
      body: '+35% range. Projectile flight distance, beam length, chain jump distance.',
      apply: (w) => {
        w.bonuses.reach += 0.35;
      },
    },

    // §6 — the Heat stats. Heat is a whole economy with no stat attached to it,
    // which is why every build treats it as weather rather than as a number they
    // own. These are the two dials.
    coolant: {
      title: 'Coolant',
      body: '+3 Heat vented per second. Base venting is 8.',
      apply: (w) => {
        w.bonuses.coolant += 3;
      },
    },
    capacitor: {
      title: 'Capacitor',
      body: '+8 Cycle capacity for each Program row that is not live.',
      apply: (w) => {
        w.bonuses.capacitor += 8;
      },
    },
    // §4.1 — the one stat that buys a *verb*. Dash is the whole of the player's
    // defensive kit and its cooldown has never been touchable by anything.
    dashHaste: {
      title: 'Capacitor Bank',
      body: '-25% dash cooldown, and +0.05s of dash i-frames.',
      apply: (w) => {
        w.bonuses.dashHaste += 0.25;
      },
    },

    // §8.3 — a stat that pays for using the draft economy, so narrowing the pool
    // is a build rather than housekeeping.
    salvage: {
      title: 'Salvage',
      body: 'Each Purge also adds +4% output permanently, on top of the +4% a Purge already gives.',
      apply: (w) => {
        w.bonuses.salvage += 1;
      },
    },
    // The stat that pays for not being hit. Every other defensive card in the
    // game buys Integrity; this one buys *play*.
    momentum: {
      title: 'Momentum',
      body: '+3% output for each second since you were last hurt, up to +45%. Resets to zero when you take damage.',
      apply: (w) => {
        w.bonuses.momentum += 0.03;
      },
    },

    integrity: {
      title: 'Plating',
      body: '+40 max Integrity. Heals 40 now.',
      apply: (w) => {
        w.player.maxIntegrity += 40;
        w.player.integrity = Math.min(w.player.maxIntegrity, w.player.integrity + 40);
      },
    },

    // ---- the class stats. Worthless to a build that is not focused. --------
    travels: {
      title: 'Ballistics',
      body: '+1 Pierce and +20% projectile speed. Projectiles only.',
      apply: (w) => {
        w.bonuses.travels += 1;
      },
    },
    area: {
      title: 'Yield',
      body: '+30% radius on bursts, fields, mines, vortices and shoves.',
      apply: (w) => {
        w.bonuses.area += 0.3;
      },
    },
    lingers: {
      title: 'Half-Life',
      body: '+40% duration on fields, mines, orbitals, vortices and buffs.',
      apply: (w) => {
        w.bonuses.lingers += 0.4;
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

/**
 * §8.2 — how badly the Engine needs more of a kind, as a pool multiplier.
 *
 * A run only fails one way at the start, and it is not a bad build: it is *no*
 * build. Modifiers outnumber triggers and actions in the pool by a wide margin
 * and are weighted higher on top of that, which is right for a full Engine and
 * lethal for an empty one. Draft five modifiers before your second action and
 * the clear rate never gets high enough to earn the drafts that would have
 * fixed it — the run is over about ninety seconds before it ends.
 *
 * So the pool leans toward whichever of the two you are short of, hard when you
 * have none and not at all once you have three. This is deliberately a function
 * of what you *own* rather than of your level: it fires exactly when a build is
 * starving, and it stops on its own without a cliff at level 10. It also fires
 * again after a Recompile, which deletes the Engine and hands you the same
 * problem in the middle of a run.
 */
const HUNGER = [4.2, 2.6, 1.5, 1];

function ownedCount(world: World, kind: 'trigger' | 'action'): number {
  const key = kind === 'trigger' ? 'triggerId' : 'actionId';
  return world.engine.programs.filter((p) => p[key] !== null).length;
}

/** How many nodes of this kind exist at all. Cached — content is immutable. */
const CLASS_SIZE: Record<NodeKind, number> = {
  trigger: TRIGGERS.length,
  action: ACTIONS.length,
  modifier: MODIFIERS.length,
};

function classSize(kind: NodeKind): number {
  return Math.max(1, CLASS_SIZE[kind]);
}

function weightFor(world: World, node: NodeDef): number {
  const bias = getAxiom(world.config.axiomId).poolBias;
  const hue = hueOf(node);
  const byId = bias[node.id];
  const byHue = hue ? bias[hue] : undefined;

  // Intended frequency: modifiers > (triggers == actions).
  //
  // Triggers used to sit at 7 against Actions' 13, on the theory that a run
  // needs "perhaps six triggers and six actions" and Triggers are the cheaper
  // half. Both halves of that were wrong. A row needs *one of each*, so across a
  // four-row Engine you need exactly as many Triggers as Actions — and the
  // asymmetry meant the hunger multiplier below, which fires when you are short
  // of either, still handed you Actions. Measured on a fourteen-minute run: the
  // player drew their second Trigger at 8:29 and spent seven minutes with the
  // one their Axiom gave them.
  //
  // Modifiers stay ahead of both, because you can absorb those forever and they
  // are the scaling that lets a build become monstrous late.
  // Per *class*, not per card. The old version gave every modifier 26 and every
  // trigger 13, which meant the class shares moved every time content was added:
  // six new Triggers took the pool from ten to sixteen and pulled the whole
  // trigger share up with them, for no design reason at all. Dividing by the
  // live count of each kind fixes the ratio where §8.2 wants it — modifiers
  // twice everything else — and keeps it there however much content lands later.
  let base = (node.kind === 'modifier' ? 2 : 1) * (100 / classSize(node.kind));

  if (node.kind !== 'modifier') {
    base *= HUNGER[Math.min(HUNGER.length - 1, ownedCount(world, node.kind))]!;
  }

  // §5.5 — a modifier that does nothing to anything you own is not a card, it is
  // a blank. Measured before this: 25% of the modifier cards a run was offered
  // were inert on every Action the player had. The tags say so on the card now,
  // which helps a player who reads them; this stops the pool asking in the first
  // place. Not zero — an inert modifier is a legitimate bet on an Action you
  // have not drawn yet, and §1.3's first pillar says the grammar stays legal.
  if (node.kind === 'modifier') {
    const owned = world.engine.programs.map((p) => p.actionId).filter((a): a is string => !!a);
    if (owned.length > 0 && owned.every((a) => inertFields(node.id, a).length > 0)) base *= 0.12;
  }

  // §8.2 — "pool weighted by what the player owns". An empty slot pulls its own
  // kind toward you, so a half-built Engine finishes itself. This stacks with
  // hunger on purpose: a lone Trigger with nothing to fire is the single worst
  // state the Engine can be in, and it should not survive one draft.
  const programs = world.engine.programs;
  if (node.kind === 'action' && programs.some((p) => p.actionId === null && p.triggerId)) base *= 2;
  if (node.kind === 'trigger' && programs.some((p) => p.triggerId === null && p.actionId)) base *= 2;

  return base * (byId ?? byHue ?? 1) * (node.poolWeight ?? 1);
}

/** Roll a fresh set of draft cards. */
export function rollDraft(world: World): DraftOffer {
  // §15.2 — the Library narrows the pool. A locked node is not "rare", it is
  // absent: the draft must never dangle something you cannot have.
  const available = world.config.availableNodes;
  const pool: NodeDef[] = [...TRIGGERS, ...ACTIONS, ...MODIFIERS].filter(
    (n) =>
      (!available || available.includes(n.id)) &&
      !world.purged.has(n.id) &&
      // §8.2 — the pool reads what you have *rejected* as well as what you own.
      // A run refused six Program Slots and the draft kept offering them; three
      // strikes and a node stops asking. Purge is still the deliberate version
      // of this, and still the one that pays.
      (world.refused.get(n.id) ?? 0) < TUNABLE.refusalsBeforeDrop &&
      placeable(world, n) &&
      affordable(world, n),
  );

  const cards: DraftCard[] = [];
  const taken = new Set<string>();

  // §8.3 Lock — a card held over from the last draft comes back first, whatever
  // the pool would otherwise have said.
  if (world.locked) {
    const held = pool.find((n) => n.id === world.locked);
    if (held) {
      cards.push({ kind: 'node', nodeId: held.id });
      taken.add(held.id);
    }
    world.locked = null;
  }

  // §9.1 — the next few drafts after a Recompile offer four cards, and §13.3
  // shifts the Meltdown pool toward capacity so a big Engine can keep running.
  const cardCount = world.surgeDrafts > 0 ? TUNABLE.rebuildSurgeCards : TUNABLE.draftCards;

  while (cards.length < cardCount) {
    const remaining = pool.filter((n) => !taken.has(n.id));

    // §8.2 — capacity upgrades and (here) a Program slot are the floor that keeps
    // a draft from ever being dead.
    const slotAvailable = world.engine.programs.length < LOADBEARING.programSlotsMax;
    // Stats sit second in the intended frequency, so the filler slice is wide —
    // but not while the Engine is starving. +8 Power on a build with one live
    // row is a card that does nothing, offered at the exact moment a card that
    // does nothing is most expensive.
    const starving = ownedCount(world, 'trigger') < 2 || ownedCount(world, 'action') < 2;
    const fillerWeight =
      remaining.length === 0 ? 1 : starving ? 0.12 : world.phase === 'meltdown' ? 0.4 : 0.3;
    const rollFiller = remaining.length === 0 || world.rng.chance(fillerWeight);

    if (rollFiller) {
      const roll = world.rng.next();
      if (slotAvailable && roll < 0.16) {
        cards.push({ kind: 'program_slot' });
      } else if (roll < 0.28) {
        // §8.3 — the draft economy is itself draftable. Purge is the tailoring
        // tool, so it is the scarce one: a Reroll buys another look at the pool,
        // a Purge permanently narrows it, and only one of those compounds.
        cards.push({ kind: 'tool', tool: world.rng.chance(0.32) ? 'purge' : 'reroll' });
      } else if (roll < 0.74) {
        // §8.2 — a small, deliberately boring stat pool.
        // Weighted by hand rather than uniformly: Gain is the scaling curve, so
        // it shows up roughly twice as often as the utility stats.
        // The class stats were added to the type and to STAT_CARDS and never
        // to this array, so for one whole release they existed, were documented,
        // and could not be drawn. Measured: 63 cards offered across a run, eight
        // of them stats, not one a class stat.
        const stats: StatKind[] = [
          'power',
          'crit',
          'magnet',
          'speed',
          'integrity',
          // Twice, like the class stats and for the same reason: base ranges are
          // short enough that Reach is a build decision rather than a trim, so
          // it has to show up often enough to plan around. (And the same bug
          // caught it as caught the class stats — added to the type, to
          // STAT_CARDS, and not to this array. Measured across four full runs:
          // travels 4, area 3, lingers 3, reach 0.)
          'reach',
          'reach',
          'reach',
          'reach',
          'dashHaste',
          'dashHaste',
          'coolant',
          'capacitor',
          'salvage',
          'momentum',
          // Weighted up, because these only pay a focused Engine and a card that
          // only sometimes matters has to show up often enough to be planned for.
          'travels',
          'travels',
          'area',
          'area',
          'lingers',
          'lingers',
        ];
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

  // Remembered so applyDraft can tell which cards were passed over. Only node
  // ids: a refused stat or capacity card is not a statement about the pool.
  world.lastOffer = cards.filter((c) => c.kind === 'node').map((c) => c.nodeId);
  return { cards, rerolls: world.rerolls, purges: world.purges };
}

export function describeCard(card: DraftCard): {
  title: string;
  body: string;
  tag: string;
  /** §5.5 behaviour tags, for the card to render as coloured words. */
  tags?: Tag[];
} {
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
  if (card.kind === 'tool') {
    return card.tool === 'reroll'
      ? {
          title: 'Reroll',
          body: `+${TUNABLE.rerollCardAmount} rerolls. Another look at the pool, whenever you don't like what it offered.`,
          tag: 'UPGRADE',
        }
      : {
          title: 'Purge',
          body: `+${TUNABLE.purgeCardAmount} purges. Purging deletes a card from this run's pool for good — the way you narrow the draft toward the engine you are actually building.`,
          tag: 'UPGRADE',
        };
  }
  const node = NODE_BY_ID.get(card.nodeId);
  if (!node) return { title: card.nodeId, body: '', tag: '?' };
  const cost =
    node.kind === 'modifier'
      ? `x${node.cycleMult} Cycles`
      : `${node.cycleCost} ${node.cycleCost === 1 ? 'Cycle' : 'Cycles'}`;

  // §5.5 — the behaviour glyphs, on the card, before you take it.
  //
  // The rule they describe has always been enforced: Pierce writes a field a
  // Nova does not read, so it does nothing, and the game let you take it and
  // said nothing. An Action shows what it *is*; a conditional modifier shows
  // what it *needs*. Match the glyph and it works.
  const marks =
    node.kind === 'action'
      ? tagsOf(node.id)
      : node.kind === 'modifier'
        ? [tagRequiredBy(node.id)].filter((t): t is Tag => t !== null)
        : [];
  const needs =
    node.kind === 'modifier' && marks[0]
      ? `  Needs ${TAG_GLYPH[marks[0]]}.`
      : '';

  return {
    title: node.name,
    body: `${node.description}${needs}  [${cost}]`,
    tag: node.kind.toUpperCase(),
    tags: marks,
  };
}

/** Apply a chosen card. Returns the Program row it landed in, if any. */
export function applyDraft(world: World, card: DraftCard): number | null {
  let landed: number | null = null;

  // §8.2 — everything else on the table was refused. Three refusals and the pool
  // stops offering it. This is the automatic half of Purge: Purge is the
  // deliberate, paid version that also deletes the card outright.
  const chosen = card.kind === 'node' ? card.nodeId : null;
  for (const id of world.lastOffer) {
    // Not the one taken, and not the one locked: paying Heat to hold a card is
    // the opposite of refusing it, and counting it as a refusal would have the
    // pool quietly punish you for wanting something.
    if (id === chosen || id === world.locked) continue;
    world.refused.set(id, (world.refused.get(id) ?? 0) + 1);
  }
  world.lastOffer = [];

  if (card.kind === 'capacity') {
    // Banked on the run's base rather than on the live figure: syncBudget
    // recomputes capacity every time the Engine changes (see Capacitor).
    world.baseCapacity += card.amount;
  } else if (card.kind === 'program_slot') {
    world.engine.addProgramSlot();
  } else if (card.kind === 'stat') {
    STAT_CARDS[card.stat].apply(world);
  } else if (card.kind === 'tool') {
    if (card.tool === 'reroll') world.rerolls += TUNABLE.rerollCardAmount;
    else world.purges += TUNABLE.purgeCardAmount;
  } else {
    landed = world.engine.autoSlot(card.nodeId);
  }

  world.syncBudget();
  if (world.pendingDrafts > 0) world.pendingDrafts--;
  if (world.surgeDrafts > 0) world.surgeDrafts--;
  world.rerollsThisDraft = 0;
  return landed;
}

/**
 * §8.3 — Purge permanently removes a card from this run's pool, and pays you.
 *
 * The paying part is new, and it is the whole fix. Measured: the pool is 42
 * nodes, a Purge deleted exactly one of them, and within the modifier slice that
 * moved every remaining card's odds by half a percentage point. Over a
 * twenty-draft run it changed roughly one card, once. It was not a weak tool, it
 * was a rounding error with a button.
 *
 * Now a Purge also banks a Scrap stack — the same permanent +4% output that
 * scrapping a node pays — so refusing a card is *progress* rather than
 * housekeeping, and the third card in an offer is never wasted. Salvage doubles
 * that, which is how a build turns the draft economy itself into a strategy.
 */
export function purgeCard(world: World, card: DraftCard): boolean {
  if (card.kind !== 'node') return false;
  if (world.purges <= 0) return false;
  world.purges--;
  world.purged.add(card.nodeId);
  world.engine.scrapStacks += 1 + world.bonuses.salvage;
  return true;
}

/**
 * §8.3 — Reroll, priced in Heat instead of rationed per run.
 *
 * Two per run meant you hoarded them and died holding them: a resource you are
 * afraid to spend is not a decision, it is inventory. Every draft now offers a
 * reroll for Heat — the run's own currency, which the player can already read on
 * the gauge and which costs *more* the hotter they are running. Banked rerolls
 * from tool cards are spent first, so those keep their value as "a free look".
 */
export function rerollCost(world: World): number {
  if (world.rerolls > 0) return 0;
  return TUNABLE.rerollHeatCost * (1 + world.rerollsThisDraft);
}

export function canReroll(world: World): boolean {
  if (world.rerolls > 0) return true;
  // Never a reroll that overheats you outright. Choosing to run hot is a
  // decision; a button that ends the run is a trap.
  return world.budget.heat + rerollCost(world) < 100;
}

export function useReroll(world: World): boolean {
  if (!canReroll(world)) return false;
  if (world.rerolls > 0) world.rerolls--;
  else world.budget.addHeat(rerollCost(world));
  world.rerollsThisDraft++;
  return true;
}

/**
 * §8.3 — Lock: keep one card on the table for the next draft too.
 *
 * The missing tool. "I need this but I cannot afford it yet" was a pure loss —
 * you either took a card that did nothing or watched the one you wanted go back
 * in the pool. A Lock costs the same Heat a reroll does and holds exactly one
 * card, which makes saving up for an expensive Action a plan rather than a hope.
 */
export function lockCard(world: World, card: DraftCard): boolean {
  if (card.kind !== 'node') return false;
  if (world.locked === card.nodeId) return false;
  if (!canReroll(world)) return false;
  if (world.rerolls > 0) world.rerolls--;
  else world.budget.addHeat(rerollCost(world));
  world.locked = card.nodeId;
  return true;
}


