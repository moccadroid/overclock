/**
 * The Engine: the player's ordered list of Programs, and the compilation of a
 * Program's modifier chain into a fire context. GDD §5.
 *
 * The critical property this module exists to guarantee (§5.5): modifiers apply
 * strictly left-to-right, and ORDER CHANGES OUTCOMES. Amplify is additive,
 * Split is multiplicative, so `Split -> Amplify` and `Amplify -> Split` produce
 * genuinely different numbers. See src/sim/engine.test.ts for the canonical case.
 */
import { MODIFIER_BY_ID, ACTION_BY_ID, TRIGGER_BY_ID } from '../content/index';
import type { FireField, ModifierDef } from './types';
export type { FireField };
import { LOADBEARING, SAFETY, TUNABLE } from './tunables';

/** GDD §5.5 Echo: repeats 0.2s later at 70% output. */
export const ECHO_DELAY = 0.2;
export const ECHO_FALLOFF = 0.7;

export interface FireContext {
  /** Output multiplier on the Action's base damage. */
  output: number;
  /** How many instances of the Action fire. */
  count: number;
  /** Echo depth — each level doubles the execution schedule. */
  echo: number;
  pierce: number;
  area: number;
  /** Trigger rate multiplier (Accelerate). */
  rate: number;
  duration: number;
  bounce: number;
  leech: number;
  volatile: number;
  quantize: number;
  attune: number;
  overdrive: number;
  resonate: number;
  ground: number;
  /** Seconds every execution of this row is pushed back (Stagger). */
  stagger: number;
  /** Extra chain jumps (Fork). */
  jumps: number;
  /** Range multiplier for flight, beams and chains (Conduct). */
  range: number;
  /** Projectile speed multiplier (Slug, Seeker). */
  speed: number;
  /** Homing strength on projectiles (Seeker). */
  seek: number;
  /** A second, smaller detonation on area effects (Bloom). */
  bloom: number;
  /** This row produces no Heat (Insulate). */
  insulate: number;
  /** This row's events resolve at depth 0 (Grounding Rod). */
  rootDepth: number;
  /** Copy the Action of the row above (Mirror). */
  mirror: number;
  /** Output ceiling, in multiples of base (Governor). 0 = no ceiling. */
  governor: number;
}

export function baseFireContext(): FireContext {
  return {
    output: 1,
    count: 1,
    echo: 0,
    pierce: 0,
    area: 1,
    rate: 1,
    duration: 1,
    bounce: 0,
    leech: 0,
    volatile: 0,
    quantize: 0,
    attune: 0,
    overdrive: 0,
    resonate: 0,
    ground: 0,
    stagger: 0,
    jumps: 0,
    range: 1,
    speed: 1,
    seek: 0,
    bloom: 0,
    insulate: 0,
    rootDepth: 0,
    mirror: 0,
    governor: 0,
  };
}

/**
 * Apply one modifier op. Within an op, `add` lands before `mul`; across ops and
 * across modifiers, application is strictly in declared order. This is the whole
 * reason ordering is a build axis — do not "normalise" it into a single formula.
 */
function applyOp(ctx: FireContext, field: FireField, add: number, mul: number): void {
  const current = ctx[field];
  ctx[field] = (current + add) * mul;
}

export function applyModifier(ctx: FireContext, def: ModifierDef): void {
  for (const op of def.ops) {
    applyOp(ctx, op.target, op.add ?? 0, op.mul ?? 1);
  }
}

/** Resolve an ordered modifier list into a fire context. */
export function resolveChain(modifierIds: readonly (string | null)[]): FireContext {
  return resolveRow(modifierIds).ctx;
}

/**
 * Resolve a row into its fire context *and* its execution schedule.
 *
 * The schedule has to be built during the walk rather than from a final Echo
 * count, because §5.5 says Echo "repeats everything before it" and the old
 * version did not: `echo, split, amplify` and `split, amplify, echo` produced
 * byte-identical results (5.86 output either way). The strongest modifier in the
 * game had no ordering decision in it at all.
 *
 * Now an Echo snapshots the output *at its own position*. Put it last and the
 * copies inherit every multiplier before it; put it first and they repeat a bare
 * Action while the modifiers after it pump only the original. Same card, two
 * genuinely different rows — which is the whole point of §5.5.
 *
 * Only `output` is snapshotted. Count, area, pierce and the rest come from the
 * finished chain, because those describe the *shape* of the Action and a copy
 * that was a different shape from its original would be unreadable on screen.
 */
