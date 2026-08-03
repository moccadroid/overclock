/**
 * How long the GPU actually spent on the last frame.
 *
 * This exists because of a mistake worth not repeating. A performance fix was
 * measured with `performance.now()` around the render calls, reported as "65ms
 * to 5ms, twelve times faster", and shipped — while the thing it introduced sent
 * a real player's GPU into overdrive on a nearly empty screen.
 *
 * Both were true. `performance.now()` around a WebGL call measures how long it
 * took to *queue* the work, not to do it: the driver returns immediately and the
 * GPU catches up later. A giant permanently-lit ring is one circle and one light
 * to submit — nearly free on the CPU — and a screen of fill for the GPU. CPU
 * timing could not see it, and neither could I.
 *
 * `EXT_disjoint_timer_query_webgl2` measures the real thing. It is not available
 * everywhere and it is asynchronous — a query started this frame is readable a
 * frame or two later — so this keeps a small ring of queries in flight and
 * reports whatever has come back. Dev-only, and silent when the extension is
 * missing.
 */
import type { Application } from 'pixi.js';

interface TimerExt {
  TIME_ELAPSED_EXT: number;
  GPU_DISJOINT_EXT: number;
}

export class GpuTimer {
  /** Milliseconds the GPU spent on the most recently resolved frame. Zero if unknown. */
  lastMs = 0;

  private readonly gl: WebGL2RenderingContext | null;
  private readonly ext: TimerExt | null;
  private readonly pending: WebGLQuery[] = [];
  private active: WebGLQuery | null = null;

  constructor(app: Application) {
    const renderer = app.renderer as unknown as {
      gl?: WebGL2RenderingContext;
      context?: { gl?: WebGL2RenderingContext };
    };
    const gl = renderer.gl ?? renderer.context?.gl ?? null;
    this.gl = gl ?? null;
    this.ext = gl ? (gl.getExtension('EXT_disjoint_timer_query_webgl2') as TimerExt | null) : null;
  }

  get available(): boolean {
    return this.ext !== null;
  }

  /** Open a query. Everything drawn until `end()` is measured. */
  begin(): void {
    const { gl, ext } = this;
    if (!gl || !ext || this.active) return;
    // Four in flight is more than enough: results land within a frame or two,
    // and an unbounded pool would be a leak with a graph.
    if (this.pending.length > 4) return;
    const query = gl.createQuery();
    if (!query) return;
    gl.beginQuery(ext.TIME_ELAPSED_EXT, query);
    this.active = query;
  }

  end(): void {
    const { gl, ext } = this;
    if (!gl || !ext || !this.active) return;
    gl.endQuery(ext.TIME_ELAPSED_EXT);
    this.pending.push(this.active);
    this.active = null;

    // Drain whatever has resolved. A disjoint means the GPU was interrupted and
    // every outstanding result is meaningless, so they all go.
    if (gl.getParameter(ext.GPU_DISJOINT_EXT)) {
      for (const q of this.pending) gl.deleteQuery(q);
      this.pending.length = 0;
      return;
    }
    while (this.pending.length > 0) {
      const q = this.pending[0]!;
      if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
      const ns = gl.getQueryParameter(q, gl.QUERY_RESULT) as number;
      // Smoothed, because a single frame's GPU time is as spiky as a single
      // frame's anything and this is meant to be read while playing.
      this.lastMs += (ns / 1e6 - this.lastMs) * 0.15;
      gl.deleteQuery(q);
      this.pending.shift();
    }
  }
}
