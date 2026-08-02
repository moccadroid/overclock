/**
 * The instrument. GDD §18.3.
 *
 * Fully synthesized, no samples (§18.1). Every voice here is oscillators,
 * filters and envelopes built per note and thrown away — the Web Audio graph is
 * cheap to construct and expensive to keep, and a game that fires six hundred
 * times a second cannot afford persistent nodes it forgot to disconnect.
 *
 * Hue voices are chosen to occupy different frequency bands, so a three-hue
 * engine reads as a mix rather than a pile:
 *
 *   THERMAL  saw bass, kick-adjacent          low
 *   VOLTAIC  square blips, hi-hat register    high
 *   VOID     FM pad, sub drops                wide and soft
 *
 * That separation is §16.3's hue discipline applied to the ear: the same three
 * colours, distinguishable without being told which is which.
 */
import type { Hue } from '../sim/types';

/** A minor pentatonic, in semitones. Every note in the game is from this set,
 *  which is why simultaneous events never sound wrong together. */
const SCALE = [0, 3, 5, 7, 10];
const ROOT = 55; // A1

/**
 * Semitones above A1. The musical layers — bass, chords, pad — work in
 * semitones because a chord progression needs notes the pentatonic does not
 * contain. The hue accents keep using `noteHz`, and that is safe: the pentatonic
 * is a subset of every mode these progressions use, so a cascade of forty
 * accents can sit over any chord without ever clashing.
 */
export function semiHz(semitones: number): number {
  return ROOT * Math.pow(2, semitones / 12);
}

export function noteHz(degree: number): number {
  const octave = Math.floor(degree / SCALE.length);
  const step = SCALE[((degree % SCALE.length) + SCALE.length) % SCALE.length]!;
  return ROOT * Math.pow(2, (octave * 12 + step) / 12);
}

export interface VoiceCtx {
  ctx: AudioContext;
  out: AudioNode;
}

function env(
  ctx: AudioContext,
  at: number,
  attack: number,
  decay: number,
  peak: number,
): GainNode {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), at + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, at + attack + decay);
  return g;
}

function osc(
  ctx: AudioContext,
  type: OscillatorType,
  hz: number,
  at: number,
  stop: number,
): OscillatorNode {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(hz, at);
  o.start(at);
  o.stop(stop);
  return o;
}

// ------------------------------------------------------------------ hue voices

/** THERMAL — saw bass with a fast filter sweep. Punchy, low, kick-adjacent. */
function thermal(v: VoiceCtx, at: number, hz: number, gain: number): void {
  const { ctx } = v;
  const dur = 0.22;
  const g = env(ctx, at, 0.004, dur, gain * 0.5);

  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.setValueAtTime(Math.min(6000, hz * 12), at);
  filter.frequency.exponentialRampToValueAtTime(Math.max(90, hz * 1.6), at + dur * 0.7);
  filter.Q.value = 6;

  const o = osc(ctx, 'sawtooth', hz, at, at + dur + 0.05);
  // A second oscillator a hair flat gives the bass body without a second note.
  const o2 = osc(ctx, 'sawtooth', hz * 0.995, at, at + dur + 0.05);

  o.connect(filter);
  o2.connect(filter);
  filter.connect(g).connect(v.out);
}

/** VOLTAIC — square blip. Short, bright, sits in the hi-hat register. */
function voltaic(v: VoiceCtx, at: number, hz: number, gain: number): void {
  const { ctx } = v;
  const dur = 0.09;
  const g = env(ctx, at, 0.002, dur, gain * 0.24);

  const filter = ctx.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.value = hz * 4;
  filter.Q.value = 3;

  const o = osc(ctx, 'square', hz * 4, at, at + dur + 0.02);
  o.connect(filter).connect(g).connect(v.out);
}

