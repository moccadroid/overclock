/**
 * The arc: when the story changes, and into what.
 *
 * STORY-AND-TONE §7 is the map this file implements: six runs, five rooms, one
 * new door per active run, and a document ladder whose rungs are hard-gated —
 * the arc does not advance until the rung's file is held, however many shifts
 * that takes. Run count paces nothing; recoveries and doors pace everything.
 *
 * A rule is `{ when, does }` over a plain `Story` value; the whole arc is a
 * fold over pure functions and a test needs no renderer and no run. Nothing
 * here touches the simulation: the levers on a run are what `configure()`
 * emits — all of them story-blind `RunConfig` fields. Delete this directory
 * and the game plays exactly as it does today.
 */
import { ARENA_BY_ID } from '../content/index';
import type { RunConfig } from '../sim/world';
import { BEAT_BY_ID, sectionBlocks } from './script';
import { START, type Story } from './state';

/**
 * When rules are evaluated. Two, and both are real places in the existing flow.
 *
 * `run-start` is the moment the operator commits — BEGIN RUN pressed, run not
 * yet begun. The channel cuts in *there* rather than at the menu: an
 * interruption while you are browsing is a notification, and an interruption
 * at the point of commitment is somebody stopping you. The run waits.
 */
export type Moment = 'run-start' | 'run-end';

/**
 * What the game knows at that moment. Built fresh at each call site from
 * `Library` and `World`, never stored — so it cannot go stale.
 */
export interface Context {
  /** Completed runs, from the Library. Shift 1147 + this is the header number. */
  runsCompleted: number;
  /** Level ids opened this run — `world.openBiomes`. Empty outside a run. */
  levelsOpened: readonly string[];
  /** Document sections recovered from fragments this run. */
  recovered?: readonly { doc: string; section: number }[];
  ending?: string;
  peakEps?: number;
}

export interface Rule {
  id: string;
  at: Moment;
  when: (story: Story, context: Context) => boolean;
  does: (story: Story, context: Context) => Story;
  /** Default true. A rule that should recur says so. */
  once?: boolean;
}

// ---------------------------------------------------------------------------
// what a rule can do
// ---------------------------------------------------------------------------

export const hasFired = (story: Story, id: string): boolean => story.fired.includes(id);

/**
 * Has the operator actually *read* it — not merely had it queued. This is the
 * predicate every thread rule wants: `fired` means the rule ran, `delivered`
 * means it landed, and ordering a story by the first is ordering it by
 * bookkeeping. It is also what stops a veteran account collapsing a whole
 * thread into one pass.
 */
export const wasDelivered = (story: Story, id: string): boolean =>
  story.fired.includes(id) && !story.queue.includes(id);

/** Put a transmission on the channel. It arrives before the run does. */
export const queueTransmission = (story: Story, beatId: string): Story => ({
  ...story,
  queue: [...story.queue, beatId],
});

/** A document arrives a section at a time. The item file is never found whole. */
export function holdDocument(story: Story, documentId: string, section: number): Story {
  const have = story.held[documentId] ?? [];
  if (have.includes(section)) return story;
  return { ...story, held: { ...story.held, [documentId]: [...have, section] } };
}

/** Does the operator hold this block of this document? */
export const isHeld = (story: Story, documentId: string, block: number): boolean =>
  (story.held[documentId] ?? []).includes(block);

/** Is the whole document on the terminal? (Block 0 stands for one-section docs.) */
const holds = (story: Story, documentId: string): boolean => isHeld(story, documentId, 0);

/** One flag, immutably. `flags` is where ideas live before they earn a field. */
export const flag = (story: Story, key: string, value: number): Story => ({
  ...story,
  flags: { ...story.flags, [key]: value },
});

const flagged = (story: Story, key: string): boolean => (story.flags[key] ?? 0) > 0;

// ---------------------------------------------------------------------------
// the ladder — STORY-AND-TONE §7.2
// ---------------------------------------------------------------------------

/**
 * Which rung the campaign is on, derived from what is held and what is open.
 * Derived rather than stored, so nothing can disagree with the documents.
 *
 *   1  orientation — until the first partition has been held
 *   2  the hunt — until the schedule and the selection criteria are held
 *   3  the archive — until the monitoring instruction is held
 *   4  the dead gate — until the exit interview and the closure are held
 *   5  the store — until the store is open and its two files are held
 *   6  the cell
 */
