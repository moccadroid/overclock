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
import type { VoiceTuning } from './score';

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

/**
 * Where a voice plays, and how it is tuned.
 *
 * `tuning` rides along here rather than being a parameter on every voice, and
 * that is the whole reason this refactor did not have to touch thirty
 * signatures and their call sites: `VoiceCtx` already threads through every
 * voice in the file, and `Audio.voice()` builds it in one place.
 *
 * A module-level `setVoiceTuning()` would have been the other option — there is
 * precedent for it in `setUserCells` — but a hidden global that every voice
 * silently depends on is exactly the thing that makes two Scores hard to reason
 * about. Required rather than optional so nothing can forget it.
 */
export interface VoiceCtx {
  ctx: AudioContext;
  out: AudioNode;
  tuning: VoiceTuning;
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

export type PercVoice = 'clap' | 'snare' | 'rim' | 'anvil';

/**
 * The backbeat. Four instruments, because this is the loudest recurring sound
 * after the kick and reusing one clap across every track is most of why they
 * sounded alike.
 *
 *   clap   many hands not quite together — three bursts a few ms apart.
 *   snare  noise over a tuned body. Harder, more forward, rock-adjacent.
 *   rim    a short woody tick. Almost nothing, which is the dub move.
 *   anvil  struck metal. Inharmonic and long — see below.
 */
export function perc(v: VoiceCtx, at: number, gain: number, voice: PercVoice = 'clap'): void {
  if (voice === 'snare') return snare(v, at, gain);
  if (voice === 'rim') return rim(v, at, gain);
  if (voice === 'anvil') return anvil(v, at, gain);
  return clap(v, at, gain);
}

/**
 * Struck metal, and the single voice that decides whether a score sounds
 * industrial.
 *
 * A clap and a snare are *noise* shaped by a filter, which is why every kit
 * built from them lands somewhere between house and rock however it is tuned.
 * Metal is not noise: it is a small number of loud, **inharmonic** partials that
 * ring at different rates, and the inharmonicity is the whole thing. The ratios
 * below are deliberately not integers — an integer stack is a musical note, and
 * a musical note is exactly what an anvil is not.
 *
 * Long, too. It rings for the best part of a second and gets *out of the way* of
 * nothing, which is the point: this is a sound that damages the room rather than
 * marking a beat inside it.
 *
 * The grit is ring modulation, not distortion, and that is not a stylistic
 * choice — §18.4 bans anything that can raise RMS. A ring modulator multiplies,
 * so it can only ever move energy around; it cannot turn the game up.
 */
function anvil(v: VoiceCtx, at: number, gain: number): void {
  const { ctx } = v;

  const bus = ctx.createGain();
  bus.gain.value = gain * 0.13;

  // A ceiling, because inharmonic partials throw energy high and the top of
  // this would otherwise be the harshest thing in the game.
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 5200;
  lp.Q.value = 0.6;
  bus.connect(lp).connect(v.out);

  // Ring modulation at a low, slightly detuned rate — the sidebands land
  // between the partials and read as the metal being *struck badly*.
  const ring = ctx.createGain();
  ring.gain.value = 0;
  const mod = osc(ctx, 'sine', 63, at, at + 1.2);
  const depth = ctx.createGain();
  depth.gain.value = 1;
  mod.connect(depth).connect(ring.gain);
  ring.connect(bus);

  // Five partials at non-integer ratios, each ringing at its own rate: the high
  // ones die first, which is what makes a struck object sound struck.
  for (const [ratio, level, decay] of [
    [1, 1, 0.9],
    [2.37, 0.62, 0.62],
    [3.41, 0.44, 0.4],
    [4.83, 0.3, 0.26],
    [6.19, 0.2, 0.17],
  ] as const) {
    const g = env(ctx, at, 0.001, decay, level * 0.5);
    const o = osc(ctx, 'sine', 210 * ratio, at, at + decay + 0.1);
    o.connect(g).connect(ring);
  }

  // The strike itself: a very short noise transient, band-limited so it reads as
  // impact rather than as a click.
  const frames = Math.ceil(ctx.sampleRate * 0.05);
  const buf = ctx.createBuffer(1, frames, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < frames; i++) {
    data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / frames, 4);
  }
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = 2600;
  bp.Q.value = 1.1;
  const hitGain = ctx.createGain();
  hitGain.gain.value = gain * 0.3;
  src.connect(bp).connect(hitGain).connect(lp);
  src.start(at);
  src.stop(at + 0.07);
}

