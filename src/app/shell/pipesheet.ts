/**
 * The pipeline. GDD §19.6.
 *
 * The same screen the DOM editor was — index, chip chain, per-row numbers, row
 * ops, chassis strip, a reading line at the foot — in the document dialect:
 * hairline frames, the column grid, the kind inks. Layout preserved on purpose;
 * it works, and this pass is about the look.
 *
 * **Drag is a click-click here.** HTML5 drag-and-drop does not exist on a
 * canvas, and reimplementing pointer-drag with hit-testing across a rebuilt
 * scene graph is a lot of moving parts for an interaction the keyboard cannot
 * reach anyway. Pick a chip, then pick a slot: fewer states, works on a
 * touchscreen, and the legal targets can be *shown* while a chip is held
 * rather than discovered by dragging onto them. `{k:'move'}` is emitted
 * identically, so replays of runs recorded either way are interchangeable.
 */
import { Container, Graphics, Rectangle, Text } from 'pixi.js';
import { MODIFIER_BY_ID, NODE_BY_ID, ACTION_BY_ID } from '../../content/index';
import { inertFields, slotAccepts, TAG_GLYPH, tagsOf, type NodeSlot } from '../../sim/engine';
import type { Command } from '../../sim/record';
import { LOADBEARING, TUNABLE } from '../../sim/tunables';
import type { World } from '../../sim/world';
import { C, LINE, SIZE, Sheet, blank, charW, head, style, wrap, type Line } from '../ui';

/**
 * Body width, in characters.
 *
 * Wide on purpose. A chain is a trigger, three modifiers and an action, each of
 * which can carry a name, a cycle multiplier and two tag glyphs, and the row
 * ops sit to the right of all of it. At 88 the chain and the ops fought over the
 * same columns the moment a build had anything in it.
 */
const COLS = 106;
/** Grid row the first program row sits on. */
const FIRST_ROW = 4;
/**
 * Grid rows one program occupies: the chip's row, its numbers, and one of air.
 *
 * This was four — two for the chip (its name on one line and its tags on a
 * second), one for the numbers, one of air — and it put ninety-two pixels between
 * one chain and the next, which read as a mock-up of an editor rather than an
 * editor. The tags left the chip (see `KIND_EDGE`), so the chip is one line — but
 * the row of air stayed. At two rows the chains were flush against each other and
 * the numbers sat on the chip's own bottom edge: a list with no gutter reads as one
 * block of text, and the point of a chain is that it is a discrete thing.
 *
 * **This number is the number of lines the body loop pushes per program.** They
 * are two halves of one layout — the chips are painted over rows the text leaves
 * blank — and when they disagree the numbers walk down onto the chips, one row
 * further out with every program. That is exactly what happened when this went
 * from 4 to 3 without the loop losing a line.
 */
const ROW_STEP = 3;
/**
 * Chip height: its own grid row, plus a little.
 *
 * Bounded by the row pitch — at `LINE + 8` a chip overhung the row below it and
 * collided with its own numbers, which is what put the dps meter behind the chips.
 */
const CHIP_H = LINE + 4;
/** Chip corner radius. A chip is a key you press, so it is not quite square —
 *  but only just: at 4 it read as a rounded button from a much later decade, and
 *  everything else on this surface is a hairline rectangle. */
const CHIP_R = 2;

/**
 * **A chip's border says what kind of node it is.**
 *
 * It used to be said in words — `WHEN Clock`, `DO Bolt` — which is three
 * characters of grammar on every row explaining a distinction the *position*
 * already makes: the first chip is always the trigger and the last is always the
 * action. The words were noise, and the tags underneath them ("flight", "area")
 * made every chip two lines tall to carry information that belongs on the card,
 * not in the editor.
 *
 * So the kind is the outline. Dotted is a condition — something that *may*
 * happen; dashed is an instruction — something the engine *does*; solid is a
 * modifier, which is neither and simply sits in the chain. Read once, then read
 * forever at a glance, and it costs no columns and no rows.
 */
const KIND_EDGE = {
  trigger: { on: 2, off: 2 },
  modifier: null,
  action: { on: 5, off: 3 },
} as const;

/**
 * A rectangle whose border is drawn in dashes, by hand.
 *
 * Pixi has no dash pattern, and a stroked path would land on half-pixels at this
 * weight anyway — every other hairline in this dialect is a filled rect for the
 * same reason.
 */
