/**
 * The tube, as a **global** setting.
 *
 * Phosphor and scanlines were shell-only: the operator could put their terminal
 * on amber, start a shift, and the run's own documents came back in colour on a
 * flat panel. That is not a preference being ignored, it is two programs — and it
 * is the same mistake the chrome made before `CHROME` existed.
 *
 * So there is one function that turns the player's saved settings into glass, and
 * everything that owns a `Glass` calls it: the desk, and the run's chrome layer.
 *
 * ---
 *
 * **The arena is deliberately not included.**
 *
 * A monochrome tube is a real trade and `PHOSPHOR` says so: on amber there is no
 * difference between thermal and signal red, and a cascade stops being readable by
 * hue at all. §16.3 makes the three fuel hues *mean elements*, and §16.2 makes the
 * brightness hierarchy untouchable — so collapsing the arena to one phosphor would
 * not dim the game, it would delete a channel the player reads threats with.
 *
 * Chrome has no such job. A document is text on paper, an amber document is text
 * on amber paper, and nothing about it stops being legible. So the setting reaches
 * every surface the player *reads* and stops at the surface they *play*.
 */
import type { GlassStyle } from './fx';
import { PHOSPHOR } from './fx';

/** Just the fields of the Library's settings this needs. */
export interface GlassSettings {
  phosphor: string;
  scanlines: number;
}

/**
 * The style for a chrome surface — the desk, or the run's sheets.
 *
 * `extra` is the surface's own authored look (vignette, grille, breathe) which the
 * player's settings sit on top of rather than replace.
 */
export function chromeGlass(s: GlassSettings, extra: GlassStyle = {}): GlassStyle {
  const p = PHOSPHOR.find((x) => x.id === s.phosphor) ?? PHOSPHOR[0]!;
  return {
    ...extra,
    // A floor under the scanlines: at zero the surface stops reading as a screen
    // at all, and the one thing every one of these panels has in common is that it
    // is being displayed on something.
    scan: Math.max(0.06, s.scanlines),
    mono: p.mono,
    tint: p.tint,
  };
}

/**
 * The interference style, for the resistance typing over a surface.
 *
 * Same phosphor, so an intrusion is on the same tube as the thing it is
 * interrupting — the tear is the signal misbehaving, not a second monitor.
 */
export function tearGlass(s: GlassSettings): GlassStyle {
  const p = PHOSPHOR.find((x) => x.id === s.phosphor) ?? PHOSPHOR[0]!;
  return { tear: 1, split: 1.8, noise: 0.07, scan: Math.max(0.06, s.scanlines), mono: p.mono, tint: p.tint };
}