/** VOID — two-operator FM. Soft, wide, slightly wrong. */
function voidVoice(v: VoiceCtx, at: number, hz: number, gain: number): void {
  const { ctx } = v;
  const dur = 0.5;
  const g = env(ctx, at, 0.03, dur, gain * 0.3);

  const carrier = osc(ctx, 'sine', hz * 2, at, at + dur + 0.1);
  const mod = osc(ctx, 'sine', hz * 2 * 1.4983, at, at + dur + 0.1);
  const modDepth = ctx.createGain();
  modDepth.gain.setValueAtTime(hz * 3, at);
  modDepth.gain.exponentialRampToValueAtTime(hz * 0.2, at + dur);

  mod.connect(modDepth);
  modDepth.connect(carrier.frequency);
  carrier.connect(g).connect(v.out);
}

const HUE_VOICE: Record<Hue, (v: VoiceCtx, at: number, hz: number, gain: number) => void> = {
  thermal,
  voltaic,
  void: voidVoice,
};

/**
 * An engine event, as a note.
 *
 * Takes a frequency rather than a scale degree, because the arranger snaps every
 * accent to the *current chord*. The first version played a fixed A-minor
 * pentatonic over whatever chord happened to be underneath, which puts a C
 * against a G major's B — a minor ninth, the most dissonant interval available,
 * and the reason a cascade could sound like a mistake.
 */
export function playHue(v: VoiceCtx, hue: Hue, at: number, hz: number, gain: number): void {
  HUE_VOICE[hue](v, at, hz, gain);
}

/**
 * Clap on 2 and 4. Three noise bursts a few milliseconds apart, because one
 * burst is a click and a real clap is many hands not quite together.
 */
export function clap(v: VoiceCtx, at: number, gain: number): void {
  const { ctx } = v;
  const bus = ctx.createGain();
  bus.gain.value = gain * 0.3;

  const filter = ctx.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.value = 1500;
  filter.Q.value = 0.9;
  bus.connect(filter).connect(v.out);

  for (const [offset, level, dur] of [
    [0, 1, 0.02],
    [0.009, 0.75, 0.02],
    [0.019, 0.6, 0.14],
  ] as const) {
    const frames = Math.ceil(ctx.sampleRate * (dur + 0.02));
    const buf = ctx.createBuffer(1, frames, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < frames; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / frames, 3);
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const g = ctx.createGain();
    g.gain.value = level;
    src.connect(g).connect(bus);
    src.start(at + offset);
    src.stop(at + offset + dur + 0.02);
  }
}

/**
 * The stab: a short, hard chord hit on an offbeat. Detroit's whole personality
 * in one voice — most of what people hear as "the melody" in techno is this.
 */
export function stab(
  v: VoiceCtx,
  at: number,
  semitones: number[],
  gain: number,
  wave: OscillatorType = 'sawtooth',
): void {
  const { ctx } = v;
  const dur = 0.14;
  const g = env(ctx, at, 0.003, dur, gain * 0.13);

  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.setValueAtTime(5200, at);
  filter.frequency.exponentialRampToValueAtTime(1100, at + dur);
  filter.Q.value = 4;
  filter.connect(g).connect(v.out);

  for (const semi of semitones) {
    const hz = semiHz(semi + 24);
    for (const cents of [-6, 6]) {
      const o = osc(ctx, wave, hz * Math.pow(2, cents / 1200), at, at + dur + 0.05);
      const vg = ctx.createGain();
      vg.gain.value = 0.4;
      o.connect(vg).connect(filter);
    }
  }
}

/** One note of the repeating motif. Plucked, bright, sits above the bass. */
export function motif(v: VoiceCtx, at: number, hz: number, gain: number): void {
  const { ctx } = v;
  const dur = 0.19;
  const g = env(ctx, at, 0.004, dur, gain * 0.09);

  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.setValueAtTime(hz * 6, at);
  filter.frequency.exponentialRampToValueAtTime(hz * 1.5, at + dur);
  filter.Q.value = 7;

  const o = osc(ctx, 'sawtooth', hz, at, at + dur + 0.05);
  const o2 = osc(ctx, 'square', hz * 2.002, at, at + dur + 0.05);
  const og = ctx.createGain();
  og.gain.value = 0.35;
  o.connect(filter);
  o2.connect(og).connect(filter);
  filter.connect(g).connect(v.out);
}

