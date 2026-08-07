/**
 * The document UI — emitters.
 *
 * Small functions that produce `Seg[]`, never pixels. Everything a sheet is made
 * of is expressed as text on the column grid, which is what keeps a field on one
 * screen identical to the same field on another: there is one `field()`, so
 * there is one leader, one column width and one value colour, everywhere.
 *
 * The alternative — each screen drawing its own label-dots-value — is exactly
 * the drift this module exists to prevent.
 */
import { C, REDACT, type Line, type Seg } from './tokens';

/** Default column at which values line up across every sheet. */
export const VALUE_COL = 20;

/** A blank line. Named, because `[]` in a list of lines reads as a mistake. */
export const blank = (): Line => [];

/** A section heading. Dim, and never bright — it is a label, not a statement. */
export const head = (text: string): Line => [[text, C.dim]];

/**
 * Censor's ink over words that exist.
 *
 * Pass what is actually under the bar. The width comes from the text, so an
 * honest bar is structural rather than a discipline somebody has to remember,
 * and the same call serves clearance lifting and the ending's unthreading.
 */
export const redact = (hidden: string, level = 1): Seg => [hidden, REDACT - level];

/**
 * `label ......... value` — a leader sized so every value on the sheet starts in
 * the same column, however long the labels are.
 *
 * The dots are literal characters rather than a drawn rule, because on a column
 * grid a run of interpuncts *is* the rule and it can never fall out of step with
 * the text beside it.
 */
export function field(
  label: string,
  value: string,
  opts: { colour?: number; indent?: number; col?: number } = {},
): Line {
  const indent = opts.indent ?? 0;
  const col = opts.col ?? VALUE_COL;
  const pad = ' '.repeat(indent);
  const dots = Math.max(1, col - indent - label.length - 1);
  return [
    [`${pad}${label} ${'.'.repeat(dots)} `, C.faint],
    [value, opts.colour ?? C.ink],
  ];
}

/**
 * `||||||····` — the HUD's own meter, at the HUD's own proportions.
 *
 * Unfilled cells keep a character rather than becoming spaces, so the track is
 * legible before you reach it — §16.2's brightness hierarchy doing the work
 * instead of a change of colour.
 */
export function meter(filled: number, total = 10, colour: number = C.trigger): Seg[] {
  const n = Math.max(0, Math.min(total, Math.round(filled)));
  return [
    ['|'.repeat(n), colour],
    ['·'.repeat(total - n), C.faint],
  ];
}

/**
 * A Program row, in the editor's kind colours.
 *
 * Trigger, modifier and action separate by hue here and only here — those three
 * are chosen to sit outside the fuel hues precisely so a chain never looks like
 * it carries an element.
 */
export function chain(parts: readonly string[]): Seg[] {
  const out: Seg[] = [];
  for (let i = 0; i < parts.length; i++) {
    if (i) out.push([' › ', C.dim]);
    const colour = i === 0 ? C.trigger : i === parts.length - 1 ? C.action : C.modifier;
    out.push([parts[i]!, colour]);
  }
  return out;
}

/** Fixed-width cells, for anything that is genuinely a table. */
export function row(cells: readonly [string, number][], widths: readonly number[]): Line {
  return cells.map(([text, colour], i) => {
    const w = widths[i] ?? text.length + 1;
    return [text.length >= w ? `${text.slice(0, w - 1)} ` : text.padEnd(w), colour] as Seg;
  });
}

/**
 * Prose, wrapped to the column grid.
 *
 * Word-by-word and greedy, which is all a monospace sheet ever needs. Lives
 * here rather than beside any one consumer because a paragraph wrapped two
 * different ways on two sheets reads as two different documents.
 */
export function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    if (!word) continue;
    if (line && line.length + 1 + word.length > width) {
      out.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) out.push(line);
  return out;
}
