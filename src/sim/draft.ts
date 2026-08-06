/**
 * The Draft. GDD §8.
 *
 * Deterministic: every roll draws from the World's Rng, so a replayed run offers
 * the same cards in the same order.
 *
 * ---
 *
 * **What the pool does is data; how it does it is here.** This file used to hold
 * the whole policy as control flow — a hunger curve as a literal array, the
 * class ratio as a ternary, the inert penalty and the empty-slot pull as bare
 * multiplications, the filler slice as three magic thresholds, and the stat
 * table as an array with entries duplicated by hand to mean "weight". Which
 * meant every question about the shape of the draft was a commit: you could not
 * ask whether the pool leaned too hard on modifiers, you could only change it
 * and see.
 *
 * Now `POOL_FILTERS` and `WEIGHT_OPS` are registries of named verbs and
 * draftpool.json composes them — the same shape as `ACTION_RUNNERS`,
 * `TRAIT_RUNNERS`, `POI_EFFECTS`, `HAZARDS`, `DISCOVERY_CHECKS` and a wave
 * event's `via` chain. A profile names its filters in order, its weight ops in
 * order, and every number they read. A variant states its difference and
 * inherits the rest.
 *
 * Two properties this arrangement is *for*, and both are load-bearing:
 *
 *   **Every profile is validated at load**, against these registries, so a
 *   renamed op is a build failure rather than a weighting that silently does
 *   nothing. That is the failure this file has already shipped twice.
 *
 *   **Each filter enforces exactly one rule.** A filter that also quietly
 *   enforces its neighbour's makes the variant that drops the neighbour a no-op,
 *   and a no-op experiment reads as a result. See `affordable`.
 *
 * §17.3 — "a drafted node visibly fires within 2s" — is a property of the
 * *shipped* profile, which keeps `placeable`, and not of the grammar.
 */
import {
  ACTIONS,
  MODIFIERS,
  TRIGGERS,
  NODE_BY_ID,
  DRAFT_POOL,
  DRAFT_POOLS,
  DRAFT_POOL_BY_ID,
} from '../content/index';
import type { DraftPoolDef, DraftStatDef, NodeDef, NodeKind } from './types';
import { LOADBEARING, TUNABLE } from './tunables';
import { inertFields, TAG_GLYPH, tagRequiredBy, tagsOf, type Tag } from './engine';
import type { World } from './world';
import { axiom as getAxiom } from '../content/index';

/**
 * §8.2 — the floor that keeps a draft from being dead, and, now, three cards
 * that are not boring at all.
 *
 * The first five are deliberately small. They exist so a draft always has
 * something legal in it, and measured across a real run they were the cards you
 * passed — four Gains offered and four refused.
 *
 * The last three are the class stats, and they only pay if your Engine is
 * focused. +1 Pierce and +20% projectile speed is nothing to a Nova build and a
 * great deal to a Bolt build. That makes them the first stats in the game that
 * are a *decision* rather than a small number, and it gives a non-cascade build
 * something to scale into — which is most of the answer to "what if I never draw
 * On Hit".
 *
 * The names are here; the magnitudes, the frequencies and the card text are in
 * draftpool.json. This list used to be three lists that had to agree — the type,
 * a table of closures, and an array of duplicated entries that the roller
 * actually picked from — and twice a stat was added to the first two and not the
 * third. Both times the card existed, was documented, and could not be drawn.
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

/**
 * A card's identity as one string, for anything counting what was offered.
 *
 * Lives here rather than in each consumer because two of them exist — the
 * per-run report in analyse.ts and the telemetry the whole corpus is built from
 * — and a pick rate computed two ways that quietly disagree is worse than
 * either. Namespaced so a node called `reroll` could never collide with the tool.
 */
export function cardId(card: DraftCard): string {
  if (card.kind === 'node') return card.nodeId;
  if (card.kind === 'stat') return `stat:${card.stat}`;
  if (card.kind === 'tool') return `tool:${card.tool}`;
  return card.kind;
}

/**
 * What each stat *does*, and nothing about how much or how often.
 *
 * A verb per stat, taking the magnitude as an argument. Almost all of them are
 * one line onto `bonuses`, which is the point: the interesting part of a stat
 * card was never the assignment, it was the number and the frequency, and both
 * of those were buried in a closure next to a sentence that restated them in
 * English. `+40 max Integrity` was written twice, in two languages, and the
 * Momentum card's text said `+45%` while the cap it described was 40%.
 */