function dashRect(
  g: Graphics,
  x: number,
  y: number,
  w: number,
  h: number,
  colour: number,
  dash: { on: number; off: number },
): void {
  const step = dash.on + dash.off;
  for (let i = 0; i < w; i += step) {
    const run = Math.min(dash.on, w - i);
    g.rect(x + i, y, run, 1).fill(colour);
    g.rect(x + i, y + h - 1, run, 1).fill(colour);
  }
  for (let i = 0; i < h; i += step) {
    const run = Math.min(dash.on, h - i);
    g.rect(x, y + i, 1, run).fill(colour);
    g.rect(x + w - 1, y + i, 1, run).fill(colour);
  }
}
/** Inside a chip, left and right of its label. */
const CHIP_PAD = 8;

const KIND_INK = { trigger: C.trigger, modifier: C.modifier, action: C.action } as const;

function fmt(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return n >= 10 ? n.toFixed(0) : n.toFixed(1);
}

interface ChipBox {
  program: number;
  slot: NodeSlot;
  kind: 'trigger' | 'modifier' | 'action';
  nodeId: string | null;
  x: number;
  y: number;
  w: number;
  label: string;
  inert: boolean;
  /** Measured, positioned and owned by `paintChips`; drawn in the same pass. */
  text: Text;
}

/** A small framed control. The editor needs a dozen of them and they are tiny. */
class Tap {
  readonly view = new Container();
  readonly width: number;
  readonly height = LINE + 6;
  private readonly box = new Graphics();
  private readonly text: Text;
  private hovered = false;

  constructor(
    label: string,
    private readonly enabled: boolean,
    onPress: () => void,
    private readonly ink: number = C.ink,
  ) {
    this.text = new Text({ text: label, style: style(11, enabled ? ink : C.rule, 2) });
    this.width = Math.ceil(this.text.width) + 14;
    this.text.position.set(7, Math.round((this.height - this.text.height) / 2));
    this.view.addChild(this.box, this.text);
    if (enabled) {
      this.view.eventMode = 'static';
      this.view.cursor = 'pointer';
      this.view.hitArea = new Rectangle(0, 0, this.width, this.height);
      this.view.on('pointerover', () => {
        this.hovered = true;
        this.paint();
      });
      this.view.on('pointerout', () => {
        this.hovered = false;
        this.paint();
      });
      this.view.on('pointertap', (ev) => {
        ev.stopPropagation();
        onPress();
      });
    }
    this.paint();
  }

  private paint(): void {
    this.box.clear();
    const edge = this.enabled ? (this.hovered ? this.ink : C.rule) : 0x1a2230;
    const r = this.box.roundRect(0.5, 0.5, this.width - 1, this.height - 1, 3);
    if (this.hovered && this.enabled) r.fill({ color: this.ink, alpha: 0.14 });
    r.stroke({ color: edge, width: 1 });
  }
}

export class PipeSheet {
  readonly view = new Container();

  private world: World | null = null;
  private sheet: Sheet | null = null;
  private readonly veil = new Graphics();
  private readonly chips = new Graphics();
  private readonly hits = new Container();
  private readonly labels = new Container();
  /**
   * The reading line — what the cursor is over — and it is a `Text` this class
   * owns rather than a line of the sheet.
   *
   * That is not a style choice. It used to be the last body line, so hovering a
   * chip meant re-rendering the sheet to change one string; a render tears down
   * and *destroys* every hit area, including the one the pointer was resting on,
   * so the click that followed the hover had nothing left to land on. Hover has
   * to be free of the render path.
   */
  private readonly readingText = new Text({ text: '', style: style(SIZE, C.faint) });
  private taps: Container[] = [];
  private boxes: ChipBox[] = [];
  /** Right edge of the widest chain, and of the row-op cluster past it. Both in
   *  pixels from the grid origin; the sheet sizes itself to the second. */
  private chainRight = 0;
  private opsRight = 0;

  /** The chip picked up, waiting for a slot. Null when nothing is held. */
  private holding: { program: number; slot: NodeSlot } | null = null;
  /** Node awaiting scrap confirmation. Scrap is permanent and there is no undo. */
  private pendingScrap: { program: number; slot: NodeSlot | 'row' } | null = null;
  /** Transient explanation when a move is refused, or a reading line. */
  private notice: string | null = null;
  private reading: string | null = null;
  private onAction: ((cmd: string) => void) | null = null;
  private quitConfirm = false;

