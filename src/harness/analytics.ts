/**
 * What the corpus says. GDD §23, at population scale.
 *
 *   pnpm analytics                      # newest tunables only
 *   pnpm analytics -- --all             # every run, across balance changes
 *   pnpm analytics -- --tun 1dbd3cae    # one balance patch
 *   pnpm analytics -- --min 20          # hide rates below this many offers
 *
 * The per-run counterpart is `analyse.ts`, which replays one recording and says
 * what happened in it. This never replays anything: it reads what the runs
 * reported about themselves and says what is true across all of them.
 *
 * ---
 *
 * **Every rate carries its denominator.** A node with a 0% pick rate that was
 * offered twice is noise; the same number at two hundred offers is a card nobody
 * wants. Printed without `n` those are the same line, and acting on the first one
 * is how a pool gets balanced against sampling error. Anything under `--min` is
 * marked rather than hidden, because knowing a card is barely offered *is* the
 * finding sometimes.
 *
 * **Segmented by tunables hash by default.** Averaging a metric across a balance
 * change is a confident way to prove the balance change did nothing. Comparing
 * across patches is `--all`, and it says so at the top when you do.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TELEMETRY_VERSION as CORPUS_VERSION } from '../meta/telemetry';

interface Event {
  k: string;
  t: number;
  p?: Record<string, unknown>;
}

interface Experience {
  runs: number;
  discoveries: number;
  unlocked: number;
  codex: number;
  bestScore: number;
  bestDepth: number;
  bestTime: number;
}

interface Device {
  backend: string | null;
  gpu: string | null;
  cores: number | null;
  memory: number | null;
  dpr: number;
  vw: number;
  vh: number;
  platform: string | null;
  gpuTimer: boolean;
}

interface Perf {
  frames: number;
  hist: number[];
  bucketsMs: number[];
  worstMs: number;
  starved: number;
  gpuWorstMs: number;
  gpuMeanMs: number;
  gpuSamples: number;
  fx: string[];
}

interface Run {
  v: number;
  id: string;
  /** Absent on runs recorded before players were identified. Never coalesced. */
  pid?: string | null;
  exp?: Experience | null;
  device?: Device | null;
  perf?: Perf;
  build: string;
  tun: string;
  /** Absent on runs recorded before the fingerprint covered content. See below. */
  cfg?: { all: string; parts: Record<string, string>; profiles: Record<string, string> };
  seed: string;
  axiomId: string;
  startedAt: number;
  end: string | null;
  ending: string;
  cause: string | null;
  duration: number;
  level: number;
  score: number;
  stats: Record<string, number | number[]>;
  killsByEnemy: Record<string, number>;
  damageBySource: Record<string, number>;
  finalEngine: { r: string; live: boolean; share: number }[];
  events: Event[];
  traj: number[][];
  truncated: boolean;
}

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : null;
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function load(path: string): Run[] {
  let raw: string;
  try {
    raw = readFileSync(resolve(process.cwd(), path), 'utf8');
  } catch {
    console.error(`\n  No corpus at ${path}. Run \`pnpm pull\` first.\n`);
    process.exit(1);
  }
  const rows = raw
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Run);

  // A long-lived corpus always has a tail of older shapes, and mixing them is
  // worse than losing them: v1 recorded every offer and no choice, so averaging
  // it in would report that players refuse everything they are shown.
  const current = rows.filter((r) => r.v === CORPUS_VERSION);
  const stale = rows.length - current.length;
  if (stale > 0) {
    console.log(`  (ignoring ${stale} run(s) from an older telemetry version)`);
  }
  return current;
}

