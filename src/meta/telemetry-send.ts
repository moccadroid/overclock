/**
 * Getting the outbox to Firestore, and the page-lifecycle handling around it.
 *
 * No SDK. The Firebase modular SDK is ~100KB gzipped and buys realtime
 * listeners, offline query and a document cache, none of which this uses — the
 * entire client-side need is one idempotent PATCH per run. So this is `fetch`
 * against the REST API, and the bundle does not notice telemetry exists.
 *
 * ---
 *
 * **Shape on the wire.** Firestore's REST encoding wraps every value in a type
 * tag, which for a nested document means an encoder that walks arrays and maps
 * and gets `integerValue`-is-a-string right. Instead the run travels as one JSON
 * string in `doc`, with a handful of scalars promoted beside it so an export can
 * filter without parsing. We never query inside Firestore — the corpus is
 * exported and read with DuckDB — so structure in the database buys nothing and
 * costs an encoder plus an index entry per nested field.
 *
 * That last part is a real trap rather than a preference: Firestore indexes every
 * field by default, index entries have a size ceiling, and **a multi-kilobyte
 * indexed string fails the write**. `firestore.indexes.json` exempts `doc` from
 * indexing. Remove that exemption and telemetry stops working for long runs only,
 * which is the worst possible failure distribution.
 *
 * **Failure is always silent.** Every path here swallows. Telemetry that can
 * interrupt a run, log noise into a player's console, or throw inside a
 * lifecycle handler has cost more than it collects.
 */
import type { TelemetryDoc } from './telemetry';
import { forgetRun, pendingRuns, queueRun } from './outbox';

/**
 * The database's address, written down.
 *
 * Not configuration, because there is nothing to configure and nowhere to hide
 * it: this is a static client, so every byte of it is public, and the project id
 * is already in `.firebaserc`, in `deploy.yml`, and in the hostname players type.
 * An unauthenticated Firestore write carries no credential at all — verified
 * against the live project, where a bare `curl` with no header beyond
 * `Content-Type` returns 200 for a well-formed run and 403 for everything else.
 * `firestore.rules` is the whole of the access control and the only place it
 * could ever be, short of auth or a backend that this game does not want.
 */
const PROJECT = 'overclock-game';

const COLLECTION = 'runs';

/** Both `sendBeacon` and `fetch(keepalive)` cap the body at 64 KiB, per spec. */
const MAX_BODY = 60_000;

interface RemoteConfig {
  enabled: boolean;
  /** Fraction of runs kept, 0..1. Whole runs, never events within a run. */
  sample: number;
}

let config: RemoteConfig = { enabled: true, sample: 1 };

/**
 * Read the kill switch.
 *
 * A static file on Hosting rather than anything in Firestore: it costs no read,
 * needs no rules, and `firebase.json` already serves every non-asset path
 * `no-cache`, so turning telemetry off or dialling it down is a deploy and takes
 * effect on the next load. Failing to fetch it leaves the defaults alone —
 * a missing config must not be the reason a corpus has a hole in it.
 */
export async function loadTelemetryConfig(): Promise<void> {
  try {
    const res = await fetch('/telemetry.json', { cache: 'no-store' });
    if (!res.ok) return;
    const parsed = (await res.json()) as Partial<RemoteConfig>;
    config = {
      enabled: parsed.enabled !== false,
      sample:
        typeof parsed.sample === 'number' && parsed.sample >= 0 && parsed.sample <= 1
          ? parsed.sample
          : 1,
    };
  } catch {
    // Offline, blocked, or not deployed yet. Defaults stand.
  }
}

/**
 * Whether this run is one of the kept ones.
 *
 * Derived from the run id, so a run samples in or out exactly once and every
 * later flush of the same run agrees. Sampling events within a run instead would
 * skew per-node confidence unevenly and make offer counts meaningless.
 */
export function samples(runId: string): boolean {
  if (!config.enabled) return false;
  if (config.sample >= 1) return true;
  if (config.sample <= 0) return false;
  let h = 2166136261 >>> 0;
  for (let i = 0; i < runId.length; i++) {
    h = Math.imul(h ^ runId.charCodeAt(i), 16777619) >>> 0;
  }
  return (h % 10000) / 10000 < config.sample;
}

/**
 * Dev builds keep their runs to themselves.
 *
 * Not to protect anything — a dev run is labelled `build: 'dev'` and could be
 * filtered out in one predicate — but because a hot reload is not a run and a
 * corpus full of half-second sessions from `pnpm dev` is a corpus somebody has
 * to remember to exclude every single time they query it. Your own runs are
 * already better served by the recorder, which is local and lossless.
 *
 * Vite folds this to a constant, so the whole send path drops out of a dev
 * bundle. To exercise it for real, build and serve: `pnpm build && pnpm preview`.
 */