  /** §14 — every hand edit is a command, or replays diverge. */
  onCommand: ((c: Command) => void) | null = null;

  constructor(stage: Container) {
    this.view.visible = false;
    this.view.addChild(this.veil);
    stage.addChild(this.view);
    window.addEventListener('resize', () => this.layout());
  }

  get open(): boolean {
    return this.view.visible;
  }

  show(world: World, onAction: (cmd: string) => void): void {
    this.close();
    this.world = world;
    this.onAction = onAction;
    this.holding = null;
    this.pendingScrap = null;
    this.notice = null;
    this.reading = null;
    this.readingText.text = '';
    this.quitConfirm = false;
    this.render();
    this.view.visible = true;
  }

  close(): void {
    this.teardown();
    // The chip layers live for the lifetime of the editor and are *parented* to
    // the sheet, so destroying the sheet with its children took them with it —
    // and the second TAB of a run threw on a Graphics with no context. Detach
    // first: the sheet is disposable, the layers are not.
    if (this.sheet) {
      this.sheet.controls.removeChild(this.chips, this.labels, this.hits, this.readingText);
      this.sheet.destroy();
    }
    this.sheet = null;
    this.view.visible = false;
  }

  setQuitConfirm(on: boolean): void {
    if (this.quitConfirm === on) return;
    this.quitConfirm = on;
    if (this.open) this.render();
  }

  /** ESC while something is held puts it down instead of leaving. */
  clearHeld(): boolean {
    if (!this.holding) return false;
    this.holding = null;
    this.render();
    return true;
  }

  private teardown(): void {
    for (const t of this.taps) t.destroy({ children: true });
    this.taps = [];
    this.hits.removeChildren().forEach((c) => c.destroy());
    this.labels.removeChildren().forEach((c) => c.destroy({ children: true }));
    this.boxes = [];
    this.chainRight = 0;
    this.opsRight = 0;
  }

  // ---- edits ----

  private afterChange(): void {
    this.world?.syncBudget();
    this.render();
  }

  private pick(program: number, slot: NodeSlot): void {
    const world = this.world;
    if (!world) return;
    const held = this.holding;

    // Nothing held: pick this chip up, if there is one.
    if (!held) {
      if (!world.engine.read(program, slot)) return;
      this.holding = { program, slot };
      this.notice = null;
      this.render();
      return;
    }
    // Same chip: put it down.
    if (held.program === program && held.slot === slot) {
      this.holding = null;
      this.render();
      return;
    }

    this.holding = null;
    this.onCommand?.({ k: 'move', fp: held.program, fs: held.slot, tp: program, ts: slot });
    const result = world.engine.moveNode(
      held.program,
      held.slot,
      program,
      slot,
      world.budget.capacity,
    );
    if (result === 'over-capacity') {
      this.notice =
        'That move would reserve more Cycles than your capacity. Draft capacity, or scrap something first.';
    } else if (result === 'wrong-slot') {
      this.notice = 'Triggers, modifiers and actions each have their own slots.';
    }
    this.afterChange();
  }

  /** Slots are typed, so only compatible targets light up while a chip is held. */
  private canDrop(program: number, slot: NodeSlot): boolean {
    const world = this.world;
    const from = this.holding;
    if (!world || !from) return false;
    if (from.program === program && from.slot === slot) return false;
    const moving = world.engine.read(from.program, from.slot);
    if (!moving || !slotAccepts(slot, moving)) return false;
    const displaced = world.engine.read(program, slot);
    return !displaced || slotAccepts(from.slot, displaced);
  }

  /** §19.6 — the refund a scrap would return, for the confirmation copy. */
  private refundFor(program: number, slot: NodeSlot): number {
    const world = this.world;
    if (!world) return 0;
    const p = world.engine.programs[program];
    if (!p) return 0;
    const before = world.engine.compiled[program]?.staticCost ?? 0;
    const saved = { t: p.triggerId, a: p.actionId, m: [...p.modifierIds] };
    if (slot === 'trigger') p.triggerId = null;
    else if (slot === 'action') p.actionId = null;
    else p.modifierIds[slot] = null;
    world.engine.recompile();
    const after = world.engine.compiled[program]?.staticCost ?? 0;
    p.triggerId = saved.t;
    p.actionId = saved.a;
    p.modifierIds = saved.m;
    world.engine.recompile();
    return Math.max(0, before - after);
  }

