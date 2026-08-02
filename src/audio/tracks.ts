/**
 * The songs. GDD §18.
 *
 * One track per Axiom. Your starting Program has a sound, and it is the sound
 * the whole run is played in — which makes the Axiom a choice about how the run
 * *feels* as well as how it opens, and gives the Music menu a reason to exist
 * beyond a settings list.
 *
 * ---
 *
 * **How this genre actually works**, since the first version of this file got it
 * wrong by writing pop songs:
 *
 * - **Techno is modal, not harmonic.** There is a tonal centre and it stays put.
 *   Two chords is a lot; four chords one-per-bar is a pop song, and it sounds
 *   like one. Chords here are held for two or four bars so a change *lands*.
 * - **Movement comes from the filter and the arrangement**, across 8- and
 *   16-bar phrases. That is the "progression" the genre has: the same loop,
 *   opening up and closing down, with layers entering and dropping at phrase
 *   boundaries. A listener feels the phrase even when the notes never change.
 * - **Kick and clap are the backbone.** Four on the floor, clap on 2 and 4.
 *   Leaving the clap out — as the first version did — removes the thing the
 *   body actually counts.
 * - **The offbeat open hat** is the house/techno signature, and closed
 *   sixteenths are what create drive without changing tempo.
 * - **The stab** — a short chord hit on an offbeat — is the Detroit move, and it
 *   is where most of the genre's "melody" lives.
 * - **A motif repeats.** One or two bars, hypnotically, unchanged. The hook is
 *   repetition, not development.
 * - **Everything ducks under the kick.** Sidechain is not a polish step here, it
 *   is what makes the low end legible at all.
 *
 * Everything is written in semitones from the track's key.
 */

import type {
  BassVoice,
  KickVoice,
  LeadVoice,
  PercVoice,
  StabVoice,
} from './voices';

export type ChordQuality = 'min' | 'maj' | 'sus' | 'min7';

export interface Chord {
  /** Semitones above the track key. */
  root: number;
  quality: ChordQuality;
}

export interface Track {
  /** Matches an Axiom id — the Axiom you pick is the song you get. */
  id: string;
  name: string;
  /** One line, shown in the Music menu. */
  blurb: string;
  /** Semitones from A. Sets the whole track's centre. */
  key: number;
  /**
   * Two chords, usually. Held for `barsPerChord` bars each, so the loop breathes
   * over eight or sixteen bars rather than churning every two seconds.
   */
  progression: Chord[];
  barsPerChord: number;
  /** 16 steps each. */
  kick: boolean[];
  clap: boolean[];
  /** Offbeat chord stabs — the Detroit signature. */
  stab: boolean[];
  /** Three bass patterns by intensity. -1 rests; values index chord tones. */
  bass: number[][];
  /**
   * The hook: a 16-step motif, repeated unchanged. Values index the chord's
   * tones across two octaves (0-2 low, 3-5 high); -1 rests.
   */
  motif: number[];
  /**
   * Steps the bass accents, as indices into the pattern. 303 accents are most
   * of what makes an acid line move; ignored by the other bass voices.
   */
  accents?: number[];
  /** 0 = straight, ~0.25 = heavy shuffle on offbeat sixteenths. */
  swing: number;

  // ---- instruments. Named voices, not knobs: two tracks sharing a synth with
  // different parameters still sound like the same band.
  kickVoice: KickVoice;
  percVoice: PercVoice;
  bassVoice: BassVoice;
  stabVoice: StabVoice;
  leadVoice: LeadVoice;
  padWave: OscillatorType;
  bassQ: number;
  bassBrightness: number;
  /** How much of the stab and lead is fed to the dub delay. 0 = dry. */
  echo: number;
  /** How eagerly hat layers arrive. Low is spacious, high is relentless. */
  drive: number;
}

/**
 * Chord tones as semitones from the chord root. Kept to three or four notes:
 * every accent the engine fires is snapped to these, so a forty-note cascade is
 * a chord being hammered rather than a scale run that might clash with it.
 */
export const CHORD_TONES: Record<ChordQuality, number[]> = {
  min: [0, 3, 7],
  maj: [0, 4, 7],
  sus: [0, 5, 7],
  min7: [0, 3, 7, 10],
};

const FOUR_ON_FLOOR = [
  true, false, false, false, true, false, false, false,
  true, false, false, false, true, false, false, false,
];
/** A ghost kick before the last beat. Rolls forward into the bar. */
const ROLLING = [
  true, false, false, false, true, false, false, false,
  true, false, false, true, true, false, false, false,
];
/**
 * A dropped kick on the third beat reads as a mistake rather than as space —
 * the body counts four and one of them is missing. Dub techno does not break
 * the kick; it keeps four on the floor and creates space with a *soft, long*
 * kick and long silences everywhere else. So the pattern stays whole and the
 * character moves into the voice.
 */

/** Clap on 2 and 4. With the kick, this is what the body counts. */
const BACKBEAT = [
  false, false, false, false, true, false, false, false,
  false, false, false, false, true, false, false, false,
];
/** Backbeat with a ghost sixteenth before the downbeat. */
const BACKBEAT_GHOST = [
  false, false, false, false, true, false, false, false,
  false, false, false, false, true, false, false, true,
];

