/**
 * The Score. GDD §18.
 *
 * Every taste decision the sound engine makes, named and bundled, so a different
 * mood is a different object rather than a different diff.
 *
 * The layers this splits into already existed — `arrange()` was always a pure
 * function, voices were always pure functions over a `VoiceCtx`, and `pool()` was
 * always a seam. What did not exist was anywhere to put a *second* set of
 * numbers: every constant was a literal at its point of use, so `5200` lived
 * inside the filter expression and `+24` inside the motif call, and having two of
 * anything was impossible. That is the whole of what this fixes.
 *
 *   cells     the vocabulary   — which phrases exist
 *   tonality  the notes        — what a chord *is*
 *   feel      the selection    — which phrases your build gets
 *   mix       the sequencer    — when, how loud, how bright
 *   graph     the room         — busses, sends, the limiter
 *   voices    the timbres      — how each instrument is built
 *
 * ---
 *
 * **A Score is TypeScript, not JSON, and that is deliberate.**
 *
 * Player-written cells are JSON: hand-editable, hostile input, validated on the
 * way in. A Score is authored here, so it can hold *behaviour* — and the things
 * that are behaviour should stay behaviour. `chooseMood` is a judgement with a
 * paragraph of reasoning behind it; flattened into a lookup table it would be
 * less readable *and* less capable, because "more rows means darker" cannot be
 * expressed as a table at all. Tables where it is a table, functions where it is
 * a decision.
 *
 * **What no Score may touch.** The limiter's guarantee (§18.4 — the volume never
 * goes up), the 16/32-step cell grid, chord-relative melody, and deterministic
 * selection. Those are not taste, they are why the game works at 600 events a
 * second, and `schedule.test.ts` asserts the two that a config file could
 * otherwise quietly break.
 */
import type { Hue } from '../sim/types';
import type { ArrangeHue } from './arrange';
import { validate, type CellLibrary, type Feel as CellFeel, type Mood, type Register, type Space } from './cells';
import { current } from './scores/current';
import { deep } from './scores/deep';
import type {
  BassVoice,
  KickVoice,
  LeadVoice,
  PercVoice,
  StabVoice,
} from './voices';

// ---------------------------------------------------------------- tonality

export interface Tonality {
  /**
   * Chord shapes, as semitones from the chord root.
   *
   * Keyed by the name a `HarmonyCell` uses. A Score may add shapes — this is the
   * cheapest real change to the mood in the whole file, because today every
   * entry is consonant and so the score *cannot* sound dangerous however it is
   * arranged. A Phrygian ♭2 costs four numbers here.
   *
   * `validate()` rejects a cell naming a shape the active Score does not define,
   * which is a stronger guarantee than the union type this replaced: that only
   * caught misspellings, this also catches a shape that is spelled correctly and
   * missing.
   */
  chords: Readonly<Record<string, readonly number[]>>;
}

// -------------------------------------------------------------------- feel

/** What `chooseMood` is allowed to know. */
export interface MoodContext {
  /** Live rows in the Engine. */
  size: number;
  /** §13.2 — 0 during the build, above 0 once Meltdown has begun. */
  meltdown: number;
  /** The Engine feeds on its own output, so it never resolves. */
  hasCascade: boolean;
  /** An economy build, which sits suspended. */
  hasConvert: boolean;
}

/** What the two instrument choices are allowed to know. */
export interface RegisterContext {
  hue: ArrangeHue;
  /** Register of the lowest Action owned, 0..2. */
  lowest: number;
  /** Register of the highest Action owned, 0..2. */
  highest: number;
  hasOrbital: boolean;
}

/** How many of a modifier the Engine is running. */
export type ModifierCount = (id: string) => number;

export interface FeelTuning {
  /**
   * The Axiom's whole contribution: a key, a default groove, and how much the
   * track shuffles. Small on purpose — three numbers, against a build that
   * contributes a dozen decisions.
   */
  axiomBias: Readonly<Record<string, { key: number; feel: CellFeel; swing: number }>>;
  /** Which bias an unrecognised Axiom falls back to. Named, not first-in-object. */
  defaultAxiom: string;

  /** §16.3's hue discipline, applied to the kit. */
  hueKick: Readonly<Record<ArrangeHue, KickVoice>>;
  huePerc: Readonly<Record<ArrangeHue, PercVoice>>;
  hueStab: Readonly<Record<ArrangeHue, StabVoice>>;
  huePadWave: Readonly<Record<ArrangeHue, OscillatorType>>;

