/**
 * Run recording and replay. GDD §14, and the tool §23 has been missing.
 *
 * A run in this game is *already* a pure function. The sim never reads the
 * clock, storage, or anything outside itself; the PRNG is seeded; the timestep
 * is fixed. That constraint has been enforced since M1 and this file is what it
 * was for — because it means a whole run is fully described by two things:
 *
 *   1. the `RunConfig` it started from, and
 *   2. every decision the player made, in order.
 *
 * Not the world. Not a video. A few kilobytes of choices, from which the entire
 * run can be reconstructed frame for frame.
 *
 * ---
 *
 * **Decisions, not just inputs.** Movement is only half of it: drafting a card,
 * spending a Reroll, dragging a node and choosing what to burn in a Recompile
 * all change the world from outside `advance()`. So a recording is a *command
 * log* — anything that mutates the world, stamped with the tick it happened on.
 * Replay applies the commands for a tick, then advances.
 *
 * Card *contents* are never recorded, only the index chosen. `rollDraft` is
 * deterministic given the world, so replay re-rolls the identical offer. This is
 * what keeps recordings small, and it is also a continuous test of that
 * determinism: if the offer ever stopped being reproducible, replay would
 * silently diverge.
 *
 * **Which is why there are checkpoints.** Every second the recorder stores
 * `hashWorld`. Replay compares. That turns the whole scheme from "trust me" into
 * something that fails loudly and immediately — including when a *new* kind of
 * world mutation is added and nobody remembers to record it. A missing command
 * shows up as a hash mismatch at the exact second it happened, rather than as a
 * replay that is quietly wrong.
 */
import { NO_INPUT, World, type InputState, type RunConfig } from './world';
import { SIM_DT } from './tunables';
import { hashWorld } from './hash';
import { applyDraft, purgeCard, rollDraft, type DraftCard } from './draft';
import type { NodeSlot } from './engine';

/**
 * Bumped whenever the format or anything a replay depends on changes.
 *
 * 3: the sim stopped calling Math.sin/cos/pow/atan2 and started using the
 * portable ones in num.ts. Every number in the game moved in its last bits, so
 * every v2 recording now describes a run this build cannot reproduce.
 */
export const RECORDING_VERSION = 3;

/**
 * Everything that changes the world other than time passing.
 *
 * Deliberately a closed union rather than a callback: a command has to be
 * serialisable and re-appliable, and the moment one of them carries a function
 * or a world reference the format stops being a recording and becomes a memory
 * dump.
 */
export type Command =
  | { k: 'draft'; i: number }
  | { k: 'reroll' }
  | { k: 'purge'; i: number }
  | { k: 'recompile'; rows: number[] }
  | { k: 'move'; fp: number; fs: NodeSlot; tp: number; ts: NodeSlot }
  /**
   * Reordering whole rows. Easy to miss and impossible to ignore: a Program
   * carries its Clock accumulator with it, so moving a row changes *when* it
   * fires. It was the one editor action with no command, and it silently broke
   * the replay of a nine-minute run at 5:27.
   */
  | { k: 'moveRow'; from: number; to: number }
  | { k: 'swap'; p: number; a: number; b: number }
  | { k: 'scrapNode'; p: number; s: NodeSlot }
  | { k: 'scrapRow'; p: number };

export interface Recording {
  version: number;
  /** Wall-clock stamp, for sorting a pile of them. Never read by the sim. */
  startedAt: number;
  config: {
    seed: string;
    axiomId: string;
    availableNodes?: string[];
    knownDiscoveries?: string[];
    meltdownAt?: number;
  };
  /** Run-length encoded inputs: [runLength, moveX, moveY, flags]. */
  inputs: number[][];
  commands: { t: number; c: Command }[];
  /** [tick, hash] every CHECKPOINT_TICKS. */
  checks: [number, string][];
  ticks: number;
  /** Denormalised so a listing does not have to replay to show anything. */
  summary: { score: number; depth: number; time: number; level: number; kills: number };
}

const CHECKPOINT_TICKS = 60;

const DASH = 1;
const INTERACT = 2;

/**
 * Exactly what was handed to `advance`, never a rounded version of it.
 *
 * Rounding here was tempting and wrong: the recording would then describe an
 * input the run never received, and the replay would diverge from the thing it
 * claims to reproduce. If inputs should be quantised — and for compression they
 * should — that belongs at the source, so the *run* uses the quantised value
 * too. See `Input.consume`.
 */
function packed(i: InputState): [number, number, number] {
  return [i.moveX, i.moveY, (i.dash ? DASH : 0) | (i.interact ? INTERACT : 0)];
}

