/**
 * The document UI — controls.
 *
 * Two of them, and both are laid out in **columns and rows** rather than pixels,
 * so a control sits on the same grid as the text around it and cannot drift out
 * of step with it.
 *
 * ---
 *
 * **A control owns its pixels; the sheet owns its words.**
 *
 * `Rows` draws a band and handles input, and that is all it draws. The marker,
 * the brightness of the selected line, the text of every row — those live in the
 * sheet's `Line[]`, built from the control's public state. The alternative is a
 * widget that renders its own labels, which immediately needs its own opinion
 * about columns, colours and leaders, and then there are two layout systems on
 * one screen.
 *
 * The exception is `Button`, which is a discrete object rather than part of the
 * flow of a document and therefore does own its label.
 */
import { Container, Graphics, Rectangle, Text } from 'pixi.js';
import type { Grid } from './grid';
import { C, SIZE, LINE, style } from './tokens';

/**
 * Arrows and WASD are the same key.
 *
 * One reading of intent, in one place — the moment two components each decide
 * for themselves what counts as "down", one of them ends up not knowing about
 * `s` and the inconsistency is invisible until somebody uses the wrong hand.
 */
export function vertical(e: KeyboardEvent): number {
  const k = e.key.toLowerCase();
  if (k === 'arrowdown' || k === 's') return 1;
  if (k === 'arrowup' || k === 'w') return -1;
  return 0;
}
export function horizontal(e: KeyboardEvent): number {
  const k = e.key.toLowerCase();
  if (k === 'arrowright' || k === 'd') return 1;
  if (k === 'arrowleft' || k === 'a') return -1;
  return 0;
}

/** Weight of the keyboard cursor and of hover. Present, never a highlight. */
const CURSOR_A = 0.09;
const HOVER_A = 0.05;

export interface RowsOpts {
  /** Grid row of the first item, and how many items there are. */
  row: number;
  count: number;
  /** Left column of the band, and its width in columns. */
  col: number;
  cols: number;
  /** Rows between successive items, for lists that are double-spaced. */
  step?: number;
  onMove?: (index: number) => void;
  onCommit?: (index: number) => void;
  /**
   * Whether a single click commits as well as selects. Off by default.
   *
   * It used to always commit, which is right for a setting you click to cycle
   * and badly wrong for the Axiom list, where committing *starts the run*:
   * clicking row two to read what it does launched the episode on row two. A
   * list you are choosing from has to let you look first. Enter still commits
   * from the keyboard, and the screens that need a mouse commit have a button.
   */
  commitOnClick?: boolean;
  /**
   * Whether a second click on an already-selected row commits.
   *
   * This is the file-explorer contract and it is not the same as
   * `commitOnClick`: one click selects so you can look, two open. Every desktop
   * ever shipped works this way, and on a list where committing *opens a window*
   * a single-click commit means you cannot move the cursor without opening
   * something.
   */
  commitOnDouble?: boolean;
  /**
   * The pointer went down on a row and then moved away from it: the caller may
   * want to treat that as picking the row up.
   *
   * Reported rather than handled, for the same reason a window reports a drag
   * instead of running one — there is exactly one thing being dragged on the
   * desk, so exactly one place should own it.
   */
  onDragOut?: (index: number) => void;
}

/** How long after a click a second one still counts as a double. */
const DOUBLE_MS = 380;

/**
 * A run of selectable lines.
 *
 * Cursor and selection are the same index here, deliberately: with a handful of
 * items and no cost to changing your mind, moving *is* choosing, and it means
 * one line on the sheet is marked instead of two. A longer list — the Library —
 * would want them separated, which is why `onMove` and `onCommit` are already
 * distinct.
 */
export class Rows {
  readonly view = new Container();
  index = 0;
  hover = -1;

  private readonly band = new Graphics();
  private readonly hits: Container[] = [];
  private readonly step: number;
  /**
   * Explicit grid row per item, when the items are not evenly spaced.
   *
   * `row + i * step` covers every list in the game except one: the file
   * explorer, whose entries are interrupted by folder headings, so item 4 might
   * be on row 9 and item 5 on row 12. Without this the bands and the hit boxes
   * march down on a fixed pitch while the text does not, and the cursor drifts
   * further from the line it is supposed to be on with every heading passed.
   */
  private positions: number[] | null = null;
  private lastTapIndex = -1;
  private lastTapAt = 0;
  /** The row the pointer went down on, until it comes up or leaves. */
  private pressed = -1;