  private confirmScrap(): void {
    const world = this.world;
    const pending = this.pendingScrap;
    if (!world || !pending) return;
    if (pending.slot === 'row') {
      this.onCommand?.({ k: 'scrapRow', p: pending.program });
      world.engine.scrapProgram(pending.program);
    } else {
      this.onCommand?.({ k: 'scrapNode', p: pending.program, s: pending.slot });
      world.engine.scrapNode(pending.program, pending.slot);
    }
    this.pendingScrap = null;
    this.afterChange();
  }

  // ---- drawing ----

  private render(): void {
    const world = this.world;
    if (!world) return;
    this.teardown();
    if (!this.sheet) {
      this.sheet = new Sheet({ head: 'ENGINE — PIPELINE', ref: 'OC-1147-E' });
      this.sheet.controls.addChild(this.chips, this.labels, this.hits, this.readingText);
      this.view.addChild(this.sheet.view);
    }

    const totalDps = world.engine.programs.reduce((s, p) => s + p.recentDamage, 0);
    const lines: Line[] = [
      [
        [`reserved `, C.faint],
        [`${world.engine.staticLoad.toFixed(1)} of ${world.budget.capacity} cycles/s`, C.ink],
        ['    heat ', C.faint],
        [world.budget.heat.toFixed(0), C.ink],
        ['    scrap ', C.faint],
        [`+${(world.engine.scrapStacks * 4).toFixed(0)}%`, C.ink],
        ['    kernel ', C.faint],
        [`×${world.engine.kernel.toFixed(2)}`, C.ink],
      ],
      blank(),
      head('TRIGGER · MODIFIERS, LEFT TO RIGHT · ACTION'),
      blank(),
    ];

    // Two grid rows per program: one the chip is painted over, one for its
    // numbers. **This must push exactly ROW_STEP lines** — see that constant.
    world.engine.programs.forEach((program, i) => {
      const compiled = world.engine.compiled[i]!;
      lines.push(blank());
      if (compiled.live) {
        const share = totalDps > 0 ? (program.recentDamage / totalDps) * 100 : 0;
        const filled = Math.max(0, Math.min(8, Math.round(share / 12.5)));
        const shots = Math.round(compiled.ctx.count) * compiled.executions.length;
        const def = program.actionId ? ACTION_BY_ID.get(program.actionId) : null;
        const perHit =
          (def?.damage ?? 0) *
          compiled.ctx.output *
          world.engine.globalOutput *
          (1 + world.bonuses.power);
        lines.push([
          ['      ', C.ink],
          ['▮'.repeat(filled), C.trigger],
          ['▮'.repeat(8 - filled), C.rule],
          [`  ${fmt(program.recentDamage)} dps`, C.bright],
          [`  ${share.toFixed(0)}%`, C.faint],
          [`   ${compiled.staticCost.toFixed(0)}c`, C.faint],
          [
            perHit > 0 ? `   ${fmt(perHit)} dmg${shots > 1 ? ` ×${shots}` : ''}` : '   no damage',
            C.faint,
          ],
        ]);
      } else {
        const needs =
          !program.triggerId && !program.actionId
            ? 'trigger + action'
            : program.triggerId
              ? 'action'
              : 'trigger';
        lines.push([['      ', C.ink], [`needs a ${needs}`, C.rule]]);
      }
      // The gutter between chains. Keeps this loop at exactly ROW_STEP lines.
      lines.push(blank());
    });

    if (this.pendingScrap) {
      const pending = this.pendingScrap;
      const program = world.engine.programs[pending.program]!;
      let label: string;
      let nodes: number;
      if (pending.slot === 'row') {
        nodes =
          (program.triggerId ? 1 : 0) +
          (program.actionId ? 1 : 0) +
          program.modifierIds.filter(Boolean).length;
        label = `whole row (${nodes} node${nodes === 1 ? '' : 's'})`;
      } else {
        const id =
          pending.slot === 'trigger'
            ? program.triggerId
            : pending.slot === 'action'
              ? program.actionId
              : program.modifierIds[pending.slot as number];
        nodes = 1;
        label = NODE_BY_ID.get(id ?? '')?.name ?? String(id);
      }
      const refund =
        pending.slot === 'row'
          ? (world.engine.compiled[pending.program]?.staticCost ?? 0)
          : this.refundFor(pending.program, pending.slot);
      lines.push(
        [
          ['SCRAP ', C.signal],
          [label, C.bright],
          [` from program ${pending.program + 1}?`, C.ink],
        ],
        [
          [`+${(nodes * 4).toFixed(0)}% permanent output`, C.trigger],
          [`   ${refund.toFixed(1)} cycles freed`, C.faint],
          ['   cannot be undone', C.signal],
        ],
        blank(),
      );
    }

    if (this.notice) {
      for (const l of wrap(this.notice, COLS - 2)) lines.push([[l, C.signal]]);
      lines.push(blank());
    }

    // The chassis: everything collected that is not a node.
    const b = world.bonuses;
    const damage = (1 + b.power) * world.engine.globalOutput;
    lines.push(head('CHASSIS'), [
      ['  damage ', C.faint],
      [`×${damage.toFixed(2)}`, C.ink],
      ['   crit ', C.faint],
      [`${Math.round((TUNABLE.critChance + b.crit) * 100)}%`, C.ink],
      ['   speed ', C.faint],
      [String(Math.round(TUNABLE.playerMoveSpeed * (1 + b.speed))), C.ink],
      ['   pickup ', C.faint],
      [String(Math.round(TUNABLE.collectRadius * (1 + b.magnet))), C.ink],
      ['   integrity ', C.faint],
      [`${Math.ceil(world.player.integrity)}/${world.player.maxIntegrity}`, C.ink],
    ]);

    lines.push(blank());
    lines.push([
      [
        this.holding
          ? 'holding a node — pick a lit slot to place it, or pick it again to put it down'
          : 'pick a node, then pick a slot. modifiers apply left to right. scrapping is permanent.',
        C.dim,
      ],
    ]);
    // The reading line's row is reserved here and written to directly, so a
    // hover never enters this function.
    lines.push(blank());
    this.readingText.position.set(0, this.sheet.grid.y(lines.length - 1));

    this.sheet.setLines(lines);
    this.paintChips(world);
    this.paintTaps(world, lines.length);
    this.layout(lines.length + 2);
  }

