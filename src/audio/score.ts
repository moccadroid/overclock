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
import type { PartTuning, PartVoice } from './parts';
import { validate, type CellLibrary, type Feel as CellFeel, type Mood, type Register, type Space } from './cells';
import { current } from './scores/current';
import { deep } from './scores/deep';
import { industrial } from './scores/industrial';
import { choir } from './scores/choir';
import { vault } from './scores/vault';
import { pulse } from './scores/pulse';
import { rust } from './scores/rust';
import { spire } from './scores/spire';
import { anthem } from './scores/anthem';
import { basin, furnace, lattice, marrow } from './scores/playlist';
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
  /**
   * The scale, in semitones from the key, for cells that ask for degrees.
   *
   * Seven entries. This is what a melody moves through *between* the chord tones
   * — the passing notes, the leading note, the step that makes a line a line
   * rather than a broken chord. Chord-relative cells never touch it.
   */
  scale: readonly number[];
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
    /**
     * How much worse than the best a cell may score and still be considered.
     *
     * `0` is a plain argmax — always the single highest — which is what this was
     * and why a twelve-motif library only ever yielded three. Anything above zero
     * turns selection from "the best" into "one of the plausible ones", chosen by
     * the seed, which is what lets a Score's vocabulary actually be heard.
     *
     * Preference still wins: nothing outside the band is reachable at all. Two is
     * about one step of energy, which is the difference between a cell that fits
     * and one that nearly does.
     */
    spread: number;
  };

  /**
   * Whether the drums reselect as the track develops.
   *
   * `false` keeps the kit fixed for as long as the Engine is, which is the
   * original behaviour and a defensible one — techno keeps its drum machine and
   * changes what is over the top. It also means exactly *one* kick pattern for a
   * whole run: measured at 1 of 9 available, in every Score, because the kick is
   * seeded from the build alone and never sees the variation counter.
   */
  kitVaries: boolean;

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
   * How the harmony is delivered.
   *
   * `gated` is the genre's answer and the one this engine was built on: a chord
   * chopped onto the sixteenths, because harmony in techno is carried
   * rhythmically. `pad` is the other one — held, slow-swelling, no relationship
   * to the grid at all.
   *
   * That was deliberately impossible before. `gatedChord` exists *because* the
   * old pad "swelled with no relationship to the beat", and the pad voice has
   * sat unused in `voices.ts` ever since. It is the right sound for a Score with
   * no drums under it, and the wrong one for every Score that has them.
   */
  chordVoice: 'gated' | 'pad';

  /**
   * What an engine event sounds like — the accents the *battle* fires.
   *
   * `null` uses the three hardcoded hue voices in `voices.ts`, which is what
   * every Score did until now: a saw blip for thermal, a square for voltaic, an
   * FM tone for void, identical in every song. Those are the densest thing in
   * the mix during play and they never changed, so however different two Scores
   * were, the noise your shooting made was the same noise.
   *
   * Naming a part voice per hue moves that. The hue stays distinguishable
   * *within* a song, which is what §16.3 asks for; it just stops being the same
   * three sounds across all of them.
   */
  accentVoice: Readonly<Record<Hue, PartVoice>> | null;

  /**
   * The Engine's own lines — which Trigger fires on which sixteenths, which
   * instrument an Action primitive gets, how each moves across the bar.
   *
   * See `PartTuning`. These were module constants in `parts.ts`, which made the
   * **densest layer in the mix** identical in every Score: measured over 64 bars
   * the parts fire about 576 notes against the motif's 63, and nine Scores
   * produced three distinct part patterns between them. Whatever else changed,
   * the loudest continuous thing in the audition was the same music every time.
   */
  parts: PartTuning;

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

// -------------------------------------------------------------------- form

/**
 * Whether a layer plays in a section.
 *
 * `auto` is the entry rule this Score already has — the stab waits a quarter of
 * the way in, the lead until halfway. `out` and `force` let a section overrule
 * it, which is what a section *is*: a break is not "the quiet part of the
 * curve", it is a decision that the hats are gone.
 */