export function rungOf(story: Story): number {
  if (!flagged(story, 'tutorial.done')) return 1;
  if (!(holds(story, 'OC0044') && holds(story, 'OC0051'))) return 2;
  if (!holds(story, 'OC0052')) return 3;
  if (!(holds(story, 'OC0046X') && holds(story, 'OC0031'))) return 4;
  if (!(flagged(story, 'doors.store') && holds(story, 'OC0061') && holds(story, 'OC001D'))) return 5;
  return 6;
}

/**
 * The earliest rung at which each recoverable document is placed. Before its
 * rung a file is simply not on the floor — she creates each stage of the hunt,
 * and the game must not front-run her. The item-file fragments ride along with
 * whatever room they sit in.
 */
const DOC_RUNG: Record<string, number> = {
  OC0044: 2,
  OC0051: 2,
  B1: 2,
  OC0052: 3,
  OC0046X: 4,
  OC0031: 4,
  OC0061: 5,
  OC001D: 5,
};

/**
 * The documents the campaign can ever place, in ladder order.
 *
 * Exported because the file explorer lists what is *not* yet recovered — see
 * `shell/filetree.ts` — and that list has to be exactly this one. Deriving it
 * from "every beat carrying a sheet" instead pulls in the notices and the
 * onboarding, which are not recoverable documents: they arrive, or they were
 * always there. This is the ladder, and the ladder lives in the story layer.
 */
export const DOCUMENT_IDS: readonly string[] = Object.keys(DOC_RUNG).sort(
  (a, b) => (DOC_RUNG[a] ?? 0) - (DOC_RUNG[b] ?? 0),
);

/**
 * LEVELS §3.2b — how far the site has come apart, per rung. **0 to 1, and 1 is
 * the whole of the decomposition vocabulary.**
 *
 * This is the *only* thing that drives `dissolve`, `decay` and `shred`. The ruins
 * coming apart is something that happens to the site over six shifts, and it is
 * therefore a fact about *when* the player is there, never about which room they
 * are standing in.
 *
 * **Rooms must not author these dials, and the earlier attempt to let them is the
 * mistake this comment exists to prevent.** A per-room decomposition ladder makes
 * the deep rooms permanently rotted and the shallow ones permanently sound, which
 * destroys the only signal that matters: the Heap is *clean on shift one and gone
 * by shift six*, and it is the same Heap both times. If the Cell is always
 * terminal then terminal means "the Cell" rather than "the end", and the player
 * learns a map instead of a decline. Rooms distinguish themselves with the dials
 * that describe a *place* — churn tempo, amplitude, jitter, block sizes, `oil`,
 * `fray`, tint — and `content.test.ts` fails the build if a room authors any of
 * the three progression dials.
 *
 * Zero for the first two shifts, because the tutorial needs one honest picture of
 * normal to measure everything else against; the descent begins when the story
 * turns and reaches the full vocabulary on the last night.
 */
const SITE_DECAY: Record<number, number> = {
  1: 0,
  2: 0,
  3: 0.3,
  4: 0.55,
  5: 0.78,
  6: 1,
};

/**
 * STORY-AND-TONE §7.1 — the growing starter. The build is OC-001's and it
 * remembers; each run starts with more of it already assembled. Run 6 is the
 * gift: the whole thing, tuned, plus the capacity to run it. Fairness is not
 * the point of the final run.
 */
