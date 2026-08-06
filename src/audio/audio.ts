/**
 * The audio engine. GDD §18.
 *
 * The first version made every event a note. That works while events are rare
 * and collapses when they are not: at 600 EPS it is ten notes every sixteenth,
 * which stops being rhythm and becomes a wall. It also moved the tempo
 * continuously with EPS, which is the one thing a groove cannot survive — your
 * body locks to a pulse, and moving the pulse breaks the lock.
 *
 * So the model is now the one real dance music uses:
 *
 *   **Tempo is nearly fixed. The arrangement carries the intensity.**
 *
 * and events do two different jobs depending on how many of them there are:
 *
 *   - **Sparse** — each one is a note, and you hear yourself playing.
 *   - **Dense** — they stop being notes and become the arrangement: which
 *     layers are in, how open the filter is, how hard the bass drives.
 *
 * When your engine is small you hear yourself. When it is huge you hear the
 * machine you built. The handover is the reward, and it is closer to §18.1's
 * "the soundtrack *is* the engine" than a note per event ever was — Rez arranges
 * at least as much as it quantizes.
 *
 * The sim never learns this file exists. Cues are drained one-way, exactly like
 * visualDeaths, and `audio.test.ts` enforces the import direction.
 */
import type { AudioCue } from '../sim/world';
import type { Hue } from '../sim/types';
import { Clock } from './clock';
import {
  bass,
  breach,
  gate,
  gatedChord,
  hat,
  hurt,
  kick,
  meltdown,
  motif,
  perc,
  playHue,
  playPart,
  semiHz,
  siegeDrone,
  siegeHit,
  siegeScream,
  stab,
  sub,
  summons,
  ui as uiVoice,
  dialup as dialupVoice,
  type UiSound,
  type VoiceCtx,
} from './voices';
import {
  parseMelodic,
  parsePerc,
  type MelodicStep,
  type PercStep,
} from './cells';
import { arrange, openingArrangement, type ArrangeInput, type Arrangement } from './arrange';
import type { Part } from './parts';

/** Chord tones as semitones from the chord root. */
const CHORD_TONES: Record<string, number[]> = {
  min: [0, 3, 7],
  maj: [0, 4, 7],
  sus: [0, 5, 7],
  min7: [0, 3, 7, 10],
};

/**
 * §18.4 — polyphony cap. Three, not ten: the point of an accent is that it is
 * rarer than the thing it accents.
 */
const MAX_ACCENTS_PER_STEP = 3;

/**
 * Your fullest gauge used to transpose the key. That was a mistake: it modulated
 * the track mid-phrase with no cadence, which is indistinguishable from the
 * chords being random. The hue is still a readout, but of *timbre* — how bright
 * the filter sits — which colours the track without moving it.
 */
const HUE_COLOUR: Record<Hue, number> = { thermal: 1, voltaic: 1.45, void: 0.7 };

/** §18 — techno moves in 16-bar phrases. Everything automated rides this. */
const PHRASE_BARS = 16;

/**
 * §21b.7 — what the siege screams, as a line rather than a note.
 *
 * The first version played one pitch on alternate bars and the report was that
 * it got annoying, which is exactly right: the ear files an unchanging shape as
 * furniture after about three repeats, however ugly the timbre is, and after
 * that it is only irritating. Something that keeps *moving* stays a threat.
 *
 * Degrees are semitones over the drone's root, from the Phrygian set — root, ♭2,
 * ♭3, 4, 5, ♭6, ♭7. Every interval in it is minor or flat, so the line can
 * wander without ever landing anywhere consoling, and the ♭2 against the drone
 * is the same semitone rub the Meltdown and breach voices are built on.
 *
 * Lengths and directions vary per entry, and the walk is ten long against a hold
 * that fires it maybe eight times, so it does not come back round inside one
 * gate. `up` is not a strict alternation, because that is itself a pattern.
 */
const SIEGE_CRIES: readonly { deg: number; len: number; up: boolean }[] = [
  { deg: 0, len: 3.4, up: true },
  { deg: 8, len: 2.0, up: false },
  { deg: 1, len: 4.2, up: true },
  { deg: 5, len: 1.6, up: true },
  { deg: 3, len: 2.8, up: false },
  { deg: 10, len: 1.4, up: false },
  { deg: 1, len: 5.0, up: true },
  { deg: 7, len: 2.2, up: false },
  { deg: 3, len: 3.0, up: true },
  { deg: 0, len: 6.0, up: false },
];
/**
 * How many bars before the melodic material is reselected. Two phrases at 112
 * BPM is a little over a minute — long enough that the line is a hook rather
 * than a tour of the library, short enough that nobody sits through the same
 * two motifs for eleven minutes, which is exactly what one recorded run did.
 */
const VARY_BARS = 32;

/**
 * **There is no saturation stage in this graph, and there must never be one.**
 *
 * §16.7's degradation ladder wants Overheat to sound like the engine coming
 * apart, and a waveshaper is the obvious way to do it. It is also a trap, and it
 * cost several rounds to learn why: a soft-clip curve has a small-signal slope
 * of `1 + k`, so at any useful drive it applies twenty-plus times gain to quiet
 * content. It does not merely "add grit" — it turns the game up, by a lot, at
 * the single most stressful moment in a run.
 *
 * A limiter cannot save it either. Limiters hold the *peak*; saturation raises
 * RMS while leaving the peak alone, and RMS is what the ear calls loudness. Two
 * different compensation schemes were tried and both were guesses that drifted
 * the moment anything else changed.
 *
 * So the whole path is gone. Overheat degrades *visually* — that ladder is
 * already built and costs nothing — and the audio says it by going wrong in
 * pitch and rhythm instead: the Overheat chord resolves down a fourth, and the
 * stall drops the music bus into a hole. Both are unmistakable and neither
 * touches the level.
 *
 * If a future change wants dirt here, the only acceptable form is one that
 * cannot raise RMS: a filter, a detune, a dropout, a bitcrush at fixed gain.
 * Never a gain stage wearing a distortion costume.
 */

export interface AudioState {
  /** 0..1 — how busy the engine is, from EPS. Drives the arrangement. */
  intensity: number;
  /** Fullest fuel gauge. Sets the key. */
  dominant: Hue;
  /** 0..1 Heat, for master-bus grit. */
  heat: number;
  stalled: boolean;
  /** §13.2 — Meltdown detunes, dirties, and finally moves the tempo. */
  meltdown: number;
  /** §21b.7 — 0, or how full the gate bar the player is holding is. */
  siege: number;
}

/**
 * A selected arrangement, parsed once.
 *
 * Cells are strings so a human can read and edit them; the sequencer needs
 * arrays. Parsing happens when an arrangement is adopted — once every sixteen
 * bars at worst — rather than on every one of the sixteen steps in every bar.
 */
interface CompiledCells {
  kick: (PercStep | null)[];
  backbeat: (PercStep | null)[];
  hats: (PercStep | null)[];
  stab: (PercStep | null)[];
  bass: (MelodicStep | null)[];
  motif: (MelodicStep | null)[];
}

function compile(plan: Arrangement): CompiledCells {
  return {
    kick: parsePerc(plan.kick.pattern),
    backbeat: parsePerc(plan.backbeat.pattern),
    hats: parsePerc(plan.hats.pattern),
    stab: parsePerc(plan.stab.pattern),
    bass: parseMelodic(plan.bass),
    motif: parseMelodic(plan.motif),
  };
}

/**
 * Read a cell at the global step count rather than the bar index.
 *
 * A 32-step cell is two bars of material, and indexing it by position-in-bar
 * would play only its first half forever. This is what lets a motif be a line
 * rather than a cell that repeats.
 */