export function telemetryEnabled(): boolean {
  return config.enabled && !import.meta.env.DEV;
}

function url(id: string): string {
  return (
    `https://firestore.googleapis.com/v1/projects/${PROJECT}` +
    `/databases/(default)/documents/${COLLECTION}/${encodeURIComponent(id)}`
  );
}

/**
 * Promote the fields an export wants to filter on; carry the rest as JSON.
 *
 * `integerValue` is a string in this encoding and `doubleValue` is not, which is
 * the kind of detail that fails as a 400 with a message about the wrong field.
 */
function body(doc: TelemetryDoc): string {
  const payload = JSON.stringify(doc);
  return JSON.stringify({
    fields: {
      v: { integerValue: String(doc.v) },
      // Promoted beside the payload so Firestore can group by player without
      // parsing every run. The rest of the analysis reads it out of `doc`.
      pid: doc.pid === null ? { nullValue: null } : { stringValue: doc.pid },
      build: { stringValue: doc.build },
      tun: { stringValue: doc.tun },
      axiomId: { stringValue: doc.axiomId },
      seed: { stringValue: doc.seed },
      end: doc.end === null ? { nullValue: null } : { stringValue: doc.end },
      startedAt: { integerValue: String(doc.startedAt) },
      lastBeat: { integerValue: String(doc.lastBeat) },
      duration: { doubleValue: doc.duration },
      level: { integerValue: String(doc.level) },
      score: { integerValue: String(doc.score) },
      truncated: { booleanValue: doc.truncated },
      doc: { stringValue: payload },
    },
  });
}

/**
 * Upsert one run.
 *
 * PATCH rather than POST because the same run is sent more than once — a partial
 * on the way to hidden, the real thing when it ends — and the run id is the
 * document id, so the last write wins and a re-send is free. POST-with-documentId
 * would reject the second write and leave the partial standing as the record,
 * which is the wrong one to keep.
 */
async function send(doc: TelemetryDoc, keepalive: boolean): Promise<boolean> {
  const payload = body(doc);
  // Over the cap the request is refused by the browser rather than the server,
  // and silently. Drop it here where at least the outbox stays clean.
  if (payload.length > MAX_BODY) return true;
  try {
    const res = await fetch(url(doc.id), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
      keepalive,
    });
    // 4xx means this document will never be accepted — a rules rejection or a
    // malformed field. Retrying it forever would wedge the queue behind it, so
    // it counts as delivered and leaves.
    return res.ok || (res.status >= 400 && res.status < 500);
  } catch {
    return false;
  }
}

/**
 * Ship everything queued.
 *
 * `keepalive` only when the page is going away: the 64 KiB allowance is shared
 * across all in-flight keepalive requests, so spending it on a routine boot
 * drain would starve the send that actually needs it.
 */
export async function flushOutbox(keepalive = false): Promise<void> {
  if (!telemetryEnabled()) return;
  for (const doc of pendingRuns()) {
    if (!samples(doc.id)) {
      forgetRun(doc.id);
      continue;
    }
    if (await send(doc, keepalive)) forgetRun(doc.id);
    else break; // Network is down. Leave the rest for next boot.
  }
}

/**
 * Register the last-chance handlers.
 *
 * `visibilitychange` to hidden is the only event that fires when a phone locks
 * or a tab is switched away from, and it is documented as the last reliably
 * observable moment — treat it as the end of the session even though it often
 * is not. `pagehide` catches navigations that somehow skipped it. Neither
 * `unload` nor `beforeunload` appears here on purpose: the first is removed and
 * both disable bfcache.
 *
 * `getDoc` must be synchronous. There is no time to await anything at this point
 * — the page may be gone before a promise settles — which is why RunTelemetry
 * keeps its document assembled rather than building one on demand.
 */
export function installLifecycleHooks(getDoc: () => TelemetryDoc | null): () => void {
  let lastSent = '';

  const flush = (): void => {
    try {
      const doc = getDoc();
      if (!doc) return;
      // Tab switching is constant and most of it changes nothing. A cheap
      // signature keeps a player who alt-tabs twenty times from writing twenty
      // documents' worth of quota for one run.
      const signature = `${doc.id}:${doc.duration}:${doc.events.length}:${doc.end ?? ''}`;
      if (signature === lastSent) return;
      lastSent = signature;
      queueRun(doc);
      void flushOutbox(true);
    } catch {
      // A telemetry throw inside a lifecycle handler is a bug that eats the
      // browser's last few milliseconds. Never.
    }
  };

  const onVisibility = (): void => {
    if (document.visibilityState === 'hidden') flush();
  };

  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pagehide', flush);

  return () => {
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('pagehide', flush);
  };
}
