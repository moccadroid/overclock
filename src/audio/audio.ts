/**
 * The audio engine. GDD §18.
 *
 * Two halves that share one clock:
 *
 *  - **The track.** A minimal techno bed — kick on the floor, offbeat hats, a
 *    sub that follows your fullest fuel gauge. Layers arrive as the run gets
 *    louder (§18.2's "rhythmic intensity layers keyed to EPS bands"), so the
 *    beat builds because you built an engine, not because a timer said so.
 *  - **The engine.** Every fire, kill and pickup is a note, quantized onto the
 *    same grid. This is the part that makes §18.1 true rather than decorative:
 *    the player is not listening to music with a game under it, they are
 *    listening to their own build.
 *
 * The sim never learns this file exists. Cues are drained one-way, exactly like
 * visualDeaths — so audio can lag, drop voices, or be muted, and the run stays
 * bit-identical. `audio.test.ts` enforces the import direction.
 */
import type { AudioCue } from '../sim/world';
import type { Hue } from '../sim/types';
import { Clock } from './clock';
import { chime, hat, hurt, kick, noteHz, playHue, sub, type VoiceCtx } from './voices';

/** §18.4 — "kill-note polyphony capped with intelligent voice-stealing". */
const MAX_VOICES_PER_STEP = 10;

export interface AudioState {
  /** 0..1 — how busy the engine is, from EPS. Drives tempo and layers. */
  intensity: number;
  /** Fullest fuel gauge, for the pad's root. */
  dominant: Hue;
  /** 0..1 Heat, for master-bus grit. */
  heat: number;
  stalled: boolean;
  /** §13.2 — Meltdown detunes and dirties everything. */
  meltdown: number;
}

export class Audio {
  private ctx: AudioContext | null = null;
  private clock: Clock | null = null;
  private master!: GainNode;
  private trackBus!: GainNode;
  private engineBus!: GainNode;
  private shaper!: WaveShaperNode;

  private state: AudioState = {
    intensity: 0,
    dominant: 'thermal',
    heat: 0,
    stalled: false,
    meltdown: 0,
  };

  /** Cues waiting for the next scheduling pass, newest last. */
  private pending: AudioCue[] = [];
  private muted = false;
  private volume = 0.7;

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

    // §18.3 — Overheat is master-bus distortion. The curve is flat until it is
    // needed, so the shaper can stay in the path permanently.
    this.shaper = ctx.createWaveShaper();
    this.setDrive(0);
    this.shaper.connect(this.master).connect(ctx.destination);

    this.trackBus = ctx.createGain();
    this.trackBus.gain.value = 0.9;
    this.trackBus.connect(this.shaper);

    this.engineBus = ctx.createGain();
    this.engineBus.gain.value = 0.55;
    this.engineBus.connect(this.shaper);

    this.clock = new Clock(ctx);
    this.clock.onStep((step) => this.onStep(step.time, step.index));
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

    // §18.2 — 110 BPM base rising toward ~140. Tempo follows how loud the run
    // is, so the track speeds up because you did something.
    this.clock.bpm = 110 + state.intensity * 30;
    this.setDrive(Math.max(state.heat * 0.7, state.meltdown * 0.5));

    // Silence is banned (§18.4) but a stall should still land as a hole.
    this.trackBus.gain.value = state.stalled ? 0.25 : 0.9;

    for (const cue of cues) {
      // Hurt is the exception to everything: unquantized, played the instant it
      // happens. Waiting up to 34ms for a grid boundary would make the one
      // sound that must feel like an interruption feel like part of the song.
      if (cue.kind === 'hurt') {
        hurt(this.voice(this.engineBus), this.ctx.currentTime, 0.9);
        continue;
      }
      if (this.pending.length < 64) this.pending.push(cue);
    }
  }

  // ------------------------------------------------------------------ the beat

  private onStep(at: number, index: number): void {
    if (!this.ctx) return;
    const track = this.voice(this.trackBus);
    const i = this.state.intensity;

    // Layers arrive as the run gets louder. Four-on-the-floor from the first
    // beat, because a techno track with no kick is not a techno track.
    if (index % 4 === 0) kick(track, at, 0.9);

    // Offbeat hats from the moment anything is happening at all.
    if (i > 0.05 && index % 4 === 2) hat(track, at, 0.8);
    // Sixteenth ticks fill in as the engine gets busy.
    if (i > 0.35 && index % 2 === 1) hat(track, at, 0.4);
    if (i > 0.7 && index % 4 === 3) hat(track, at, 0.6, true);

    // The sub follows your fullest gauge, so the track's key is a readout of the
    // fuel you are sitting on. Two bars per note — it should feel like a floor,
    // not a melody.
    if (index === 0) {
      const root = { thermal: 0, voltaic: 2, void: 3 }[this.state.dominant];
      sub(track, at, noteHz(root) / 2, 0.8, (60 / (this.clock?.bpm ?? 110)) * 4);
    }

    this.flush(at);
  }

  /**
   * Drain pending engine cues onto this step.
   *
   * §18.4's voice-stealing: when a cascade produces forty events in one frame,
   * the loudest ten play and the rest are dropped. Playing all forty is not
   * "more faithful" — it is a clipped roar with no information in it.
   */
  private flush(at: number): void {
    if (this.pending.length === 0) return;
    const batch = this.pending;
    this.pending = [];

    batch.sort((a, b) => b.weight - a.weight);
    const voice = this.voice(this.engineBus);

    let played = 0;
    const heard = new Set<string>();
    for (const cue of batch) {
      if (played >= MAX_VOICES_PER_STEP) break;
      // One note per (kind, hue, depth) per step. Twelve identical bolts on the
      // same sixteenth is one note played twelve times, which is just a louder
      // note with phasing artefacts.
      const key = `${cue.kind}:${cue.hue}:${cue.depth}`;
      if (heard.has(key)) continue;
      heard.add(key);

      if (cue.kind === 'level') {
        chime(voice, at, 0.9);
      } else if (cue.kind === 'overheat') {
        sub(voice, at, noteHz(0) / 2, 1, 0.9);
      } else if (cue.kind === 'pickup') {
        playHue(voice, cue.hue, at, 14 + (cue.depth % 3), 0.35);
      } else {
        // Depth climbs the scale: a deep cascade rises as it travels.
        const base = cue.kind === 'kill' ? 7 : 3;
        playHue(voice, cue.hue, at, base + cue.depth, 0.35 + cue.weight * 0.65);
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
