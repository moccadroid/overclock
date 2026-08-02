/**
 * The Results screen. GDD §14.
 *
 * The run trace is the hero element, not a footnote: a single horizontal chart
 * of EPS over the run, annotated with level-ups, Recompiles (visible as
 * cliffs-then-spikes — the prestige rhythm made visible), Meltdown and death.
 * That chart is the run's story, and everything else is annotation around it.
 *
 * Drawn as inline SVG so it stays in the same stroke-and-type vocabulary as the
 * rest of the schematic (§16: no sprites, no textures, ever).
 */
import {
  AXIOM_BY_ID,
  DISCOVERIES,
  DISCOVERY_BY_ID,
  NODE_BY_ID,
} from '../content/index';
import type { Library } from '../meta/profile';
import { TUNABLE } from '../sim/tunables';
import type { TraceMarkerKind, World } from '../sim/world';
import { BRANDING } from '../branding';
import { shapeSvg } from './gfx/shapes';

const MARKER_COLOR: Record<TraceMarkerKind, string> = {
  level: '#3f5570',
  beacon: '#9fd0ff',
  recompile: '#b44cff',
  meltdown: '#ffb000',
  extract: '#ffb000',
  death: '#ff2a3c',
};

const CHART_W = 900;
const CHART_H = 210;