  /**
   * The percussion voice for an Engine with no rows.
   *
   * The menu is this case and it is the first thing anybody hears: a bed with no
   * Engine behind it, so the backbeat is the loudest thing in a nearly empty mix,
   * and a clap in an empty mix is a hand clapping in your ear.
   */
  emptyPercVoice: PercVoice;

  /** Where each Action primitive sits, which is also where it sits on screen. */
  primitiveRegister: Readonly<Record<string, number>>;

  /** Triggers that fire on your own output — the ones that make a loop. */
  cascadeTriggers: ReadonlySet<string>;

  /**
   * `pick()`'s scorer. Distance from the wanted energy costs `energy` per step;
   * matching the wanted feel, space or register pays; the cell currently playing
   * takes `avoid` so a variation pass can lose a tie it would otherwise always
   * win; `jitter` is the deterministic tie-break, deliberately too small to beat
   * a real preference.
   */
  weights: {
    energy: number;
    feel: number;
    space: number;
    register: number;
    avoid: number;
    /**
     * The tie-break, as a *divisor* of `hash % 100`.
     *
     * A divisor rather than a multiplier on purpose: `x / 120` and
     * `x * (1 / 120)` are not bit-identical in floating point, and this value
     * decides ties between cells. Storing the reciprocal would have been a
     * silent, occasional change to which bassline a build gets.
     */
    jitterScale: number;
  };

  /**
   * The section-to-section energy nudge, indexed by variation.
   *
   * Reselecting with a different seed was not enough on its own: the energy and
   * space a build asks for narrow the field so hard that only two motifs in a
   * library of nine were ever plausible. Moving the *ask* is what opens the
   * library without ever asking for a cell that does not fit the Engine.
   */
  lift: readonly number[];

  /** What the harmony is *for*. See MoodContext. */
  chooseMood(ctx: MoodContext): Mood;

  /** Which groove the drums play. */
  chooseFeel(count: ModifierCount, bias: CellFeel): CellFeel;

  /** The lift applied to a wanted space. */
  shiftSpace(base: Space, lift: number): Space;

  bassVoice(ctx: RegisterContext): BassVoice;
  leadVoice(ctx: RegisterContext): LeadVoice;

  /**
   * What each group is asked for.
   *
   * Formulas rather than tables because that is what they are: the bass gets
   * sparser as the Engine fills up, which is the single most important rule in
   * the arranger — without it a five-row build and a busy bassline compete for
   * the same bar.
   */
  ask: {
    kickEnergy(size: number): number;
    backbeatEnergy(intensity: number): number;
    hatEnergy(intensity: number, lift: number): number;
    hatSpace(intensity: number): Space;
    bassEnergy(intensity: number, lift: number): number;
    motifEnergy(intensity: number, lift: number): number;
    motifRegister(highest: number): Register;
    stabEnergy(size: number, lift: number): number;
    stabSpace(size: number): Space;
    /** The ladder the bass and the motif share. */
    space(size: number): Space;
  };

  /** Timbre from modifiers. Every one of these is something you can point at. */
  echo(count: ModifierCount): number;
  brightness(count: ModifierCount): number;
  bassQ(voice: BassVoice, count: ModifierCount): number;
  /** How eagerly the hat layers arrive. */
  drive(size: number): number;
}

// --------------------------------------------------------------------- mix

export interface MixTuning {
  /** §18 — techno moves in 16-bar phrases. Everything automated rides this. */
  phraseBars: number;
  /** Bars before the melodic material is reselected. */
  varyBars: number;
  /**
   * §18.4 — polyphony cap for engine accents. The point of an accent is that it
   * is rarer than the thing it accents.
   */
  maxAccentsPerStep: number;
  /** How fast the arrangement follows EPS. A cascade spikes for half a second. */
  intensitySmoothing: number;
  /** How fast the siege score takes the room. */
  siegeSmoothing: number;
  /** Below this the siege mix is snapped to zero. */
  siegeFloor: number;

  tempo: {
    base: number;
    /** §13.2 — the one thing allowed to move the pulse. */
    meltdown: number;
  };

  /**
   * Timbre by fuel gauge. Not pitch: transposing mid-phrase with no cadence is
   * indistinguishable from the chords being random.
   */
  hueColour: Readonly<Record<Hue, number>>;