export function resolveRow(modifierIds: readonly (string | null)[]): {
  ctx: FireContext;
  executions: Execution[];
} {
  const ctx = baseFireContext();
  // Absolute output values, resolved to multipliers at the end.
  let schedule: { delay: number; output: number }[] = [{ delay: 0, output: 1 }];
  let live = true;

  for (const id of modifierIds) {
    if (!id) continue;
    const def = MODIFIER_BY_ID.get(id);
    if (!def) throw new Error(`Unknown modifier "${id}" in chain`);
    for (const op of def.ops) {
      if (op.target === 'echo') {
        const levels = Math.max(0, Math.floor((op.add ?? 0) * (op.mul ?? 1)));
        for (let i = 0; i < levels; i++) {
          if (schedule.length * 2 > SAFETY.maxFireExecutions) {
            live = false;
            break;
          }
          schedule = schedule.concat(
            schedule.map((e) => ({
              delay: e.delay + ECHO_DELAY,
              // The snapshot: what the row's output is *here*, not at the end.
              output: ctx.output * ECHO_FALLOFF,
            })),
          );
        }
        ctx.echo += levels;
        continue;
      }
      if (op.target === 'stagger') {
        // Not a copy — a shift. Everything this row does lands late.
        const by = (op.add ?? 0) * (op.mul ?? 1);
        for (const e of schedule) e.delay += by;
        ctx.stagger += by;
        continue;
      }
      applyOp(ctx, op.target, op.add ?? 0, op.mul ?? 1);
    }
  }
  void live;

  // The primary execution always carries the finished output; the copies carry
  // whatever the row was worth where they were made.
  const final = ctx.output === 0 ? 1 : ctx.output;
  const executions: Execution[] = schedule.map((e, i) => ({
    delay: e.delay,
    outputMul: i === 0 ? 1 : e.output / final,
  }));
  return { ctx, executions };
}

export interface Execution {
  /** Seconds after the trigger fires. */
  delay: number;
  /** Multiplier applied on top of the chain's output. */
  outputMul: number;
}

/**
 * Expand Echo into a concrete execution schedule.
 *
 * DESIGN CALL (see DECISIONS.md #2): each Echo level repeats *everything before
 * it*, doubling the schedule — so N Echoes yield 2^N executions with geometric
 * falloff, while costing 1.8^N Cycles. That superlinearity is what makes Echo
 * "deliberately the strongest modifier in the game" and the intended discovery
 * path to exponential output (§5.5). Awaiting design sign-off.
 */
export function expandExecutions(echo: number): Execution[] {
  let schedule: Execution[] = [{ delay: 0, outputMul: 1 }];
  const levels = Math.max(0, Math.floor(echo));
  for (let i = 0; i < levels; i++) {
    if (schedule.length * 2 > SAFETY.maxFireExecutions) break;
    schedule = schedule.concat(
      schedule.map((e) => ({
        delay: e.delay + ECHO_DELAY,
        outputMul: e.outputMul * ECHO_FALLOFF,
      })),
    );
  }
  return schedule;
}

/** Where a node sits in a Program: the Trigger, the Action, or a modifier index. */
export type NodeSlot = 'trigger' | 'action' | number;

export type MoveResult = 'ok' | 'empty' | 'wrong-slot' | 'over-capacity';

/**
 * Which fire-context fields each Action primitive actually reads.
 *
 * A modifier that writes a field its Action ignores is a silent no-op — Ricochet
 * on an Orbital, Pierce on a Nova. The grammar deliberately lets you build those
 * (pillar 1: combinations stay legal), but the editor has to *say* so, or the
 * player is left guessing which of their picks are doing nothing.
 */
const PRIMITIVE_FIELDS: Record<string, readonly FireField[]> = {
  projectile: ['output', 'count', 'echo', 'pierce', 'bounce', 'volatile', 'leech', 'range', 'speed', 'seek'],
  burst: ['output', 'count', 'echo', 'area', 'leech', 'bloom'],
  chain: ['output', 'count', 'echo', 'leech', 'jumps', 'range'],
  // Volatile now lands on everything with a life, which is what its card has
  // always said ("effects detonate at the end of their life"). It was
  // implemented for projectiles alone: dead on 14 of 17 Actions, including the
  // three — Field, Mine, Orbital — that most obviously *have* an end of life.
  zone: ['output', 'count', 'echo', 'area', 'duration', 'leech', 'volatile', 'bloom'],
  vortex: ['output', 'count', 'echo', 'area', 'duration', 'leech', 'volatile'],
  mine: ['output', 'count', 'echo', 'area', 'duration', 'leech', 'volatile', 'bloom'],
  delayed: ['output', 'count', 'echo', 'area', 'leech', 'volatile', 'bloom'],
  beam: ['output', 'count', 'echo', 'area', 'leech', 'range'],
  orbital: ['output', 'count', 'echo', 'area', 'duration', 'leech', 'volatile'],
  buff: ['count', 'echo', 'duration'],
  knockback: ['output', 'count', 'echo', 'area', 'leech', 'bloom'],
  convert: ['count', 'echo'],
};