const GIFT: Record<number, { rows: { trigger: string; modifiers: string[]; action: string }[]; capacity: number }> = {
  1: { rows: [], capacity: 0 },
  2: { rows: [{ trigger: 'on_hit', modifiers: ['echo'], action: 'bolt' }], capacity: 10 },
  3: {
    rows: [
      { trigger: 'on_hit', modifiers: ['echo'], action: 'bolt' },
      { trigger: 'on_kill', modifiers: ['amplify'], action: 'nova' },
    ],
    capacity: 20,
  },
  4: {
    rows: [
      { trigger: 'on_hit', modifiers: ['echo'], action: 'bolt' },
      { trigger: 'on_kill', modifiers: ['amplify'], action: 'nova' },
    ],
    capacity: 25,
  },
  5: {
    rows: [
      { trigger: 'on_hit', modifiers: ['echo', 'ricochet'], action: 'bolt' },
      { trigger: 'on_kill', modifiers: ['amplify'], action: 'nova' },
      { trigger: 'on_wave', modifiers: ['enlarge'], action: 'field' },
    ],
    capacity: 40,
  },
  6: {
    rows: [
      { trigger: 'on_hit', modifiers: ['echo', 'ricochet', 'amplify'], action: 'bolt' },
      { trigger: 'on_kill', modifiers: ['split', 'amplify'], action: 'nova' },
      { trigger: 'on_wave', modifiers: ['enlarge', 'sustain'], action: 'field' },
    ],
    capacity: 80,
  },
};

/** Where the extraction terminal stands per rung — always the frontier. */
const EXTRACT_AT: Record<number, { x: number; y: number } | undefined> = {
  1: undefined,
  2: { x: 7700, y: 1800 },
  3: { x: 2000, y: 5050 },
  4: { x: 2000, y: 5050 },
  5: { x: 5750, y: 4750 },
  6: undefined,
};

// ---------------------------------------------------------------------------
// the arc
// ---------------------------------------------------------------------------

