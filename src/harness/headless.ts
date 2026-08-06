/**
 * Headless balance harness.
 *
 * Full determinism (GDD §0) means the sim runs without a renderer, so tuning the
 * [T] curves in §23.2 can be a measurement rather than a guess. Run:
 *
 *   pnpm sim                       # default sweep
 *   pnpm sim -- --runs 20 --minutes 8 --axiom feedback
 *   pnpm sim -- --progression default            # as a fresh account sees it
 *   pnpm sim -- --progression default --earned chain_reaction,deep_end
 *   pnpm sim -- --pool no_placeable_filter       # a draft variant, from data
 *   pnpm sim -- --pilot all                      # the same run, three tastes
 *   pnpm sim -- --out sweep.ndjson               # ...then: pnpm analytics -- --in sweep.ndjson --all
 *
 * `--out` writes each run in the same document shape the game reports itself in,
 * so `analytics.ts` reads a sweep and a corpus of real players with one code
 * path — including the offered/taken pick rates, which are the numbers a draft
 * change is actually judged on. The sweep's axes ride in `build` as
 * `sim:<pilot>/<pool>/<progression>`, which that tool can already filter by.
 *
 * Reported against the design targets in §2.2 and §8.1.
 *
 * ---
 *
 * **`--progression` is not a flag, it is the thing that was missing.** The sim
 * takes a set of node ids (`RunConfig.availableNodes`) and until now nothing
 * here ever passed one, so every sweep measured the full pool while the game
 * handed the player a gated one. That is not a small discrepancy: under the
 * curated profile the trigger class loses more than half its members, and a
 * tuning note taken here described a draft nobody was playing.
 *
 * The default stays "whatever profile is active", so this measures the shipped
 * game rather than a hypothesis about it.
 */
import { World } from '../sim/world';
import { SIM_DT } from '../sim/tunables';
import { applyDraft, rollDraft } from '../sim/draft';
import { botDraftChoice, botInput } from './bot';
import { ACTIVE_PILOT, PILOTS, pilot, type PilotDef } from './pilots';
import { AXIOMS, DRAFT_POOL } from '../content/index';
import { ACTIVE, progression, resolve } from '../meta/progression';
import { cardId } from '../sim/draft';
import { RunTelemetry, type TelemetryDoc } from '../meta/telemetry';
import { appendFileSync, writeFileSync } from 'node:fs';

interface Options {
  runs: number;
  minutes: number;
  axiom: string | null;
  seedPrefix: string;
  /** Whose taste plays the run. `all` sweeps every pilot. See pilots.ts. */
  pilot: string;
  /** Which gating graph, and how far into it this account is. */
  progression: string;
  earned: string[];
  /** §8.2 — which draft policy from draftpool.json. */
  pool: string | null;
  /** Where to write the sweep as a corpus, for `pnpm analytics --in`. */
  out: string | null;
  verbose: boolean;
}

function parseArgs(argv: readonly string[]): Options {
  const opts: Options = {
    runs: 8,
    minutes: 6,
    axiom: null,
    seedPrefix: 'harness',
    pilot: ACTIVE_PILOT.id,
    progression: ACTIVE.id,
    earned: [],
    pool: null,
    out: null,
    verbose: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--runs' && next) opts.runs = Number(next);
    else if (arg === '--minutes' && next) opts.minutes = Number(next);
    else if (arg === '--axiom' && next) opts.axiom = next;
    else if (arg === '--seed' && next) opts.seedPrefix = next;
    else if (arg === '--pilot' && next) opts.pilot = next;
    else if (arg === '--progression' && next) opts.progression = next;
    else if (arg === '--earned' && next) opts.earned = next.split(',').filter(Boolean);
    else if (arg === '--pool' && next) opts.pool = next;
    else if (arg === '--out' && next) opts.out = next;
    else if (arg === '--verbose') opts.verbose = true;
  }
  return opts;
}

