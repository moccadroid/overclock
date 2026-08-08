/**
 * Display calibration. §20.1.
 *
 * One word, one slider, and it runs **before anything else on the page** — the
 * shell is unreadable on an uncorrected panel, so a calibration screen reached
 * through the shell is a key locked inside the door it opens.
 *
 * Deliberately not a Sheet. Everything else in this game is a filed document
 * because the Bureau filed it; this is the only screen that exists outside the
 * fiction entirely, addressed to the person rather than to the operator, and
 * dressing it as stationery would be both a lie and four paragraphs the player
 * has to read before they can see. Black field, the wordmark at 5%, a track.
 *
 * See `app/gfx/display.ts` for what the track actually moves.
 */
import { Application, Container, Graphics, Rectangle, Text } from 'pixi.js';
import { BRANDING } from '../../branding';
import type { Library } from '../../meta/profile';
import { C, style } from '../ui';
import { DISPLAY, DisplayPass, GAMMA_MAX, GAMMA_MIN, GAMMA_STEP, setGamma } from '../gfx/display';

/**
 * The target: the wordmark, at 2%.
 *
 * The value is the only thing that was ever wrong with this screen. It shipped
 * at 5% — *above* `background` (7.1% blue) and `mass` (3.5%), the two values it
 * was standing in for — so on a decent panel it was plainly visible before the
 * player touched anything, and the only honest way to satisfy "barely visible"
 * was to turn the whole game down. Which is what happened, and the arena went
 * black.
 *
 * At 2% it sits *below* the mass, which is the darkest thing the game asks
 * anyone to see. On a correct panel it is faintly there at 1.00 and the player
 * stops immediately; on a dim one it is nothing until they raise it. And with
 * the range's floor now at 1.00 there is no longer a wrong answer to reach —
 * the worst this screen can do is leave the game exactly as authored.
 *
 * The attempt in between drew a real slab of `mass` on a real field of
 * `background` — technically the exact pass condition, and completely opaque as
 * an instruction. Nobody knows when two dark rectangles have "separated". A word
 * you either can or cannot read needs no explanation, which is the whole reason
 * every game has shipped this screen and not that one.
 */
const TARGET = 0x050505;
const TRACK_W = 320;
const TRACK_H = 10;

/** The screen, as a container. Hosted by `calibrate` below, or by the shell. */
export class CalibrationView {
  readonly view = new Container();

  private readonly art = new Graphics();
  private readonly mark = new Text({ text: BRANDING.title, style: style(40, TARGET, 22) });
  private readonly ask = new Text({
    text: 'raise until the word above is only just visible',
    style: style(14, C.ink, 3),
  });
  private readonly hint = new Text({
    text: '[← →] darker / brighter      [ENTER] continue',
    style: style(12, C.dim, 3),
  });

  private dragging = false;
  private w = 0;
  private h = 0;

  constructor(
    private readonly onChange: (gamma: number) => void,
    private readonly onDone: (gamma: number) => void,
  ) {
    for (const t of [this.mark, this.ask, this.hint]) t.anchor.set(0.5, 0.5);
    this.view.addChild(this.art, this.mark, this.ask, this.hint);

    this.view.eventMode = 'static';
    this.view.hitArea = new Rectangle(-8000, -8000, 16000, 16000);
    this.view.on('pointerdown', (e) => this.grab(e.global.x, e.global.y));
    this.view.on('pointermove', (e) => this.dragging && this.slide(e.global.x));
    this.view.on('pointerup', () => (this.dragging = false));
    this.view.on('pointerupoutside', () => (this.dragging = false));

    this.hint.eventMode = 'static';
    this.hint.cursor = 'pointer';
    this.hint.on('pointertap', () => this.onDone(DISPLAY.gamma));
  }

  layout(w: number, h: number): void {
    this.w = w;
    this.h = h;
    const cx = Math.round(w / 2);
    const cy = Math.round(h * 0.42);
    this.mark.position.set(cx, cy);
    this.ask.position.set(cx, cy + 96);
    this.hint.position.set(cx, cy + 196);
    this.paint();
  }

  /** Where the track sits, in screen pixels. One source, three readers. */
  private track(): { x0: number; y: number } {
    return {
      x0: Math.round(this.w / 2) - TRACK_W / 2,
      y: Math.round(this.h * 0.42) + 144,
    };
  }

