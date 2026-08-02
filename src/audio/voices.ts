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
import type { PartVoice } from './parts';

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

export type PercVoice = 'clap' | 'snare' | 'rim';

/**
 * The backbeat, on 2 and 4. Three instruments, because this is the loudest
 * recurring sound after the kick and reusing one clap across every track is
 * most of why they sounded alike.
 *
 *   clap   many hands not quite together — three bursts a few ms apart.
 *   snare  noise over a tuned body. Harder, more forward, rock-adjacent.
 *   rim    a short woody tick. Almost nothing, which is the dub move.
 */
export function perc(v: VoiceCtx, at: number, gain: number, voice: PercVoice = 'clap'): void {
  if (voice === 'snare') return snare(v, at, gain);
  if (voice === 'rim') return rim(v, at, gain);
  return clap(v, at, gain);
}

function snare(v: VoiceCtx, at: number, gain: number): void {
  const { ctx } = v;
  const dur = 0.16;

  const frames = Math.ceil(ctx.sampleRate * (dur + 0.02));
  const buf = ctx.createBuffer(1, frames, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < frames; i++) {
    data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / frames, 2.2);
  }
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 1800;
  const ng = ctx.createGain();
  ng.gain.value = gain * 0.26;
  src.connect(hp).connect(ng).connect(v.out);
  src.start(at);
  src.stop(at + dur + 0.02);

  // The tuned body is what separates a snare from a burst of noise.
  const bodyGain = env(ctx, at, 0.002, 0.09, gain * 0.18);
  const o = osc(ctx, 'triangle', 190, at, at + 0.13);
  const o2 = osc(ctx, 'triangle', 285, at, at + 0.13);
  const og = ctx.createGain();
  og.gain.value = 0.5;
  o.connect(bodyGain);
  o2.connect(og).connect(bodyGain);
  bodyGain.connect(v.out);
}

function rim(v: VoiceCtx, at: number, gain: number): void {
  const { ctx } = v;
  const g = env(ctx, at, 0.001, 0.035, gain * 0.3);
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = 1750;
  bp.Q.value = 7;
  const o = osc(ctx, 'square', 1750, at, at + 0.06);
  const o2 = osc(ctx, 'square', 470, at, at + 0.06);
  const og = ctx.createGain();
  og.gain.value = 0.5;
  o.connect(bp);
  o2.connect(og).connect(bp);
  bp.connect(g).connect(v.out);
}