const STAT_APPLY: Record<StatKind, (w: World, amount: number) => void> = {
  crit: (w, a) => {
    w.bonuses.crit += a;
  },
  magnet: (w, a) => {
    w.bonuses.magnet += a;
  },
  speed: (w, a) => {
    w.bonuses.speed += a;
  },
  // The scaling that lets a deliberately weak Action become monstrous by the
  // end of a run. It multiplies *everything*, so it stays small per card.
  power: (w, a) => {
    w.bonuses.power += a;
  },
  // §7.x Reach — the stat that moves you.
  //
  // Base ranges are short on purpose: a Bolt crosses 430 units and the visible
  // arena is nearly two thousand across, so an unaugmented Engine kills things
  // you can see. Reach is how a build buys the screen back, and unlike every
  // other stat here it changes *where you stand* rather than what a number says.
  reach: (w, a) => {
    w.bonuses.reach += a;
  },
  // §6 — the Heat stats. Heat is a whole economy with no stat attached to it,
  // which is why every build treats it as weather rather than as a number they
  // own. These are the two dials.
  coolant: (w, a) => {
    w.bonuses.coolant += a;
  },
  capacitor: (w, a) => {
    w.bonuses.capacitor += a;
  },
  // §4.1 — the one stat that buys a *verb*. Dash is the whole of the player's
  // defensive kit and its cooldown has never been touchable by anything.
  dashHaste: (w, a) => {
    w.bonuses.dashHaste += a;
  },
  // §8.3 — a stat that pays for using the draft economy, so narrowing the pool
  // is a build rather than housekeeping.
  salvage: (w, a) => {
    w.bonuses.salvage += a;
  },
  // The stat that pays for not being hit. Every other defensive card in the
  // game buys Integrity; this one buys *play*.
  momentum: (w, a) => {
    w.bonuses.momentum += a;
  },
  integrity: (w, a) => {
    w.player.maxIntegrity += a;
    w.player.integrity = Math.min(w.player.maxIntegrity, w.player.integrity + a);
  },
  // ---- the class stats. Worthless to a build that is not focused. --------
  travels: (w, a) => {
    w.bonuses.travels += a;
  },
  area: (w, a) => {
    w.bonuses.area += a;
  },
  lingers: (w, a) => {
    w.bonuses.lingers += a;
  },
};

/** The vocabulary of stats, as the type declares it. Compared against the data. */
export const STAT_KINDS = Object.keys(STAT_APPLY) as StatKind[];

function renderAmount(def: DraftStatDef): string {
  return def.format === 'percent' ? `${Math.round(def.amount * 100)}%` : String(def.amount);
}

/**
 * A stat card, assembled from its data and its verb.
 *
 * Kept as a `Record` so every existing reader — the draft overlay, the coverage
 * test — sees the shape it always saw. What changed is where the numbers come
 * from, and that `body` interpolates them rather than repeating them.
 */
export const STAT_CARDS: Record<
  StatKind,
  { title: string; body: string; amount: number; apply: (w: World) => void }
> = (() => {
  const out = {} as Record<
    StatKind,
    { title: string; body: string; amount: number; apply: (w: World) => void }
  >;
  for (const def of DRAFT_POOL.stats) {
    const stat = def.stat as StatKind;
    const verb = STAT_APPLY[stat];
    if (!verb) {
      throw new Error(
        `draftpool.json: stat "${def.stat}" has no verb in STAT_APPLY — the card would ` +
          `be offered and do nothing`,
      );
    }
    out[stat] = {
      title: def.title,
      amount: def.amount,
      body: def.body
        .replaceAll('{n}', renderAmount(def))
        .replaceAll('{cap}', `${Math.round(TUNABLE.momentumCap * 100)}%`),
      apply: (w) => verb(w, def.amount),
    };
  }
  // ...and the other direction, which is the failure this file has actually
  // shipped: a stat that exists in the type, has a verb, and is in no profile,
  // so it is documented and undraftable.
  for (const stat of STAT_KINDS) {
    if (!out[stat]) {
      throw new Error(`draftpool.json: stat "${stat}" has a verb but no card — it can never be offered`);
    }
  }
  return out;
})();

