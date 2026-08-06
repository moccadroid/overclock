/**
 * The document UI — the character grid.
 *
 * Takes lines of coloured segments and lays them out by *column*: a segment's x
 * comes from the combined length of the segments before it on its line. That is
 * the whole reason a `[1]` on one row and a `[2]` on the next land in the same
 * place without anybody counting spaces, and why a dot leader written as text
 * arrives at the same column as the one above it.
 *
 * ---
 *
 * **Text objects are pooled, never destroyed.**
 *
 * A sheet rebuilds on every state change — a cursor move, a toggled setting —
 * and a rebuild touches every segment on the page. Destroying and recreating
 * sixty `Text` objects for a keypress is the difference between a menu that
 * feels instant and one that stutters, and it is pure waste: the same sixty
 * slots are wanted again a frame later with different strings in them.
 *
 * It is also the seam for `BitmapText`. Every string on a sheet is created here
 * and nowhere else, so moving to a font atlas — which is what this will want if
 * it is ever drawn during a run — changes this file and no other.
 */
import { Container, Graphics, Text } from 'pixi.js';
import { C, LINE, SIZE, type Line, charW, isRedaction, redactionLevel, style } from './tokens';

export class Grid {
  readonly view = new Container();

  private readonly bars = new Graphics();
  private readonly pool: Text[] = [];
  private used = 0;

  /**
   * What this account is cleared to read. Any bar at or below it lifts and its
   * words render normally — the file did not change, the permission did.
   */
  clearance = 0;
  /**
   * §11.5 — how far the bars have slid off what they were covering, 0..1. Only
   * the ending ever moves this, and for a frame or two on the way the words
   * underneath are legible.
   */
  slip = 0;

  constructor() {
    this.view.addChild(this.bars);
  }

  /** Pixel offset of a column and a row, for anything that has to line up with
   *  the text without being text — a highlight band, a hit area, a rule. */
  x(col: number): number {
    return Math.round(col * charW());
  }
  y(row: number): number {
    return row * LINE;
  }

  /** How many columns fit in a pixel width. Sheets size their content in these. */
  static cols(width: number): number {
    return Math.floor(width / charW());
  }

  set(lines: readonly Line[]): void {
    this.bars.clear();
    this.used = 0;

    for (let row = 0; row < lines.length; row++) {
      let col = 0;
      for (const [text, colour] of lines[row]!) {
        if (isRedaction(colour) && this.clearance < redactionLevel(colour)) {
          // The words go down first and the bar goes over them, rather than the
          // bar standing in for them. That is what makes §11.5 possible at all:
          // slide the bar and what was always underneath is simply there.
          this.put(text, C.dim, this.x(col), this.y(row));
          this.bars
            .rect(
              this.x(col) + this.slip * this.x(text.length),
              this.y(row) - 1,
              this.x(text.length),
              SIZE + 3,
            )
            .fill(C.bar);
        } else {
          this.put(text, isRedaction(colour) ? C.bright : colour, this.x(col), this.y(row));
        }
        col += text.length;
      }
    }

    for (let i = this.used; i < this.pool.length; i++) this.pool[i]!.visible = false;

    // The bars go on top, every rebuild.
    //
    // They were added first and never moved, so the pooled `Text` objects —
    // added lazily, as the pool grew — all drew *over* them. The words were laid
    // down in C.dim and the bar was painted behind them, which reads as text on
    // a highlight and means **every redaction in the game was legible**. §5.4
    // makes bars permissions and §13.4 invites the player to measure them;
    // neither survives a bar you can read through.
    //
    // On top is also what §11.5 needs: the words are genuinely underneath, so
    // sliding the bar off reveals something rather than un-highlighting it. The
    // original worry — a bar landing on the line below — cannot happen: the rect
    // is SIZE+3 tall in a LINE-tall row, so it never reaches the next one.
    this.view.setChildIndex(this.bars, this.view.children.length - 1);
  }

  private put(text: string, colour: number, x: number, y: number): void {
    let t = this.pool[this.used];
    if (!t) {
      t = new Text({ text, style: style(SIZE, colour) });
      this.pool.push(t);
      this.view.addChild(t);
    } else {
      t.text = text;
      t.style = style(SIZE, colour);
      t.visible = true;
    }
    t.position.set(x, y);
    this.used++;
  }

  destroy(): void {
    this.view.destroy({ children: true });
  }
}
