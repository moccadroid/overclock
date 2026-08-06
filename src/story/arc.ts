/**
 * The arc: when the story changes, and into what.
 *
 * One list, in reading order. A shift with nothing to say has no entry — silence
 * is the default, and most shifts are silent.
 *
 * A rule is `{ when, does }`. The condition is code because a condition is code
 * — `src/sim/discoveries.ts` settled that argument for this codebase already,
 * and re-stating `&&` and `>=` as JSON would mean writing an interpreter for
 * operators the language already has. `does` returns a new `Story`, so the whole
 * arc is a fold over pure functions and a test needs no renderer and no run.
 *
 * Nothing here touches the simulation. The only lever on a run is
 * `configure()`, which sets `arenaId` — a field `RunConfig` already had. Delete
 * this directory and the game plays exactly as it does today.
 */
import type { RunConfig } from '../sim/world';
import type { Story } from './state';

/**
 * When rules are evaluated. Two, and both are real places in the existing flow.
 *
 * `run-start` is the moment the operator commits — BEGIN RUN pressed, run not
 * yet begun. §8's channel cuts in *there* rather than at the menu: an
 * interruption while you are browsing is a notification, and an interruption at
 * the point of commitment is somebody stopping you. The run waits.
 */
export type Moment = 'run-start' | 'run-end';

/**
 * What the game knows at that moment.
 *
 * Built fresh at each call site from `Library` and `World`, never stored — so it
 * cannot go stale, and nothing has to keep it in sync with anything.
 */
export interface Context {
  /** Completed runs, from the Library. Shift 1147 + this is the header number. */
  runsCompleted: number;
  /** Level ids opened this run — `world.openBiomes`. Empty outside a run. */
  levelsOpened: readonly string[];
  ending?: string;
  peakEps?: number;
}

export interface Rule {
  id: string;
  at: Moment;
  when: (story: Story, context: Context) => boolean;
  does: (story: Story) => Story;
  /** Default true. A rule that should recur says so. */
  once?: boolean;
}

// ---------------------------------------------------------------------------
// what a rule can do
// ---------------------------------------------------------------------------

export const hasFired = (story: Story, id: string): boolean => story.fired.includes(id);

/**
 * Has the operator actually *read* it — not merely had it queued.
 *
 * This is the predicate a rule wants when it continues a thread, and using
 * `hasFired` for that was a real design error rather than a slip.
 *
 * `advance()` lets rules see the state left by earlier rules in the same pass,
 * so `hasFired('R1')` is true a microsecond after R1 fires. R2 gates on R1, and
 * R2's other condition is `runsCompleted >= 2` — so an operator who already had
 * shifts on file when the arc was first added fired **both in a single pass**
 * and had two messages waiting before one episode. A whole thread could collapse
 * into one tick that way, which is the opposite of what a sequence is for.
 *
 * `fired` means the rule ran. `delivered` means it landed. Ordering a story by
 * the first is ordering it by bookkeeping.
 */
export const wasDelivered = (story: Story, id: string): boolean =>
  story.fired.includes(id) && !story.queue.includes(id);

/** §8 — put a transmission on the channel. It arrives before the run does. */
export const queueTransmission = (story: Story, beatId: string): Story => ({
  ...story,
  queue: [...story.queue, beatId],
});

/** §6.3 — a document arrives a section at a time. B1 is never found whole. */
export function holdDocument(story: Story, documentId: string, section: number): Story {
  const have = story.held[documentId] ?? [];
  if (have.includes(section)) return story;
  return { ...story, held: { ...story.held, [documentId]: [...have, section] } };
}

/** §6.2 — which arena the next run is built from. */
export const buildFrom = (story: Story, arenaId: string): Story => ({ ...story, arena: arenaId });

// ---------------------------------------------------------------------------
// the arc
// ---------------------------------------------------------------------------

export const STORY: Rule[] = [
  /**
   * §8 R1 — first contact. Before the first run has begun.
   *
   * `once` is the entire gate, and it has to be: the condition was
   * `runsCompleted === 0`, which looks equivalent and is not — a player who
   * reaches this at run 1 for any reason would meet a condition that can never
   * be true again. R1 would never fire, and because every later beat waits on
   * R1, the whole arc would be dead behind it.
   *
   * That is the failure mode every gate in this list has to be checked for: a
   * condition that can stop being satisfiable is a condition that can end the
   * story. Prefer `>=` over `===`, and prefer `once` over either.
   */
  {
    id: 'R1',
    at: 'run-start',
    when: () => true,
    does: (story) => queueTransmission(story, 'R1'),
  },

  // Shift 2 says nothing. There is no rule for it, which is the point.

  /**
   * §8 R2 — the proof. She points at a document, and it is a true one.
   *
   * Held until the third run so the silent one between them reads as a silent
   * shift rather than a gap waiting to be filled.
   */
  {
    id: 'R2',
    at: 'run-start',
    when: (story, context) => context.runsCompleted >= 2 && wasDelivered(story, 'R1'),
    does: (story) => ({ ...queueTransmission(story, 'R2'), chapter: 'II' }),
  },

  /**
   * §6.2 — the archive is in the arena this time.
   *
   * The player is told nothing. The run is set up from a different arena
   * definition, which has one more level in it and one more door.
   */
  {
    id: 'archive.available',
    at: 'run-start',
    when: (story, context) => context.runsCompleted >= 3 && wasDelivered(story, 'R2'),
    does: (story) => buildFrom(story, 'heap_archive'),
  },

  /**
   * §9 B2 — acquisition. Recovered by opening the door, which only an operator
   * can do. Held, not readable: the bars stay black at clearance 0.
   */
  {
    id: 'archive.entered',
    at: 'run-end',
    when: (_story, context) => context.levelsOpened.includes('archive'),
    does: (story) => ({ ...holdDocument(story, 'B2', 0), chapter: 'III' }),
  },
];

// ---------------------------------------------------------------------------
// operations
// ---------------------------------------------------------------------------

/**
 * Fire every rule whose moment and condition match, in list order.
 *
 * The only writer of `fired`. Rules see the state as left by earlier rules in
 * the same pass, which is what lets one depend on another having just fired.
 */
export function advance(story: Story, at: Moment, context: Context): Story {
  let next = story;
  for (const rule of STORY) {
    if (rule.at !== at) continue;
    if (rule.once !== false && next.fired.includes(rule.id)) continue;
    if (!rule.when(next, context)) continue;
    next = { ...rule.does(next), fired: [...next.fired, rule.id] };
  }
  return next;
}

/**
 * What this run looks like, given where the story is.
 *
 * The whole of the story's influence over the simulation, and it is one field
 * that `RunConfig` already had. Without a story, this is the identity function.
 */
export function configure(story: Story, base: RunConfig): RunConfig {
  return story.arena ? { ...base, arenaId: story.arena } : base;
}

/** Acknowledge a transmission the operator has actually read to the end. */
export const delivered = (story: Story, beatId: string): Story => ({
  ...story,
  queue: story.queue.filter((id) => id !== beatId),
});
