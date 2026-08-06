/**
 * The document UI — a long list, windowed.
 *
 * Pure state: a cursor, a scroll offset, and the window they imply. It draws
 * nothing. `Rows` draws the band over the visible window and the sheet writes
 * the words — same division as everywhere else in this module, and the reason a
 * list of six and a list of sixty are the same component.
 *
 * The cursor is kept off the very edge of the window while there is more list in
 * that direction, so you can always see where you are going. A cursor pinned to
 * the last visible row scrolls one item per keypress and reads as the list
 * dragging itself past you.
 */
export class List {
  index = 0;
  offset = 0;

  constructor(
    private count: number,
    /** How many rows the sheet has room for. */
    public rows: number,
    /** Rows of lookahead kept between the cursor and the edge. */
    private readonly margin = 2,
  ) {}

  setCount(n: number): void {
    this.count = Math.max(0, n);
    this.index = Math.min(this.index, Math.max(0, this.count - 1));
    this.clampOffset();
  }

  get length(): number {
    return this.count;
  }

  /** First index shown, and one past the last. */
  get window(): [number, number] {
    return [this.offset, Math.min(this.count, this.offset + this.rows)];
  }

  /** Where the cursor sits *within* the window, for the band to draw against. */
  get cursorRow(): number {
    return this.index - this.offset;
  }

  get atTop(): boolean {
    return this.offset > 0;
  }
  get atBottom(): boolean {
    return this.offset + this.rows < this.count;
  }

  move(d: number): void {
    if (!this.count) return;
    // Clamped, not wrapped. A sixty-item list that jumps to the top when you
    // step off the end reads as a bug the first three times you do it.
    this.index = Math.max(0, Math.min(this.count - 1, this.index + d));
    this.clampOffset();
  }

  moveTo(i: number): void {
    this.index = Math.max(0, Math.min(Math.max(0, this.count - 1), i));
    this.clampOffset();
  }

  /**
   * Scroll the window itself, dragging the cursor along only as far as it must.
   *
   * `move` is for a cursor: it steps the selection and the window follows once
   * the selection nears an edge. Driving a wheel through it reads as lurching —
   * nothing happens for a few notches while the cursor crosses the lookahead,
   * then the list jumps. A wheel is pointing at the *window*, so it moves that,
   * and the selection is only pushed if it would otherwise scroll out of sight.
   */
  scrollBy(d: number): void {
    if (this.count <= this.rows) return;
    this.offset = Math.max(0, Math.min(this.count - this.rows, this.offset + d));
    this.index = Math.max(this.offset, Math.min(this.offset + this.rows - 1, this.index));
  }

  private clampOffset(): void {
    const m = Math.min(this.margin, Math.floor((this.rows - 1) / 2));
    const lo = Math.max(0, this.index - this.rows + 1 + m);
    const hi = Math.max(0, this.index - m);
    this.offset = Math.max(0, Math.min(this.count - this.rows, Math.max(lo, Math.min(hi, this.offset))));
    if (this.count <= this.rows) this.offset = 0;
  }
}
