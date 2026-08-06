/**
 * The document UI — the sheet.
 *
 * One piece of headed paper: a hairline frame, a typed heading, a file
 * reference, a rule above the footer, and a stamp struck across the corner. A
 * department does not redesign its stationery per memo, so every screen is this
 * object with different words on it.
 *
 * The chassis owns the furniture and the frame; the caller owns the words and
 * any controls, which it places against `grid` in columns and rows.
 */
import { Container, Graphics, Text } from 'pixi.js';
import { Grid } from './grid';
import { C, LINE, type Line, charW, style } from './tokens';

/** Margins, in pixels, because the frame is not on the character grid. */
const PAD = 56;
const HEAD_RULE = 82;
const FOOT_RULE = 54;
/** Rows of clear space kept under the last line, so the stamp has somewhere to
 *  land that is not on top of a sentence. */
const STAMP_ROWS = 3;

export interface SheetSpec {
  /** Typed across the top. */
  head: string;
  /** Its catalogue reference, top right. Every sheet has been filed. */
  ref: string;
  /** What it was hit with, and in what ink. Defaults to signal red. */
  stamp?: string;
  stampInk?: number;
}

export class Sheet {
  readonly view = new Container();
  readonly grid = new Grid();
  /** Controls go here, above the text and below nothing. */
  readonly controls = new Container();

  private readonly chrome = new Graphics();
  private readonly headText: Text;
  private readonly refText: Text;
  private readonly stampText: Text | null;

  private w = 0;

  constructor(spec: SheetSpec) {
    this.headText = new Text({ text: spec.head, style: style(14, C.bright, 8) });
    this.refText = new Text({ text: spec.ref, style: style(11, 0x35485e, 4) });
    this.refText.anchor.set(1, 0);
    this.stampText = spec.stamp
      ? new Text({ text: spec.stamp, style: style(19, spec.stampInk ?? C.signal, 5) })
      : null;
    if (this.stampText) {
      this.stampText.anchor.set(0.5, 0.5);
      // Struck after filing, so it does not respect the layout.
      this.stampText.rotation = -0.17;
      this.stampText.alpha = 0.82;
    }

    // Bands, then text, then controls: a control's highlight has to sit under
    // the words it is highlighting, and its hit area over them.
    this.view.addChild(this.chrome, this.grid.view, this.controls);
    this.view.addChild(this.headText, this.refText);
    if (this.stampText) this.view.addChild(this.stampText);
  }

  /** Where the character grid starts, in pixels from the sheet's corner. */
  get originX(): number {
    return PAD;
  }
  get originY(): number {
    return 112;
  }

  /**
   * The height this sheet needs for `rows` lines of body.
   *
   * A document is as long as what is typed on it. Fixing the height and hoping
   * the copy fits is how the body ended up running out through the bottom of
   * the frame — and how the stamp ended up across a sentence.
   */
  heightFor(rows: number): number {
    return this.originY + (rows + STAMP_ROWS) * LINE + FOOT_RULE;
  }

  /** How many columns of body text this sheet holds at its current size. */
  get cols(): number {
    return Math.floor((this.w - PAD * 2) / charW());
  }

  setLines(lines: readonly Line[]): void {
    this.grid.set(lines);
  }

  layout(w: number, h: number): void {
    this.w = w;

    this.chrome.clear();
    this.chrome.rect(0, 0, w, h).fill({ color: C.void, alpha: 0.985 });
    this.chrome.rect(0, 0, w, 1).fill(C.paper);
    this.chrome.rect(0, h - 1, w, 1).fill(C.paper);
    this.chrome.rect(0, 0, 1, h).fill(C.paper);
    this.chrome.rect(w - 1, 0, 1, h).fill(C.paper);
    // Two rules, and they are the only structure the sheet has.
    this.chrome.rect(PAD, HEAD_RULE, w - PAD * 2, 1).fill(C.faint);
    this.chrome.rect(PAD, h - FOOT_RULE, w - PAD * 2, 1).fill(C.rule);

    this.headText.position.set(PAD, 38);
    this.refText.position.set(w - PAD, 42);
    this.stampText?.position.set(w - 130, h - FOOT_RULE - LINE);

    this.grid.view.position.set(this.originX, this.originY);
    this.controls.position.set(this.originX, this.originY);
  }

  destroy(): void {
    this.view.destroy({ children: true });
  }
}
