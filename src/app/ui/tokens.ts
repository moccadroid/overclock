/**
 * The document UI — tokens. GDD §16.2, §16.3.
 *
 * **Everything in this module aligns because it is monospace on a column grid.**
 *
 * That is the load-bearing rule and it is worth stating before anything else,
 * the way `structure.ts` states its own. Positions are given in *columns and
 * rows*, never in pixels, and are resolved against one measured character
 * advance. The first proportional font or off-grid element added to a sheet
 * does not degrade gracefully — every leader, every meter and every censor's
 * bar on that sheet stops lining up at once.
 *
 * Scope: this serves **documents** — the menu, and later anything that reads
 * like a filed sheet. It is deliberately not the HUD. The HUD is peripheral and
 * built to be ignored; a document is a thing you stop and read, and the two want
 * opposite treatments.
 */
import { Text, TextStyle } from 'pixi.js';

export const FONT = 'ui-monospace, "Cascadia Mono", Consolas, monospace';

/** Body size, and the baseline-to-baseline step. */
export const SIZE = 13;
export const LINE = 23;

/**
 * §16.2's brightness hierarchy, plus the paper the department prints on.
 *
 * Nothing here is chosen to look nice. `INK` is body copy, `FAINT` is the
 * furniture that must be legible but never read first, and `PAPER` is the one
 * light value — used for the frame, and for the inverted states where something
 * has been stamped rather than merely written.
 */
export const C = {
  void: 0x000000,
  ink: 0x8fa5c0,
  bright: 0xd7e3f2,
  dim: 0x46586e,
  faint: 0x2a3a52,
  rule: 0x18202c,
  paper: 0x6d7d92,
  /** The censor's bar, and the fill of an inverted control. */
  bar: 0xdfe7f0,
  /** What sits on `bar` when a control inverts. */
  barInk: 0x07090d,

  /** §16.3 — the three fuel hues. These mean elements and nothing else. */
  thermal: 0xffb000,
  voltaic: 0x00e5ff,
  voidHue: 0xb44cff,
  /** Reserved for harm. */
  signal: 0xff2a3c,

  /** ui.css:739 — kind colours, chosen to sit *outside* the fuel hues. */
  trigger: 0x5fe3a1,
  modifier: 0x93a7bd,
  action: 0xffe9a8,
} as const;

/**
 * Redaction sentinels.
 *
 * A segment whose colour is negative is a **censored** segment, and the value
 * encodes the clearance needed to read it: `REDACT - level`. The segment still
 * carries its real text, which is the whole point —
 *
 *   NARRATIVE §13.3  every bar has real words under it, authored first
 *   NARRATIVE §13.4  bar widths are honest; people will measure
 *   NARRATIVE §5.4   bars are permissions, and clearance lifts them
 *   NARRATIVE §11.5  during the deconstruction bars slide off and the words
 *                    underneath are legible for a frame or two
 *
 * All four need the bar to know what it hides. Storing a width instead of the
 * text satisfies none of them and cannot be retrofitted without rewriting every
 * document in the game.
 */
export const REDACT = -1;
/** Clearance that never arrives. ORIGIN is always black. */
export const NEVER = 99;

/** True if this colour marks a censored segment, and what it costs to read. */
export const isRedaction = (colour: number): boolean => colour < 0;
export const redactionLevel = (colour: number): number => -colour - 1;

/** A run of text and the colour it is set in. The atom of every sheet. */
export type Seg = [string, number];
/** One line: segments laid end to end, columns implied by what came before. */
export type Line = Seg[];

const styles = new Map<string, TextStyle>();

/**
 * Styles are cached by their arguments.
 *
 * A sheet rebuild touches every segment on it, and a fresh `TextStyle` per
 * segment is both an allocation and a fresh text-metrics measurement — the
 * expensive half. There are only ever a dozen distinct styles on screen.
 */
export function style(size: number, colour: number, tracking = 0): TextStyle {
  const key = `${size}:${colour}:${tracking}`;
  let s = styles.get(key);
  if (!s) {
    s = new TextStyle({ fontFamily: FONT, fontSize: size, fill: colour, letterSpacing: tracking });
    styles.set(key, s);
  }
  return s;
}

let advance = 0;

/**
 * The width of one character at `SIZE`, measured once from the live font.
 *
 * Measured rather than assumed because the family is a stack — whichever of
 * `ui-monospace`, Cascadia or Consolas the machine actually has decides the
 * advance, and being wrong by a fraction of a pixel compounds across sixty
 * columns into a visibly crooked leader.
 */
export function charW(): number {
  if (!advance) {
    const probe = new Text({ text: 'M'.repeat(40), style: style(SIZE, C.ink) });
    advance = probe.width / 40;
    probe.destroy();
  }
  return advance;
}
