/**
 * Pilot policies. The simulated player's *taste*, as data.
 *
 * Why this is a balance surface and not harness plumbing: the draft reacts to
 * what you own and to what you refuse. Hunger leans the pool toward the kind you
 * are short of; three refusals drop a node from the run for good. So the pool a
 * run sees is a function of how that run drafts — which means the pilot is an
 * input to the measurement, and until now there was exactly one of it, written
 * as a scoring function in `bot.ts` that nobody could vary without editing the
 * harness.
 *
 * That is not a small confound. Measured on the curated library, a
 * modifier-preferring pilot burned all seven available Triggers out of its own
 * pool by refusal and finished a thirteen-minute run on one live row. The
 * reference pilot never does, because it takes Triggers. Both are the same game;
 * only the taste differs, and every number this repo has recorded came from one
 * of them.
 *
 * ---
 *
 * Same arrangement as everything else here: `when` names a condition and `op`
 * names a bonus, both from registries below; the profile composes them and owns
 * every number. Conditions that need a threshold get it from the profile's own
 * `conditions` block, so `wantMoreRows` can mean "fewer than three live rows"
 * for one pilot and "fewer than eight" for another without a second condition.
 *
 * The recompile and burn policies live here too. They were a module-level
 * mutable global and a threaded parameter respectively — a global meant a sweep
 * could not run two pilots without the first one's setting leaking into the
 * second, which is the kind of bug that shows up as a mysterious ten-percent
 * difference nobody can reproduce.
 */
import pilotsRaw from './data/pilots.json';
import { validateCollection, type Schema } from '../content/validate';
import { NODE_BY_ID } from '../content/index';
import type { NodeDef } from '../sim/types';
import type { World } from '../sim/world';
import type { DraftCard } from '../sim/draft';

/**
 * How the pilot treats Recompile terminals.
 *   never  — hoard the engine to the end
 *   eager  — take every terminal the moment it appears
 *   smart  — take it when there is output worth converting and health to spare
 */
export type RecompilePolicy = 'never' | 'eager' | 'smart';

/** Which rows it sacrifices when it does. */
export type BurnPolicy = 'strong' | 'weak' | 'all';

/** The card classes a pilot scores. Node kinds, plus the filler kinds. */
const CARD_CLASSES = [
  'trigger',
  'action',
  'modifier',
  'capacity',
  'program_slot',
  'stat',
  'tool',
] as const;
export type CardClass = (typeof CARD_CLASSES)[number];

interface ScoreRule {
  /** A condition from `CONDITIONS`. Absent means "always" — the default rung. */
  when?: string;
  score: number;
}

interface BonusRule {
  op: string;
  cards: readonly string[];
  score?: number;
  mult?: number;
}

export interface PilotDef {
  id: string;
  active?: boolean;
  description: string;
  recompile: RecompilePolicy;
  burn: BurnPolicy;
  conditions: {
    wantMoreRows: { liveRowsBelow: number };
    headroomTight: { loadShare: number; heat: number };
  };
  scores: Record<CardClass, readonly ScoreRule[]>;
  bonuses: readonly BonusRule[];
}

const ruleList: Schema[string] = {
  type: 'array',
  required: true,
  items: {
    type: 'object',
    fields: { when: { type: 'string' }, score: { type: 'number', required: true } },
  },
};

const pilotSchema: Schema = {
  id: { type: 'string', required: true },
  active: { type: 'boolean' },
  description: { type: 'string', required: true },
  recompile: { type: 'string', required: true, oneOf: ['never', 'eager', 'smart'] },
  burn: { type: 'string', required: true, oneOf: ['strong', 'weak', 'all'] },
  conditions: {
    type: 'object',
    required: true,
    fields: {
      wantMoreRows: {
        type: 'object',
        required: true,
        fields: { liveRowsBelow: { type: 'number', required: true, min: 0 } },
      },
      headroomTight: {
        type: 'object',
        required: true,
        fields: {
          loadShare: { type: 'number', required: true, min: 0 },
          heat: { type: 'number', required: true, min: 0 },
        },
      },
    },
  },
  scores: {
    type: 'object',
    required: true,
    fields: Object.fromEntries(CARD_CLASSES.map((c) => [c, ruleList])),
  },
  bonuses: {
    type: 'array',
    required: true,
    items: {
      type: 'object',
      fields: {
        op: { type: 'string', required: true },
        cards: { type: 'array', required: true, items: { type: 'string' } },
        score: { type: 'number' },
        mult: { type: 'number' },
      },
    },
  },
};

export const PILOTS = validateCollection<PilotDef>('pilots.json', pilotsRaw, pilotSchema, {});

export const PILOT_BY_ID = new Map(PILOTS.map((p) => [p.id, p]));

export const ACTIVE_PILOT: PilotDef = (() => {
  const on = PILOTS.filter((p) => p.active);
  if (on.length !== 1) {
    throw new Error(
      `pilots.json: exactly one pilot must be active, found ${on.length} ` +
        `(${on.map((p) => p.id).join(', ') || 'none'})`,
    );
  }
  return on[0]!;
})();

export function pilot(id: string): PilotDef {
  const p = PILOT_BY_ID.get(id);
  if (!p) throw new Error(`Unknown pilot "${id}" — pilots.json has [${PILOTS.map((x) => x.id).join(', ')}]`);
  return p;
}