function unpacked(row: number[]): InputState {
  const flags = row[3] ?? 0;
  return {
    moveX: row[1] ?? 0,
    moveY: row[2] ?? 0,
    dash: (flags & DASH) !== 0,
    interact: (flags & INTERACT) !== 0,
  };
}

/**
 * Records a live run.
 *
 * Costs one array push per *change* of input rather than per tick, so a player
 * holding a direction for four seconds costs one entry. Everything here is
 * append-only and nothing is read back, so it cannot affect the run it watches.
 */
export class Recorder {
  private readonly inputs: number[][] = [];
  private readonly commands: { t: number; c: Command }[] = [];
  private readonly checks: [number, string][] = [];
  private tick = 0;
  private last: [number, number, number] | null = null;

  constructor(private readonly config: RunConfig) {}

  get length(): number {
    return this.tick;
  }

  /** Call once per simulated tick, *before* advancing. */
  step(world: World, input: InputState): void {
    if (this.tick % CHECKPOINT_TICKS === 0) this.checks.push([this.tick, hashWorld(world)]);
    const p = packed(input);
    const prev = this.last;
    if (prev && prev[0] === p[0] && prev[1] === p[1] && prev[2] === p[2]) {
      this.inputs[this.inputs.length - 1]![0]!++;
    } else {
      this.inputs.push([1, p[0], p[1], p[2]]);
      this.last = p;
    }
    this.tick++;
  }

  /**
   * Record a decision. Stamped with the *next* tick to run, because commands are
   * applied before `advance` in replay and that is when they happened live too —
   * a draft resolves while time is frozen.
   */
  command(c: Command): void {
    this.commands.push({ t: this.tick, c });
  }

  finish(world: World): Recording {
    const config: Recording['config'] = {
      seed: this.config.seed,
      axiomId: this.config.axiomId,
    };
    if (this.config.availableNodes) config.availableNodes = [...this.config.availableNodes];
    if (this.config.knownDiscoveries) {
      config.knownDiscoveries = [...this.config.knownDiscoveries];
    }
    if (this.config.meltdownAt !== undefined) config.meltdownAt = this.config.meltdownAt;

    return {
      version: RECORDING_VERSION,
      startedAt: 0,
      config,
      inputs: this.inputs,
      commands: this.commands,
      checks: this.checks,
      ticks: this.tick,
      summary: {
        score: Math.floor(world.score),
        depth: world.stats.maxDepth,
        time: Number(world.time.toFixed(2)),
        level: world.level,
        kills: world.stats.kills,
      },
    };
  }
}

export interface ReplayResult {
  world: World;
  /** Where the replay stopped agreeing with the recording, if it ever did. */
  divergedAt: number | null;
  ticks: number;
}

/** Expand the run-length encoding back into one entry per tick, lazily. */
function* inputStream(inputs: number[][]): Generator<InputState> {
  for (const row of inputs) {
    const state = unpacked(row);
    for (let i = 0; i < (row[0] ?? 0); i++) yield state;
  }
}

/**
 * Re-run a recording.
 *
 * `onTick` sees every tick, which is what an analysis pass hooks into — the
 * replay does not know or care whether anyone is measuring it.
 *
 * Stops at the first checkpoint mismatch by default. A divergence means the sim
 * changed under the recording (a tunable, a rule, a float order), and continuing
 * past it produces numbers that look real and are not.
 */
export interface ReplayHooks {
  /** After the tick's commands are applied, before it advances. */
  onTick?: (world: World, tick: number) => void;
  /**
   * The cards that were on the table, handed over as they are rolled.
   *
   * Knowing what somebody *refused* is most of the value of a recording, and the
   * obvious way to get it — re-roll the offer from a hook before the command
   * applies — is wrong in a way that took a bisect to find: `rollDraft` draws
   * from the run's Rng, so looking at the offer *consumes* it, and the next roll
   * returns a different card. The observer changed the run.
   *
   * So the offer is passed out from inside `apply`, where it was rolled once and
   * is about to be used. Watching is free because nothing extra happens.
   */
  onDraft?: (world: World, cards: readonly DraftCard[], chosen: number, tick: number) => void;
  /** Any other command, before it applies. Purely observational. */
  beforeCommand?: (world: World, command: Command, tick: number) => void;
}