function snare(v: VoiceCtx, at: number, gain: number): void {
  const { ctx } = v;
  const dur = 0.16;

  const frames = Math.ceil(ctx.sampleRate * (dur + 0.02));
  const buf = ctx.createBuffer(1, frames, ctx.sampleRate);
  const data = buf.getChannelData(0);
  // Decays faster than it used to. A long noise tail on a sound that lands twice
  // a bar is the difference between a snare and a hiss.
  for (let i = 0; i < frames; i++) {
    data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / frames, 2.9);
  }
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 1500;
  // The fix for "jarring". A highpass alone passes everything from its corner to
  // Nyquist at full level, so this was white noise with the bottom removed and
  // no ceiling at all — bright, flat and fatiguing, and worst on the sparse
  // patterns where nothing else is covering it. Every other voice in here has a
  // top rolloff; the snare was the one that did not. A real snare has almost
  // nothing above 8k.
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 6200;
  lp.Q.value = 0.5;
  const ng = ctx.createGain();
  ng.gain.value = gain * 0.2;
  src.connect(hp).connect(lp).connect(ng).connect(v.out);
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
  // Quieter than it was. This is the first thing anyone hears — it plays under
  // the title screen — and it was landing on top of an arrangement built to be
  // heard *behind* a game.
  bus.gain.value = gain * 0.22;

  const filter = ctx.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.value = 1500;
  filter.Q.value = 0.9;
  // The snare's fault, again: a Q of 0.9 is barely a filter, so this was noise
  // with a gentle tilt and no ceiling, and the 3-8k band it left through is
  // exactly where "jarring" lives. Measured: harsh-band energy down 2.2x against
  // 2.0x overall, so it is duller *relative to itself*, not merely quieter.
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 4200;
  lp.Q.value = 0.5;
  bus.connect(filter).connect(lp).connect(v.out);

  for (const [offset, level, dur] of [
    [0, 1, 0.02],
    [0.009, 0.75, 0.02],
    [0.019, 0.6, 0.14],
  ] as const) {
    const frames = Math.ceil(ctx.sampleRate * (dur + 0.02));
    const buf = ctx.createBuffer(1, frames, ctx.sampleRate);
    const data = buf.getChannelData(0);
    // A 2 ms rise on each burst. An instantaneous noise onset is a broadband
    // step — the same thing that made the UI ticks pierce — and two thousandths
    // of a second is inaudible as softness but audible as *not a click*.
    const rise = Math.max(1, Math.round(ctx.sampleRate * 0.002));
    for (let i = 0; i < frames; i++) {
      data[i] =
        (Math.random() * 2 - 1) * Math.pow(1 - i / frames, 3) * Math.min(1, i / rise);
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
 * Vowels. The second synthesis method the game did not have.
 *
 * A lowpass filter says "how bright"; it cannot say "what". A bank of narrow
 * resonators at fixed absolute frequencies says *what* — because that is
 * physically what a throat is, and the ear has a dedicated, unmissable response
 * to it. Three bandpasses at the right frequencies and a sawtooth stops sounding
 * like a synthesiser and starts sounding like somebody.
 *
 * Crucially the formants do **not** track the pitch. That is the whole trick and
 * the thing that separates this from every other voice here: sing higher and your
 * mouth stays the same shape, so the resonances stay put while the source moves
 * under them. Track them with the note and it collapses back into a filter sweep.
 *
 * The vowel morphs across the note, which is what makes it read as a word rather
 * than a chord — and unsettling rather than pretty, which is the point.
 */
const VOWELS = {
  // f1, f2, f3 — the standard measured formants, near enough.
  ah: [800, 1150, 2900],
  oh: [450, 800, 2830],
  oo: [325, 700, 2530],
  ee: [270, 2290, 3010],
} as const;

function formantVoice(
  v: VoiceCtx,
  at: number,
  hz: number,
  gain: number,
  seconds: number,
  from: keyof typeof VOWELS,
  to: keyof typeof VOWELS,
): void {
  const { ctx } = v;
  const a = VOWELS[from];
  const b = VOWELS[to];

  /**
   * A fast onset, and this is the fix for "half the song is playing in reverse".
   *
   * The first version faded in over 18% of the note — 288ms on the chord voice.
   * A slow fade-in *is* what a reversed sound is; the ear identifies a sound by
   * its attack, and if the attack is a swell then every note arrives backwards.
   * Stacked on an offbeat stab pattern with a five-second reverb behind it, the
   * whole mix became a wash with no front edge.
   *
   * This is also a mistake this codebase had already made and already fixed —
   * `gatedChord` exists because the old pad "swelled with no relationship to the
   * grid, which is exactly what 'ethereal, no connection' describes". A voice
   * needs a consonant, not a crescendo.
   */
  const g = env(ctx, at, 0.012, seconds, gain);
  g.connect(v.out);

  // The consonant: a very short noise transient through the same formants, so
  // the note has a front edge without stopping sounding like a throat.
  const conFrames = Math.ceil(ctx.sampleRate * 0.035);
  const conBuf = ctx.createBuffer(1, conFrames, ctx.sampleRate);
  const conData = conBuf.getChannelData(0);
  for (let i = 0; i < conFrames; i++) {
    conData[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / conFrames, 3);
  }
  const con = ctx.createBufferSource();
  con.buffer = conBuf;
  const conGain = ctx.createGain();
  conGain.gain.value = 0.5;
  con.start(at);
  con.stop(at + 0.05);

  // The source: two saws a few cents apart. The beating between them is what
  // makes one voice sound like several, which is what makes it a choir.
  const bus = ctx.createGain();
  bus.gain.value = 0.5;
  for (const cents of [-8, 8]) {
    const o = osc(ctx, 'sawtooth', hz * Math.pow(2, cents / 1200), at, at + seconds + 0.15);
    o.connect(bus);
  }
  // A slow, shallow wobble. Nothing human holds a pitch perfectly still, and the
  // absence of that is most of what makes a synth pad sound synthetic.
  const lfo = osc(ctx, 'sine', 4.6, at, at + seconds + 0.15);
  const lfoDepth = ctx.createGain();
  lfoDepth.gain.value = hz * 0.006;
  lfo.connect(lfoDepth);

  for (let i = 0; i < 3; i++) {
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(a[i]!, at);
    bp.frequency.linearRampToValueAtTime(b[i]!, at + seconds * 0.7);
    // Narrow, and narrower for the lower formants, which is what makes the vowel
    // legible rather than merely coloured.
    bp.Q.value = 9 - i * 2.2;
    lfoDepth.connect(bp.frequency);

    const level = ctx.createGain();
    // The first formant carries the vowel; the third is air.
    level.gain.value = [1, 0.55, 0.24][i]!;
    bus.connect(bp).connect(level).connect(g);
    // The consonant goes through the same throat, so the front edge belongs to
    // the voice rather than sitting on top of it as a click.
    con.connect(conGain).connect(bp);
  }
}

export type StabVoice = 'organ' | 'saw' | 'dub' | 'hit' | 'choir';

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
  const S = v.tuning.stab;

  /**
   * Not a chord. A press.
   *
   * The other three are all *harmony delivered rhythmically* — the genre's usual
   * trick, and the reason the stab reads as "the melody" in a techno track. This
   * one keeps the pitch (it still takes the chord's root, so it cannot clash)
   * but delivers it as a **hydraulic impact**: a short inharmonic ring over a
   * noise burst that closes fast.
   *
   * It is the one melodic slot in the mix, spent on something that is barely
   * melodic. That is the trade a genuinely industrial score makes.
   */
  /**
   * The chord, sung.
   *
   * Every note of it gets its own throat, and each one lands on a different
   * vowel — so the "chord" is three voices holding three different sounds rather
   * than one instrument playing three notes. Long, because a voice that stops
   * dead is a synth again.
   */
  if (voice === 'choir') {
    const dur = 1.6;
    const shapes = [
      ['oh', 'ah'],
      ['oo', 'oh'],
      ['ah', 'ee'],
    ] as const;
    for (let i = 0; i < semitones.length; i++) {
      const [from, to] = shapes[i % shapes.length]!;
      formantVoice(
        v,
        at,
        semiHz(semitones[i]! + 12),
        gain * 0.055,
        dur,
        from,
        to,
      );
    }
    return;
  }

  if (voice === 'hit') {
    const dur = 0.26;
    const g = env(ctx, at, 0.002, dur, gain * 0.11);

    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(1800, at);
    bp.frequency.exponentialRampToValueAtTime(430, at + dur);
    bp.Q.value = 1.4;
    bp.connect(g).connect(v.out);

    const root = semiHz((semitones[0] ?? 0) + 24);
    // Two partials a tritone-ish apart, which is the interval that refuses to
    // resolve, over the chord root so it still belongs to the harmony.
    for (const [ratio, level] of [
      [1, 0.5],
      [1.414, 0.34],
      [2.83, 0.2],
    ] as const) {
      const o = osc(ctx, 'square', root * ratio, at, at + dur + 0.05);
      const og = ctx.createGain();
      og.gain.value = level;
      o.connect(og).connect(bp);
    }

    const frames = Math.ceil(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, frames, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < frames; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / frames, 3.4);
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const ng = ctx.createGain();
    ng.gain.value = 0.7;
    src.connect(ng).connect(bp);
    src.start(at);
    src.stop(at + dur + 0.02);
    return;
  }

  if (voice === 'organ') {
    const O = S.organ;
    const dur = O.length;
    const g = env(ctx, at, O.attack, dur, gain * O.gain);
    g.connect(v.out);
    for (const semi of semitones) {
      // Drawbar registration: fundamental, octave, and the fifth above that.
      for (const [mult, level] of O.drawbar) {
        const o = osc(ctx, 'sine', semiHz(semi + O.register) * mult, at, at + dur + 0.05);
        const vg = ctx.createGain();
        vg.gain.value = level * O.level;
        o.connect(vg).connect(g);
      }
    }
    return;
  }

  const F = S.filtered[voice === 'dub' ? 'dub' : 'saw'];
  const dur = F.length;
  const g = env(ctx, at, S.attack, dur, gain * F.gain);

  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.setValueAtTime(F.open, at);
  filter.frequency.exponentialRampToValueAtTime(F.close, at + dur);
  filter.Q.value = F.q;
  filter.connect(g).connect(v.out);

  for (const semi of semitones) {
    const hz = semiHz(semi + S.register);
    for (const cents of [-S.detune, S.detune]) {
      const o = osc(ctx, F.wave, hz * Math.pow(2, cents / 1200), at, at + dur + 0.05);
      const vg = ctx.createGain();
      vg.gain.value = S.level;
      o.connect(vg).connect(filter);
    }
  }
}

export type LeadVoice = 'pluck' | 'acid' | 'bell' | 'voice' | 'blip';

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

  /**
   * The melody, sung.
   *
   * The one slot in the mix the ear is already listening to for a tune, spent on
   * a throat instead of an oscillator. Because the formants stay put while the
   * pitch moves, a line played through this reads as *one voice singing several
   * notes* rather than as a synth being transposed — and that is a categorically
   * different thing to hear, not a differently-filtered version of the same one.
   */
  if (voice === 'voice') {
    formantVoice(v, at, hz, gain * 0.085, 0.68, 'oo', 'ah');
    return;
  }

  /**
   * Cold, and mostly a click.
   *
   * The other four leads are all *expressive* — a pluck decays like a string, an
   * acid line slides, a bell rings, the formant sings. That is the wrong register
   * for minimal techno, where the melodic part is closer to a percussion
   * instrument that happens to have a pitch: you are meant to hear the placement
   * first and the note second.
   *
   * So: a square with a half-millisecond attack and a fifty-millisecond decay,
   * band-limited at both ends, one octave partial for the metallic edge a click
   * needs in order to cut, and *nothing that moves* — no detune, no glide, no
   * filter envelope, no resonance. Every one of those is what makes a synth sound
   * like it is performing. This does not perform; it lands.
   *
   * Deliberately unaffected by `glideFrom`. A blip that slid would be an acid
   * line with a shorter envelope, which the playlist already has.
   */
  if (voice === 'blip') {
    const dur = 0.05;
    // 1.6ms rather than 0.6. A half-millisecond edge on a square is a *transient*
    // — it puts energy well above the note, which is heard as sharpness rather
    // than as attack. This is still an order of magnitude faster than any other
    // lead here, so it still reads as a click; it just stops stinging.
    const g = env(ctx, at, 0.0016, dur, gain * 0.2);

    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 380;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    // 2800, down from 5200. A square already has energy at every odd harmonic;
    // letting the ninth and eleventh through is what made it bright rather than
    // percussive.
    lp.frequency.value = 2800;
    lp.Q.value = 0.5;
    hp.connect(lp).connect(g).connect(v.out);

    const o = osc(ctx, 'square', hz, at, at + dur + 0.02);
    const og = ctx.createGain();
    og.gain.value = 0.5;
    o.connect(og).connect(hp);

    // Half the length, so it reads as the attack of one note rather than as a
    // second note an octave up.
    const o2 = osc(ctx, 'square', hz * 2, at, at + dur * 0.5 + 0.02);
    const o2g = ctx.createGain();
    // Halved. Enough octave to define the click, not enough to whistle.
    o2g.gain.value = 0.08;
    o2.connect(o2g).connect(hp);
    return;
  }

  if (voice === 'bell') {
    // Orbital. Softened, and the reason it was harsh is worth writing down.
    //
    // It was FM at a ratio of 2.41 with a modulation index of 2.4 held for most
    // of the note, and **no filter at all**. An inharmonic ratio at that index
    // throws sidebands a long way either side of the carrier, and every one of
    // them went straight out. Orbital also sits at register +12, and a voltaic
    // build adds another +12 — so the worst case was a dense inharmonic spray
    // two octaves up, which is precisely the band the ear is most sensitive to.
    //
    // Now: a harmonic ratio, an index around 1 that collapses in the first fifth
    // of the note, and a ceiling. That is a struck bell — bright in the attack,
    // a tone immediately after — rather than a tone that keeps screaming.
    const L = v.tuning.lead.bell;
    const dur = L.length;
    const g = env(ctx, at, L.attack, dur, gain * L.gain);
    const carrier = osc(ctx, 'sine', hz, at, at + dur + 0.1);
    const mod = osc(ctx, 'sine', hz * L.ratio, at, at + dur + 0.1);
    const depth = ctx.createGain();
    depth.gain.setValueAtTime(hz * L.depth, at);
    depth.gain.exponentialRampToValueAtTime(hz * L.depthEnd, at + dur * L.collapse);
    mod.connect(depth);
    depth.connect(carrier.frequency);

    // The ceiling every other voice in here already had.
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = Math.min(L.ceiling, hz * L.cutoff);
    lp.Q.value = L.q;
    carrier.connect(lp).connect(g).connect(v.out);
    return;
  }

  if (voice === 'acid') {
    const L = v.tuning.lead.acid;
    const dur = L.length;
    const g = env(ctx, at, L.attack, dur, gain * L.gain);
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.Q.value = L.q;
    filter.frequency.setValueAtTime(hz * L.start, at);
    filter.frequency.exponentialRampToValueAtTime(
      Math.min(L.peakCeiling, hz * L.peak),
      at + L.rise,
    );
    filter.frequency.exponentialRampToValueAtTime(hz * L.land, at + dur * L.fall);

    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    if (glideFrom > 0) {
      o.frequency.setValueAtTime(glideFrom, at);
      o.frequency.exponentialRampToValueAtTime(hz, at + L.glide);
    } else {
      o.frequency.setValueAtTime(hz, at);
    }
    o.start(at);
    o.stop(at + dur + 0.06);
    o.connect(filter).connect(g).connect(v.out);
    return;
  }

  const L = v.tuning.lead.pluck;
  const dur = L.length;
  const g = env(ctx, at, L.attack, dur, gain * L.gain);
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.setValueAtTime(hz * L.open, at);
  filter.frequency.exponentialRampToValueAtTime(hz * L.close, at + dur);
  filter.Q.value = L.q;

  const o = osc(ctx, 'sawtooth', hz, at, at + dur + 0.05);
  const o2 = osc(ctx, 'square', hz * L.octave, at, at + dur + 0.05);
  const og = ctx.createGain();
  og.gain.value = L.octaveLevel;
  o.connect(filter);
  o2.connect(og).connect(filter);
  filter.connect(g).connect(v.out);
}

// -------------------------------------------------------------- the backing

export type KickVoice = 'punch' | 'tight' | 'deep' | 'crush' | 'slam';

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
  if (voice === 'crush') return crushKick(v, at, gain);
  if (voice === 'slam') return slamKick(v, at, gain);
  const { ctx } = v;
  const K = v.tuning.kick;
  // Falls back rather than asserting: a Score is only obliged to tune the kicks
  // it actually selects, and the industrial one carries its own design below.
  const spec = K.spec[voice] ?? K.spec.punch!;

  const body = env(ctx, at, K.attack, spec.decay, gain * K.gain);
  const o = ctx.createOscillator();
  o.type = 'sine';
  o.frequency.setValueAtTime(spec.from, at);
  o.frequency.exponentialRampToValueAtTime(spec.to, at + spec.drop);
  o.start(at);
  o.stop(at + spec.decay + 0.08);
  o.connect(body).connect(v.out);

  const tick = env(ctx, at, K.clickAttack, K.clickDecay, gain * spec.click);
  const t = osc(ctx, 'triangle', spec.clickHz, at, at + 0.03);
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = K.clickHp;
  t.connect(hp).connect(tick).connect(v.out);
}