interface RunResult {
  seed: string;
  axiom: string;
  survivedSeconds: number;
  died: boolean;
  level: number;
  levelIntervals: number[];
  peakEps: number;
  finalEps: number;
  score: number;
  kills: number;
  maxDepth: number;
  overheats: number;
  /** Fraction of the run spent in each Heat tier. */
  tierShare: [number, number, number, number];
  /**
   * §6.1 — static load as a share of capacity, sampled across the run.
   *
   * This slot used to hold `cyclesPerSec`, computed as `maxDepth / time`: a
   * cascade depth divided by seconds, left behind when the dynamic Cycle budget
   * was deleted. It printed `0/s` on every run of every axiom, under a heading
   * that read "cycle demand vs supply — 0% of budget", which is the headline
   * readout for the whole economy. A gauge that always reads zero is worse than
   * no gauge: it answers the question, and the answer is a lie.
   *
   * What `cycleCapacityBase`'s own comment claims — "a typical three-row Engine
   * around 70-85% reserved" — is a statement about *this* number, so this is the
   * number to report.
   */
  loadShareMean: number;
  loadSharePeak: number;
  peakHeat: number;
  firstLevelTime: number;
  kernels: number;
  kernelMultiplier: number;
  reachedMeltdown: boolean;
  meltdownSeconds: number;
  peakMultiplier: number;
  finalScore: number;
  ending: string;
  peakEnemies: number;
  misfireRate: number;
  safetyTrips: number;
  finalStaticLoad: number;
  capacity: number;
  engine: string[];
  /** The run reporting itself, in corpus shape. Null unless `--out` asked. */
  doc: TelemetryDoc | null;
}

/**
 * §23 — a simulated run reports itself in exactly the shape a real one does.
 *
 * `build` is where the sweep's identity goes, because `analytics.ts` can already
 * filter on it: `sim:<pilot>/<pool>/<progression>` makes every axis of a sweep a
 * `--build` query with no changes to the analyser at all.
 *
 * The alternative was a second aggregator over harness output, which is how a
 * pick rate ends up computed two ways that quietly disagree — the exact failure
 * the shared `cardId` helper was extracted to prevent. One analyser, two
 * sources: real players, and pilots.
 */
