/**
 * The desk, hosted.
 *
 * Brings up the renderer, mounts the desktop, and resolves when the operator
 * accepts a shift — deliberately the same contract `TitleScreen.present()` has,
 * so `main.ts` can hand the between-run surface to either one and the run knows
 * no difference.
 *
 * Everything here is plumbing the surface cannot own for itself: the canvas, the
 * glass, the panel correction, and the three global gestures. Two of those are
 * worth a word.
 *
 * **The drag lives on the stage, not on the window.** A pointer that leaves the
 * canvas mid-drag never delivers its `pointerup` to the thing being dragged, so
 * the window stays welded to the cursor. `pointerupoutside` and a stage-level
 * move are the fix, and they only work if exactly one component is listening —
 * see `desktop.ts`.
 *
 * **The glass is applied to the desk and not to the stage.** When the resistance
 * takes over the terminal, the tear has to hit the *site's* windows and not the
 * one doing the tearing, which is only expressible as two layers.
 */
import { Application, Container, Rectangle } from 'pixi.js';
import { BEAT_BY_ID } from '../../story/script';
import { CalibrationView } from './calibrate';
import { DocumentSheet } from './document';
import type { Audio } from '../../audio/audio';
import type { Library } from '../../meta/profile';
import type { StoryStore } from '../../story/store';
import { Glass, Transmission, chromeGlass, tearGlass } from '../ui';
import { DisplayPass } from '../gfx/display';
import { Desk, type DeskResult } from './desk';

function randomSeed(): string {
  return `run-${Math.floor(Math.random() * 1e9).toString(36)}`;
}

export class DeskShell {
  private readonly app = new Application();
  /** Everything the intrusion happens *to*. */
  private readonly behind = new Container();
  /**
   * The tube, tuned with a document open rather than on an empty screen.
   *
   * `?crt=0` takes it all off, which is how the layout gets judged: every one of
   * these takes light away, and a legibility problem and a brightness problem
   * look identical through them.
   */
  private readonly crtOff = new URLSearchParams(location.search).get('crt') === '0';
  /**
   * How hard the tube bends. **Zero, and it has to be.**
   *
   * The bend looked genuinely good and it cost four rounds of the interface being
   * broken, so it is worth writing down exactly why it is gone.
   *
   * A barrel warp in the display shader moves every pixel; Pixi hit-tests the
   * untouched scene graph. Input and output therefore disagree by nothing at the
   * centre and by tens of pixels at the edges, and the errors are not subtle —
   * a close box 24 pixels tall was displaced 31, so it could not be hit at all.
   *
   * Inverting the warp on the way in is the obvious fix and it *nearly* works,
   * which is the trap. The shader's coordinates are not screen coordinates: they
   * are normalised over the filter's output frame, which Pixi derives from the
   * filtered container's bounds and then pads. Pinning `filterArea` fixed the
   * scale and left an eleven-pixel offset from the padding. Every iteration got
   * closer and none of them was right, and a hit test that is *nearly* right is
   * worse than an honest one — it reads as the game being broken at random.
   *
   * So the tube keeps everything that does not move a pixel: scanlines, the
   * aperture grille, the vignette, the mains breathe, and the bezel inset that
   * makes it a screen sitting in a frame. If the bend comes back it belongs
   * somewhere nothing is clickable — the boot sequence, or the ending.
   */
  private readonly curve = 0;
  private readonly glass = new Glass(
    this.crtOff
      ? {}
      : // Tuned on screen with a document open. The vignette came down from 0.42,
        // where a window parked bottom-right lost its own footer.
        { scan: 0.26, vignette: 0.3, curve: this.curve, grille: 0.09, breathe: 0.012 },
  );
  private readonly display = new DisplayPass();
  private desk: Desk | null = null;

  /**
   * Above the glass, so the window doing the tearing is not itself torn.
   * §8 — the intrusion happens *to* the site, and the site is `behind`.
   */
  private readonly intrusionLayer = new Container();
  /** The quantised-band shader the terminal used while she is typing. */
  private readonly tear = new Glass({ tear: 1, split: 1.8, noise: 0.07, scan: 0.34 });
  private intrusion: Transmission | null = null;
  private intrusionId: string | null = null;
  private noticeSheet: DocumentSheet | null = null;
  private noticeId: string | null = null;
  private calibrationView: CalibrationView | null = null;
  /** True while a run is waiting on the channel to finish. */
  private holdingRun = false;
  /** The accepted shift, held until the channel has had its say. */
  private pending: DeskResult | null = null;

