/**
 * The cell library. GDD §18.
 *
 * Music in this game is **authored vocabulary, derived selection** — the same
 * shape the rest of it uses. Nobody writes "Ignition's bassline"; there is a
 * library of small authored fragments here, each tagged with what it is good
 * for, and `arrange.ts` chooses between them from the player's Engine. Every
 * cell is musical because a person wrote it; every combination is the player's
 * because their build picked it.
 *
 * The alternative — deriving the notes themselves — is how generative soundtracks
 * end up as sonification. A machine can choose well between good phrases. It
 * cannot yet write one.
 *
 * ---
 *
 * **Notation.** Patterns are strings, one character per sixteenth, at a fixed
 * 112 BPM in 4/4. One step is 134ms, one bar 2.14s, and a cell is 16 or 32
 * characters — nothing else. Strings rather than arrays because a human can read
 * them, a model can produce them reliably, and a single changed hit shows up as
 * a single changed character in a diff.
 *
 *   Percussion   `.` rest  `x` hit  `X` accent  `o` ghost  `-` open (hats)
 *   Melodic      `.` rest  `0123` chord tones, low octave
 *                          `abcd` the same tones an octave up
 *                          `~` hold the previous note through this step
 *
 * Melodic cells are **chord-relative**, never absolute. That is the rule that
 * lets any cell play over any chord in any key without going out — and it is why
 * a cascade of forty engine accents can land on top without clashing, since
 * those snap to the same chord tones.
 *
 * `3` and `d` are the seventh, which only exists on a `min7`. A cell using them
 * must declare `needsSeventh`, or it silently wraps to the root — a bug this
 * codebase has already shipped once.
 */

export type Feel = 'straight' | 'swung' | 'broken' | 'rolling';
export type Space = 'sparse' | 'mid' | 'busy';
export type Register = 'low' | 'mid' | 'high';
export type Mood = 'driving' | 'suspended' | 'dark' | 'lifting';

/**
 * The name of a chord shape, resolved against the active Score's chord table.
 *
 * A string rather than the union `'min' | 'maj' | 'sus' | 'min7'` it replaced,
 * because a Score may define shapes this file has never heard of — and adding a
 * Phrygian ♭2 is the cheapest real change to the mood there is.
 *
 * The union was doing real work, so its guarantee moves rather than disappearing:
 * `validate` rejects a cell naming a shape the Score does not define. That is
 * strictly stronger, because it also catches a shape that is spelled correctly
 * and simply missing from the table.
 */
export type ChordQuality = string;

export interface PercCell {
  id: string;
  pattern: string;
  /** 1 quietest and sparsest, 5 relentless. */
  energy: number;
  feel: Feel;
  space: Space;
}

export interface MelodicCell {
  id: string;
  steps: string;
  /** Acid only: opens the filter further and hits harder on these steps. */
  accent?: string;
  /** Acid only: glides pitch from the previous note. */
  slide?: string;
  energy: number;
  register: Register;
  space: Space;
  needsSeventh?: boolean;
}

export interface StabCell {
  id: string;
  pattern: string;
  energy: number;
  space: Space;
}

export interface HarmonyCell {
  id: string;
  chords: { root: number; quality: ChordQuality }[];
  /** Held two, four or eight bars. Two chords is a lot; techno is modal. */
  barsPerChord: number;
  mood: Mood;
}

export interface CellLibrary {
  kicks: PercCell[];
  backbeats: PercCell[];
  hats: PercCell[];
  basslines: MelodicCell[];
  motifs: MelodicCell[];
  stabs: StabCell[];
  harmonies: HarmonyCell[];
}

// ------------------------------------------------------------------ parsing

export interface PercStep {
  gain: number;
  open: boolean;
}

export interface MelodicStep {
  /** Index into the chord's tones. */
  tone: number;
  /** 0 or 1 — which octave. */
  octave: number;
  accent: boolean;
  slide: boolean;
  hold: boolean;
}

const PERC_GAIN: Record<string, number> = { x: 1, X: 1.4, o: 0.45, '-': 1 };

/** `null` at a step means silence. Parsed once at load, never per frame. */
export function parsePerc(pattern: string): (PercStep | null)[] {
  return [...pattern].map((c) =>
    c === '.' ? null : { gain: PERC_GAIN[c] ?? 1, open: c === '-' },
  );
}

const TONE_CHARS = '0123';
const HIGH_CHARS = 'abcd';

