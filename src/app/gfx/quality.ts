/**
 * Graphics quality: the setting, the live state, and the governor.
 *
 * §20.1 gives the player toggles for what the picture *looks like*; this file
 * is about what the picture *costs*. The two are deliberately separate — the
 * view effects are taste, these are throughput, and a preset that swept both
 * would undo somebody's aesthetic on its way to saving their frame rate.
 *
 * Two modes:
 *
 *   **auto** — the governor watches the frame's measured cost (the same
 *   cpu-busy and gpu numbers the HUD and telemetry read) and walks a quality
 *   ladder to hold 60fps. It starts at the top, steps down when the frame runs
 *   out of headroom, and climbs back only after the headroom has stayed wide
 *   for a while. This is the shipped default: a machine nobody configured
 *   should still play at full rate.
 *
 *   **custom** — the knobs mean exactly what they say and never move on their
 *   own, including into territory the machine cannot afford. Slow but pretty
 *   is a legitimate choice; it just has to be a *choice*.
 *
 * MSAA and the canvas scale sit beside the ladder rather than on it. MSAA is a
 * context attribute — decided when the canvas is created, so it applies from
 * the next run. It also defaults OFF: the world is composed from render
 * textures, so multisampling was resolving a retina framebuffer to antialias
 * a dozen quad edges and some HUD strokes. The scale knob is the canvas
 * resolution on a high-dpi display; the run's own picture is composed at CSS
 * resolution either way (see gfx/bloom.ts), so 2x is mostly text sharpness on
 * the sheets.
 */

import { GRAPHICS_DEFAULTS, type GraphicsSettings } from '../../meta/profile';

export type { GraphicsSettings };

/**
 * The live effective quality, read by the renderer every frame. In custom
 * mode it mirrors the settings; in auto mode the governor owns it.
 */
export const GFX = {
  bloomMips: GRAPHICS_DEFAULTS.bloomMips,
  lightBudget: GRAPHICS_DEFAULTS.lightBudget,
  /** Which rung of the auto ladder is in force. 0 in custom mode. */
  tier: 0,
};

/** Custom mode: the settings are the state. */
export function applyGraphics(s: GraphicsSettings): void {
  GFX.bloomMips = s.bloomMips;
  GFX.lightBudget = s.lightBudget;
  GFX.tier = 0;
}

/**
 * The auto ladder, best first. Each rung gives up the least visible thing
 * still standing: the wide bloom mips go before the light budget, and the
 * budget halves before it halves again. The floor still has the tight glow
 * and a hundred lights — the §16 look degrades, it never disappears.
 */
const TIERS: readonly { bloomMips: number; lightBudget: number }[] = [
  { bloomMips: 5, lightBudget: 512 },
  { bloomMips: 3, lightBudget: 512 },
  { bloomMips: 3, lightBudget: 256 },
  { bloomMips: 2, lightBudget: 128 },
];

/**
 * Walks the ladder from measured frame cost.
 *
 * The pressure number is the binding constraint: cpu busy time or gpu time,
 * whichever is worse. Where the GPU timer extension is missing (Safari) a
 * GPU-bound frame shows up as neither — busy stays low while the achieved
 * interval stretches — so the interval stands in whenever it disagrees with
 * both. Steps down are eager (1.5s of sustained pressure), steps up are
 * reluctant (10s of sustained headroom), and an up-step that immediately gets
 * reversed doubles the patience before the next try — a ladder that oscillates
 * is worse than one that sits a rung low.
 */
export class QualityGovernor {
  private ema = 0;
  private clock = 0;
  private slowFor = 0;
  private fastFor = 0;
  private cooldown = 0;
  private upNeed = 10;
  private lastUpAt = -Infinity;

  reset(): void {
    this.ema = 0;
    this.clock = 0;
    this.slowFor = 0;
    this.fastFor = 0;
    this.cooldown = 0;
    this.upNeed = 10;
    this.lastUpAt = -Infinity;
    GFX.tier = 0;
    this.apply();
  }

  /** Feed one displayed frame. Returns true when the tier changed. */
  frame(elapsedMs: number, busyMs: number, gpuMs: number): boolean {
    let cost = Math.max(busyMs, gpuMs);
    if (cost < 12 && elapsedMs > 19) cost = elapsedMs * 0.9;
    this.ema += (cost - this.ema) * 0.06;

    const dt = Math.min(0.25, elapsedMs / 1000);
    this.clock += dt;
    this.cooldown = Math.max(0, this.cooldown - dt);
    if (this.cooldown > 0) return false;

    if (this.ema > 14.5) this.slowFor += dt;
    else this.slowFor = 0;
    if (this.ema < 8.5) this.fastFor += dt;
    else this.fastFor = 0;

    if (this.slowFor > 1.5 && GFX.tier < TIERS.length - 1) {
      if (this.clock - this.lastUpAt < 12) this.upNeed = Math.min(120, this.upNeed * 2);
      GFX.tier++;
      this.apply();
      this.slowFor = 0;
      this.cooldown = 3;
      return true;
    }
    if (this.fastFor > this.upNeed && GFX.tier > 0) {
      GFX.tier--;
      this.apply();
      this.lastUpAt = this.clock;
      this.fastFor = 0;
      this.cooldown = 5;
      return true;
    }
    return false;
  }

  private apply(): void {
    const t = TIERS[GFX.tier]!;
    GFX.bloomMips = t.bloomMips;
    GFX.lightBudget = t.lightBudget;
  }
}
