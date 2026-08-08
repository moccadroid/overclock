/**
 * The document UI — the desktop.
 *
 * The between-run surface stopped being a menu and became **a place you work**.
 * That is the whole brief: a run ends, you are back at your desk, the shift clock
 * has moved, a file has arrived, and one message is waiting. A menu cannot do any
 * of that, because a menu is not anywhere.
 *
 * This owns the parts a window cannot own for itself:
 *
 *   **z-order and focus.** Overlapping, not tiled. Windows 1.0 tiled and Windows
 *   2.0 overlapped, and overlapping is the one that reads as a desk — depth is
 *   what makes a screen feel like it has things *on* it rather than *in* it.
 *
 *   **one drag state.** Windows report that a drag began; the gesture lives here.
 *   Per-window drag means every window subscribes to stage-level pointer moves
 *   and each one independently decides whether the gesture is still theirs, which
 *   is how a window ends up stuck to the cursor after a pointerup lands outside
 *   the canvas. There is exactly one thing being dragged, so there is exactly one
 *   variable holding it.
 *
 *   **the strip.** Open windows, and the clock.
 *
 * ---
 *
 * **The clock is a plot device.** Six runs across one night: 22:10 to 02:40. §9
 * already dates a file at 2140 — "the 46 file moved to your terminal at 2140" —
 * so the shift clock is canon rather than decoration, and her *finish tonight*
 * stops being a line and becomes a number the player keeps glancing at. It costs
 * this file one string.
 */
import { Container, Graphics, Rectangle, Text } from 'pixi.js';
import { C, style } from './tokens';
import type { Win } from './window';

/** The strip along the bottom: where the open windows and the clock live. */
const STRIP_H = 44;
const STRIP_PAD = 14;
/**
 * Clear desk under the strip.
 *
 * It sat flush to the bottom edge and read as part of the frame rather than as
 * something lying on the desk. A strip needs floor under it for the same reason
 * a window does.
 */
const STRIP_GAP = 16;

export interface DesktopState {
  /** Site designation, top left, the way a workstation names its host. */
  site: string;
  /** The operator, redacted from themselves. NARRATIVE §5.2. */
  operator: string;
  /** Shift number. It does not start at 1 and nobody asks about the first 1146. */
  shift: number;
  /** The site restoration index. Always 04 until RESET makes it 05. */
  revision: string;
  /** Wall clock, as the shift sees it: minutes since midnight. */
  clock: number;
}

export class Desktop {
  readonly view = new Container();
  /** Wallpaper and the site's own markings. Under everything. */
  private readonly ground = new Graphics();
  /**
   * Things lying *on* the desk, under every window — the icons.
   *
   * They were a sibling of the whole desktop, added after it, so they drew over
   * open windows: a folder icon floating on top of the config sheet. An icon is on
   * the desk surface, so it belongs between the wallpaper and the windows.
   */
  readonly wallpaper = new Container();
  /** Every window, in z-order: last child is frontmost. */
  private readonly windows = new Container();
  private readonly strip = new Graphics();
  private readonly stripLabels = new Container();

  private readonly hostText: Text;
  private readonly clockText: Text;

  private readonly open: Win[] = [];
  private focusedId: string | null = null;

  /** The one drag in progress, if any. See the header for why there is only one. */
  private drag: { win: Win; offsetX: number; offsetY: number } | null = null;

  private w = 0;
  private h = 0;
  private state: DesktopState;

  /** Raised when the frontmost window changes, so the caller can re-route keys. */
  onFocusChange: ((id: string | null) => void) | null = null;

  constructor(state: DesktopState) {
    this.state = state;
    this.hostText = new Text({ text: '', style: style(10, C.faint, 3) });
    this.clockText = new Text({ text: '', style: style(13, C.dim, 5) });
    this.clockText.anchor.set(1, 0);
    this.hostText.eventMode = 'none';
    this.clockText.eventMode = 'none';

    // Clicking the wallpaper defocuses. A desk you cannot put down is a desk
    // where the keyboard always belongs to whatever you touched last.
    this.ground.eventMode = 'static';
    this.ground.on('pointerdown', () => this.focus(null));

    this.view.addChild(
      this.ground,
      this.hostText,
      this.wallpaper,
      this.windows,
      this.strip,
      this.stripLabels,
      this.clockText,
    );
    this.setState(state);
  }

  setState(s: DesktopState): void {
    this.state = s;
    this.hostText.text =
      `SITE ${s.site}   OPERATOR ${s.operator}   SHIFT ${s.shift}   REVISION ${s.revision}`;
    this.clockText.text = clockLabel(s.clock);
  }