export function parseMelodic(cell: MelodicCell): (MelodicStep | null)[] {
  const accent = cell.accent ?? '';
  const slide = cell.slide ?? '';
  return [...cell.steps].map((c, i) => {
    if (c === '.') return null;
    if (c === '~') {
      return { tone: -1, octave: 0, accent: false, slide: false, hold: true };
    }
    const low = TONE_CHARS.indexOf(c);
    const high = HIGH_CHARS.indexOf(c);
    if (low < 0 && high < 0) return null;
    return {
      tone: low >= 0 ? low : high,
      octave: low >= 0 ? 0 : 1,
      accent: accent[i] === 'x' || accent[i] === 'X',
      slide: slide[i] === '~',
      hold: false,
    };
  });
}

/**
 * Validation, run once at module load rather than in a test.
 *
 * A cell library is the one thing here that will arrive from outside — written
 * by a composer, or by another model. A malformed pattern does not throw, it
 * *drifts*: a 15-step bar slips a sixteenth every bar and takes twenty minutes
 * of listening to notice. Failing loudly at boot is the only humane option.
 */
export function validate(
  library: CellLibrary,
  /**
   * The active Score's chord table. When given, every harmony's quality must
   * name a shape in it — the check that replaced `ChordQuality`'s union.
   *
   * Optional because this file is loaded before any Score exists, and the
   * pattern checks below are worth running at that point regardless.
   */
  chords?: Readonly<Record<string, readonly number[]>>,
): void {
  const lengths = (id: string, s: string) => {
    if (s.length !== 16 && s.length !== 32) {
      throw new Error(`cell "${id}": pattern is ${s.length} steps, must be 16 or 32`);
    }
  };

  for (const group of [library.kicks, library.backbeats, library.hats]) {
    for (const cell of group) {
      lengths(cell.id, cell.pattern);
      if (!/^[.xXo-]+$/.test(cell.pattern)) {
        throw new Error(`cell "${cell.id}": bad percussion characters`);
      }
    }
  }

  for (const cell of library.stabs) lengths(cell.id, cell.pattern);

  for (const group of [library.basslines, library.motifs]) {
    for (const cell of group) {
      lengths(cell.id, cell.steps);
      if (!/^[.0123abcd~]+$/.test(cell.steps)) {
        throw new Error(`cell "${cell.id}": bad melodic characters`);
      }
      // The seventh only exists on a min7, and a cell that reaches for one it
      // does not have wraps back to the root without complaining.
      const usesSeventh = /[3d]/.test(cell.steps);
      if (usesSeventh && !cell.needsSeventh) {
        throw new Error(`cell "${cell.id}": uses the seventh but does not declare needsSeventh`);
      }
      for (const extra of [cell.accent, cell.slide]) {
        if (extra && extra.length !== cell.steps.length) {
          throw new Error(`cell "${cell.id}": accent/slide length must match steps`);
        }
      }
    }
  }

  for (const cell of library.harmonies) {
    if (cell.chords.length === 0 || cell.chords.length > 2) {
      throw new Error(`harmony "${cell.id}": techno is modal — one or two chords`);
    }
    if (cell.chords[0]!.root !== 0) {
      throw new Error(`harmony "${cell.id}": must open on its tonic`);
    }
    if (cell.barsPerChord < 2) {
      throw new Error(`harmony "${cell.id}": chords must be held at least two bars`);
    }
    if (chords) {
      for (const chord of cell.chords) {
        if (!chords[chord.quality]) {
          throw new Error(
            `harmony "${cell.id}": no chord shape "${chord.quality}" — the Score defines ${Object.keys(chords).join(', ')}`,
          );
        }
      }
    }
  }
}

// ---------------------------------------------------------------- the pool
//
// The arranger reads `pool()`, not `CELLS`. They are the same object until
// somebody writes a cell of their own, at which point theirs are appended and
// the arranger simply has more to choose between.
//
// That is deliberately the *only* way a player can touch the soundtrack. §18.1
// says the Engine is the arrangement, and a screen that let you pick your own
// bassline would make that false — your run would stop sounding like your run
// and start sounding like whatever you left in a dropdown. Widening the pool
// keeps the relationship intact: you did not choose the song, you chose what the
// game is able to say. It is the same deal the Library strikes with the draft.

export const GROUPS = [
  'kicks',
  'backbeats',
  'hats',
  'basslines',
  'motifs',
  'stabs',
  'harmonies',
] as const;
export type CellGroup = (typeof GROUPS)[number];

let extra: CellLibrary | null = null;