  paint(): void {
    const { x0, y } = this.track();
    const t = (DISPLAY.gamma - GAMMA_MIN) / (GAMMA_MAX - GAMMA_MIN);

    this.art.clear();
    this.art.rect(0, 0, this.w, this.h).fill(0x000000);
    this.art.rect(x0, y, TRACK_W, TRACK_H).fill(C.rule);
    this.art.rect(x0, y, Math.round(TRACK_W * t), TRACK_H).fill(C.ink);
    this.art.rect(x0 + Math.round(TRACK_W * t) - 1, y - 4, 3, TRACK_H + 8).fill(C.bar);
  }

  /** Arrows and WASD move it; ENTER and SPACE accept. ESC does not — see below. */
  keys(e: KeyboardEvent): boolean {
    const k = e.key.toLowerCase();
    if (k === 'arrowright' || k === 'd') return this.step(1);
    if (k === 'arrowleft' || k === 'a') return this.step(-1);
    // No ESC. It is the one key that means "get me out of here" everywhere else
    // in the shell, and here there is nothing to get out of — the way past this
    // screen is to answer it.
    if (e.key === 'Enter' || e.key === ' ') {
      this.onDone(DISPLAY.gamma);
      return true;
    }
    return false;
  }

  private step(d: number): boolean {
    this.set(DISPLAY.gamma + d * GAMMA_STEP);
    return true;
  }

  private grab(x: number, y: number): void {
    const { x0, y: ty } = this.track();
    // A generous band around the track. It is ten pixels tall and the person
    // aiming at it currently cannot see very much.
    if (y < ty - 22 || y > ty + TRACK_H + 22) return;
    if (x < x0 - 20 || x > x0 + TRACK_W + 20) return;
    this.dragging = true;
    this.slide(x);
  }

  private slide(x: number): void {
    const { x0 } = this.track();
    const t = Math.max(0, Math.min(1, (x - x0) / TRACK_W));
    this.set(GAMMA_MIN + t * (GAMMA_MAX - GAMMA_MIN));
  }

  private set(g: number): void {
    const before = DISPLAY.gamma;
    const after = setGamma(g);
    if (after === before) return;
    // Repainted *before* the host is told, not after. The other order shipped,
    // and it meant the frame the host rendered still had the previous step's
    // track on it — press right, see nothing; press right again, see the first
    // move. A control that lags its own input by one press reads as a control
    // that does not work.
    this.paint();
    this.onChange(after);
  }

  destroy(): void {
    this.view.destroy({ children: true });
  }
}

/**
 * The pre-boot gate: its own Application, torn down before the shell brings up
 * its own. Resolves immediately when the account has already answered.
 *
 * A whole WebGL context for one screen is a cost the rest of this codebase
 * refuses to pay, and it is the right call here for the same reason it is the
 * wrong one everywhere else: nothing else exists yet, and this dies before
 * anything does. The alternative was calibrating *inside* the shell, which means
 * calibrating after LOGIN, which means finding LOGIN on a screen where it is
 * invisible.
 */
export async function calibrate(mount: HTMLElement, library: Library): Promise<void> {
  if (library.snapshot.settings.calibrated) return;

  const app = new Application();
  await app.init({
    background: 0x000000,
    resizeTo: window,
    antialias: true,
    autoDensity: true,
    resolution: Math.min(2, window.devicePixelRatio || 1),
    autoStart: false,
  });
  app.ticker.stop();
  app.canvas.style.position = 'absolute';
  app.canvas.style.inset = '0';
  mount.appendChild(app.canvas);

  const display = new DisplayPass();
  app.stage.filters = [display.filter];

  return new Promise<void>((resolve) => {
    let view: CalibrationView;

    const draw = (): void => {
      display.sync();
      app.render();
    };
    const relayout = (): void => {
      view.layout(app.screen.width, app.screen.height);
      draw();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (view.keys(e)) e.preventDefault();
    };

    view = new CalibrationView(
      (gamma) => {
        library.setDisplay({ gamma });
        draw();
      },
      (gamma) => {
        library.setDisplay({ gamma, calibrated: true });
        window.removeEventListener('keydown', onKey);
        window.removeEventListener('resize', relayout);
        app.canvas.remove();
        app.destroy(true, { children: true });
        resolve();
      },
    );

    app.stage.addChild(view.view);
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', relayout);
    relayout();
    // Rendered on demand rather than on a ticker. Nothing here moves until the
    // player moves it.
    app.canvas.addEventListener('pointermove', draw);
  });
}