// -------------------------------------------------------------- the backing

/**
 * Four-on-the-floor kick. Three parts, because one sine is a beep:
 *
 *   - a click transient, so it cuts through a busy mix
 *   - a fast pitch drop, which is what the ear reads as "hit"
 *   - a long body down at 35Hz, which is what the chest reads as "oomph"
 *
 * The body outlasts the transient by an order of magnitude. That ratio is the
 * whole difference between a kick you hear and a kick you feel.
 */
export function kick(v: VoiceCtx, at: number, gain: number): void {
  const { ctx } = v;

  const body = env(ctx, at, 0.003, 0.42, gain * 1.15);
  const o = ctx.createOscillator();
  o.type = 'sine';
  o.frequency.setValueAtTime(190, at);
  o.frequency.exponentialRampToValueAtTime(35, at + 0.075);
  o.start(at);
  o.stop(at + 0.48);
  o.connect(body).connect(v.out);

  // The click. Almost inaudible alone, and the kick sounds soft without it.
  const tick = env(ctx, at, 0.001, 0.012, gain * 0.5);
  const t = osc(ctx, 'triangle', 900, at, at + 0.03);
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 400;
  t.connect(hp).connect(tick).connect(v.out);
}

/**
 * The bassline. A short plucked saw through a resonant lowpass — the sound the
 * whole genre is built on, and the layer that turns a beat into a track.
 */
export interface BassVoice {
  wave: OscillatorType;
  q: number;
  brightness: number;
}

export function bass(
  v: VoiceCtx,
  at: number,
  hz: number,
  gain: number,
  voice: BassVoice,
  dur = 0.16,
): void {
  const { ctx } = v;
  const g = env(ctx, at, 0.006, dur, gain * 0.6);

  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.setValueAtTime(Math.min(4200, hz * 14 * voice.brightness), at);
  filter.frequency.exponentialRampToValueAtTime(
    Math.max(70, hz * 2.2 * voice.brightness),
    at + dur * 0.8,
  );
  filter.Q.value = voice.q;

  const o = osc(ctx, voice.wave, hz, at, at + dur + 0.06);
  // An octave-down square under everything, for weight the filter cannot remove.
  const o2 = osc(ctx, 'square', hz / 2, at, at + dur + 0.06);
  const subGain = ctx.createGain();
  subGain.gain.value = 0.5;

  o.connect(filter);
  o2.connect(subGain).connect(filter);
  filter.connect(g).connect(v.out);
}

/**
 * A chord, for the occasions that deserve one — a level, a Discovery, a
 * Recompile, the moment Meltdown starts.
 *
 * Detuned saw stack with a slow attack and a long tail: cheap, but it reads as
 * *orchestral* against a track made of blips and kicks, which is the only thing
 * it has to do. Kept rare on purpose. A fanfare you hear every thirty seconds
 * stops marking anything.
 */
export function chord(
  v: VoiceCtx,
  at: number,
  semitones: number[],
  gain: number,
  dur = 2.2,
  wave: OscillatorType = 'sawtooth',
): void {
  const { ctx } = v;

  const bus = ctx.createGain();
  bus.gain.value = 1;

  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.setValueAtTime(400, at);
  filter.frequency.exponentialRampToValueAtTime(4200, at + 0.35);
  filter.frequency.exponentialRampToValueAtTime(900, at + dur);
  filter.Q.value = 1.2;

  const g = env(ctx, at, 0.09, dur, gain * 0.24);
  bus.connect(filter).connect(g).connect(v.out);

  for (const semi of semitones) {
    const hz = semiHz(semi + 24);
    // Three voices per note, detuned. The beating between them is the "ensemble"
    // — one oscillator per note would sound like an organ.
    for (const cents of [-7, 0, 7]) {
      const o = osc(ctx, wave, hz * Math.pow(2, cents / 1200), at, at + dur + 0.3);
      const vg = ctx.createGain();
      vg.gain.value = 0.33;
      o.connect(vg).connect(bus);
    }
  }
}

