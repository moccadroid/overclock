/**
 * The pause, on paper. GDD §19.8.
 *
 * ESC holds the shift and shows its current state: the run, the chassis, the
 * Engine with what each row actually hits for, Heat, the draft economy, and
 * what was discovered — the same information the old DOM console showed,
 * on the stationery everything else already uses. No stamp: a stamp is a
 * disposition on a filed document, and a pause is not a disposition.
 *
 * The only deliberate way out of a run lives here too. Two presses — a
 * misclick must never throw away twenty minutes.
 */
import { Container, Graphics } from 'pixi.js';
import { ACTION_BY_ID, DISCOVERIES, DISCOVERY_BY_ID, NODE_BY_ID } from '../../content/index';
import type { Library } from '../../meta/profile';
import { TUNABLE } from '../../sim/tunables';
import type { World } from '../../sim/world';
import {
  Button,
  C,
  Sheet,
  blank,
  chain,
  charW,
  field,
  head,
  wrap,
  type Line,
} from '../ui';

const COLS = 64;

function fmt(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return n >= 10 ? n.toFixed(0) : n.toFixed(1);
}

function nodeName(id: string | null): string {
  if (!id) return '·';
  return NODE_BY_ID.get(id)?.name ?? id;
}

/** The Engine as it stands, with what each row actually hits for. */
function engineLines(world: World): Line[] {
  const total = world.engine.programs.reduce((s, p) => s + p.recentEvents, 0);
  const out: Line[] = [];
  for (const [i, program] of world.engine.programs.entries()) {
    const compiled = world.engine.compiled[i];
    if (!compiled?.live) continue;
    const parts = [
      nodeName(program.triggerId),
      ...program.modifierIds.filter((m): m is string => m !== null).map(nodeName),
      nodeName(program.actionId),
    ];
    const def = program.actionId ? ACTION_BY_ID.get(program.actionId) : null;
    const perHit =
      (def?.damage ?? 0) *
      compiled.ctx.output *
      world.engine.globalOutput *
      (1 + world.bonuses.power);
    const shots = Math.round(compiled.ctx.count) * compiled.executions.length;
    const share = total > 0 ? (program.recentEvents / total) * 100 : 0;
    const numbers =
      perHit > 0 ? `${fmt(perHit)} dmg${shots > 1 ? ` ×${shots}` : ''} · ${share.toFixed(0)}%` : '—';
    out.push([[' ', C.ink], ...chain(parts), [`   ${numbers}`, C.faint]]);
  }
  if (out.length === 0) out.push([[' no live programs', C.dim]]);
  return out;
}

/** The run, as a readable page. Exported so the copy is testable dry. */
export function pauseLines(world: World, library: Library): Line[] {
  const b = world.bonuses;
  const damage = (1 + b.power) * world.engine.globalOutput;
  const tierName = ['NOMINAL', 'INSTABILITY I', 'INSTABILITY II', 'OVERHEAT'][world.budget.tier]!;
  const found = [...world.discoveries.earned]
    .map((id) => DISCOVERY_BY_ID.get(id)?.name)
    .filter((n): n is string => !!n);

  const out: Line[] = [
    head('THE RUN'),
    field('level', String(world.level), { indent: 1 }),
    field('score', Math.floor(world.score).toLocaleString(), { indent: 1 }),
    field('eps', world.eps.toFixed(1), { indent: 1 }),
    field('peak eps', world.stats.peakEps.toFixed(1), { indent: 1 }),
    field('kills', world.stats.kills.toLocaleString(), { indent: 1 }),
    field('deepest cascade', String(world.stats.maxDepth), { indent: 1 }),
    field('threat', world.threat.toFixed(1), { indent: 1 }),
  ];
  if (world.phase === 'meltdown') {
    out.push(field('meltdown', `×${world.meltdownMultiplier.toFixed(2)}`, { indent: 1, colour: C.bright }));
  }
  out.push(
    blank(),
    head('CHASSIS'),
    field('integrity', `${Math.ceil(world.player.integrity)}/${world.player.maxIntegrity}`, { indent: 1 }),
    field('damage', `×${damage.toFixed(2)}`, { indent: 1 }),
    field('crit', `${Math.round((TUNABLE.critChance + b.crit) * 100)}%`, { indent: 1 }),
    field('speed', String(Math.round(TUNABLE.playerMoveSpeed * (1 + b.speed))), { indent: 1 }),
    blank(),
    head(
      `ENGINE — ${world.budget.staticLoad.toFixed(1)} of ${world.budget.capacity} cycles/s reserved`,
    ),
    ...engineLines(world),
    blank(),
    head('HEAT'),
    field(tierName.toLowerCase(), `${world.budget.heat.toFixed(0)} / 100`, { indent: 1 }),
    field('chain depth', world.depthAverage.toFixed(1), { indent: 1 }),
    blank(),
    head('DRAFT'),
    field('rerolls', String(world.rerolls), { indent: 1 }),
    field('purges', String(world.purges), { indent: 1 }),
    field('pending', String(world.pendingDrafts), { indent: 1 }),
    blank(),
    head(
      `DISCOVERED THIS RUN — ${library.earnedDiscoveries.size}/${DISCOVERIES.length} all time`,
    ),
  );
  const foundText = found.length > 0 ? found.join(' · ') : 'nothing yet';
  for (const line of wrap(foundText, COLS - 2)) out.push([[` ${line}`, C.faint]]);
  return out;
}

