/**
 * The end of an episode, on the site's own stationery.
 *
 * §14 gives this surface one job: *"Stamps CONTAINED after every meltdown death,
 * from run 1. The truth, filed where nobody reads it."* So it is a `Sheet`, like
 * every other document — same frame, same rules, same stamp struck across the
 * corner — instead of the DOM panel it replaced, which opened with `GARBAGE
 * COLLECTED` and belonged to no voice in the game.
 *
 * ---
 *
 * **The frame is diegetic. The vocabulary is not.**
 *
 * The first pass at this got that backwards and renamed every number into
 * register: kills became "collections", SCORE became "RECORDED", meltdown peak
 * became "divergence peak". Nobody can read that. §13.7 is explicit that a file
 * has to be *crisp and useful in its surface reading*, and this is the one
 * screen whose entire job is answering "how did I do, how did I die, what do I
 * try next". The Bureau supplies the paper and the stamp; the numbers keep the
 * names the player already knows from the HUD.
 *
 * **The trace is the hero element, not a footnote.** One chart of EPS across the
 * run, annotated with level-ups, Recompiles, Meltdown and death. That chart is
 * the run's story and everything under it is annotation.
 */
import { Container, Graphics, Text } from 'pixi.js';
import type { World, TraceMarkerKind } from '../../sim/world';
import type { Library } from '../../meta/profile';
import { DISCOVERY_BY_ID, ENEMY_BY_ID, NODE_BY_ID } from '../../content/index';
import { Button, C, LINE, SIZE, Sheet, type Line, blank, field, head, style } from '../ui';
import { drawEnemy } from '../gfx/enemy';
import { HUE_COLOR, PALETTE } from '../visual';
import { TUNABLE } from '../../sim/tunables';

/** The chart, in pixels. Tall enough to read a shape off, short enough to sit above the fold. */
const CHART_H = 132;
/** Room above the chart for stacked marker labels, before the head rule. */
const CHART_TOP = 30;
/** Where the scrolling body starts, under the chart. */
const BODY_TOP = CHART_TOP + CHART_H + 18;

const MARKER_INK: Record<TraceMarkerKind, number> = {
  level: 0x3f5570,
  cache: 0x9fd0ff,
  gate: 0xffe9a8,
  beacon: 0x9fd0ff,
  recompile: 0xb44cff,
  meltdown: 0xffb000,
  extract: 0xffb000,
  death: 0xff2a3c,
  // LEVELS §6 — Bureau furniture on the trace: the paper-blues the map uses.
  station: 0x7f9cbf,
  fragment: 0xa8c2de,
  // Dim on purpose: a threat step is the backdrop the rest of the trace happens
  // against, and a run has a dozen of them against one Recompile.
  threat: 0x4a4358,
};