  /**
   * The phrase filter. §18 — this genre does not build with chords, it builds by
   * opening a filter and adding layers over sixteen bars, then dropping them and
   * doing it again. This is the number that makes a loop feel like an arrangement.
   */
  filter: {
    floor: number;
    span: number;
    q: number;
    opennessBase: number;
    opennessSpan: number;
    /**
     * How much of the span is free, and how much intensity has to earn.
     *
     * Two fields that happened to hold the same number in the expression these
     * replaced — `(0.5 + i * 0.5)`. Splitting them is the point: a darker Score
     * wants a low floor and a wide earn, which was not expressible while they
     * were one literal typed twice.
     */
    intensityFloor: number;
    intensitySpan: number;
    glide: number;
  };

  /** Where in a phrase the lead answers itself, and where it stops. */
  phrase: {
    answerFrom: number;
    restFrom: number;
  };

  gains: {
    kick: number;
    backbeatBase: number;
    backbeatPerIntensity: number;
    hat: number;
    hatBleak: number;
    bass: number;
    stab: number;
    motif: number;
    sub: number;
    chord: number;
    chordBleak: number;
  };

  /** What each layer has to earn before it is heard. */
  entry: {
    hatDrive: number;
    bass: number;
    stabPhrase: number;
    stabIntensity: number;
    motifPhrase: number;
    motifIntensity: number;
    chordIntensity: number;
  };

  /** Semitone offsets. Rows stack into a mix rather than crowding one octave. */
  register: {
    bass: number;
    sub: number;
    motif: number;
    /** The back half of a phrase answers the front half from up here. */
    motifAnswer: number;
    part: number;
  };

  /** Note lengths, in beats. */
  length: {
    sub: number;
    chord: number;
    chordBleak: number;
  };

  /** How far a swung offbeat is pushed, as a fraction of a beat. */
  swing: number;

  /**
   * Sidechain. What makes a kick *punch* rather than fight the bass for the same
   * frequencies, and most of the reason a real track breathes.
   */
  duck: {
    depth: number;
    recover: number;
  };

  /** The music bus, and where it goes when the engine stalls. */
  bus: {
    music: number;
    stalled: number;
  };

  /** Engine events, as accents. See `flush`. */
  accents: {
    /** How hard the engine layer steps back as the arrangement takes over. */
    duckPerIntensity: number;
    duckCap: number;
    /** Below this the engine layer is silent — the track is carrying itself. */
    duckFloor: number;
    /** Quiet events stop being worth a note at this fraction of intensity. */
    weightGate: number;
    gainBase: number;
    gainSpan: number;
    /** Chord degree each cue kind starts from. */
    base: Readonly<Record<string, number>>;
    /** Highest degree a cascade may climb to. */
    maxDegree: number;
  };

  /** Level-ups and Overheat. Never dropped for a kill note. */
  occasion: {
    perStep: number;
    hits: number;
    spacing: number;
    decay: number;
    length: number;
    gain: number;
    /** Overheat resolves *down* a fourth — the one chord that sounds wrong. */
    overheatShift: number;
    overheatSubShift: number;
    overheatSubGain: number;
    overheatSubLength: number;
    overheatGain: number;
  };

  /** A detonation big enough to be the loudest thing on screen. */
  bigEvent: {
    subGain: number;
    subLength: number;
    chordGain: number;
    chordLength: number;
    hueGain: number;
    hueRegister: number;
    /** Sixteenths of room the bass gives it. */
    claim: number;
  };

  /**
   * §21b.7 — the siege score. A different piece of music, not a treatment of the
   * existing one: a modification of something familiar reads as the familiar
   * thing slightly off, and a replacement reads as a replacement.
   */
  siege: {
    hitGain: number;
    droneHz: number;
    droneLength: number;
    droneGainBase: number;
    droneGainPerSiege: number;
    droneDuckDepth: number;
    droneDuckRecover: number;
    screamFrom: number;
    screamLength: number;
    screamGainBase: number;
    screamGainPerSiege: number;
    screamRegister: number;
    /** Octave multiplier, so the line sits clear of the drone rather than over it. */
    screamOctaves: number;
    answerFrom: number;
    answerLength: number;
    answerGainBase: number;
    answerGainPerSiege: number;
    answerRegister: number;
    answerStride: number;
    /** What the siege screams, as a line rather than a note. */
    cries: readonly { deg: number; len: number; up: boolean }[];
    /** How far the run's own arrangement is taken away. */
    scoreTrim: number;
    fxDry: number;
    fxWet: number;
    crossfade: number;
  };

