/**
 * What actually happened in a run. GDD §23.
 *
 * "It felt weak" is not a bug report and it is not tunable. This turns a
 * recording into numbers: what was offered, what was taken, when the Engine
 * stopped keeping up, what killed you, and which of your rows were doing the
 * work.
 *
 * It reads a replay rather than instrumenting the sim, which is the whole point
 * of `record.ts` existing. Nothing here can affect a run — it cannot even be
 * reached from one — so an analysis pass can be as expensive and as invasive as
 * it likes. It also means the same code that checks *my* run checks a thousand
 * of them, which is the only way pick rates and dead nodes ever get found.
 */
import { replay, type Recording } from './record';
import type { World } from './world';
import { rollDraft, type DraftCard } from './draft';
import { SIM_DT } from './tunables';

export interface DraftMoment {
  t: number;
  level: number;
  /** Everything that was on the table, so a *refusal* is visible too. */
  offered: string[];
  taken: string;
  /** Rows live at the moment of the choice — the state the decision was made in. */
  liveRows: number;
  eps: number;
}

export interface Sample {
  t: number;
  eps: number;
  level: number;
  integrity: number;
  enemies: number;
  heat: number;
  liveRows: number;
  staticLoad: number;
  capacity: number;
}

export interface Analysis {
  ok: boolean;
  divergedAt: number | null;
  seed: string;
  axiomId: string;
  duration: number;
  /** One sample a second. The shape of the run, not its every frame. */
  samples: Sample[];
  drafts: DraftMoment[];
  /** Node ids offered and never taken — the pool's dead weight. */
  refused: { id: string; offered: number; taken: number }[];
  finalEngine: { row: string; live: boolean; share: number }[];
  deaths: { cause: string; amount: number }[];
  stats: {
    kills: number;
    score: number;
    maxDepth: number;
    peakEps: number;
    overheats: number;
    damageTaken: number;
    firstLevelTime: number;
    safetyTrips: number;
    misfireRate: number;
    tierSeconds: number[];
  };
  /** Plain-English observations. The part a human reads first. */
  notes: string[];
}

function rowText(world: World, i: number): string {
  const p = world.engine.programs[i];
  if (!p) return '';
  return [p.triggerId, ...p.modifierIds.filter(Boolean), p.actionId].filter(Boolean).join(' > ');
}

function cardId(card: DraftCard): string {
  if (card.kind === 'node') return card.nodeId;
  if (card.kind === 'stat') return `stat:${card.stat}`;
  if (card.kind === 'tool') return `tool:${card.tool}`;
  return card.kind;
}

/**
 * Replay a recording and describe it.
 *
 * The draft moments are the expensive part and also the interesting one: at
 * every `draft` command the offer is re-rolled *before* it is applied, so we can
 * see the three cards the player was actually looking at. That is the difference
 * between knowing what someone built and knowing what they turned down.
 */
