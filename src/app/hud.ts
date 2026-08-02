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
    this.br.textContent = `${BRANDING.title} · H help · TAB editor · SPACE dash · E channel`;

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

    const xpPct = Math.floor((world.xp / world.xpToNext) * 100);
    this.tl.innerHTML =
      `INTEGRITY <span class="bar">${bar(p.integrity, p.maxIntegrity, 20)}</span> ` +
      `${Math.ceil(p.integrity)}\n` +
      `LEVEL ${world.level} <span class="xp">${bar(world.xp, world.xpToNext, 20)}</span> ` +
      `${Math.floor(world.xp)}/${world.xpToNext} → ${world.level + 1}  (${xpPct}%)\n` +
      `DASH ${p.dashCooldown > 0 ? p.dashCooldown.toFixed(1) + 's' : 'READY'}`;

    const heat = world.budget.heat;
    const tier = world.budget.tier;
    const tierName = ['NOMINAL', 'INSTABILITY I', 'INSTABILITY II', 'OVERHEAT'][tier]!;
    const heatClass = tier >= 1 ? 'hot' : '';
    // §19.4 — at 20:00 the clock is replaced by the Meltdown multiplier.
    const topLine =
      world.phase === 'meltdown'
        ? `<span class="meltdown">MELTDOWN ×${world.meltdownMultiplier.toFixed(2)}` +
          `   +${clock(world.meltdownTime)}</span>`
        : `${clock(world.time)}   THREAT ${world.threat.toFixed(1)}`;
    // Heat is caused by drawing more Cycles than you generate, and the game has
    // to say so — otherwise it reads as an unexplained penalty. Show the draw
    // against the supply, and name the fix.
    const demand = Math.round(world.demandAverage);
    const supply = Math.round(world.budget.capacity);
    const over = demand > supply * 1.05;
    const cause = over
      ? `<span class="hot">DRAWING ${demand}/s · CAPACITY ${supply}/s — OVER BUDGET</span>`
      : `<span class="cool">drawing ${demand}/s of ${supply}/s</span>`;
    const advice =
      world.budget.stalled || heat > 55
        ? `<span class="advice">scrap a program, draft capacity, or fire less</span>`
        : '';

    this.tc.innerHTML =
      `${topLine}\n` +
      `<span class="${heatClass}">HEAT ${bar(heat, 100, 12)} ${tierName}` +
      `${world.budget.stalled ? '  ·  STALLED' : ''}</span>\n` +
      cause +
      (advice ? `\n${advice}` : '') +
      (world.surgeTime > 0
        ? `\n<span class="surge">REBUILD SURGE ${world.surgeTime.toFixed(0)}s · 2× XP</span>`
        : '');

    this.tr.innerHTML =
      `<span class="eps">EPS ${world.eps.toFixed(1)}</span>\n` +
      `SCORE ${Math.floor(world.score)}` +
      (world.kernels > 0 ? `   KERNEL ×${world.engine.kernel.toFixed(2)}` : '') +
      `\n` +
      `CYCLES ${Math.round(world.budget.available)}/${Math.round(world.budget.headroom)}` +
      `  (static ${world.engine.staticLoad.toFixed(1)}/${world.budget.capacity})`;

    // §19.4 — the three fuel gauges, each carrying its adaptive-resistance
    // percentage (§11.1). Resistance is always visible: it is a tax the player
    // is choosing to pay, so it can never be a surprise.
    // A gauge pinned at zero and a gauge sitting full are both confusing without
    // the flow behind them: the first means "burning it as fast as it arrives",
    // the second "nothing you own can spend this". Say which.
    const gauge = (hue: 'thermal' | 'voltaic' | 'void', label: string): string => {
      const resist = world.resistance[hue];
      const tax = resist > 0.01 ? ` <span class="resist">−${Math.round(resist * 100)}%</span>` : '';
      const burn = world.fuelBurn[hue];
      const gain = world.fuelGain[hue];

      let flow: string;
      if (burn > 0.2) {
        flow = `<span class="burning">−${burn < 10 ? burn.toFixed(1) : burn.toFixed(0)}/s spent</span>`;
      } else if (gain > 0.2) {
        flow = `<span class="idle">nothing spends this</span>`;
      } else {
        flow = '';
      }

      return (
        `<span class="${hue}">${label} ${bar(world.fuel[hue], 100, 14)} ` +
        `${String(Math.floor(world.fuel[hue])).padStart(3)}</span>${tax}  ${flow}`
      );
    };
    this.bl.innerHTML =
      gauge('thermal', 'THERMAL') +
      '\n' +
      gauge('voltaic', 'VOLTAIC') +
      '\n' +
      gauge('void', 'VOID   ') +
      (world.suppressedNow ? '\n<span class="suppressed">SUPPRESSED — TRIGGERS OFFLINE</span>' : '');

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

    const active = world.terminals.find((t) => t.progress > 0);
    const filled = active ? Math.round(active.progress * 10) : 0;
    const channel = active
      ? `<div class="channel">${active.kind.toUpperCase()} ` +
        `${'█'.repeat(filled)}${'·'.repeat(10 - filled)}</div>`
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