  /** Advance the wall clock. The night gets later; nothing else changes. */
  setClock(minutes: number): void {
    this.state.clock = minutes;
    this.clockText.text = clockLabel(minutes);
  }

  // ------------------------------------------------------------------ windows

  has(id: string): boolean {
    return this.open.some((w) => w.id === id);
  }

  /** How many windows are on the desk. Used to cascade the next one. */
  get count(): number {
    return this.open.length;
  }

  /** The lowest a window may reach: the strip and its gap are not desk. */
  get contentBottom(): number {
    return this.h - STRIP_H - STRIP_GAP;
  }

  get(id: string): Win | undefined {
    return this.open.find((w) => w.id === id);
  }

  /** Every open window, in the order they were opened. */
  get all(): readonly Win[] {
    return this.open;
  }

  get focused(): Win | null {
    return this.open.find((w) => w.id === this.focusedId) ?? null;
  }

  /**
   * Put a window on the desk, wired up, focused, and clamped on screen.
   *
   * Opening an id that is already open raises the existing one instead of making
   * a second: two FILES windows is a bug in every operating system ever shipped
   * and it would be a bug here.
   */
  add(win: Win): Win {
    const already = this.get(win.id);
    if (already) {
      win.destroy();
      this.focus(already.id);
      return already;
    }

    win.onFocus = () => this.focus(win.id);
    win.onClose = () => this.close(win.id);
    win.onDragStart = (ox, oy) => {
      this.drag = { win, offsetX: ox, offsetY: oy };
      this.focus(win.id);
    };

    win.layout();
    win.view.position.set(win.spec.x, win.spec.y);
    this.open.push(win);
    this.windows.addChild(win.view);
    this.clamp(win);
    this.focus(win.id);
    this.paintStrip();
    return win;
  }

  close(id: string): void {
    const i = this.open.findIndex((w) => w.id === id);
    if (i < 0) return;
    const [win] = this.open.splice(i, 1);
    if (!win) return;
    if (this.drag?.win === win) this.drag = null;
    this.windows.removeChild(win.view);
    win.destroy();
    if (this.focusedId === id) {
      // **Nothing is raised in its place.**
      //
      // This used to hand focus to `open[open.length - 1]` — the last window
      // *opened*, which is not the same as the topmost one, so closing a window
      // brought some semi-arbitrary other window to the front. It read exactly
      // like the click passing through the X into whatever was underneath.
      //
      // A click on a close box means close this, and nothing else. The desk simply
      // has one window fewer, and the player picks what they want next.
      this.focusedId = null;
      for (const w of this.open) w.setFocused(false);
      this.onFocusChange?.(null);
    }
    this.paintStrip();
  }

  closeAll(): void {
    for (const win of this.open.splice(0)) {
      this.windows.removeChild(win.view);
      win.destroy();
    }
    this.drag = null;
    this.focusedId = null;
    this.paintStrip();
  }

  focus(id: string | null): void {
    if (id === this.focusedId) return;
    this.focusedId = id;
    for (const win of this.open) win.setFocused(win.id === id);
    // Raising is a reorder of the display list, and the array is left alone: it
    // is the *open* order, and the strip is stabler if its buttons do not
    // reshuffle every time the player looks at a different window.
    const win = id ? this.get(id) : undefined;
    if (win) this.windows.setChildIndex(win.view, this.windows.children.length - 1);
    this.paintStrip();
    this.onFocusChange?.(id);
  }

  /** Frontmost first — the order the keyboard should be offered to windows. */
  cycle(dir: number): void {
    if (this.open.length < 2) return;
    const order = this.open.map((w) => w.id);
    const at = this.focusedId ? order.indexOf(this.focusedId) : -1;
    const n = order.length;
    this.focus(order[(((at + dir) % n) + n) % n]!);
  }

  // ------------------------------------------------------------------ pointer

  /**
   * The drag, continued and finished.
   *
   * Driven from the caller's own stage handlers rather than subscribed here,
   * because the stage belongs to the shell and one component reaching up to
   * install global listeners is how two of them end up fighting over the same
   * gesture.
   */
  pointerMove(x: number, y: number): void {
    const d = this.drag;
    if (!d) return;
    d.win.view.position.set(x - d.offsetX, y - d.offsetY);
    this.clamp(d.win);
  }

  pointerUp(): void {
    this.drag = null;
  }

  get dragging(): boolean {
    return this.drag !== null;
  }

