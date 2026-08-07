/**
 * What a run looked like, in a shape that survives being asked new questions.
 *
 * This is the *other* half of §14. A recording is evidence about one run and
 * costs a replay to read; this is evidence about ten thousand runs and costs a
 * query. They answer different questions and neither replaces the other —
 * `record.ts` tells you what happened at 3:12, this tells you whether anybody
 * ever takes `overdrive`.
 *
 * ---
 *
 * **The document is open, and that is deliberate.**
 *
 * `Command` in record.ts is a closed union because a command has to be
 * *re-appliable* — `apply()` executes it, so an unknown kind is a correctness
 * failure. Nothing here is ever re-applied. An unknown event kind is just data
 * nobody has drawn a chart for yet, so the sink takes a string and a payload and
 * a new mechanic costs exactly one `emit()` call at the site where it happens.
 * The moment this becomes a union with a case per mechanic, every feature starts
 * paying a tax to the audit trail, and the audit trail starts losing.
 *
 * For the same reason nothing here ever enumerates content. Node and enemy ids
 * are opaque strings in maps, never fields and never a union — the trait refactor
 * is going to churn them and a telemetry migration per content change is exactly
 * the interference this module exists to avoid.
 *
 * **It never touches the sim.** No RNG, no mutation, no clock. The trap is
 * documented in record.ts and it is worth restating because this module is where
 * somebody would fall into it again: *observing a draft offer by re-rolling it
 * consumes a draw and changes the run*. Everything here is handed data that has
 * already been produced. It reads `world`; it never asks the world for anything
 * that costs something to produce.
 *
 * **It is synchronously serialisable at any instant.** `snapshot()` is the last
 * thing that runs when a tab is closing, inside a `visibilitychange` handler with
 * no time to await anything. So the document is kept assembled as it goes and
 * sealed by copying, never built at flush time.
 */
import type { World } from '../sim/world';
import { TUNABLE } from '../sim/tunables';
import type { PlayerExperience } from './player';
import type { DeviceInfo } from './device';
import { fingerprint, type Fingerprint } from './fingerprint';

/**
 * Bumped only for removals and changes of meaning. Adding a field does *not*
 * bump it — old documents simply lack it, and the analysis layer must read a
 * missing field as "not measured" rather than as zero. A counter introduced in
 * build N looks like a catastrophic regression across all of history if anybody
 * coalesces that absence to 0.
 */
export const TELEMETRY_VERSION = 2;

/**
 * How a run stopped.
 *
 * `abandoned` is never written by the game — it is filled in at boot by the
 * outbox, for any document that was still open when its session died. See
 * outbox.ts. That makes it the one end reason nobody can observe happening,
 * which is also why it is the one worth having: a run nobody finished is a run
 * that lost somebody, and that is the most expensive thing in the corpus.
 */
export type EndReason = 'death' | 'victory' | 'quit' | 'error' | 'abandoned';

/**
 * One thing that happened, stamped with the run-time it happened at.
 *
 * The payload is nested rather than spread, and that is a scar. Flattened, an
 * event's own fields shared a namespace with the envelope's — and the draft
 * event carried the taken card as `k`, which the envelope's `k` then overwrote
 * with the word "draft". Every offer was recorded and every *choice* was thrown
 * away, silently, by the line that was supposed to be labelling the event.
 *
 * The invariant test did not catch it because it asserted `k` looked like an
 * event kind, which it did — it was the wrong one. An open sink cannot reserve
 * names it has never heard of, so it stops sharing a namespace with them.
 */
export interface TelemetryEvent {
  k: string;
  t: number;
  p?: Record<string, unknown>;
}