const pad = (s: string | number, n: number): string => String(s).padStart(n);
const padr = (s: string | number, n: number): string => String(s).padEnd(n);
const pct = (n: number, d: number): string => (d === 0 ? '  --' : `${Math.round((n / d) * 100)}%`);

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}
function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}
function tally<T>(items: T[], key: (t: T) => string): Map<string, number> {
  const out = new Map<string, number>();
  for (const item of items) {
    const k = key(item);
    out.set(k, (out.get(k) ?? 0) + 1);
  }
  return out;
}
/**
 * Which game this run was played against.
 *
 * `cfg.all` when the run has one, `tun` when it does not. `tun` digests
 * `TUNABLE` alone, so for as long as it was the only fingerprint a change to the
 * draft pool, the wave table, the wave events or any node left it untouched —
 * two genuinely different games grouped under one hash, in the segmentation that
 * exists to stop precisely that. See meta/fingerprint.ts.
 *
 * Falling back rather than discarding: a run recorded before the wider
 * fingerprint existed is still a real run, and an absent field means "not
 * measured", never zero. It groups by the only mark it has, and the header says
 * so rather than implying its neighbours were checked against more.
 */
function mark(run: Run): string {
  return run.cfg?.all ?? run.tun;
}

function num(run: Run, key: string): number {
  const v = run.stats[key];
  return typeof v === 'number' ? v : 0;
}

/**
 * A target line: what §-whatever asks for, what the corpus does, and the n.
 *
 * `--` rather than a number when there is nothing to measure. A design target
 * reported as 0.0s reads as a catastrophic failure rather than as silence.
 */
function target(label: string, value: number | null, unit: string, want: string, n: number): string {
  const shown = value === null ? padr('--', 9) : padr(`${value.toFixed(1)}${unit}`, 9);
  return `    ${padr(label, 26)} ${shown} want ${padr(want, 14)} n=${n}`;
}