/** Fields that apply to the row itself rather than to the Action's shape. */
const UNIVERSAL_FIELDS: readonly FireField[] = [
  'rate',
  'quantize',
  'attune',
  'overdrive',
  'resonate',
  'ground',
  'stagger',
  'insulate',
  'rootDepth',
  'mirror',
  'governor',
];

/**
 * Does this modifier do anything on a row ending in this Action? Returns the
 * fields it writes that the Action ignores.
 */
export function inertFields(modifierId: string, actionId: string | null): FireField[] {
  const mod = MODIFIER_BY_ID.get(modifierId);
  if (!mod) return [];
  const action = actionId ? ACTION_BY_ID.get(actionId) : undefined;
  if (!action) return [];
  const supported = PRIMITIVE_FIELDS[action.primitive] ?? [];
  const dead: FireField[] = [];
  for (const op of mod.ops) {
    if (UNIVERSAL_FIELDS.includes(op.target)) continue;
    if (!supported.includes(op.target) && !dead.includes(op.target)) dead.push(op.target);
  }
  // A modifier counts as inert only if *nothing* it writes lands.
  const writes = mod.ops.filter((op) => !UNIVERSAL_FIELDS.includes(op.target)).length;
  return dead.length > 0 && dead.length === new Set(mod.ops.map((o) => o.target)).size && writes > 0
    ? dead
    : [];
}

/**
 * §5.5 — the three behaviour tags, and the glyphs that carry them.
 *
 * These are not a new rule. `PRIMITIVE_FIELDS` above has always decided which
 * modifiers do anything on which Actions, and `inertFields` has always been able
 * to say so — but only *after* you had built the row and gone looking. Put
 * Pierce on a Nova and the game let you, ran it, and told you nothing.
 *
 * So the same table now also produces a glyph you can read on the card, before
 * you take it. Derived rather than authored, because a second hand-written list
 * of "which modifiers work with which actions" would drift from the one the
 * simulation actually uses, and the version the player reads would be the wrong
 * one.
 *
 * Glyphs rather than colour: §16.3 already spends hue on enemy threat class and
 * the editor already spends colour on node *kind*. A fourth colour meaning would
 * collide with both, and a glyph survives the draft card, the chip and the HUD
 * strip identically.
 */
export type Tag = 'travels' | 'area' | 'lingers';

/**
 * Words, not symbols — and *nouns*, not verbs.
 *
 * This shipped as ▸ ◍ ⧗, which were terrible: an hourglass at eleven pixels
 * reads as a loading spinner, and every one of them is a thing you have to be
 * taught. Then it shipped as "travels / area / lingers", which were still
 * wrong for a subtler reason: two of them were verbs describing the card, so
 * they read as flavour rather than as a category. "lingers" in particular says
 * nothing about *what* lingers or why you'd care.
 *
 * A tag names the property the Modifiers key off. So: what does this thing
 * have — flight, area, or duration. The word is the property; the colour is the
 * grouping; the tooltip says which Modifiers it unlocks.
 */
export const TAG_GLYPH: Record<Tag, string> = {
  travels: 'flight',
  area: 'area',
  lingers: 'duration',
};

export const TAG_LABEL: Record<Tag, string> = {
  travels: 'flight — it crosses ground, so Pierce and Ricochet work',
  area: 'area — it covers ground, so Enlarge works',
  lingers: 'duration — it stays, so Sustain works',
};

/** Which fire-context field marks each tag. */
const TAG_FIELDS: Record<Tag, readonly FireField[]> = {
  travels: ['pierce', 'bounce'],
  area: ['area'],
  lingers: ['duration'],
};

