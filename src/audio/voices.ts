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
 * An engine event, as a note. Depth climbs the scale, which is why a deep
 * cascade audibly *rises* — the one thing the depth counter cannot convey.
 */
export function playHue(v: VoiceCtx, hue: Hue, at: number, degree: number, gain: number): void {
  HUE_VOICE[hue](v, at, noteHz(degree), gain);
}

// -------------------------------------------------------------- the backing

/** Four-on-the-floor kick: pitch drop into a short body. */
export function kick(v: VoiceCtx, at: number, gain: number): void {
  const { ctx } = v;
  const g = env(ctx, at, 0.002, 0.28, gain);
  const o = ctx.createOscillator();
  o.type = 'sine';
  o.frequency.setValueAtTime(150, at);
  o.frequency.exponentialRampToValueAtTime(42, at + 0.09);
  o.start(at);
  o.stop(at + 0.34);
  o.connect(g).connect(v.out);
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