  /**
   * The chip chain: drawn boxes, with hit areas over them.
   *
   * **Widths are measured, not counted.** They were `label.length * charW`, and
   * a label is not monospace text: a cycle multiplier and two tag glyphs render
   * wider than their character count buys, so a full chip's own name ran out
   * through its right border and under the scrap ×. Nothing about that could be
   * fixed by adding columns — the arithmetic was measuring the wrong thing.
   *
   * **And the columns are uniform down the page.** Sizing each chip to its own
   * label makes every row a different shape and re-flows the whole chain the
   * moment a modifier lands in it, which is what "the pipeline breaks when you
   * add modules" was: the chain grew past the row ops. One width per slot,
   * taken from the widest label in that slot, means the chain is a table —
   * columns line up, and the geometry only changes when the widest entry does.
   */
  private paintChips(world: World): void {
    const sheet = this.sheet!;
    const g = this.chips;
    g.clear();
    this.boxes = [];

    const slots: { slot: NodeSlot; kind: 'trigger' | 'modifier' | 'action' }[] = [
      { slot: 'trigger', kind: 'trigger' },
    ];
    for (let s = 0; s < LOADBEARING.modifierSlotsPerProgram; s++) {
      slots.push({ slot: s, kind: 'modifier' });
    }
    slots.push({ slot: 'action', kind: 'action' });

    // Pass one: the words, and what they measure. Nothing is positioned yet —
    // a column's width is not known until every row has been read.
    const cells = world.engine.programs.map((program, i) =>
      slots.map(({ slot, kind }) => {
        const nodeId = world.engine.read(i, slot);
        const node = nodeId ? NODE_BY_ID.get(nodeId) : null;
        const mult = nodeId ? MODIFIER_BY_ID.get(nodeId)?.cycleMult : undefined;
        // No `WHEN`/`DO`: the outline says it. See `KIND_EDGE`.
        const inert =
          kind === 'modifier' && nodeId ? inertFields(nodeId, program.actionId).length > 0 : false;
        const label = nodeId
          ? `${node?.name ?? nodeId}${mult ? ` ×${mult}` : ''}`
          : kind === 'modifier'
            ? '—'
            : `no ${kind}`;
        const ink = nodeId ? (inert ? C.signal : KIND_INK[kind]) : C.rule;
        const text = new Text({
          text: inert ? `${label} · no effect` : label,
          style: style(SIZE, ink, 1),
        });
        // The tags are gone from the editor. They are properties of the node —
        // "flight", "area", "duration" — and carrying them here cost every chip a
        // second line to restate what the node's own card already says. The editor
        // is for *arranging*; the card is for reading.
        return { program: i, slot, kind, nodeId, label, inert, text };
      }),
    );

    // Room for the × of whichever chip in this column is filled, plus air.
    const gutter = Math.round(charW() * 4);
    const inner = (cell: (typeof cells)[number][number]): number =>
      Math.ceil(cell.text.width);
    const widths = slots.map((_, j) => {
      const widest = Math.max(0, ...cells.map((row) => inner(row[j]!)));
      return Math.max(Math.round(charW() * 7), widest + CHIP_PAD * 2);
    });
    const h = CHIP_H;
    const left = sheet.grid.x(2);
    cells.forEach((row, i) => {
      const gridRow = FIRST_ROW + i * ROW_STEP;
      const y = sheet.grid.y(gridRow) - 4;

      // The index, as text on the grid rather than a chip.
      const idx = new Text({ text: String(i + 1), style: style(SIZE, C.faint, 2) });
      idx.position.set(sheet.grid.x(0), sheet.grid.y(gridRow));
      this.labels.addChild(idx);

      let x = left;
      row.forEach((cell, j) => {
        const w = widths[j]!;
        this.boxes.push({ ...cell, x, y, w });
        const top = Math.round(y + (h - cell.text.height) / 2);
        cell.text.position.set(Math.round(x + (w - cell.text.width) / 2), top);
        this.labels.addChild(cell.text);
        x += w + gutter;
      });
    });
    this.chainRight = left + widths.reduce((sum, w) => sum + w + gutter, 0);

    // Pass two: the boxes, so state (held, legal, inert) is read once per chip.
    for (const box of this.boxes) {
      const held = this.holding?.program === box.program && this.holding?.slot === box.slot;
      const legal = this.holding ? this.canDrop(box.program, box.slot) : false;
      const ink = box.nodeId ? KIND_INK[box.kind] : C.rule;
      const edge = held ? C.bright : legal ? C.trigger : box.inert ? C.signal : ink;

      const shape = g.roundRect(box.x + 0.5, box.y + 0.5, box.w - 1, h - 1, CHIP_R);
      if (held) shape.fill({ color: C.bright, alpha: 0.16 });
      else if (legal) shape.fill({ color: C.trigger, alpha: 0.1 });
      else if (box.nodeId) shape.fill({ color: ink, alpha: 0.05 });
      // The outline says what kind of node this is — see `KIND_EDGE`. A modifier
      // keeps the plain stroke; a trigger is dotted and an action dashed, drawn by
      // hand because Pixi has no dash pattern and a stroke at this weight lands on
      // half-pixels anyway.
      const dash = KIND_EDGE[box.kind];
      if (dash) dashRect(g, Math.round(box.x), Math.round(box.y), Math.round(box.w), h, edge, dash);
      else shape.stroke({ color: edge, width: 1, alignment: 0.5 });

      // One hit area per slot: picks up, places, and feeds the reading line.
      const hit = new Container();
      hit.eventMode = 'static';
      hit.cursor = box.nodeId || this.holding ? 'pointer' : 'default';
      hit.hitArea = new Rectangle(box.x, box.y, box.w, h);
      hit.on('pointerover', () => {
        const node = box.nodeId ? NODE_BY_ID.get(box.nodeId) : null;
        // The tags read here rather than on the chip. They are properties of the
        // node, they are words, and a chip that carried them was two lines tall to
        // restate what one hover says better.
        const marks = box.nodeId ? tagsOf(box.nodeId).map((t) => TAG_GLYPH[t]) : [];
        const tail = marks.length > 0 ? `  [${marks.join(' · ')}]` : '';
        this.reading = box.inert
          ? `NO EFFECT on this action — it ignores ${inertFields(box.nodeId!, world.engine.programs[box.program]!.actionId).join(', ')}. It still costs Cycles.`
          : `${node?.description ?? ''}${tail}`;
        this.readingText.text = this.reading;
      });
      hit.on('pointertap', () => this.pick(box.program, box.slot));
      this.hits.addChild(hit);
    }
  }

