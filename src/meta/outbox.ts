/**
 * The durable half of telemetry. Storage is the truth; the network is a hope.
 *
 * Browsers do not tell you when a session ends. `unload` is gone — Chrome
 * finished deprecating it in April 2026 — `beforeunload` does not fire for a
 * killed background tab and disables bfcache if you so much as listen for it,
 * and `pagehide` does not fire when a tab is merely switched away from. The best
 * available signal is `visibilitychange` to hidden, and combining it with
 * `pagehide` lands somewhere around 91% of sessions.
 *
 * Which leaves 9%, plus every crash, every OS kill, and — the one this codebase
 * has already been burned by — every freeze. runstore.ts says it plainly: a
 * recording that does not survive the crash it is describing is not evidence.
 * The same is true here, and the same answer applies: write to storage on a
 * timer, ship from storage when you can, and let the next boot pick up whatever
 * the last session dropped.
 *
 * So this is a queue, not a buffer. A document enters when the run is stashed
 * and leaves when the server has it. Everything in between is somebody else's
 * problem, including the tab being gone.
 *
 * Its own key, like `runstore` and `cellstore`: §15.1's guard scans LibraryData
 * for numbers that could become multipliers, and this is nothing but numbers.
 */
import type { TelemetryDoc } from './telemetry';
import { TELEMETRY_VERSION } from './telemetry';

const STORAGE_KEY = 'overclock.telemetry.outbox.v1';

/**
 * How many unsent runs to keep.
 *
 * Each is a few kilobytes, so twenty is well under a hundred kilobytes — small
 * beside the recording window in `runstore`, which shares the same 5MB quota and
 * is worth an order of magnitude more per entry. If somebody plays twenty runs
 * offline the oldest telemetry is the right thing to lose.
 */
const KEEP = 20;

/**
 * Everything well-formed in the queue, whatever build wrote it.
 *
 * This used to filter on `v === TELEMETRY_VERSION`, on the reasoning that a
 * document whose fields meant something else is not one this build can reason
 * about. The reasoning is right and the placement was wrong, in a way that cost
 * exactly the runs worth most.
 *
 * `read` is the front of a read-modify-write: `queueRun`, `forgetRun` and
 * `sealAbandoned` all end in a `write` of whatever `read` returned. So a filter
 * here is not a filter, it is a **delete** — and the first boot after a version
 * bump silently discarded every pending document from the previous build. Those
 * are the runs that crashed, froze or were closed on the build you just
 * replaced: the churn signal, destroyed by the mechanism meant to protect it,
 * and invisible because a missing abandoned run looks exactly like a player who
 * never showed up.
 *
 * So the queue keeps what it was given. Version is a question for whoever
 * *interprets* a document, and the interpreter already asks it: analysis
 * segments on `v` and reports how many rows it set aside. Shipping a foreign
 * document costs a counted row it declines to average. Deleting one costs the
 * evidence, permanently, and says nothing.
 */
function read(): TelemetryDoc[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    // Structure only: enough to key by, enough to say which build's meaning it
    // carries. Never repaired — a document is evidence, and evidence is not
    // edited into a shape that suits the reader.
    return parsed.filter(
      (d): d is TelemetryDoc =>
        Boolean(d) &&
        typeof d === 'object' &&
        typeof (d as TelemetryDoc).v === 'number' &&
        typeof (d as TelemetryDoc).id === 'string',
    );
  } catch {
    return [];
  }
}

/**
 * Persist the queue, shedding the oldest until it fits.
 *
 * Quota is a real outcome here rather than a theoretical one, because the
 * recording window is in the same storage and is much larger. Losing the oldest
 * telemetry costs a row in a table nobody has queried yet; failing costs the run.
 */
function write(docs: TelemetryDoc[]): void {
  let queue = docs.slice(-KEEP);
  while (queue.length > 0) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(queue));
      return;
    } catch {
      queue = queue.slice(1);
    }
  }
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage is gone entirely. The run still happened; nobody will hear about it.
  }
}

/**
 * Add or replace a run's document.
 *
 * Keyed by run id, and that is load-bearing rather than tidy. The same run is
 * queued repeatedly — every stash, on the way to hidden, and again when it ends
 * — and the id is also the Firestore document id, so a re-send overwrites
 * instead of duplicating. Without that, one run that was tab-switched away from
 * three times would land as four runs and quietly wreck every rate in the corpus.
 */
export function queueRun(doc: TelemetryDoc): void {
  const queue = read().filter((d) => d.id !== doc.id);
  queue.push(doc);
  write(queue);
}

export function pendingRuns(): TelemetryDoc[] {
  return read();
}

export function forgetRun(id: string): void {
  write(read().filter((d) => d.id !== id));
}

/**
 * Close out whatever the last session left open. Called once at boot.
 *
 * Anything still here with a null end is a run whose session died before it
 * could say why — a crash, a freeze, a closed tab, a phone that locked. It is
 * marked `abandoned` and shipped.
 *
 * That is not damage control, it is the point. A run nobody finished is the most
 * expensive event in the corpus and the only one the game itself can never
 * observe. What it costs the analysis layer is that abandoned runs have a
 * truncated trajectory and no settled engine, so anything averaging run length
 * has to segment on `end` or it will report that players quit early because runs
 * are short.
 */
export function sealAbandoned(): number {
  const queue = read();
  let sealed = 0;
  for (const doc of queue) {
    // Kept, not reinterpreted. A document from another build travels as it was
    // written: `end` is only stamped where this build knows what `end` means,
    // and a foreign one ships with a null end, which analysis already reads as a
    // session that never said how it stopped. That is the true statement about
    // it, and the difference between a gap and a lie.
    if (doc.v !== TELEMETRY_VERSION) continue;
    if (doc.end === null) {
      doc.end = 'abandoned';
      sealed++;
    }
  }
  if (sealed > 0) write(queue);
  return sealed;
}

export function clearOutbox(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to do and nothing that matters.
  }
}