/** What an Action *is*, in the only terms that change what modifiers do to it. */
export function tagsOf(actionId: string | null): Tag[] {
  const action = actionId ? ACTION_BY_ID.get(actionId) : undefined;
  if (!action) return [];
  const fields = PRIMITIVE_FIELDS[action.primitive] ?? [];
  return (Object.keys(TAG_FIELDS) as Tag[]).filter((tag) =>
    TAG_FIELDS[tag].some((f) => fields.includes(f)),
  );
}

/** Which tag a modifier needs to do anything, or null if it is universal. */
export function tagRequiredBy(modifierId: string): Tag | null {
  const mod = MODIFIER_BY_ID.get(modifierId);
  if (!mod) return null;
  const targets = mod.ops.map((o) => o.target).filter((t) => !UNIVERSAL_FIELDS.includes(t));
  if (targets.length === 0) return null;
  // Only a modifier whose *entire* effect rides one tag is worth marking. Split
  // writes `count`, which every Action reads; marking it would be noise.
  for (const tag of Object.keys(TAG_FIELDS) as Tag[]) {
    if (targets.every((t) => TAG_FIELDS[tag].includes(t))) return tag;
  }
  return null;
}

/** Slots are typed — this is what stops a Modifier landing in the Action slot. */
export function slotAccepts(slot: NodeSlot, nodeId: string): boolean {
  if (slot === 'trigger') return TRIGGER_BY_ID.has(nodeId);
  if (slot === 'action') return ACTION_BY_ID.has(nodeId);
  return MODIFIER_BY_ID.has(nodeId);
}

export interface Program {
  id: number;
  triggerId: string | null;
  /** Fixed-length slot array; null = empty slot. */
  modifierIds: (string | null)[];
  actionId: string | null;
  /** Runtime attribution for the editor readout (§19.6). */
  fireCount: number;
  eventCount: number;
  /** Events attributed to this row during the current tick. */
  tickEvents: number;
  /** Smoothed events/sec for this row — its share of total EPS. */
  recentEvents: number;
}

export function emptyProgram(id: number): Program {
  return {
    id,
    triggerId: null,
    modifierIds: new Array<string | null>(LOADBEARING.modifierSlotsPerProgram).fill(null),
    actionId: null,
    fireCount: 0,
    eventCount: 0,
    tickEvents: 0,
    recentEvents: 0,
  };
}

export interface CompiledProgram {
  /** A Program needs a Trigger and an Action to be live (§5.1). */
  live: boolean;
  ctx: FireContext;
  /** Cycles charged when this Program's trigger fires. */
  cycleCost: number;
  /** Cycles reserved while live (§6.1 static load). */
  staticCost: number;
  /** For self-scheduled triggers (Clock), the effective interval in seconds. */
  interval: number;
  executions: readonly Execution[];
}

/**
 * Cost model (GDD §5.3–5.5, §6.1):
 *   cost = trigger.cycleCost + action.cycleCost * product(modifier cycleMults)
 *
 * The modifier multiplier is where copies are priced — a Split that triples the
 * bolts is paid for by its x2.0, not by multiplying cost per bolt. This is the
 * lever the design doc says to pull instead of nerfing behaviour (§23.1).
 */
export function compileProgram(p: Program): CompiledProgram {
  const trig = p.triggerId ? TRIGGER_BY_ID.get(p.triggerId) : undefined;
  const act = p.actionId ? ACTION_BY_ID.get(p.actionId) : undefined;
  const { ctx, executions } = resolveRow(p.modifierIds);

  let mult = 1;
  for (const id of p.modifierIds) {
    if (!id) continue;
    mult *= MODIFIER_BY_ID.get(id)?.cycleMult ?? 1;
  }

  const live = Boolean(trig && act);
  const cycleCost = live ? trig!.cycleCost + act!.cycleCost * mult : 0;
  // §5.3 — a rare Trigger pays a bigger payload per fire. Folded into output at
  // compile time so the editor's damage figure tells the truth.
  if (live && trig!.payload !== undefined) ctx.output *= trig!.payload;
  const interval = trig?.interval !== undefined ? trig.interval / Math.max(0.05, ctx.rate) : 0;

  return {
    live,
    ctx,
    cycleCost,
    staticCost: cycleCost,
    interval,
    executions,
  };
}

export class Engine {
  programs: Program[] = [];
  compiled: CompiledProgram[] = [];
  /** Clock accumulators, parallel to `programs`. */
  clocks: number[] = [];
  /** World time each Program last fired, for per-Action cooldowns. */
  lastFired: number[] = [];
  /** §5.7 — permanent global output bonus from scrapping, additive. */
  scrapStacks = 0;
  /** §9 — Kernel multiplier from Recompile. Not earned until M3; always 1 in M1. */
  kernel = 1;
  slots: number;

