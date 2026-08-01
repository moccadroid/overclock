/**
 * Headless balance harness.
 *
 * Full determinism (GDD §0) means the sim runs without a renderer, so tuning the
 * [T] curves in §23.2 can be a measurement rather than a guess. Run:
 *
 *   pnpm sim                       # default sweep
 *   pnpm sim -- --runs 20 --minutes 8 --axiom feedback
 *
 * Reported against the design targets in §2.2 and §8.1.
 */
import { World } from '../sim/world';
import { SIM_DT, TUNABLE } from '../sim/tunables';
import { applyDraft, rollDraft } from '../sim/draft';
import { botDraftChoice, botInput } from './bot';
import { AXIOMS } from '../content/index';

interface Options {
  runs: number;
  minutes: number;
  axiom: string | null;
  seedPrefix: string;
  verbose: boolean;
}

function parseArgs(argv: readonly string[]): Options {
  const opts: Options = {
    runs: 8,
    minutes: 6,
    axiom: null,
    seedPrefix: 'harness',
    verbose: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--runs' && next) opts.runs = Number(next);
    else if (arg === '--minutes' && next) opts.minutes = Number(next);
    else if (arg === '--axiom' && next) opts.axiom = next;
    else if (arg === '--seed' && next) opts.seedPrefix = next;
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
  peakEnemies: number;
  misfireRate: number;
  safetyTrips: number;
  finalStaticLoad: number;
  capacity: number;
  engine: string[];
}

function simulateRun(seed: string, axiomId: string, minutes: number): RunResult {
  const world = new World({ seed, axiomId });
  const totalTicks = Math.round((minutes * 60) / SIM_DT);
  const levelTimes: number[] = [];
  let lastLevel = world.level;

  for (let tick = 0; tick < totalTicks; tick++) {
    if (!world.player.alive) break;

    while (world.pendingDrafts > 0) {
      const offer = rollDraft(world);
      const choice = botDraftChoice(world, offer.cards);
      applyDraft(world, offer.cards[choice]!);
    }

    if (world.level !== lastLevel) {
      levelTimes.push(world.time);
      lastLevel = world.level;
    }

    world.advance(botInput(world));
  }

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
  const axioms = opts.axiom ? [opts.axiom] : AXIOMS.map((a) => a.id);

  console.log(
    `\n  headless sweep — ${opts.runs} run(s) x ${opts.minutes} min x ${axioms.length} axiom(s)\n`,
  );

  const all: RunResult[] = [];

  for (const axiomId of axioms) {
    const results: RunResult[] = [];
    for (let i = 0; i < opts.runs; i++) {
      results.push(simulateRun(`${opts.seedPrefix}-${i}`, axiomId, opts.minutes));
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
        `   target ${TUNABLE.xpBase ? '30-45' : '?'}s  [§8.1]`,
    );
    console.log(`    level reached ${pad(mean(results.map((r) => r.level)).toFixed(1), 8)}`);
    console.log(`    peak EPS      ${pad(mean(results.map((r) => r.peakEps)).toFixed(1), 8)}`);
    console.log(`    score         ${pad(mean(results.map((r) => r.score)).toFixed(0), 8)}`);
    console.log(`    kills         ${pad(mean(results.map((r) => r.kills)).toFixed(0), 8)}`);
    console.log(`    max depth     ${pad(mean(results.map((r) => r.maxDepth)).toFixed(1), 8)}`);
    console.log(`    overheats     ${pad(mean(results.map((r) => r.overheats)).toFixed(1), 8)}`);
    console.log(`    peak enemies  ${pad(mean(results.map((r) => r.peakEnemies)).toFixed(0), 8)}`);
    console.log(
      `    misfire rate  ${pad((mean(results.map((r) => r.misfireRate)) * 100).toFixed(1), 8)}%`,
    );
    console.log(
      `    load/capacity ${pad(mean(results.map((r) => r.finalStaticLoad)).toFixed(1), 8)}` +
        ` / ${mean(results.map((r) => r.capacity)).toFixed(0)}`,
    );

    if (opts.verbose) {
      for (const r of results) {
        console.log(`      ${r.seed}: ${r.engine.join('  |  ') || '(no live programs)'}`);
      }
    }
    console.log('');
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
  console.log('');
}

main();