export class PauseSheet {
  readonly view = new Container();

  private sheet: Sheet | null = null;
  private buttons: Button[] = [];
  private readonly veil = new Graphics();
  private lines: Line[] = [];
  private onAction: ((cmd: string) => void) | null = null;
  private quitConfirm = false;

  constructor(stage: Container) {
    this.view.visible = false;
    this.view.addChild(this.veil);
    stage.addChild(this.view);
    window.addEventListener('resize', () => this.layout());
  }

  get open(): boolean {
    return this.view.visible;
  }

  show(world: World, library: Library, onAction: (cmd: string) => void): void {
    this.close();
    this.onAction = onAction;
    this.quitConfirm = false;
    this.lines = pauseLines(world, library);

    // No stamp. A stamp is a disposition on a filed document — CONTAINED,
    // CONCLUDED, STANDING — and a pause is not a disposition, it is a pause.
    // Decorating idle surfaces with invented stamps is how the register rots.
    this.sheet = new Sheet({ head: 'SHIFT STATUS', ref: 'OC-1147-P' });
    this.sheet.setLines(this.lines);
    this.view.addChild(this.sheet.view);
    this.paintButtons();

    this.view.visible = true;
    this.layout();
  }

  /** The second press is the one that means it. Relabel, never a dialog. */
  setQuitConfirm(on: boolean): void {
    if (this.quitConfirm === on) return;
    this.quitConfirm = on;
    this.paintButtons();
  }

  close(): void {
    for (const b of this.buttons) b.destroy();
    this.buttons = [];
    this.sheet?.destroy();
    this.sheet = null;
    this.view.visible = false;
  }

  private paintButtons(): void {
    if (!this.sheet) return;
    for (const b of this.buttons) b.destroy();
    const row = this.lines.length + 2;
    const resume = new Button(this.sheet.grid, 'RESUME  [ESC]', {
      col: 1,
      row,
      onPress: () => this.onAction?.('close'),
    });
    const abandon = new Button(
      this.sheet.grid,
      this.quitConfirm ? 'CONFIRM — ABANDON SHIFT' : 'ABANDON SHIFT',
      { col: 24, row, onPress: () => this.onAction?.('quit') },
    );
    this.buttons = [resume, abandon];
    for (const b of this.buttons) this.sheet.controls.addChild(b.view);
  }

  layout(): void {
    if (!this.sheet) return;
    const W = window.innerWidth;
    const H = window.innerHeight;
    this.veil.clear().rect(0, 0, W, H).fill({ color: 0x000000, alpha: 0.78 });

    const w = Math.min(Math.round(COLS * charW()) + 112, W - 48);
    const h = Math.min(this.sheet.heightFor(this.lines.length + 3), H - 40);
    this.sheet.layout(w, h);
    this.sheet.view.position.set(Math.round((W - w) / 2), Math.round((H - h) / 2));
  }
}