  private resolve: ((r: DeskResult) => void) | null = null;
  private readonly onKey = (e: KeyboardEvent): void => this.handleKey(e);
  private readonly onResize = (): void => this.layout();

  constructor(
    private readonly mount: HTMLElement,
    private readonly library: Library,
    private readonly audio: Audio,
    private readonly story?: StoryStore,
  ) {}

  async present(defaults?: Partial<DeskResult>): Promise<DeskResult> {
    await this.app.init({
      background: 0x000000,
      resizeTo: window,
      // Crisp on purpose. Every edge in this dialect is axis-aligned and one
      // pixel wide, and antialiasing turns a 1px hairline into two grey ones.
      antialias: false,
      resolution: Math.min(2, window.devicePixelRatio || 1),
      autoDensity: true,
      preference: 'webgl',
    });
    const canvas = this.app.canvas;
    canvas.style.position = 'absolute';
    canvas.style.inset = '0';
    this.mount.appendChild(canvas);

    this.desk = new Desk(
      this.library,
      this.audio,
      this.story,
      defaults?.seed ?? randomSeed(),
    );
    this.desk.onGlassChange = () => this.applyGlass();
    this.desk.onBegin = (r) => this.commit(r);
    this.desk.onCalibrate = () => this.openCalibration();

    this.behind.addChild(this.desk.view);
    this.behind.filters = [this.glass.filter];
    this.app.stage.addChild(this.behind, this.intrusionLayer);
    this.app.stage.filters = [this.display.filter];

    this.correctPointer();

    // One listener for the whole desk. See the header.
    this.app.stage.eventMode = 'static';
    this.app.stage.hitArea = new Rectangle(0, 0, 1 << 20, 1 << 20);
    this.app.stage.on('globalpointermove', (ev) => {
      // Into the tube's own space: the desk is inset by the bezel, so screen
      // coordinates are the bezel's, not the desk's.
      this.desk?.pointerMove(ev.global.x - this.bezel, ev.global.y - this.bezel);
    });
    this.app.stage.on('pointerup', () => this.desk?.pointerUp());
    this.app.stage.on('pointerupoutside', () => this.desk?.pointerUp());
    canvas.addEventListener('wheel', (ev) => {
      ev.preventDefault();
      this.desk?.wheel(ev.deltaY);
    });

    this.app.ticker.add((t) => {
      const dt = t.deltaMS / 1000;
      this.glass.update(dt);
      this.tear.update(dt);
    });

    window.addEventListener('keydown', this.onKey);
    window.addEventListener('resize', this.onResize);
    this.desk.mount();
    this.applyGlass();
    this.layout();

    if (import.meta.env.DEV) {
      // `__oc.desk.geometry()` is how the layout gets checked at 720p without a
      // screenshot: every window's rect, and whether it is inside the desk.
      const oc = (window as unknown as { __oc?: Record<string, unknown> }).__oc;
      if (oc) {
        oc.desk = this.desk;
        // For hit-test forensics: `__oc.app.renderer.events.rootBoundary.hitTest(x, y)`
        // is the only ground truth about what a click would land on.
        oc.app = this.app;
      }
    }

    return new Promise((resolve) => {
      this.resolve = resolve;
    });
  }

  // ------------------------------------------------------------------- story

  /**
   * BEGIN CONTAINMENT. The channel gets to speak first.
   *
   * The operator commits, and *then* something cuts in — the run is held until
   * they have read it and does not begin behind the window. An interruption at
   * the desk is a notification; an interruption at the point of commitment is
   * somebody stopping you. Ported from the terminal unchanged, because it is the
   * single most important piece of timing in the game.
   */
  private commit(r: DeskResult): void {
    this.audio.chrome('click');
    this.pending = r;
    if (this.story) {
      this.story.advance('run-start', {
        runsCompleted: this.library.snapshot.runs,
        levelsOpened: [],
      });
      if (this.story.state.queue.length > 0) {
        this.holdingRun = true;
        this.showTransmission();
        return;
      }
    }
    this.finish();
  }

  private finish(): void {
    const r = this.pending;
    if (!r) return;
    this.pending = null;
    this.teardown();
    this.resolve?.(r);
  }