  /** §8 — what the intrusion does to the track while it is up. */
  interfere: {
    corner: number;
    open: number;
    level: number;
    /** Fast in, slow out, so it reads as something being done to the room. */
    inSeconds: number;
    outSeconds: number;
  };

  /** Chrome. Hovers fire hundreds of times a minute; without a floor it hisses. */
  hoverThrottle: number;
}

// ------------------------------------------------------------------- graph

export interface GraphTuning {
  /** A low shelf before the limiter, down where the kick and bass live. */
  lowShelf: { hz: number; gain: number };

  /**
   * §18.4 — the guarantee, and the one thing in this file that is not taste.
   *
   * A compressor is not a correction, it is a control loop: threshold well below
   * the working level and a high ratio means output is set by the compressor
   * rather than by how many things happen to be playing. Driven *into* it and
   * trimmed straight back out — the pair has to be read together, because
   * driving without trimming is simply turning the game up, which is the exact
   * failure the whole graph exists to prevent.
   */
  limiter: {
    threshold: number;
    knee: number;
    ratio: number;
    attack: number;
    release: number;
    drive: number;
    trim: number;
  };

  /**
   * The dub delay: a feedback loop with a lowpass inside it, so each repeat
   * arrives darker than the last and the tail dissolves rather than stopping.
   * Dotted eighth, so the echoes land between the beats as counter-rhythm.
   */
  delay: { note: number; feedback: number; damp: number; glide: number };

  /** §21b.7 — the siege's treatment of the Engine's own sounds. */
  siegeFx: { band: number; q: number; ringHz: number };

  /**
   * Starting bus levels. The master is absent on purpose — that is the player's
   * volume, not the Score's.
   */
  busGains: {
    punch: number;
    music: number;
    engine: number;
    ui: number;
    siege: number;
  };

  /**
   * Space. A synthesized impulse — decaying noise, no assets, consistent with
   * §18.1's no-samples rule.
   *
   * `send` is 0 in the current Score, so the bus exists and nothing reaches it.
   * That is the honest way to add a node to a graph under a golden: the wiring
   * lands and is reviewable, and the sound does not move until somebody turns it
   * up on purpose.
   */
  reverb: { send: number; seconds: number; damp: number; predelay: number };
}

// ------------------------------------------------------------------ voices

/**
 * Per-voice timbre — the numbers *inside* each voice.
 *
 * Kept as a bag of per-voice records rather than one uniform shape, because the
 * voices genuinely have nothing in common: `clap` is three noise bursts a few
 * milliseconds apart, `snare` is noise over a tuned body, `rim` is two squares
 * through a bandpass. A shared `PercParams` would either fail to express them or
 * flatten them into something that no longer describes what is there.
 *
 * The graphs themselves are untouched. That is where all the risk lives, and a
 * Score wanting a fundamentally different kick can ship its own function.
 *
 * Only the voices that carry *mood* are here — the ones whose filter corners and
 * decays are what "bright" and "dark" actually mean. The event voices (gate,
 * breach, Meltdown, the siege) keep their numbers in place: they are character
 * rather than mood, they are heard once, and the gate in particular is approved
 * as it stands.
 */
export interface VoiceTuning {
  kick: KickTuning;
  hat: HatTuning;
  sub: SubTuning;
  bass: BassTuning;
  stab: StabTuning;
  lead: LeadTuning;
  chord: ChordTuning;
}

/**
 * Kicks. Three parts each — a click transient so it cuts a busy mix, a fast pitch
 * drop the ear reads as "hit", and a body the chest reads as weight. The
 * *proportions* are what make them different drums rather than one drum with a
 * knob on it.
 */
export interface KickTuning {
  spec: Readonly<
    Record<
      KickVoice,
      { from: number; to: number; drop: number; decay: number; click: number; clickHz: number }
    >
  >;
  gain: number;
  attack: number;
  clickAttack: number;
  clickDecay: number;
  /** The transient's highpass, so the click is edge rather than thump. */
  clickHp: number;
}

export interface HatTuning {
  /** Highpass corner. Everything below this is somebody else's job. */
  hz: number;
  attack: number;
  /** Closed, and open. The open hat is what pushes a bar along. */
  closed: number;
  open: number;
  gain: number;
}

export interface SubTuning {
  attack: number;
  gain: number;
}

