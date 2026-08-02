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
  chord,
  hat,
  hurt,
  kick,
  noteHz,
  pad,
  playHue,
  sub,
  type VoiceCtx,
} from './voices';

/**
 * §18.4 — polyphony cap. Three, not ten: the point of an accent is that it is
 * rarer than the thing it accents.
 */
const MAX_ACCENTS_PER_STEP = 3;

/** Bass patterns, 16 steps. `-1` is a rest; numbers are scale degrees. */
const BASS_PATTERNS: number[][] = [
  // Sparse — root on the offbeat. Barely there, holds the floor.
  [-1, -1, 0, -1, -1, -1, 0, -1, -1, -1, 0, -1, -1, -1, 0, -1],
  // Driving — the classic offbeat pump with a walk at the end of the bar.
  [-1, -1, 0, -1, -1, -1, 0, -1, -1, -1, 0, -1, -1, 2, 0, 3],
  // Busy — sixteenth stabs. Only earned at high intensity.
  [0, -1, 0, 3, -1, 0, 0, -1, 2, -1, 0, 3, -1, 0, 5, 3],
];

/** Which scale degree each hue roots the track on. */
const HUE_ROOT: Record<Hue, number> = { thermal: 0, voltaic: 2, void: 3 };

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

    this.musicBus = ctx.createGain();
    this.musicBus.gain.value = 0.9;
    this.musicBus.connect(this.lowShelf);

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

  /** Called each frame with the run's mood and the cues it produced. */
  update(state: AudioState, cues: AudioCue[]): void {
    this.state = state;
    if (!this.ctx || !this.clock) return;

    // Intensity is smoothed hard. A cascade spikes EPS for half a second, and an
    // arrangement that adds and drops a layer inside half a second sounds broken
    // rather than responsive.
    this.smoothed += (state.intensity - this.smoothed) * 0.04;

    // §18.2 asked for 110 rising to 140. 140 is right for the *feeling* of
    // Meltdown and wrong as a continuous ramp: a groove needs a stable pulse,
    // and the earlier build moved it every frame. Tempo now sits at 112 and only
    // Meltdown — a once-per-run, permanent, announced event — shifts it.
    this.clock.bpm = 112 + state.meltdown * 12;
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
    const i = this.smoothed;
    const root = HUE_ROOT[this.state.dominant];
    const beat = (60 / (this.clock?.bpm ?? 112)) * 4;

    // Four on the floor, always. A techno track without a kick is not one.
    if (index % 4 === 0) {
      kick(punch, at, 0.95);
      this.duck(at);
    }

    // Layers arrive with intensity, and each one is a rung: you can hear the
    // arrangement grow as your engine does.
    if (i > 0.08 && index % 4 === 2) hat(music, at, 0.8);
    if (i > 0.45 && index % 2 === 1) hat(music, at, 0.35);
    if (i > 0.75 && index % 8 === 6) hat(music, at, 0.55, true);

    // The bassline. Pattern is chosen by intensity, root by your fullest gauge,
    // so the track's key is a readout of the fuel you are sitting on.
    if (i > 0.03) {
      const pattern = BASS_PATTERNS[i > 0.7 ? 2 : i > 0.3 ? 1 : 0]!;
      const degree = pattern[index]!;
      if (degree >= 0) bass(music, at, noteHz(root + degree) / 2, 0.85);
    }

    // Sub on the downbeat of every other bar — the floor under the floor.
    if (index === 0 && count % 32 === 0) {
      sub(punch, at, noteHz(root) / 2, 0.7, beat * 2);
    }

    // A pad, once the run is genuinely loud. Two bars long, so it reads as
    // atmosphere rather than a part.
    if (i > 0.55 && index === 0 && count % 32 === 0) {
      pad(music, at, root, Math.min(1, (i - 0.55) * 2.5), beat * 2);
    }

    this.flush(at, i);
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
      if (occasion.kind === 'overheat') {
        sub(voice, at, noteHz(0) / 2, 1, 1.1);
        chord(voice, at, HUE_ROOT[this.state.dominant] - 2, 0.75, 1.6);
      } else {
        chord(voice, at, HUE_ROOT[this.state.dominant], 1);
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
      if (cue.kind === 'convert') {
        playHue(voice, cue.hue, at, 10, gain);
      } else if (cue.kind === 'pickup') {
        playHue(voice, cue.hue, at, 14 + (cue.depth % 3), gain * 0.6);
      } else {
        // Depth climbs the scale: a deep cascade rises as it travels.
        const base = cue.kind === 'kill' ? 7 : 3;
        playHue(voice, cue.hue, at, base + Math.min(cue.depth, 9), gain);
      }
      played++;
    }
  }

  // ---------------------------------------------------------------- utilities

  private voice(out: AudioNode): VoiceCtx {
    return { ctx: this.ctx!, out };
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