/**
 * The stat slice, expanded to one entry per unit of weight.
 *
 * Flat rather than a weighted pick because `Rng.pick` is a single draw off the
 * stream and `pickWeighted` is too, but they land on different entries — and
 * this array replaces one that was hand-duplicated in exactly this order. Same
 * draw, same result, so every existing seed still rolls the run it used to.
 */
const STAT_ROLL: StatKind[] = DRAFT_POOL.stats.flatMap((s) =>
  new Array<StatKind>(Math.max(1, Math.round(s.weight))).fill(s.stat as StatKind),
);

export interface DraftOffer {
  cards: DraftCard[];
  rerolls: number;
  purges: number;
}

function hueOf(node: NodeDef): string | null {
  return node.kind === 'action' ? node.hue : null;
}

function ownedCount(world: World, kind: 'trigger' | 'action'): number {
  const key = kind === 'trigger' ? 'triggerId' : 'actionId';
  return world.engine.programs.filter((p) => p[key] !== null).length;
}

/**
 * The filters, by name. Each is all-or-nothing: false and the card is not in
 * this run's pool at all.
 *
 * A list rather than a chain of `&&` so a profile can drop one. "Should a
 * Trigger you cannot place still be offered" is the single biggest shape
 * question the draft has, and answering it used to mean editing this file.
 */
const POOL_FILTERS: Record<string, (world: World, node: NodeDef) => boolean> = {
  // §15.2 — the Library narrows the pool. A locked node is not "rare", it is
  // absent: the draft must never dangle something you cannot have. The sim has
  // no idea *why* the set is what it is (see meta/progression.ts).
  library: (world, node) =>
    !world.config.availableNodes || world.config.availableNodes.includes(node.id),

  purged: (world, node) => !world.purged.has(node.id),

  // §8.2 — the pool reads what you have *rejected* as well as what you own. A
  // run refused six Program Slots and the draft kept offering them; three
  // strikes and a node stops asking. Purge is still the deliberate version of
  // this, and still the one that pays.
  refused: (world, node) => (world.refused.get(node.id) ?? 0) < TUNABLE.refusalsBeforeDrop,

  /** Can this node land somewhere right now? */
  placeable: (world, node) => {
    const programs = world.engine.programs;
    if (node.kind === 'trigger') return programs.some((p) => p.triggerId === null);
    if (node.kind === 'action') return programs.some((p) => p.actionId === null);
    return programs.some((p) => p.modifierIds.some((m) => m === null));
  },

  /**
   * §6.1 — static load can never exceed capacity. Rather than let the player
   * draft a node they cannot afford to run, we check first and drop it.
   *
   * **Answers one question.** It used to return `landed !== null && load <=
   * capacity`, which quietly folded `placeable` into it: `autoSlot` returns null
   * when there is no free slot, so an unplaceable node was unaffordable too.
   * Harmless while both filters always ran together — and it made the first
   * variant anyone wrote a no-op. `no_placeable_filter` dropped `placeable` and
   * produced results identical to `default` down to the last digit, which is
   * indistinguishable from the experiment having no effect.
   *
   * A filter that silently enforces a second filter's rule is a knob that lies
   * about what it does. This one now says only "if it lands, can the Engine run
   * it" — a node with nowhere to go is somebody else's veto. Composed with
   * `placeable`, as `default` does, the pool is exactly what it always was.
   */
  affordable: (world, node) => {
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
    return landed === null || load <= world.budget.capacity;
  },
};

/** How many nodes of each kind this *run* can draw. See `classShare`. */
function classSizes(world: World): Record<NodeKind, number> {
  const available = world.config.availableNodes;
  const count = (all: readonly NodeDef[]) =>
    Math.max(1, available ? all.filter((n) => available.includes(n.id)).length : all.length);
  return { trigger: count(TRIGGERS), action: count(ACTIONS), modifier: count(MODIFIERS) };
}

/** What a weight op is handed. Precomputed once per roll, not once per card. */
interface WeightCtx {
  world: World;
  classSize: Record<NodeKind, number>;
  bias: Record<string, number>;
}