export type LayerGate = 'auto' | 'out' | 'force';

/**
 * One section of the song.
 *
 * The form is the one thing here that is not derived from the player's Engine,
 * and that is deliberate. §18.1 says the soundtrack *is* the engine, and it still
 * is — every cell in every section is chosen by your build. What the form adds is
 * *when*, which is the part a build cannot express: a build has no opinion about
 * whether bar 48 should be a chorus.
 */
export interface Section {
  id: string;
  bars: number;

  backbeat: LayerGate;
  hats: LayerGate;
  bass: LayerGate;
  stab: LayerGate;
  lead: LayerGate;
  chord: LayerGate;
  /** The Engine's own lines. Dropping these is what makes a break feel empty. */
  parts: LayerGate;
  /**
   * The downbeat sub. Optional, defaulting to `auto`, because until now it was
   * not a decision at all — `onStep` fired one on every bar unconditionally.
   *
   * That is correct for every Score built on a drum kit and wrong for one built
   * without: a track with no kick still had a low thud on every downbeat, which
   * is a kick by another name.
   */
  sub?: LayerGate;

  /** Filter openness across the section, start to end. Replaces the phrase ramp. */
  open: readonly [number, number];

  /**
   * Lay a hat on every Nth sixteenth, on top of whatever the cell plays.
   * Undefined leaves the cell alone; 2 is eighths, 1 is sixteenths.
   *
   * This is how a section gets *denser* rather than merely louder, and it is a
   * subdivision rather than a cell swap on purpose: asking for a busier cell
   * would mean re-running `arrange()` at every section boundary, which fights
   * the handover and would re-cut the track several times a form.
   *
   * It replaced a `drive` multiplier that turned out to do nothing. `drive`
   * scaled the number the *auto* gate compares against — so in every section
   * that actually wanted more hats, and therefore said `hats: 'force'`, it was
   * multiplying a value nothing then read. The drop was declared at 2.2 and came
   * out sparser than the build.
   */
  hatEvery?: number;

  /**
   * Play the *remembered* cells instead of the varying ones.
   *
   * This is the whole mechanism behind a chorus, and it is the exact opposite of
   * what the arranger does everywhere else. `pick()` takes an `avoid` argument
   * and every variation is told to move *off* what is currently playing — which
   * is the right fix for a track that stopped developing, and precisely why
   * nothing was ever memorable. A hook is a thing that comes back.
   */
  hook: boolean;

  /** Where in the section the lead stops, overriding `phrase.restFrom`. */
  restFrom?: number;
}

// --------------------------------------------------------------------- mix

export interface MixTuning {
  /**
   * The song, as a list of sections, cycled.
   *
   * A single 16-bar section is the behaviour this replaced: one phrase, repeating
   * forever, with cells reselected on a timer. That is still a legal form and it
   * is what `current` declares.
   */
  form: readonly Section[];

  /** The ask a remembered hook is selected at. Fixed, so the hook never drifts. */
  hookIntensity: number;

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