  /**
   * Type the next queued beat over the desk.
   *
   * §13.5 — the shape of the page is the voice. A Bureau beat arrives as a
   * document: typeset, whole, through the proper channel. The typed window belongs
   * to the channel and to nobody else. Only a message read to the end is
   * acknowledged, so one interrupted by a reload is still queued next session.
   */
  private showTransmission(): void {
    if (!this.story || this.intrusion || this.notice.open) return;
    const beatId = this.story.state.queue[0];
    if (!beatId) return;
    const beat = BEAT_BY_ID.get(beatId);
    if (!beat) return;

    if (beat.voice === 'bureau') {
      this.noticeId = beatId;
      this.notice.show({ beat, hint: 'ANY KEY — ACKNOWLEDGE AND PROCEED' }, () =>
        this.closeNotice(),
      );
      this.audio.chrome('confirm');
      return;
    }

    this.intrusionId = beatId;
    this.intrusion = new Transmission(
      beat.body.filter((block): block is string => typeof block === 'string'),
      (isBanner) => this.audio.chrome(isBanner ? 'wire' : 'type'),
    );
    this.audio.dialup();
    this.audio.interfere(true);
    this.intrusion.view.eventMode = 'static';
    this.intrusion.view.hitArea = new Rectangle(-4000, -4000, 8000, 8000);
    this.intrusion.view.on('pointertap', () => this.closeTransmission());
    this.intrusionLayer.addChild(this.intrusion.view);
    this.layoutTransmission();
    // The site comes apart while the window is open and settles when it closes.
    this.behind.filters = [this.tear.filter];
  }

  private layoutTransmission(): void {
    if (!this.intrusion) return;
    this.intrusion.view.position.set(
      Math.round((this.app.screen.width - this.intrusion.width) / 2),
      Math.round(this.app.screen.height * 0.42 - this.intrusion.height / 2),
    );
  }

  /** The notice surface, mounted the first time the Bureau has one to serve. */
  private get notice(): DocumentSheet {
    if (!this.noticeSheet) this.noticeSheet = new DocumentSheet(this.intrusionLayer);
    return this.noticeSheet;
  }

  /** Acknowledge the notice. Documents arrive whole; one key files it. */
  private closeNotice(): void {
    if (!this.notice.open) return;
    if (this.story && this.noticeId) this.story.delivered(this.noticeId);
    this.notice.close();
    this.noticeId = null;
    this.audio.chrome('click');
    if (!this.holdingRun) return;
    this.holdingRun = false;
    this.finish();
  }

  /** Dismiss the intrusion. Acknowledged only if it finished typing. */
  private closeTransmission(): void {
    if (!this.intrusion) return;
    if (!this.intrusion.done) {
      this.intrusion.finish();
      return;
    }
    if (this.story && this.intrusionId) this.story.delivered(this.intrusionId);
    this.intrusion.destroy();
    this.intrusion = null;
    this.intrusionId = null;
    this.behind.filters = [this.glass.filter];
    this.audio.interfere(false);
    // One per run, and then the run — never the next queued message, because
    // several rules can come true in one pass and the player would be handed both
    // back to back where their episode should have been.
    if (!this.holdingRun) return;
    this.holdingRun = false;
    this.finish();
  }

  /**
   * §20.1 — re-run the calibration screen, over everything.
   *
   * In `intrusionLayer` so it covers the desk, and under the stage filter so it
   * is corrected by the very setting it is adjusting.
   */
  private openCalibration(): void {
    if (this.calibrationView) return;
    const view = new CalibrationView(
      (gamma) => this.library.setDisplay({ gamma }),
      (gamma) => {
        this.library.setDisplay({ gamma, calibrated: true });
        view.destroy();
        this.calibrationView = null;
        // `calibrated` comes from the Library, so the sheet is stale until rebuilt.
        this.desk?.refreshSettings();
        this.audio.chrome('confirm');
      },
    );
    this.calibrationView = view;
    this.intrusionLayer.addChild(view.view);
    view.layout(this.app.screen.width, this.app.screen.height);
  }

  /**
   * Re-read the player's glass settings onto the tube.
   *
   * The desk's own CRT values are the authored look; these two are the player's,
   * and they layer on top of it.
   */
  private applyGlass(): void {
    const s = this.library.snapshot.settings;
    if (this.crtOff) {
      this.glass.set({ scan: 0, mono: 0, vignette: 0, grille: 0, breathe: 0 });
      return;
    }
    // The desk's own authored look, with the player's tube over the top.
    this.glass.set(chromeGlass(s, { vignette: 0.3, grille: 0.09, breathe: 0.012 }));
    this.tear.set(tearGlass(s));
  }

  /** A run finished and we came back. The night moved on. */
  refresh(): void {
    this.desk?.refresh();
  }

