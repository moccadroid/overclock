/**
 * The document UI — a window.
 *
 * The between-run surface is a Bureau-issue workstation, and the Bureau does not
 * buy new equipment. So this is a 1985 window: one weight of border, no
 * gradients, no rounded corners, no shadows, chrome built from rectangles and
 * hairlines. That is the same dialect as the ruins — *mass, not material* — which
 * is the first time the frame and the game have agreed about anything.
 *
 * ---
 *
 * **A window is a form, and forms have numbers.**
 *
 * Every sheet in this game already carries a catalogue reference: the pipeline is
 * `OC-1147-E`, the pause sheet is `OC-1147-P`. Windows inherit that, in the
 * titlebar, and it earns its keep twice. The player learns to read the number as
 * "the site issued this". And then:
 *
 *   **Her window has no number.**
 *
 * It cannot have one, because nobody filed it. Wrong border, wrong weight, warm
 * where the whole machine is cold, and it opens where the layout did not ask for
 * anything. The Bureau's own notice — *"Your terminal has recorded unsolicited
 * text"* — is the system complaining about that window. The intrusion at the
 * centre of the plot becomes a fact you can see on the chrome, and it costs us
 * nothing but the discipline to leave the number off.
 *
 * ---
 *
 * Content is sized and positioned in **columns and rows**, never pixels, for the
 * reason `tokens.ts` states at length: everything on a sheet aligns because it is
 * monospace on a column grid, and there is no graceful degradation available if
 * one element leaves it. A window is a `Grid` with furniture around it, and the
 * furniture is the only part measured in pixels.
 *
 * Dragging is deliberately *not* handled here. The window reports that a drag
 * began and the desktop owns the gesture from there — see `desktop.ts` for why
 * one drag state beats one per window.
 */
import { Container, Graphics, Rectangle, Text } from 'pixi.js';
import { Grid } from './grid';
import { C, LINE, charW, style, type Line } from './tokens';

/**
 * Chrome metrics, in pixels, because the frame is furniture rather than text.
 *
 * `BORDER` is 2 and wants to stay 2. At 1 the window reads as a rectangle drawn
 * on the background; at 3 it reads as a picture frame. Two is the weight that
 * says "moulded plastic" without becoming decorative.
 */
/**
 * **The chrome, once.** Exported because a `Sheet` is the same object with the
 * dragging taken out, and two definitions of "a bordered surface with a heading
 * and a reference" is how the game ended up with an in-run UI that looked like a
 * different program from its own desktop.
 */
export const CHROME = {
  border: 2,
  titleH: 26,
  padX: 12,
  padY: 9,
} as const;

const BORDER = CHROME.border;
const TITLE_H = CHROME.titleH;
/** Clear space inside the frame before the character grid starts. */
const PAD_X = CHROME.padX;
const PAD_Y = CHROME.padY;
/** The close box: a square with an X through it, at the top right. */
const BOX = 12;

/**
 * The panel a window is made of. **Opaque, and slightly above the desk.**
 *
 * It was 96.5% for a while, on the theory that a hairline of wallpaper bleeding
 * through keeps a stack of windows reading as depth. It does — and translucent
 * chrome is a 2003 idea. On a machine this old a window is a sheet of painted
 * metal, and you can see exactly nothing through it. Depth comes from the border
 * and the drop of the titlebar instead, which is how it was actually done.
 *
 * Lifted just above the wallpaper rather than matching it, because a window
 * filled with pure black on a near-black desk reads as a hole cut in the screen
 * rather than as an object lying on it.
 */
export const PANEL = 0x080b12;

/**
 * The frame every surface in the game is drawn with: panel, four-rect border,
 * titlebar band and the rule under it.
 *
 * Four rects rather than a stroke, because a stroke straddles the path and lands
 * on half-pixels at odd sizes — on a 2px border that is the difference between a
 * moulded edge and a blurry one.
 */
export function drawPanel(
  g: Graphics,
  w: number,
  h: number,
  opts: { frame: number; band: boolean; border?: number } = { frame: C.paper, band: true },
): void {
  const b = opts.border ?? BORDER;
  g.rect(0, 0, w, h).fill({ color: PANEL, alpha: 1 });
  g.rect(0, 0, w, b).fill(opts.frame);
  g.rect(0, h - b, w, b).fill(opts.frame);
  g.rect(0, 0, b, h).fill(opts.frame);
  g.rect(w - b, 0, b, h).fill(opts.frame);
  if (opts.band) {
    g.rect(b, b, w - b * 2, TITLE_H - b).fill({ color: C.paper, alpha: 0.13 });
    g.rect(b, TITLE_H, w - b * 2, 1).fill(opts.frame);
  }
}