/**
 * Register a library of player-written cells, or `null` to clear.
 *
 * Validated against the same rules as the authored ones and rejected whole if
 * any cell fails — a half-loaded library is how you end up debugging a bar that
 * drifts a sixteenth every four bars.
 */
export function setUserCells(
  library: CellLibrary | null,
  chords?: Readonly<Record<string, readonly number[]>>,
): void {
  if (library) validate(library, chords);
  extra = library;
}

export function userCells(): CellLibrary | null {
  return extra;
}

/**
 * Everything the arranger may choose from: the Score's library plus whatever the
 * player has written.
 *
 * `base` is a parameter rather than the module's own `CELLS` — that is the whole
 * of "a Score can *replace* the vocabulary rather than only add to it". Before
 * this, user cells were appended to the authored library and the authored library
 * could never be got out of the way, so a darker library would have competed with
 * the bright one in the scorer instead of superseding it.
 *
 * Player cells still append, which is correct: §18.1 says the Engine is the
 * arrangement, and widening the pool keeps that intact — you did not choose the
 * song, you chose what the game is able to say.
 */
export function pool(base: CellLibrary): CellLibrary {
  if (!extra) return base;
  return {
    kicks: [...base.kicks, ...extra.kicks],
    backbeats: [...base.backbeats, ...extra.backbeats],
    hats: [...base.hats, ...extra.hats],
    basslines: [...base.basslines, ...extra.basslines],
    motifs: [...base.motifs, ...extra.motifs],
    stabs: [...base.stabs, ...extra.stabs],
    harmonies: [...base.harmonies, ...extra.harmonies],
  };
}

export function emptyLibrary(): CellLibrary {
  return {
    kicks: [],
    backbeats: [],
    hats: [],
    basslines: [],
    motifs: [],
    stabs: [],
    harmonies: [],
  };
}

// ------------------------------------------------------------- the library
//
// Seeded from the three hand-authored tracks this replaces, so nothing that
// already sounded good was thrown away — but broken apart, so the arranger can
// use Feedback's kick under Ignition's bassline if the build asks for it.