export function analyse(recording: Recording): Analysis {
  const samples: Sample[] = [];
  const drafts: DraftMoment[] = [];
  const offered = new Map<string, number>();
  const taken = new Map<string, number>();

  const result = replay(
    recording,
    {
      // Handed the offer that was already rolled, rather than rolling one of its
      // own. See ReplayHooks.onDraft — looking costs a draw from the Rng, and a
      // measurement that costs anything is measuring a different run.
      onDraft: (world, cards, chosen, tick) => {
        const ids = cards.map(cardId);
        for (const id of ids) offered.set(id, (offered.get(id) ?? 0) + 1);
        const took = ids[chosen];
        if (took) taken.set(took, (taken.get(took) ?? 0) + 1);
        drafts.push({
          t: Number((tick * SIM_DT).toFixed(1)),
          level: world.level,
          offered: ids,
          taken: took ?? '?',
          liveRows: world.engine.compiled.filter((c) => c.live).length,
          eps: Number(world.eps.toFixed(1)),
        });
      },
      onTick: (world, tick) => {
        if (tick % 60 !== 0) return;
        samples.push({
          t: Number((tick * SIM_DT).toFixed(1)),
          eps: Number(world.eps.toFixed(1)),
          level: world.level,
          integrity: Math.ceil(world.player.integrity),
          enemies: world.enemies.length,
          heat: Math.round(world.budget.heat),
          liveRows: world.engine.compiled.filter((c) => c.live).length,
          staticLoad: Number(world.engine.staticLoad.toFixed(1)),
          capacity: world.budget.capacity,
        });
      },
    },
    // Analysis reports a divergence rather than stopping at it: a run that no
    // longer replays is exactly the run somebody most wants to look at, and half
    // an answer with a loud warning beats no answer.
    { stopOnDiverge: false },
  );

  const world = result.world;

  const finalEngine = world.engine.programs.map((_, i) => ({
    row: rowText(world, i),
    live: world.engine.compiled[i]?.live ?? false,
    share: Number(world.outputShareOf([i]).toFixed(3)),
  }));

  const deaths = [...world.damageBySource.values()]
    .sort((a, b) => b.amount - a.amount)
    .map((d) => ({ cause: d.source.label, amount: Math.round(d.amount) }));

  const refused = [...offered.entries()]
    .map(([id, n]) => ({ id, offered: n, taken: taken.get(id) ?? 0 }))
    .filter((r) => r.taken === 0)
    .sort((a, b) => b.offered - a.offered);

  const stats = {
    kills: world.stats.kills,
    score: Math.floor(world.score),
    maxDepth: world.stats.maxDepth,
    peakEps: Number(world.stats.peakEps.toFixed(1)),
    overheats: world.stats.overheats,
    damageTaken: Math.round(world.stats.damageTaken),
    firstLevelTime: Number(world.stats.firstLevelTime.toFixed(1)),
    safetyTrips: world.stats.safetyTrips,
    misfireRate:
      world.stats.fires + world.stats.misfires > 0
        ? Number((world.stats.misfires / (world.stats.fires + world.stats.misfires)).toFixed(3))
        : 0,
    tierSeconds: world.stats.tierSeconds.map((s) => Number(s.toFixed(1))),
  };

  return {
    ok: result.divergedAt === null,
    divergedAt: result.divergedAt,
    seed: recording.config.seed,
    axiomId: recording.config.axiomId,
    duration: Number((result.ticks * SIM_DT).toFixed(1)),
    samples,
    drafts,
    refused,
    finalEngine,
    deaths,
    stats,
    notes: observe(samples, drafts, stats, finalEngine, result.divergedAt),
  };
}

/**
 * The part a person reads.
 *
 * Every one of these is a threshold somebody would otherwise have to eyeball a
 * chart to notice, and each says what it means rather than only what it is. They
 * are deliberately conservative: a note that fires on a healthy run teaches you
 * to ignore the notes.
 */
function observe(
  samples: Sample[],
  drafts: DraftMoment[],
  stats: Analysis['stats'],
  engine: Analysis['finalEngine'],
  divergedAt: number | null,
): string[] {
  const notes: string[] = [];

  if (divergedAt !== null) {
    notes.push(
      `REPLAY DIVERGED at tick ${divergedAt}. The sim changed since this was ` +
        `recorded, so everything below describes a run that never happened.`,
    );
  }

  if (stats.safetyTrips > 0) {
    notes.push(
      `${stats.safetyTrips} safety valve trips — that is a bug to investigate, ` +
        `not a number to tune.`,
    );
  }

  if (stats.firstLevelTime > 45) {
    notes.push(
      `First level-up took ${stats.firstLevelTime}s. §3 asks for a decision every ` +
        `~30s, so the opening is slow.`,
    );
  }

  const liveAtEnd = engine.filter((r) => r.live).length;
  if (liveAtEnd <= 1) {
    notes.push(
      `Ended with ${liveAtEnd} live row. Either the draft starved this run of ` +
        `Triggers and Actions, or capacity did.`,
    );
  }

  // The spiral: EPS flat or falling while enemies climb is the failure mode the
  // draft weighting exists to prevent, and it is invisible in a summary.
  const mid = samples.slice(Math.floor(samples.length / 3));
  if (mid.length > 6) {
    const first = mid.slice(0, Math.floor(mid.length / 2));
    const last = mid.slice(Math.floor(mid.length / 2));
    const avg = (rows: Sample[], f: (s: Sample) => number): number =>
      rows.reduce((n, s) => n + f(s), 0) / rows.length;
    const epsBefore = avg(first, (s) => s.eps);
    const epsAfter = avg(last, (s) => s.eps);
    const enemiesBefore = avg(first, (s) => s.enemies);
    const enemiesAfter = avg(last, (s) => s.enemies);
    if (epsAfter < epsBefore * 1.05 && enemiesAfter > enemiesBefore * 1.3) {
      notes.push(
        `Spiral: EPS went ${epsBefore.toFixed(1)} -> ${epsAfter.toFixed(1)} while the ` +
          `crowd went ${enemiesBefore.toFixed(0)} -> ${enemiesAfter.toFixed(0)}. The ` +
          `Engine stopped keeping up with the wave curve.`,
      );
    }
  }

  const overCapacity = samples.filter((s) => s.staticLoad > s.capacity * 0.9).length;
  if (overCapacity > samples.length * 0.4) {
    notes.push(
      `Static load sat above 90% of capacity for ${Math.round((overCapacity / samples.length) * 100)}% ` +
        `of the run. Capacity is the binding constraint here, not the draft.`,
    );
  }

  if (stats.misfireRate > 0.25) {
    notes.push(
      `${Math.round(stats.misfireRate * 100)}% of Trigger fires misfired — the Engine ` +
        `was asking for more than the budget allowed most of the time.`,
    );
  }

  const hot = stats.tierSeconds[2]! + stats.tierSeconds[3]!;
  const total = stats.tierSeconds.reduce((a, b) => a + b, 0);
  if (total > 0 && hot > total * 0.3) {
    notes.push(
      `${Math.round((hot / total) * 100)}% of the run in Heat tier 2+. §6.3 wants that ` +
        `to be a place you visit, not where you live.`,
    );
  }

  if (drafts.length > 0) {
    const stats2 = drafts.filter((d) => d.taken.startsWith('stat:')).length;
    if (stats2 > drafts.length * 0.4) {
      notes.push(
        `${stats2}/${drafts.length} drafts took a stat. Either the node offers were ` +
          `weak or the stats are too strong.`,
      );
    }
  }

  if (notes.length === 0) notes.push('Nothing anomalous. A run that behaved.');
  return notes;
}

