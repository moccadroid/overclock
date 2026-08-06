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
}

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
  setCount(n: number): void {
    const count = Math.max(0, n);
    if (count === this.hits.length) return;
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
        this.grid.y(this.o.row + i * this.step) - 2,
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
      });
      hit.on('pointertap', () => {
        this.moveTo(i);
        if (this.o.commitOnClick) this.o.onCommit?.(i);
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
        .rect(x, this.grid.y(this.o.row + this.hover * this.step) - 2, w, LINE)
        .fill({ color: C.ink, alpha: HOVER_A });
    }
    this.band
      .rect(x, this.grid.y(this.o.row + this.index * this.step) - 2, w, LINE)
      .fill({ color: C.ink, alpha: CURSOR_A });
  }

  destroy(): void {
    this.view.destroy({ children: true });
  }
}

export interface ButtonOpts {
  /** Grid position of the box's top-left, in columns and rows. */
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
    grid: Grid,
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