function step<T>(cell: (T | null)[], count: number): T | null {
  return cell[count % cell.length] ?? null;
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

/** Which absolute semitone a melodic step lands on, over the current chord. */
function tone(tones: number[], s: MelodicStep): number {
  return tones[s.tone % tones.length]! + s.octave * 12;
}

export class Audio {
  private ctx: AudioContext | null = null;
  private clock: Clock | null = null;
  private master!: GainNode;
  /** Everything the arrangement plays. Under the Music slider. */
  private musicGroup!: GainNode;
  /** Everything the Engine and the chrome play. Under the Effects slider. */
  private sfxGroup!: GainNode;
  private uiBus!: GainNode;
  /** The Effects slider, applied post-limiter for chrome. Mirrors `sfxGroup`. */
  private uiLevel!: GainNode;
  private musicVolume = 1;
  private sfxVolume = 1;
  /** Kick and accents. Never ducked — the kick is what everything ducks under. */
  private punchBus!: GainNode;
  /** Bass, pad, hats. Ducked on every kick. */
  private musicBus!: GainNode;
  /**
   * §21b.7 — the siege score's own bus.
   *
   * Separate from `musicBus` because the two cross-fade: while a gate is held
   * the run's arrangement goes away entirely and this takes the room. Routed to
   * musicGroup rather than through musicFilter, since the phrase filter is part
   * of the arrangement's shape and the siege is not participating in that.
   */
  private siegeBus!: GainNode;
  /**
   * The run's whole arrangement, on one fader, so the siege can take it away.
   *
   * It has to be its own node. The first version scaled `musicBus.gain`
   * directly and the fade did not happen: `duck()` calls
   * `cancelScheduledValues` on that param every kick and ramps it back to full,
   * so the sidechain and the crossfade were writing the same AudioParam and the
   * sidechain won four times a bar. Two things that both want to control a
   * level need two nodes.
   */
  private scoreTrim!: GainNode;
  /**
   * §21b.7 — the drone, on its own node, so the kick can duck it.
   *
   * This is the whole reason the beat pounds instead of merely being loud. The
   * drone saturates the low band by design, which is the same band the kick
   * lives in — turning the kick up just adds to a wall that is already there.
   * Ducking the drone for a fifth of a beat under each hit carves a hole for it
   * instead, and the hole is what the ear hears as impact. Standard sidechain,
   * and the one technique this genre is actually built on.
   */
  private siegeDroneBus!: GainNode;
  /**
   * §21b.7 — the siege's treatment of the Engine's own sounds.
   *
   * Every shot, kill and pickup keeps firing during a hold: they are the
   * player's feedback and muting them would be a lie about what their build is
   * doing. But they belong to the run's soundtrack, and during a siege the run's
   * soundtrack is gone — unprocessed they sit on top of the drone sounding like
   * a different game leaking in.
   *
   * So they get bent rather than removed. A resonant bandpass throws away the
   * top and the bottom, and a ring modulator tears what is left. Same reason the
   * drone uses one: the graph has no saturation stage and is not getting one,
   * and ring modulation is harsher than a waveshaper anyway. Crossfaded, so
   * nothing changes outside a hold.
   */
  private fxDry!: GainNode;
  private fxWet!: GainNode;
  private engineBus!: GainNode;
  /**
   * The guarantee. GDD §18.4.
   *
   * Every previous attempt at "the music must not get louder" was a
   * *correction*: a trim here, a smaller gain there, each one a guess about how
   * much loudness some change had added. Guesses do not compose. Add a layer,
   * add a voice, add an occasion chord, and the guesses are wrong again — which
   * is exactly what kept happening.
   *
   * A compressor is not a correction, it is a control loop. Threshold well below
   * the working level and a high ratio means the output level is set by the
   * compressor rather than by how many things happen to be playing: forty voices
   * and four voices arrive at the same loudness, because that is the one job
   * this device has. Nothing downstream of it can make the game louder, no
   * matter what anyone adds later.
   */
  private limiter!: DynamicsCompressorNode;
  private limiterDrive!: GainNode;
  private limiterTrim!: GainNode;
  private lowShelf!: BiquadFilterNode;
  /** §8 — the intrusion's grip on the track. Nothing else touches these two. */
  private interfereGain!: GainNode;
  private interfereFilter!: BiquadFilterNode;
  /** Automated across each 16-bar phrase - the genre's build and release. */
  private musicFilter!: BiquadFilterNode;
  /**
   * The dub delay. A feedback loop with a lowpass inside it, so each repeat
   * arrives darker than the last and the tail dissolves rather than stopping.
   * This is the entire personality of dub techno, and the reason the Feedback
   * Axiom's track sounds like a different genre rather than a preset.
   */
  private delay!: DelayNode;
  private delayFeedback!: GainNode;
  private echoSend!: GainNode;
  /**
   * Intensity used to raise gains, which is the wrong instrument entirely — a
   * track that gets *louder* as the game gets busier is uncomfortable and, at
   * the top, just clipping. Aggression is the thing that should climb, so it
   * climbs here: saturation on the music bus, plus a headroom trim that offsets
   * the extra voices a busy arrangement adds. Same loudness, more teeth.
   */


  private state: AudioState = {
    intensity: 0,
    dominant: 'thermal',
    heat: 0,
    stalled: false,
    meltdown: 0,
    siege: 0,
  };

  private pending: AudioCue[] = [];
  /** Occasions jump the queue — a chord is never dropped for a kill note. */
  private occasions: AudioCue[] = [];
  private muted = false;
  private volume = 0.7;
  /**
   * What is playing. Selected by `arrange` from the Engine, never authored.
   *
   * `pending` holds a newly selected arrangement until the next 16-bar boundary.
   * A build changes the moment you take a Draft, and swapping the bassline
   * mid-phrase reads as a glitch rather than as a response — which is also just
   * how anyone mixing two records does it.
   */
  private plan: Arrangement = openingArrangement('ignition');
  private pendingPlan: Arrangement | null = null;
  /** Set by `beginRun`; makes the next `setEngine` skip the phrase boundary. */
  private freshRun = true;
  /** §18.1 — which pass through the material the soundtrack is on. */
  private variation = 0;
  private lastVaryBar = 0;
  /** The last Engine handed over, so the variation timer can re-arrange it. */
  private lastInput: ArrangeInput | null = null;
  private cells = compile(openingArrangement('ignition'));
  /** Bars elapsed, for walking the progression. */
  private bar = 0;
  private silenced = false;
  /** The chord currently sounding. Accents snap to it. */
  private tones: number[] = [0, 3, 7];
  /** Previous note, for 303 glide. 0 means "no slide into this one". */
  private lastBassHz = 0;
  private lastLeadHz = 0;
  private lastHover = 0;
  /** Steps still owed to a big event. See `bigEvent`. */
  private claim = 0;
  /** Context time of the last accent, so a sixteenth can only hold one. */
  private lastBigEvent = -1;
  /**
   * §18.1 — one part per live Program. This is the arrangement, and it is
   * literally the player's Engine. See parts.ts.
   */
  private parts: (Part | null)[] = [];
  private lastPartHz: number[] = [];
  /** Smoothed, so the arrangement never flickers between layers frame to frame. */
  private smoothed = 0;
  /**
   * How far the siege score has taken over, smoothed.
   *
   * Smoothed rather than switched for the obvious reason and one less obvious
   * one: `siege` is a hold bar that drains, so it flickers around zero every
   * time the player steps a pixel outside the ring, and a hard gate on it would
   * chop the whole soundtrack in and out.
   */
  private siegeMix = 0;
  /** Where in SIEGE_CRIES the line has got to. */
  private siegeCry = 0;
  /** §13.2 — so the arrangement is rebuilt once when the phase turns. */
  private wasMeltdown = false;
  /** A pending plan that may land on the next bar instead of the next phrase. */
  private pendingUrgent = false;

  get enabled(): boolean {
    return this.ctx !== null && !this.muted;
  }

  /**
   * Must be called from a user gesture — browsers refuse to start an
   * AudioContext otherwise, and a silent game with no error is a miserable bug
   * to chase. The menu's START RUN is that gesture.
   */
  start(): void {
    if (this.ctx) {
      // Already built, but not necessarily running. A context created before a
      // gesture starts suspended, and browsers also suspend on tab blur — both
      // of which leave a graph that is wired correctly and completely silent.
      // Returning early here was half of "there's no sound in the menu".
      if (this.ctx.state !== 'running') void this.ctx.resume();
      return;
    }
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;

    const ctx = new Ctor();
    this.ctx = ctx;

    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : this.volume;

    // A low shelf before the shaper: the saturation then has something to bite
    // on down where the kick and bass live, which is where "oomph" comes from.
    this.lowShelf = ctx.createBiquadFilter();
    this.lowShelf.type = 'lowshelf';
    this.lowShelf.frequency.value = 110;
    this.lowShelf.gain.value = 5;

    // Deliberately aggressive. This is a leveller, not a mastering compressor —
    // musical transparency is worth nothing next to the promise that the volume
    // never rises.
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -34;
    this.limiter.knee.value = 4;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.003;
    this.limiter.release.value = 0.12;

    // Driven into the limiter rather than merely caught by it, then brought
    // straight back down.
    //
    // A threshold the quiet passages never reach only levels the loud ones,
    // which leaves the loud ones louder — measured at 2.5x. Pushing everything
    // above the threshold means the compressor is always working, so quiet and
    // loud both leave at the level *it* decides rather than at the level the
    // arrangement happened to produce.
    //
    // The trim after it is not optional and not a guess: driving 12x without
    // taking 12x back out is simply turning the game up, which is the exact
    // failure this whole graph exists to prevent. The pair has to be read
    // together — drive in, trim out, limiter deciding what happens between.
    this.limiterDrive = ctx.createGain();
    this.limiterDrive.gain.value = 12;
    this.limiterTrim = ctx.createGain();
    // Calibrated by measurement, not by arithmetic: with the limiter working
    // this hard the drive is not what sets the output, so `1/drive` is the
    // wrong number and produced a game nobody could hear.
    this.limiterTrim.gain.value = 0.75;

    // Order matters. The drive sits *after* the shaper — feeding 12x into a
    // waveshaper clips against the ends of its curve, which is hard distortion
    // rather than the soft saturation the curve exists to provide.
    this.lowShelf
      .connect(this.limiterDrive)
      .connect(this.limiter)
      .connect(this.limiterTrim)
      .connect(this.master)
      .connect(ctx.destination);

    // Two groups under the master, because "the music is too loud" and "the
    // shots are too loud" are different complaints with different fixes, and a
    // single slider can only answer one of them.
    //
    // They sit *above* the limiter, not below it: the limiter's whole job is
    // that nothing downstream can raise the level, and a group gain that could
    // push into it would be a volume control that makes things louder by making
    // them quieter somewhere else. These only ever attenuate.
    // §8 — the intrusion's own pair, between the music and the master, written
    // by nothing but `interfere()`.
    //
    // The first attempt ducked `scoreTrim` and closed `musicFilter`, and neither
    // survived: the sequencer rewrites the filter corner every sixteenth
    // (`voiceSixteenth`) and the siege mix rewrites the trim every frame, so a
    // ramp on either was gone inside a beat. A parameter with a per-frame driver
    // is not a parameter you can hold, and the answer is a node that has no
    // driver rather than a fight over one that does.
    this.interfereGain = ctx.createGain();
    this.interfereGain.gain.value = 1;
    this.interfereGain.connect(this.lowShelf);

    this.interfereFilter = ctx.createBiquadFilter();
    this.interfereFilter.type = 'lowpass';
    this.interfereFilter.frequency.value = 20000;
    this.interfereFilter.Q.value = 0.7;
    this.interfereFilter.connect(this.interfereGain);

    this.musicGroup = ctx.createGain();
    this.musicGroup.gain.value = this.musicVolume;
    this.musicGroup.connect(this.interfereFilter);

    this.sfxGroup = ctx.createGain();
    this.sfxGroup.gain.value = this.sfxVolume;
    this.sfxGroup.connect(this.lowShelf);

    // The Effects slider still has to reach chrome, and chrome no longer passes
    // through `sfxGroup`, so the level is mirrored here instead.
    this.uiLevel = ctx.createGain();
    this.uiLevel.gain.value = this.sfxVolume;
    this.uiLevel.connect(this.master);

    // Everything the run's arrangement makes goes through here, and nothing the
    // siege makes does.
    this.scoreTrim = ctx.createGain();
    this.scoreTrim.gain.value = 1;
    this.scoreTrim.connect(this.musicGroup);

    this.punchBus = ctx.createGain();
    this.punchBus.gain.value = 0.95;
    this.punchBus.connect(this.scoreTrim);

    // Chrome sits *after* the limiter, and it is the only thing that does.
    //
    // A click that vanishes because the music is loud is a click that did not
    // register, and with the limiter driven 12x into a -34dB threshold it is
    // always working — so a busy passage was ducking the interface along with
    // everything else. That is the whole failure mode a shared bus has, and no
    // amount of raising the click fixes it, because raising it raises what the
    // limiter is reacting to as well.
    //
    // This does not weaken §18.4's guarantee, and the reason is specific: the
    // rule exists because *accumulation* raises RMS, and forty simultaneous
    // voices are what accumulate. Chrome is one-shot, fixed-gain, throttled to
    // one hover every 45ms, and never more than a couple at once. It has no
    // mechanism to get louder. Nothing else may follow it here.
    this.uiBus = ctx.createGain();
    this.uiBus.gain.value = 0.5;
    this.uiBus.connect(this.uiLevel);

    this.musicFilter = ctx.createBiquadFilter();
    this.musicFilter.type = 'lowpass';
    this.musicFilter.frequency.value = 2200;
    this.musicFilter.Q.value = 1.1;
    this.musicFilter.connect(this.scoreTrim);

    this.musicBus = ctx.createGain();
    this.musicBus.gain.value = 0.9;
    this.musicBus.connect(this.musicFilter);

    this.siegeBus = ctx.createGain();
    this.siegeBus.gain.value = 0;
    this.siegeBus.connect(this.musicGroup);

    this.siegeDroneBus = ctx.createGain();
    this.siegeDroneBus.gain.value = 1;
    this.siegeDroneBus.connect(this.siegeBus);

    // Dotted eighth is the classic dub delay: it lands between the beats rather
    // than on them, so the echoes read as counter-rhythm instead of as a
    // stutter. Set properly once the tempo is known.
    this.delay = ctx.createDelay(2);
    this.delay.delayTime.value = (60 / 112) * 0.75;
    this.delayFeedback = ctx.createGain();
    this.delayFeedback.gain.value = 0.52;
    const delayDamp = ctx.createBiquadFilter();
    delayDamp.type = 'lowpass';
    delayDamp.frequency.value = 1700;

    this.delay.connect(delayDamp).connect(this.delayFeedback).connect(this.delay);
    this.delay.connect(this.musicFilter);

    this.echoSend = ctx.createGain();
    this.echoSend.gain.value = 0;
    this.echoSend.connect(this.delay);

    this.engineBus = ctx.createGain();
    this.engineBus.gain.value = 0.5;

    // Two paths out of the engine bus, summed. Dry is what the game has always
    // sounded like; wet is what it sounds like from inside a siege.
    this.fxDry = ctx.createGain();
    this.fxDry.gain.value = 1;
    this.engineBus.connect(this.fxDry).connect(this.sfxGroup);

    const fxBand = ctx.createBiquadFilter();
    fxBand.type = 'bandpass';
    // Narrow and high. Everything below about 700Hz and above 3kHz goes, which
    // takes the body out of a shot and leaves the part that sounds broken.
    fxBand.frequency.value = 1500;
    fxBand.Q.value = 2.4;

    // Ring modulation at 180Hz — low enough that the sidebands land inside the
    // band the filter kept, so it reads as the sound being torn rather than as a
    // second tone playing underneath it.
    const fxRing = ctx.createGain();
    fxRing.gain.value = 0;
    const fxMod = ctx.createOscillator();
    fxMod.type = 'square';
    fxMod.frequency.value = 180;
    const fxModDepth = ctx.createGain();
    fxModDepth.gain.value = 1;
    fxMod.connect(fxModDepth).connect(fxRing.gain);
    fxMod.start();

    this.fxWet = ctx.createGain();
    this.fxWet.gain.value = 0;
    this.engineBus.connect(fxBand).connect(fxRing).connect(this.fxWet).connect(this.sfxGroup);

    this.clock = new Clock(ctx);
    this.clock.onStep((step) => this.onStep(step.time, step.index, step.count));
    this.clock.start();
    void ctx.resume();
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.applyMaster();
  }

  setVolume(v: number): void {
    this.volume = clamp01(v);
    this.applyMaster();
  }

  setMusicVolume(v: number): void {
    this.musicVolume = clamp01(v);
    if (this.musicGroup) this.musicGroup.gain.value = this.musicVolume;
  }

  setSfxVolume(v: number): void {
    this.sfxVolume = clamp01(v);
    if (this.sfxGroup) this.sfxGroup.gain.value = this.sfxVolume;
    if (this.uiLevel) this.uiLevel.gain.value = this.sfxVolume;
  }

  /**
   * The volume never goes up. Ever.
   *
   * Saturation raises RMS even though it leaves the peak alone, so driving the
   * master bus during Overheat made the game *louder* exactly when it was
   * already at its most stressful — the one moment where louder is unbearable
   * rather than exciting. Every drive stage now pays for itself with makeup
   * gain in the opposite direction, so the mix gets dirtier and stays level.
   */
  private applyMaster(): void {
    if (!this.ctx) return;
    // No drive compensation here any more: the limiter upstream already holds
    // the level, and stacking a guess on top of a control loop is how the
    // volume ended up moving in the first place.
    this.master.gain.setTargetAtTime(
      this.muted ? 0 : this.volume,
      this.ctx.currentTime,
      0.05,
    );
  }

  /** What the arrangement currently is, for the Music screen. */
  get arrangement(): Arrangement {
    return this.plan;
  }

  /** True while the arrangement is running — the Music pane shows a ▶ for it. */
  get playing(): boolean {
    return this.clock !== null && !this.silenced;
  }

  /**
   * Where we are in the bar, right now. GDD §18.2 read backwards.
   *
   * Everything in this game already waits for the grid; the picture was the one
   * thing that did not know the grid existed. So when a Nova landed on a
   * downbeat it was luck, and it read as a moment rather than as the game.
   *
   * `beat` counts sixteenths as a float — 4.5 is halfway between the fifth and
   * sixth step of the bar — and `pulse` is 1 on the quarter falling to 0 by the
   * next one. Read by the renderer, written by nobody: this is a clock you look
   * at, not one you set. It is deliberately derived from `ctx.currentTime`
   * rather than from the frame, because the *audio* clock is the one the player
   * is hearing and a frame-derived copy would drift against it within seconds.
   */
  get beat(): { beat: number; pulse: number; bpm: number } | null {
    if (!this.ctx || !this.clock || this.silenced) return null;
    const step = this.clock.stepDuration;
    // `nextStepTime` is up to a lookahead window ahead of the sound you are
    // hearing, so this measures against the context clock directly.
    const sixteenths = this.ctx.currentTime / step;
    const inBar = ((sixteenths % 16) + 16) % 16;
    const sinceQuarter = inBar % 4;
    return {
      beat: inBar,
      // Sharp attack, quick decay — a pulse that lingered would smear the four
      // quarters into one wobble.
      pulse: Math.pow(1 - sinceQuarter / 4, 2.6),
      bpm: this.clock.bpm,
    };
  }

  /**
   * Stop the arrangement without tearing down the context.
   *
   * Closing an AudioContext is one-way in some browsers and re-creating one
   * needs another user gesture, so "stop" mutes the busses and parks the clock
   * instead. The run can start the music again with no gesture at all.
   */
  silence(): void {
    if (!this.ctx) return;
    this.silenced = true;
    this.clock?.stop();
    for (const bus of [this.punchBus, this.musicBus, this.engineBus]) {
      bus.gain.cancelScheduledValues(this.ctx.currentTime);
      bus.gain.value = 0;
    }
  }

  private resumeBusses(): void {
    if (!this.ctx || !this.silenced) return;
    this.silenced = false;
    this.punchBus.gain.value = 0.95;
    this.musicBus.gain.value = 0.9;
    this.engineBus.gain.value = 0.5;
    this.clock?.start();
  }

  /**
   * Hand over the Engine. Selection is cheap and deterministic, so this can be
   * called whenever the build changes without any bookkeeping about whether it
   * really did.
   */
  setEngine(input: ArrangeInput): void {
    // Remembered so the variation timer can re-arrange the same Engine without
    // the caller having to hand it over again.
    this.lastInput = input;
    const next = arrange({
      ...input,
      variation: this.variation,
      // §13.2 — the phase is not the caller's business to remember. The audio
      // layer already has it every frame, so it merges it in here.
      meltdown: this.state.meltdown,
      // What is playing right now, so a variation pass moves off it rather than
      // reselecting the same cell and calling it a change.
      avoid: {
        motif: this.plan.motif.id,
        bass: this.plan.bass.id,
        stab: this.plan.stab.id,
        hats: this.plan.hats.id,
      },
    });
    if (next.signature === this.plan.signature && next.harmony.id === this.plan.harmony.id) return;
    // The first arrangement of a run lands immediately; every later one waits
    // for a phrase boundary. The bar counter cannot stand in for "first" — it
    // runs off a step count that never resets, so the second run of a session
    // would open on the previous run's bed for up to half a minute.
    if (this.freshRun) this.adopt(next);
    else this.pendingPlan = next;
    this.freshRun = false;
  }

  /**
   * §18.1 — move the line on, on a timer.
   *
   * Called once a bar. Every `VARY_BARS` it bumps the variation counter and asks
   * for a fresh arrangement of the *same* Engine: new motif, new bassline, new
   * stab, new chord sequence within the same mood — same kit, same key, same
   * groove. That is how the genre stays hypnotic without becoming a loop you can
   * hear the seams of, and it is the fix for a run whose music stopped
   * developing three minutes before it ended.
   */
  private maybeVary(): void {
    if (!this.lastInput) return;
    if (this.bar === this.lastVaryBar) return;
    if (this.bar - this.lastVaryBar < VARY_BARS) return;
    this.lastVaryBar = this.bar;
    this.variation++;
    this.setEngine(this.lastInput);
  }

  /**
   * A new run is starting.
   *
   * Two jobs. It tells the arranger to stop waiting for a phrase boundary — the
   * music itself keeps running, because cutting it dead between the menu and the
   * arena is worse than one abrupt change of bed.
   *
   * And it undoes `silence()`, which nothing else did. STOP on the Music screen
   * zeroes the punch, music and engine busses, and only `preview` and
   * `auditArrangement` ever put them back — so pressing STOP and then starting a
   * run gave you a completely silent run, music *and* engine, until you happened
   * to wander back into the Music screen and play something. That is exactly the
   * "it stopped, then weirdly came back" this was reported as.
   */
  beginRun(): void {
    this.freshRun = true;
    this.resumeBusses();
  }

  private adopt(plan: Arrangement): void {
    this.plan = plan;
    this.cells = compile(plan);
    this.pendingPlan = null;
  }

  /**
   * Hand over the Engine as an arrangement.
   *
   * Called when the build changes rather than every frame: a part is a *pattern*,
   * and a pattern that changes sixty times a second is not a pattern. This is
   * the whole reason the music is hypnotic while the play on top of it is not.
   */
  setParts(parts: (Part | null)[]): void {
    this.parts = parts;
    this.lastPartHz = parts.map(() => 0);
  }

  /**
   * Menu preview: run an Engine's arrangement with no game behind it, at a fixed
   * intensity high enough to hear every layer it has earned.
   */
  preview(input: ArrangeInput, parts: (Part | null)[] = [], intensity = 0.72): void {
    this.start();
    this.resumeBusses();
    this.adopt(arrange({ ...input, intensity }));
    this.setParts(parts);
    this.bar = 0;
    this.smoothed = intensity;
    this.state = {
      intensity,
      dominant: 'thermal',
      heat: 0,
      stalled: false,
      siege: 0,
      meltdown: 0,
    };
    if (this.clock) this.clock.bpm = 112;
  }

  /**
   * Play an arrangement that was handed over rather than selected.
   *
   * Only the Music screen uses this. It exists because an editor has to put a
   * cell somewhere the arranger would never have chosen it — that is the entire
   * point of an editor — and because a dial you turn has to be audible *now*
   * rather than at the next sixteen-bar boundary. Nothing in a run reaches this.
   */
  auditArrangement(plan: Arrangement, parts: (Part | null)[] = [], intensity = 0.72): void {
    this.start();
    this.resumeBusses();
    this.adopt(plan);
    this.setParts(parts);
    this.smoothed = intensity;
    this.state = { intensity, dominant: 'thermal', heat: 0, stalled: false, meltdown: 0, siege: 0 };
    if (this.clock) this.clock.bpm = 112;
  }

  /**
   * The chord under the current bar, as absolute semitones.
   *
   * Held for `barsPerChord`, so a two-chord track turns over every eight or
   * sixteen bars. That slowness is the point — a change nobody waited for is not
   * a change anybody notices.
   */
  private chordTones(): number[] {
    const harmony = this.plan.harmony;
    const index = Math.floor(this.bar / harmony.barsPerChord) % harmony.chords.length;
    const c = harmony.chords[index]!;
    const base = this.plan.key + c.root;
    return (CHORD_TONES[c.quality] ?? CHORD_TONES.min!).map((t) => base + t);
  }

  /** 0..1 across a 16-bar phrase. The genre's actual sense of going somewhere. */
  private get phrase(): number {
    return (this.bar % PHRASE_BARS) / PHRASE_BARS;
  }

  /** Called each frame with the run's mood and the cues it produced. */
  update(state: AudioState, cues: AudioCue[]): void {
    this.state = state;
    if (!this.ctx || !this.clock) return;
    // A run always un-silences: STOP PREVIEW is a menu control, not a mute.
    this.resumeBusses();

    // Intensity is smoothed hard. A cascade spikes EPS for half a second, and an
    // arrangement that adds and drops a layer inside half a second sounds broken
    // rather than responsive.
    this.smoothed += (state.intensity - this.smoothed) * 0.04;

    // §18.2 asked for 110 rising to 140. 140 is right for the *feeling* of
    // Meltdown and wrong as a continuous ramp: a groove needs a stable pulse,
    // and the earlier build moved it every frame. Tempo now sits at 112 and only
    // Meltdown — a once-per-run, permanent, announced event — shifts it.
    // §13.2 — act three gets its own material, once, on the edge.
    //
    // The arrangement is only rebuilt when the Engine changes, so without this
    // the harmony clamp would not land until the next Draft — which could be
    // minutes, or never. Guarded on the edge rather than the value: rebuilding
    // every frame would thrash the phrase-boundary handover.
    if (state.meltdown > 0 && !this.wasMeltdown) {
      this.wasMeltdown = true;
      if (this.lastInput) {
        this.setEngine(this.lastInput);
        // and it does not wait sixteen bars for a phrase boundary. That rule
        // exists so an arrangement change lands where the ear expects one, and
        // it is right for a Draft — but Meltdown is announced, once, with five
        // seconds of stinger over it, and half a minute later is not "the music
        // changed when the containment failed".
        this.pendingUrgent = true;
      }
    }

    this.clock.bpm = 112 + state.meltdown * 12;
    this.delay.delayTime.setTargetAtTime((60 / this.clock.bpm) * 0.75, this.ctx.currentTime, 0.2);
    this.echoSend.gain.setTargetAtTime(this.plan.echo, this.ctx.currentTime, 0.3);

    // §21b.7 — the handover, on two faders that belong to nobody else.
    const wanted = state.siege > 0.01 ? 1 : 0;
    this.siegeMix += (wanted - this.siegeMix) * 0.06;
    if (this.siegeMix < 0.002) this.siegeMix = 0;
    const now = this.ctx.currentTime;
    this.siegeBus.gain.setTargetAtTime(this.siegeMix, now, 0.25);
    // All the way out.
    //
    // This kept 12% of the run's arrangement underneath, on the theory that a
    // trace of it made the siege read as something happening *to* your music. In
    // practice the two are in unrelated keys over unrelated pulses, and the
    // residue was mud under the drone — and the drone is the point.
    this.scoreTrim.gain.setTargetAtTime(1 - this.siegeMix, now, 0.25);
    // The Engine's own sounds bend rather than vanish, and not all the way: a
    // little dry left in keeps a shot legible as *your shot*, which is the one
    // thing this must not take away.
    this.fxDry.gain.setTargetAtTime(1 - this.siegeMix * 0.72, now, 0.25);
    this.fxWet.gain.setTargetAtTime(this.siegeMix * 1.35, now, 0.25);

    // Busier means dirtier, not louder. Drive climbs with intensity while the
    // trim comes down to pay for the layers that intensity added.
    this.musicBus.gain.value = state.stalled ? 0.12 : 0.9;

    for (const cue of cues) {
      // Hurt is the exception to everything: unquantized, played the instant it
      // happens. Waiting up to 34ms for a grid boundary would make the one sound
      // that must feel like an interruption feel like part of the song.
      if (cue.kind === 'hurt') {
        hurt(this.voice(this.engineBus), this.ctx.currentTime, 0.9);
        continue;
      }
      // §21b.5 — the gate. Played the instant it is asked for and never
      // quantised: it is six seconds long and its own event, so snapping its
      // start to a sixteenth would only delay it, and nothing about it is
      // rhythmic enough for the grid to help.
      if (cue.kind === 'gate') {
        gate(this.voice(this.engineBus), this.ctx.currentTime, 6.4, 0.62);
        continue;
      }
      // §21b — a breach: the room past the gate noticing you. Unquantised for
      // the same reason as the other two, and short, because unlike Meltdown it
      // is not a state you are now in, it is a thing that just happened.
      if (cue.kind === 'breach') {
        breach(this.voice(this.engineBus), this.ctx.currentTime, 3.2, 0.66);
        continue;
      }
      // §12.3 / §12.4 — a wave the player asked for. The Cache's is a tier up:
      // same voice, affixes on everything, and it says so before they arrive.
      // §21b.7 — the gate refusing you. The heaviest thing in the game short of
      // Meltdown, because unlike everything else on this list it is not an
      // arrival, it is the next twenty-two seconds announcing themselves.
      if (cue.kind === 'siege') {
        summons(this.voice(this.engineBus), this.ctx.currentTime, 4.2, 0.78, true);
        continue;
      }
      if (cue.kind === 'summons' || cue.kind === 'hardened') {
        summons(
          this.voice(this.engineBus),
          this.ctx.currentTime,
          cue.kind === 'hardened' ? 3.4 : 2.6,
          cue.kind === 'hardened' ? 0.62 : 0.5,
          cue.kind === 'hardened',
        );
        continue;
      }
      // §13.2 — Meltdown, likewise. Five seconds and its own event.
      if (cue.kind === 'meltdown') {
        meltdown(this.voice(this.engineBus), this.ctx.currentTime, 5, 0.7);
        continue;
      }
      if (cue.kind === 'level' || cue.kind === 'overheat') {
        if (this.occasions.length < 4) this.occasions.push(cue);
        continue;
      }
      if (this.pending.length < 64) this.pending.push(cue);
    }
  }

  /**
   * §18.4 — the interface, audible.
   *
   * Played the instant it is asked for rather than on the next sixteenth: a
   * button that waited up to 34ms would feel broken, and immediacy is worth more
   * than grid alignment for anything the player's hand caused directly.
   *
   * Hovers are rate-limited. They fire hundreds of times a minute as a cursor
   * crosses a list, and without a floor the mix turns into a hiss.
   */
  chrome(sound: UiSound): void {
    if (this.muted) return;
    // Builds the context if this is the first thing the player has touched.
    // Chrome fires from clicks, which are exactly the gesture browsers want, and
    // the menu used to stay silent until something else happened to call start()
    // — so the first few hovers and clicks of a session made no sound at all,
    // which reads as the sounds being broken rather than as not yet existing.
    this.start();
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    if (sound === 'hover') {
      if (now - this.lastHover < 0.045) return;
      this.lastHover = now;
    }
    uiVoice(this.voice(this.uiBus), now, sound);
  }

  /**
   * §8 — the handshake at the top of an intrusion. Once, then it is gone.
   *
   * Held carriers were wrong: a modem negotiates and stops, and a drone under
   * six lines of dialogue is a hum the player stops hearing by the third line.
   * The screech is over inside the banner, which leaves the message itself in
   * something much more uncomfortable — the typing, and nothing else.
   */
  dialup(): void {
    this.start();
    if (!this.ctx) return;
    dialupVoice(this.voice(this.uiBus), this.ctx.currentTime);
  }

  /**
   * §8 — what the intrusion does to the track while it is up.
   *
   * GDD §18.4 bans silence everywhere, and this is the one surface allowed to
   * come close to it: the music does not stop, it is *taken away* — shut behind
   * a low corner and pulled down to almost nothing, so the room the player has
   * been sitting in audibly stops working. Restored on the way out, so the
   * absence reads as an event rather than as a setting.
   */
  interfere(on: boolean): void {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    const corner = on ? 200 : 20000;
    const level = on ? 0.06 : 1;
    // Fast in, slow out. The room stops working in a quarter of a second and
    // takes the best part of a second to come back, so it reads as something
    // being done to it rather than as a setting changing.
    const over = on ? 0.2 : 0.9;
    for (const [param, target] of [
      [this.interfereFilter.frequency, corner],
      [this.interfereGain.gain, level],
    ] as const) {
      param.cancelScheduledValues(now);
      param.setValueAtTime(Math.max(0.0002, param.value), now);
      param.exponentialRampToValueAtTime(target, now + over);
    }
  }

  /** For the occasions the sim does not model as cues — Discovery, Recompile. */
  celebrate(): void {
    if (!this.ctx) return;
    // Capped like the cue path already was. This was the last push into the
    // audio layer with no bound on it, and `bigEvent` is what an unbounded one
    // costs: a queue nobody drains fast enough is a leak with a soundtrack.
    if (this.occasions.length >= 4) return;
    this.occasions.push({ kind: 'level', hue: this.state.dominant, depth: 0, weight: 1 });
  }

  // ------------------------------------------------------------- arrangement

  private onStep(at: number, index: number, count: number): void {
    if (!this.ctx) return;
    const punch = this.voice(this.punchBus);
    const music = this.voice(this.musicBus);
    const plan = this.plan;
    const cells = this.cells;
    const i = this.smoothed;
    const beat = 60 / (this.clock?.bpm ?? 112);

    if (index === 0) {
      this.bar = Math.floor(count / 16);
      // A new arrangement lands on a phrase boundary and nowhere else.
      if (this.pendingPlan && (this.pendingUrgent || this.bar % PHRASE_BARS === 0)) {
        this.pendingUrgent = false;
        this.adopt(this.pendingPlan);
      }
      this.maybeVary();
    }
    const tones = this.chordTones();
    this.tones = tones;

    // §18 — the phrase. Techno does not build with chords, it builds by opening
    // a filter and adding layers over sixteen bars, then dropping them and doing
    // it again. This is the number that makes a loop feel like an arrangement.
    const phrase = this.phrase;
    const openness = 0.25 + phrase * 0.75;
    const colour = HUE_COLOUR[this.state.dominant];
    this.musicFilter.frequency.setTargetAtTime(
      420 + openness * colour * 5200 * (0.5 + i * 0.5),
      at,
      0.08,
    );

    // Swing: delay the offbeat sixteenths. A little of this is the whole
    // difference between a machine and a groove.
    const swung = index % 2 === 1 ? at + beat * 0.25 * plan.swing : at;

    // A big detonation owns the next sixteenth. See `bigEvent`.
    const claimed = this.claim > 0;
    if (claimed) this.claim--;

    const bleak = this.state.meltdown > 0;



    const kickStep = step(cells.kick, count);
    if (kickStep) {
      kick(punch, at, 0.95 * kickStep.gain, plan.kickVoice);
      this.duck(at);
    }

    // The backbeat on 2 and 4 — with the kick, the thing the body counts. It
    // drops for the last bar of a phrase, which is what makes the next downbeat
    // land.
    const percStep = step(cells.backbeat, count);
    if (percStep && this.bar % PHRASE_BARS !== PHRASE_BARS - 1) {
      // Scaled by intensity, unlike before. The backbeat was the one loud voice
      // that ignored how much was happening, so the menu — an arrangement at
      // near-zero intensity with almost nothing else playing — got the same clap
      // as a full run, with no wall of engine to sit behind. It now opens up with
      // everything else instead of arriving fully grown.
      perc(punch, at, (0.5 + 0.3 * i) * percStep.gain, plan.percVoice);
    }

    // §13.2 — Meltdown takes layers away rather than adding them.
    //
    // The instinct is to pile on for act three, and it is the wrong one: this
    // genre gets frightening when the room empties, not when it fills. The hats,
    // the stab and the lead are what make the track *pleasant* — they are the
    // groove and the tune. Strip them and what is left is a kick, a sub, a
    // bassline and one held minor chord, which is the same room with nobody
    // enjoying it. The kick never goes; the pulse is what the player is
    // surviving to.

    const hatStep = step(cells.hats, count);
    const drive = i * plan.drive;
    if (hatStep && drive > 0.08 && (!bleak || index % 8 === 4)) {
      hat(music, swung, (bleak ? 0.45 : 0.8) * hatStep.gain, hatStep.open);
    }

    // The bassline walks the chord: cell values index into its tones, so the
    // bass is always playing the harmony rather than a line beside it.
    const bassStep = step(cells.bass, count);
    if (bassStep && !bassStep.hold && i > 0.03 && !claimed) {
      const hz = semiHz(tone(tones, bassStep) - 12);
      bass(music, swung, hz, 0.85, {
        voice: plan.bassVoice,
        q: plan.bassQ,
        brightness: plan.bassBrightness * colour,
        accent: bassStep.accent,
        glideFrom: bassStep.slide ? this.lastBassHz : 0,
      });
      this.lastBassHz = hz;
    } else if (!bassStep) {
      this.lastBassHz = 0;
    }

    if (index === 0) sub(punch, at, semiHz(tones[0]! - 24), 0.7, beat * 2);

    // The stab. Enters a quarter of the way into a phrase and is most of what
    // reads as melody in this genre.
    const stabStep = step(cells.stab, count);
    if (stabStep && !bleak && (phrase > 0.24 || i > 0.5)) {
      stab(music, swung, tones, 0.9 * stabStep.gain, plan.stabVoice);
      if (plan.echo > 0.01) {
        stab(this.voice(this.echoSend), swung, tones, 0.9 * stabStep.gain, plan.stabVoice);
      }
    }

    // The motif: one or two bars, and the hook is repetition rather than
    // development — but *unchanged for sixteen bars* is not repetition, it is a
    // loop, and it was audible as one. So the back half of every phrase answers
    // the front half an octave up, and the last two bars of a phrase drop the
    // lead entirely. Same line, three shapes: statement, answer, silence. That
    // is the smallest amount of arrangement that stops a hook from wearing out,
    // and it costs nothing but a transposition.
    const answering = phrase >= 0.5 && phrase < 0.875;
    const resting = phrase >= 0.875;
    const motifStep = resting || bleak ? null : step(cells.motif, count);
    if (motifStep && !motifStep.hold && (phrase > 0.48 || i > 0.65)) {
      const hz = semiHz(tone(tones, motifStep) + (answering ? 36 : 24));
      motif(music, swung, hz, 0.9, plan.leadVoice, this.lastLeadHz);
      if (plan.echo > 0.01) motif(this.voice(this.echoSend), swung, hz, 0.9, plan.leadVoice);
      this.lastLeadHz = hz;
    } else if (!motifStep) {
      this.lastLeadHz = 0;
    }

    // The chord, chopped onto the grid. A sustained pad swells with no
    // relationship to the beat, which is what made the old one sound ethereal
    // and disconnected; harmony in this genre is carried rhythmically.
    // Under Meltdown it stops being chopped and is held across the bar instead.
    // A gated chord is a rhythm part; the same notes sustained are a drone, and
    // with the lead gone that is the only thing left carrying the harmony.
    if (bleak) {
      if (index === 0) gatedChord(music, swung, tones, 0.6, beat * 3.6, plan.padWave);
    } else if (i > 0.3 && index % 8 === 4) {
      gatedChord(music, swung, tones, 0.85, beat * 0.45, plan.padWave);
    }

    this.playParts(music, swung, index, tones);
    this.siegeStep(at, index, beat);
    this.flush(at, i);
  }

  /**
   * §21b.7 — the siege score.
   *
   * A different piece of music, not a treatment of the existing one. That was
   * the lesson of the version before this: sagging the arrangement's pitch and
   * tempo was reported as "the music doesn't change", and it was right — a
   * modification of something familiar reads as the familiar thing, slightly
   * off. A replacement reads as a replacement.
   *
   * Three ideas and nothing else. A drone with no chord movement, because
   * harmony implies somewhere to go. A blunt four-on-the-floor that doubles as
   * the bar fills, because the only structure here is time passing. And
   * something screaming above both from a third of the way in, inharmonic so it
   * never becomes a tune you could hum.
   *
   * It ignores the key, the plan and the phrase entirely. The run's arrangement
   * is a thing your Engine wrote; this is not yours.
   */
  private siegeStep(at: number, index: number, beat: number): void {
    if (this.siegeMix < 0.01 || !this.ctx) return;
    const v = this.voice(this.siegeBus);
    const s = this.state.siege;

    // The beat. Four on the floor, all four the same size: BAM BAM BAM BAM,
    // with nothing in between to soften it. The offbeat eighths are gone and
    // every downbeat is a full hit rather than one in two — anything else was
    // filling the gaps that make it pound.
    //
    // The gain still looks small for "pounding" and it still is not the lever.
    // Weight comes from the voice — a steeper pitch drop, a sub under the
    // landing, a noise crack on the transient — and from the duck below, which
    // is what actually makes it land: the drone owns the low band, so the kick
    // has to be given a hole in it rather than shouted over the top of it.
    if (index % 4 === 0) {
      siegeHit(v, at, 0.62, true);
      this.duckDrone(at, beat);
    }

    // The floor. Retriggered a bar at a time so it never quite decays, on a
    // fixed low E that has nothing to do with whatever key the run is in.
    if (index === 0) {
      // The gains here are small and the reason is worth writing down: a
      // resonant filter with Q up to 14 is an amplifier. Four oscillators
      // through it at what looked like a sane 0.5 rendered at peak 3.3 — more
      // than twice the loudest one-shot in the game — which would have pinned
      // the limiter flat for twenty-two seconds and ducked everything else to
      // nothing. Measured, not guessed.
      siegeDrone({ ctx: this.ctx, out: this.siegeDroneBus }, at, beat * 4.2, 41.2, 0.28 + s * 0.12, s);
    }

    // And the line above it, from a third of the way in. Each entry is a
    // different pitch, length and direction, and the walk is long enough that it
    // does not come back round inside a single hold.
    //
    // The gains are large because a bandpass at Q 3.2 over an FM carrier throws
    // most of the energy away — at what looked like a reasonable 0.13 this
    // rendered at peak 0.05 and was inaudible.
    if (index === 8 && s > 0.3) {
      const cry = SIEGE_CRIES[this.siegeCry % SIEGE_CRIES.length]!;
      this.siegeCry++;
      // Two octaves clear of the drone, so it is a separate register rather than
      // a melody the bass could be accompanying.
      siegeScream(v, at, beat * cry.len * 0.6, semiHz(cry.deg + 4) * 8, 0.13 + s * 0.15, s, cry.up);
    }
    // Past three quarters it stops waiting its turn and answers itself.
    if (index === 4 && s > 0.75) {
      const cry = SIEGE_CRIES[(this.siegeCry + 3) % SIEGE_CRIES.length]!;
      siegeScream(v, at, beat * 1.5, semiHz(cry.deg + 11) * 8, 0.11 + s * 0.12, s, !cry.up);
    }
  }

  /**
   * §21b.7 — sidechain the drone to the siege kick.
   *
   * Down to a quarter on the hit, back over the next two fifths of a beat. Fast
   * enough that it reads as the kick punching a hole rather than as the bass
   * being turned down, which is the entire difference between a sidechain and a
   * fault. It is also why the kick's own gain can stay modest: the impact comes
   * from the low end getting out of the way, not from the hit being louder than
   * the thing it competes with.
   */
  private duckDrone(at: number, beat: number): void {
    const g = this.siegeDroneBus.gain;
    g.cancelScheduledValues(at);
    g.setValueAtTime(0.26, at);
    g.linearRampToValueAtTime(1, at + beat * 0.42);
  }

  /**
   * A detonation big enough to be the loudest thing on screen.
   *
   * The best moments this soundtrack produces are the ones where a Nova lands
   * exactly on a note, and until now that was luck — the audio layer knew what
   * the simulation did but nothing about what the *screen* was doing. This is
   * the channel that makes it deliberate: a large burst claims the next
   * sixteenth, the bass gets out of the way for it, and the chord hits with it.
   *
   * Quantized like everything else, because an accent off the grid is a mistake
   * rather than an accent.
   */
  bigEvent(hue: Hue): void {
    if (!this.ctx || !this.clock) return;
    const at = this.clock.quantize(this.ctx.currentTime);

    // One accent per sixteenth, and no more. This is the fix for a crash.
    //
    // The caller reports every large detonation as it appears, which at level
    // fifteen with a Nova build is dozens per *frame* — and this method schedules
    // about ten Web Audio nodes each. Thousands of nodes a second first killed
    // the audio (it went silent and never came back), then the tab.
    //
    // Rate-limiting at the caller would have been the wrong place. Everything
    // quantizes, so forty calls in one sixteenth all schedule at the identical
    // instant: they were never forty accents, they were one accent played forty
    // times on top of itself. Refusing them here is both the performance fix and
    // the correct musical behaviour, and it means no future caller can flood it
    // either. §18.4's polyphony cap, applied to the one voice that had none.
    if (at <= this.lastBigEvent) return;
    this.lastBigEvent = at;

    const tones = this.tones;
    const voice = this.voice(this.punchBus);
    sub(voice, at, semiHz(tones[0]! - 24), 0.9, 0.45);
    gatedChord(this.voice(this.musicBus), at, tones, 1, 0.4, this.plan.padWave);
    playHue(this.voice(this.engineBus), hue, at, semiHz(tones[0]! + 24), 0.8);
    // Two steps of room. Any longer and the groove notices the hole.
    this.claim = 2;
  }

  /**
   * The Engine, playing. One line per live Program.
   *
   * These are the parts derived in `parts.ts` — the layer that responds to your
   * build second by second, over the arrangement `arrange.ts` selected for it.
   * Parts fan out across the chord by index so two rows never land on the same
   * note, which is the difference between harmony and four copies of one line.
   */
  private playParts(music: VoiceCtx, swung: number, index: number, tones: number[]): void {
    for (let p = 0; p < this.parts.length; p++) {
      const part = this.parts[p];
      if (!part?.pattern[index]) {
        if (part) this.lastPartHz[p] = 0;
        continue;
      }
      // Walk the contour, not the same note every time. `tone` places the row
      // in the chord; the contour moves it around inside that chord across the
      // bar. Both are chord degrees, so a part cannot step onto a wrong note.
      const degree = part.tone + (part.contour[index % part.contour.length] ?? 0);
      const hz = semiHz(tones[degree % tones.length]! + 24 + part.register);
      playPart(
        music,
        part.voice,
        swung,
        hz,
        part.gain,
        part.length,
        part.bite,
        part.glide ? (this.lastPartHz[p] ?? 0) : 0,
      );
      if (part.echo > 0.01) {
        const send = this.voice(this.echoSend);
        playPart(send, part.voice, swung, hz, part.gain * part.echo, part.length, part.bite);
      }
      this.lastPartHz[p] = hz;
    }
  }

  /**
   * Sidechain. The music bus dips on every kick and recovers over the beat.
   *
   * This is what makes a kick *punch* rather than fight the bass for the same
   * frequencies, and it is most of the reason a real track breathes. Cheap here:
   * one gain automation per beat.
   */
  private duck(at: number): void {
    const g = this.musicBus.gain;
    const target = this.state.stalled ? 0.12 : 0.9;
    const beat = 60 / (this.clock?.bpm ?? 112);
    g.cancelScheduledValues(at);
    g.setValueAtTime(target * 0.34, at);
    g.linearRampToValueAtTime(target, at + beat * 0.75);
  }

  /**
   * Engine events, as accents.
   *
   * The gate is the whole point. Below the density threshold every event plays,
   * and the game feels wired directly to your hands. Above it, only the loudest
   * few per step survive — the rest have already become the arrangement, which
   * is where their information went. Playing all forty is not more faithful, it
   * is a clipped roar carrying nothing.
   */
  private flush(at: number, intensity: number): void {
    const voice = this.voice(this.engineBus);

    // Occasions first, and never dropped. A level-up chord that loses its slot
    // to the 300th kill note is the system defeating its own purpose.
    for (const occasion of this.occasions.splice(0, 2)) {
      const tones = this.tones;
      const beat = 60 / (this.clock?.bpm ?? 112);
      if (occasion.kind === 'overheat') {
        // Overheat resolves *down* a fourth: the one chord in the game that
        // sounds like something went wrong rather than right. Quieter than a
        // level-up, not louder — it is already the most stressful moment in the
        // run and does not need volume to say so.
        sub(voice, at, semiHz(tones[0]! - 29), 0.55, 1.1);
        this.hitChord(voice, at, tones.map((x) => x - 5), 0.45, beat);
      } else {
        // Three hits on the beat rather than one long swell — an occasion should
        // land *in* the track, not float above it.
        this.hitChord(voice, at, tones, 1, beat);
      }
    }

    if (this.pending.length === 0) return;
    const batch = this.pending;
    this.pending = [];

    // As the arrangement takes over, individual events step back. This one is a
    // *reduction*, which is the direction that stays comfortable: the engine
    // layer thins out rather than everything else getting louder to bury it.
    const duckToArrangement = 1 - Math.min(0.75, intensity * 0.95);
    if (duckToArrangement < 0.3) return;

    batch.sort((a, b) => b.weight - a.weight);

    let played = 0;
    const heard = new Set<string>();
    for (const cue of batch) {
      if (played >= MAX_ACCENTS_PER_STEP) break;

      // Quiet events stop being worth a note once the track is carrying itself.
      if (cue.weight < intensity * 0.55) continue;

      // One note per (kind, hue, depth) per step. Twelve identical bolts on one
      // sixteenth is one note played twelve times — a louder note with phasing.
      const key = `${cue.kind}:${cue.hue}:${cue.depth}`;
      if (heard.has(key)) continue;
      heard.add(key);

      const gain = (0.3 + cue.weight * 0.6) * duckToArrangement;
      // Every accent is a *chord tone*. A cascade is therefore the current chord
      // being hammered, and cannot clash with the track by construction - which
      // is the only way forty simultaneous notes were ever going to work.
      const base = cue.kind === 'kill' ? 2 : cue.kind === 'pickup' ? 4 : 0;
      playHue(voice, cue.hue, at, this.chordNote(base + cue.depth), gain);
      played++;
    }
  }

  // ---------------------------------------------------------------- utilities

  private voice(out: AudioNode): VoiceCtx {
    return { ctx: this.ctx!, out };
  }

  /** An occasion chord: three hits on the beat, so it lands in the track. */
  private hitChord(voice: VoiceCtx, at: number, tones: number[], gain: number, beat: number): void {
    for (let i = 0; i < 3; i++) {
      gatedChord(voice, at + beat * i * 0.5, tones, gain * (1 - i * 0.18), beat * 0.42, this.plan.padWave);
    }
  }

  /**
   * The n-th chord tone above the chord, climbing octaves as n grows.
   *
   * Cascade depth feeds this, so a deep cascade is an arpeggio running up the
   * chord - the rise the HUD's depth counter cannot convey, and in key by
   * construction rather than by luck.
   */
  private chordNote(n: number): number {
    const tones = this.tones;
    const clamped = Math.max(0, Math.min(11, n));
    const octave = Math.floor(clamped / tones.length);
    return semiHz(tones[clamped % tones.length]! + 24 + octave * 12);
  }


}