  private handleKey(e: KeyboardEvent): void {
    // Whatever is over the desk owns the keyboard. A held run must not be
    // dismissable by arrowing around the window behind the message.
    if (this.calibrationView) {
      this.calibrationView.keys(e);
      e.preventDefault();
      return;
    }
    if (this.intrusion) {
      this.closeTransmission();
      e.preventDefault();
      return;
    }
    if (this.notice.open) {
      this.closeNotice();
      e.preventDefault();
      return;
    }
    if (this.desk?.key(e)) {
      e.preventDefault();
      this.audio.chrome('hover');
    }
  }

  /**
   * The gap between the tube and the edge of the viewport.
   *
   * The curvature bows the picture outward, so without a margin the bend runs
   * off the top and bottom of the screen while the sides still have room — which
   * reads as a rendering fault rather than as a screen. An even gap all round is
   * what makes it a monitor sitting in a bezel.
   *
   * Scaled, with a floor: at 1280x720 it is 23px, and it never grows past 30.
   */
  /**
   * Bend the pointer the same way the glass bends the picture.
   *
   * **The curvature is a lie told to the eye, and input believed it.** The shader
   * displaces every pixel toward the centre of the tube; Pixi hit-tests the
   * untouched scene graph. So what the player saw and what the player clicked
   * were two different places, by nothing at the centre and by tens of pixels at
   * the edges — measured: the close box appeared 31 pixels below where it
   * actually was, inside a box 24 pixels tall, so it could not be hit at all.
   * That is why it never even showed a pointer cursor. Every other complaint —
   * clicking FILES opening SHIFT, the drag handle sitting above the titlebar,
   * rows in the explorer opening their neighbours, half of all clicks doing
   * nothing — is the same offset at a different radius.
   *
   * The fix belongs here rather than in each handler. `mapPositionToPoint` is the
   * single place Pixi turns a DOM position into a scene position, so correcting
   * it once fixes windows, close boxes, icons, list rows and buttons together and
   * cannot fall out of step with the shader: both read the same `curve`.
   *
   * The transform is the shader's own, forward: content displayed at `p` truly
   * lives at `centre + (p - centre) * k`, where `k` grows with the square of the
   * distance from the centre.
   */
  private correctPointer(): void {
    if (this.curve <= 0) return;
    const events = this.app.renderer.events;
    const base = events.mapPositionToPoint.bind(events);
    events.mapPositionToPoint = (point, x, y): void => {
      base(point, x, y);
      // Normalised against the **whole screen**, because that is what the shader
      // is normalised against — see `filterArea` in `layout`. The first version of
      // this used the tube rect instead, which is the same transform at the wrong
      // scale: it corrected most of the error and left a fifth of it, which is
      // worse than not correcting at all because it looks like it works.
      const sw = this.app.screen.width;
      const sh = this.app.screen.height;
      if (sw <= 0 || sh <= 0) return;
      let cx = (point.x / sw) * 2 - 1;
      let cy = (point.y / sh) * 2 - 1;
      const k = 1 + this.curve * (cx * cx + cy * cy) * 0.5;
      cx *= k;
      cy *= k;
      point.x = (cx * 0.5 + 0.5) * sw;
      point.y = (cy * 0.5 + 0.5) * sh;
    };
  }

  private get bezel(): number {
    return Math.round(Math.min(30, Math.max(14, this.app.screen.width * 0.018)));
  }

  private layout(): void {
    const m = this.bezel;
    const sw = this.app.screen.width;
    const sh = this.app.screen.height;
    this.behind.position.set(m, m);
    // Pinned to the screen, not left to the container's bounds.
    //
    // Pixi derives a filter's area from what it is filtering, so the shader's
    // 0..1 spanned the desk's bounding box — which changes as windows move. The
    // curvature therefore bent around a moving centre, and the pointer correction
    // had no fixed frame to undo it in. One explicit rect makes the tube's
    // geometry a property of the screen, which is what a tube is.
    this.behind.filterArea = new Rectangle(0, 0, sw, sh);
    this.desk?.layout(sw - m * 2, sh - m * 2);
    this.layoutTransmission();
    this.calibrationView?.layout(sw, sh);
  }

  private teardown(): void {
    window.removeEventListener('keydown', this.onKey);
    window.removeEventListener('resize', this.onResize);
    this.desk?.destroy();
    this.desk = null;
    // The run wants a renderer of its own, and two live WebGL contexts on one
    // page buys nothing.
    this.app.destroy(true, { children: true });
  }
}
