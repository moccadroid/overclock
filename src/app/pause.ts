/**
 * The pause screen. GDD §19.8.
 *
 * ESC used to produce a bare stat dump with no way out of it except ESC again,
 * which is the worst kind of menu: it interrupts you and then offers nothing for
 * the interruption. A pause is the one moment the player has time to read, so it
 * is the right place to put the whole state of the run — what the Engine is
 * doing, what the chassis has become, what has been discovered — and the only
 * place a run can be left deliberately rather than by dying.
 */
import { ACTION_BY_ID, DISCOVERIES, DISCOVERY_BY_ID, NODE_BY_ID } from '../content/index';
import type { Library } from '../meta/profile';
import { TUNABLE } from '../sim/tunables';
import type { World } from '../sim/world';
import { BRANDING } from '../branding';

function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function clockLabel(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function fmt(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return n >= 10 ? n.toFixed(0) : n.toFixed(1);
}

/** The Engine as it stands, with what each row actually hits for. */
function engineRows(world: World): string {
  const total = world.engine.programs.reduce((s, p) => s + p.recentEvents, 0);

  const rows = world.engine.programs
    .map((program, i) => {
      const compiled = world.engine.compiled[i];
      if (!compiled?.live) return null;

      const parts = [
        `<span class="k-trigger">${esc(nodeName(program.triggerId))}</span>`,
        ...program.modifierIds
          .filter((m): m is string => m !== null)
          .map((m) => `<span class="k-modifier">${esc(nodeName(m))}</span>`),
        `<span class="k-action">${esc(nodeName(program.actionId))}</span>`,
      ];

      const def = program.actionId ? ACTION_BY_ID.get(program.actionId) : null;
      const perHit =
        (def?.damage ?? 0) *
        compiled.ctx.output *
        world.engine.globalOutput *
        (1 + world.bonuses.power);
      const shots = Math.round(compiled.ctx.count) * compiled.executions.length;
      const share = total > 0 ? (program.recentEvents / total) * 100 : 0;

      return (
        `<div class="pz-row">` +
        `<span class="pz-chain">${parts.join('<span class="k-sep"> › </span>')}</span>` +
        `<span class="pz-num">${perHit > 0 ? `${fmt(perHit)} dmg${shots > 1 ? ` ×${shots}` : ''}` : '—'}</span>` +
        `<span class="pz-pct">${share.toFixed(0)}%</span>` +
        `</div>`
      );
    })
    .filter(Boolean);

  return rows.length > 0 ? rows.join('') : `<div class="pz-row dim">no live programs</div>`;
}

function nodeName(id: string | null): string {
  if (!id) return '·';
  return NODE_BY_ID.get(id)?.name ?? id;
}

export function renderPause(world: World, library: Library): string {
  const b = world.bonuses;
  const damage = (1 + b.power) * world.engine.globalOutput;
  const tierName = ['NOMINAL', 'INSTABILITY I', 'INSTABILITY II', 'OVERHEAT'][world.budget.tier]!;

  const stat = (label: string, value: string): string =>
    `<div class="pz-stat"><span class="lbl">${label}</span><span class="val">${value}</span></div>`;

  // Only what was found *this* run. The Library's full list lives in the Library;
  // repeating it here would bury the three lines that are news.
  const found = [...world.discoveries.earned]
    .map((id) => DISCOVERY_BY_ID.get(id)?.name)
    .filter(Boolean);

  return `
    <div class="headline">PAUSED <span class="pz-clock">${clockLabel(world.time)}</span></div>
    <div class="pz-body">
      <div class="pz-col">
        <div class="k">the run</div>
        ${stat('LEVEL', String(world.level))}
        ${stat('SCORE', Math.floor(world.score).toLocaleString())}
        ${stat('EPS', world.eps.toFixed(1))}
        ${stat('PEAK EPS', world.stats.peakEps.toFixed(1))}
        ${stat('KILLS', world.stats.kills.toLocaleString())}
        ${stat('DEEPEST CASCADE', String(world.stats.maxDepth))}
        ${stat('OVERHEATS', String(world.stats.overheats))}
        ${stat('THREAT', world.threat.toFixed(1))}
        ${
          world.phase === 'meltdown'
            ? stat('MELTDOWN', `×${world.meltdownMultiplier.toFixed(2)}`)
            : ''
        }

        <div class="k">chassis</div>
        ${stat('INTEGRITY', `${Math.ceil(world.player.integrity)}/${world.player.maxIntegrity}`)}
        ${stat('DAMAGE', `×${damage.toFixed(2)}`)}
        ${stat('CRIT', `${Math.round((TUNABLE.critChance + b.crit) * 100)}%`)}
        ${stat('SPEED', String(Math.round(TUNABLE.playerMoveSpeed * (1 + b.speed))))}
        ${stat('PICKUP', String(Math.round(TUNABLE.collectRadius * (1 + b.magnet))))}
      </div>

      <div class="pz-col wide">
        <div class="k">engine — ${world.budget.staticLoad.toFixed(1)} of ${world.budget.capacity} Cycles/s reserved</div>
        ${engineRows(world)}

        <div class="k">heat</div>
        ${stat(tierName, `${world.budget.heat.toFixed(0)} / 100`)}
        ${stat('DRAW', `${Math.round(world.demandAverage)} of ${Math.round(world.budget.capacity)} c/s`)}

        <div class="k">draft</div>
        ${stat('REROLLS', String(world.rerolls))}
        ${stat('PURGES', String(world.purges))}
        ${stat('PENDING', String(world.pendingDrafts))}
        ${stat('POOL PURGED', `${world.purged.size} cards`)}

        <div class="k">discovered this run — ${library.earnedDiscoveries.size}/${DISCOVERIES.length} all time</div>
        <div class="pz-found">${found.length > 0 ? found.map((n) => esc(n!)).join(' · ') : 'nothing yet'}</div>
      </div>
    </div>
    <div class="foot">
      <button class="again" data-action="pause">RESUME &nbsp;[ESC]</button>
      <button class="again danger" data-action="quit">QUIT TO RUN SETUP</button>
      <span class="dim">${BRANDING.title} · quitting ends this run without scoring it</span>
    </div>`;
}
