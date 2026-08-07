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
  /**
   * Whether the next word is preceded by a space *in the source*.
   *
   * Load-bearing across the seam between spans. Every word used to be joined
   * with a space whenever the line was non-empty, which is right inside a span
   * and wrong at its edges: a sentence written as `'…item as '`, `bar('company')`,
   * `'. It is…'` rendered as "item as ███ . It is" — the full stop, which
   * continues the censored word, arrived as its own word and got a space in
   * front of it. Every bar followed by punctuation in every file had it.
   */
  let spaced = false;

  const push = (): void => {
    if (line.length) lines.push(line);
    line = [];
    used = 0;
  };

  for (const span of spans(para)) {
    const hidden = typeof span === 'string' ? null : span.clearance;
    const text = typeof span === 'string' ? span : span.hidden;
    const colour = hidden === null ? ink : REDACT - hidden;
    if (/^\s/.test(text)) spaced = true;

    for (const word of text.split(' ')) {
      if (!word) continue;
      const space = used > 0 && spaced;
      if (used > 0 && used + (space ? 1 : 0) + word.length > width) push();
      const piece = used > 0 && space ? ` ${word}` : word;
      const last = line[line.length - 1];
      // Merge runs set the same way, so a sentence is one Text object and not
      // one per word — the grid pools these and a rebuild touches every segment.
      if (last && last[1] === colour) last[0] += piece;
      else line.push([piece, colour]);
      used += piece.length;
      // Words within a span are space-separated; the next one always is.
      spaced = true;
    }

    // …and a span that does not end in whitespace runs straight into the next.
    spaced = /\s$/.test(text);
  }

  push();
  return lines;
}

/**
 * One block. `pre` is typed as a shape and is laid out exactly as written.
 *
 * "Exactly as written" means the runs of spaces that make the shape a shape.
 * `wrap` normalises whitespace — correctly, for prose — so routing a `pre` row
 * through it collapsed every column gap to one space and a register turned into
 * a sentence. A `pre` row is one segment, verbatim; only a censored one has to
 * be walked, and its spacing is preserved span by span.
 */
export function blockLines(block: Block, width: number, ink: number = C.ink): Line[] {
  if (typeof block === 'object' && !Array.isArray(block) && 'pre' in block) {
    return block.pre.map((row): Line => {
      if (typeof row === 'string') return row ? [[row, ink]] : [];
      return row.map((span) =>
        typeof span === 'string'
          ? ([span, ink] as Seg)
          : ([span.hidden, REDACT - span.clearance] as Seg),
      );
    });
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
