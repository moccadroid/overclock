/**
 * A beat, laid out for a pane.
 *
 * Wrapping and nothing else. There is no text format to decode here, because
 * there is no text format: a paragraph is a string, and a paragraph containing a
 * censored run is an array with a `bar()` in it. The type says what the sentence
 * is made of, so nothing has to work it out at runtime.
 *
 * The bar's width is never written down — it is measured from the words behind
 * it, which is what makes §13.4 ("bar widths are honest; people will measure")
 * true by construction, and re-derives it for free in another language.
 */
import { C, REDACT, type Line, type Seg } from '../app/ui';
import type { Block, Para, Span } from './script';

const spans = (p: Para): readonly Span[] => (typeof p === 'string' ? [p] : p);

/**
 * Wrap spans to `width` columns, keeping each run's censoring across the break.
 *
 * Word by word rather than string-then-fix-up, so a censored phrase that
 * straddles a line break becomes two bars instead of one bar and a leak.
 */
function wrap(para: Para, width: number, ink: number): Line[] {
  const lines: Line[] = [];
  let line: Seg[] = [];
  let used = 0;

  const push = (): void => {
    if (line.length) lines.push(line);
    line = [];
    used = 0;
  };

  for (const span of spans(para)) {
    const hidden = typeof span === 'string' ? null : span.clearance;
    const text = typeof span === 'string' ? span : span.hidden;
    const colour = hidden === null ? ink : REDACT - hidden;

    for (const word of text.split(' ')) {
      if (!word) continue;
      const space = used > 0;
      if (used > 0 && used + 1 + word.length > width) push();
      const piece = used > 0 && space ? ` ${word}` : word;
      const last = line[line.length - 1];
      // Merge runs set the same way, so a sentence is one Text object and not
      // one per word — the grid pools these and a rebuild touches every segment.
      if (last && last[1] === colour) last[0] += piece;
      else line.push([piece, colour]);
      used += piece.length;
    }
  }

  push();
  return lines;
}

/** One block. `pre` is typed as a shape and is laid out exactly as written. */
export function blockLines(block: Block, width: number, ink: number = C.ink): Line[] {
  if (typeof block === 'object' && !Array.isArray(block) && 'pre' in block) {
    return block.pre.map((row) => wrap(row, Number.MAX_SAFE_INTEGER, ink)[0] ?? []);
  }
  return wrap(block as Para, width, ink);
}

/** A whole beat body, blocks separated by a blank line. */
export function beatLines(body: readonly Block[], width: number, ink: number = C.ink): Line[] {
  const out: Line[] = [];
  for (const block of body) {
    if (out.length) out.push([]);
    out.push(...blockLines(block, width, ink));
  }
  return out;
}

/** The words under every bar in a beat, for the §11.5 slide-off and for tests. */
export function hiddenWords(body: readonly Block[]): string[] {
  const out: string[] = [];
  for (const block of body) {
    const paras =
      typeof block === 'object' && !Array.isArray(block) && 'pre' in block
        ? block.pre
        : [block as Para];
    for (const p of paras) {
      for (const s of spans(p)) if (typeof s !== 'string') out.push(s.hidden);
    }
  }
  return out;
}
