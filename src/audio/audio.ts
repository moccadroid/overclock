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
  gatedChord,
  hat,
  hurt,
  kick,
  motif,
  perc,
  playHue,
  playPart,
  semiHz,
  stab,
  sub,
  ui as uiVoice,
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
  /**
   * §18.1 — one part per live Program. This is the arrangement, and it is
   * literally the player's Engine. See parts.ts.
   */
  private parts: (Part | null)[] = [];
  private lastPartHz: number[] = [];
  /** Smoothed, so the arrangement never flickers between layers frame to frame. */
  private smoothed = 0;

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
    this.musicGroup = ctx.createGain();
    this.musicGroup.gain.value = this.musicVolume;
    this.musicGroup.connect(this.lowShelf);

    this.sfxGroup = ctx.createGain();
    this.sfxGroup.gain.value = this.sfxVolume;
    this.sfxGroup.connect(this.lowShelf);

    // The Effects slider still has to reach chrome, and chrome no longer passes
    // through `sfxGroup`, so the level is mirrored here instead.
    this.uiLevel = ctx.createGain();
    this.uiLevel.gain.value = this.sfxVolume;
    this.uiLevel.connect(this.master);

    this.punchBus = ctx.createGain();
    this.punchBus.gain.value = 0.95;
    this.punchBus.connect(this.musicGroup);

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
    this.musicFilter.connect(this.musicGroup);

    this.musicBus = ctx.createGain();
    this.musicBus.gain.value = 0.9;
    this.musicBus.connect(this.musicFilter);

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
    this.engineBus.connect(this.sfxGroup);

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
    const next = arrange(input);
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
    this.state = { intensity, dominant: 'thermal', heat: 0, stalled: false, meltdown: 0 };
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
    this.clock.bpm = 112 + state.meltdown * 12;
    this.delay.delayTime.setTargetAtTime((60 / this.clock.bpm) * 0.75, this.ctx.currentTime, 0.2);
    this.echoSend.gain.setTargetAtTime(this.plan.echo, this.ctx.currentTime, 0.3);

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

  /** For the occasions the sim does not model as cues — Discovery, Recompile. */
  celebrate(): void {
    if (!this.ctx) return;
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
      if (this.pendingPlan && this.bar % PHRASE_BARS === 0) this.adopt(this.pendingPlan);
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
      perc(punch, at, 0.75 * percStep.gain, plan.percVoice);
    }

    const hatStep = step(cells.hats, count);
    const drive = i * plan.drive;
    if (hatStep && drive > 0.08) {
      hat(music, swung, 0.8 * hatStep.gain, hatStep.open);
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
    if (stabStep && (phrase > 0.24 || i > 0.5)) {
      stab(music, swung, tones, 0.9 * stabStep.gain, plan.stabVoice);
      if (plan.echo > 0.01) {
        stab(this.voice(this.echoSend), swung, tones, 0.9 * stabStep.gain, plan.stabVoice);
      }
    }

    // The motif: one or two bars, repeated unchanged. The hook is repetition,
    // not development — so it arrives on a phrase boundary and then never varies.
    const motifStep = step(cells.motif, count);
    if (motifStep && !motifStep.hold && (phrase > 0.48 || i > 0.65)) {
      const hz = semiHz(tone(tones, motifStep) + 24);
      motif(music, swung, hz, 0.9, plan.leadVoice, this.lastLeadHz);
      if (plan.echo > 0.01) motif(this.voice(this.echoSend), swung, hz, 0.9, plan.leadVoice);
      this.lastLeadHz = hz;
    } else if (!motifStep) {
      this.lastLeadHz = 0;
    }

    // The chord, chopped onto the grid. A sustained pad swells with no
    // relationship to the beat, which is what made the old one sound ethereal
    // and disconnected; harmony in this genre is carried rhythmically.
    if (i > 0.3 && index % 8 === 4) {
      gatedChord(music, swung, tones, 0.85, beat * 0.45, plan.padWave);
    }

    this.playParts(music, swung, index, tones);
    this.flush(at, i);
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
      if (!part || !part.pattern[index]) {
        if (part) this.lastPartHz[p] = 0;
        continue;
      }
      const hz = semiHz(tones[part.tone % tones.length]! + 24 + part.register);
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