/**
 * The weight ops, by name. Each returns a multiplier; the profile's list is
 * applied in order.
 *
 * Ordering is preserved because it is not commutative in general — an op could
 * clamp — and because a profile that reorders them should mean what it says.
 */
const WEIGHT_OPS: Record<
  string,
  (ctx: WeightCtx, node: NodeDef, op: DraftPoolDef['weights'][number]) => number
> = {
  /**
   * Intended frequency: modifiers > (triggers == actions).
   *
   * Triggers used to sit at 7 against Actions' 13, on the theory that a run
   * needs "perhaps six triggers and six actions" and Triggers are the cheaper
   * half. Both halves of that were wrong. A row needs *one of each*, so across a
   * four-row Engine you need exactly as many Triggers as Actions.
   *
   * Per *class*, not per card, so the share does not move every time content is
   * added — and divided by what this **run** can draw rather than by what
   * exists. That is a real fix, not a rename: `TRIGGERS.length` counted all
   * sixteen Triggers while a gated account could draw seven, so the trigger
   * class silently handed out weight sized for a pool more than twice the one
   * it had. Inert while progression is open, because there the two are equal —
   * which is exactly when a bug like this survives a review.
   */
  classShare: (ctx, node, op) =>
    (op.shares?.[node.kind] ?? 1) * (100 / ctx.classSize[node.kind]),

  /**
   * §8.2 — how badly the Engine needs more of a kind.
   *
   * A run only fails one way at the start, and it is not a bad build: it is *no*
   * build. Draft five modifiers before your second action and the clear rate
   * never gets high enough to earn the drafts that would have fixed it — the run
   * is over about ninety seconds before it ends.
   *
   * So the pool leans toward whichever kind you are short of, hard when you have
   * none and not at all once you have three. Deliberately a function of what you
   * *own* rather than of your level: it fires exactly when a build is starving,
   * stops on its own without a cliff, and fires again after a Recompile.
   */
  hunger: (ctx, node, op) => {
    if (!op.kinds?.includes(node.kind)) return 1;
    const curve = op.curve ?? [1];
    const owned = ownedCount(ctx.world, node.kind as 'trigger' | 'action');
    return curve[Math.min(curve.length - 1, owned)] ?? 1;
  },

  /**
   * §8.2 — "pool weighted by what the player owns". An empty slot pulls its own
   * kind toward you, so a half-built Engine finishes itself. This stacks with
   * hunger on purpose: a lone Trigger with nothing to fire is the single worst
   * state the Engine can be in, and it should not survive one draft.
   */
  emptySlotPull: (ctx, node, op) => {
    const programs = ctx.world.engine.programs;
    const half =
      node.kind === 'action'
        ? programs.some((p) => p.actionId === null && p.triggerId)
        : node.kind === 'trigger'
          ? programs.some((p) => p.triggerId === null && p.actionId)
          : false;
    return half ? (op.mult ?? 1) : 1;
  },

  /**
   * §5.5 — a modifier that does nothing to anything you own is not a card, it is
   * a blank. Measured before this: 25% of the modifier cards a run was offered
   * were inert on every Action the player had. Not zero — an inert modifier is a
   * legitimate bet on an Action you have not drawn yet, and §1.3's first pillar
   * says the grammar stays legal.
   */
  inertPenalty: (ctx, node, op) => {
    if (node.kind !== 'modifier') return 1;
    const owned = ctx.world.engine.programs
      .map((p) => p.actionId)
      .filter((a): a is string => !!a);
    if (owned.length === 0) return 1;
    return owned.every((a) => inertFields(node.id, a).length > 0) ? (op.mult ?? 1) : 1;
  },

  /** §8.4 — the Axiom's lean, by node id or by hue. */
  axiomBias: (ctx, node) => {
    const hue = hueOf(node);
    return ctx.bias[node.id] ?? (hue ? ctx.bias[hue] : undefined) ?? 1;
  },

  /** A node's own thumb on the scale, from its content record. */
  poolWeight: (_ctx, node) => node.poolWeight ?? 1,
};

/**
 * Fail at load, not at the draft that needed it.
 *
 * A profile naming an op that does not exist would otherwise weight nothing and
 * read as a tuning result — the exact failure mode this file has shipped twice
 * with the stat list. Runs over every profile, not just the active one, so a
 * variant is known to be runnable before someone reaches for it mid-sweep.
 */