/**
 * Three genuinely different instruments, not one with a filter knob — so three
 * genuinely different parameter sets. The acid's squelch is the *envelope*, not
 * the resonance, which is the part everyone gets wrong.
 */
export interface BassTuning {
  sub: { length: number; attack: number; gain: number; triangle: number };
  acid: {
    accentLength: number;
    attack: number;
    gain: number;
    accentGain: number;
    /** Filter peak as a multiple of the note, plain and accented. */
    peak: number;
    accentPeak: number;
    peakCeiling: number;
    start: number;
    startFloor: number;
    land: number;
    landFloor: number;
    rise: number;
    /** Where in the note the filter has collapsed, plain and accented. */
    fall: number;
    accentFall: number;
    glide: number;
  };
  pluck: {
    attack: number;
    gain: number;
    cutoff: number;
    cutoffCeiling: number;
    land: number;
    landFloor: number;
    fall: number;
    /** The octave-down square under it. */
    subLevel: number;
  };
}

export interface StabTuning {
  organ: {
    length: number;
    attack: number;
    gain: number;
    /** Drawbar registration: multiple and level per partial. */
    drawbar: readonly (readonly [number, number])[];
    level: number;
    register: number;
  };
  /** `saw` and `dub` share a graph and differ only in these. */
  filtered: Readonly<
    Record<
      'saw' | 'dub',
      {
        wave: OscillatorType;
        length: number;
        gain: number;
        open: number;
        close: number;
        q: number;
      }
    >
  >;
  attack: number;
  detune: number;
  level: number;
  register: number;
}

export interface LeadTuning {
  bell: {
    length: number;
    attack: number;
    gain: number;
    /** Modulator ratio and index. Harmonic and shallow, or it screams. */
    ratio: number;
    depth: number;
    depthEnd: number;
    collapse: number;
    ceiling: number;
    cutoff: number;
    q: number;
  };
  acid: {
    length: number;
    attack: number;
    gain: number;
    q: number;
    start: number;
    peak: number;
    peakCeiling: number;
    rise: number;
    land: number;
    fall: number;
    glide: number;
  };
  pluck: {
    length: number;
    attack: number;
    gain: number;
    open: number;
    close: number;
    q: number;
    /** The octave square above it, slightly sharp. */
    octave: number;
    octaveLevel: number;
  };
}

export interface ChordTuning {
  attack: number;
  gain: number;
  open: number;
  close: number;
  q: number;
  detune: number;
  level: number;
  register: number;
}

// ------------------------------------------------------------------- score

export interface Score {
  id: string;
  /** Shown in the Lab and when `?score=` names something that does not exist. */
  name: string;
  cells: CellLibrary;
  tonality: Tonality;
  feel: FeelTuning;
  mix: MixTuning;
  graph: GraphTuning;
  voices: VoiceTuning;
}

// ---------------------------------------------------------------- registry

export const SCORES: Readonly<Record<string, Score>> = { current, deep };

export const DEFAULT_SCORE = 'current';

/**
 * Resolve a `?score=` value.
 *
 * An unknown id falls back to the default and warns rather than throwing. A typo
 * in a URL must not produce a silent game — that failure mode has already cost
 * this project one round of "there's no sound in the menu", and the whole reason
 * this seam exists is to make comparing two Scores cheap.
 */
export function resolveScore(id: string | null | undefined): Score {
  if (!id) return SCORES[DEFAULT_SCORE]!;
  const found = SCORES[id];
  if (found) return found;
  console.warn(
    `[audio] unknown score "${id}" — using "${DEFAULT_SCORE}". Known: ${Object.keys(SCORES).join(', ')}`,
  );
  return SCORES[DEFAULT_SCORE]!;
}

/**
 * Check every Score at boot, against its own chord table.
 *
 * A harmony cell naming a shape its Score does not define used to be impossible —
 * `ChordQuality` was a union, so the type checker caught it. Now that a Score may
 * add shapes the union is gone, and the guarantee moves here: the same trade
 * `cells.ts` already makes for patterns, and for the same reason. A malformed
 * library does not throw, it *drifts*, and failing loudly at boot is the only
 * humane option.
 */
export function validateScores(): void {
  for (const score of Object.values(SCORES)) {
    try {
      validate(score.cells, score.tonality.chords);
    } catch (err) {
      throw new Error(`score "${score.id}": ${(err as Error).message}`);
    }
  }
}