function clap(v: VoiceCtx, at: number, gain: number): void {
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

export type StabVoice = 'organ' | 'saw' | 'dub';

/**
 * The stab: a short, hard chord hit on an offbeat. Detroit's whole personality
 * in one voice — most of what people hear as "the melody" in techno is this.
 *
 *   organ  stacked sines at octave and fifth, no filter movement. Hammond by
 *          way of a drawbar. Warm, and unmistakably not a saw.
 *   saw    detuned saws through a falling lowpass. Bright, aggressive.
 *   dub    heavily filtered and short, meant to be fed to a delay and heard
 *          mostly as its own echoes. See the delay bus in audio.ts.
 */
export function stab(
  v: VoiceCtx,
  at: number,
  semitones: number[],
  gain: number,
  voice: StabVoice = 'saw',
): void {
  const { ctx } = v;

  if (voice === 'organ') {
    const dur = 0.17;
    const g = env(ctx, at, 0.004, dur, gain * 0.1);
    g.connect(v.out);
    for (const semi of semitones) {
      // Drawbar registration: fundamental, octave, and the fifth above that.
      for (const [mult, level] of [[1, 1], [2, 0.5], [3, 0.28]] as const) {
        const o = osc(ctx, 'sine', semiHz(semi + 24) * mult, at, at + dur + 0.05);
        const vg = ctx.createGain();
        vg.gain.value = level * 0.33;
        o.connect(vg).connect(g);
      }
    }
    return;
  }

  const dub = voice === 'dub';
  const dur = dub ? 0.1 : 0.14;
  const g = env(ctx, at, 0.003, dur, gain * (dub ? 0.16 : 0.13));

  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.setValueAtTime(dub ? 1500 : 5200, at);
  filter.frequency.exponentialRampToValueAtTime(dub ? 500 : 1100, at + dur);
  filter.Q.value = dub ? 2 : 4;
  filter.connect(g).connect(v.out);

  for (const semi of semitones) {
    const hz = semiHz(semi + 24);
    for (const cents of [-6, 6]) {
      const o = osc(ctx, dub ? 'triangle' : 'sawtooth', hz * Math.pow(2, cents / 1200), at, at + dur + 0.05);
      const vg = ctx.createGain();
      vg.gain.value = 0.4;
      o.connect(vg).connect(filter);
    }
  }
}

export type LeadVoice = 'pluck' | 'acid' | 'bell';

/**
 * One note of the repeating motif — the closest this game has to a tune.
 *
 *   pluck  saw + octave square through a snappy filter. Bright, percussive.
 *   acid   the 303 again but an octave up and shorter: reedy and vocal, and it
 *          slides, which is what makes a line sound *played* rather than
 *          sequenced.
 *   bell   two-operator FM at a non-integer ratio. Glassy, long, unhurried.
 */
export function motif(
  v: VoiceCtx,
  at: number,
  hz: number,
  gain: number,
  voice: LeadVoice = 'pluck',
  glideFrom = 0,
): void {
  const { ctx } = v;

  if (voice === 'bell') {
    const dur = 0.75;
    const g = env(ctx, at, 0.006, dur, gain * 0.07);
    const carrier = osc(ctx, 'sine', hz, at, at + dur + 0.1);
    const mod = osc(ctx, 'sine', hz * 2.41, at, at + dur + 0.1);
    const depth = ctx.createGain();
    depth.gain.setValueAtTime(hz * 2.4, at);
    depth.gain.exponentialRampToValueAtTime(hz * 0.05, at + dur * 0.7);
    mod.connect(depth);
    depth.connect(carrier.frequency);
    carrier.connect(g).connect(v.out);
    return;
  }

  if (voice === 'acid') {
    const dur = 0.22;
    const g = env(ctx, at, 0.004, dur, gain * 0.075);
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.Q.value = 14;
    filter.frequency.setValueAtTime(hz * 1.6, at);
    filter.frequency.exponentialRampToValueAtTime(Math.min(9000, hz * 9), at + 0.02);
    filter.frequency.exponentialRampToValueAtTime(hz * 2, at + dur * 0.7);

    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    if (glideFrom > 0) {
      o.frequency.setValueAtTime(glideFrom, at);
      o.frequency.exponentialRampToValueAtTime(hz, at + 0.05);
    } else {
      o.frequency.setValueAtTime(hz, at);
    }
    o.start(at);
    o.stop(at + dur + 0.06);
    o.connect(filter).connect(g).connect(v.out);
    return;
  }

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

export type KickVoice = 'punch' | 'tight' | 'deep';

/**
 * Kicks. Three parts each — a click transient so it cuts a busy mix, a fast
 * pitch drop the ear reads as "hit", and a body the chest reads as weight — but
 * the *proportions* are what make them different drums rather than one drum with
 * a knob on it.
 *
 *   punch  classic house. Mid decay, present click, sits forward.
 *   tight  909-ish. Short, hard, heavily clicked; leaves room for sixteenths.
 *   deep   dub. Long, soft, almost no click. Felt more than heard.
 */
export function kick(v: VoiceCtx, at: number, gain: number, voice: KickVoice = 'punch'): void {
  const { ctx } = v;
  const spec = {
    punch: { from: 190, to: 35, drop: 0.075, decay: 0.42, click: 0.5, clickHz: 900 },
    tight: { from: 220, to: 44, drop: 0.045, decay: 0.19, click: 0.85, clickHz: 1600 },
    deep: { from: 120, to: 28, drop: 0.13, decay: 0.85, click: 0.12, clickHz: 420 },
  }[voice];

  const body = env(ctx, at, 0.003, spec.decay, gain * 1.15);
  const o = ctx.createOscillator();
  o.type = 'sine';
  o.frequency.setValueAtTime(spec.from, at);
  o.frequency.exponentialRampToValueAtTime(spec.to, at + spec.drop);
  o.start(at);
  o.stop(at + spec.decay + 0.08);
  o.connect(body).connect(v.out);

  const tick = env(ctx, at, 0.001, 0.012, gain * spec.click);
  const t = osc(ctx, 'triangle', spec.clickHz, at, at + 0.03);
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 400;
  t.connect(hp).connect(tick).connect(v.out);
}

export type BassVoice = 'pluck' | 'acid' | 'sub';

export interface BassSpec {
  voice: BassVoice;
  q: number;
  brightness: number;
  /** True on accented steps — 303 accents are most of what makes acid move. */
  accent?: boolean;
  /** Glide from this frequency, in seconds. 0 for no slide. */
  glideFrom?: number;
}

/**
 * Basslines. Three genuinely different instruments, not one with a filter knob:
 *
 *   pluck  saw + octave-down square through a moderate lowpass. Round, warm,
 *          stays out of the way. The house default.
 *   acid   a 303: one saw, a *steep* resonant lowpass, and a filter envelope
 *          per note. The squelch is the envelope, not the resonance — that is
 *          the part everyone gets wrong. Accents open it further and hit
 *          harder; glide slurs one note into the next.
 *   sub    almost a sine. Long, slow, no filter movement at all. Dub bass is a
 *          pitch you feel arriving and leaving, not a note you hear played.
 */
export function bass(
  v: VoiceCtx,
  at: number,
  hz: number,
  gain: number,
  spec: BassSpec,
  dur = 0.16,
): void {
  const { ctx } = v;

  if (spec.voice === 'sub') {
    const long = dur * 3.2;
    const g = env(ctx, at, 0.02, long, gain * 0.75);
    const o = osc(ctx, 'sine', hz, at, at + long + 0.1);
    const o2 = osc(ctx, 'triangle', hz, at, at + long + 0.1);
    const og = ctx.createGain();
    og.gain.value = 0.25;
    o.connect(g);
    o2.connect(og).connect(g);
    g.connect(v.out);
    return;
  }

  if (spec.voice === 'acid') {
    const accented = spec.accent === true;
    const length = accented ? dur * 1.35 : dur;
    const g = env(ctx, at, 0.004, length, gain * (accented ? 0.75 : 0.5));

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.Q.value = spec.q;
    // The envelope is the sound: snap wide open, collapse fast. An accent
    // opens further and decays slower, which is the whole 303 vocabulary.
    const peak = Math.min(7000, hz * (accented ? 26 : 15) * spec.brightness);
    filter.frequency.setValueAtTime(Math.max(90, hz * 1.4), at);
    filter.frequency.exponentialRampToValueAtTime(peak, at + 0.012);
    filter.frequency.exponentialRampToValueAtTime(
      Math.max(80, hz * 1.6),
      at + length * (accented ? 0.9 : 0.55),
    );

    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    if (spec.glideFrom) {
      o.frequency.setValueAtTime(spec.glideFrom, at);
      o.frequency.exponentialRampToValueAtTime(hz, at + 0.055);
    } else {
      o.frequency.setValueAtTime(hz, at);
    }
    o.start(at);
    o.stop(at + length + 0.06);
    o.connect(filter).connect(g).connect(v.out);
    return;
  }

  const g = env(ctx, at, 0.006, dur, gain * 0.6);
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.setValueAtTime(Math.min(4200, hz * 14 * spec.brightness), at);
  filter.frequency.exponentialRampToValueAtTime(
    Math.max(70, hz * 2.2 * spec.brightness),
    at + dur * 0.8,
  );
  filter.Q.value = spec.q;

  const o = osc(ctx, 'sawtooth', hz, at, at + dur + 0.06);
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

// ---------------------------------------------------------------- part voices

/**
 * One note of a Program's part. GDD §18.1 — see `parts.ts` for why a Program is
 * a musical part at all.
 *
 * Each voice is picked so the sound matches what the Action *looks* like in the
 * arena: a Bolt is a pluck, a Nova is a low burst, a Field is a drone that sits
 * there, a Pull falls. Nobody needs to be taught the mapping; it lines up.
 */
export function playPart(
  v: VoiceCtx,
  voice: PartVoice,
  at: number,
  hz: number,
  gain: number,
  length: number,
  bite: number,
  glideFrom = 0,
): void {
  const { ctx } = v;

  switch (voice) {
    case 'pluck':
      return motif(v, at, hz, gain, 'pluck');
    case 'acid':
      return motif(v, at, hz, gain, 'acid', glideFrom);
    case 'bell':
      return motif(v, at, hz, gain, 'bell');

    case 'stab': {
      // A low burst: short, fat, and felt. This is Nova.
      const dur = 0.22 * length;
      const g = env(ctx, at, 0.004, dur, gain * 0.34);
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(Math.min(4000, hz * (7 + bite * 10)), at);
      filter.frequency.exponentialRampToValueAtTime(Math.max(60, hz * 1.5), at + dur * 0.7);
      filter.Q.value = 5;
      const o = osc(ctx, 'sawtooth', hz, at, at + dur + 0.06);
      const o2 = osc(ctx, 'sine', hz / 2, at, at + dur + 0.06);
      const og = ctx.createGain();
      og.gain.value = 0.6;
      o.connect(filter);
      o2.connect(og).connect(filter);
      filter.connect(g).connect(v.out);
      return;
    }

    case 'drone': {
      // A tone that stays. Field and Beam persist in the arena, so they persist
      // here — but gated by the step so it still belongs to the grid rather
      // than floating over it the way the old pad did.
      const dur = 0.55 * length;
      const g = env(ctx, at, 0.02, dur, gain * 0.13);
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = hz * (3 + bite * 6);
      filter.Q.value = 2.5;
      for (const cents of [-9, 9]) {
        const o = osc(ctx, 'sawtooth', hz * Math.pow(2, cents / 1200), at, at + dur + 0.1);
        const vg = ctx.createGain();
        vg.gain.value = 0.4;
        o.connect(vg).connect(filter);
      }
      filter.connect(g).connect(v.out);
      return;
    }

    case 'tick': {
      // A placed object arming: woody, dry, short. Mine and Rupture.
      const dur = 0.06 * length;
      const g = env(ctx, at, 0.001, dur, gain * 0.3);
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = hz * 3;
      bp.Q.value = 9;
      const o = osc(ctx, 'square', hz * 3, at, at + dur + 0.03);
      o.connect(bp).connect(g).connect(v.out);
      return;
    }

    case 'sweep': {
      // Falls. Pull drags everything toward a point, so the note does too.
      const dur = 0.34 * length;
      const g = env(ctx, at, 0.01, dur, gain * 0.18);
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(hz * 2.6, at);
      o.frequency.exponentialRampToValueAtTime(Math.max(40, hz * 0.55), at + dur);
      o.start(at);
      o.stop(at + dur + 0.06);
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 2400;
      filter.Q.value = 6;
      o.connect(filter).connect(g).connect(v.out);
      return;
    }

    case 'noise': {
      // Displacement, not damage. Shove is a push of air.
      const dur = 0.1 * length;
      const frames = Math.ceil(ctx.sampleRate * (dur + 0.02));
      const buf = ctx.createBuffer(1, frames, ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < frames; i++) {
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / frames, 1.6);
      }
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = Math.max(180, hz * 2);
      bp.Q.value = 1.1;
      const g = ctx.createGain();
      g.gain.value = gain * 0.16;
      src.connect(bp).connect(g).connect(v.out);
      src.start(at);
      src.stop(at + dur + 0.02);
      return;
    }

    case 'riser': {
      // Surge speeds the engine up, so its note climbs.
      const dur = 0.3 * length;
      const g = env(ctx, at, 0.02, dur, gain * 0.12);
      const o = ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.setValueAtTime(hz * 0.6, at);
      o.frequency.exponentialRampToValueAtTime(hz * 1.9, at + dur);
      o.start(at);
      o.stop(at + dur + 0.06);
      o.connect(g).connect(v.out);
      return;
    }

    case 'organ': {
      const dur = 0.2 * length;
      const g = env(ctx, at, 0.005, dur, gain * 0.15);
      g.connect(v.out);
      for (const [mult, level] of [[1, 1], [2, 0.5], [3, 0.3]] as const) {
        const o = osc(ctx, 'sine', hz * mult, at, at + dur + 0.05);
        const vg = ctx.createGain();
        vg.gain.value = level * 0.33;
        o.connect(vg).connect(g);
      }
      return;
    }
  }
}

/**
 * A chord that *hits*.
 *
 * The old pad had a two-second attack on an eight-bar chord: it swelled with no
 * relationship to the grid, which is exactly what "ethereal, no connection"
 * describes. Harmony in this genre is carried rhythmically — by stabs, by the
 * bass, by a chord chopped into the sixteenths. So this one has a hard attack
 * and a gate, and lands *on* the beat instead of drifting across it.
 */
export function gatedChord(
  v: VoiceCtx,
  at: number,
  semitones: number[],
  gain: number,
  dur: number,
  wave: OscillatorType = 'sawtooth',
): void {
  const { ctx } = v;
  const g = env(ctx, at, 0.006, dur, gain * 0.13);

  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.setValueAtTime(3400, at);
  filter.frequency.exponentialRampToValueAtTime(900, at + dur);
  filter.Q.value = 2.2;
  filter.connect(g).connect(v.out);

  for (const semi of semitones) {
    const hz = semiHz(semi + 24);
    for (const cents of [-5, 5]) {
      const o = osc(ctx, wave, hz * Math.pow(2, cents / 1200), at, at + dur + 0.05);
      const vg = ctx.createGain();
      vg.gain.value = 0.3;
      o.connect(vg).connect(filter);
    }
  }
}
