/**
 * The document UI — the intrusion. NARRATIVE §4.2, §8.
 *
 * **The anti-sheet.** Bureau documents are *typeset* — headed paper, a file
 * reference, a stamp struck across the corner. This is a **process window**: a
 * one-pixel border, a title bar, and raw monospace inside it. It did not arrive
 * through the document system, and it does not pretend to have. That contrast is
 * the firewall the twist rides on (§13.5) — the player tells the two voices
 * apart by the shape of the page long before they can tell them apart by content.
 *
 * The title bar reads **INTERNAL CONNECTION**, which is true (§13.1) and reads
 * as nothing at all the first time: an internal network is what you would expect
 * a site terminal to be on. It is the only place in the game that says where the
 * channel comes from, and it says it in the first five seconds.
 *
 * Two rules this component exists to enforce:
 *
 *   **It types.** Character by character, at a human rate. A message that
 *   appears fully formed is a document; a message that arrives while you watch
 *   is somebody at a keyboard. It is the cheapest possible way to make the
 *   channel feel occupied.
 *
 *   **There is no report action.** §10 turns entirely on the player having read
 *   nine of these and filed zero reports — and never once having been offered a
 *   button that would have let them. That omission is load-bearing. **Do not add
 *   a Report control to this component.** The only thing you can do with a
 *   transmission is finish reading it.
 *
 * The distortion is not this component's business. Interference is a property of
 * the glass — see `fx.ts` — so the terminal misbehaves while the intrusion is up
 * rather than the intrusion being drawn in a spooky font.
 */
import { Container, Graphics, Text } from 'pixi.js';
import { C, LINE, SIZE, charW, style } from './tokens';

/** Units per second. A character is one unit; a pause is several. */
const RATE = 42;

/**
 * The connection, printing itself before anything is said.
 *
 * Technical fluff, and it is doing two jobs. It gives the window something to
 * do while it arrives, so a message does not simply appear; and it is the only
 * place in the game that states where the channel comes from — truthfully, in
 * the register of a comms stack, three seconds before anybody starts lying on
 * it. §13.1 holds: every line here is true.
 */
const BANNER = [
  'CARRIER DETECTED — CHANNEL NOT ON APPROVED LIST',
  'HANDSHAKE ......... OK',
  'CONNECTION ESTABLISHED — SOURCE ████ INTERNAL',
];

/**
 * And the connection going away again.
 *
 * Closed *by remote*, every time: the operator never ends one of these, and
 * never gets the chance to. It is the same fact as the missing Report control
 * (§10) stated in the comms stack's own words — the channel is one-way, and the
 * far end decides when it is over.
 */
const TAIL = ['REMOTE CLOSED SESSION', 'CARRIER LOST'];

/**
 * What a character costs.
 *
 * Typing at a flat rate is a spooling tape. A hand stops at the end of a
 * sentence and again at the end of a line, and those two pauses are most of what
 * makes it read as somebody thinking rather than a buffer draining.
 */
function costAfter(char: string): number {
  if (char === '.' || char === '?' || char === '!') return 9;
  if (char === ',') return 4;
  return 1;
}
/** The beat at the end of a line, before the next one starts. */
const LINE_PAUSE = 14;

/** Window furniture. Enough to be a window and not a pixel more. */
const TITLE_H = 22;
const PAD = 14;
const TITLE = 'INTERNAL CONNECTION';

export class Transmission {
  readonly view = new Container();

  private readonly lines: string[];
  private readonly texts: Text[] = [];
  private readonly caret: Text;
  private readonly frame = new Graphics();
  /** Cumulative cost at which each line's Nth character appears. */
  private readonly costs: number[][] = [];
  /** Rows before and after the message: the connection, not the voice on it. */
  private readonly banner: number;
  private readonly bodyEnd: number;
  private shown = 0;
  private total: number;
  private struck = 0;
  readonly width: number;
  readonly height: number;

