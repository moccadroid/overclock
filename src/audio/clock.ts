/**
 * The grid. GDD §18.2.
 *
 * One clock, 110 BPM base, climbing with Threat toward ~140 at Meltdown. Every
 * sound in the game is scheduled against it, which is what makes chaos musical
 * rather than noisy: forty simultaneous kills land on four sixteenth boundaries
 * instead of forty arbitrary moments.
 *
 * Scheduling uses a lookahead window against `ctx.currentTime`, never
 * setTimeout for the note itself. JS timers jitter by tens of milliseconds under
 * load — which is exactly when the game is loudest — and jitter is the one thing
 * a beat cannot survive. The timer only decides *when to schedule*; the audio
 * clock decides when things sound.
 */

/** How far ahead we queue notes, and how often we top the queue up. */
const LOOKAHEAD_S = 0.12;
const TICK_MS = 25;

export interface Step {
  /** Absolute AudioContext time this step lands on. */
  time: number;
  /** Step index within the bar, 0..15. */
  index: number;
  /** Steps elapsed since the clock started — for patterns longer than a bar. */
  count: number;
}

export class Clock {
  bpm = 110;
  /** Set by the game each frame. Drives tempo and the intensity layers. */
  intensity = 0;

  private nextStepTime = 0;
  private stepCount = 0;
  private timer: number | null = null;
  private readonly listeners = new Set<(step: Step) => void>();

  constructor(private readonly ctx: AudioContext) {}

  /** Seconds per sixteenth note. */
  get stepDuration(): number {
    return 60 / this.bpm / 4;
  }

  onStep(fn: (step: Step) => void): void {
    this.listeners.add(fn);
  }

  start(): void {
    if (this.timer !== null) return;
    this.nextStepTime = this.ctx.currentTime + 0.06;
    this.timer = window.setInterval(() => this.pump(), TICK_MS);
  }

  stop(): void {
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * The next sixteenth boundary at or after `when`. This is the whole §18.2
   * trick: an engine event asks for its note here, gets pushed forward onto the
   * grid, and forty simultaneous kills become four chords instead of forty
   * arbitrary moments.
   *
   * The delay is up to one sixteenth — 134ms at 112 BPM, not the "~34ms" this
   * comment used to claim. That is a lot for a sound, and it works anyway
   * because a *sound* arriving late still reads as part of the music, while the
   * hit it describes already happened on screen and sold the impact. The picture
   * gets no such forgiveness, which is why the renderer's equivalent is a 45ms
   * snap window rather than this.
   */
  quantize(when: number): number {
    const step = this.stepDuration;
    const base = this.nextStepTime - step * Math.ceil((this.nextStepTime - when) / step);
    return base < when ? base + step : base;
  }

  private pump(): void {
    const horizon = this.ctx.currentTime + LOOKAHEAD_S;
    while (this.nextStepTime < horizon) {
      const step: Step = {
        time: this.nextStepTime,
        index: this.stepCount % 16,
        count: this.stepCount,
      };
      for (const fn of this.listeners) fn(step);

      // Tempo is read per step rather than per bar, so a Threat spike speeds the
      // track up smoothly instead of lurching at the next downbeat.
      this.nextStepTime += this.stepDuration;
      this.stepCount++;
    }
  }
}
