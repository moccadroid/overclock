/**
 * The operations order — `OC-1147-A`. The commitment point, as paperwork.
 *
 * This replaces the old run sheet, and the reason is a cut: STORY-AND-TONE §7.3
 * makes the campaign Ignition-only, so the Axiom list at the centre of the old
 * sheet is a choice the player no longer has. What was left was a form built
 * around a missing control.
 *
 * So it becomes a **dashboard, not a briefing**. The first version of this
 * replacement went the other way — three paragraphs of assignment prose, the
 * standing denial, an acknowledgement clause — and it was worse than what it
 * replaced: nobody wants to read a page before pressing the button they press six
 * times. Every instruction on it already lives in `OC-0001`, where a procedure
 * belongs and where the operator can go and look it up.
 *
 * What is left is what only this screen can say: the shift's number, when
 * extraction opens, and what the site has written down about the person reading
 * it. The button is the only control.
 *
 * ---
 *
 * **Everything on this form is derived. Nothing on it is written.**
 *
 * §13.1 — the Bureau never lies, and this sheet is the easiest place in the game
 * to break that, because a plausible-looking number is exactly what a form wants.
 *
 * §6 — and it is the easiest place to write like a language model. "Recorded
 * against the operator" was the heading here and it is banned outright: no
 * institution and no person has ever said it. Things are *logged*, *entered on a
 * form*, or *filed*. A file of somebody's work is a service record.
 * The extraction clock on the old sheet was quoted rather than derived and said
 * 15:00 for a build after the re-cut moved it to 9:30. So every figure here comes
 * out of the Library or the story state, and where there is no figure the line
 * says so rather than inventing one.
 *
 * The register: long clauses, cross-references, and the flattest possible
 * delivery of the worst possible facts. The form is not trying to frighten
 * anybody. It is a form.
 */
import { TUNABLE } from '../../sim/tunables';
import type { Library } from '../../meta/profile';
import type { Story } from '../../story/state';
import { DOCUMENT_IDS, rungOf } from '../../story/arc';
import { C, type Line } from '../ui';
import { blank, field, head } from '../ui/emit';

export const ORDER_SHEET = {
  head: 'OPERATIONS ORDER',
  ref: 'OC-1147-A',
};

/**
 * The one word on the button.
 *
 * Not "RUN". The operator does not run anything — they are posted to a shift
 * during which an article is contained, and the paperwork's own word for that
 * job is the only honest label. It is also the first time the game says the
 * quiet part in the Bureau's own voice, on a button the player presses six
 * times.
 */
export const BEGIN_LABEL = 'BEGIN CONTAINMENT';

const pad = (s: string, n: number): string => (s.length >= n ? s : s + ' '.repeat(n - s.length));

/** m:ss, the way the shift log writes a duration. */
function duration(seconds: number): string {
  if (seconds <= 0) return '—';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/** Thousands separators, because a form would. */
function figure(n: number): string {
  if (n <= 0) return '—';
  return Math.round(n).toLocaleString('en-GB');
}

/**
 * The order, top to bottom.
 *
 * `rows` is what the window can hold; the body is written to fit it rather than
 * being written long and clipped, because a form that runs off the bottom of its
 * own window is the thing this redesign exists to stop.
 */
export function orderLines(library: Library, story: Story | undefined, seed: string): Line[] {
  const s = library.snapshot;
  const shift = s.runs + 1147;
  const rung = story ? rungOf(story) : 1;

  // Material accumulated, out of the whole ladder. This is the line that does the
  // work: the Bureau is not accusing anybody of anything, it is *counting*, and
  // the count is of documents the operator has taken off its floors.
  const held = story ? DOCUMENT_IDS.filter((id) => (story.held[id]?.length ?? 0) > 0).length : 0;
  const total = DOCUMENT_IDS.length;

  const opens = TUNABLE.extractFromTime;
  const clock = `${Math.floor(opens / 60)}:${String(Math.floor(opens % 60)).padStart(2, '0')}`;

  const out: Line[] = [
    field('SHIFT', String(shift), { col: 22, colour: C.bright }),
    field('OPERATOR', '████████', { col: 22 }),
    field('EXTRACTION OPENS', clock, { col: 22 }),
    blank(),
    head('SERVICE RECORD'),
    field('shifts worked', figure(s.runs), { col: 22, indent: 2 }),
    field('best output', figure(s.bestScore), { col: 22, indent: 2 }),
    field('deepest chain', s.bestDepth > 0 ? String(s.bestDepth) : '—', { col: 22, indent: 2 }),
    field('longest shift', duration(s.bestTime), { col: 22, indent: 2 }),
    blank(),
    head('ARTICLE OC-001'),
    field('status', 'CONTAINED', { col: 22, indent: 2 }),
    field('review stage', `${rung} of 6`, { col: 22, indent: 2 }),
    // The two lines that should land, delivered as inventory. The first is the
    // operator's own accumulation being tallied against them; the second is
    // OC-001Δ's finding, stated as an operational fact and left there.
    field('material taken', `${held} of ${total}`, {
      col: 22,
      indent: 2,
      colour: held > 0 ? C.bright : C.dim,
    }),
    field(
      'structure gained',
      rung > 1 ? `at ${rung - 1} of ${rung} reviews` : 'not observed',
      { col: 22, indent: 2, colour: rung > 3 ? C.thermal : C.dim },
    ),
    blank(),
    field('SEED', seed, { col: 22 }),
  ];

  return out;
}

/** How many rows the order needs. The window is sized from this, not guessed. */
export function orderRows(library: Library, story: Story | undefined, seed: string): number {
  // Three spare: two for the button and one of air under it.
  return orderLines(library, story, seed).length + 3;
}

/** Widest line, so the window is never narrower than its own copy. */
export function orderCols(library: Library, story: Story | undefined, seed: string): number {
  let widest = 0;
  for (const line of orderLines(library, story, seed)) {
    widest = Math.max(
      widest,
      line.reduce((n, seg) => n + seg[0].length, 0),
    );
  }
  return widest;
}

export { pad };