/**
 * A bass drum with weight and a room around it.
 *
 * The three original kicks are all *dry by construction* — a body, a click, and
 * nothing else. That is correct for a track where the kick's job is to mark time
 * cleanly, and it is why they sound small the moment the kick is supposed to be
 * the loudest thing in the room instead.
 *
 * Two things are missing from them and both are added here.
 *
 * **Harmonics.** A kick landing at 45Hz has the same problem the bass had: a
 * laptop cannot move air at 45Hz, so a pure sine simply vanishes and only the
 * click survives — which is exactly "weak and clicky". A quiet partial an octave
 * up and a short mid knock give the ear something to reconstruct the fundamental
 * *from*, so the same hit reads as deep on a big system and still lands on a
 * small one.
 *
 * **A room.** This is the whole of "dry". A real bass drum is heard in a space:
 * a short, dark burst of reflected energy arriving a few milliseconds behind the
 * hit. Fifteen milliseconds of predelay and a couple of hundred of dark noise is
 * the difference between a drum and a sample of a drum — and unlike a reverb
 * send it stays *inside* the voice, so it cannot smear the rest of the mix the
 * way a tail on the whole low end would.
 */
function slamKick(v: VoiceCtx, at: number, gain: number): void {
  const { ctx } = v;

  /**
   * Peaks, and why they matter more here than anywhere else in the graph.
   *
   * The first version of this stacked a 1.3 body, a 0.3 octave, a 0.4 knock, a
   * 0.3 click and a 0.34 room — all inside about ten milliseconds, for a
   * combined transient near twice `punch`'s. The limiter has a 3ms attack, so a
   * spike that size gets *through* before the compressor reacts and is then
   * clamped hard the moment it does. That is not loudness, it is overload, and
   * it was reported as exactly that.
   *
   * Four layers now, summing to about 1.8 — comparable to `punch` — and the
   * impact comes from *where* the energy sits rather than from how much of it
   * there is.
   */

  // 1 — the body. Lands at 58 rather than 45, and decays in a third of a second
  // rather than three quarters. Weight is not the same as length: a long tail
  // down here is boom, and boom is what a gut punch is not.
  const body = env(ctx, at, 0.002, 0.3, gain * 0.9);
  const o = ctx.createOscillator();
  o.type = 'sine';
  o.frequency.setValueAtTime(190, at);
  o.frequency.exponentialRampToValueAtTime(58, at + 0.045);
  o.start(at);
  o.stop(at + 0.36);
  o.connect(body).connect(v.out);

  /**
   * 2 — the knock, and this is the punch.
   *
   * The ear does not locate impact at the fundamental. It locates it between
   * roughly 150 and 250Hz, which is why a kick can be *felt* on a speaker that
   * cannot reproduce a single cycle of its bottom octave. Making this the
   * loudest thing after the body — rather than reaching for more sub — is the
   * whole difference between a drum that hits you and one that merely rumbles.
   */
  const knock = env(ctx, at, 0.001, 0.085, gain * 0.55);
  const k = ctx.createOscillator();
  k.type = 'triangle';
  k.frequency.setValueAtTime(260, at);
  k.frequency.exponentialRampToValueAtTime(100, at + 0.045);
  k.start(at);
  k.stop(at + 0.1);
  k.connect(knock).connect(v.out);

  // 3 — a click for definition only. `tight` puts this at 0.85, which is the
  // sound of a kick with nothing underneath it; this one has plenty.
  const tick = env(ctx, at, 0.0008, 0.012, gain * 0.2);
  const t = osc(ctx, 'triangle', 1400, at, at + 0.03);
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 600;
  t.connect(hp).connect(tick).connect(v.out);

  // 4 — the room, short. Twelve milliseconds late so it reads as a reflection
  // rather than as part of the attack, and gone in a tenth of a second so it
  // adds a space rather than a tail.
  const pre = 0.012;
  const seconds = 0.11;
  const frames = Math.ceil(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, frames, ctx.sampleRate);
  const data = buf.getChannelData(0);
  const rise = Math.max(1, Math.round(ctx.sampleRate * 0.008));
  for (let i = 0; i < frames; i++) {
    data[i] =
      (Math.random() * 2 - 1) * Math.pow(1 - i / frames, 2.6) * Math.min(1, i / rise);
  }
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const dark = ctx.createBiquadFilter();
  dark.type = 'lowpass';
  dark.frequency.value = 380;
  dark.Q.value = 0.7;
  const room = ctx.createGain();
  room.gain.value = gain * 0.15;
  src.connect(dark).connect(room).connect(v.out);
  src.start(at + pre);
  src.stop(at + pre + seconds);
}

/**
 * A kick that does not mark time.
 *
 * The three above are all the same idea at three weights: a fast pitch drop and
 * a click, sitting on a quarter. That is a *metronome*, and a metronome is what
 * makes every four-on-the-floor track sound like the last one however it is
 * filtered.
 *
 * This one is built to be heard as an *impact* instead. It falls further and
 * much slower (140 down to 26 over a fifth of a second, against 190→35 in
 * 75ms), so the ear tracks the fall rather than reading it as a single thud, and
 * it rings for over a second — long enough that on a sparse pattern the previous
 * hit is still decaying under the next.
 *
 * Instead of a click it has a *scrape*: ring-modulated noise, band-limited low.
 * Ring modulation again rather than distortion, for §18.4's reason — it
 * multiplies, so it cannot raise RMS. Nothing in this graph is allowed to turn
 * the game up, least of all the loudest voice in it.
 */
function crushKick(v: VoiceCtx, at: number, gain: number): void {
  const { ctx } = v;

  // The body. Three things were wrong with the first version of this and all
  // three made it *weaker*, which is the opposite of what it was reaching for:
  //
  //   - it decayed for 1.15s. At 96 BPM that is longer than the gap between
  //     hits, so consecutive kicks overlapped into a continuous low wall. The
  //     limiter is driven 12x into a -34dB threshold, so a wall down there does
  //     not sound big, it pins the compressor and ducks *everything else*.
  //   - it landed at 26Hz, under most speakers. Inaudible, and still spending
  //     all of that headroom.
  //   - it had no transient at all. Punch is an attack, not a decay.
  //
  // So: land at 41 where the cone can still move, fall fast enough to be heard
  // as a hit, and get out of the way.
  const body = env(ctx, at, 0.002, 0.5, gain * 1.2);
  const o = ctx.createOscillator();
  o.type = 'sine';
  o.frequency.setValueAtTime(210, at);
  o.frequency.exponentialRampToValueAtTime(41, at + 0.055);
  o.start(at);
  o.stop(at + 0.58);
  o.connect(body).connect(v.out);

  // The knock: a short mid-range thud that survives a laptop speaker. This is
  // most of what "weight" is on any system that cannot reproduce 40Hz.
  const knock = env(ctx, at, 0.001, 0.055, gain * 0.55);
  const k = ctx.createOscillator();
  k.type = 'triangle';
  k.frequency.setValueAtTime(320, at);
  k.frequency.exponentialRampToValueAtTime(110, at + 0.05);
  k.start(at);
  k.stop(at + 0.08);
  k.connect(knock).connect(v.out);

  // The scrape, now an *attack* rather than a smear: high, ring-modulated, and
  // over in 40ms. Ring modulation rather than distortion, for §18.4's reason —
  // it multiplies, so it cannot raise RMS.
  const frames = Math.ceil(ctx.sampleRate * 0.05);
  const buf = ctx.createBuffer(1, frames, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < frames; i++) {
    data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / frames, 3.2);
  }
  const src = ctx.createBufferSource();
  src.buffer = buf;

  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.setValueAtTime(2400, at);
  bp.frequency.exponentialRampToValueAtTime(700, at + 0.045);
  bp.Q.value = 1.2;

  const ring = ctx.createGain();
  ring.gain.value = 0;
  const mod = osc(ctx, 'square', 147, at, at + 0.06);
  const depth = ctx.createGain();
  depth.gain.value = 1;
  mod.connect(depth).connect(ring.gain);

  const scrape = ctx.createGain();
  scrape.gain.value = gain * 0.62;
  src.connect(bp).connect(ring).connect(scrape).connect(v.out);
  src.start(at);
  src.stop(at + 0.06);
}

/**
 * A plucked string, by physical model. Karplus-Strong.
 *
 * **This is the first voice in the game that is not subtractive synthesis**, and
 * that is the entire reason it exists. Every other instrument here — all fifty-odd
 * of them — is oscillators into a lowpass into an envelope. Different oscillators
 * and different corners give you different *settings* of one synthesiser, which
 * is why new cells and new variants kept arriving as "the same song with
 * different instruments". You cannot get a genuinely new timbre out of the same
 * method.
 *
 * This one is a short burst of noise fired into a delay line that feeds back on
 * itself through a damper. The delay length *is* the pitch; the damper is what
 * makes the high partials die before the low ones, which is what every real
 * struck or plucked object does and what no envelope can imitate. The result
 * decays by itself, unevenly, the way a physical thing does.
 *
 * Two practical notes. The excitation buffer runs for the whole note rather than
 * just the burst — it is silent after the first few milliseconds, but a live
 * source keeps the feedback loop from being collected while it is still ringing.
 * And a feedback loop through a `DelayNode` cannot go below one render quantum,
 * which caps this at roughly 375Hz; that is fine, because everything it is used
 * for lives underneath that.
 */
function pluckString(
  v: VoiceCtx,
  at: number,
  hz: number,
  gain: number,
  seconds: number,
  damp: number,
  bright: number,
): void {
  const { ctx } = v;
  const period = 1 / Math.max(40, Math.min(370, hz));

  const frames = Math.ceil(ctx.sampleRate * (seconds + 0.05));
  const buf = ctx.createBuffer(1, frames, ctx.sampleRate);
  const data = buf.getChannelData(0);
  // The pluck: a couple of milliseconds of noise, then silence. Everything after
  // this is the string, not the source.
  const burst = Math.max(1, Math.round(ctx.sampleRate * 0.004));
  for (let i = 0; i < burst; i++) {
    data[i] = (Math.random() * 2 - 1) * (1 - i / burst);
  }
  const src = ctx.createBufferSource();
  src.buffer = buf;

  // Brightness of the *attack*, before the string gets hold of it.
  const pre = ctx.createBiquadFilter();
  pre.type = 'lowpass';
  pre.frequency.value = Math.min(9000, hz * bright);

  const delay = ctx.createDelay(0.05);
  delay.delayTime.value = period;

  const loss = ctx.createGain();
  loss.gain.value = 0.5;

  const damper = ctx.createBiquadFilter();
  damper.type = 'lowpass';
  damper.frequency.value = damp;
  damper.Q.value = 0.4;

  const out = env(ctx, at, 0.001, seconds, gain);

  src.connect(pre).connect(delay);
  // The loop. `loss` under 1 is what makes it decay rather than howl; the damper
  // inside the loop is what makes it decay *unevenly*.
  delay.connect(damper).connect(loss).connect(delay);
  delay.connect(out).connect(v.out);

  src.start(at);
  src.stop(at + seconds + 0.05);
}