  constructor(
    private readonly grid: Grid,
    private readonly o: RowsOpts,
  ) {
    this.step = o.step ?? 1;
    this.view.addChild(this.band);
    this.setCount(o.count);
  }

  /**
   * Change how many rows are selectable, rebuilding the hit areas.
   *
   * The hit boxes used to be built once, in the constructor, from whatever
   * `count` happened to be at that instant — and a list whose height depends on
   * the sheet is constructed *before* the sheet is laid out, so that instant was
   * the worst possible one to measure at. The body list was born with three rows
   * and stayed three rows selectable no matter how many were drawn: text
   * scrolled, the cursor could not follow it past the third entry, and every
   * attempt to fix it further up the stack was working around this.
   */
  /**
   * Place the items on given grid rows instead of on a fixed pitch.
   *
   * Pass one row per item, in item order. Setting it always rebuilds, because
   * the whole reason to call it is that the rows moved.
   */
  setPositions(rows: readonly number[]): void {
    this.positions = [...rows];
    this.rebuild(this.o.count);
  }

  /** Grid row of item `i`, honouring an explicit placement if one was given. */
  private rowOf(i: number): number {
    return this.positions?.[i] ?? this.o.row + i * this.step;
  }

  setCount(n: number): void {
    const count = Math.max(0, n);
    if (count === this.hits.length) return;
    this.rebuild(count);
  }

  private rebuild(n: number): void {
    const count = Math.max(0, n);
    this.o.count = count;
    for (const hit of this.hits) {
      this.view.removeChild(hit);
      hit.destroy();
    }
    this.hits.length = 0;

    for (let i = 0; i < count; i++) {
      const hit = new Container();
      hit.eventMode = 'static';
      hit.cursor = 'pointer';
      hit.hitArea = new Rectangle(
        this.grid.x(this.o.col),
        this.grid.y(this.rowOf(i)) - 2,
        this.grid.x(this.o.cols),
        LINE,
      );
      hit.on('pointerover', () => {
        this.hover = i;
        this.paint();
      });
      hit.on('pointerout', () => {
        if (this.hover === i) this.hover = -1;
        this.paint();
        // Left the row with the button still down: that is a pick-up, not a
        // click. Checked on the way out rather than by measuring distance,
        // because a row is one line tall and any threshold worth having is
        // taller than the thing being dragged.
        if (this.pressed === i) {
          this.pressed = -1;
          this.o.onDragOut?.(i);
        }
      });
      hit.on('pointerdown', () => {
        this.pressed = i;
      });
      hit.on('pointerupoutside', () => {
        this.pressed = -1;
      });
      hit.on('pointertap', () => {
        const now = performance.now();
        const double =
          this.o.commitOnDouble === true &&
          this.lastTapIndex === i &&
          now - this.lastTapAt < DOUBLE_MS;
        this.lastTapIndex = i;
        this.lastTapAt = now;
        this.pressed = -1;
        this.moveTo(i);
        if (double || this.o.commitOnClick) this.o.onCommit?.(i);
      });
      this.hits.push(hit);
      this.view.addChild(hit);
    }
    this.index = Math.min(this.index, Math.max(0, count - 1));
    this.hover = -1;
    this.paint();
  }

  moveTo(i: number): void {
    const n = this.o.count;
    if (n <= 0) return;
    const next = ((i % n) + n) % n;
    if (next === this.index) return;
    this.index = next;
    this.paint();
    this.o.onMove?.(next);
  }

  /** Arrows or WASD move, Enter commits. Anything else falls through. */
  keys(e: KeyboardEvent): boolean {
    const d = vertical(e);
    if (d) {
      this.moveTo(this.index + d);
      return true;
    }
    if (e.key === 'Enter') {
      this.o.onCommit?.(this.index);
      return true;
    }
    return false;
  }