/** Everything a condition or bonus reads, computed once per draft. */
interface PilotCtx {
  world: World;
  def: PilotDef;
  liveRows: number;
}

/**
 * The conditions, by name. A rule list is walked in order and the first whose
 * condition holds wins, so the last entry — the one with no `when` — is the
 * default rung.
 */
const CONDITIONS: Record<string, (ctx: PilotCtx) => boolean> = {
  /**
   * No live row at all. A Program needs BOTH a Trigger and an Action to fire, so
   * this has to include the empty-Engine case: written as "has an action but no
   * trigger" it is false for a freshly Recompiled Engine, and the pilot then
   * drafts modifiers onto nothing forever — which is exactly what it did.
   */
  rebuilding: (ctx) => ctx.liveRows === 0,

  needsTrigger: (ctx) => ctx.world.engine.programs.some((p) => p.triggerId === null),
  needsAction: (ctx) => ctx.world.engine.programs.some((p) => p.actionId === null),

  /**
   * Widen before deepening: a second and third firing row beats a third modifier
   * stacked on the first. Without this the reference pilot ended seven-minute
   * runs holding a single weapon even when Actions were a third of the pool.
   */
  wantMoreRows: (ctx) => ctx.liveRows < ctx.def.conditions.wantMoreRows.liveRowsBelow,

  /** Capacity is the only lever these pilots have against Heat — none of them scrap. */
  headroomTight: (ctx) => {
    const { loadShare, heat } = ctx.def.conditions.headroomTight;
    return (
      ctx.liveRows > 0 &&
      (ctx.world.engine.staticLoad > ctx.world.budget.capacity * loadShare ||
        ctx.world.budget.heat > heat)
    );
  },
};

/** Adjustments applied after the base score, in the order the profile lists them. */
const BONUS_OPS: Record<
  string,
  (score: number, ctx: PilotCtx, node: NodeDef, op: BonusRule) => number
> = {
  /**
   * A Convert occupies an Action slot but deals no damage. These pilots have no
   * economy strategy, so they treat one as a last resort rather than filling the
   * Engine with cards that produce nothing. Overrides rather than adds — the
   * point is a ceiling, not a discount.
   */
  convertPenalty: (score, _ctx, node, op) =>
    node.kind === 'action' && node.primitive === 'convert' ? (op.score ?? 0) : score,

  /**
   * §11.1 — a pilot that never diversifies gets taxed to 60% resistance on its
   * only hue, which measures the tax rather than the game. Prefer hues the
   * Engine is currently light on.
   */
  hueDiversity: (score, ctx, node, op) =>
    node.kind === 'action' ? score + (1 - hueShare(ctx.world, node.hue)) * (op.mult ?? 0) : score,
};

// Fail at load, over every profile — not just the active one, so a pilot is
// known to be runnable before someone reaches for it mid-sweep.
for (const p of PILOTS) {
  for (const rules of Object.values(p.scores)) {
    for (const rule of rules) {
      if (rule.when && !CONDITIONS[rule.when]) {
        throw new Error(`pilots.json: pilot "${p.id}" names unknown condition "${rule.when}"`);
      }
    }
  }
  for (const b of p.bonuses) {
    if (!BONUS_OPS[b.op]) {
      throw new Error(`pilots.json: pilot "${p.id}" names unknown bonus op "${b.op}"`);
    }
  }
}

function hueShare(world: World, hue: string): number {
  let total = 0;
  let matching = 0;
  for (const p of world.engine.programs) {
    if (!p.actionId) continue;
    const node = NODE_BY_ID.get(p.actionId);
    if (node?.kind !== 'action') continue;
    total++;
    if (node.hue === hue) matching++;
  }
  return total === 0 ? 0 : matching / total;
}

function classOf(card: DraftCard): { cls: CardClass; node: NodeDef | null } | null {
  if (card.kind === 'node') {
    const node = NODE_BY_ID.get(card.nodeId);
    return node ? { cls: node.kind, node } : null;
  }
  return { cls: card.kind, node: null };
}

/**
 * Score every card and return the index of the best.
 *
 * Strictly-greater comparison, so the first of a tie wins — the old function did
 * the same, and a pilot that broke ties differently would shift every run for no
 * reason anyone could name.
 */
export function pilotDraftChoice(
  world: World,
  cards: readonly DraftCard[],
  def: PilotDef = ACTIVE_PILOT,
): number {
  const ctx: PilotCtx = {
    world,
    def,
    liveRows: world.engine.compiled.filter((c) => c.live).length,
  };

  let bestIndex = 0;
  let bestScore = -Infinity;
  cards.forEach((card, i) => {
    const info = classOf(card);
    // An unknown node id scores zero, as it always has: a card the content no
    // longer defines is not a card, and it must not win by default.
    let score = 0;
    if (info) {
      const rules = def.scores[info.cls] ?? [];
      score = rules.find((r) => !r.when || CONDITIONS[r.when]!(ctx))?.score ?? 0;
      if (info.node) {
        for (const b of def.bonuses) {
          if (b.cards.includes(info.cls)) score = BONUS_OPS[b.op]!(score, ctx, info.node, b);
        }
      }
    }
    if (score > bestScore) {
      bestScore = score;
      bestIndex = i;
    }
  });
  return bestIndex;
}