export interface TelemetryDoc {
  v: number;
  /** Client-generated, and used as the Firestore document id. See outbox.ts. */
  id: string;
  /**
   * Which browser played it. See player.ts — a stable random id, null when
   * storage is unavailable.
   *
   * This is the field that makes the corpus pseudonymous rather than anonymous:
   * before it, two runs by the same person were unlinkable by construction.
   * Nothing else in the document identifies anybody, so if this ever has to go,
   * it goes on its own and the rest of the corpus survives intact.
   */
  pid: string | null;
  /** What they had behind them entering the run. Never measured at the end. */
  exp: PlayerExperience | null;
  build: string;
  /**
   * A digest of the tunables table this run was played against.
   *
   * Without it a corpus is uninterpretable: two runs can be the same build and
   * different games, and averaging across a balance change is a confident way to
   * conclude that the balance change did nothing. Analysis segments on this by
   * default and comparing across it should be an explicit act.
   */
  tun: string;
  /**
   * ...and every *other* balance surface, which `tun` does not cover.
   *
   * `tun` digests `TUNABLE` alone. The draft pool, the progression graph, the
   * wave table, the wave events, the enemies and every node are data too, and a
   * change to any of them changes the game without moving that hash — the fix
   * that stopped a Cache fielding suppression is a `waveevents.json` edit and is
   * invisible to it. Group on `cfg.all`; `cfg.parts` says which surface moved.
   *
   * Additive, so no version bump and no reinterpretation of what is already in
   * the corpus. Absent means "not measured", which for a run recorded before
   * this existed is exactly true. See fingerprint.ts.
   */
  cfg: Fingerprint;
  seed: string;
  axiomId: string;
  /** Wall-clock. The sim never reads a clock; this is stamped at the boundary. */
  startedAt: number;
  /** Wall-clock of the last snapshot, so a dead session's age is knowable. */
  lastBeat: number;
  end: EndReason | null;
  /**
   * §2.1's own vocabulary, carried verbatim rather than folded into `end`.
   *
   * `end` says how the *session* stopped; this says how the *run* did, and the
   * difference between `died-early` and `contained` is whether somebody ever
   * reached Meltdown — one of the few single fields that tells you if the build
   * phase is tuned. Collapsing both into "death" would throw that away.
   */
  ending: string;
  cause: string | null;
  duration: number;
  level: number;
  score: number;
  /** `world.stats`, which the sim already accumulates exactly. Never sampled. */
  stats: Record<string, number | number[]>;
  killsByEnemy: Record<string, number>;
  damageBySource: Record<string, number>;
  finalEngine: { r: string; live: boolean; share: number }[];
  events: TelemetryEvent[];
  /** [t, eps, level, integrity, enemies, heat, liveRows, staticLoad, capacity] */
  traj: number[][];
  /** What it ran on. Null until the renderer exists — see describe(). */
  device: DeviceInfo | null;
  perf: {
    frames: number;
    /** Counts per FRAME_BUCKETS ceiling, plus one bucket for everything above. */
    hist: number[];
    bucketsMs: number[];
    worstMs: number;
    /**
     * How many times the sim's catch-up cap was hit and the leftover accumulator
     * was thrown away.
     *
     * A performance number that is really a balance number. `game.ts` steps the
     * sim at most eight times per frame and then drops the remainder — dropped
     * time is time the run never experienced — so a machine that cannot keep up
     * plays a *shorter, easier* game than one that can. Without this, those runs
     * sit in the corpus looking like ordinary short runs.
     */
    starved: number;
    /** Real GPU milliseconds, where the timer extension exists. See GpuTimer. */
    gpuWorstMs: number;
    gpuMeanMs: number;
    gpuSamples: number;
    /**
     * CPU milliseconds the frame callback cost — sim ticks, scene update, draw
     * submission, HUD. Rendering is capped at 60fps, which pins the frame
     * *interval* at ~16.7ms no matter how hard the machine is working; the
     * histogram above stopped describing throughput the day the cap landed and
     * now only catches missed frames. Busy time is what headroom is read from:
     * a machine at cpu 3ms / gpu 2ms has a ~5× ceiling over the cap. An
     * approximation — the compositor is invisible from here — and biased
     * conservative, since an uncapped frame would carry fewer sim ticks.
     */
    cpuWorstMs: number;
    cpuMeanMs: number;
    /** §20.1 — which visual effects were on, so a preset can be judged by it. */
    fx: string[];
  };
  /** A cap was hit. Without this a truncated run reads as a complete one. */
  truncated: boolean;
}