  /** Redraw the bands. Called on any state change; costs one Graphics rebuild. */
  paint(): void {
    this.band.clear();
    const x = this.grid.x(this.o.col);
    const w = this.grid.x(this.o.cols);
    if (this.hover >= 0 && this.hover !== this.index) {
      this.band
        .rect(x, this.grid.y(this.rowOf(this.hover)) - 2, w, LINE)
        .fill({ color: C.ink, alpha: HOVER_A });
    }
    this.band
      .rect(x, this.grid.y(this.rowOf(this.index)) - 2, w, LINE)
      .fill({ color: C.ink, alpha: CURSOR_A });
  }

  destroy(): void {
    this.view.destroy({ children: true });
  }
}

export interface ButtonOpts {
  /** Grid position of the box's top-left, in columns and rows. Mutable: see
   *  `Button.place`, which a resizing window uses. */
  col: number;
  row: number;
  /** Columns of padding either side of the label. */
  pad?: number;
  onPress?: () => void;
}

/**
 * A control that inverts when you reach it.
 *
 * Idle it is an outline; hovered or focused it fills with paper and the label
 * goes black — a thing that has been *stamped* rather than merely written, which
 * is the one move in this dialect that reads unambiguously as "this is the
 * action". No other state on a sheet puts a light value behind text.
 */
export class Button {
  readonly view = new Container();
  focused = false;

  private readonly box = new Graphics();
  private readonly label: Text;
  private readonly w: number;
  private readonly h: number;
  private hovered = false;

  constructor(
    private readonly grid: Grid,
    text: string,
    private readonly o: ButtonOpts,
  ) {
    const pad = o.pad ?? 3;
    this.h = LINE + 10;

    // Measured, not computed from the grid.
    //
    // The label carries 2px of letter-spacing and the box did not know: width
    // was `grid.x(text.length + pad*2)`, which is the *monospace* width, so an
    // eight-character label overflowed its own box by sixteen pixels and sat
    // off-centre inside it. Longer label, worse offset — which is why a row of
    // three read as three differently-broken boxes.
    // Both axes, from the measured label.
    //
    // Width came from the monospace grid while the label carries 2px of letter
    // spacing, so a long label overflowed its own box; height was a hardcoded 6
    // against a 33px box, so every label sat high in it whatever its size. Two
    // magic numbers doing a job `Text` can answer exactly.
    this.label = new Text({ text, style: style(SIZE, C.ink, 2) });
    this.w = Math.ceil(this.label.width) + grid.x(pad) * 2;
    this.label.position.set(
      Math.round((this.w - this.label.width) / 2),
      Math.round((this.h - this.label.height) / 2),
    );

    this.view.position.set(grid.x(o.col), grid.y(o.row) - 5);
    this.view.addChild(this.box, this.label);
    this.view.eventMode = 'static';
    this.view.cursor = 'pointer';
    this.view.hitArea = new Rectangle(0, 0, this.w, this.h);
    this.view.on('pointerover', () => {
      this.hovered = true;
      this.paint();
    });
    this.view.on('pointerout', () => {
      this.hovered = false;
      this.paint();
    });
    this.view.on('pointertap', () => this.o.onPress?.());

    this.paint();
  }

  /**
   * Move the button to a different grid row.
   *
   * A button positions itself once, at construction — which is fine on a fixed
   * sheet and wrong inside a window that resizes. BEGIN CONTAINMENT is placed two
   * rows from the bottom, so when the desk shrank the window to fit the viewport
   * the button stayed where the *old* bottom was and ended up sitting across the
   * window's own border.
   */
  place(col: number, row: number): void {
    this.o.col = col;
    this.o.row = row;
    this.view.position.set(this.grid.x(col), this.grid.y(row) - 5);
  }

  keys(e: KeyboardEvent): boolean {
    if (this.focused && e.key === 'Enter') {
      this.o.onPress?.();
      return true;
    }
    return false;
  }

  paint(): void {
    const lit = this.hovered || this.focused;
    this.box.clear();
    if (lit) {
      this.box.rect(0, 0, this.w, this.h).fill(C.bar);
    } else {
      this.box.rect(0, 0, this.w, 1).fill(C.paper);
      this.box.rect(0, this.h - 1, this.w, 1).fill(C.paper);
      this.box.rect(0, 0, 1, this.h).fill(C.paper);
      this.box.rect(this.w - 1, 0, 1, this.h).fill(C.paper);
    }
    this.label.style = style(SIZE, lit ? C.barInk : C.ink, 2);
  }

  destroy(): void {
    this.view.destroy({ children: true });
  }
}