function simulateRun(
  seed: string,
  axiomId: string,
  minutes: number,
  flyer: PilotDef,
  availableNodes?: readonly string[],
  draftPoolId?: string | null,
  build?: string,
): RunResult {
  const burn = flyer.burn;
  const world = new World({
    seed,
    axiomId,
    ...(availableNodes ? { availableNodes } : {}),
    ...(draftPoolId ? { draftPoolId } : {}),
  });
  // Handed data that already exists, never asked to produce any. Observing a
  // draft by re-rolling it would consume a draw and change the run — the trap is
  // documented in record.ts and telemetry.ts, and this is a third place to fall
  // into it.
  // No player and no history: a bot has neither. Null rather than a synthetic
  // id, so a harness sweep can never be mistaken for the most dedicated user in
  // the corpus — and so `exp` segmentation only ever describes real people.
  const telemetry = build
    ? new RunTelemetry(seed, axiomId, {
        build,
        startedAt: Date.now(),
        pid: null,
        exp: null,
        fx: [],
      })
    : null;
  const totalTicks = Math.round((minutes * 60) / SIM_DT);
  const levelTimes: number[] = [];
  let lastLevel = world.level;
  // Once a second is plenty: static load only moves when the Engine does.
  const loadShares: number[] = [];
  let lastSuppressed = false;
  let markersSent = 0;

  for (let tick = 0; tick < totalTicks; tick++) {
    if (!world.player.alive) break;
    if (tick % 60 === 0 && world.budget.capacity > 0) {
      loadShares.push(world.engine.staticLoad / world.budget.capacity);
    }

    // Partial Recompile (DECISIONS D-28): the reference pilot sacrifices its
    // biggest producer and keeps the rest running, which is the whole point of
    // making the cost a dial rather than a cliff.
    if (world.pendingRecompileChoice) {
      world.pendingRecompileChoice = false;
      const live = world.engine.programs
        .map((_, i) => ({ i, share: world.outputShareOf([i]) }))
        .filter((r) => r.share > 0)
        .sort((a, b) => (burn === 'weak' ? a.share - b.share : b.share - a.share));
      if (live.length > 0) {
        const chosen = burn === 'all' ? live.map((r) => r.i) : [live[0]!.i];
        world.recompile(chosen);
      }
      world.pendingCeremony = null;
    }

    while (world.pendingDrafts > 0) {
      const offer = rollDraft(world);
      const choice = botDraftChoice(world, offer.cards, flyer);
      // Same event, same field names, same `c`-not-`k` for the chosen card as
      // game.ts emits. A corpus that spelled the pilot's decisions differently
      // from the players' would need two readers and would get two answers.
      if (telemetry) {
        const offered = offer.cards.map(cardId);
        telemetry.emit(world, 'draft', {
          o: offered,
          c: offered[choice] ?? null,
          lv: world.level,
          rows: world.engine.compiled.filter((x) => x.live).length,
          eps: Math.round(world.eps * 10) / 10,
          heat: Math.round(world.budget.heat),
          load: Math.round(world.engine.staticLoad * 10) / 10,
          cap: world.budget.capacity,
        });
      }
      applyDraft(world, offer.cards[choice]!);
    }

    if (world.level !== lastLevel) {
      levelTimes.push(world.time);
      lastLevel = world.level;
    }

    world.advance(botInput(world, flyer));
    telemetry?.sample(world);
    // The same two signals game.ts emits, from the same sources, so a sweep and
    // a corpus of real runs answer the same questions. A pilot that recorded
    // suppression differently from a player would need a second reader, and a
    // second reader is how two numbers that should agree stop agreeing.
    if (telemetry) {
      if (world.suppressedNow !== lastSuppressed) {
        lastSuppressed = world.suppressedNow;
        telemetry.emit(world, lastSuppressed ? 'suppress_in' : 'suppress_out', {
          lv: world.level,
          eps: Math.round(world.eps * 10) / 10,
        });
      }
      for (; markersSent < world.markers.length; markersSent++) {
        const m = world.markers[markersSent]!;
        telemetry.emit(world, `poi_${m.kind}`, { label: m.label, lv: world.level });
      }
    }
  }

  // `death` when it died, `quit` when the sweep's clock ran out — never null,
  // which the corpus reads as "abandoned, still open" and would count a
  // completed sweep as a pile of runs that lost somebody.
  const doc = telemetry?.snapshot(world, world.player.alive ? 'quit' : 'death') ?? null;

  const intervals: number[] = [];
  for (let i = 1; i < levelTimes.length; i++) {
    intervals.push(levelTimes[i]! - levelTimes[i - 1]!);
  }

  const engine = world.engine.programs
    .map((p, i) => {
      const compiled = world.engine.compiled[i]!;
      if (!compiled.live) return null;
      const mods = p.modifierIds.filter(Boolean).join(' -> ');
      return `${p.triggerId} -> ${mods ? mods + ' -> ' : ''}${p.actionId}`;
    })
    .filter((s): s is string => s !== null);

  return {
    doc,
    seed,
    axiom: axiomId,
    survivedSeconds: world.time,
    died: !world.player.alive,
    level: world.level,
    levelIntervals: intervals,
    peakEps: world.stats.peakEps,
    finalEps: world.eps,
    score: world.score,
    kills: world.stats.kills,
    maxDepth: world.stats.maxDepth,
    overheats: world.stats.overheats,
    tierShare: world.stats.tierSeconds.map((s) => (world.time > 0 ? s / world.time : 0)) as [
      number,
      number,
      number,
      number,
    ],
    loadShareMean: mean(loadShares),
    loadSharePeak: loadShares.length > 0 ? Math.max(...loadShares) : 0,
    peakHeat: world.stats.peakHeat,
    firstLevelTime: world.stats.firstLevelTime,
    kernels: world.kernels,
    kernelMultiplier: world.engine.kernel,
    reachedMeltdown: world.phase === 'meltdown',
    meltdownSeconds: world.meltdownTime,
    peakMultiplier: world.peakMeltdownMultiplier,
    finalScore: world.finalScore().total,
    ending: world.ending,
    peakEnemies: world.stats.peakConcurrentEnemies,
    misfireRate: world.stats.fires > 0 ? world.stats.misfires / world.stats.fires : 0,
    safetyTrips: world.stats.safetyTrips,
    finalStaticLoad: world.engine.staticLoad,
    capacity: world.budget.capacity,
    engine,
  };
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}