export const CELLS: CellLibrary = {
  kicks: [
    { id: 'floor', pattern: 'x...x...x...x...', energy: 2, feel: 'straight', space: 'sparse' },
    { id: 'floor-hard', pattern: 'X...x...X...x...', energy: 3, feel: 'straight', space: 'sparse' },
    { id: 'rolling', pattern: 'x...x...x..xx...', energy: 4, feel: 'rolling', space: 'mid' },
    { id: 'rolling-ghost', pattern: 'X...x..ox..xX...', energy: 5, feel: 'rolling', space: 'busy' },
    { id: 'pushed', pattern: 'x...x...x...x..x', energy: 4, feel: 'rolling', space: 'mid' },
    { id: 'halftime', pattern: 'X.......x.......', energy: 1, feel: 'straight', space: 'sparse' },
    { id: 'swung', pattern: 'x...x..ox...x..o', energy: 3, feel: 'swung', space: 'mid' },
    { id: 'stutter', pattern: 'x..xx...x...x.x.', energy: 5, feel: 'broken', space: 'busy' },
    // Three against four: a hit every third sixteenth, which does not divide
    // sixteen and so drifts against the bar before resolving on the last beat.
    // The ear hears triplets even though nothing here is a triplet — you cannot
    // put real ones on a sixteenth grid, and this is the move that has stood in
    // for them since drum machines had sixteen buttons.
    { id: 'triplet-push', pattern: 'x..x..x...x.x...', energy: 4, feel: 'broken', space: 'mid' },
  ],

  backbeats: [
    { id: 'two-four', pattern: '....x.......x...', energy: 2, feel: 'straight', space: 'sparse' },
    { id: 'two-four-ghost', pattern: '....x.......x..o', energy: 3, feel: 'straight', space: 'mid' },
    { id: 'two-four-hard', pattern: '....X.......X...', energy: 4, feel: 'straight', space: 'sparse' },
    { id: 'clave', pattern: '..x.x......x.x..', energy: 3, feel: 'broken', space: 'mid' },
    { id: 'doubled', pattern: '....x..o....X..x', energy: 5, feel: 'rolling', space: 'busy' },
    { id: 'late', pattern: '.....x.......x..', energy: 2, feel: 'swung', space: 'sparse' },
    // Five in a row into the four. The run is ghosted so it arrives *under* the
    // bar rather than on top of it, and only the note it lands on is a real hit
    // — a roll that is as loud as its destination is a fill, not a lead-in.
    { id: 'roll-in', pattern: '....x...ooooX...', energy: 5, feel: 'rolling', space: 'busy' },
    // The same three-against-four drift as the kick, but ghosted, so it reads as
    // a shuffle underneath rather than as a second rhythm arguing with the first.
    { id: 'triplet-ghost', pattern: '....x..o..o.x...', energy: 4, feel: 'broken', space: 'mid' },
  ],

  hats: [
    { id: 'offbeat', pattern: '..x...x...x...x.', energy: 2, feel: 'straight', space: 'sparse' },
    { id: 'offbeat-open', pattern: '..x...-...x...-.', energy: 3, feel: 'straight', space: 'mid' },
    // Was a byte-for-byte copy of `offbeat`, which quietly made the pool five
    // cells wide instead of six. Eighth notes are every *second* sixteenth.
    { id: 'eighths', pattern: 'x.x.x.x.x.x.x.x.', energy: 3, feel: 'straight', space: 'mid' },
    { id: 'sixteenths', pattern: '.o.x.o.x.o.x.o.x', energy: 4, feel: 'straight', space: 'busy' },
    { id: 'shuffle', pattern: '..x..o..x..o..x.', energy: 3, feel: 'swung', space: 'mid' },
    { id: 'driving', pattern: 'oxoxoxoxoxoxox-x', energy: 5, feel: 'rolling', space: 'busy' },
    { id: 'triplet-cross', pattern: 'x..x..x..x..x..x', energy: 4, feel: 'broken', space: 'mid' },
    // A bar that behaves, then a run of five to end it. The variance lands in
    // one place rather than everywhere, which is what keeps it subtle.
    { id: 'burst-run', pattern: '..x...x...xxxxx.', energy: 4, feel: 'broken', space: 'busy' },
  ],

  basslines: [
    {
      id: 'pump',
      steps: '..0...0...0...0.',
      energy: 2,
      register: 'low',
      space: 'sparse',
    },
    {
      id: 'pump-walk',
      steps: '..0...0...0.2.0.',
      energy: 3,
      register: 'low',
      space: 'mid',
    },
    {
      id: 'roll',
      steps: '0.0.0.0.0.0.0.2.',
      accent: 'x.......x.......',
      energy: 4,
      register: 'low',
      space: 'busy',
    },
    {
      id: 'acid-classic',
      steps: '0.0.2.0.1.0.2.1.',
      accent: 'x...x.......x...',
      slide: '..~.....~.......',
      energy: 4,
      register: 'low',
      space: 'busy',
    },
    {
      id: 'acid-seventh',
      steps: '0.3.0.2.a...0.1.',
      accent: 'x...x.......x...',
      slide: '..~.........~...',
      // 4, not 5. The bass asks for `1 + intensity * 3`, and intensity is capped
      // at 1 — so nothing ever asked for a 5 and this cell had never once been
      // heard. An energy no request can reach is a cell that is not in the game.
      energy: 4,
      register: 'low',
      space: 'busy',
      needsSeventh: true,
    },
    {
      id: 'dub-long',
      steps: '0~~~~~~~........',
      energy: 1,
      register: 'low',
      space: 'sparse',
    },
    {
      id: 'dub-two',
      steps: '0~~~~~~~2~~~....',
      energy: 2,
      register: 'low',
      space: 'sparse',
    },
    {
      id: 'stab-low',
      steps: '0...0.0...0...2.',
      energy: 3,
      register: 'low',
      space: 'mid',
    },
  ],

  motifs: [
    {
      id: 'call',
      steps: '....a...b.......',
      energy: 2,
      register: 'high',
      space: 'sparse',
    },
    {
      id: 'call-answer',
      steps: '....a...b...c...',
      energy: 3,
      register: 'high',
      space: 'mid',
    },
    {
      id: 'two-bar-line',
      steps: 'a.b.a.c.b.a.b.c.' + 'a.b.c.b.a...c...',
      energy: 4,
      register: 'high',
      space: 'busy',
    },
    {
      id: 'hook-rise',
      steps: '..a...b...c...b.',
      energy: 3,
      register: 'high',
      space: 'mid',
    },
    {
      id: 'bell-sparse',
      steps: '........a.......',
      energy: 1,
      register: 'high',
      space: 'sparse',
    },
    {
      id: 'mid-riff',
      steps: '..1...2...1...0.',
      energy: 3,
      register: 'mid',
      space: 'mid',
    },

    // ---- shapes, rather than runs -------------------------------------------
    //
    // The cells above are mostly ascending: a, then b, then c. That is a scale,
    // and a scale is not a tune — it has no destination, so nothing about it is
    // memorable. What makes four notes stick is *shape*: leaving and coming
    // back, rising and falling, or saying a thing twice with a different ending.
    //
    // None of these use more notes than what is already here. They use the same
    // three chord tones and arrange them into a gesture.

    {
      // Away and back. The oldest melodic figure there is — go up to a
      // neighbour, return home — stated twice with a higher peak the second
      // time, which is the whole sentence: question, then the same question
      // asked harder.
      id: 'neighbour',
      steps: '..a...b.a.......' + '..a...c.a.......',
      energy: 2,
      register: 'high',
      space: 'mid',
    },
    {
      // An arch. Up over the first bar, down over the second, landing where it
      // started. A contour you can hum after one pass because you can feel where
      // it is going before it gets there.
      id: 'arch',
      steps: 'a...b...c...b...' + 'c...b...a.......',
      energy: 3,
      register: 'high',
      space: 'sparse',
    },
    {
      // A pickup — the phrase starts *before* the beat and lands on it. This is
      // most of the difference between a line that sounds played and one that
      // sounds sequenced, and it costs one sixteenth.
      id: 'pickup',
      steps: '...ab...a...b...' + '...ac...b...a...',
      energy: 4,
      register: 'high',
      space: 'mid',
    },
    {
      // Leap, then walk back down. A big interval is the most attention a melody
      // can ask for, and stepwise motion afterwards is how it pays that back —
      // do either alone and it is a jump or a scale, do both and it is a hook.
      id: 'leap-step',
      steps: 'a.......c.b.a...' + 'b.......c.b.a...',
      energy: 4,
      register: 'high',
      space: 'sparse',
    },
    {
      // Two notes, falling. The sigh figure: almost nothing, and unmistakable.
      // For builds so full that anything else would be in the way.
      id: 'sigh',
      steps: '....b.a.........',
      energy: 1,
      register: 'high',
      space: 'sparse',
    },
    {
      // Held notes are melody too, and the mid register only had one cell — so
      // half the builds in the game were hearing the same line.
      id: 'mid-song',
      steps: '..1~..2~..1...0~',
      energy: 2,
      register: 'mid',
      space: 'mid',
    },
  ],

  stabs: [
    { id: 'offbeat', pattern: '..x...x...x...x.', energy: 3, space: 'mid' },
    { id: 'pushed', pattern: '...x..x....x.x..', energy: 4, space: 'busy' },
    { id: 'sparse', pattern: '......x.........', energy: 1, space: 'sparse' },
    { id: 'downbeat', pattern: 'x.......x.......', energy: 2, space: 'sparse' },
    { id: 'syncopated', pattern: '...x....x..x....', energy: 3, space: 'mid' },
    // One three-against-four in here too, but stopping halfway through the bar
    // so the second half stays open. The stab is the loudest melodic thing in
    // the mix and a cross-rhythm that ran the whole bar would take it over.
    { id: 'triplet', pattern: 'x..x..x..x......', energy: 4, space: 'busy' },
  ],

  harmonies: [
    {
      id: 'unresolved',
      chords: [
        { root: 0, quality: 'min7' },
        { root: 10, quality: 'maj' },
      ],
      barsPerChord: 2,
      mood: 'driving',
    },
    {
      id: 'pop-minor',
      chords: [
        { root: 0, quality: 'min' },
        { root: 8, quality: 'maj' },
      ],
      barsPerChord: 4,
      mood: 'lifting',
    },
    {
      id: 'hypnotic',
      chords: [
        { root: 0, quality: 'min7' },
        { root: 0, quality: 'sus' },
      ],
      barsPerChord: 8,
      mood: 'suspended',
    },
    {
      id: 'drone',
      chords: [{ root: 0, quality: 'min' }],
      barsPerChord: 8,
      mood: 'dark',
    },
    {
      id: 'lament',
      chords: [
        { root: 0, quality: 'min' },
        { root: 5, quality: 'min' },
      ],
      barsPerChord: 4,
      mood: 'dark',
    },
    {
      id: 'open',
      chords: [
        { root: 0, quality: 'sus' },
        { root: 10, quality: 'sus' },
      ],
      barsPerChord: 4,
      mood: 'suspended',
    },
  ],
};

validate(CELLS);