  constructor(slots: number = LOADBEARING.programSlotsStart) {
    this.slots = slots;
    for (let i = 0; i < slots; i++) this.programs.push(emptyProgram(i));
    this.recompile();
  }

  /** Recompute compiled state. Call after any structural change. */
  recompile(): void {
    this.compiled = this.programs.map(compileProgram);

    // §5.6 Ground — "the Program above it costs -30% Cycles". This is the only
    // node whose effect reaches outside its own row, so it has to be applied
    // after every row has compiled, and it is why row order is a build axis.
    for (let i = 0; i < this.compiled.length; i++) {
      const grounding = this.compiled[i]!;
      if (grounding.ctx.ground <= 0 || i === 0) continue;
      const above = this.compiled[i - 1]!;
      if (!above.live) continue;
      const discount = 1 - 0.3 * Math.min(2, grounding.ctx.ground);
      above.cycleCost *= discount;
      above.staticCost *= discount;
    }

    while (this.clocks.length < this.programs.length) this.clocks.push(0);
    this.clocks.length = this.programs.length;
    while (this.lastFired.length < this.programs.length) this.lastFired.push(-Infinity);
    this.lastFired.length = this.programs.length;
  }

  get staticLoad(): number {
    let total = 0;
    for (const c of this.compiled) if (c.live) total += c.staticCost;
    return total;
  }

  /** §5.7 — scrapping grants +4% permanent global output, stacking additively. */
  get globalOutput(): number {
    return (1 + this.scrapStacks * TUNABLE.scrapOutputBonus) * this.kernel;
  }

  addProgramSlot(): boolean {
    if (this.programs.length >= LOADBEARING.programSlotsMax) return false;
    this.programs.push(emptyProgram(this.programs.length));
    this.slots = this.programs.length;
    this.recompile();
    return true;
  }

  /** Move a Program up or down — program order is a build axis (§5.6). */
  moveProgram(from: number, to: number): void {
    if (from === to) return;
    if (from < 0 || from >= this.programs.length) return;
    if (to < 0 || to >= this.programs.length) return;
    const [p] = this.programs.splice(from, 1);
    this.programs.splice(to, 0, p!);
    const [c] = this.clocks.splice(from, 1);
    this.clocks.splice(to, 0, c ?? 0);
    this.recompile();
  }

  /**
   * Auto-slot a drafted node into the first compatible empty slot (§8.3).
   * Returns the program index it landed in, or null if there was no room.
   */
  /**
   * The lowest row where `fits`, preferring one where `prefer` also holds.
   * Deterministic in both passes: index order, never "nearest" or "newest".
   */
  private firstSlot(
    fits: (p: Program) => boolean,
    prefer: (p: Program) => boolean,
  ): number {
    const paired = this.programs.findIndex((p) => fits(p) && prefer(p));
    return paired >= 0 ? paired : this.programs.findIndex(fits);
  }

  autoSlot(nodeId: string): number | null {
    // A Trigger or an Action completes a half-built row before it starts a new
    // one. Index order alone gets this right until a Program slot is drafted in
    // the middle of the sequence, after which it can leave a lone Trigger in row
    // 3 and a lone Action in row 4 — two dead rows where one live one was
    // available, and §17.3's promise that a drafted node fires within two
    // seconds quietly broken.
    if (TRIGGER_BY_ID.has(nodeId)) {
      const i = this.firstSlot((p) => p.triggerId === null, (p) => p.actionId !== null);
      if (i < 0) return null;
      this.programs[i]!.triggerId = nodeId;
      this.recompile();
      return i;
    }
    if (ACTION_BY_ID.has(nodeId)) {
      const i = this.firstSlot((p) => p.actionId === null, (p) => p.triggerId !== null);
      if (i < 0) return null;
      this.programs[i]!.actionId = nodeId;
      this.recompile();
      return i;
    }
    if (MODIFIER_BY_ID.has(nodeId)) {
      // Prefer a live Program — a modifier on a dead row does nothing visible,
      // and §17.3 requires a drafted node to visibly fire within 2s.
      const order = this.programs
        .map((_, i) => i)
        .sort((a, b) => {
          const la = this.compiled[a]?.live ? 0 : 1;
          const lb = this.compiled[b]?.live ? 0 : 1;
          return la - lb || a - b;
        });
      for (const i of order) {
        const slot = this.programs[i]!.modifierIds.findIndex((m) => m === null);
        if (slot >= 0) {
          this.programs[i]!.modifierIds[slot] = nodeId;
          this.recompile();
          return i;
        }
      }
      return null;
    }
    return null;
  }