export const STORY: Rule[] = [
  /**
   * Fragments recovered in-run become held documents. First in the list on
   * purpose: rules below gate on `holds`, and at run-end they must see what
   * this run just recovered. A recovery is a *section*; `held` stores body
   * block indices, the terminal's unit, expanded here once so no surface can
   * disagree about what a section is.
   */
  {
    id: 'ingest',
    at: 'run-end',
    once: false,
    when: (_story, context) => (context.recovered?.length ?? 0) > 0,
    does: (story, context) =>
      (context.recovered ?? []).reduce((s, r) => {
        const beat = BEAT_BY_ID.get(r.doc);
        const blocks = beat ? sectionBlocks(beat, r.section) : [r.section];
        return blocks.reduce((held, block) => holdDocument(held, r.doc, block), s);
      }, story),
  },

  /** Doors stay open across runs. One flag per gated room. */
  {
    id: 'doors.archive',
    at: 'run-end',
    when: (_story, context) => context.levelsOpened.includes('archive'),
    does: (story) => flag(story, 'doors.archive', 1),
  },
  {
    id: 'doors.store',
    at: 'run-end',
    when: (_story, context) => context.levelsOpened.includes('store'),
    does: (story) => flag(story, 'doors.store', 1),
  },

  /** The failure streak, as bookkeeping. */
  {
    id: 'streak.bump',
    at: 'run-end',
    once: false,
    when: (_story, context) => context.ending === 'died-early',
    does: (story) => flag(story, 'wallStreak', (story.flags['wallStreak'] ?? 0) + 1),
  },
  {
    id: 'streak.reset',
    at: 'run-end',
    once: false,
    when: (_story, context) => context.ending !== undefined && context.ending !== 'died-early',
    does: (story) => flag(story, 'wallStreak', 0),
  },

  // ---- run 1 — orientation ----

  {
    id: 'B-welcome',
    at: 'run-start',
    when: () => true,
    does: (story) => queueTransmission(story, 'B-welcome'),
  },
  {
    id: 'tutorial.done',
    at: 'run-end',
    when: (_story, context) => context.levelsOpened.includes('sink'),
    does: (story) => flag(story, 'tutorial.done', 1),
  },
  /**
   * Its own rule, with the beat's own id, because `wasDelivered` reads the
   * `fired` list — a beat queued under another rule's id is a beat no thread
   * can ever see as read, and R1 waits on this one.
   */
  {
    id: 'B-onboard',
    at: 'run-end',
    when: (story) => flagged(story, 'tutorial.done'),
    does: (story) => queueTransmission(story, 'B-onboard'),
  },
  {
    id: 'B-lapse',
    at: 'run-end',
    when: (story, context) =>
      !flagged(story, 'tutorial.done') &&
      context.ending !== undefined &&
      wasDelivered(story, 'B-welcome') &&
      !context.levelsOpened.includes('sink'),
    does: (story) => queueTransmission(story, 'B-lapse'),
  },

  // ---- run 2 — first contact and the hunt ----

  {
    id: 'R1',
    at: 'run-start',
    when: (story) => wasDelivered(story, 'B-onboard'),
    does: (story) => queueTransmission(story, 'R1'),
  },
  {
    id: 'R-nag1',
    at: 'run-end',
    when: (story, context) =>
      wasDelivered(story, 'R1') && !holds(story, 'OC0044') && context.ending !== undefined,
    does: (story) => queueTransmission(story, 'R-nag1'),
  },
  {
    id: 'R-nag2',
    at: 'run-end',
    when: (story, context) =>
      wasDelivered(story, 'R-nag1') && !holds(story, 'OC0044') && context.ending !== undefined,
    does: (story) => queueTransmission(story, 'R-nag2'),
  },

  // ---- run 3 — the proof, the archive, the monitoring file ----

  {
    id: 'R2',
    at: 'run-start',
    when: (story) => wasDelivered(story, 'R1') && rungOf(story) >= 3,
    does: (story) => ({ ...queueTransmission(story, 'R2'), chapter: 'II' }),
  },
  {
    id: 'N1',
    at: 'run-end',
    when: (story) => wasDelivered(story, 'R2') && rungOf(story) >= 4,
    does: (story) => queueTransmission(story, 'N1'),
  },

  // ---- run 4 — clause 4.1, the deep bays, the dead gate ----

  {
    id: 'R3',
    at: 'run-start',
    when: (story) => wasDelivered(story, 'N1'),
    does: (story) => queueTransmission(story, 'R3'),
  },
  {
    id: 'N2',
    at: 'run-end',
    when: (story) => wasDelivered(story, 'R3') && rungOf(story) >= 5,
    does: (story) => ({ ...queueTransmission(story, 'N2'), chapter: 'III' }),
  },

  // ---- run 5 — the predecessor, the relay, the store ----

  {
    id: 'R4',
    at: 'run-start',
    when: (story) => wasDelivered(story, 'N2'),
    does: (story) => queueTransmission(story, 'R4'),
  },
  {
    id: 'N3',
    at: 'run-end',
    when: (story) => wasDelivered(story, 'R4') && rungOf(story) >= 6,
    does: (story) => ({ ...queueTransmission(story, 'N3'), chapter: 'IV' }),
  },

  // ---- run 6 — the gift, the deadline, the cell ----

  {
    id: 'R5',
    at: 'run-start',
    when: (story) => wasDelivered(story, 'N3'),
    does: (story) => queueTransmission(story, 'R5'),
  },
  {
    id: 'finale',
    at: 'run-end',
    when: (_story, context) => context.levelsOpened.includes('cell'),
    does: (story) => {
      // Placeholder delivery for the ending: the eleven words arrive on the
      // channel at the next terminal visit. The real §11 sequence — the live
      // lock lines, the deconstruction, the prompt, RESET — is its own build.
      let next = flag(story, 'campaign.done', 1);
      next = queueTransmission(next, 'E1');
      next = queueTransmission(next, 'E2');
      return { ...next, chapter: 'V' };
    },
  },

  // ---- reactive ----

  {
    id: 'R-wall',
    at: 'run-start',
    when: (story) => wasDelivered(story, 'R1') && (story.flags['wallStreak'] ?? 0) >= 3,
    does: (story) => queueTransmission(story, 'R-wall'),
  },
  {
    id: 'R-strong',
    at: 'run-end',
    when: (story, context) => wasDelivered(story, 'R2') && (context.peakEps ?? 0) >= 2000,
    does: (story) => queueTransmission(story, 'R-strong'),
  },
  {
    id: 'R-door',
    at: 'run-end',
    when: (story, context) =>
      wasDelivered(story, 'R1') && context.levelsOpened.includes('archive'),
    does: (story) => queueTransmission(story, 'R-door'),
  },
  {
    id: 'R-missed',
    at: 'run-end',
    when: (story, context) =>
      context.levelsOpened.includes('archive') &&
      !holds(story, 'OC0052') &&
      wasDelivered(story, 'R2'),
    does: (story) => queueTransmission(story, 'R-missed'),
  },
  {
    id: 'R-death',
    at: 'run-end',
    when: (story, context) =>
      wasDelivered(story, 'R1') &&
      context.ending === 'died-early' &&
      (story.flags['wallStreak'] ?? 0) === 0,
    does: (story) => queueTransmission(story, 'R-death'),
  },
  {
    id: 'R-quiet',
    at: 'run-start',
    when: (story, context) =>
      wasDelivered(story, 'R2') && story.queue.length === 0 && context.runsCompleted >= 4,
    does: (story) => queueTransmission(story, 'R-quiet'),
  },
];