export interface WindowSpec {
  id: string;
  title: string;
  /**
   * The form number. Omitted only for what the site did not issue, which in this
   * game is exactly one window.
   */
  ref?: string;
  /** Content size, in characters and lines. */
  cols: number;
  rows: number;
  /** Where it opens. Authored, because a window that opens somewhere different
   *  every time never becomes a place. */
  x: number;
  y: number;
  /** Some windows cannot be dismissed. Hers cannot, while she is typing. */
  closable?: boolean;
  /**
   * Off-system chrome. Warm, unnumbered, and the border is a different weight.
   *
   * The palette note: the shell is not a run, so the three fuel hues mean nothing
   * here and amber is free. In the run it would be a lie — thermal means an
   * element — which is exactly why her intrusion is allowed to use it out here
   * and nowhere else.
   */
  foreign?: boolean;
}

export class Win {
  readonly view = new Container();
  readonly grid = new Grid();
  /** Controls sit above the text, on the same grid origin. */
  readonly controls = new Container();

  readonly id: string;
  readonly spec: WindowSpec;

  /** Raised when this window is touched anywhere, and when its close box is hit. */
  onFocus: (() => void) | null = null;
  onClose: (() => void) | null = null;
  /** A drag has begun at this offset inside the titlebar. The desktop takes it. */
  onDragStart: ((offsetX: number, offsetY: number) => void) | null = null;

  private readonly chrome = new Graphics();
  private readonly titleText: Text;
  private readonly refText: Text | null;
  /**
   * The titlebar and the close box, as **drawn geometry that is also the hit
   * target**.
   *
   * Both were empty `Container`s carrying a `hitArea`, and both were broken in
   * the same way: the close box did nothing at all and never showed a pointer
   * cursor, and the titlebar's drag region sat somewhere above the titlebar
   * instead of on it. A childless container has no bounds of its own, and inside
   * a filtered parent Pixi's bounds pass does not reliably resolve a bare
   * `hitArea` into one — the same fault that made the desktop icons decoration.
   *
   * So anything clickable draws itself. Each of these fills its own region first
   * — at a hair of alpha where it should be invisible — so the geometry the
   * pointer tests against is the geometry the player can see.
   */
  private readonly barG = new Graphics();
  private readonly closeG = new Graphics();
  /**
   * The interior, and what clips to it.
   *
   * A document is as long as what is typed on it, and a window is as big as it
   * was declared — so a file with forty lines in a twenty-six line window will
   * write the other fourteen straight down the desktop, across whatever is
   * beneath it. Scroll offsets alone do not fix this: the last visible line
   * still overhangs the frame by a few pixels, and any body that renders one row
   * more than it was asked for escapes entirely.
   */
  private readonly content = new Container();
  private readonly clip = new Graphics();
  /**
   * The classification, struck across the window in red, under the words.
   *
   * Every file in this game is CONFIDENTIAL — that is the joke, and it only
   * lands if it is *marked* rather than mentioned. In the titlebar it read as
   * metadata; across the page at an angle it reads as the stamp somebody put
   * there, and the fact that it is on all of them stops being a detail you have
   * to notice and becomes the wallpaper of the whole job.
   *
   * Under the content, and dim. It is furniture in the most literal sense: the
   * player has to be able to read straight through it.
   */
  private stamp: Text | null = null;
  /** The scroll thumb, when the content is taller than the window. */
  private readonly track = new Graphics();

  private focused = false;
  private w = 0;
  private h = 0;