/**
 * Sampling interval for the trajectory, in seconds of play.
 *
 * Ten, not one. The counters in `world.stats` are integrated per tick and are
 * exact, so sampling buys nothing for anything that has a total — `tierSeconds`
 * knows the dwell, `overheats` knows the count, `peakHeat` knows the maximum.
 * The trajectory exists only for *shape*: the spiral in analyse.ts is EPS going
 * flat while the crowd climbs, and that unfolds over minutes. At 1Hz the
 * trajectory was 73% of the document and resolved nothing the counters missed.
 */
const SAMPLE_EVERY = 10;

/**
 * Caps. A runaway array must cost the telemetry, never the run.
 *
 * Generous enough that no real run reaches them — a two-hour run is 720 samples
 * — and low enough that a bug cannot push a document at Firestore's 1 MiB limit.
 */
const MAX_EVENTS = 512;
const MAX_TRAJ = 1024;

/**
 * Frame-time bucket ceilings, in milliseconds. The last bucket is everything above.
 *
 * A histogram rather than percentiles computed on the device, because the
 * average frame is the one number that never mattered — a run at a steady 60
 * with four 300ms stalls in it has a lovely mean and feels broken. Buckets keep
 * the shape, cost eight integers, and let the question be decided later instead
 * of at collection time.
 *
 * Boundaries are the ones a player can feel: 8 and 12 are comfortably inside a
 * 120Hz and 90Hz frame, 17 is 60Hz, 25 and 34 are visibly down, and past 50 is
 * a stutter rather than a frame rate.
 */
const FRAME_BUCKETS = [8, 12, 17, 25, 34, 50, 100] as const;

/** Longest string accepted from anywhere, so one bad label cannot bloat a doc. */
const MAX_LABEL = 64;

/** Error text gets more room — a message clipped to 64 chars names nothing. */
const MAX_NOTE = 300;

function clip(s: string, max = MAX_LABEL): string {
  return s.length > max ? s.slice(0, max) : s;
}

function r1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * A digest of the balance table.
 *
 * Computed at runtime rather than baked in at build time, because a value that
 * has to be regenerated by a build step is a value that is eventually stale and
 * silently wrong. Walking the live table cannot disagree with the table.
 */