// ---------------------------------------------------------------------------
// operations
// ---------------------------------------------------------------------------

/**
 * Fire every rule whose moment and condition match, in list order. The only
 * writer of `fired`. Rules see the state as left by earlier rules in the same
 * pass, which is what lets one depend on another having just fired.
 */
export function advance(story: Story, at: Moment, context: Context): Story {
  let next = story;
  for (const rule of STORY) {
    if (rule.at !== at) continue;
    if (rule.once !== false && next.fired.includes(rule.id)) continue;
    if (!rule.when(next, context)) continue;
    next = { ...rule.does(next, context), fired: [...next.fired, rule.id] };
  }
  return next;
}

/**
 * What this run looks like, given where the story is. The whole of the story's
 * influence over the simulation, as story-blind `RunConfig` fields, all driven
 * by the rung.
 */
export function configure(story: Story, base: RunConfig): RunConfig {
  const rung = rungOf(story);

  const ARENA: Record<number, string> = {
    1: 'heap',
    2: 'heap',
    3: 'heap_archive',
    4: 'heap_store',
    5: 'heap_store',
    6: 'heap_cell',
  };
  const arenaId = ARENA[rung]!;
  const arena = ARENA_BY_ID.get(arenaId);

  // Doors stay open. Which rooms start unlocked is the rung's geography.
  const openLevels: string[] = [];
  if (rung >= 2) openLevels.push('sink');
  if (rung >= 4 || (rung === 3 && flagged(story, 'doors.archive'))) openLevels.push('archive');
  if (rung >= 6) openLevels.push('store');

  // STORY-AND-TONE §7.2 — run 4 finds the store partition dead and the relay
  // locked; run 5 has the relay live and the partition still dead until it is
  // revived from inside.
  const deadGates =
    rung === 4 ? ['partition_3', 'relay_1'] : rung === 5 ? ['partition_3'] : undefined;

  // Placement: a file is on the floor from its rung onward, minus what is
  // already on the terminal. Stations stand for the whole of orientation,
  // read or not, and are withdrawn after it.
  const recoveredPois: string[] = [];
  for (const level of arena?.levels ?? []) {
    for (const spot of level.pois ?? []) {
      if (spot.kind === 'station') {
        const read = (story.flags[`station.${spot.doc}`] ?? 0) > 0;
        if (rung > 1 && (read || story.chapter !== 'I')) recoveredPois.push(spot.id);
        continue;
      }
      if (rung < (DOC_RUNG[spot.doc] ?? 2)) {
        recoveredPois.push(spot.id);
        continue;
      }
      const beat = BEAT_BY_ID.get(spot.doc);
      const blocks = beat ? sectionBlocks(beat, spot.section ?? 0) : [spot.section ?? 0];
      const recovered = blocks.length > 0 && blocks.every((b) => isHeld(story, spot.doc, b));
      if (recovered) recoveredPois.push(spot.id);
    }
  }

  const gift = GIFT[rung]!;
  const extractAt = EXTRACT_AT[rung];

  return {
    ...base,
    arenaId,
    ...(recoveredPois.length > 0 ? { recoveredPois } : {}),
    ...(openLevels.length > 0 ? { openLevels } : {}),
    ...(deadGates ? { deadGates } : {}),
    ...(rung === 1 ? { concludeOnOpen: 'sink', pressure: 0.55, meltdownAt: 480 } : {}),
    ...(rung > 1 && rung < 6 ? { meltdownAt: 600 } : {}),
    ...(rung === 6 ? { concludeOnOpen: 'cell', noExtract: true, meltdownAt: 1200 } : {}),
    // LEVELS §3.2b — the site comes apart across the campaign, not only across
    // its rooms. The Heap on the last night is not the Heap on the first, and
    // nothing in the fiction has to announce it: the operator walks the same
    // corridor and it is further gone. Zero on rung 1 so the tutorial room is
    // the game's one honest picture of normal.
    ...(SITE_DECAY[rung] ? { siteDecay: SITE_DECAY[rung] } : {}),
    ...(extractAt ? { extractAt } : {}),
    ...(gift.rows.length > 0 ? { bonusRows: gift.rows } : {}),
    ...(gift.capacity > 0 ? { bonusCapacity: gift.capacity } : {}),
  };
}

