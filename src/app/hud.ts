/**
 * In-run HUD. GDD §19.4 — edge-mounted, minimal, EPS always visible.
 * Placeholder styling; the Ring itself lives on the avatar in the renderer.
 */
import type { World } from '../sim/world';
import { BRANDING } from '../branding';
import { MODIFIER_BY_ID, NODE_BY_ID } from '../content/index';

function bar(value: number, max: number, width: number): string {
  const filled = Math.max(0, Math.min(width, Math.round((value / max) * width)));
  return '█'.repeat(filled) + '·'.repeat(width - filled);
}

function clock(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export class Hud {
  private readonly tl: HTMLElement;
  private readonly tc: HTMLElement;
  private readonly tr: HTMLElement;
  private readonly bl: HTMLElement;
  private readonly bc: HTMLElement;
  private readonly br: HTMLElement;
  private readonly xpbar: HTMLElement;
  private readonly engine: HTMLElement;

  constructor(root: HTMLElement) {
    const make = (id: string): HTMLElement => {
      const el = document.createElement('div');
      el.id = id;
      el.className = 'corner';
      root.appendChild(el);
      return el;
    };
    this.xpbar = document.createElement('div');
    this.xpbar.id = 'xpbar';
    root.appendChild(this.xpbar);

    this.tl = make('hud-tl');
    this.tc = make('hud-tc');
    this.tr = make('hud-tr');
    this.bl = make('hud-bl');
    this.bc = make('hud-bc');
    this.br = make('hud-br');
    this.br.textContent = `${BRANDING.title} · M1 grammar slice · TAB editor · SPACE dash`;

    // The Engine strip. §19.4 keeps the HUD minimal and puts the pipeline in the
    // editor, but a build you cannot see is a build you cannot reason about —
    // pillar 2. Low-brightness, right edge, one line per Program.
    this.engine = document.createElement('div');
    this.engine.id = 'hud-engine';
    root.appendChild(this.engine);
  }

  update(world: World): void {
    const p = world.player;

    this.xpbar.style.width = `${(world.xp / world.xpToNext) * 100}%`;

    this.tl.innerHTML =
      `INTEGRITY <span class="bar">${bar(p.integrity, p.maxIntegrity, 20)}</span> ` +
      `${Math.ceil(p.integrity)}\n` +
      `LEVEL ${world.level}   DASH ${p.dashCooldown > 0 ? p.dashCooldown.toFixed(1) + 's' : 'READY'}`;

    const heat = world.budget.heat;
    const tier = world.budget.tier;
    const tierName = ['NOMINAL', 'INSTABILITY I', 'INSTABILITY II', 'OVERHEAT'][tier]!;
    const heatClass = tier >= 1 ? 'hot' : '';
    this.tc.innerHTML =
      `${clock(world.time)}   THREAT ${world.threat.toFixed(1)}\n` +
      `<span class="${heatClass}">HEAT ${bar(heat, 100, 12)} ${tierName}` +
      `${world.budget.stalled ? '  ·  STALLED' : ''}</span>`;

    this.tr.innerHTML =
      `<span class="eps">EPS ${world.eps.toFixed(1)}</span>\n` +
      `SCORE ${Math.floor(world.score)}\n` +
      `CYCLES ${Math.round(world.budget.available)}/${Math.round(world.budget.headroom)}` +
      `  (static ${world.engine.staticLoad.toFixed(1)}/${world.budget.capacity})`;

    this.bl.innerHTML =
      `<span class="thermal">THERMAL ${bar(world.fuel.thermal, 100, 14)} ${Math.floor(world.fuel.thermal)}</span>\n` +
      `<span class="voltaic">VOLTAIC ${bar(world.fuel.voltaic, 100, 14)} ${Math.floor(world.fuel.voltaic)}</span>\n` +
      `<span class="void">VOID    ${bar(world.fuel.void, 100, 14)} ${Math.floor(world.fuel.void)}</span>`;

    const queued = world.pendingDrafts;
    this.bc.textContent = queued > 0 ? `${'^'.repeat(queued)}  ${queued} DRAFT PENDING — E` : '';

    this.br.textContent =
      `enemies ${world.enemies.length}  proj ${world.projectiles.length}  ` +
      `zones ${world.zones.length}  depth ${world.stats.maxDepth}  ` +
      `scrap +${(world.engine.scrapStacks * 4).toFixed(0)}%`;

    this.renderEngineStrip(world);
  }

  /** One line per Program: the chain as written, and its live share of EPS. */
  private renderEngineStrip(world: World): void {
    const total = world.engine.programs.reduce((s, p) => s + p.recentEvents, 0);
    const lines = world.engine.programs.map((program, i) => {
      const compiled = world.engine.compiled[i]!;
      if (!compiled.live && !program.triggerId && !program.actionId) {
        return `<div class="prog dead">${i + 1}  —</div>`;
      }

      const parts: string[] = [nodeName(program.triggerId) ?? '·'];
      for (const m of program.modifierIds) if (m) parts.push(nodeName(m) ?? m);
      parts.push(nodeName(program.actionId) ?? '·');
      const chain = parts.join(' › ');

      if (!compiled.live) {
        return `<div class="prog dead">${i + 1}  ${chain}   <span class="warn">not live</span></div>`;
      }

      const share = total > 0 ? (program.recentEvents / total) * 100 : 0;
      const meter = '▏'.repeat(Math.max(0, Math.round(share / 10)));
      return (
        `<div class="prog">${i + 1}  ${chain}` +
        `   <span class="num">${compiled.staticCost.toFixed(0)}c</span>` +
        `<span class="meter">${meter}</span>` +
        `<span class="pct">${share.toFixed(0)}%</span></div>`
      );
    });

    const beacon = world.beacons.find((b) => b.progress > 0);
    const channel = beacon
      ? `<div class="channel">CHANNELLING ${'█'.repeat(Math.round(beacon.progress * 10))}${'·'.repeat(
          10 - Math.round(beacon.progress * 10),
        )}</div>`
      : '';

    this.engine.innerHTML =
      `<div class="prog head">ENGINE — TAB to edit</div>` + lines.join('') + channel;
  }
}

function nodeName(id: string | null): string | null {
  if (!id) return null;
  const node = NODE_BY_ID.get(id);
  if (!node) return id;
  const mult = MODIFIER_BY_ID.get(id)?.cycleMult;
  return mult ? `${node.name}×${mult}` : node.name;
}
