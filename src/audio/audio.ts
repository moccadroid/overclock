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
import { CHORD_TONES, TRACKS, trackForAxiom, type Track } from './tracks';
import type { Part } from './parts';

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

export class Audio {
  private ctx: AudioContext | null = null;
  private clock: Clock | null = null;
  private master!: GainNode;
  /** Kick and accents. Never ducked — the kick is what everything ducks under. */
  private punchBus!: GainNode;
  /** Bass, pad, hats. Ducked on every kick. */
  private musicBus!: GainNode;
  private engineBus!: GainNode;
  private shaper!: WaveShaperNode;
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
  private track: Track = TRACKS[0]!;
  /** Bars elapsed, for walking the progression. */
  private bar = 0;
  private silenced = false;
  /** The chord currently sounding. Accents snap to it. */
  private tones: number[] = [0, 3, 7];
  /** Previous note, for 303 glide. 0 means "no slide into this one". */
  private lastBassHz = 0;
  private lastLeadHz = 0;
  private lastHover = 0;
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
   * to chase. Run Setup's START RUN is that gesture.
   */
  start(): void {
    if (this.ctx) return;
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

    this.shaper = ctx.createWaveShaper();
    this.setDrive(0);

    this.lowShelf.connect(this.shaper).connect(this.master).connect(ctx.destination);

    this.punchBus = ctx.createGain();
    this.punchBus.gain.value = 0.95;
    this.punchBus.connect(this.lowShelf);

    this.musicFilter = ctx.createBiquadFilter();
    this.musicFilter.type = 'lowpass';
    this.musicFilter.frequency.value = 2200;
    this.musicFilter.Q.value = 1.1;
    this.musicFilter.connect(this.lowShelf);

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
    this.engineBus.connect(this.lowShelf);

    this.clock = new Clock(ctx);
    this.clock.onStep((step) => this.onStep(step.time, step.index, step.count));
    this.clock.start();
    void ctx.resume();
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.ctx) this.master.gain.value = muted ? 0 : this.volume;
  }

  setVolume(v: number): void {
    this.volume = Math.max(0, Math.min(1, v));
    if (this.ctx && !this.muted) this.master.gain.value = this.volume;
  }

  get trackId(): string {
    return this.track.id;
  }

  /** True while the arrangement is running — the Music pane shows a ▶ for it. */
  get playing(): boolean {
    return this.clock !== null && !this.silenced;
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

  setTrack(track: Track): void {
    this.track = track;
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

  /** The Axiom you started with is the song you hear. */
  setTrackForAxiom(axiomId: string): void {
    this.track = trackForAxiom(axiomId);
  }

  /**
   * Menu preview: run the arrangement with no game behind it, at a fixed
   * intensity high enough to hear every layer the track has.
   */
  preview(track: Track, parts: (Part | null)[] = [], intensity = 0.72): void {
    this.start();
    this.resumeBusses();
    this.track = track;
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
   * The chord under the current bar, as absolute semitones.
   *
   * Held for `barsPerChord`, so a two-chord track turns over every eight or
   * sixteen bars. That slowness is the point — a change nobody waited for is not
   * a change anybody notices.
   */
  private chordTones(): number[] {
    const prog = this.track.progression;
    const index = Math.floor(this.bar / this.track.barsPerChord) % prog.length;
    const c = prog[index]!;
    const base = this.track.key + c.root;
    return CHORD_TONES[c.quality].map((t) => base + t);
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
    this.echoSend.gain.setTargetAtTime(this.track.echo, this.ctx.currentTime, 0.3);
    this.setDrive(Math.max(state.heat * 0.6, state.meltdown * 0.45));
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
    if (!this.ctx || this.muted) return;
    const now = this.ctx.currentTime;
    if (sound === 'hover') {
      if (now - this.lastHover < 0.045) return;
      this.lastHover = now;
    }
    // Chrome goes to the punch bus: it must not duck under the kick, because a
    // click that ducks reads as a click that did not register.
    uiVoice(this.voice(this.punchBus), now, sound);
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
    const t = this.track;
    const i = this.smoothed;
    const beat = 60 / (this.clock?.bpm ?? 112);

    if (index === 0) this.bar = Math.floor(count / 16);
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
    const swung = index % 2 === 1 ? at + beat * 0.25 * t.swing : at;

    if (t.kick[index]) {
      kick(punch, at, 0.95, t.kickVoice);
      this.duck(at);
    }
    // The backbeat on 2 and 4 - with the kick, the thing the body counts. It
    // drops for the last bar of a phrase, which is what makes the next downbeat
    // land.
    if (t.clap[index] && this.bar % PHRASE_BARS !== PHRASE_BARS - 1) {
      perc(punch, at, 0.75, t.percVoice);
    }

    const d = i * t.drive;
    if (d > 0.08 && index % 4 === 2) hat(music, swung, 0.8);
    if (d > 0.4 && index % 2 === 1) hat(music, swung, 0.35);
    if ((d > 0.7 || phrase > 0.6) && index % 8 === 6) hat(music, swung, 0.55, true);

    // The bassline walks the chord: pattern values index into its tones, so the
    // bass is always playing the harmony rather than a line beside it.
    if (i > 0.03) {
      const pattern = t.bass[i > 0.7 ? 2 : i > 0.3 ? 1 : 0]!;
      const tone = pattern[index]!;
      if (tone >= 0) {
        const hz = semiHz(tones[tone % tones.length]! - 12);
        bass(music, swung, hz, 0.85, {
          voice: t.bassVoice,
          q: t.bassQ,
          brightness: t.bassBrightness * colour,
          accent: t.accents?.includes(index) ?? false,
          // Slide from the previous note when they are adjacent sixteenths.
          // Glide is what makes a 303 line sound played rather than stepped.
          glideFrom: this.lastBassHz > 0 && pattern[(index + 15) % 16]! >= 0 ? this.lastBassHz : 0,
        });
        this.lastBassHz = hz;
      } else {
        this.lastBassHz = 0;
      }
    }

    if (index === 0) sub(punch, at, semiHz(tones[0]! - 24), 0.7, beat * 2);

    // The stab. Enters a quarter of the way into a phrase and is most of what
    // reads as melody in this genre.
    if (t.stab[index] && (phrase > 0.24 || i > 0.5)) {
      stab(music, swung, tones, 0.7 + i * 0.5, t.stabVoice);
      if (t.echo > 0.01) stab(this.voice(this.echoSend), swung, tones, 0.7 + i * 0.5, t.stabVoice);
    }

    // The motif: one or two bars, repeated unchanged. The hook is repetition,
    // not development - so it arrives on a phrase boundary and then never varies.
    // The motif walks its own length, so a 32-step line reads as two bars of
    // tune rather than the same bar twice.
    if (phrase > 0.48 || i > 0.65) {
      const step = t.motif[count % t.motif.length]!;
      if (step >= 0) {
        const octave = step >= 3 ? 12 : 0;
        const hz = semiHz(tones[step % 3]! + 24 + octave);
        motif(music, swung, hz, 0.9, t.leadVoice, this.lastLeadHz);
        if (t.echo > 0.01) motif(this.voice(this.echoSend), swung, hz, 0.9, t.leadVoice);
        this.lastLeadHz = hz;
      } else {
        this.lastLeadHz = 0;
      }
    }

    // The chord, chopped onto the grid. The old sustained pad swelled for two
    // seconds with no relationship to the beat, which is what made it sound
    // ethereal and disconnected; harmony in this genre is carried rhythmically.
    if (i > 0.3 && index % 8 === 4) {
      gatedChord(music, swung, tones, Math.min(1, (i - 0.3) * 1.6), beat * 0.45, t.padWave);
    }

    this.playParts(music, swung, index, tones, i);
    this.flush(at, i);
  }

  /**
   * The Engine, playing. One line per live Program.
   *
   * This is §18.1's claim made literal: four rows are four interlocking
   * sequences, and rebuilding your Engine rewrites the track. Parts fan out
   * across the chord by index so two rows never land on the same note, which is
   * the difference between harmony and four copies of one line.
   */
  private playParts(
    music: VoiceCtx,
    swung: number,
    index: number,
    tones: number[],
    intensity: number,
  ): void {
    for (let p = 0; p < this.parts.length; p++) {
      const part = this.parts[p];
      if (!part || !part.pattern[index]) {
        if (part) this.lastPartHz[p] = 0;
        continue;
      }
      // Parts fade up with the run rather than arriving at full volume: a fresh
      // Engine should sound like one row, not like a finished track.
      const level = part.gain * (0.45 + intensity * 0.55);
      const hz = semiHz(tones[part.tone % tones.length]! + 24 + part.register);
      playPart(
        music,
        part.voice,
        swung,
        hz,
        level,
        part.length,
        part.bite,
        part.glide ? (this.lastPartHz[p] ?? 0) : 0,
      );
      if (part.echo > 0.01) {
        const send = this.voice(this.echoSend);
        playPart(send, part.voice, swung, hz, level * part.echo, part.length, part.bite);
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
        // sounds like something went wrong rather than right.
        sub(voice, at, semiHz(tones[0]! - 29), 1, 1.1);
        this.hitChord(voice, at, tones.map((x) => x - 5), 0.8, beat);
      } else {
        // Three hits on the beat rather than one long swell — an occasion should
        // land *in* the track, not float above it.
        this.hitChord(voice, at, tones, 1, beat);
      }
    }

    if (this.pending.length === 0) return;
    const batch = this.pending;
    this.pending = [];

    // As the arrangement takes over, individual events step back. At full
    // intensity the engine layer is a quarter of its quiet-game volume.
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
      gatedChord(voice, at + beat * i * 0.5, tones, gain * (1 - i * 0.18), beat * 0.42, this.track.padWave);
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

  /** Soft clip. 0 is transparent; 1 is an engine coming apart. */
  private setDrive(amount: number): void {
    const k = amount * 40;
    const n = 256;
    const curve = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      curve[i] = k === 0 ? x : ((1 + k) * x) / (1 + k * Math.abs(x));
    }
    this.shaper.curve = curve;
  }
}