  /**
   * A window may hang off the edge, but its titlebar may never leave.
   *
   * The rule that matters: whatever happens, the thing you grab it by has to
   * stay grabbable. Losing a window behind the strip or off the top is
   * unrecoverable without a "tidy desk" command nobody would find.
   */
  private clamp(win: Win): void {
    // Nothing to clamp against before the first layout, and clamping anyway is
    // not harmless: `maxX` becomes `0 - 80`, so every window added at mount time
    // was dragged to x = −80 and opened half off the left edge. A window's
    // authored position has to survive being opened before the desk is measured.
    if (this.w === 0 || this.h === 0) return;
    const p = win.view.position;
    const maxX = this.w - 80;
    p.x = Math.max(-(win.width - 120), Math.min(maxX, Math.round(p.x)));

    // The bottom, properly. This clamped the *top* edge only, so a window could
    // sit legally at its maximum y and still have three hundred pixels of itself
    // below the strip — over it, under it, and past the bottom of the desk. A
    // window's whole body belongs on the desk, so its bottom is what is bounded,
    // and only a window taller than the desk is allowed to overhang (upward,
    // keeping its titlebar reachable).
    const floor = this.contentBottom;
    const maxY = Math.max(0, floor - win.height);
    p.y = Math.max(0, Math.min(maxY, Math.round(p.y)));
  }

  // ------------------------------------------------------------------- layout

  layout(vw: number, vh: number): void {
    this.w = vw;
    this.h = vh;

    this.ground.clear();
    this.ground.rect(0, 0, vw, vh).fill({ color: 0x04060a, alpha: 1 });
    this.ground.hitArea = new Rectangle(0, 0, vw, vh);
    // The site's own grid, very faint, at the same 120-unit pitch the arena
    // floor uses. The desk and the room the operator works in are the same
    // building, and it is the cheapest possible way to say so.
    for (let x = 120; x < vw; x += 120) this.ground.rect(x, 0, 1, vh).fill({ color: 0x0a1018 });
    for (let y = 120; y < vh - STRIP_H - STRIP_GAP; y += 120)
      this.ground.rect(0, y, vw, 1).fill({ color: 0x0a1018 });

    this.hostText.position.set(STRIP_PAD, 12);

    for (const win of this.open) {
      win.layout();
      this.clamp(win);
    }

    this.paintStrip();
  }

  private paintStrip(): void {
    const vw = this.w;
    const vh = this.h;
    const top = vh - STRIP_H - STRIP_GAP;

    this.strip.clear();
    this.strip.rect(STRIP_PAD, top, vw - STRIP_PAD * 2, STRIP_H).fill({ color: 0x070a10, alpha: 1 });
    this.strip.rect(STRIP_PAD, top, vw - STRIP_PAD * 2, 1).fill(C.rule);
    this.strip.rect(STRIP_PAD, top + STRIP_H - 1, vw - STRIP_PAD * 2, 1).fill(C.rule);

    // One button per open window, in the order they were opened.
    this.stripLabels.removeChildren().forEach((c) => c.destroy());
    let x = STRIP_PAD * 2;
    for (const win of this.open) {
      const on = win.id === this.focusedId;
      const label = new Text({
        text: win.spec.title,
        style: style(12, on ? C.bright : C.dim, 4),
      });
      const bw = Math.round(label.width) + 30;
      const by = top + 8;
      const bh = STRIP_H - 16;
      // The button draws itself and is its own hit target — see `Win` for the
      // whole story about bare hit areas on childless containers.
      const button = new Graphics();
      button.rect(x, by, bw, bh).fill({ color: on ? C.paper : C.void, alpha: on ? 0.14 : 0.9 });
      button.rect(x, by, bw, 1).fill(on ? C.paper : C.rule);
      button.rect(x, by + bh - 1, bw, 1).fill(on ? C.paper : C.rule);
      button.rect(x, by, 1, bh).fill(on ? C.paper : C.rule);
      button.rect(x + bw - 1, by, 1, bh).fill(on ? C.paper : C.rule);
      button.eventMode = 'static';
      button.cursor = 'pointer';
      button.hitArea = new Rectangle(x, by, bw, bh);
      button.on('pointertap', () => this.focus(win.id));
      label.eventMode = 'none';
      label.position.set(x + 15, by + Math.round((bh - 14) / 2));

      this.stripLabels.addChild(button, label);
      x += bw + 8;
    }

    this.clockText.position.set(vw - STRIP_PAD * 2, top + Math.round((STRIP_H - 14) / 2));
  }

  destroy(): void {
    this.closeAll();
    this.view.destroy({ children: true });
  }
}

/**
 * The shift clock, as a workstation would print it.
 *
 * Twenty-four hour and zero-padded, because this is a government building and
 * the operator is on nights.
 */
export function clockLabel(minutes: number): string {
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
  const hh = Math.floor(m / 60)
    .toString()
    .padStart(2, '0');
  const mm = (m % 60).toString().padStart(2, '0');
  return `${hh}:${mm}`;
}