  constructor(spec: WindowSpec) {
    this.spec = spec;
    this.id = spec.id;

    const ink = spec.foreign ? C.thermal : C.bright;
    this.titleText = new Text({ text: spec.title, style: style(12, ink, 6) });
    this.refText = spec.ref ? new Text({ text: spec.ref, style: style(10, C.dim, 3) }) : null;
    this.refText?.anchor.set(1, 0);
    // See `Grid`: a label must never be the thing the pointer lands on. The title
    // sits in the middle of the drag handle and was eating the middle of it.
    this.titleText.eventMode = 'none';
    if (this.refText) this.refText.eventMode = 'none';

    // Touching any part of a window raises it, and the window carries an explicit
    // `hitArea` (set in `paint`) so that it does.
    //
    // The explicit area is not a nicety, it is the fix for controls inside a
    // window being hoverable and unclickable. Pixi prunes differently for a press
    // than for a move, and with no hit area on the window the search ended like
    // this: `chrome` fills the whole panel, is *not* interactive, passes the hit
    // test, and returns an empty path — which stops the descent and promotes the
    // nearest interactive ancestor (this container) to be the target. Every click
    // inside a window therefore landed on the window.
    //
    // With an area of its own, this container is hit-tested directly and its
    // children are still reached first, so a click on a control goes to the
    // control and a click on bare panel raises the window. `chrome` is taken out
    // of the running entirely — it is paint, and paint is never a target.
    this.view.eventMode = 'static';
    this.chrome.eventMode = 'none';
    this.view.on('pointerdown', () => this.onFocus?.());

    // The titlebar is the drag handle and nothing else is, which is both
    // authentic and the only version that leaves the content clickable.
    this.barG.eventMode = 'static';
    this.barG.cursor = 'grab';
    this.barG.on('pointerdown', (ev) => {
      const local = this.view.toLocal(ev.global);
      this.onDragStart?.(local.x, local.y);
    });

    if (spec.closable !== false) {
      this.closeG.eventMode = 'static';
      this.closeG.cursor = 'pointer';
      // Stopped on the way *down*, not at tap. The titlebar underneath begins a
      // drag on pointerdown, so a close that only intervened at tap time had
      // already picked the window up by then.
      this.closeG.on('pointerdown', (ev) => {
        ev.stopPropagation();
        ev.stopImmediatePropagation();
      });
      this.closeG.on('pointertap', (ev) => {
        ev.stopPropagation();
        ev.stopImmediatePropagation();
        // **Deferred by a frame, deliberately.**
        //
        // Closing destroys this window's whole display tree, and doing that while
        // Pixi is still dispatching the event that caused it leaves the dispatcher
        // walking a chain that no longer exists — it re-resolves a target, finds
        // whatever window was underneath, and delivers the rest of the gesture
        // there. The visible symptom was closing the top window and having the one
        // beneath it jump to the front, from a click the player only aimed at an X.
        //
        // Stopping propagation cannot fix that, because the leak is not the event
        // bubbling: it is the tree changing underneath the event. So the event
        // finishes first and the window goes away after.
        requestAnimationFrame(() => this.onClose?.());
      });
    }

    // **The mask goes on the text, not on the controls.**
    //
    // Both used to live in one masked container, and masking a container breaks
    // Pixi's press/release target tracking: hover still resolves — which is what
    // made this so hard to see — but the tap that Pixi synthesises from a
    // pointerdown and pointerup never arrives. Every control inside a window was
    // therefore hoverable and unclickable.
    //
    // Only the grid ever needed clipping anyway: a document is as long as its
    // copy and will write past the frame, whereas a control is placed inside the
    // window by construction.
    this.content.addChild(this.grid.view, this.controls);
    this.grid.view.mask = this.clip;
    // A mask is not a control. `clip` is a full-size filled rectangle sitting in
    // the window, so while it was hit-testable it shadowed everything inside the
    // window on the press path — which is why controls hovered but never clicked.
    this.clip.eventMode = 'none';

    // Text is not interactive, so labels lying over the titlebar do not shadow
    // it; the close box is added above the bar so it wins where they overlap.
    this.view.addChild(this.chrome, this.barG, this.titleText);
    if (this.refText) this.view.addChild(this.refText);
    this.view.addChild(this.closeG, this.clip, this.content, this.track);
  }

  /** The pixel size this window needs for the content it was declared with. */
  get width(): number {
    return BORDER * 2 + PAD_X * 2 + Math.round(this.spec.cols * charW());
  }
  get height(): number {
    return BORDER * 2 + TITLE_H + PAD_Y * 2 + this.spec.rows * LINE;
  }

  /** Where the character grid starts, relative to the window's own corner. */
  get originX(): number {
    return BORDER + PAD_X;
  }
  get originY(): number {
    return BORDER + TITLE_H + PAD_Y;
  }

  setLines(lines: readonly Line[]): void {
    this.grid.set(lines);
  }