/** Acknowledge a transmission the operator has actually read to the end. */
export const delivered = (story: Story, beatId: string): Story => ({
  ...story,
  queue: story.queue.filter((id) => id !== beatId),
});

/** A station read, remembered. Read once is read forever — after orientation. */
export const stationRead = (story: Story, beatId: string): Story =>
  flag(story, `station.${beatId}`, 1);

// ---------------------------------------------------------------------------
// checkpoints — `?story=<name>`
// ---------------------------------------------------------------------------

/** A whole document, as the block list the terminal renders. */
const whole = (doc: string): [string, number[]] => {
  const beat = BEAT_BY_ID.get(doc);
  return [doc, beat ? beat.body.map((_, i) => i) : [0]];
};

const heldDocs = (...docs: string[]): Record<string, number[]> =>
  Object.fromEntries(docs.map(whole));

/**
 * Named story positions. Each is a complete `Story` literal, holds and all —
 * landing at "the dead gate run" is an assignment, not a replay.
 */
export const CHECKPOINTS: Record<string, Story> = {
  /** Before anything. The first BEGIN RUN shows the assignment notice. */
  fresh: START,
  /** Orientation beaten and both notices read. The next BEGIN RUN is R1. */
  tutored: {
    ...START,
    flags: { 'tutorial.done': 1 },
    fired: ['B-welcome', 'tutorial.done', 'B-onboard'],
  },
  /** R1 read; the hunt is live in the Sink. (Run 2.) */
  contact: {
    ...START,
    flags: { 'tutorial.done': 1 },
    fired: ['B-welcome', 'tutorial.done', 'B-onboard', 'R1'],
  },
  /** The schedule and the criteria held; R2 read. The archive is next. (Run 3.) */
  archive: {
    ...START,
    chapter: 'II',
    flags: { 'tutorial.done': 1 },
    held: heldDocs('OC0044', 'OC0051'),
    fired: ['B-welcome', 'tutorial.done', 'B-onboard', 'R1', 'R2'],
  },
  /** Monitoring held, N/1 and R3 read. The dead-gate run. (Run 4.) */
  deadgate: {
    ...START,
    chapter: 'II',
    flags: { 'tutorial.done': 1, 'doors.archive': 1 },
    held: heldDocs('OC0044', 'OC0051', 'OC0052'),
    fired: ['B-welcome', 'tutorial.done', 'B-onboard', 'R1', 'R2', 'doors.archive', 'R-door', 'N1', 'R3'],
  },
  /** The predecessor read, N/2 and R4 read. The relay run. (Run 5.) */
  store: {
    ...START,
    chapter: 'III',
    flags: { 'tutorial.done': 1, 'doors.archive': 1 },
    held: heldDocs('OC0044', 'OC0051', 'OC0052', 'OC0046X', 'OC0031'),
    fired: [
      'B-welcome', 'tutorial.done', 'B-onboard', 'R1', 'R2', 'doors.archive', 'R-door', 'N1',
      'R3', 'N2', 'R4',
    ],
  },
  /** Everything held, N/3 and R5 read. The last run. (Run 6.) */
  final: {
    ...START,
    chapter: 'IV',
    flags: { 'tutorial.done': 1, 'doors.archive': 1, 'doors.store': 1 },
    held: heldDocs('OC0044', 'OC0051', 'OC0052', 'OC0046X', 'OC0031', 'OC0061', 'OC001D', 'B1'),
    fired: [
      'B-welcome', 'tutorial.done', 'B-onboard', 'R1', 'R2', 'doors.archive', 'R-door', 'N1',
      'R3', 'N2', 'R4', 'doors.store', 'N3', 'R5',
    ],
  },
};