/**
 * Booming bass.
 *
 * The existing three all failed to boom for the same two reasons, and neither
 * was the voice's fault.
 *
 * **One: they were being played too low to hear.** The bass is pitched at
 * `chordRoot + register.bass`, and `register.bass` is -12. A Score that also
 * drops its key for darkness stacks the two: `choir`'s feedback Axiom sat at
 * key -12, so the bass fundamental was `semiHz(-24)` — **13.75 Hz**. Not quiet.
 * *Inaudible*, on any speaker ever made, while still spending every bit of the
 * limiter's headroom and ducking the rest of the mix through it. Darkness is not
 * altitude, and the fix is in the Scores as much as here.
 *
 * **Two: a sine has nothing to be loud with.** Small speakers cannot reproduce
 * 50Hz at all — what you hear as bass on a laptop is the *harmonics*, and your
 * ear reconstructs the missing fundamental from them. A pure sine has no
 * harmonics to reconstruct from, so it vanishes. `sub` was the quietest voice in
 * the game on exactly the hardware most people play on.
 *
 * So: a sine that drops into pitch for the boom, a triangle for body, and a
 * resonant saw an octave up whose entire job is to be the thing a small speaker
 * can actually move. On a big system you feel the first; on a laptop you hear
 * the third; both read as the same note.
 */
function boomBass(
  v: VoiceCtx,
  at: number,
  hz: number,
  gain: number,
  dur: number,
  brightness: number,
): void {
  const { ctx } = v;
  const long = dur * 5.5;

  // 1 — the boom. A short fall into the fundamental is what makes a low note
  // land rather than simply begin.
  const low = env(ctx, at, 0.004, long, gain * 1.15);
  const o = ctx.createOscillator();
  o.type = 'sine';
  o.frequency.setValueAtTime(hz * 2.2, at);
  o.frequency.exponentialRampToValueAtTime(hz, at + 0.06);
  o.start(at);
  o.stop(at + long + 0.1);
  o.connect(low).connect(v.out);

  // 2 — body. Odd harmonics, quiet, so the note has a shape between the sub and
  // the growl above it.
  const bodyOsc = osc(ctx, 'triangle', hz, at, at + long + 0.1);
  const body = ctx.createGain();
  body.gain.value = 0.34;
  bodyOsc.connect(body).connect(low);

  /**
   * 3 — the growl. This is where "oomph" actually lives, and it is a *spectrum*
   * problem rather than a level one.
   *
   * The obvious way to make a bass sound bigger is to drive it, and that is
   * banned here for a good reason (§18.4 — a soft-clip curve raises RMS, which
   * turns the game up). But what a listener hears as "driven" is mostly the
   * *presence of harmonics*, and harmonics can be added by addition rather than
   * by distortion: a detuned saw pair an octave up, a square at the twelfth for
   * the hollow midrange a clipped bass gets, all through one resonant lowpass.
   * Every level is set by hand, so nothing can run away.
   */
  const growl = env(ctx, at, 0.005, long * 0.7, gain * 0.42);
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.Q.value = 11;
  const open = Math.min(2600, hz * 13 * brightness);
  filter.frequency.setValueAtTime(open, at);
  filter.frequency.exponentialRampToValueAtTime(
    Math.max(90, hz * 3.2 * brightness),
    at + long * 0.62,
  );
  filter.connect(growl).connect(v.out);

  /**
   * And this is the answer to "dry": the cutoff never sits still.
   *
   * A filter that only follows its envelope produces the same note every time,
   * and a bass that is identical on every hit stops being an instrument and
   * becomes a sample. A slow sub-audio wobble under the envelope means no two
   * notes have quite the same edge — the movement is well below the pitch, so it
   * reads as the sound *breathing* rather than as vibrato.
   *
   * It sums with the scheduled ramp above rather than replacing it, which is how
   * AudioParams combine automation with connected inputs.
   */
  const wob = osc(ctx, 'sine', 0.7, at, at + long + 0.1);
  const wobDepth = ctx.createGain();
  wobDepth.gain.value = open * 0.3;
  wob.connect(wobDepth).connect(filter.frequency);

  for (const cents of [-7, 7]) {
    const s = osc(ctx, 'sawtooth', hz * 2 * Math.pow(2, cents / 1200), at, at + long * 0.8 + 0.1);
    const sg = ctx.createGain();
    sg.gain.value = 0.4;
    s.connect(sg).connect(filter);
  }
  // The twelfth. A square here is what gives a clipped bass its hollow middle,
  // and it is the single cheapest way to sound driven without driving anything.
  const twelfth = osc(ctx, 'square', hz * 3, at, at + long * 0.7 + 0.1);
  const twelfthGain = ctx.createGain();
  twelfthGain.gain.value = 0.16;
  twelfth.connect(twelfthGain).connect(filter);

  // 4 — the thud. Twenty milliseconds of band-limited noise so the note has an
  // edge the ear can place in time. Without this a long low note has no onset
  // and reads as a swell.
  const frames = Math.ceil(ctx.sampleRate * 0.03);
  const buf = ctx.createBuffer(1, frames, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < frames; i++) {
    data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / frames, 3.5);
  }
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = 240;
  bp.Q.value = 1.1;
  const thud = ctx.createGain();
  thud.gain.value = gain * 0.32;
  src.connect(bp).connect(thud).connect(v.out);
  src.start(at);
  src.stop(at + 0.05);
}

export type BassVoice = 'pluck' | 'acid' | 'sub' | 'drone' | 'string' | 'boom';

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
  const B = v.tuning.bass;

  /**
   * A bass that is a *surface* rather than a line.
   *
   * The three below all articulate — they play notes, with attacks, and the ear
   * follows them as a part. This one is meant to be the floor: two saws beating
   * against each other a few cents apart, an octave-down square underneath, and
   * a resonant filter crawling across the whole length of the note instead of
   * snapping. Nothing about it is plucked, so nothing about it counts time.
   *
   * The slow beating between the detuned pair is doing most of the work. It is
   * unease you cannot name, which lasts far better than a dissonance you can.
   */
  if (spec.voice === 'boom') {
    boomBass(v, at, hz, gain, dur, spec.brightness);
    return;
  }

  // A struck string, low. `dur` is a sixteenth, so this rings for about a bar —
  // long enough that the previous note is still sounding under the next, which
  // is what a plucked instrument does and a bass synth never does.
  if (spec.voice === 'string') {
    pluckString(v, at, hz, gain * 0.85, dur * 9, 900 + hz * spec.brightness * 6, 14);
    return;
  }

  if (spec.voice === 'drone') {
    const long = dur * 7;
    const g = env(ctx, at, 0.06, long, gain * 0.5);

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.Q.value = Math.max(6, spec.q);
    filter.frequency.setValueAtTime(Math.max(70, hz * 2.2 * spec.brightness), at);
    filter.frequency.exponentialRampToValueAtTime(
      Math.min(2400, hz * 9 * spec.brightness),
      at + long * 0.45,
    );
    filter.frequency.exponentialRampToValueAtTime(Math.max(60, hz * 1.6), at + long);
    filter.connect(g).connect(v.out);

    for (const cents of [-9, 9]) {
      const o = osc(ctx, 'sawtooth', hz * Math.pow(2, cents / 1200), at, at + long + 0.2);
      const og = ctx.createGain();
      og.gain.value = 0.34;
      o.connect(og).connect(filter);
    }
    const low = osc(ctx, 'square', hz / 2, at, at + long + 0.2);
    const lowGain = ctx.createGain();
    lowGain.gain.value = 0.3;
    low.connect(lowGain).connect(filter);
    return;
  }

  if (spec.voice === 'sub') {
    const long = dur * B.sub.length;
    const g = env(ctx, at, B.sub.attack, long, gain * B.sub.gain);
    const o = osc(ctx, 'sine', hz, at, at + long + 0.1);
    const o2 = osc(ctx, 'triangle', hz, at, at + long + 0.1);
    const og = ctx.createGain();
    og.gain.value = B.sub.triangle;
    o.connect(g);
    o2.connect(og).connect(g);
    g.connect(v.out);
    return;
  }

  if (spec.voice === 'acid') {
    const A = B.acid;
    const accented = spec.accent === true;
    const length = accented ? dur * A.accentLength : dur;
    const g = env(ctx, at, A.attack, length, gain * (accented ? A.accentGain : A.gain));

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.Q.value = spec.q;
    // The envelope is the sound: snap wide open, collapse fast. An accent
    // opens further and decays slower, which is the whole 303 vocabulary.
    const peak = Math.min(
      A.peakCeiling,
      hz * (accented ? A.accentPeak : A.peak) * spec.brightness,
    );
    filter.frequency.setValueAtTime(Math.max(A.startFloor, hz * A.start), at);
    filter.frequency.exponentialRampToValueAtTime(peak, at + A.rise);
    filter.frequency.exponentialRampToValueAtTime(
      Math.max(A.landFloor, hz * A.land),
      at + length * (accented ? A.accentFall : A.fall),
    );

    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    if (spec.glideFrom) {
      o.frequency.setValueAtTime(spec.glideFrom, at);
      o.frequency.exponentialRampToValueAtTime(hz, at + A.glide);
    } else {
      o.frequency.setValueAtTime(hz, at);
    }
    o.start(at);
    o.stop(at + length + 0.06);
    o.connect(filter).connect(g).connect(v.out);
    return;
  }

  const P = B.pluck;
  const g = env(ctx, at, P.attack, dur, gain * P.gain);
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.setValueAtTime(
    Math.min(P.cutoffCeiling, hz * P.cutoff * spec.brightness),
    at,
  );
  filter.frequency.exponentialRampToValueAtTime(
    Math.max(P.landFloor, hz * P.land * spec.brightness),
    at + dur * P.fall,
  );
  filter.Q.value = spec.q;

  const o = osc(ctx, 'sawtooth', hz, at, at + dur + 0.06);
  const o2 = osc(ctx, 'square', hz / 2, at, at + dur + 0.06);
  const subGain = ctx.createGain();
  subGain.gain.value = P.subLevel;
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
  const H = v.tuning.hat;
  const dur = open ? H.open : H.closed;
  const frames = Math.ceil(ctx.sampleRate * (dur + 0.02));
  const buf = ctx.createBuffer(1, frames, ctx.sampleRate);
  const data = buf.getChannelData(0);
  // Deterministic-irrelevant: this is presentation, and noise is noise.
  for (let i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1;

  const src = ctx.createBufferSource();
  src.buffer = buf;

  const filter = ctx.createBiquadFilter();
  filter.type = 'highpass';
  filter.frequency.value = H.hz;

  const g = env(ctx, at, H.attack, dur, gain * H.gain);
  src.connect(filter).connect(g).connect(v.out);
  src.start(at);
  src.stop(at + dur + 0.02);
}