  /**
   * Swap two modifier slots within a Program. This is the interaction that
   * teaches §5.5 — reordering is free, unlimited, and changes the numbers.
   * Empty slots participate, so a modifier can be walked along the chain.
   */
  swapModifiers(programIndex: number, a: number, b: number): boolean {
    const p = this.programs[programIndex];
    if (!p) return false;
    if (a < 0 || b < 0 || a >= p.modifierIds.length || b >= p.modifierIds.length) return false;
    const tmp = p.modifierIds[a] ?? null;
    p.modifierIds[a] = p.modifierIds[b] ?? null;
    p.modifierIds[b] = tmp;
    this.recompile();
    return true;
  }

  /** A node's home in the Engine: which row, and which slot in that row. */
  read(programIndex: number, slot: NodeSlot): string | null {
    const p = this.programs[programIndex];
    if (!p) return null;
    if (slot === 'trigger') return p.triggerId;
    if (slot === 'action') return p.actionId;
    return p.modifierIds[slot] ?? null;
  }

  private write(programIndex: number, slot: NodeSlot, value: string | null): void {
    const p = this.programs[programIndex];
    if (!p) return;
    if (slot === 'trigger') p.triggerId = value;
    else if (slot === 'action') p.actionId = value;
    else p.modifierIds[slot] = value;
  }

  /**
   * Move a node between any two slots, in the same Program or across Programs,
   * swapping if the destination is occupied.
   *
   * Slots are typed — a Modifier cannot live in the Action slot — and the move is
   * refused if it would push static load past capacity (§6.1: the editor blocks
   * it). Returns why it failed so the editor can say so rather than silently
   * dropping the node.
   */
  moveNode(
    fromProgram: number,
    fromSlot: NodeSlot,
    toProgram: number,
    toSlot: NodeSlot,
    capacity = Infinity,
  ): MoveResult {
    if (fromProgram === toProgram && fromSlot === toSlot) return 'ok';

    const moving = this.read(fromProgram, fromSlot);
    if (!moving) return 'empty';
    const displaced = this.read(toProgram, toSlot);

    if (!slotAccepts(toSlot, moving)) return 'wrong-slot';
    if (displaced && !slotAccepts(fromSlot, displaced)) return 'wrong-slot';

    this.write(toProgram, toSlot, moving);
    this.write(fromProgram, fromSlot, displaced);
    this.recompile();

    if (this.staticLoad > capacity) {
      // Roll back — an Engine that reserves more than capacity cannot run.
      this.write(fromProgram, fromSlot, moving);
      this.write(toProgram, toSlot, displaced);
      this.recompile();
      return 'over-capacity';
    }
    return 'ok';
  }

  /** §5.7 — Scrap. Returns the Cycles refunded (informational; static load drops). */
  scrapNode(programIndex: number, slot: 'trigger' | 'action' | number): number {
    const p = this.programs[programIndex];
    if (!p) return 0;
    const before = this.compiled[programIndex]?.staticCost ?? 0;
    if (slot === 'trigger') p.triggerId = null;
    else if (slot === 'action') p.actionId = null;
    else if (p.modifierIds[slot] !== undefined) p.modifierIds[slot] = null;
    else return 0;
    this.scrapStacks++;
    this.recompile();
    const after = this.compiled[programIndex]?.staticCost ?? 0;
    return Math.max(0, before - after);
  }

  /** Scrap a whole Program row. Counts as one scrap stack per node removed. */
  scrapProgram(programIndex: number): number {
    const p = this.programs[programIndex];
    if (!p) return 0;
    const before = this.compiled[programIndex]?.staticCost ?? 0;
    let nodes = 0;
    if (p.triggerId) nodes++;
    if (p.actionId) nodes++;
    for (const m of p.modifierIds) if (m) nodes++;
    if (nodes === 0) return 0;
    p.triggerId = null;
    p.actionId = null;
    p.modifierIds.fill(null);
    this.scrapStacks += nodes;
    this.recompile();
    return before - (this.compiled[programIndex]?.staticCost ?? 0);
  }
}