function main(): void {
  const all = load(arg('in') ?? 'analytics/runs.ndjson');
  if (all.length === 0) {
    console.log('\n  Corpus is empty.\n');
    return;
  }

  const minOffers = Number(arg('min') ?? 10);
  const wantBuild = arg('build');
  const newest = [...all].sort((a, b) => b.startedAt - a.startedAt)[0]!;
  const wantTun = arg('tun') ?? (flag('all') ? null : mark(newest));

  const runs = all.filter(
    (r) => (wantTun === null || mark(r) === wantTun) && (wantBuild === null || r.build === wantBuild),
  );
  if (runs.length === 0) {
    console.log(`\n  No runs match. Corpus holds ${all.length}.\n`);
    return;
  }

  // Abandoned runs stopped when a tab did, not when the run did. They are the
  // most important rows in the corpus and the most misleading ones to average:
  // their duration is where somebody stopped watching, not where they lost.
  const finished = runs.filter((r) => r.end !== 'abandoned' && r.end !== null);
  const abandoned = runs.filter((r) => r.end === 'abandoned' || r.end === null);

  const L: string[] = [];
  L.push('');
  L.push(
    `  overclock analytics — ${runs.length} run(s)` +
      (runs.length < all.length ? ` of ${all.length}` : '') +
      (wantTun ? `  ·  balance ${wantTun}` : '  ·  ALL BALANCE PATCHES (cross-patch)'),
  );
  if (!wantTun) {
    L.push('  !! spanning balance changes — differences here may be the patch, not the players');
  }
  L.push('');

  // ------------------------------------------------------------------ corpus
  const builds = tally(runs, (r) => r.build);
  const marks = tally(all, mark);
  L.push('  CORPUS');
  L.push(`    builds        ${[...builds].map(([b, n]) => `${b}(${n})`).join('  ')}`);
  L.push(`    balance       ${[...marks].map(([t, n]) => `${t}(${n})`).join('  ')}`);
  const narrow = runs.filter((r) => !r.cfg).length;
  if (narrow > 0) {
    L.push(
      `    !! ${narrow} run(s) predate the content fingerprint — grouped on tunables alone,` +
        `\n       so a draft-pool or wave change inside that group is invisible here`,
    );
  }
  // Which surface moved. With one group this is the manifest; with several it is
  // the diff, and "the draft pool changed and nothing else did" is a far more
  // useful sentence than "these two populations differ".
  const withCfg = runs.filter((r) => r.cfg);
  if (withCfg.length > 0) {
    const surfaces = new Set(withCfg.flatMap((r) => Object.keys(r.cfg!.parts)));
    const moved = [...surfaces].filter((s) => new Set(withCfg.map((r) => r.cfg!.parts[s])).size > 1);
    const profiles = new Set(
      withCfg.map((r) => Object.entries(r.cfg!.profiles).map(([k, v]) => `${k}=${v}`).join(' ')),
    );
    L.push(`    profiles      ${[...profiles].join('  ·  ')}`);
    if (moved.length > 0) {
      L.push(`    !! surfaces differing across this selection: ${moved.join(', ')}`);
    }
  }
  L.push(`    truncated     ${runs.filter((r) => r.truncated).length}`);
  L.push('');

  // -------------------------------------------------------------- how it ends
  L.push('  HOW RUNS END');
  const ends = tally(runs, (r) => r.end ?? 'open');
  for (const [k, n] of [...ends].sort((a, b) => b[1] - a[1])) {
    L.push(`    ${padr(k, 14)} ${pad(n, 5)}  ${pad(pct(n, runs.length), 5)}`);
  }
  const endings = tally(finished, (r) => r.ending);
  if (endings.size > 0) {
    L.push('    ·');
    for (const [k, n] of [...endings].sort((a, b) => b[1] - a[1])) {
      L.push(`    ${padr(k, 14)} ${pad(n, 5)}  ${pad(pct(n, finished.length), 5)}  (of finished)`);
    }
  }
  if (abandoned.length > 0) {
    L.push(
      `    -> ${abandoned.length} abandoned, median level ${median(abandoned.map((r) => r.level))}` +
        ` at ${median(abandoned.map((r) => r.duration)).toFixed(0)}s — where players stop watching`,
    );
  }
  L.push('');

  // --------------------------------------------------------- design targets
  //
  // Draft cadence is read off the gaps between draft events rather than from a
  // level-up counter: what §8.1 is asking about is how often a decision arrives,
  // and that is exactly what those timestamps are.
  //
  // Measured off level-ups, not drafts. Draft gaps looked like the same thing
  // and were not: pending drafts queue, so two banked level-ups get clicked
  // through 1.7s apart and pull the median down to a number describing how fast
  // somebody clears a backlog. On the first run in this corpus that read 10.5s
  // against a 30-45s target and looked like a three-fold miss; it was partly the
  // metric. Runs recorded before `level` events fall back to the run's own
  // average, which is coarse but cannot be fooled by a burst.
  const cadences: number[] = [];
  for (const r of runs) {
    const times = r.events.filter((e) => e.k === 'level').map((e) => e.t);
    if (times.length > 0) {
      let prev = num(r, 'firstLevelTime') || times[0]!;
      for (const t of times) {
        if (t > prev) cadences.push(t - prev);
        prev = t;
      }
    } else if (r.level > 1 && r.duration > 0) {
      const first = num(r, 'firstLevelTime');
      const span = r.duration - first;
      if (span > 0) cadences.push(span / (r.level - 1));
    }
  }
  const firstLevels = finished.map((r) => num(r, 'firstLevelTime')).filter((n) => n > 0);
  const kernels = finished.map((r) => num(r, 'kernels'));
  const tierShare = finished.map((r) => {
    const t = r.stats.tierSeconds;
    const arr = Array.isArray(t) ? t : [0, 0, 0, 0];
    const total = arr.reduce((a, b) => a + b, 0);
    return total > 0 ? (arr[2]! + arr[3]!) / total : 0;
  });
  const misfire = finished.map((r) => {
    const f = num(r, 'fires');
    const m = num(r, 'misfires');
    return f + m > 0 ? m / (f + m) : 0;
  });

  L.push('  DESIGN TARGETS');
  L.push(
    target(
      '§8.1 level cadence',
      cadences.length ? median(cadences) : null,
      's',
      '30-45s median',
      cadences.length,
    ),
  );
  // A median is the wrong summary when the thing is bimodal, and this one is:
  // an observed run went 22s to its first level, waited 34s for the second, then
  // produced five more in twenty-two seconds — two of them 0.6s apart. Reported
  // as "8.1s median" that reads as uniformly too fast, and the fix somebody
  // would reach for is slowing the curve, which would make the 34s wait worse
  // while leaving the cascade untouched. The shape is the finding.
  if (cadences.length >= 4) {
    const clustered = cadences.filter((g) => g < 5).length;
    const inBand = cadences.filter((g) => g >= 30 && g <= 45).length;
    L.push(
      `      spread ${Math.min(...cadences).toFixed(1)}s - ${Math.max(...cadences).toFixed(1)}s` +
        `   ${clustered}/${cadences.length} under 5s (cascading)` +
        `   ${inBand}/${cadences.length} in band`,
    );
  }
  L.push(
    target(
      '§3 first decision',
      firstLevels.length ? mean(firstLevels) : null,
      's',
      'under 45s',
      firstLevels.length,
    ),
  );
  L.push(
    target('§9.2 recompiles', kernels.length ? mean(kernels) : null, '', '2-3 per run', kernels.length),
  );
  L.push(
    target(
      '§6.3 heat tier 2+',
      tierShare.length ? mean(tierShare) * 100 : null,
      '%',
      'under 30%',
      tierShare.length,
    ),
  );
  L.push(
    target(
      'misfire rate',
      misfire.length ? mean(misfire) * 100 : null,
      '%',
      'under 25%',
      misfire.length,
    ),
  );
  const trips = finished.reduce((s, r) => s + num(r, 'safetyTrips'), 0);
  if (trips > 0) {
    L.push(`    !! ${trips} safety-valve trips — §5.2 says investigate, do not tune`);
  }

  // A target can be missed by never being approached, and that reads as a pass.
  // Heat sitting at 0% of tier 2+ satisfies "under 30%" while telling you the
  // economy never engaged at all; no recompiles satisfies nothing but would be
  // easy to skim past as a small number. Both are worth saying out loud.
  const inertHeat = finished.filter((r) => {
    const t = r.stats.tierSeconds;
    const arr = Array.isArray(t) ? t : [];
    return arr.length > 1 && arr.slice(1).every((s) => s === 0);
  });
  if (inertHeat.length > 0) {
    const peak = Math.max(...inertHeat.map((r) => num(r, 'peakHeat')));
    L.push(
      `    !! ${inertHeat.length}/${finished.length} run(s) never left Heat tier 0` +
        ` (peak ${peak}) — §6.3 wants somewhere you visit, not somewhere you never reach`,
    );
  }
  const noKernel = finished.filter((r) => num(r, 'kernels') === 0);
  if (noKernel.length > 0) {
    L.push(
      `    !! ${noKernel.length}/${finished.length} run(s) never Recompiled` +
        ` — §9.2 wants 2-3, so this is a system that did not happen`,
    );
  }
  L.push('');

  // ------------------------------------------------------------- engine offline
  //
  // §11.2 — how long the player's Triggers were switched off, and where.
  //
  // The dwell is a counter, integrated per tick in the sim, because it has an
  // exact integral and sampling one would be strictly worse. What a counter
  // cannot carry is *when*, so the crossings are events, and the pairing below
  // is the only reason both exist: "was my Engine off when I opened that box"
  // was unanswerable from this corpus until it did.
  const suppressedRuns = finished.filter((r) => num(r, 'suppressedSeconds') > 0);
  if (finished.length > 0) {
    const dwell = finished.map((r) => num(r, 'suppressedSeconds'));
    const share = finished.map((r) => (r.duration > 0 ? num(r, 'suppressedSeconds') / r.duration : 0));
    L.push('  ENGINE OFFLINE (§11.2)');
    L.push(
      `    suppressed    ${suppressedRuns.length}/${finished.length} run(s)` +
        `   median ${median(dwell).toFixed(1)}s   worst ${Math.max(0, ...dwell).toFixed(1)}s` +
        `   ${(mean(share) * 100).toFixed(1)}% of play`,
    );
    const entries = finished.map((r) => num(r, 'suppressionEntries'));
    L.push(
      `    crossings     median ${median(entries)}   worst ${Math.max(0, ...entries)}` +
        `   (forty seconds in one field and forty one-second fields are different games)`,
    );

    // §12.4 — the one this was built to answer. A Cache is a purchase, and the
    // thing it must never sell you is your own Engine switched off.
    const WINDOW = 20;
    let caches = 0;
    let cachesWithSuppression = 0;
    for (const r of runs) {
      const opens = r.events.filter((e) => e.k === 'poi_cache').map((e) => e.t);
      const ins = r.events.filter((e) => e.k === 'suppress_in').map((e) => e.t);
      for (const t of opens) {
        caches++;
        if (ins.some((s) => s >= t && s <= t + WINDOW)) cachesWithSuppression++;
      }
    }
    if (caches > 0) {
      L.push(
        `    at a Cache    ${cachesWithSuppression}/${caches} opened within ${WINDOW}s of the` +
          ` Engine going quiet${cachesWithSuppression === 0 ? '  — clean' : '  !!'}`,
      );
    } else {
      L.push(`    at a Cache    -- no Cache opened in this selection`);
    }
    L.push('');
  }

  // ------------------------------------------------------------------ players
  //
  // A pid identifies a browser profile, not a person: cleared storage, private
  // browsing, a second device all mint a new one. So every count here is a
  // floor. Runs with no pid are held apart rather than lumped into one ghost
  // player, which would otherwise look like the most dedicated user on record.
  const identified = runs.filter((r) => typeof r.pid === 'string');
  const anonymous = runs.length - identified.length;
  if (identified.length > 0) {
    const byPlayer = new Map<string, Run[]>();
    for (const r of identified) byPlayer.set(r.pid!, [...(byPlayer.get(r.pid!) ?? []), r]);
    const counts = [...byPlayer.values()].map((rs) => rs.length);
    const returning = counts.filter((n) => n > 1).length;

    L.push('  PLAYERS');
    L.push(`    distinct      ${byPlayer.size}  (a floor — see analytics.ts)`);
    L.push(
      `    runs each     median ${median(counts)}   max ${Math.max(...counts)}` +
        `   ${returning} played more than once`,
    );
    if (anonymous > 0) L.push(`    unidentified  ${anonymous} run(s), storage unavailable or pre-pid`);

    // Experience is the reason to have any of this: it separates "the tuning is
    // wrong" from "the person measuring it has played four hundred runs".
    const withExp = runs.filter((r) => r.exp);
    if (withExp.length > 0) {
      const buckets: [string, (n: number) => boolean][] = [
        ['first run', (n) => n === 0],
        ['runs 1-4', (n) => n >= 1 && n < 5],
        ['runs 5-19', (n) => n >= 5 && n < 20],
        ['runs 20+', (n) => n >= 20],
      ];
      L.push('    ·');
      L.push(
        `    ${padr('experience', 14)} ${pad('n', 4)}  ${pad('cadence', 9)}  ` +
          `${pad('duration', 9)}  ${pad('level', 6)}`,
      );
      for (const [label, test] of buckets) {
        const group = withExp.filter((r) => test(r.exp!.runs));
        if (group.length === 0) continue;
        const gaps: number[] = [];
        for (const r of group) {
          const ts = r.events.filter((e) => e.k === 'draft').map((e) => e.t);
          for (let i = 1; i < ts.length; i++) gaps.push(ts[i]! - ts[i - 1]!);
        }
        const done = group.filter((r) => r.end !== 'abandoned' && r.end !== null);
        L.push(
          `    ${padr(label, 14)} ${pad(group.length, 4)}  ` +
            `${pad(gaps.length ? median(gaps).toFixed(1) + 's' : '--', 9)}  ` +
            `${pad(done.length ? median(done.map((r) => r.duration)).toFixed(0) + 's' : '--', 9)}  ` +
            `${pad(done.length ? median(done.map((r) => r.level)) : '--', 6)}`,
        );
      }
    }
    L.push('');
  }

  // -------------------------------------------------------------- performance
  //
  // Here rather than in a separate perf tool because `starved` is a balance
  // number wearing a frame-rate costume: a machine that keeps hitting the sim's
  // catch-up cap has time deleted from its runs, so it plays a shorter and
  // easier game than the one any of these targets were tuned against.
  const withPerf = runs.filter((r) => r.perf && r.perf.frames > 0);
  if (withPerf.length > 0) {
    const totalFrames = withPerf.reduce((s, r) => s + r.perf!.frames, 0);
    const buckets = withPerf[0]!.perf!.bucketsMs;
    const merged = new Array<number>(buckets.length + 1).fill(0);
    for (const r of withPerf) r.perf!.hist.forEach((n, i) => (merged[i]! += n));
    // Everything at or past the 34ms bucket: under 30fps, and the region a
    // player describes as the game stuttering rather than running slowly.
    const jankFrom = buckets.findIndex((b) => b >= 34);
    const jank = jankFrom < 0 ? 0 : merged.slice(jankFrom + 1).reduce((a, b) => a + b, 0);
    const starved = withPerf.reduce((s, r) => s + r.perf!.starved, 0);

    L.push('  PERFORMANCE');
    L.push(`    frames        ${totalFrames} over ${withPerf.length} run(s)`);
    // Counts, not percentages. Three bad frames in fourteen thousand round to
    // 0% and the distribution then reads as flawless while the worst frame line
    // says 50ms — erasing exactly the tail the histogram exists to keep.
    L.push(
      `    distribution  ${buckets
        .map((b, i) => `<${b}ms ${merged[i]}`)
        .join('  ')}  >=${buckets.at(-1)}ms ${merged.at(-1)}`,
    );
    L.push(
      `    over 34ms     ${jank} frame(s) of ${totalFrames}   worst ` +
        `${Math.max(...withPerf.map((r) => r.perf!.worstMs))}ms`,
    );
    const gpuRuns = withPerf.filter((r) => r.perf!.gpuSamples > 0);
    if (gpuRuns.length > 0) {
      L.push(
        `    gpu           mean ${mean(gpuRuns.map((r) => r.perf!.gpuMeanMs)).toFixed(2)}ms   ` +
          `worst ${Math.max(...gpuRuns.map((r) => r.perf!.gpuWorstMs)).toFixed(2)}ms   ` +
          `n=${gpuRuns.length} run(s) with the timer extension`,
      );
    }
    if (starved > 0) {
      const affected = withPerf.filter((r) => r.perf!.starved > 0);
      L.push(
        `    !! ${starved} catch-up cap hit(s) across ${affected.length}/${withPerf.length} run(s)` +
          ` — those runs had sim time deleted and are NOT comparable on duration`,
      );
    }

    const devices = withPerf.filter((r) => r.device);
    if (devices.length > 0) {
      L.push('    ·');
      const gpus = tally(
        devices.filter((r) => r.device!.gpu),
        (r) => r.device!.gpu!,
      );
      for (const [gpu, n] of [...gpus].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
        const on = devices.filter((r) => r.device!.gpu === gpu);
        const worst = Math.max(...on.map((r) => r.perf!.worstMs));
        L.push(`    ${padr(gpu.slice(0, 40), 42)} n=${pad(n, 3)}  worst ${worst}ms`);
      }
      const noGpu = devices.length - [...gpus.values()].reduce((a, b) => a + b, 0);
      if (noGpu > 0) L.push(`    ${padr('(renderer string withheld)', 42)} n=${pad(noGpu, 3)}`);
      const backends = tally(
        devices.filter((r) => r.device!.backend),
        (r) => r.device!.backend!,
      );
      L.push(`    backends      ${[...backends].map(([b, n]) => `${b}(${n})`).join('  ')}`);
    }
    L.push('');
  }

  // ------------------------------------------------------------ run shape
  if (finished.length > 0) {
    L.push('  FINISHED RUNS');
    L.push(
      `    duration      median ${median(finished.map((r) => r.duration)).toFixed(0)}s` +
        `   mean ${mean(finished.map((r) => r.duration)).toFixed(0)}s`,
    );
    L.push(
      `    level         median ${median(finished.map((r) => r.level))}` +
        `   max ${Math.max(...finished.map((r) => r.level))}`,
    );
    L.push(
      `    score         median ${Math.round(median(finished.map((r) => r.score)))}` +
        `   max ${Math.max(...finished.map((r) => r.score))}`,
    );
    const byAxiom = new Map<string, Run[]>();
    for (const r of finished) byAxiom.set(r.axiomId, [...(byAxiom.get(r.axiomId) ?? []), r]);
    if (byAxiom.size > 1) {
      L.push('    ·');
      for (const [axiom, rs] of [...byAxiom].sort((a, b) => b[1].length - a[1].length)) {
        L.push(
          `    ${padr(axiom, 14)} n=${pad(rs.length, 4)}  ` +
            `median ${pad(median(rs.map((r) => r.duration)).toFixed(0) + 's', 6)}  ` +
            `lv ${median(rs.map((r) => r.level))}`,
        );
      }
    }
    L.push('');
  }

  // ---------------------------------------------------------------- the draft
  //
  // The one thing no counter of what people built could ever tell you. Because
  // the whole offer is recorded, this is a genuine conditional: of the times a
  // card was on the table, how often did somebody reach for it.
  const offered = new Map<string, number>();
  const taken = new Map<string, number>();
  let drafts = 0;
  for (const r of runs) {
    for (const e of r.events) {
      if (e.k !== 'draft') continue;
      drafts++;
      for (const id of (e.p?.o as string[]) ?? []) offered.set(id, (offered.get(id) ?? 0) + 1);
      const chosen = e.p?.c;
      if (typeof chosen === 'string') taken.set(chosen, (taken.get(chosen) ?? 0) + 1);
    }
  }

  L.push(`  DRAFT — ${drafts} decision(s), ${offered.size} distinct cards seen`);
  L.push(`    ${padr('card', 26)} ${pad('offered', 8)} ${pad('taken', 6)} ${pad('rate', 6)}`);
  const rows = [...offered.entries()]
    .map(([id, n]) => ({ id, n, t: taken.get(id) ?? 0, rate: (taken.get(id) ?? 0) / n }))
    .sort((a, b) => a.rate - b.rate || b.n - a.n);
  for (const row of rows) {
    const thin = row.n < minOffers ? '  (thin)' : '';
    L.push(
      `    ${padr(row.id, 26)} ${pad(row.n, 8)} ${pad(row.t, 6)} ${pad(pct(row.t, row.n), 6)}${thin}`,
    );
  }
  const dead = rows.filter((r) => r.t === 0 && r.n >= minOffers);
  if (dead.length > 0) {
    L.push('    ·');
    L.push(`    never taken at n>=${minOffers}: ${dead.map((r) => `${r.id}(${r.n})`).join(', ')}`);
  }
  L.push('');

  // ------------------------------------------------------------------- deaths
  const causes = new Map<string, number>();
  for (const r of finished) {
    if (r.cause) causes.set(r.cause, (causes.get(r.cause) ?? 0) + 1);
  }
  if (causes.size > 0) {
    L.push('  WHAT KILLED THEM');
    for (const [cause, n] of [...causes].sort((a, b) => b[1] - a[1])) {
      L.push(`    ${padr(cause, 26)} ${pad(n, 5)}  ${pad(pct(n, finished.length), 5)}`);
    }
    L.push('');
  }

  if (runs.length < 30) {
    L.push(
      `  Corpus is ${runs.length} run(s). Nothing here is a finding yet — offer counts` +
        ` are what\n  make a pick rate mean anything, and they need volume.`,
    );
    L.push('');
  }

  console.log(L.join('\n'));
}

main();