/** Classic offbeat eighths. */
const STAB_OFFBEAT = [
  false, false, true, false, false, false, true, false,
  false, false, true, false, false, false, true, false,
];
/** Syncopated — lands just before the beat, which pulls the bar forward. */
const STAB_PUSHED = [
  false, false, false, true, false, false, true, false,
  false, false, false, true, false, true, false, false,
];
const STAB_SPARSE = [
  false, false, false, false, false, false, true, false,
  false, false, false, false, false, false, false, false,
];

export const TRACKS: Track[] = [
  {
    id: 'ignition',
    name: 'Ignition',
    blurb: 'Warm house. Organ stabs, round bass, four on the floor with room around it.',
    key: 0,
    // i - VI, four bars each: the loop turns over every eight bars, slow enough
    // that the change reads as an event rather than as churn.
    progression: [
      { root: 0, quality: 'min' },
      { root: 8, quality: 'maj' },
    ],
    barsPerChord: 4,
    kick: FOUR_ON_FLOOR,
    clap: BACKBEAT,
    stab: STAB_OFFBEAT,
    bass: [
      [-1, -1, 0, -1, -1, -1, 0, -1, -1, -1, 0, -1, -1, -1, 0, -1],
      [-1, -1, 0, -1, -1, -1, 0, -1, -1, -1, 0, -1, -1, 2, 0, -1],
      [0, -1, 0, -1, -1, 0, 0, -1, 0, -1, 0, 2, -1, 0, 2, 1],
    ],
    motif: [-1, -1, -1, -1, 3, -1, 4, -1, -1, -1, 3, -1, -1, 5, -1, -1],
    swing: 0,
    kickVoice: 'punch',
    percVoice: 'clap',
    bassVoice: 'pluck',
    stabVoice: 'organ',
    leadVoice: 'pluck',
    padWave: 'sawtooth',
    bassQ: 8,
    bassBrightness: 1,
    echo: 0.12,
    drive: 1,
  },
  {
    id: 'circuit',
    name: 'Circuit',
    blurb: 'Acid. A 303 that slides and screams, a snare backbeat, and an actual tune.',
    key: 3,
    // i - VII, two bars each. Rocks and never resolves, which is what you want
    // from something meant to run for twenty minutes.
    progression: [
      { root: 0, quality: 'min7' },
      { root: 10, quality: 'maj' },
    ],
    barsPerChord: 2,
    kick: ROLLING,
    clap: BACKBEAT_GHOST,
    stab: STAB_PUSHED,
    bass: [
      [0, -1, -1, -1, 0, -1, -1, -1, 0, -1, -1, -1, 0, -1, -1, -1],
      [0, -1, 0, -1, 0, -1, 0, -1, 0, -1, 0, -1, 0, -1, 2, 1],
      [0, 0, -1, 0, 0, -1, 0, 0, 1, 0, -1, 1, 2, -1, 2, 1],
    ],
    // Two bars, so it is a line rather than a cell — the one track here with a
    // melody you could hum, which is the thing worth leaning into.
    motif: [
      3, -1, 4, -1, 3, -1, 5, 4, -1, 3, -1, -1, 4, -1, 5, -1,
      3, -1, 4, -1, 5, -1, 4, 3, -1, -1, 5, -1, 4, 3, -1, -1,
    ],
    accents: [0, 4, 8, 12, 14],
    swing: 0,
    kickVoice: 'tight',
    percVoice: 'snare',
    bassVoice: 'acid',
    stabVoice: 'saw',
    leadVoice: 'acid',
    padWave: 'square',
    bassQ: 17,
    bassBrightness: 1.6,
    echo: 0.2,
    drive: 1.4,
  },
  {
    id: 'feedback',
    name: 'Feedback',
    blurb: 'Dub techno. A soft deep kick, a rimshot, and chords that echo away for bars.',
    key: -4,
    // One chord for eight bars, then a sus for eight. Barely a progression: the
    // point is the room and the decay, not the harmony.
    progression: [
      { root: 0, quality: 'min7' },
      { root: 0, quality: 'sus' },
    ],
    barsPerChord: 8,
    kick: FOUR_ON_FLOOR,
    clap: BACKBEAT,
    stab: STAB_SPARSE,
    bass: [
      [0, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1],
      [0, -1, -1, -1, -1, -1, -1, -1, 2, -1, -1, -1, -1, -1, -1, -1],
      [0, -1, -1, -1, -1, -1, 2, -1, 1, -1, -1, -1, -1, -1, 2, -1],
    ],
    motif: [-1, -1, -1, -1, -1, -1, -1, -1, 3, -1, -1, -1, -1, -1, -1, -1],
    swing: 0.18,
    kickVoice: 'deep',
    percVoice: 'rim',
    bassVoice: 'sub',
    stabVoice: 'dub',
    leadVoice: 'bell',
    padWave: 'sawtooth',
    bassQ: 4,
    bassBrightness: 0.5,
    // The signature. A stab that is mostly its own echoes is the entire genre,
    // and naming the Axiom "Feedback" makes it too apt to pass up.
    echo: 0.85,
    drive: 0.55,
  },
];

export const TRACK_BY_ID = new Map(TRACKS.map((t) => [t.id, t]));

/** The Axiom you started with is the song you hear. */
export function trackForAxiom(axiomId: string): Track {
  return TRACK_BY_ID.get(axiomId) ?? TRACKS[0]!;
}