/** Sub pulse under the kick — the low end that makes it feel like a room. */
export function sub(v: VoiceCtx, at: number, hz: number, gain: number, dur = 0.5): void {
  const { ctx } = v;
  const S = v.tuning.sub;
  const g = env(ctx, at, S.attack, dur, gain * S.gain);
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
      // Beam and Field. The edge came from two things multiplying.
      //
      // Detuned sawtooths through a lowpass at `hz * (3 + bite * 6)` with Q 2.5:
      // at high bite that is a resonant peak nine harmonics up, sitting on a
      // waveform that has energy at every one of them. And the corner was
      // relative only, so a high note put the peak somewhere the ear cannot
      // ignore. Capped absolutely now, and the resonance pulled back to where it
      // colours the tone instead of announcing it.
      const dur = 0.55 * length;
      const g = env(ctx, at, 0.02, dur, gain * 0.13);
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = Math.min(2400, hz * (2 + bite * 3.5));
      filter.Q.value = 0.9;
      for (const cents of [-9, 9]) {
        const o = osc(ctx, 'sawtooth', hz * Math.pow(2, cents / 1200), at, at + dur + 0.1);
        const vg = ctx.createGain();
        vg.gain.value = 0.4;
        o.connect(vg).connect(filter);
      }

      // And a shelf on top of the corner, because a lowpass at Q 0.9 still
      // passes plenty an octave above it and a Beam is *held*, not struck: a
      // sound you hear for four bars gets judged on its top end, not its attack.
      const air = ctx.createBiquadFilter();
      air.type = 'highshelf';
      air.frequency.value = 2600;
      air.gain.value = -9;
      filter.connect(air).connect(g).connect(v.out);
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
  const C = v.tuning.chord;
  const g = env(ctx, at, C.attack, dur, gain * C.gain);

  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.setValueAtTime(C.open, at);
  filter.frequency.exponentialRampToValueAtTime(C.close, at + dur);
  filter.Q.value = C.q;
  filter.connect(g).connect(v.out);

  for (const semi of semitones) {
    const hz = semiHz(semi + C.register);
    for (const cents of [-C.detune, C.detune]) {
      const o = osc(ctx, wave, hz * Math.pow(2, cents / 1200), at, at + dur + 0.05);
      const vg = ctx.createGain();
      vg.gain.value = C.level;
      o.connect(vg).connect(filter);
    }
  }
}

// ------------------------------------------------------------------- chrome

export type UiSound =
  | 'hover'
  | 'click'
  | 'draft'
  | 'confirm'
  | 'start'
  | 'death'
  | 'type'
  | 'wire';

/**
 * Interface sounds. GDD §18.4 — "silence is banned: even the menu hums."
 *
 * A hover and a click should be the *same object* at two weights: a tiny wooden
 * tick, differing only in how hard it was hit. Giving them separate melodic
 * identities was a mistake — a UI that plays little tunes at you competes with
 * the track for attention it has not earned, and every one of these fires
 * hundreds of times a session.
 *
 * The two exceptions are the two moments that matter: a Draft arriving, and a
 * Draft taken. Those are decisions, and a decision is worth a note.
 *
 * All of it is unquantized. Everything else in the game waits up to 34ms for a
 * sixteenth; a button that waited would feel broken. Immediacy is worth more
 * than grid alignment for anything the player's hand caused directly — the same
 * exemption §18.3 gives the hurt clip, for the same reason.
 */
export function ui(v: VoiceCtx, at: number, sound: UiSound): void {
  const { ctx } = v;

  switch (sound) {
    // One tick, two weights. If you can describe the hover individually, it is
    // too loud; if the click does not feel like the same object, they are wrong.
    //
    // Both centres dropped about an octave. They sat at 2400 and 1900, which is
    // the middle of where human hearing peaks — a tick there is *piercing* at
    // any level, and a hover fires hundreds of times a session. Lower and
    // slightly longer reads as wood rather than as glass, and it stays audible
    // at the same gain, so this softens the character without undoing the "a bit
    // louder please" from earlier.
    case 'hover':
      return tick(v, at, 0.07, 950, 0.03);
    case 'click':
      return tick(v, at, 0.24, 780, 0.05);

    /**
     * A key struck on somebody else's keyboard. §8 — the channel has to feel
     * *occupied*, and a message that arrives in silence is a document.
     *
     * Quieter and far shorter than a hover, and detuned per strike: a fixed
     * pitch at forty a second is a machine gun, and the small random spread is
     * what makes it read as fingers. The caller fires it every few characters
     * rather than every one.
     */
    case 'type':
      return keyClick(v, at);

    /**
     * The handshake printing itself. Higher, drier and perfectly even, so the
     * change of register when the typing starts is audible before it is legible
     * — banner first, then a hand.
     */
    case 'wire':
      return tick(v, at, 0.04, 2600, 0.01);

    case 'draft': {
      // A Draft arriving. Two notes up, quiet: an offer, not an announcement.
      for (const [i, degree] of [10, 14].entries()) {
        const t = at + i * 0.07;
        const g = env(ctx, t, 0.003, 0.16, 0.16);
        const o = osc(ctx, 'triangle', noteHz(degree), t, t + 0.2);
        o.connect(g).connect(v.out);
      }
      return;
    }

    case 'confirm': {
      // A Draft taken. The same interval, landing rather than rising, plus the
      // tick you get from every other button so it still feels like a press.
      tick(v, at, 0.24, 780, 0.05);
      for (const [i, degree] of [14, 12].entries()) {
        const t = at + i * 0.06;
        const g = env(ctx, t, 0.003, 0.2, 0.18);
        const o = osc(ctx, 'triangle', noteHz(degree), t, t + 0.24);
        o.connect(g).connect(v.out);
      }
      return;
    }

    case 'start': {
      // A run beginning: the tonic, low and wide, opening up.
      for (const [i, degree] of [0, 5, 10].entries()) {
        const t = at + i * 0.075;
        const g = env(ctx, t, 0.006, 0.5, 0.2);
        const filter = ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.setValueAtTime(600, t);
        filter.frequency.exponentialRampToValueAtTime(3000, t + 0.2);
        for (const cents of [-8, 8]) {
          const o = osc(ctx, 'sawtooth', noteHz(degree) * Math.pow(2, cents / 1200), t, t + 0.6);
          const vg = ctx.createGain();
          vg.gain.value = 0.4;
          o.connect(vg).connect(filter);
        }
        filter.connect(g).connect(v.out);
      }
      return;
    }

    case 'death': {
      // §18.3 says the hurt clip is the only non-musical sound in the game.
      // Death is its full stop: the same wrongness, pitched down and long, and
      // the one moment the track is allowed to lose.
      const dur = 1.4;
      const g = env(ctx, at, 0.004, dur, 0.4);
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(noteHz(4), at);
      o.frequency.exponentialRampToValueAtTime(noteHz(0) / 4, at + dur * 0.8);
      o.start(at);
      o.stop(at + dur + 0.1);
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(2200, at);
      filter.frequency.exponentialRampToValueAtTime(180, at + dur);
      filter.Q.value = 3;
      o.connect(filter).connect(g).connect(v.out);
      return;
    }
  }
}

/**
 * A key bottoming out. Two layers, because one is a tick and two is a keyboard.
 *
 * Deliberately **not** built on `tick()`. That has a 6ms attack, which is right
 * for a button — fast enough to feel immediate, soft enough not to bite after
 * the thousandth press. A key is the opposite: the whole character of a click is
 * the step at the front, and 6ms rounds it off into a blip. This attacks in half
 * a millisecond and is over in eight, which is a *snap* rather than a tone with
 * a short envelope.
 *
 * The high layer is the keycap; the low one is the key hitting the plate. The
 * ear needs the second to believe something physical happened, and everything is
 * jittered per strike or forty a second becomes a texture instead of fingers.
 */
function keyClick(v: VoiceCtx, at: number): void {
  const { ctx } = v;

  // Noise, not a tone: a click with a pitch is a beep, and a beep is a sound the
  // player will learn to resent.
  const frames = Math.ceil(ctx.sampleRate * 0.02);
  const buf = ctx.createBuffer(1, frames, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < frames; i++) {
    data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / frames, 6);
  }

  const snap = ctx.createBufferSource();
  snap.buffer = buf;
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = 2900 + (Math.random() - 0.5) * 1100;
  bp.Q.value = 1.1;

  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(0.09 + Math.random() * 0.04, at + 0.0005);
  g.gain.exponentialRampToValueAtTime(0.0001, at + 0.008);
  snap.start(at);
  snap.stop(at + 0.02);
  snap.connect(bp).connect(g).connect(v.out);

  // The plate. Short enough that it is felt rather than heard as a note.
  const thock = env(ctx, at, 0.0008, 0.022, 0.055 + Math.random() * 0.02);
  const lowOsc = osc(ctx, 'sine', 130 + Math.random() * 50, at, at + 0.04);
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 380;
  lowOsc.connect(lp).connect(thock).connect(v.out);
}

/**
 * The handshake, once, at the top of an intrusion. §8.
 *
 * Played rather than held: a modem screeches while it is negotiating and then
 * shuts up, and a carrier droning under six lines of dialogue is just a hum the
 * player stops hearing. The whole thing is over inside the banner.
 *
 * The sequence is the real one, in the real order — dial tone, tones dialled,
 * answer tone, then the negotiation. Every frequency below is the actual value:
 * DTMF is 697/770/852 by 1209/1336/1477, the answer tone is 2100 Hz, and the
 * warble is Bell 103's mark and space pairs. None of that is audible as
 * *correct*, but the intervals between them are what makes it sound like a
 * modem rather than like sound effects.
 */
export function dialup(v: VoiceCtx, at: number): void {
  const { ctx } = v;
  const out = ctx.createGain();
  out.gain.value = 0.5;
  out.connect(v.out);

  const pair = (t: number, low: number, high: number, dur: number, gain: number): void => {
    const g = env(ctx, t, 0.008, dur, gain);
    for (const hz of [low, high]) osc(ctx, 'sine', hz, t, t + dur + 0.02).connect(g);
    g.connect(out);
  };

  // Dial tone: the two-tone hum of a line waiting to be told where to go.
  pair(at, 350, 440, 0.42, 0.06);

  // Dialling. Six digits, unevenly spaced, because a hand is pressing them.
  const digits: [number, number][] = [
    [697, 1209],
    [852, 1477],
    [770, 1336],
    [941, 1336],
    [697, 1477],
    [852, 1209],
  ];
  let t = at + 0.6;
  for (const [low, high] of digits) {
    pair(t, low, high, 0.085, 0.05);
    t += 0.12 + Math.random() * 0.05;
  }

  // The far end picks up. A steady 2100 Hz is the sound of something answering.
  const answer = at + 1.55;
  pair(answer, 2100, 2100, 0.7, 0.05);

  // Negotiation: two carriers hopping between mark and space, over hiss, run
  // through a soft clip. This is the screech, and it is the only part anybody
  // actually remembers.
  const start = at + 2.25;
  const dur = 1.7;
  const shaper = ctx.createWaveShaper();
  const curve = new Float32Array(1024);
  for (let i = 0; i < curve.length; i++) {
    const x = (i / (curve.length - 1)) * 2 - 1;
    curve[i] = Math.tanh(x * 3.2);
  }
  shaper.curve = curve;

  const band = ctx.createBiquadFilter();
  band.type = 'bandpass';
  band.frequency.value = 1700;
  band.Q.value = 0.6;

  const swell = env(ctx, start, 0.15, dur, 0.075);
  shaper.connect(band).connect(swell).connect(out);

  for (const [mark, space] of [
    [1070, 1270],
    [2025, 2225],
  ]) {
    const o = ctx.createOscillator();
    o.type = 'square';
    const g = ctx.createGain();
    g.gain.value = 0.5;
    for (let step = 0; step < dur; step += 0.03 + Math.random() * 0.04) {
      o.frequency.setValueAtTime(Math.random() < 0.5 ? mark! : space!, start + step);
    }
    o.start(start);
    o.stop(start + dur + 0.05);
    o.connect(g).connect(shaper);
  }

  const frames = Math.ceil(ctx.sampleRate * dur);
  const buf = ctx.createBuffer(1, frames, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < frames; i++) data[i] = (Math.random() * 2 - 1) * 0.5;
  const hiss = ctx.createBufferSource();
  hiss.buffer = buf;
  const hissGain = ctx.createGain();
  hissGain.gain.value = 0.35;
  hiss.start(start);
  hiss.stop(start + dur);
  hiss.connect(hissGain).connect(shaper);
}