/**
 * The play-by-play, as text.
 *
 * Deliberately something you can paste into a message. A chart is better for
 * spotting a shape and much worse for saying "at 3:12 you were offered Echo,
 * Split and +8 Power with two live rows, and took the Power."
 */
export function report(a: Analysis): string {
  const clock = (t: number): string =>
    `${Math.floor(t / 60)}:${Math.floor(t % 60)
      .toString()
      .padStart(2, '0')}`;

  const lines: string[] = [
    `${a.seed} · ${a.axiomId} · ${clock(a.duration)} · ${a.stats.score.toLocaleString()} pts`,
    a.ok ? '' : `!! replay diverged at tick ${a.divergedAt}`,
    '',
    'NOTES',
    ...a.notes.map((n) => `  · ${n}`),
    '',
    'RUN',
    '  time   eps  lvl  hp  enemies  heat  rows  load/cap',
  ];

  for (const s of a.samples.filter((_, i) => i % 10 === 0)) {
    lines.push(
      `  ${clock(s.t).padStart(5)} ${String(s.eps).padStart(5)} ${String(s.level).padStart(4)}` +
        ` ${String(s.integrity).padStart(3)} ${String(s.enemies).padStart(8)}` +
        ` ${String(s.heat).padStart(5)} ${String(s.liveRows).padStart(5)}` +
        `  ${s.staticLoad}/${s.capacity}`,
    );
  }

  lines.push('', 'DRAFTS');
  for (const d of a.drafts) {
    const rest = d.offered.filter((id) => id !== d.taken);
    lines.push(
      `  ${clock(d.t).padStart(5)} lv${String(d.level).padStart(2)} ` +
        `${d.liveRows} live · took ${d.taken}` +
        (rest.length ? `  (passed ${rest.join(', ')})` : ''),
    );
  }

  if (a.refused.length) {
    lines.push('', 'OFFERED AND NEVER TAKEN');
    for (const r of a.refused.slice(0, 12)) lines.push(`  ${r.id} x${r.offered}`);
  }

  lines.push('', 'FINAL ENGINE');
  for (const r of a.finalEngine) {
    if (!r.row) continue;
    lines.push(`  ${r.live ? '*' : ' '} ${r.row}${r.live ? `  ${Math.round(r.share * 100)}%` : ''}`);
  }

  if (a.deaths.length) {
    lines.push('', 'DAMAGE TAKEN');
    for (const d of a.deaths.slice(0, 8)) lines.push(`  ${d.cause}  ${d.amount}`);
  }

  lines.push(
    '',
    `kills ${a.stats.kills} · depth ${a.stats.maxDepth} · peak ${a.stats.peakEps} eps · ` +
      `overheats ${a.stats.overheats} · misfire ${Math.round(a.stats.misfireRate * 100)}%`,
  );

  return lines.filter((l) => l !== '' || true).join('\n');
}

/** Re-derive the offer at a draft, for tooling that wants the cards themselves. */
export function offerAt(world: World): DraftCard[] {
  return [...rollDraft(world).cards];
}