export function hashTunables(): string {
  const json = JSON.stringify(TUNABLE, Object.keys(TUNABLE).sort());
  let h = 2166136261 >>> 0;
  for (let i = 0; i < json.length; i++) {
    h = Math.imul(h ^ json.charCodeAt(i), 16777619) >>> 0;
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Random, unguessable, and generated on the client so a re-send overwrites. */
export function newRunId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  // Older Safari and any non-browser host. Only needs to not collide.
  let s = '';
  for (let i = 0; i < 32; i++) s += Math.floor(Math.random() * 16).toString(16);
  return s;
}

export interface TelemetryMeta {
  build: string;
  startedAt: number;
  pid: string | null;
  exp: PlayerExperience | null;
  fx: string[];
}

export class RunTelemetry {
  readonly id = newRunId();
  private readonly events: TelemetryEvent[] = [];
  private readonly traj: number[][] = [];
  private readonly tun = hashTunables();
  private readonly cfg = fingerprint();
  private nextSample = 0;
  private truncated = false;
  private failure: string | null = null;
  private device: DeviceInfo | null = null;
  private readonly hist = new Array<number>(FRAME_BUCKETS.length + 1).fill(0);
  private frames = 0;
  private worstMs = 0;
  private starved = 0;
  private gpuWorstMs = 0;
  private gpuTotalMs = 0;
  private gpuSamples = 0;
  private cpuWorstMs = 0;
  private cpuTotalMs = 0;
  private cpuSamples = 0;

  constructor(
    private readonly seed: string,
    private readonly axiomId: string,
    private readonly meta: TelemetryMeta,
  ) {}

  /**
   * Record something that happened.
   *
   * The payload is whatever that mechanic knows about itself. Nothing validates
   * its shape, on purpose — a new event kind should not require touching this
   * file, the document type, the query layer or the panel. Unknown kinds flow
   * through to the corpus and become queryable the day they first appear.
   */
  emit(world: World, k: string, payload?: Record<string, unknown>): void {
    if (this.events.length >= MAX_EVENTS) {
      this.truncated = true;
      return;
    }
    const event: TelemetryEvent = { k: clip(k), t: r1(world.time) };
    if (payload) event.p = payload;
    this.events.push(event);
  }

  /** What it is running on. Known only once the renderer exists. */
  describe(device: DeviceInfo): void {
    this.device = device;
  }

  /**
   * One displayed frame.
   *
   * Called every frame, so it allocates nothing and branches at most eight
   * times. A telemetry call that costs a frame is measuring a frame it caused.
   *
   * `gpuMs` is the real thing where `EXT_disjoint_timer_query_webgl2` exists —
   * see GpuTimer, which is there because CPU timing around a WebGL call measures
   * how long it took to *queue* the work and once reported a twelve-fold speedup
   * while sending a real player's GPU into overdrive.
   */
  frame(ms: number, gpuMs = 0, cpuBusyMs = 0): void {
    this.frames++;
    if (ms > this.worstMs) this.worstMs = ms;
    let i = 0;
    while (i < FRAME_BUCKETS.length && ms >= FRAME_BUCKETS[i]!) i++;
    this.hist[i]!++;
    if (gpuMs > 0) {
      this.gpuSamples++;
      this.gpuTotalMs += gpuMs;
      if (gpuMs > this.gpuWorstMs) this.gpuWorstMs = gpuMs;
    }
    // `cpuBusyMs` arrives one frame late — a frame cannot know its own cost
    // while it is still inside it — so the first frame legitimately sends 0.
    if (cpuBusyMs > 0) {
      this.cpuSamples++;
      this.cpuTotalMs += cpuBusyMs;
      if (cpuBusyMs > this.cpuWorstMs) this.cpuWorstMs = cpuBusyMs;
    }
  }

  /** The catch-up cap hit and time was deleted from the run. See `perf.starved`. */
  starve(): void {
    this.starved++;
  }

  /**
   * The run threw.
   *
   * Recorded as an event *and* kept as the document's `cause`, because a crash
   * is the one ending where "what killed it" is a string nobody wrote down in
   * advance. The stack is clipped to its first few frames: past that it is
   * framework noise, and the useful part — which of our functions was on top —
   * is always at the beginning.
   *
   * Sealing this is the last thing the run does before the error is rethrown, so
   * the failure survives the thing that caused it. That ordering is the whole
   * point; a crash report that dies with the crash is not a report.
   */
  fail(world: World, err: unknown): void {
    const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    this.failure = clip(message, MAX_NOTE);
    const stack =
      err instanceof Error && err.stack
        ? clip(err.stack.split('\n').slice(1, 6).join(' | '), MAX_NOTE)
        : null;
    this.emit(world, 'error', { m: this.failure, s: stack });
  }

  /**
   * Append a trajectory row if enough run-time has passed.
   *
   * Safe to call every tick; it is a compare against a counter until it is not.
   * Driven from the same timer that stashes recordings, so it costs a frame
   * nothing it was not already paying.
   */
  sample(world: World): void {
    if (world.time < this.nextSample) return;
    this.nextSample = world.time + SAMPLE_EVERY;
    if (this.traj.length >= MAX_TRAJ) {
      this.truncated = true;
      return;
    }
    this.traj.push([
      Math.round(world.time),
      r1(world.eps),
      world.level,
      Math.ceil(world.player.integrity),
      world.enemies.length,
      Math.round(world.budget.heat),
      world.engine.compiled.filter((c) => c.live).length,
      r1(world.engine.staticLoad),
      world.budget.capacity,
    ]);
  }

  /**
   * Seal the document as it stands.
   *
   * Callable at any instant, including from a page-lifecycle handler with the
   * tab already going away, so everything here is a copy of something that
   * already exists. Nothing is computed that could take a while and nothing can
   * throw on a half-built world — a run that ends on tick one still produces a
   * valid document.
   *
   * `end` is null for a run still in progress. That is not a placeholder to be
   * tidied away: a document that reaches the outbox with a null end is how an
   * abandoned run identifies itself at next boot.
   */
  snapshot(world: World, end: EndReason | null = null): TelemetryDoc {
    const s = world.stats;
    return {
      v: TELEMETRY_VERSION,
      id: this.id,
      pid: this.meta.pid,
      exp: this.meta.exp,
      build: this.meta.build,
      tun: this.tun,
      cfg: this.cfg,
      seed: this.seed,
      axiomId: this.axiomId,
      startedAt: this.meta.startedAt,
      lastBeat: Date.now(),
      end,
      ending: world.ending,
      // What ended it, whatever "it" turned out to be. A crash outranks a death
      // cause: if both are set the run was already failing when it died.
      cause: this.failure ?? world.deathCause?.label ?? null,
      duration: r1(world.time),
      level: world.level,
      score: Math.floor(world.finalScore().total),
      stats: {
        events: s.events,
        kills: s.kills,
        fires: s.fires,
        misfires: s.misfires,
        droppedByDepth: s.droppedByDepth,
        maxDepth: s.maxDepth,
        peakEps: r1(s.peakEps),
        peakConcurrentEnemies: s.peakConcurrentEnemies,
        overheats: s.overheats,
        magnets: s.magnets,
        recycled: s.recycled,
        gatesOpened: s.gatesOpened,
        cachesOpened: s.cachesOpened,
        gluttonsPopped: s.gluttonsPopped,
        suppressorsKilledInside: s.suppressorsKilledInside,
        damageTaken: Math.round(s.damageTaken),
        beaconsChannelled: s.beaconsChannelled,
        converts: s.converts,
        crits: s.crits,
        suppressedKills: s.suppressedKills,
        // §11.2 — the dwell and the crossings. Counters, because both have exact
        // integrals; the *where* is the `suppress_in`/`suppress_out` events.
        suppressedSeconds: r1(s.suppressedSeconds),
        suppressionEntries: s.suppressionEntries,
        desperateConverts: s.desperateConverts,
        peakHeat: Math.round(s.peakHeat),
        firstLevelTime: r1(s.firstLevelTime),
        safetyTrips: s.safetyTrips,
        tierSeconds: s.tierSeconds.map(r1),
        kernels: world.kernels,
        kernel: Math.round(world.engine.kernel * 100) / 100,
        meltdownSeconds: r1(world.meltdownTime),
        peakMultiplier: Math.round(world.peakMeltdownMultiplier * 100) / 100,
        phase: world.phase === 'meltdown' ? 1 : 0,
      },
      killsByEnemy: Object.fromEntries(s.killsByEnemy),
      damageBySource: Object.fromEntries(
        [...world.damageBySource.values()].map((d) => [clip(d.source.label), Math.round(d.amount)]),
      ),
      finalEngine: world.engine.programs
        .map((p, i) => ({
          r: clip(
            [p.triggerId, ...p.modifierIds.filter(Boolean), p.actionId].filter(Boolean).join('>'),
          ),
          live: world.engine.compiled[i]?.live ?? false,
          share: Math.round(world.outputShareOf([i]) * 1000) / 1000,
        }))
        .filter((row) => row.r),
      events: [...this.events],
      traj: [...this.traj],
      device: this.device,
      perf: {
        frames: this.frames,
        hist: [...this.hist],
        bucketsMs: [...FRAME_BUCKETS],
        worstMs: Math.round(this.worstMs),
        starved: this.starved,
        gpuWorstMs: Math.round(this.gpuWorstMs * 100) / 100,
        gpuMeanMs:
          this.gpuSamples > 0 ? Math.round((this.gpuTotalMs / this.gpuSamples) * 100) / 100 : 0,
        gpuSamples: this.gpuSamples,
        cpuWorstMs: Math.round(this.cpuWorstMs * 100) / 100,
        cpuMeanMs:
          this.cpuSamples > 0 ? Math.round((this.cpuTotalMs / this.cpuSamples) * 100) / 100 : 0,
        fx: [...this.meta.fx],
      },
      truncated: this.truncated,
    };
  }
}