/** The whole UI vocabulary: a short filtered tick. Weight is the only variable. */
function tick(v: VoiceCtx, at: number, gain: number, hz: number, dur: number): void {
  const { ctx } = v;
  // 6ms rather than 0.8. An attack that fast is a step, and a step is broadband
  // by definition — the bite people call "harsh" was the transient, not the
  // level. 6ms is still well below the ~20ms where a press starts to feel late,
  // so nothing about the response changes.
  const g = env(ctx, at, 0.006, dur, gain);
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = hz;
  // Narrower, so less of the noise escapes either side of the centre.
  bp.Q.value = 3;

  // And a ceiling. A bandpass at Q 3 still passes plenty an octave up, and an
  // octave up from here is 3–5kHz — the exact band the ear is most sensitive
  // to and the reason a quiet sound can still be fatiguing. Same fix the snare
  // needed, for the same reason.
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = hz * 2.4;
  lp.Q.value = 0.6;

  // Noise, not a tone: a click with a pitch is a beep, and a beep is a sound
  // the player will learn to resent.
  const frames = Math.ceil(ctx.sampleRate * (dur + 0.01));
  const buf = ctx.createBuffer(1, frames, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < frames; i++) {
    data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / frames, 3);
  }
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(bp).connect(lp).connect(g).connect(v.out);
  src.start(at);
  src.stop(at + dur + 0.01);
}

/**
 * §21b.5 — a gate opening. Six seconds of machinery, not a hit.
 *
 * Three layers, because a gate is three things at once and none of them is a
 * transient: a mass that has to be got moving, surfaces dragging on each other,
 * and teeth taking load. The brief was "not jarring, but distinct" — so nothing
 * here has an attack. The low swell arrives under you before you can name it,
 * the scrape rises through the middle of the mix where nothing else lives, and
 * the teeth are the only thing with edges.
 *
 * The middle of the envelope dips deliberately. GATE_SEQUENCE has the wall
 * strain almost without moving a second and a half in, and the sound has to
 * agree with that or the beat reads as a stutter rather than as effort.
 */
export function gate(v: VoiceCtx, at: number, seconds: number, gain: number): void {
  const { ctx } = v;
  const go = at + seconds * 0.44;              // where the wall actually moves

  const swell = (node: GainNode, peak: number) => {
    node.gain.setValueAtTime(0.0001, at);
    node.gain.exponentialRampToValueAtTime(peak * 0.85, at + 1.1);
    node.gain.exponentialRampToValueAtTime(peak * 0.3, go - 0.15);
    node.gain.exponentialRampToValueAtTime(peak, at + seconds * 0.76);
    node.gain.exponentialRampToValueAtTime(0.0001, at + seconds);
  };

  // 1 — the mass. A sub that shifts pitch as it gets under way.
  const low = ctx.createOscillator();
  low.type = 'sine';
  low.frequency.setValueAtTime(23, at);
  low.frequency.linearRampToValueAtTime(36, at + seconds * 0.62);
  low.frequency.linearRampToValueAtTime(18, at + seconds);
  const lowGain = ctx.createGain();
  swell(lowGain, gain * 0.95);
  low.connect(lowGain).connect(v.out);
  low.start(at);
  low.stop(at + seconds + 0.1);

  // 2 — the choir. Five detuned saws a fifth apart under a slow lowpass, which
  // is the whole of "majestic": a chord that is *held* while everything else
  // grinds. Tuned low and dark so it reads as scale rather than as melody.
  const bed = ctx.createBiquadFilter();
  bed.type = 'lowpass';
  bed.Q.value = 1.2;
  bed.frequency.setValueAtTime(180, at);
  bed.frequency.linearRampToValueAtTime(1300, at + seconds * 0.78);
  bed.frequency.linearRampToValueAtTime(420, at + seconds);
  const bedGain = ctx.createGain();
  swell(bedGain, gain * 0.4);
  bed.connect(bedGain).connect(v.out);
  for (const [mult, detune] of [
    [1, -7],
    [1, 6],
    [1.5, -4],
    [2, 9],
    [3, -11],
  ] as const) {
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.value = 41 * mult;
    o.detune.value = detune;
    o.connect(bed);
    o.start(at);
    o.stop(at + seconds + 0.1);
  }

  // 3 — the scrape. Noise through a bandpass that sweeps up as it moves and
  // falls away as it finishes. Q high enough to sing rather than hiss.
  const frames = Math.ceil(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, frames, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1;
  const noise = ctx.createBufferSource();
  noise.buffer = buf;
  const band = ctx.createBiquadFilter();
  band.type = 'bandpass';
  band.Q.value = 5.5;
  band.frequency.setValueAtTime(240, at);
  band.frequency.linearRampToValueAtTime(520, at + seconds * 0.42);
  band.frequency.linearRampToValueAtTime(1750, at + seconds * 0.74);
  band.frequency.linearRampToValueAtTime(400, at + seconds);
  const scrape = ctx.createGain();
  swell(scrape, gain * 0.62);
  noise.connect(band).connect(scrape).connect(v.out);
  noise.start(at);
  noise.stop(at + seconds);

  // 4 — the horn. One long descending tone under everything. This is the scary
  // one: it never resolves, it only sinks, and it is the last thing still
  // sounding when the wall has finished.
  const horn = ctx.createOscillator();
  horn.type = 'triangle';
  horn.frequency.setValueAtTime(196, at + 0.2);
  horn.frequency.exponentialRampToValueAtTime(58, at + seconds * 0.9);
  const hornGain = ctx.createGain();
  hornGain.gain.setValueAtTime(0.0001, at + 0.2);
  hornGain.gain.exponentialRampToValueAtTime(gain * 0.34, at + 1.4);
  hornGain.gain.exponentialRampToValueAtTime(gain * 0.5, at + seconds * 0.8);
  hornGain.gain.exponentialRampToValueAtTime(0.0001, at + seconds + 0.5);
  horn.connect(hornGain).connect(v.out);
  horn.start(at + 0.2);
  horn.stop(at + seconds + 0.6);

  // 5 — the moment it gives. One impact on the beat the wall actually moves,
  // because everything before this has been threat and this is the payoff.
  const hit = ctx.createOscillator();
  hit.type = 'sine';
  hit.frequency.setValueAtTime(120, go);
  hit.frequency.exponentialRampToValueAtTime(31, go + 0.55);
  const hitGain = ctx.createGain();
  hitGain.gain.setValueAtTime(gain * 1.15, go);
  hitGain.gain.exponentialRampToValueAtTime(0.0001, go + 0.9);
  hit.connect(hitGain).connect(v.out);
  hit.start(go);
  hit.stop(go + 0.95);

  // 6 — the teeth. A click train whose spacing tightens as the wall accelerates
  // and opens out again as it runs clear. Scheduled rather than looped so the
  // rhythm can follow the sequence instead of ticking through it. Each tooth
  // carries a metallic partial above it, which is what makes it iron.
  let t = at + 0.3;
  while (t < at + seconds * 0.95) {
    const k = (t - at) / seconds;
    const bell = 0.1 + 0.18 * Math.sin(Math.min(1, k * 1.35) * Math.PI);
    const tooth = ctx.createOscillator();
    tooth.type = 'square';
    tooth.frequency.value = 140 + k * 260;
    const shape = ctx.createBiquadFilter();
    shape.type = 'lowpass';
    shape.frequency.value = 2600;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain * bell), t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.08);
    tooth.connect(shape).connect(g).connect(v.out);
    tooth.start(t);
    tooth.stop(t + 0.095);

    const ring = ctx.createOscillator();
    ring.type = 'triangle';
    ring.frequency.value = 1450 + k * 900;
    const rg = ctx.createGain();
    rg.gain.setValueAtTime(0.0001, t);
    rg.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain * bell * 0.3), t + 0.002);
    rg.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
    ring.connect(rg).connect(v.out);
    ring.start(t);
    ring.stop(t + 0.24);

    // Fast in the middle, slow at both ends — the cadence of something heavy.
    t += 0.28 - 0.19 * Math.sin(Math.min(1, k * 1.2) * Math.PI);
  }
}

/**
 * §13.2 — Meltdown. The moment the run stops being a build and starts being a
 * siege, announced.
 *
 * The gate voice next door is *machinery* — something enormous doing a job, and
 * deliberately not jarring. This is the opposite brief and shares none of its
 * parts: nothing here is doing a job, something has been let in.
 *
 * Four ideas, all of them chosen because they are unpleasant on purpose:
 *
 *   **A minor second.** Two detuned saw stacks a semitone apart, which is the
 *   interval the ear reads as wrong before it can name why. Held, not struck.
 *
 *   **A tritone horn**, the two notes alternating so it never settles.
 *
 *   **The floor leaving.** A sub that starts where a kick lives and walks down
 *   below hearing, so the mix loses its bottom under the player.
 *
 *   **One impact, late.** Everything above swells for two and a half seconds
 *   with no transient at all, and then something lands. Announcing it at the
 *   start would make it an alarm; announcing it at the end makes it an arrival.
 *
 * Deliberately no saturation stage anywhere in here — the graph does not have
 * one and must not grow one.
 */