function clock(t: number): string {
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * The stamp. Three dispositions and no fourth.
 *
 * `CONTAINED` from run one, long before the player has any reason to find the
 * word ominous. `CONCLUDED` for an extraction — the only ending the Bureau
 * considers a job done, and the one the player reads as giving up.
 */
function disposition(world: World): { stamp: string; ink: number } {
  if (world.ending === 'extracted') return { stamp: 'CONCLUDED', ink: C.dim };
  return { stamp: 'CONTAINED', ink: C.signal };
}

/**
 * The body of the report.
 *
 * Exported so the copy can be read without a renderer — checking what a screen
 * says should not require standing up a GPU.
 */
export function reportLines(world: World): Line[] {
  const score = world.finalScore();
  const out: Line[] = [];

  const stat = (label: string, value: string, bright = false): Line =>
    field(`  ${label}`, value, { col: 24, colour: bright ? C.bright : C.ink });

  out.push(
    stat('time', clock(world.time)),
    stat('output (∫EPS)', score.output.toLocaleString()),
    stat('peak EPS', world.stats.peakEps.toFixed(1)),
    stat('meltdown peak', `×${score.multiplier.toFixed(2)}`),
    stat('kernels', `${world.kernels}  (+${score.kernelBonus})`),
    [['  ', C.ink], ['─'.repeat(36), C.rule]],
    stat('SCORE', score.total.toLocaleString(), true),
    blank(),
    stat('kills', world.stats.kills.toLocaleString()),
    stat('events', world.stats.events.toLocaleString()),
    stat('deepest cascade', String(world.stats.maxDepth)),
    stat('overheats', String(world.stats.overheats)),
    stat('beacons', String(world.stats.beaconsChannelled)),
    stat('level', String(world.level)),
    blank(),
  );

  // §9.2 — hoarding a solved engine is the noob trap, and Results says so.
  const wasted = world.kernels === 0 ? world.wastedKernelPercent : 0;
  if (wasted > 1) {
    out.push(
      [['  Kernel potential wasted: ', C.ink], [`${wasted.toFixed(0)}%`, C.thermal]],
      [['  A Recompile at your peak would have compounded that into', C.faint]],
      [['  every later run of the engine.', C.faint]],
      blank(),
    );
  }
  // §12.4 — extraction shows what Meltdown would have offered, feeding the greed.
  if (world.ending === 'extracted') {
    out.push(
      [['  Banked safe at ×1.0. Meltdown was still ahead of you —', C.ink]],
      [
        [`  every ${TUNABLE.meltdownStepSeconds}s past `, C.faint],
        [clock(world.config.meltdownAt ?? TUNABLE.meltdownAt), C.ink],
        [` would have added ×${TUNABLE.meltdownMultiplierStep}.`, C.faint],
      ],
      blank(),
    );
  }

  out.push(head('FINAL ENGINE'), blank());
  const rows = world.engine.programs.filter((_, i) => world.engine.compiled[i]?.live);
  if (!rows.length) out.push([['  (no live programs)', C.dim]]);
  for (let i = 0; i < rows.length; i++) {
    const p = rows[i]!;
    const names = [p.triggerId, ...p.modifierIds, p.actionId]
      .filter((x): x is string => !!x)
      .map((id) => NODE_BY_ID.get(id)?.name ?? id);
    out.push([['  ', C.ink], [`${i + 1}  `, C.faint], [names.join(' › '), C.ink]]);
  }
  out.push(blank());

  // §14 — "how did I die" is the one question this screen must answer, and the
  // honest answer has two halves: the blow that landed, and the thing that had
  // been grinding all run. They are usually different, and the gap is the lesson.
  if (world.deathCause) {
    // Three rows of clear space: the killer's silhouette is drawn over this, at
    // the size the arena draws it, by `paintGlyph`.
    out.push(head('KILLED BY'), blank(), blank(), blank(), blank());
    out.push(blank(), head('DAMAGE TAKEN, BY SOURCE'), blank());
    const sorted = [...world.damageBySource.values()].sort((a, b) => b.amount - a.amount);
    const total = sorted.reduce((s, e) => s + e.amount, 0);
    for (const { source, amount } of sorted.slice(0, 5)) {
      const pct = total > 0 ? (amount / total) * 100 : 0;
      out.push([
        ['  ', C.ink],
        [source.label.padEnd(20), C.ink],
        ['█'.repeat(Math.max(1, Math.round(pct / 4))), C.faint],
        [` ${pct.toFixed(0)}%`, C.dim],
      ]);
    }
    out.push(blank());
  }

  const earned = [...world.discoveries.earned];
  if (earned.length) {
    out.push(head('DISCOVERED THIS RUN'), blank());
    for (const id of earned) {
      const def = DISCOVERY_BY_ID.get(id);
      if (def) out.push([['  ', C.ink], [def.name, C.bright]]);
    }
    out.push(blank());
  }

  out.push(field('  seed', `${world.config.seed} · ${world.config.axiomId}`, { col: 24 }));
  return out;
}

/** Grid row the killer's silhouette is drawn on, found by the header above it. */
function killedByRow(lines: readonly Line[]): number {
  return lines.findIndex((l) => l[0]?.[0] === 'KILLED BY');
}

/**
 * The report, mounted over the arena.
 *
 * Drawn into the run's own renderer rather than a second `Application`: the
 * shell destroys itself before a run starts precisely so there is one WebGL
 * context, and standing up another to show a document would undo that.
 */
export class EpisodeReport {
  readonly view = new Container();

  private sheet: Sheet | null = null;
  private buttons: Button[] = [];
  private readonly veil = new Graphics();
  private readonly chart = new Graphics();
  private readonly glyph = new Graphics();
  private readonly chartLabels = new Container();
  private readonly scrollbar = new Graphics();

  private onAction: ((cmd: string) => void) | null = null;
  private world: World | null = null;
  private lines: Line[] = [];
  private offset = 0;
  private rows = 0;

  private readonly onWheel = (e: WheelEvent): void => {
    if (!this.open) return;
    e.preventDefault();
    this.scrollBy(e.deltaY > 0 ? 3 : -3);
  };

  constructor(stage: Container) {
    this.view.visible = false;
    this.view.addChild(this.veil);
    stage.addChild(this.view);
    window.addEventListener('resize', () => this.layout());
    window.addEventListener('wheel', this.onWheel, { passive: false });
  }

  get open(): boolean {
    return this.view.visible;
  }

  show(
    world: World,
    library: Library,
    onAction: (cmd: string) => void,
    storyMode = false,
  ): void {
    this.close();
    this.onAction = onAction;
    this.world = world;
    this.lines = reportLines(world);
    this.offset = 0;

    const d = disposition(world);
    this.sheet = new Sheet({
      head: 'EPISODE REPORT',
      ref: `OC-${1147 + library.snapshot.runs}-R`,
      stamp: d.stamp,
      stampInk: d.ink,
    });
    this.view.addChild(this.sheet.view);
    this.sheet.controls.addChild(this.chart, this.chartLabels, this.glyph, this.scrollbar);

    // LEVELS §2.3 — in the campaign there is one way forward: back to the
    // terminal, one keystroke from the next shift. AGAIN skips the terminal,
    // and the terminal is where the story happens — a shortcut around it is a
    // shortcut around the game. The wider set returns with the post-campaign
    // modes, where a rematch is a rematch and nothing is waiting to be said.
    const labels: [string, string][] = storyMode
      ? [['CONTINUE', 'continue']]
      : [
          ['AGAIN', 'confirm'],
          ['MENU', 'library'],
          ['SAVE RUN', 'save-run'],
        ];
    let col = 2;
    this.buttons = labels.map(([text, cmd]) => {
      const at = col;
      col += text.length + 6 + 2;
      const b = new Button(this.sheet!.grid, text, {
        col: at,
        row: 0,
        onPress: () => this.onAction?.(cmd),
      });
      this.sheet!.controls.addChild(b.view);
      return b;
    });
    this.buttons[0]!.focused = true;
    this.buttons[0]!.paint();

    this.view.visible = true;
    this.layout();
  }

  close(): void {
    for (const b of this.buttons) b.destroy();
    this.buttons = [];
    this.chartLabels.removeChildren().forEach((c) => c.destroy());
    this.sheet?.destroy();
    this.sheet = null;
    this.view.visible = false;
  }

  private scrollBy(d: number): void {
    const max = Math.max(0, this.lines.length - this.rows);
    const next = Math.max(0, Math.min(max, this.offset + d));
    if (next === this.offset) return;
    this.offset = next;
    this.paint();
  }

  layout(): void {
    if (!this.sheet) return;
    const W = window.innerWidth;
    const H = window.innerHeight;
    this.veil.clear().rect(0, 0, W, H).fill({ color: 0x000000, alpha: 0.88 });

    const w = Math.min(880, W - 64);
    const h = Math.min(H - 48, 940);
    this.sheet.layout(w, h);
    this.sheet.view.position.set(Math.round((W - w) / 2), Math.round((H - h) / 2));

    // The chart sits at the top of the body; the text scrolls beneath it, and
    // the controls sit clear of the footer rule so the way out of a run is
    // never something you have to scroll to find.
    this.chart.position.y = CHART_TOP;
    this.chartLabels.position.y = CHART_TOP;
    this.sheet.grid.view.position.y = this.sheet.originY + BODY_TOP;

    // Derived, not guessed. `heightFor(rows)` is `originY + (rows + 3) * LINE +
    // FOOT_RULE`, so the rule's offset falls out of it — and placing the buttons
    // from the *text* height instead put them straight on top of that rule,
    // because the two numbers only agreed when the body happened to fill the
    // sheet exactly.
    const footRule = this.sheet.heightFor(0) - this.sheet.originY - 3 * LINE;
    const ruleY = h - footRule - this.sheet.originY;
    const buttonH = LINE + 10;
    const buttonY = ruleY - buttonH - 16;

    this.rows = Math.max(4, Math.floor((buttonY - BODY_TOP - 12) / LINE));
    for (const b of this.buttons) b.view.position.y = buttonY;
    this.paint();
  }

  private paint(): void {
    if (!this.sheet || !this.world) return;
    const max = Math.max(0, this.lines.length - this.rows);
    this.offset = Math.min(this.offset, max);
    this.sheet.setLines(this.lines.slice(this.offset, this.offset + this.rows));

    this.paintChart();
    this.paintGlyph();

    // A visible track, because a document that silently shows two thirds of
    // itself reads as a document that is two thirds long.
    this.scrollbar.clear();
    if (max > 0) {
      const x = this.sheet.grid.x(this.sheet.cols) + 10;
      const top = BODY_TOP;
      const height = this.rows * LINE;
      const thumb = Math.max(24, (this.rows / this.lines.length) * height);
      const at = (this.offset / max) * (height - thumb);
      this.scrollbar.rect(x, top, 2, height).fill({ color: C.rule, alpha: 0.5 });
      this.scrollbar.rect(x - 1, top + at, 4, thumb).fill({ color: C.ink, alpha: 0.8 });
    }
  }

  /** The run trace: EPS across the episode, annotated. §14's hero element. */
  private paintChart(): void {
    const world = this.world;
    if (!world || !this.sheet) return;
    const g = this.chart;
    g.clear();
    this.chartLabels.removeChildren().forEach((c) => c.destroy());

    const w = this.sheet.grid.x(this.sheet.cols);
    const duration = Math.max(1, world.time);
    const peak = Math.max(1, ...world.trace.map((s) => s.eps));
    const x = (t: number): number => (t / duration) * w;
    const y = (eps: number): number => CHART_H - (eps / peak) * (CHART_H - 10);

    g.rect(0, 0, w, CHART_H).stroke({ width: 1, color: PALETTE.structure, alpha: 0.9 });

    // A gridline a minute, in the same band-5 language as the arena grid.
    for (let t = 60; t < duration; t += 60) {
      g.moveTo(x(t), 0).lineTo(x(t), CHART_H);
    }
    g.stroke({ width: 1, color: PALETTE.structure, alpha: 0.5 });

    if (world.trace.length > 1) {
      const first = world.trace[0]!;
      g.moveTo(x(first.t), y(first.eps));
      for (const s of world.trace) g.lineTo(x(s.t), y(s.eps));
      g.lineTo(w, CHART_H).lineTo(0, CHART_H).lineTo(x(first.t), y(first.eps));
      g.fill({ color: PALETTE.voltaic, alpha: 0.1 });

      g.moveTo(x(first.t), y(first.eps));
      for (const s of world.trace) g.lineTo(x(s.t), y(s.eps));
      g.stroke({ width: 1.5, color: PALETTE.voltaic, alpha: 0.95 });
    }

    // Labels stack rather than overlap.
    //
    // Three events inside ten seconds is normal — a cache opens, a partition
    // opens, the threat steps — and printing all three at the same height drew
    // them straight through each other into "@añd idiate–4?a¤ntected". Each
    // label takes the lowest row whose right edge it clears.
    const rowEnds: number[] = [];
    for (const m of world.markers) {
      if (m.kind === 'level' && world.markers.length >= 40) continue;
      const big = m.kind !== 'level' && m.kind !== 'beacon';
      const at = x(m.t);
      g.moveTo(at, big ? 0 : CHART_H - 16).lineTo(at, CHART_H);
      g.stroke({ width: big ? 1.5 : 1, color: MARKER_INK[m.kind], alpha: big ? 0.9 : 0.45 });
      if (!big) continue;

      // Anchored inward near the edges, or the label runs off the sheet — which
      // is how "CONTAINED" once became "CONTAI".
      const t = new Text({ text: m.label, style: style(10, MARKER_INK[m.kind]) });
      const anchor = at < 60 ? 0 : at > w - 60 ? 1 : 0.5;
      t.anchor.set(anchor, 1);
      const left = at - t.width * anchor;
      let row = rowEnds.findIndex((end) => left > end + 6);
      if (row < 0) row = rowEnds.length;
      rowEnds[row] = left + t.width;
      t.position.set(Math.max(0, Math.min(w, at)), -3 - row * 11);
      this.chartLabels.addChild(t);
    }

    const cap = new Text({ text: `EPS · peak ${peak.toFixed(0)}`, style: style(10, C.faint) });
    cap.position.set(4, 4);
    this.chartLabels.addChild(cap);
  }

  /**
   * The thing that killed you, drawn the way the arena drew it.
   *
   * Not a name in a list. Everywhere else in the game an enemy is a silhouette —
   * the register, the arena, the variant strip — and the one screen where the
   * player has time to study the shape that got them is the one screen that was
   * printing its name in text.
   */
  private paintGlyph(): void {
    const g = this.glyph;
    g.clear();
    const world = this.world;
    if (!world?.deathCause || !this.sheet) return;

    const row = killedByRow(this.lines) - this.offset;
    if (row < 0 || row + 4 > this.rows) return;

    const cause = world.deathCause;
    const def = cause.enemyId ? ENEMY_BY_ID.get(cause.enemyId) : undefined;
    const cy = this.sheet.grid.y(row + 3) + BODY_TOP;
    if (def) {
      // A floor on the size: a Mote at true scale is five pixels, and this is
      // the one screen where the player has time to study the shape that got them.
      drawEnemy(g, def, 40, cy, Math.max(11, Math.min(22, def.radius * 1.1)), -Math.PI / 2, {
        colour: HUE_COLOR[def.hue] ?? C.signal,
        zone: 0,
      });
    } else {
      // A hazard, not a unit — §11.4's containment bracket rather than a body.
      g.moveTo(28, cy - 14).lineTo(28, cy + 14);
      g.moveTo(52, cy - 14).lineTo(52, cy + 14);
      g.stroke({ width: 1.6, color: C.signal, alpha: 0.9 });
    }

    const name = new Text({ text: cause.label, style: style(SIZE, C.bright, 1) });
    name.position.set(76, cy - 16);
    this.chartLabels.addChild(name);
    if (cause.mode) {
      const mode = new Text({ text: cause.mode, style: style(11, C.faint) });
      mode.position.set(76, cy + 4);
      this.chartLabels.addChild(mode);
    }
  }

  /** ENTER runs again, ESC returns to the menu, arrows scroll. */
  keys(e: KeyboardEvent): boolean {
    if (!this.open) return false;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      this.scrollBy(e.key === 'ArrowDown' ? 2 : -2);
      return true;
    }
    if (e.key === 'Enter') {
      this.onAction?.('confirm');
      return true;
    }
    if (e.key === 'Escape') {
      this.onAction?.('library');
      return true;
    }
    return false;
  }
}
