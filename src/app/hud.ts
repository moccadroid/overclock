/**
 * In-run HUD. GDD §19.4 — edge-mounted, minimal, EPS always visible.
 * Placeholder styling; the Ring itself lives on the avatar in the renderer.
 */
import type { World } from '../sim/world';
import { TUNABLE } from '../sim/tunables';
import { BRANDING } from '../branding';
import { MODIFIER_BY_ID, NODE_BY_ID } from '../content/index';

function bar(value: number, max: number, width: number): string {
  const filled = Math.max(0, Math.min(width, Math.round((value / max) * width)));
  return '█'.repeat(filled) + '·'.repeat(width - filled);
}

/**
 * A bar that wears its own thresholds. The track is drawn green / amber / red
 * along its length, so you can see which zone you are in *and* which one you are
 * heading into. Heat's tiers sit at 40 / 70 / 100 and load's pain starts at
 * capacity — both read as "stay in the green" without needing a legend.
 */
function zoneBar(value: number, max: number, width: number, stops: number[]): string {
  const filled = Math.max(0, Math.min(width, Math.round((value / max) * width)));
  const classes = ['z-ok', 'z-warn', 'z-crit'];
  let out = '';
  let start = 0;
  for (let z = 0; z < stops.length; z++) {
    const stop = Math.round((stops[z]! / max) * width);
    const lit = Math.max(0, Math.min(stop, filled) - start);
    const dim = stop - start - lit;
    const cls = classes[z] ?? 'z-crit';
    if (lit > 0) out += `<span class="${cls}">${'█'.repeat(lit)}</span>`;
    if (dim > 0) out += `<span class="${cls} dim">${'·'.repeat(dim)}</span>`;
    start = stop;
  }
  return out;
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
  private notice = '';
  private noticeUntil = 0;
  private readonly fps: HTMLElement;
  /** Smoothed, because a per-frame number is unreadable and always looks worse. */
  private fpsAverage = 60;

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
    this.br.textContent =
      `${BRANDING.title} · H help · TAB editor · SPACE dash · E channel · M mute`;

    // The Engine strip. §19.4 keeps the HUD minimal and puts the pipeline in the
    // editor, but a build you cannot see is a build you cannot reason about —
    // pillar 2. Low-brightness, right edge, one line per Program.
    this.engine = document.createElement('div');
    this.engine.id = 'hud-engine';
    root.appendChild(this.engine);

    // Quiet by design: a number you can find when you go looking and never
    // notice when you are not. It sits above everything so a full screen of
    // light cannot hide it, which is exactly when you want to read it.
    this.fps = document.createElement('div');
    this.fps.id = 'hud-fps';
    root.appendChild(this.fps);
  }

  /** A transient line for things that have no permanent home — mute, mostly. */
  flash(message: string): void {
    this.notice = message;
    this.noticeUntil = performance.now() / 1000 + 1.8;
  }

  /** Called every frame; the display only refreshes with the rest of the HUD. */
  sample(frameDt: number): void {
    if (frameDt <= 0) return;
    this.fpsAverage += (1 / frameDt - this.fpsAverage) * 0.08;
  }

  update(world: World): void {
    const p = world.player;
    this.fps.textContent = `${Math.round(this.fpsAverage)} fps`;

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
    // §19.4 — at 20:00 the clock is replaced by the Meltdown multiplier.
    const topLine =
      world.phase === 'meltdown'
        ? `<span class="meltdown">MELTDOWN ×${world.meltdownMultiplier.toFixed(2)}` +
          `   +${clock(world.meltdownTime)}</span>`
        : `${clock(world.time)}   THREAT ${world.threat.toFixed(1)}`;

    // Heat used to be reported as a bare number that sat at zero and then leapt.
    // Two things fix that: the bar carries its own tier colours (40 / 70 / 100),
    // and the rate says which way it is moving. Venting is as informative as
    // building — it is the proof that easing off works.
    const rate = world.budget.heatRate;
    let heatFlow: string;
    if (world.budget.stalled) {
      heatFlow = `<span class="z-crit">STALLED ${world.budget.stall.toFixed(1)}s</span>`;
    } else if (rate > 0.05) {
      heatFlow = `<span class="z-crit">▲ +${rate.toFixed(0)}/s</span>`;
    } else if (rate < -0.05) {
      heatFlow = `<span class="z-ok">▼ ${rate.toFixed(0)}/s venting</span>`;
    } else {
      heatFlow = `<span class="cool">stable</span>`;
    }
    // §6.2 — Heat's cause, printed beside Heat.
    //
    // This is the whole reason Heat moved onto cascade depth. The old readout
    // could only say how hot you were, because its cause was a per-second
    // integral of a hidden budget — nothing you could point at. Depth is a thing
    // on the screen: you can see the chain, and now you can see the number it is
    // charging you.
    const depth = world.depthAverage;
    const free = TUNABLE.heatFreeDepth;
    const depthRead =
      depth < 0.5
        ? `<span class="cool">chain 0</span>`
        : `<span class="${depth > free ? 'z-warn' : 'z-ok'}">chain ${depth.toFixed(1)}` +
          `${depth > free ? ` · ${(depth - free).toFixed(1)} over` : ' · free'}</span>`;

    const advice =
      world.budget.stalled || heat > 55
        ? `<span class="advice">shorten the chain — depth past ${free} is what heats you</span>`
        : '';

    this.tc.innerHTML =
      `${topLine}\n` +
      `HEAT ${zoneBar(heat, 100, 16, [40, 70, 100])} ` +
      `<span class="${tier >= 2 ? 'z-crit' : tier >= 1 ? 'z-warn' : 'z-ok'}">${tierName}</span>` +
      `   ${heatFlow}   ${depthRead}` +
      (advice ? `\n${advice}` : '') +
      (world.surgeTime > 0
        ? `\n<span class="surge">REBUILD SURGE ${world.surgeTime.toFixed(0)}s · 2× XP</span>`
        : '');

    this.tr.innerHTML =
      `<span class="eps">EPS ${world.eps.toFixed(1)}</span>\n` +
      `SCORE ${Math.floor(world.score)}` +
      (world.kernels > 0 ? `   KERNEL ×${world.engine.kernel.toFixed(2)}` : '') +
      `\n` +
      // One number, and it only moves when *you* move it. The old readout showed
      // a dynamic pool draining against a static reservation — two quantities
      // with one name, one of which was a cliff.
      `CYCLES ${world.engine.staticLoad.toFixed(1)}/${world.budget.capacity}` +
      `  ${bar(world.engine.staticLoad, world.budget.capacity, 12)}`;

    this.bl.innerHTML = world.suppressedNow
      ? '<span class="suppressed">SUPPRESSED — TRIGGERS OFFLINE</span>'
      : '';

    const queued = world.pendingDrafts;
    const showNotice = performance.now() / 1000 < this.noticeUntil;
    this.bc.textContent = showNotice
      ? this.notice
      : queued > 0
        ? `${'^'.repeat(queued)}  ${queued} DRAFT PENDING — E`
        : '';

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

      // Same kind colours as the chips and cards, so the strip reads as the
      // same language rather than a separate list.
      const parts: string[] = [
        `<span class="k-trigger">${nodeName(program.triggerId) ?? '·'}</span>`,
      ];
      for (const m of program.modifierIds) {
        if (m) parts.push(`<span class="k-modifier">${nodeName(m) ?? m}</span>`);
      }
      parts.push(`<span class="k-action">${nodeName(program.actionId) ?? '·'}</span>`);
      const chain = parts.join('<span class="k-sep"> › </span>');

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

    // What the Engine reserves, against what it may. This only changes when the
    // build does, which is the entire point of the resource being static: it is
    // a number you plan against rather than one you discover.
    const reserved = world.engine.staticLoad;
    const supply = world.budget.capacity;
    const pct = supply > 0 ? reserved / supply : 0;
    const load =
      `<div class="load">RESERVED ${zoneBar(reserved, supply, 14, [supply * 0.75, supply * 0.9, supply])}` +
      `  <span class="${pct > 0.95 ? 'z-crit' : pct > 0.8 ? 'z-warn' : 'z-ok'}">` +
      `${reserved.toFixed(1)}</span><span class="num">/${supply} c</span></div>`;

    this.engine.innerHTML =
      `<div class="prog head">ENGINE — TAB to edit</div>` + load + lines.join('') + channel;
  }
}

function nodeName(id: string | null): string | null {
  if (!id) return null;
  const node = NODE_BY_ID.get(id);
  if (!node) return id;
  const mult = MODIFIER_BY_ID.get(id)?.cycleMult;
  return mult ? `${node.name}×${mult}` : node.name;
}