export function meltdown(v: VoiceCtx, at: number, seconds: number, gain: number): void {
  const { ctx } = v;
  const hit = at + seconds * 0.42;

  // 1 — the semitone cluster. Six saws, two pitch centres a semitone apart,
  // under a filter that opens as it swells and shuts as it decays.
  const clusterFilter = ctx.createBiquadFilter();
  clusterFilter.type = 'lowpass';
  clusterFilter.Q.value = 3;
  clusterFilter.frequency.setValueAtTime(150, at);
  clusterFilter.frequency.exponentialRampToValueAtTime(1400, hit);
  clusterFilter.frequency.exponentialRampToValueAtTime(220, at + seconds);
  const clusterGain = ctx.createGain();
  clusterGain.gain.setValueAtTime(0.0001, at);
  clusterGain.gain.exponentialRampToValueAtTime(gain * 0.3, hit);
  // Falls back to a floor rather than to nothing, and only lets go at the very
  // end. A straight exponential to zero was inaudible a second past the impact,
  // which left the stinger as a bang — and the dread is in the part afterwards,
  // where the cluster is still there and you have started playing again.
  clusterGain.gain.exponentialRampToValueAtTime(gain * 0.075, at + seconds * 0.62);
  clusterGain.gain.setValueAtTime(gain * 0.075, at + seconds * 0.88);
  clusterGain.gain.exponentialRampToValueAtTime(0.0001, at + seconds);
  clusterFilter.connect(clusterGain).connect(v.out);

  for (let i = 0; i < 6; i++) {
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    // Three voices at 49 Hz, three a semitone above, each detuned a few cents
    // so the pair beats against itself as well as against the other.
    const base = i < 3 ? 49 : 51.9;
    o.frequency.value = base;
    o.detune.value = (i % 3) * 9 - 9;
    // The whole cluster sags a little over its life. A held pitch is a chord;
    // a pitch that will not sit still is a thing.
    o.frequency.setValueAtTime(base, at);
    o.frequency.linearRampToValueAtTime(base * 0.965, at + seconds);
    o.connect(clusterFilter);
    o.start(at);
    o.stop(at + seconds + 0.1);
  }

  // 2 — the horn. A tritone, alternating, never resolving.
  for (let i = 0; i < 2; i++) {
    const o = ctx.createOscillator();
    o.type = 'triangle';
    const hz = i === 0 ? 98 : 138.6; // an augmented fourth apart
    o.frequency.value = hz;
    const g = ctx.createGain();
    // Offset halves so one is arriving while the other leaves.
    const t0 = at + i * seconds * 0.3;
    g.gain.setValueAtTime(0.0001, at);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain * 0.16, t0 + seconds * 0.28);
    g.gain.exponentialRampToValueAtTime(0.0001, Math.min(at + seconds, t0 + seconds * 0.62));
    o.connect(g).connect(v.out);
    o.start(at);
    o.stop(at + seconds + 0.1);
  }

  // 3 — the floor leaving. Starts where a kick lives and walks out from under.
  const low = ctx.createOscillator();
  low.type = 'sine';
  low.frequency.setValueAtTime(58, at);
  low.frequency.exponentialRampToValueAtTime(21, at + seconds * 0.9);
  const lowGain = ctx.createGain();
  lowGain.gain.setValueAtTime(0.0001, at);
  lowGain.gain.exponentialRampToValueAtTime(gain, at + seconds * 0.5);
  lowGain.gain.exponentialRampToValueAtTime(0.0001, at + seconds);
  low.connect(lowGain).connect(v.out);
  low.start(at);
  low.stop(at + seconds + 0.1);

  // 4 — a noise bed climbing through a bandpass, so the room fills up before
  // anything has happened in it.
  const dur = seconds + 0.2;
  const noise = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * dur), ctx.sampleRate);
  const data = noise.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  const src = ctx.createBufferSource();
  src.buffer = noise;
  const band = ctx.createBiquadFilter();
  band.type = 'bandpass';
  band.Q.value = 1.4;
  band.frequency.setValueAtTime(220, at);
  band.frequency.exponentialRampToValueAtTime(2600, hit);
  band.frequency.exponentialRampToValueAtTime(140, at + seconds);
  const noiseGain = ctx.createGain();
  noiseGain.gain.setValueAtTime(0.0001, at);
  noiseGain.gain.exponentialRampToValueAtTime(gain * 0.17, hit - 0.05);
  noiseGain.gain.exponentialRampToValueAtTime(0.0001, at + seconds * 0.8);
  src.connect(band).connect(noiseGain).connect(v.out);
  src.start(at);
  src.stop(at + dur);

  // 5 — the arrival. The only transient in the whole thing.
  const thud = ctx.createOscillator();
  thud.type = 'sine';
  thud.frequency.setValueAtTime(120, hit);
  thud.frequency.exponentialRampToValueAtTime(31, hit + 0.5);
  const thudGain = ctx.createGain();
  thudGain.gain.setValueAtTime(gain * 1.15, hit);
  thudGain.gain.exponentialRampToValueAtTime(0.0001, hit + 1.1);
  thud.connect(thudGain).connect(v.out);
  thud.start(hit);
  thud.stop(hit + 1.2);

  // and its metal, three inharmonic partials so it rings rather than pitches.
  for (let i = 0; i < 3; i++) {
    const o = ctx.createOscillator();
    o.type = 'square';
    o.frequency.value = [317, 631, 1153][i]!;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain * 0.06, hit);
    g.gain.exponentialRampToValueAtTime(0.0001, hit + 1.6 - i * 0.35);
    o.connect(g).connect(v.out);
    o.start(hit);
    o.stop(hit + 1.7);
  }
}

/**
 * §21b — a breach. The room past the gate noticing you.
 *
 * Shares a vocabulary with `meltdown` — the same semitone cluster, the same
 * refusal to resolve — and inverts its shape, because the two events are
 * opposite in time. Meltdown is a state you have entered and will not leave, so
 * it swells for two and a half seconds and then arrives. A breach has already
 * happened by the time you hear it: you walked through the door. So the impact
 * is first, on the very first sample, and everything after it is the room
 * answering.
 *
 * And the cluster rises here where Meltdown's sags. A pitch walking up is
 * something coming toward you; a pitch walking down is something settling in.
 */
export function breach(v: VoiceCtx, at: number, seconds: number, gain: number): void {
  const { ctx } = v;

  // 1 — the door. One hit, immediately, low and wide.
  const thud = ctx.createOscillator();
  thud.type = 'sine';
  thud.frequency.setValueAtTime(96, at);
  thud.frequency.exponentialRampToValueAtTime(27, at + 0.55);
  const thudGain = ctx.createGain();
  thudGain.gain.setValueAtTime(gain * 1.05, at);
  thudGain.gain.exponentialRampToValueAtTime(0.0001, at + 1.0);
  thud.connect(thudGain).connect(v.out);
  thud.start(at);
  thud.stop(at + 1.1);

  // 2 — the room, waking. A rising semitone cluster under an opening filter:
  // whatever is in here is now coming, and it is not in a hurry.
  const clusterFilter = ctx.createBiquadFilter();
  clusterFilter.type = 'lowpass';
  clusterFilter.Q.value = 2.4;
  clusterFilter.frequency.setValueAtTime(180, at);
  clusterFilter.frequency.exponentialRampToValueAtTime(1900, at + seconds * 0.8);
  clusterFilter.frequency.exponentialRampToValueAtTime(300, at + seconds);
  const clusterGain = ctx.createGain();
  clusterGain.gain.setValueAtTime(0.0001, at);
  clusterGain.gain.exponentialRampToValueAtTime(gain * 0.26, at + seconds * 0.7);
  clusterGain.gain.exponentialRampToValueAtTime(0.0001, at + seconds);
  clusterFilter.connect(clusterGain).connect(v.out);

  for (let i = 0; i < 4; i++) {
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    const base = i < 2 ? 62 : 65.7;
    o.detune.value = (i % 2) * 11 - 5;
    o.frequency.setValueAtTime(base * 0.94, at);
    o.frequency.linearRampToValueAtTime(base, at + seconds * 0.85);
    o.connect(clusterFilter);
    o.start(at);
    o.stop(at + seconds + 0.1);
  }

  // 3 — three struck partials, inharmonic, so the hit rings off the walls of a
  // room whose size you cannot see yet.
  for (let i = 0; i < 3; i++) {
    const o = ctx.createOscillator();
    o.type = 'square';
    o.frequency.value = [289, 547, 991][i]!;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain * 0.05, at);
    g.gain.exponentialRampToValueAtTime(0.0001, at + 1.5 - i * 0.4);
    o.connect(g).connect(v.out);
    o.start(at);
    o.stop(at + 1.6);
  }

  // 4 — a reversed-sounding noise rise into the tail. Not a transient of its
  // own: it fills the space the impact leaves as the impact decays.
  const dur = seconds + 0.2;
  const noise = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * dur), ctx.sampleRate);
  const data = noise.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  const src = ctx.createBufferSource();
  src.buffer = noise;
  const band = ctx.createBiquadFilter();
  band.type = 'bandpass';
  band.Q.value = 1.1;
  band.frequency.setValueAtTime(300, at);
  band.frequency.exponentialRampToValueAtTime(3200, at + seconds * 0.82);
  band.frequency.exponentialRampToValueAtTime(400, at + seconds);
  const noiseGain = ctx.createGain();
  noiseGain.gain.setValueAtTime(0.0001, at);
  noiseGain.gain.exponentialRampToValueAtTime(gain * 0.15, at + seconds * 0.78);
  noiseGain.gain.exponentialRampToValueAtTime(0.0001, at + seconds);
  src.connect(band).connect(noiseGain).connect(v.out);
  src.start(at);
  src.stop(at + dur);
}

/**
 * §12.3, §12.4 — a wave you asked for. The Beacon calls one in early; the Cache
 * trades a card for the same composition with everything in it hardened.
 *
 * Both were wrong before this existed. The Beacon made no sound at all, and the
 * Cache — the sharpest opt-in fight in the game — played the level-up chime and
 * nothing else, so the loudest thing about walking into a hardened wave was the
 * reward. (The chime stays: a Cache really is a free Draft. This goes over it.)
 *
 * The shape is `breach` run backwards, and deliberately so, because the events
 * are opposite. A breach has already happened when you hear it, so the impact is
 * first. A summons has *not* happened yet: you pressed the button and the thing
 * is on its way. So it rises, and the arrival is at seven tenths, and what you
 * do with the time before it is the point of the sound.
 *
 * `hardened` is the Cache's extra: a tritone horn over the top and struck metal
 * on the arrival. Same voice, one tier heavier, so the two events are audibly
 * related and not interchangeable.
 */
export function summons(
  v: VoiceCtx,
  at: number,
  seconds: number,
  gain: number,
  hardened = false,
): void {
  const { ctx } = v;
  const land = at + seconds * 0.7;

  // 1 — the call. A semitone cluster climbing into the arrival, filter opening
  // with it, so the room gets brighter and worse at the same time.
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.Q.value = 2.8;
  filter.frequency.setValueAtTime(160, at);
  filter.frequency.exponentialRampToValueAtTime(hardened ? 2200 : 1300, land);
  filter.frequency.exponentialRampToValueAtTime(260, at + seconds);
  const clusterGain = ctx.createGain();
  clusterGain.gain.setValueAtTime(0.0001, at);
  clusterGain.gain.exponentialRampToValueAtTime(gain * (hardened ? 0.3 : 0.2), land);
  clusterGain.gain.exponentialRampToValueAtTime(0.0001, at + seconds);
  filter.connect(clusterGain).connect(v.out);

  const voices = hardened ? 6 : 4;
  for (let i = 0; i < voices; i++) {
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    const half = voices / 2;
    const base = i < half ? 58 : 61.5;
    o.detune.value = (i % half) * 8 - 8;
    // Climbing a whole tone across its life: something on its way, not settling.
    o.frequency.setValueAtTime(base * 0.89, at);
    o.frequency.linearRampToValueAtTime(base, land);
    o.frequency.linearRampToValueAtTime(base * 1.02, at + seconds);
    o.connect(filter);
    o.start(at);
    o.stop(at + seconds + 0.1);
  }

  // 2 — the sub, rising with it rather than walking out from under.
  const low = ctx.createOscillator();
  low.type = 'sine';
  low.frequency.setValueAtTime(26, at);
  low.frequency.exponentialRampToValueAtTime(hardened ? 44 : 36, land);
  const lowGain = ctx.createGain();
  lowGain.gain.setValueAtTime(0.0001, at);
  lowGain.gain.exponentialRampToValueAtTime(gain * 0.8, land);
  lowGain.gain.exponentialRampToValueAtTime(0.0001, at + seconds);
  low.connect(lowGain).connect(v.out);
  low.start(at);
  low.stop(at + seconds + 0.1);

  // 3 — the arrival.
  const thud = ctx.createOscillator();
  thud.type = 'sine';
  thud.frequency.setValueAtTime(hardened ? 110 : 88, land);
  thud.frequency.exponentialRampToValueAtTime(30, land + 0.45);
  const thudGain = ctx.createGain();
  thudGain.gain.setValueAtTime(gain * (hardened ? 1.0 : 0.7), land);
  thudGain.gain.exponentialRampToValueAtTime(0.0001, land + 0.9);
  thud.connect(thudGain).connect(v.out);
  thud.start(land);
  thud.stop(land + 1.0);

  if (!hardened) return;

  // 4 — the Cache's tier. A tritone under the climb, and struck metal on the
  // landing: this wave is wearing affixes and the sound says so before it does.
  for (let i = 0; i < 2; i++) {
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.value = i === 0 ? 92 : 130.1;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(gain * 0.13, land);
    g.gain.exponentialRampToValueAtTime(0.0001, at + seconds);
    o.connect(g).connect(v.out);
    o.start(at);
    o.stop(at + seconds + 0.1);
  }
  for (let i = 0; i < 3; i++) {
    const o = ctx.createOscillator();
    o.type = 'square';
    o.frequency.value = [271, 583, 1039][i]!;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain * 0.05, land);
    g.gain.exponentialRampToValueAtTime(0.0001, land + 1.4 - i * 0.35);
    o.connect(g).connect(v.out);
    o.start(land);
    o.stop(land + 1.5);
  }
}