  /** Row ops, the scrap confirmation, and the way out. */
  private paintTaps(world: World, lineCount: number): void {
    const sheet = this.sheet!;
    const place = (t: Tap, col: number, row: number): void => {
      t.view.position.set(sheet.grid.x(col), sheet.grid.y(row) - 3);
      sheet.controls.addChild(t.view);
      this.taps.push(t.view);
    };

    // The ops hang off the end of the chain, never off a fixed column: the
    // chain's width is what it is, and a cluster nailed to column 66 is a
    // collision waiting for the player to fill a row.
    const opsX = Math.max(this.chainRight + Math.round(charW() * 2), sheet.grid.x(COLS - 26));

    world.engine.programs.forEach((program, i) => {
      const row = FIRST_ROW + i * ROW_STEP;
      const y = Math.round(sheet.grid.y(row) - 4 + (CHIP_H - (LINE + 6)) / 2);
      let x = opsX;
      const put = (t: Tap): void => {
        t.view.position.set(x, y);
        sheet.controls.addChild(t.view);
        this.taps.push(t.view);
        x += t.width + 8;
      };
      const hasNodes = Boolean(
        program.triggerId || program.actionId || program.modifierIds.some(Boolean),
      );
      put(
        new Tap('↑', i > 0, () => {
          this.onCommand?.({ k: 'moveRow', from: i, to: i - 1 });
          world.engine.moveProgram(i, i - 1);
          this.afterChange();
        }),
      );
      put(
        new Tap('↓', i < world.engine.programs.length - 1, () => {
          this.onCommand?.({ k: 'moveRow', from: i, to: i + 1 });
          world.engine.moveProgram(i, i + 1);
          this.afterChange();
        }),
      );
      put(
        new Tap(
          'SCRAP ROW',
          hasNodes,
          () => {
            this.pendingScrap = { program: i, slot: 'row' };
            this.render();
          },
          C.signal,
        ),
      );
      this.opsRight = Math.max(this.opsRight, x);

      // Per-slot scrap: one × per live node, in the gutter to the right of its
      // own chip. It used to sit *inside* the chip, which is where it collided
      // with the label of anything with a long name.
      const slots: NodeSlot[] = [
        'trigger',
        ...Array.from({ length: LOADBEARING.modifierSlotsPerProgram }, (_, s) => s),
        'action',
      ];
      for (const slot of slots) {
        const nodeId = world.engine.read(i, slot);
        const box = this.boxes.find((b) => b.program === i && b.slot === slot);
        if (!nodeId || !box) continue;
        const kill = new Tap(
          '×',
          true,
          () => {
            this.pendingScrap = { program: i, slot };
            this.render();
          },
          C.signal,
        );
        kill.view.position.set(box.x + box.w + 5, Math.round(box.y + (CHIP_H - kill.height) / 2));
        sheet.controls.addChild(kill.view);
        this.taps.push(kill.view);
      }
    });

    if (this.pendingScrap) {
      const row = lineCount - 8;
      const confirm = new Tap('CONFIRM SCRAP', true, () => this.confirmScrap(), C.signal);
      place(confirm, 2, row);
      const cancel = new Tap('CANCEL', true, () => {
        this.pendingScrap = null;
        this.render();
      });
      place(cancel, 20, row);
    }

    const foot = lineCount + 1;
    place(new Tap('RESUME  [TAB]', true, () => this.onAction?.('close')), 2, foot);
    place(
      new Tap(
        this.quitConfirm ? 'CONFIRM — ABANDON SHIFT' : 'ABANDON SHIFT',
        true,
        () => this.onAction?.('quit'),
        C.signal,
      ),
      22,
      foot,
    );
  }

  layout(rows?: number): void {
    if (!this.sheet) return;
    const W = window.innerWidth;
    const H = window.innerHeight;
    this.veil.clear().rect(0, 0, W, H).fill({ color: 0x000000, alpha: 0.8 });
    // Wide enough for the body copy *and* for whatever the chain actually
    // measured this frame, so a full build widens the sheet instead of running
    // off the side of it.
    const needed = Math.max(Math.round(COLS * charW()), this.opsRight + 16);
    const w = Math.min(needed + 112, W - 32);
    const h = Math.min(this.sheet.heightFor(rows ?? 40), H - 32);
    this.sheet.layout(w, h);
    this.sheet.view.position.set(Math.round((W - w) / 2), Math.round((H - h) / 2));
  }
}