  /** Rename the window. Kept on `spec` so `paint` can re-truncate it. */
  setTitle(text: string): void {
    this.spec.title = text;
    this.titleText.text = text;
    if (this.w > 0) this.paint();
  }

  /**
   * Strike a classification across the window. See `stamp` for why it is here
   * and not in the titlebar.
   */
  setStamp(text: string, ink = C.signal): void {
    if (!this.stamp) {
      this.stamp = new Text({ text, style: style(30, ink, 12) });
      this.stamp.anchor.set(0.5, 0.5);
      // Struck after filing, so it does not respect the layout — the same
      // rotation `Sheet` uses, for the same reason.
      this.stamp.rotation = -0.32;
      // Enough to read as red rather than as a grey smudge, and not enough to
      // compete with a line of body copy lying across it. At 0.09 the colour was
      // gone and only the shape survived, which is the worst of both.
      this.stamp.alpha = 0.16;
      // Under the content and over the panel: the words have to read straight
      // through it.
      this.view.addChildAt(this.stamp, this.view.getChildIndex(this.chrome) + 1);
    }
    this.stamp.text = text;
    this.stamp.style = style(30, ink, 12);
    this.positionStamp();
  }

  private positionStamp(): void {
    const s = this.stamp;
    if (!s || this.w === 0) return;
    // Scaled to the window rather than set at a fixed size. CONFIDENTIAL at 30pt
    // is wider than a 70-column window's interior, so it ran out through both
    // frames and only its middle was ever on the page.
    s.scale.set(1);
    const target = (this.w - PAD_X * 2) * 0.86;
    if (s.width > 0) s.scale.set(Math.min(1.4, target / s.width));
    s.position.set(this.w / 2, (this.h + TITLE_H) / 2);
  }

  /**
   * Re-declare the content size, in characters and lines.
   *
   * 720p is the floor the game has to work at, and a window declared at 24 lines
   * is 617 pixels tall before its chrome — which does not fit under a taskbar on
   * a 720-pixel screen. So sizes are chosen against the viewport rather than
   * fixed, and this is how a window is told.
   */
  resize(cols: number, rows: number): void {
    if (this.spec.cols === cols && this.spec.rows === rows) return;
    this.spec.cols = cols;
    this.spec.rows = rows;
    this.layout();
  }

  /**
   * How far down a longer document this window is looking, as a thumb.
   *
   * Drawn, not interactive. A real scrollbar with arrow buttons is authentic and
   * is also four more hit areas and a repeat timer; the wheel and the arrow keys
   * already scroll, so what is missing is only the answer to "how much more is
   * there", which is what a thumb is for.
   */
  setScroll(offset: number, total: number, visible: number): void {
    this.track.clear();
    if (total <= visible) return;
    const b = this.spec.foreign === true ? 1 : BORDER;
    const x = this.w - b - 5;
    const top = TITLE_H + 4;
    const height = this.h - TITLE_H - b - 8;
    this.track.rect(x, top, 3, height).fill({ color: C.rule, alpha: 1 });
    const thumb = Math.max(18, Math.round((visible / total) * height));
    const span = height - thumb;
    const at = total - visible <= 0 ? 0 : Math.round((offset / (total - visible)) * span);
    this.track.rect(x, top + at, 3, thumb).fill({ color: C.dim, alpha: 1 });
  }

  /**
   * Focused windows get a filled titlebar and the unfocused ones do not.
   *
   * This is the one piece of state the chrome absolutely has to carry. With a
   * dozen overlapping rectangles on a dark ground, "which of these is listening
   * to the keyboard" cannot be answered by z-order alone — the frontmost window
   * may be entirely behind another one.
   */
  setFocused(on: boolean): void {
    if (this.focused === on) return;
    this.focused = on;
    this.paint();
  }

  layout(): void {
    this.w = this.width;
    this.h = this.height;
    this.paint();

    this.grid.view.position.set(this.originX, this.originY);
    this.controls.position.set(this.originX, this.originY);
    this.positionStamp();
  }

