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
export type ChordQuality = 'min' | 'maj' | 'sus' | 'min7';

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
export function validate(library: CellLibrary): void {
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
  }
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
  ],

  backbeats: [
    { id: 'two-four', pattern: '....x.......x...', energy: 2, feel: 'straight', space: 'sparse' },
    { id: 'two-four-ghost', pattern: '....x.......x..o', energy: 3, feel: 'straight', space: 'mid' },
    { id: 'two-four-hard', pattern: '....X.......X...', energy: 4, feel: 'straight', space: 'sparse' },
    { id: 'clave', pattern: '..x.x......x.x..', energy: 3, feel: 'broken', space: 'mid' },
    { id: 'doubled', pattern: '....x..o....X..x', energy: 5, feel: 'rolling', space: 'busy' },
    { id: 'late', pattern: '.....x.......x..', energy: 2, feel: 'swung', space: 'sparse' },
  ],

  hats: [
    { id: 'offbeat', pattern: '..x...x...x...x.', energy: 2, feel: 'straight', space: 'sparse' },
    { id: 'offbeat-open', pattern: '..x...-...x...-.', energy: 3, feel: 'straight', space: 'mid' },
    { id: 'eighths', pattern: '..x...x...x...x.', energy: 2, feel: 'straight', space: 'sparse' },
    { id: 'sixteenths', pattern: '.o.x.o.x.o.x.o.x', energy: 4, feel: 'straight', space: 'busy' },
    { id: 'shuffle', pattern: '..x..o..x..o..x.', energy: 3, feel: 'swung', space: 'mid' },
    { id: 'driving', pattern: 'oxoxoxoxoxoxox-x', energy: 5, feel: 'rolling', space: 'busy' },
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
      energy: 5,
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
  ],

  stabs: [
    { id: 'offbeat', pattern: '..x...x...x...x.', energy: 3, space: 'mid' },
    { id: 'pushed', pattern: '...x..x....x.x..', energy: 4, space: 'busy' },
    { id: 'sparse', pattern: '......x.........', energy: 1, space: 'sparse' },
    { id: 'downbeat', pattern: 'x.......x.......', energy: 2, space: 'sparse' },
    { id: 'syncopated', pattern: '...x....x..x....', energy: 3, space: 'mid' },
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
