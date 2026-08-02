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
}

export function baseFireContext(): FireContext {
  return { output: 1, count: 1, echo: 0, pierce: 0, area: 1, rate: 1, duration: 1 };
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
  const ctx = baseFireContext();
  for (const id of modifierIds) {
    if (!id) continue;
    const def = MODIFIER_BY_ID.get(id);
    if (!def) throw new Error(`Unknown modifier "${id}" in chain`);
    applyModifier(ctx, def);
  }
  return ctx;
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
  const ctx = resolveChain(p.modifierIds);

  let mult = 1;
  for (const id of p.modifierIds) {
    if (!id) continue;
    mult *= MODIFIER_BY_ID.get(id)?.cycleMult ?? 1;
  }

  const live = Boolean(trig && act);
  const cycleCost = live ? trig!.cycleCost + act!.cycleCost * mult : 0;
  const interval = trig?.interval !== undefined ? trig.interval / Math.max(0.05, ctx.rate) : 0;

  return {
    live,
    ctx,
    cycleCost,
    staticCost: cycleCost,
    interval,
    executions: expandExecutions(ctx.echo),
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
  autoSlot(nodeId: string): number | null {
    if (TRIGGER_BY_ID.has(nodeId)) {
      const i = this.programs.findIndex((p) => p.triggerId === null);
      if (i < 0) return null;
      this.programs[i]!.triggerId = nodeId;
      this.recompile();
      return i;
    }
    if (ACTION_BY_ID.has(nodeId)) {
      const i = this.programs.findIndex((p) => p.actionId === null);
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