    /**
     * How loud the Engine's parts are against the written song.
     *
     * The parts layer fires an order of magnitude more notes than the melody —
     * measured over 36 bars, 2,133 part notes against 768 of motif in one Score
     * — so at equal level it is not an accompaniment, it *is* the song, and the
     * written music plays underneath where nobody can hear it. That is what
     * buried a choir under an organ, and what made two songs with completely
     * different melodies sound like the same song.
     *
     * 1 is the historical behaviour, and what `current` keeps.
     */
    part: number;
  };

  /** What each layer has to earn before it is heard. */
  entry: {
    /**
     * How much has to be happening before the Engine's own layer is heard.
     *
     * The other six thresholds existed; this one did not, because `parts` was
     * gated on the literal `true`. That made the densest layer in the mix the one
     * layer that could not build — it arrived at full strength on bar one whether
     * you had fired a shot or not.
     *
     * A **negative** value means no threshold at all, which is the historical
     * behaviour: `intensity` is 0..1, so `i > -1` is always true.
     */
    parts: number;
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
  /**
   * `highpass` is the corner of a filter on the *send*, not the return.
   *
   * A reverb fed low frequencies smears them: the tail of a bass note arrives
   * under the next one and the low end stops having edges. In a Score with a
   * sustained pad and a five-second room it reads as reverb on the bass even
   * though the bass is never sent — the pad's own fundamentals do it.
   *
   * 0 means no filter and no node in the graph at all, which is what every
   * Score did before this existed.
   */
  reverb: { send: number; seconds: number; damp: number; predelay: number; highpass: number };
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
  /**
   * Partial: a Score is only obliged to tune the kicks it actually selects, and
   * some variants (the industrial `crush`) carry their own design in `voices.ts`
   * the way the event voices always have.
   */
  spec: Readonly<
    Partial<
      Record<
        KickVoice,
        { from: number; to: number; drop: number; decay: number; click: number; clickHz: number }
      >
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

/** The Engine a Score auditions with. See `Score.demo`. */
export interface DemoEngine {
  axiomId: string;
  rows: { triggerId: string; primitive: string; hue: Hue; modifiers: string[] }[];
  /** Where in its own variation space to start, so no two open on the same pass. */
  from: number;
}

export interface Score {
  id: string;
  /** Shown in the Lab and when `?score=` names something that does not exist. */
  name: string;
  /** One line, for the list on the desk. What it is, not how it works. */
  blurb: string;
  /**
   * Whether this appears in the MUSIC window.
   *
   * The registry holds everything the build can play, which by now includes a
   * transcription and nine abandoned experiments. A player is not a changelog:
   * the list shows the songs, and everything else stays reachable by `?score=`
   * for comparison without cluttering the thing somebody actually uses.
   */
  listed?: boolean;
  cells: CellLibrary;
  tonality: Tonality;
  feel: FeelTuning;
  mix: MixTuning;
  graph: GraphTuning;
  voices: VoiceTuning;
  /**
   * The Engine the Music window plays this Score with.
   *
   * Every Score auditioned with the *same* four Programs and always from
   * variation zero, so clicking down the list compared nine parameter sets
   * arranging one piece of material from one starting point. The differences
   * were real and almost entirely inaudible in the first minute, which is all
   * anybody listens for.
   *
   * A Score picks its own build instead. Row count moves the mood and the
   * density, the Triggers move every part rhythm, the primitives move the
   * instruments, the hues move the kit — so two Scores now differ in what they
   * are *playing*, not only in how it is treated.
   */
  demo: DemoEngine;
}

// ---------------------------------------------------------------- registry

/**
 * Every Score this build can play.
 *
 * Mutable rather than frozen because saved documents join it at boot — see
 * `scorestore.ts`. The authored ones are written here; anything a player saved
 * is layered on top by `registerScores` before the first lookup.
 */
export const SCORES: Record<string, Score> = {
  lattice,
  furnace,
  basin,
  marrow,
  current,
  anthem,
  deep,
  vault,
  spire,
  rust,
  pulse,
  choir,
  industrial,
};

/**
 * Add Scores built from saved documents.
 *
 * Refuses to overwrite an authored Score. A saved document that shadowed
 * `current` would break the one guarantee this whole system rests on — that
 * `?score=` with nothing set plays the transcription — and it would do it
 * invisibly, from a blob in local storage.
 */
export function registerScores(scores: readonly Score[]): void {
  for (const score of scores) {
    if (AUTHORED.has(score.id)) {
      console.warn(`[audio] saved score "${score.id}" ignored — that name is built in`);
      continue;
    }
    SCORES[score.id] = score;
  }
}

const AUTHORED = new Set(Object.keys(SCORES));

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