export function pad(
  v: VoiceCtx,
  at: number,
  semitones: number[],
  gain: number,
  dur: number,
  wave: OscillatorType = 'sawtooth',
): void {
  const { ctx } = v;
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = 1400;
  filter.Q.value = 0.8;

  const g = env(ctx, at, dur * 0.35, dur * 0.65, gain * 0.1);
  filter.connect(g).connect(v.out);

  for (const semi of semitones) {
    const hz = semiHz(semi + 12);
    for (const cents of [-11, 11]) {
      const o = osc(ctx, wave, hz * Math.pow(2, cents / 1200), at, at + dur + 0.4);
      const vg = ctx.createGain();
      vg.gain.value = 0.3;
      o.connect(vg).connect(filter);
    }
  }
}

/** Filtered noise burst. `open` lengthens it into an open hat. */
export function hat(v: VoiceCtx, at: number, gain: number, open = false): void {
  const { ctx } = v;
  const dur = open ? 0.16 : 0.035;
  const frames = Math.ceil(ctx.sampleRate * (dur + 0.02));
  const buf = ctx.createBuffer(1, frames, ctx.sampleRate);
  const data = buf.getChannelData(0);
  // Deterministic-irrelevant: this is presentation, and noise is noise.
  for (let i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1;

  const src = ctx.createBufferSource();
  src.buffer = buf;

  const filter = ctx.createBiquadFilter();
  filter.type = 'highpass';
  filter.frequency.value = 7000;

  const g = env(ctx, at, 0.001, dur, gain * 0.16);
  src.connect(filter).connect(g).connect(v.out);
  src.start(at);
  src.stop(at + dur + 0.02);
}

/** Sub pulse under the kick — the low end that makes it feel like a room. */
export function sub(v: VoiceCtx, at: number, hz: number, gain: number, dur = 0.5): void {
  const { ctx } = v;
  const g = env(ctx, at, 0.02, dur, gain * 0.45);
  const o = osc(ctx, 'sine', hz, at, at + dur + 0.1);
  o.connect(g).connect(v.out);
}

/**
 * §18.3 — "the only *non-musical* sound in the game". Unquantized, unpitched,
 * dry. It must feel wrong on purpose: everything else in the mix is on the grid
 * and in the scale, so a clip that is neither is unmistakable even at 40 voices.
 */
export function hurt(v: VoiceCtx, at: number, gain: number): void {
  const { ctx } = v;
  const frames = Math.ceil(ctx.sampleRate * 0.12);
  const buf = ctx.createBuffer(1, frames, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < frames; i++) {
    // Decaying noise with a bit-crushed edge — deliberately cheap and ugly.
    const t = i / frames;
    const step = Math.round((Math.random() * 2 - 1) * 5) / 5;
    data[i] = step * Math.pow(1 - t, 2.5);
  }
  const src = ctx.createBufferSource();
  src.buffer = buf;

  const filter = ctx.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.value = 900;
  filter.Q.value = 0.7;

  const g = ctx.createGain();
  g.gain.value = gain * 0.7;
  src.connect(filter).connect(g).connect(v.out);
  src.start(at);
}

/** Level-up / discovery: a rising arpeggio, always the same shape. */
export function chime(v: VoiceCtx, at: number, gain: number): void {
  for (let i = 0; i < 4; i++) {
    voltaic(v, at + i * 0.055, noteHz(12 + i * 2), gain * 0.8);
  }
}