  private paint(): void {
    const w = this.w;
    const h = this.h;
    const foreign = this.spec.foreign === true;
    // Unfocused chrome drops to the furniture value rather than dimming the
    // whole window: the words inside a background window stay readable, because
    // reading two documents side by side is the entire reason for a desktop.
    const frame = foreign ? C.thermal : this.focused ? C.paper : C.faint;

    this.chrome.clear();
    this.chrome.rect(0, 0, w, h).fill({ color: PANEL, alpha: 1 });

    // The frame, as four rects rather than a stroke. A stroke straddles the
    // path and lands on half-pixels at odd sizes, which on a 2px border is the
    // difference between a moulded edge and a blurry one.
    const b = foreign ? 1 : BORDER;
    this.chrome.rect(0, 0, w, b).fill(frame);
    this.chrome.rect(0, h - b, w, b).fill(frame);
    this.chrome.rect(0, 0, b, h).fill(frame);
    this.chrome.rect(w - b, 0, b, h).fill(frame);

    // The titlebar band, drawn into its own layer because that layer is the drag
    // handle. Filled edge to edge every time — at a hair of alpha when the window
    // is not focused — so the region the pointer tests is exactly the bar.
    this.barG.clear();
    this.barG
      .rect(b, b, w - b * 2, TITLE_H - b)
      .fill({ color: C.paper, alpha: this.focused && !foreign ? 0.13 : 0.02 });
    this.barG.rect(b, TITLE_H, w - b * 2, 1).fill(foreign ? C.thermal : frame);
    this.barG.hitArea = new Rectangle(0, 0, w, TITLE_H);

    // The close box, top right, with an X through it. Its own layer for the same
    // reason, and it is the thing that finally made it clickable.
    let closeW = 0;
    this.closeG.clear();
    if (this.spec.closable !== false) {
      const cy = Math.round((TITLE_H - BOX) / 2) + 1;
      const cx = w - PAD_X - BOX;
      closeW = BOX + 12;
      // The pad first: a generous target around a 12px box, filled, so a click
      // near the X counts. A hit area alone did not survive the bounds pass.
      this.closeG
        .rect(cx - 6, cy - 6, BOX + 12, BOX + 12)
        .fill({ color: C.paper, alpha: 0.02 });
      this.closeG.rect(cx, cy, BOX, BOX).fill({ color: PANEL, alpha: 1 });
      this.closeG.rect(cx, cy, BOX, 1).fill(frame);
      this.closeG.rect(cx, cy + BOX - 1, BOX, 1).fill(frame);
      this.closeG.rect(cx, cy, 1, BOX).fill(frame);
      this.closeG.rect(cx + BOX - 1, cy, 1, BOX).fill(frame);
      // The X, as two 1px diagonals stepped by hand. A stroked line at this size
      // lands on half-pixels and comes out as two grey smudges.
      const ink = this.focused || foreign ? frame : C.rule;
      for (let i = 3; i < BOX - 3; i++) {
        this.closeG.rect(cx + i, cy + i, 1, 1).fill(ink);
        this.closeG.rect(cx + i, cy + BOX - 1 - i, 1, 1).fill(ink);
      }
      this.closeG.hitArea = new Rectangle(cx - 6, cy - 6, BOX + 12, BOX + 12);
    }

    this.titleText.position.set(PAD_X, Math.round((TITLE_H - 12) / 2));
    this.titleText.style = style(12, foreign ? C.thermal : this.focused ? C.bright : C.dim, 6);
    this.refText?.position.set(w - PAD_X - closeW, Math.round((TITLE_H - 10) / 2) + 1);

    // Truncated to the room it actually has, between the left padding and
    // whatever the reference and the close box are using. A titlebar is not a
    // status line: an over-long title used to run straight out of the frame and
    // across the windows beside it, which reads as a rendering fault.
    const refW = this.refText ? Math.ceil(this.refText.width) + 16 : 0;
    const room = Math.max(40, w - PAD_X * 2 - closeW - refW);
    if (this.titleText.width > room) {
      const full = this.spec.title;
      const perChar = this.titleText.width / Math.max(1, full.length);
      const keep = Math.max(3, Math.floor(room / perChar) - 1);
      this.titleText.text = `${full.slice(0, keep)}…`;
    } else if (this.titleText.text !== this.spec.title) {
      this.titleText.text = this.spec.title;
    }

    // The interior, to the pixel. A row of clear space is left at the bottom so
    // a clipped line is visibly cut rather than looking like the copy ended.
    // The window is its own hit target, at its current size.
    this.view.hitArea = new Rectangle(0, 0, w, h);

    this.clip.clear();
    this.clip
      .rect(b, TITLE_H + 1, w - b * 2, h - TITLE_H - 1 - b)
      .fill({ color: 0xffffff, alpha: 1 });
  }

  destroy(): void {
    this.view.destroy({ children: true });
  }
}
