/**
 * The document UI. GDD §16.2, §16.3.
 *
 * A small set of components for anything that reads like a **filed document** —
 * the menu today, and whatever else stops the player to be read later. It is
 * deliberately not the HUD: the HUD is peripheral and built to be ignored, and
 * the two want opposite treatments.
 *
 *   tokens        palette, metrics, the `Seg`/`Line` atom, redaction sentinels
 *   grid          lines of coloured segments, laid out by column
 *   emit          field / meter / chain / redact — text, never pixels
 *   terminal      the constant surface: header, three words, footer keys
 *   sheet         a Bureau document: frame, heading, reference, rule, stamp
 *   transmission  an intrusion: no chrome at all, and it types
 *   fx            the glass — scanlines, phosphor, and interference
 *   widgets       the two controls that own pixels
 *   focus         one owner of the keyboard at a time
 *
 * **Three voices, three renderers, firewalled** (NARRATIVE §13.5). The Bureau
 * gets `Sheet`; the resistance gets `Transmission`; the Engine gets the same
 * channel the resistance used, because it is the same channel and always was.
 * They are separate components on purpose — the player learns to tell the voices
 * apart by the shape of the page long before they can tell them apart by what
 * they say.
 *
 * **The rule the whole thing rests on:** everything aligns because it is
 * monospace on a column grid. Positions are columns and rows, never pixels. Add
 * one proportional font or one off-grid element to a sheet and every leader,
 * meter and censor's bar on it stops lining up at once — there is no graceful
 * degradation here, which is why it is stated in three files rather than one.
 */
export {
  C,
  FONT,
  LINE,
  NEVER,
  REDACT,
  SIZE,
  charW,
  isRedaction,
  redactionLevel,
  style,
  type Line,
  type Seg,
} from './tokens';
export { Grid } from './grid';
export { List } from './list';
export { VALUE_COL, blank, chain, field, head, meter, redact, row } from './emit';
export { Sheet, type SheetSpec } from './sheet';
export { Button, Rows, horizontal, vertical, type ButtonOpts, type RowsOpts } from './widgets';
export { Focus, type KeyHandler } from './focus';
export { Glass, PHOSPHOR, type GlassStyle } from './fx';
export { ENTRIES, Terminal, type Entry, type TerminalState } from './terminal';
export { Transmission } from './transmission';
