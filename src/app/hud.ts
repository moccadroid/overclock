/**
 * The HUD's *state*, now that the HUD itself is drawn in the bezel.
 *
 * This was 337 lines: six absolutely-positioned HTML divs, an xp bar, an engine
 * strip and a frame-cost line, each building its own markup with its own colour
 * classes in a stylesheet a long way from `tokens.ts`. All of that moved — the
 * content to `readouts.ts`, the drawing to `bezel.ts` — for three reasons, in
 * order of how much they mattered:
 *
 *   **It could not take the player's phosphor.** A monochrome tube is a global
 *   setting; DOM text over a WebGL canvas is not on the tube at all, so an
 *   operator on amber had an amber game with a blue-grey HUD stapled to it.
 *
 *   **It read as text lying on the game** rather than as a machine the game is
 *   inside, which is the whole point of the bezel.
 *
 *   **It kept a second palette.** Two sources of truth for what "warning" looks
 *   like, and the CSS one was never updated when `C` changed.
 *
 * What is left is the part that genuinely is state and not rendering: a smoothed
 * frame cost, and a notice with an expiry. Both are asked for once per UI tick.
 */

/** How long a flashed line stays up. */
const NOTICE_SECONDS = 2.4;

export class Hud {
  /** Smoothed, because a per-frame number is unreadable and always looks worse. */
  private fpsAverage = 60;
  private gpuMs = 0;
  /** CPU cost of the frame callback, smoothed like the fps. See Game.busyMs. */
  private cpuMs = 0;
  private notice = '';
  private noticeUntil = 0;

  /** A transient line for things that have no permanent home — mute, mostly. */
  flash(message: string): void {
    this.notice = message;
    this.noticeUntil = performance.now() / 1000 + NOTICE_SECONDS;
  }

  /** The flashed line, or empty once it has expired. */
  get message(): string {
    return performance.now() / 1000 < this.noticeUntil ? this.notice : '';
  }

  sample(frameDt: number, gpuMs = 0, cpuBusyMs = 0): void {
    if (frameDt > 0) this.fpsAverage += (1 / frameDt - this.fpsAverage) * 0.08;
    if (gpuMs > 0) this.gpuMs += (gpuMs - this.gpuMs) * 0.1;
    if (cpuBusyMs > 0) this.cpuMs += (cpuBusyMs - this.cpuMs) * 0.1;
  }

  /**
   * What the frame cost, and how far the machine sits above the budget.
   *
   * Frame rate alone hides a GPU working far too hard for what is on screen —
   * exactly the failure that made this readout necessary — and with rendering
   * capped at 60 the rate can only ever confirm the cap. Headroom is the real
   * number. The bound is whichever side is slower, because cpu and gpu run
   * concurrently, and where the timer extension is missing the estimate says so
   * rather than silently reporting half the picture.
   */
  get frameLine(): string {
    let line = `${Math.round(this.fpsAverage)} fps`;
    if (this.cpuMs > 0) line += ` · ${this.cpuMs.toFixed(1)}ms cpu`;
    if (this.gpuMs > 0) line += ` · ${this.gpuMs.toFixed(1)}ms gpu`;
    const bound = Math.max(this.cpuMs, this.gpuMs);
    if (bound > 0) {
      const head = 1000 / 60 / bound;
      line += ` · ~${head >= 10 ? Math.round(head) : head.toFixed(1)}× headroom`;
      if (this.gpuMs <= 0) line += ' (cpu only)';
    }
    return line;
  }
}