export function replay(
  recording: Recording,
  hooks: ReplayHooks = {},
  options: { stopOnDiverge?: boolean } = {},
): ReplayResult {
  const stopOnDiverge = options.stopOnDiverge !== false;
  const config: RunConfig = {
    seed: recording.config.seed,
    axiomId: recording.config.axiomId,
  };
  if (recording.config.availableNodes) config.availableNodes = recording.config.availableNodes;
  if (recording.config.knownDiscoveries) {
    config.knownDiscoveries = new Set(recording.config.knownDiscoveries);
  }
  if (recording.config.meltdownAt !== undefined) config.meltdownAt = recording.config.meltdownAt;

  const world = new World(config);
  const checks = new Map(recording.checks);
  const byTick = new Map<number, Command[]>();
  for (const { t, c } of recording.commands) {
    const list = byTick.get(t);
    if (list) list.push(c);
    else byTick.set(t, [c]);
  }

  const stream = inputStream(recording.inputs);
  let divergedAt: number | null = null;
  let tick = 0;

  for (; tick < recording.ticks; tick++) {
    // Commands first, *then* the checkpoint. Live, a decision is resolved while
    // time is frozen and the recorder samples the world afterwards — so checking
    // the hash before applying them compares two different moments and reports a
    // divergence on the first draft of every run. Order is the whole contract
    // here; there is nothing else keeping the two paths honest.
    for (const c of byTick.get(tick) ?? []) {
      hooks.beforeCommand?.(world, c, tick);
      apply(world, c, tick, hooks);
    }

    const expected = checks.get(tick);
    if (expected !== undefined && hashWorld(world) !== expected) {
      // The *first* mismatch, not the most recent one. Once a replay diverges it
      // stays diverged, so overwriting this on every later checkpoint reported
      // the end of the run as the cause and hid where it actually went wrong.
      divergedAt ??= tick;
      if (stopOnDiverge) break;
    }
    hooks.onTick?.(world, tick);

    const next = stream.next();
    world.advance(next.done ? NO_INPUT : next.value, SIM_DT);
  }

  return { world, divergedAt, ticks: tick };
}

/**
 * Re-apply one decision.
 *
 * The draft cases re-roll rather than replaying stored cards, which is the whole
 * reason a recording is kilobytes instead of megabytes — and which makes every
 * replay an assertion that `rollDraft` is still a pure function of the world.
 */
function apply(world: World, c: Command, tick: number, hooks: ReplayHooks): void {
  switch (c.k) {
    case 'draft': {
      const offer = rollDraft(world);
      hooks.onDraft?.(world, offer.cards, c.i, tick);
      const card = offer.cards[c.i];
      if (card) applyDraft(world, card);
      return;
    }
    case 'reroll':
      // The discarded offer still has to be rolled.
      //
      // `rollDraft` draws from the run's Rng, so the *number of times it is
      // called* is part of the world's state. Live, a reroll means the offer you
      // rejected was rolled and then another one was; skipping the first here
      // would leave the PRNG one draw ahead of where it was, and every draft for
      // the rest of the run would be a different one. This is the exact class of
      // bug the checkpoint hashes exist to make loud.
      rollDraft(world);
      if (world.rerolls > 0) world.rerolls--;
      return;
    case 'purge': {
      const offer = rollDraft(world);
      const card = offer.cards[c.i];
      if (card) purgeCard(world, card);
      return;
    }
    case 'recompile':
      world.recompile(c.rows);
      return;
    // Editing the Engine by hand. Every one of these has to re-sync the budget,
    // because the editor does it — `afterChange` calls `syncBudget` after each
    // edit, and `applyDraft` calls it internally, so this was the only path that
    // changed the Engine without it. A drag at 3:13 of a real run was enough to
    // put the reserved Cycles a fraction out and diverge everything after it.
    case 'move':
      // The capacity limit is part of the rule, not part of the choice: a move
      // the player was refused must be refused on replay too.
      world.engine.moveNode(c.fp, c.fs, c.tp, c.ts, world.budget.capacity);
      world.syncBudget();
      return;
    case 'moveRow':
      world.engine.moveProgram(c.from, c.to);
      world.syncBudget();
      return;
    case 'swap':
      world.engine.swapModifiers(c.p, c.a, c.b);
      world.syncBudget();
      return;
    case 'scrapNode':
      world.engine.scrapNode(c.p, c.s);
      world.syncBudget();
      return;
    case 'scrapRow':
      world.engine.scrapProgram(c.p);
      world.syncBudget();
      return;
  }
}

/** The card a `draft` command chose, for analysis. Needs the pre-draft world. */
export function cardAt(world: World, index: number): DraftCard | null {
  return rollDraft(world).cards[index] ?? null;
}