  /**
   * @param onStrike fired as characters appear, throttled — `true` while the
   * banner is printing, `false` once somebody is typing. The two want different
   * sounds and the caller is the only thing that knows what they are.
   */
  constructor(
    lines: readonly string[],
    private readonly onStrike?: (isBanner: boolean) => void,
  ) {
    this.banner = BANNER.length;
    this.bodyEnd = this.banner + lines.length;
    // The blank row is a beat: it costs a line pause and prints nothing, so the
    // disconnection lands after a silence rather than on the heels of the last
    // thing said.
    this.lines = [...BANNER, ...lines, '', ...TAIL];

    // Cost is precomputed rather than derived while typing, so a pause is a
    // property of the text and not a special case in the update loop.
    let running = 0;
    for (const line of this.lines) {
      const perChar: number[] = [];
      for (const char of line) {
        running += costAfter(char);
        perChar.push(running);
      }
      running += LINE_PAUSE;
      this.costs.push(perChar);
    }
    this.total = running;

    // Sized to its contents, like a window that opened at the size it needed.
    const cols = Math.max(TITLE.length + 6, ...this.lines.map((l) => l.length)) + 1;
    this.width = Math.round(cols * charW()) + PAD * 2;
    this.height = TITLE_H + PAD + this.lines.length * LINE + PAD;

    this.view.addChild(this.frame);
    this.paintFrame();

    const title = new Text({ text: TITLE, style: style(10, C.barInk, 3) });
    title.position.set(PAD, Math.round((TITLE_H - title.height) / 2));
    this.view.addChild(title);

    for (let i = 0; i < this.lines.length; i++) {
      // Lowercase, unspaced, left-aligned. Nothing here is set — it is typed.
      // The banner is dimmer: it is the wire, not the message on it.
      const t = new Text({ text: '', style: style(SIZE, this.isWire(i) ? C.faint : C.bright) });
      t.position.set(PAD, TITLE_H + PAD + i * LINE);
      this.texts.push(t);
      this.view.addChild(t);
    }
    this.caret = new Text({ text: '█', style: style(SIZE, C.bright) });
    this.view.addChild(this.caret);
  }

  /** True for the connection's own lines, at either end of the message. */
  private isWire(row: number): boolean {
    return row < this.banner || row >= this.bodyEnd;
  }

  /**
   * A filled body, a title bar, and a one-pixel border.
   *
   * Opaque, because it is a window and not an overlay: whatever is behind it is
   * *behind* it, tearing away while this sits still. A translucent panel would
   * read as part of the terminal, which is the one thing it is not.
   */
  private paintFrame(): void {
    this.frame
      .rect(0, 0, this.width, this.height)
      .fill({ color: 0x05070c, alpha: 0.97 })
      .rect(0, 0, this.width, TITLE_H)
      .fill(C.bar)
      .rect(0, 0, this.width, 1)
      .fill(C.paper)
      .rect(0, this.height - 1, this.width, 1)
      .fill(C.paper)
      .rect(0, 0, 1, this.height)
      .fill(C.paper)
      .rect(this.width - 1, 0, 1, this.height)
      .fill(C.paper);
  }

  get done(): boolean {
    return this.shown >= this.total;
  }

  /** Reveal everything at once, for a player who does not want to wait. */
  finish(): void {
    this.shown = this.total;
    this.paint();
  }

  update(dt: number): void {
    if (this.done) return;
    this.shown = Math.min(this.total, this.shown + dt * RATE);
    this.paint();
  }

  private paint(): void {
    const at = this.shown;
    let caretRow = 0;
    let struck = 0;

    for (let i = 0; i < this.lines.length; i++) {
      const line = this.lines[i]!;
      const costs = this.costs[i]!;
      // How many characters of this line have been paid for. The costs are
      // ascending, so this is the count of entries at or below the clock.
      let take = 0;
      while (take < costs.length && costs[take]! <= at) take++;
      this.texts[i]!.text = line.slice(0, take);
      struck += take;
      if (take > 0) caretRow = i;
    }

    // One sound every few characters. Per character at forty a second is a
    // rattle, and the ear reads the gaps as rhythm either way.
    if (struck >= this.struck + 3) {
      this.struck = struck;
      this.onStrike?.(this.isWire(caretRow));
    }

    this.caret.visible = !this.done;
    this.caret.position.set(
      PAD + this.texts[caretRow]!.width,
      TITLE_H + PAD + caretRow * LINE,
    );
  }

  destroy(): void {
    this.view.destroy({ children: true });
  }
}