function pad(s: string | number, width: number): string {
  return String(s).padStart(width);
}

function main(): void {
  const opts = parseArgs(process.argv.slice(2));
  const prog = progression(opts.progression);
  const library = resolve(opts.earned, { progression: prog });
  // The Axioms to sweep are the ones this account actually has. Measuring
  // Feedback against a profile that gates it produces a column of numbers for a
  // run the player cannot start.
  const axioms = opts.axiom ? [opts.axiom] : library.axioms;
  // `--pilot all` is the point of pilots being data: the same run measured by
  // three different tastes. A number that only holds for one of them is a
  // statement about that pilot, not about the game.
  const flyers = opts.pilot === 'all' ? PILOTS : [pilot(opts.pilot)];

  const total = AXIOMS.length;
  console.log(
    `\n  headless sweep — ${opts.runs} run(s) x ${opts.minutes} min x ${axioms.length} axiom(s)` +
      ` x ${flyers.length} pilot(s)` +
      `\n  progression: ${prog.id}` +
      (opts.earned.length ? ` +${opts.earned.length} earned` : '') +
      `  ·  library ${library.nodes.length} nodes, ${library.axioms.length}/${total} axioms` +
      `  ·  draft policy: ${opts.pool ?? DRAFT_POOL.id}\n`,
  );

  const all: RunResult[] = [];
  // Truncate up front, so a sweep never silently appends to yesterday's corpus
  // and reports a comparison across two sets of tunables as one population.
  if (opts.out) writeFileSync(opts.out, '');

  for (const flyer of flyers) {
    if (flyers.length > 1) {
      console.log(`  ── pilot: ${flyer.id}  (recompile ${flyer.recompile}/${flyer.burn})\n`);
    }
    for (const axiomId of axioms) {
    const results: RunResult[] = [];
    const build = opts.out
      ? `sim:${flyer.id}/${opts.pool ?? DRAFT_POOL.id}/${prog.id}`
      : undefined;
    for (let i = 0; i < opts.runs; i++) {
      results.push(
        simulateRun(
          `${opts.seedPrefix}-${i}`,
          axiomId,
          opts.minutes,
          flyer,
          library.nodes,
          opts.pool,
          build,
        ),
      );
    }
    if (opts.out) {
      const docs = results.map((r) => r.doc).filter((d): d is TelemetryDoc => d !== null);
      appendFileSync(opts.out, docs.map((d) => JSON.stringify(d)).join('\n') + '\n');
    }
    all.push(...results);

    const deaths = results.filter((r) => r.died);
    const allIntervals = results.flatMap((r) => r.levelIntervals);

    console.log(`  ${axiomId.toUpperCase()}`);
    console.log(
      `    survived      ${pad(mean(results.map((r) => r.survivedSeconds)).toFixed(1), 8)}s mean` +
        `   (${deaths.length}/${results.length} died)`,
    );
    console.log(
      `    draft cadence ${pad(median(allIntervals).toFixed(1), 8)}s median` +
        `  ${mean(allIntervals).toFixed(1)}s mean   target 30-45s  [§8.1]`,
    );
    console.log(
      `    first level   ${pad(mean(results.map((r) => r.firstLevelTime)).toFixed(1), 8)}s` +
        `   (the opening must not stall — §3)`,
    );
    console.log(`    level reached ${pad(mean(results.map((r) => r.level)).toFixed(1), 8)}`);
    console.log(`    peak EPS      ${pad(mean(results.map((r) => r.peakEps)).toFixed(1), 8)}`);
    console.log(`    score         ${pad(mean(results.map((r) => r.finalScore)).toFixed(0), 8)}`);
    console.log(
      `    recompiles    ${pad(mean(results.map((r) => r.kernels)).toFixed(1), 8)}` +
        `   kernel ×${mean(results.map((r) => r.kernelMultiplier)).toFixed(2)}   [§9.2 target 2-3]`,
    );
    console.log(
      `    meltdown      ${pad(results.filter((r) => r.reachedMeltdown).length, 8)}/${results.length} runs` +
        `   +${mean(results.map((r) => r.meltdownSeconds)).toFixed(0)}s` +
        `   peak ×${mean(results.map((r) => r.peakMultiplier)).toFixed(2)}`,
    );
    const endings = results.reduce<Record<string, number>>((acc, r) => {
      acc[r.ending] = (acc[r.ending] ?? 0) + 1;
      return acc;
    }, {});
    console.log(
      `    endings       ${Object.entries(endings)
        .map(([k, v]) => `${k} ${v}`)
        .join('  ')}`,
    );
    console.log(`    kills         ${pad(mean(results.map((r) => r.kills)).toFixed(0), 8)}`);
    console.log(`    max depth     ${pad(mean(results.map((r) => r.maxDepth)).toFixed(1), 8)}`);
    console.log(`    overheats     ${pad(mean(results.map((r) => r.overheats)).toFixed(1), 8)}`);
    console.log(
      `    heat tiers    ` +
        `nominal ${(mean(results.map((r) => r.tierShare[0])) * 100).toFixed(0)}%` +
        `  inst-I ${(mean(results.map((r) => r.tierShare[1])) * 100).toFixed(0)}%` +
        `  inst-II ${(mean(results.map((r) => r.tierShare[2])) * 100).toFixed(0)}%` +
        `   peak heat ${mean(results.map((r) => r.peakHeat)).toFixed(0)}`,
    );
    console.log(`    peak enemies  ${pad(mean(results.map((r) => r.peakEnemies)).toFixed(0), 8)}`);
    console.log(
      `    misfire rate  ${pad((mean(results.map((r) => r.misfireRate)) * 100).toFixed(1), 8)}%`,
    );
    console.log(
      `    load/capacity ${pad(mean(results.map((r) => r.finalStaticLoad)).toFixed(1), 8)}` +
        ` / ${mean(results.map((r) => r.capacity)).toFixed(0)}` +
        `   reserved ${(mean(results.map((r) => r.loadShareMean)) * 100).toFixed(0)}% mean,` +
        ` ${(mean(results.map((r) => r.loadSharePeak)) * 100).toFixed(0)}% peak   [§6.1 target 70-85%]`,
    );

    if (opts.verbose) {
      for (const r of results) {
        console.log(`      ${r.seed}: ${r.engine.join('  |  ') || '(no live programs)'}`);
      }
    }
    console.log('');
    }
  }

  const trips = all.reduce((s, r) => s + r.safetyTrips, 0);
  if (trips > 0) {
    console.log(`  !! ${trips} runtime safety-valve trips — investigate, do not tune (§5.2)\n`);
  }

  // §23.3 testing invariants, checked automatically where they are measurable.
  const cadence = median(all.flatMap((r) => r.levelIntervals));
  const inBand = cadence >= 30 && cadence <= 45;
  console.log(
    `  §8.1 draft cadence 30-45s: ${inBand ? 'PASS' : 'OUT OF BAND'} (median ${cadence.toFixed(1)}s)`,
  );
  console.log(`  §5.2 depth cap respected: ${all.every((r) => r.maxDepth <= 12) ? 'PASS' : 'FAIL'}`);
  if (opts.out) {
    console.log(
      `\n  wrote ${all.length} run(s) to ${opts.out}` +
        `\n  read them with:  pnpm analytics -- --in ${opts.out} --all`,
    );
  }
  console.log('');
}

main();