for (const profile of DRAFT_POOLS) {
  for (const name of profile.filters) {
    if (!POOL_FILTERS[name]) {
      throw new Error(`draftpool.json: profile "${profile.id}" names unknown filter "${name}"`);
    }
  }
  for (const op of profile.weights) {
    if (!WEIGHT_OPS[op.op]) {
      throw new Error(`draftpool.json: profile "${profile.id}" names unknown weight op "${op.op}"`);
    }
  }
}

function weightFor(ctx: WeightCtx, node: NodeDef, policy: DraftPoolDef): number {
  let weight = 1;
  for (const op of policy.weights) weight *= WEIGHT_OPS[op.op]!(ctx, node, op);
  return weight;
}

/**
 * The policy this run rolls under. `config.draftPoolId` wins, then the active
 * profile — and an id that does not resolve throws rather than silently falling
 * back, because a sweep that quietly measured `default` while it was asked for
 * a variant is worse than one that stopped.
 */
export function poolFor(world: World): DraftPoolDef {
  const id = world.config.draftPoolId;
  if (!id) return DRAFT_POOL;
  const found = DRAFT_POOL_BY_ID.get(id);
  if (!found) {
    throw new Error(
      `Unknown draft pool "${id}" — draftpool.json has [${DRAFT_POOLS.map((p) => p.id).join(', ')}]`,
    );
  }
  return found;
}

/** Roll a fresh set of draft cards. */
export function rollDraft(world: World, policy: DraftPoolDef = poolFor(world)): DraftOffer {
  const filters = policy.filters.map((name) => POOL_FILTERS[name]!);
  const pool: NodeDef[] = [...TRIGGERS, ...ACTIONS, ...MODIFIERS].filter((n) =>
    filters.every((f) => f(world, n)),
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

  const ctx: WeightCtx = {
    world,
    classSize: classSizes(world),
    bias: getAxiom(world.config.axiomId).poolBias,
  };
  const filler = policy.filler;

  while (cards.length < cardCount) {
    const remaining = pool.filter((n) => !taken.has(n.id));

    // §8.2 — capacity upgrades and a Program slot are the floor that keeps a
    // draft from ever being dead, so an empty pool is all filler.
    //
    // Stats sit second in the intended frequency, so the filler slice is wide —
    // but not while the Engine is starving. +20% Power on a build with one live
    // row is a card that does nothing, offered at the exact moment a card that
    // does nothing is most expensive.
    const starving =
      ownedCount(world, 'trigger') < filler.starvingBelow ||
      ownedCount(world, 'action') < filler.starvingBelow;
    const chance = starving
      ? filler.chance.starving
      : world.phase === 'meltdown'
        ? filler.chance.meltdown
        : filler.chance.base;
    // Short-circuit deliberately: an empty pool takes no draw off the stream.
    const rollFiller = remaining.length === 0 || world.rng.chance(chance);

    if (rollFiller) {
      // One draw against cumulative bands. A band whose `needs` is unmet falls
      // through to the next rather than resizing the rest — see DraftFillerSlice.
      const roll = world.rng.next();
      const band =
        filler.slice.find(
          (s) => roll < s.upTo && (s.needs !== 'programSlot' || world.engine.programs.length < LOADBEARING.programSlotsMax),
        ) ?? filler.slice[filler.slice.length - 1]!;

      if (band.card === 'program_slot') {
        cards.push({ kind: 'program_slot' });
      } else if (band.card === 'tool') {
        // §8.3 — the draft economy is itself draftable. Purge is the tailoring
        // tool, so it is the scarce one: a Reroll buys another look at the pool,
        // a Purge permanently narrows it, and only one of those compounds.
        cards.push({
          kind: 'tool',
          tool: world.rng.chance(band.purgeChance ?? 0) ? 'purge' : 'reroll',
        });
      } else if (band.card === 'stat') {
        cards.push({ kind: 'stat', stat: world.rng.pick(STAT_ROLL) });
      } else {
        cards.push({ kind: 'capacity', amount: TUNABLE.capacityUpgradeAmount });
      }
      continue;
    }

    const node = world.rng.pickWeighted(
      remaining,
      remaining.map((n) => weightFor(ctx, n, policy)),
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