function svgEscape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function clockLabel(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/** The EPS run-trace, as an annotated schematic chart. */
function renderTrace(world: World): string {
  const trace = world.trace;
  const duration = Math.max(1, world.time);
  const peak = Math.max(1, ...trace.map((s) => s.eps));

  const x = (t: number): number => (t / duration) * CHART_W;
  const y = (eps: number): number => CHART_H - (eps / peak) * (CHART_H - 12);

  const line =
    trace.length > 1
      ? trace.map((s, i) => `${i === 0 ? 'M' : 'L'}${x(s.t).toFixed(1)},${y(s.eps).toFixed(1)}`).join(' ')
      : '';
  const area = line ? `${line} L${CHART_W},${CHART_H} L0,${CHART_H} Z` : '';

  // Gridlines every minute, in the same band-5 language as the arena grid.
  const minutes: string[] = [];
  for (let t = 60; t < duration; t += 60) {
    const px = x(t).toFixed(1);
    minutes.push(
      `<line x1="${px}" y1="0" x2="${px}" y2="${CHART_H}" stroke="#2a3a52" stroke-width="1" opacity="0.5"/>` +
        `<text x="${px}" y="${CHART_H + 14}" fill="#3f5570" font-size="10" text-anchor="middle">${clockLabel(t)}</text>`,
    );
  }

  const markers = world.markers
    .filter((m) => m.kind !== 'level' || world.markers.length < 40)
    .map((m) => {
      const at = x(m.t);
      const px = at.toFixed(1);
      const color = MARKER_COLOR[m.kind];
      const big = m.kind !== 'level' && m.kind !== 'beacon';
      let label = '';
      if (big) {
        // Anchor labels inward near the edges, or they overflow the viewBox and
        // get clipped — which is how "CONTAINED" became "CONTAI".
        const anchor = at < 60 ? 'start' : at > CHART_W - 60 ? 'end' : 'middle';
        const tx = anchor === 'start' ? 2 : anchor === 'end' ? CHART_W - 2 : at;
        label =
          `<text x="${tx.toFixed(1)}" y="-6" fill="${color}" font-size="10" ` +
          `text-anchor="${anchor}">${svgEscape(m.label)}</text>`;
      }
      return (
        `<line x1="${px}" y1="${big ? 0 : CHART_H - 18}" x2="${px}" y2="${CHART_H}" ` +
        `stroke="${color}" stroke-width="${big ? 1.5 : 1}" opacity="${big ? 0.9 : 0.45}"/>` +
        label
      );
    })
    .join('');

  return `
    <svg class="trace" viewBox="-8 -22 ${CHART_W + 16} ${CHART_H + 44}" width="100%">
      <rect x="0" y="0" width="${CHART_W}" height="${CHART_H}" fill="none" stroke="#2a3a52" stroke-width="1"/>
      ${minutes.join('')}
      ${area ? `<path d="${area}" fill="#00e5ff" opacity="0.10"/>` : ''}
      ${line ? `<path d="${line}" fill="none" stroke="#00e5ff" stroke-width="1.5"/>` : ''}
      ${markers}
      <text x="4" y="12" fill="#3f5570" font-size="10">EPS · peak ${peak.toFixed(0)}</text>
    </svg>`;
}

function renderEngine(world: World): string {
  const rows = world.engine.programs
    .map((p, i) => {
      if (!world.engine.compiled[i]?.live) return null;
      const parts = [nodeName(p.triggerId)];
      for (const m of p.modifierIds) if (m) parts.push(nodeName(m));
      parts.push(nodeName(p.actionId));
      return `  ${parts.join(' › ')}`;
    })
    .filter(Boolean);
  return rows.length > 0 ? rows.join('\n') : '  (no live programs)';
}

function nodeName(id: string | null): string {
  if (!id) return '·';
  return NODE_BY_ID.get(id)?.name ?? id;
}

/** §14 — no shaming language anywhere. */
function headline(world: World): string {
  if (world.ending === 'contained') {
    return `CONTAINED — after ${world.meltdownTime.toFixed(0)}s of divergence`;
  }
  if (world.ending === 'extracted') return 'EXTRACTED — banked at ×1.0';
  return 'GARBAGE COLLECTED';
}

/**
 * §14 — "how did I die" is the one question a Results screen must answer, and
 * the honest answer has two halves: the blow that landed, and the thing that had
 * been grinding you down all run. They are usually different, and the gap
 * between them is the lesson.
 */
function renderPostMortem(world: World): string {
  const cause = world.deathCause;
  if (!cause) return '';

  const sorted = [...world.damageBySource.values()].sort((a, b) => b.amount - a.amount);
  const total = sorted.reduce((s, e) => s + e.amount, 0);
  const rows = sorted
    .slice(0, 5)
    .map(({ source, amount }) => {
      const pct = total > 0 ? (amount / total) * 100 : 0;
      const meter = '█'.repeat(Math.max(1, Math.round(pct / 5)));
      return (
        `<div class="pm-row">${shapeSvg(source.shape, 15, '#8ba3bd')}` +
        `<span class="pm-src">${svgEscape(source.label)}</span>` +
        `<span class="pm-bar">${meter}</span>` +
        `<span class="pm-pct">${pct.toFixed(0)}%</span></div>`
      );
    })
    .join('');

  return (
    `<div class="postmortem">` +
    `<div class="k">killed by</div>` +
    `<div class="pm-blow">${shapeSvg(cause.shape, 30, '#ff2a3c')}` +
    `<span class="pm-name">${svgEscape(cause.label)}</span>` +
    (cause.mode ? `<span class="pm-mode">${svgEscape(cause.mode)}</span>` : '') +
    `</div>` +
    `<div class="k">damage taken, by source</div>${rows}` +
    `</div>`
  );
}

/**
 * §15.3 — what this run added to the Library, and the nearest thing you have not
 * done yet. The second half is the load-bearing one: a Results screen that only
 * looks backwards ends the session, and one that names a reachable next thing
 * starts another run.
 */
function renderDiscoveries(world: World, library: Library): string {
  const earned = [...world.discoveries.earned];
  const held = library.earnedDiscoveries;

  const rows = earned
    .map((id) => {
      const def = DISCOVERY_BY_ID.get(id);
      if (!def) return '';
      const names = def.unlocks
        .map((u) => NODE_BY_ID.get(u)?.name ?? AXIOM_BY_ID.get(u)?.name ?? u)
        .join(' · ');
      return (
        `<div class="disc-row"><span class="disc-name">${svgEscape(def.name)}</span>` +
        (names ? `<span class="disc-unlock">+ ${svgEscape(names)}</span>` : '') +
        `</div>`
      );
    })
    .join('');

  // The next three you have not earned, in the order they are written — which is
  // roughly the order they get hard.
  const next = DISCOVERIES.filter((d) => !held.has(d.id) && !world.discoveries.earned.has(d.id))
    .slice(0, 3)
    .map((d) => `<div class="disc-todo">${svgEscape(d.hint)}</div>`)
    .join('');

  const total = DISCOVERIES.length;
  const have = new Set([...held, ...world.discoveries.earned]).size;

  return (
    `<div class="discoveries">` +
    (rows ? `<div class="k">discovered this run</div>${rows}` : '') +
    (next ? `<div class="k">still out there  ${have}/${total}</div>${next}` : '') +
    `</div>`
  );
}

export function renderResults(world: World, library: Library): string {
  const score = world.finalScore();
  const wasted = world.kernels === 0 ? world.wastedKernelPercent : 0;

  const lines: string[] = [
    `time              ${clockLabel(world.time)}`,
    `output (∫EPS)     ${score.output.toLocaleString()}`,
    `peak EPS          ${world.stats.peakEps.toFixed(1)}`,
    `meltdown peak     ×${score.multiplier.toFixed(2)}`,
    `kernels           ${world.kernels}  (+${score.kernelBonus})`,
    `mirror kills      0  (+0)`,
    `─────────────────────────────`,
    `SCORE             ${score.total.toLocaleString()}`,
    ``,
    `kills             ${world.stats.kills.toLocaleString()}`,
    `events            ${world.stats.events.toLocaleString()}`,
    `deepest cascade   ${world.stats.maxDepth}`,
    `overheats         ${world.stats.overheats}`,
    `beacons           ${world.stats.beaconsChannelled}`,
    `level             ${world.level}`,
  ];

  // §9.2 — hoarding a solved engine is the noob trap, and Results says so.
  const wastedLine =
    wasted > 1
      ? `<div class="wasted">Kernel potential wasted: ${wasted.toFixed(0)}% — a Recompile at your peak would have compounded that into every later run of the engine.</div>`
      : '';

  // §12.4 — extraction shows what the Meltdown multiplier would have offered,
  // feeding next run's greed.
  const extractLine =
    world.ending === 'extracted'
      ? `<div class="wasted">Banked safe at ×1.0. Meltdown was still ahead of you — every 30s survived past ${clockLabel(
          world.config.meltdownAt ?? TUNABLE.meltdownAt,
        )} would have added ×${TUNABLE.meltdownMultiplierStep}.</div>`
      : '';

  // The headline and the exits live outside `.results-scroll`, so the way out of
  // a run is never something you have to scroll down to find.
  return `
    <div class="headline">${headline(world)}</div>
    <div class="results-scroll">
    ${renderTrace(world)}
    <div class="cols">
      <pre class="score">${lines.join('\n')}</pre>
      <div class="snapshot">
        <div class="k">final engine</div>
        <pre>${svgEscape(renderEngine(world))}</pre>
        ${renderPostMortem(world)}
        ${renderDiscoveries(world, library)}
        <div class="k">seed</div>
        <pre>  ${svgEscape(world.config.seed)} · ${svgEscape(world.config.axiomId)}</pre>
      </div>
    </div>
    ${wastedLine}${extractLine}
    </div>
    <div class="foot">
      <button class="again" data-action="confirm">RUN AGAIN &nbsp;[ENTER]</button>
      <button class="again" data-action="library">RUN SETUP &amp; LIBRARY &nbsp;[L / ESC]</button>
      <span class="dim">${BRANDING.title} · reload to replay this exact seed</span>
    </div>`;
}