/* ---------------------------------------------------------------- §21b.7
 * The siege score.
 *
 * Not a variation on the run's arrangement — a different piece of music that
 * takes the room over while a gate is held, and hands it back when the gate
 * opens. Everything here is deliberately outside the vocabulary the rest of the
 * soundtrack uses: no key, no chord movement, no groove that resolves. A drone,
 * a beat, and something screaming above both.
 *
 * **On "distortion".** The audio graph does not have a saturation stage and must
 * never grow one. The grit in here is synthesis, not clipping: ring modulation
 * (multiplying two signals, which produces sum-and-difference sidebands) and FM
 * at inharmonic ratios (a modulator at 1.41x the carrier — a tritone, so the
 * partials never line up into a pitch). Both are harsher than a waveshaper and
 * neither raises RMS the way one does.
 */

/**
 * The floor. A detuned stack an octave below anything else in the game, ring
 * modulated so it grinds rather than hums, under a filter that opens with the
 * pressure. Meant to be felt before it is heard.
 */
export function siegeDrone(
  v: VoiceCtx,
  at: number,
  dur: number,
  hz: number,
  gain: number,
  intensity: number,
): void {
  const { ctx } = v;

  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  // Resonant, but not as resonant as it wants to be.
  //
  // At Q 14 the filter is an amplifier: the drone alone peaked past 3.0 and the
  // whole score with it, which on a bus feeding a limiter means everything else
  // gets ducked *by the bass* four times a bar. Halving Q costs almost nothing
  // in low-end weight — measured, the sub-200Hz energy barely moved — and buys
  // back the headroom that lets the drone actually be loud.
  filter.Q.value = 3 + intensity * 4;
  filter.frequency.setValueAtTime(90, at);
  filter.frequency.exponentialRampToValueAtTime(180 + intensity * 900, at + dur * 0.55);
  filter.frequency.exponentialRampToValueAtTime(110, at + dur);

  const out = ctx.createGain();
  out.gain.setValueAtTime(0.0001, at);
  out.gain.exponentialRampToValueAtTime(gain, at + dur * 0.14);
  out.gain.setValueAtTime(gain, at + dur * 0.8);
  out.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  filter.connect(out).connect(v.out);

  // Ring modulation. `ring.gain` sits at zero and the modulator swings it, so
  // the output is literally signal x modulator: no fundamental of its own, only
  // sidebands. At 37Hz against a 41Hz drone that is a beating, metallic floor.
  const ring = ctx.createGain();
  ring.gain.value = 0;
  const modulator = ctx.createOscillator();
  modulator.type = 'sine';
  modulator.frequency.setValueAtTime(37, at);
  modulator.frequency.linearRampToValueAtTime(37 + intensity * 26, at + dur);
  const modDepth = ctx.createGain();
  modDepth.gain.value = 1;
  modulator.connect(modDepth).connect(ring.gain);
  modulator.start(at);
  modulator.stop(at + dur + 0.1);
  ring.connect(filter);

  // Dry alongside it, so there is still a note under the grinding.
  const dry = ctx.createGain();
  dry.gain.value = 0.55 - intensity * 0.25;
  dry.connect(filter);

  for (let i = 0; i < 4; i++) {
    const o = ctx.createOscillator();
    o.type = i === 3 ? 'square' : 'sawtooth';
    o.frequency.value = hz * (i === 3 ? 0.5 : 1);
    o.detune.value = [-9, 4, 11, 0][i]!;
    o.connect(ring);
    o.connect(dry);
    o.start(at);
    o.stop(at + dur + 0.1);
  }
}

/**
 * The thing above it. A high FM voice that slides and never lands.
 *
 * The modulator runs at a tritone above the carrier, so the sidebands are
 * inharmonic and the ear cannot resolve a pitch out of it — that is what makes a
 * high note read as a scream rather than as a lead. Slow glissando plus vibrato,
 * because a steady one is a test tone.
 */
export function siegeScream(
  v: VoiceCtx,
  at: number,
  dur: number,
  hz: number,
  gain: number,
  intensity: number,
  /** Which way it slides. Alternating this is most of what stops it nagging. */
  rise = true,
): void {
  const { ctx } = v;

  const carrier = ctx.createOscillator();
  carrier.type = 'sawtooth';
  // One shape repeated is a car alarm however unpleasant the timbre — the ear
  // files it as furniture after about three passes. So the glide runs both
  // ways, and the caller walks a line of pitches and lengths across it.
  if (rise) {
    carrier.frequency.setValueAtTime(hz * 0.82, at);
    carrier.frequency.exponentialRampToValueAtTime(hz * 1.35, at + dur * 0.7);
    carrier.frequency.exponentialRampToValueAtTime(hz * 1.06, at + dur);
  } else {
    carrier.frequency.setValueAtTime(hz * 1.28, at);
    carrier.frequency.exponentialRampToValueAtTime(hz * 0.88, at + dur * 0.62);
    carrier.frequency.exponentialRampToValueAtTime(hz * 0.72, at + dur);
  }

  // FM at 1.41x — an augmented fourth. Nothing lines up, so nothing resolves.
  const modulator = ctx.createOscillator();
  modulator.type = 'sine';
  modulator.frequency.value = hz * 1.41;
  const modDepth = ctx.createGain();
  modDepth.gain.setValueAtTime(hz * 0.2, at);
  modDepth.gain.linearRampToValueAtTime(hz * (0.6 + intensity * 1.4), at + dur * 0.75);
  modulator.connect(modDepth).connect(carrier.frequency);
  modulator.start(at);
  modulator.stop(at + dur + 0.1);

  // Vibrato, slow and wide enough to be unsteady rather than expressive.
  const vibrato = ctx.createOscillator();
  vibrato.type = 'sine';
  vibrato.frequency.value = 5.5;
  const vibDepth = ctx.createGain();
  vibDepth.gain.value = hz * 0.02;
  vibrato.connect(vibDepth).connect(carrier.frequency);
  vibrato.start(at);
  vibrato.stop(at + dur + 0.1);

  const band = ctx.createBiquadFilter();
  band.type = 'bandpass';
  band.Q.value = 3.2;
  band.frequency.setValueAtTime(hz, at);
  band.frequency.exponentialRampToValueAtTime(hz * (rise ? 1.8 : 0.62), at + dur * 0.7);

  const out = ctx.createGain();
  out.gain.setValueAtTime(0.0001, at);
  out.gain.exponentialRampToValueAtTime(gain, at + dur * 0.45);
  out.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  carrier.connect(band).connect(out).connect(v.out);
  carrier.start(at);
  carrier.stop(at + dur + 0.1);
}

/**
 * The beat. Heavier and blunter than the run's kick, because this one is not
 * keeping a groove, it is keeping time in a place you do not want to be.
 */
export function siegeHit(v: VoiceCtx, at: number, gain: number, hard: boolean): void {
  const { ctx } = v;

  // A kick reads as *hard* through its pitch envelope far more than its level:
  // the drop is the punch, and the level only decides how much of the mix it
  // takes with it. So this starts higher, falls faster, lands lower and holds.
  const body = ctx.createOscillator();
  body.type = 'sine';
  body.frequency.setValueAtTime(hard ? 210 : 150, at);
  body.frequency.exponentialRampToValueAtTime(hard ? 27 : 36, at + (hard ? 0.075 : 0.1));
  const bodyGain = ctx.createGain();
  bodyGain.gain.setValueAtTime(gain, at);
  bodyGain.gain.exponentialRampToValueAtTime(0.0001, at + (hard ? 0.68 : 0.4));
  body.connect(bodyGain).connect(v.out);
  body.start(at);
  body.stop(at + 0.8);

  // A second sine under the landing, so there is something below the
  // fundamental for the body to sit on. This is the part you feel rather than
  // hear, and it is why the hit has weight instead of just level.
  const under = ctx.createOscillator();
  under.type = 'sine';
  under.frequency.setValueAtTime(hard ? 54 : 62, at);
  under.frequency.exponentialRampToValueAtTime(hard ? 20 : 28, at + 0.3);
  const underGain = ctx.createGain();
  underGain.gain.setValueAtTime(gain * 0.7, at);
  underGain.gain.exponentialRampToValueAtTime(0.0001, at + (hard ? 0.55 : 0.32));
  under.connect(underGain).connect(v.out);
  under.start(at);
  under.stop(at + 0.7);

  // The crack: sixty milliseconds of filtered noise. The transient is what makes
  // a hit read as struck rather than as a tone that started.
  const clickDur = 0.06;
  const noise = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * clickDur), ctx.sampleRate);
  const data = noise.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  const src = ctx.createBufferSource();
  src.buffer = noise;
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = hard ? 1400 : 2200;
  const clickGain = ctx.createGain();
  clickGain.gain.setValueAtTime(gain * (hard ? 0.5 : 0.28), at);
  clickGain.gain.exponentialRampToValueAtTime(0.0001, at + clickDur);
  src.connect(hp).connect(clickGain).connect(v.out);
  src.start(at);
  src.stop(at + clickDur);

  if (!hard) return;

  // Struck metal on the downbeats only. Three inharmonic partials, short.
  for (let i = 0; i < 3; i++) {
    const o = ctx.createOscillator();
    o.type = 'square';
    o.frequency.value = [193, 431, 757][i]!;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain * 0.08, at);
    g.gain.exponentialRampToValueAtTime(0.0001, at + 0.26 - i * 0.05);
    o.connect(g).connect(v.out);
    o.start(at);
    o.stop(at + 0.3);
  }
}
