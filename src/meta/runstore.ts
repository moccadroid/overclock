/**
 * The last few runs, kept automatically.
 *
 * Recording a run costs a few kilobytes and asking somebody to press SAVE RUN
 * costs them remembering to. The interesting run is always the one you did not
 * save — the one where something went wrong and you closed the tab annoyed.
 *
 * So every finished run is kept, and the oldest falls off the end. Five is
 * enough to compare a session against itself and small enough that the whole
 * window is a couple of hundred kilobytes at worst.
 *
 * Its own storage key, for the same reason `cellstore` has one: §15.1's guard
 * scans `LibraryData` for numbers that could become multipliers, and a recording
 * is nothing but numbers. These are evidence, not progression.
 */
import { RECORDING_VERSION, type Recording } from '../sim/record';

const STORAGE_KEY = 'overclock.runs.v1';

/**
 * The run currently being played, stashed every few seconds.
 *
 * Its own slot rather than an entry in the window, because it is overwritten
 * constantly and must not push finished runs out.
 *
 * This exists because of a crash. A twenty-minute run reached level 22, froze
 * the tab, and every byte of it was gone — the recorder only persisted at the
 * end, which meant it was reliable for exactly the runs nobody needs and useless
 * for the one kind that matters. A recording that does not survive the crash it
 * is describing is not evidence.
 */
const PARTIAL_KEY = 'overclock.run.partial.v1';

/** How many runs the window holds. */
export const KEEP = 5;

/** How often a run in progress is written out, in seconds of play. */
export const STASH_EVERY = 15;

/**
 * Runs whose format this build can still replay.
 *
 * A recording from an older format is not repaired and not silently kept: the
 * tunables it was made against are gone, so replaying it would produce a
 * confident, detailed description of a run that never happened. That is worse
 * than having nothing.
 */
export function loadRuns(): Recording[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (r): r is Recording =>
        Boolean(r) && typeof r === 'object' && (r as Recording).version === RECORDING_VERSION,
    );
  } catch {
    return [];
  }
}

/**
 * Add a run to the window. Newest first.
 *
 * Drops the oldest until it fits, and then keeps dropping if storage refuses it
 * — a quota error must cost you the oldest recording, never the ability to
 * finish a run.
 */
export function keepRun(recording: Recording): Recording[] {
  let runs = [recording, ...loadRuns()].slice(0, KEEP);
  while (runs.length > 0) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(runs));
      return runs;
    } catch {
      runs = runs.slice(0, runs.length - 1);
    }
  }
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage is unavailable entirely. The run still happened.
  }
  return [];
}

/** Overwrite the in-progress slot. Cheap enough to do every few seconds. */
export function stashPartial(recording: Recording): void {
  try {
    localStorage.setItem(PARTIAL_KEY, JSON.stringify(recording));
  } catch {
    // Out of room. The finished-run window is worth more than this slot, so
    // this one loses quietly rather than evicting anything.
  }
}

export function clearPartial(): void {
  try {
    localStorage.removeItem(PARTIAL_KEY);
  } catch {
    // Nothing to do.
  }
}

/**
 * Fold a crashed run into the window. Called once at boot.
 *
 * A partial that is still here means the last session ended without the run
 * ending — a freeze, a crash, or a closed tab. It is promoted to a real entry
 * because that is precisely the recording somebody wants to look at, and the
 * slot is cleared so it is only ever promoted once.
 */
export function recoverPartial(): Recording | null {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(PARTIAL_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  clearPartial();
  try {
    const parsed = JSON.parse(raw) as Recording;
    if (parsed?.version !== RECORDING_VERSION || parsed.ticks <= 0) return null;
    keepRun(parsed);
    return parsed;
  } catch {
    return null;
  }
}

export function clearRuns(): void {
  clearPartial();
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to do and nothing that matters.
  }
}

/** One line each, for a listing. */
export function describeRun(r: Recording): string {
  const t = r.summary.time;
  const clock = `${Math.floor(t / 60)}:${Math.floor(t % 60)
    .toString()
    .padStart(2, '0')}`;
  return (
    `${r.config.seed} · ${r.config.axiomId} · ${clock} · ` +
    `${r.summary.score.toLocaleString()} pts · lv${r.summary.level} · ` +
    `${r.summary.kills} kills · depth ${r.summary.depth}`
  );
}
