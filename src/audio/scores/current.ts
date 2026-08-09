/**
 * THE CURRENT SCORE — the game as it sounds today, verbatim.
 *
 * Every number here was a literal at its point of use before the Score existed,
 * and this file is the switch-back guarantee: with no `?score=` in the URL the
 * game plays exactly what it played at `2d48e48`, and `schedule.test.ts` holds
 * that to the sample-accurate schedule.
 *
 * **So nothing in this file is a value judgement.** It is a transcription. The
 * rationale comments came across with the numbers they explain, because a number
 * without its reason is a number the next person will "clean up" — but if you
 * find yourself wanting to *improve* something here, that is a different Score,
 * not an edit to this one.
 */
import { CELLS, type Space } from '../cells';
import type { Score } from '../score';

export const current: Score = {
  id: 'current',
  name: 'Current',

  cells: CELLS,

  tonality: {
    // Triads and one seventh. Every entry is consonant, which is both why forty
    // simultaneous accents never clash and why this Score cannot sound dangerous
    // however it is arranged.
    chords: {
      min: [0, 3, 7],
      maj: [0, 4, 7],
      sus: [0, 5, 7],
      min7: [0, 3, 7, 10],
    },
  },

  feel: {
    axiomBias: {
      ignition: { key: 0, feel: 'straight', swing: 0 },
      circuit: { key: 3, feel: 'rolling', swing: 0 },
      feedback: { key: -4, feel: 'swung', swing: 0.18 },
    },
    defaultAxiom: 'ignition',

    hueKick: { thermal: 'punch', voltaic: 'tight', void: 'deep' },
    huePerc: { thermal: 'clap', voltaic: 'snare', void: 'rim' },
    hueStab: { thermal: 'organ', voltaic: 'saw', void: 'dub' },
    huePadWave: { thermal: 'sawtooth', voltaic: 'square', void: 'sawtooth' },

    // An Engine with no rows gets the rim, whatever its hue. It also earns its
    // keep in a run's first minute — the drums fill in as the Engine does, rather
    // than arriving complete before you own anything.
    emptyPercVoice: 'rim',

    primitiveRegister: {
      burst: 0,
      zone: 0,
      delayed: 0,
      knockback: 1,
      vortex: 1,
      chain: 1,
      beam: 1,
      convert: 1,
      mine: 1,
      projectile: 2,
      orbital: 2,
      buff: 2,
    },

    cascadeTriggers: new Set(['on_hit', 'on_kill', 'on_crit']),

    weights: {
      energy: 2,
      feel: 3,
      space: 2,
      register: 4,
      avoid: 2.5,
      // Small enough never to beat a real preference, large enough that two
      // equally good cells do not always resolve the same way for every build.
      jitterScale: 120,
    },

    lift: [0, 1, 0, -1],

    /**
     * Read off what the Engine is *for*. A build that feeds on its own output
     * never resolves, so neither does its harmony; an economy build sits
     * suspended; a metronome build stays dark and modal.
     *
     * Meltdown overrides all of it — whatever the Engine is for stops being the
     * most interesting fact about the run the moment the containment goes.
     */
    chooseMood: ({ meltdown, hasConvert, hasCascade, size }) =>
      meltdown
        ? 'dark'
        : hasConvert
          ? 'suspended'
          : hasCascade
            ? 'driving'
            : size >= 3
              ? 'lifting'
              : 'dark',

    /**
     * Accelerate makes a row fire more often, so it makes the kick roll — the
     * most direct build-to-beat mapping there is. Ricochet asks for `broken`
     * because a bounce that lands somewhere other than where it was aimed is the
     * one thing in the grammar that already means "off the grid".
     */
    chooseFeel: (count, bias) =>
      count('accelerate') > 0 ? 'rolling' : count('ricochet') > 0 ? 'broken' : bias,

    shiftSpace: (base: Space, lift: number): Space => {
      if (lift > 0) return base === 'sparse' ? 'mid' : 'busy';
      if (lift < 0) return base === 'busy' ? 'mid' : 'sparse';
      return base;
    },

    // The lowest Action you own picks the bass voice, because that is the one
    // competing with it for the same octave.
    bassVoice: ({ lowest, hue }) => (lowest === 0 ? 'sub' : hue === 'voltaic' ? 'acid' : 'pluck'),
    leadVoice: ({ hasOrbital, hue }) =>
      hasOrbital ? 'bell' : hue === 'voltaic' ? 'acid' : 'pluck',

    ask: {
      kickEnergy: (size) => 1 + Math.min(4, size),
      backbeatEnergy: (i) => Math.max(1, Math.round(1 + i * 4)),
      hatEnergy: (i, lift) => Math.max(1, Math.round(1 + i * 4) + lift),
      hatSpace: (i) => (i > 0.6 ? 'busy' : 'mid'),
      bassEnergy: (i, lift) => Math.max(1, Math.round(1 + i * 3) + lift),
      motifEnergy: (i, lift) => Math.max(1, Math.round(1 + i * 3) + lift),
      motifRegister: (highest) => (highest === 2 ? 'high' : 'mid'),
      stabEnergy: (size, lift) => Math.max(1, Math.min(4, size) + lift),
      // Stops at `mid` rather than reaching `busy`: the stab is the loudest
      // melodic thing in the mix.
      stabSpace: (size) => (size >= 4 ? 'sparse' : 'mid'),
      // More rows means less room. The single most important rule in the
      // arranger — without it a five-row build and a busy bassline are competing
      // for the same bar.
      space: (size) => (size >= 4 ? 'sparse' : size >= 2 ? 'mid' : 'busy'),
    },

    // Draft Echo and the room opens up; draft Ground and the bass goes dark.
    echo: (count) => Math.min(0.85, count('echo') * 0.4 + count('ricochet') * 0.2),
    brightness: (count) =>
      Math.max(
        0.4,
        Math.min(1.9, 1 + count('overdrive') * 0.35 + count('amplify') * 0.2 - count('ground') * 0.3),
      ),
    bassQ: (voice, count) => (voice === 'acid' ? 14 + count('overdrive') * 3 : 7),
    drive: (size) => 0.6 + Math.min(1, size / 4) * 0.8,
  },

  mix: {
    /**
     * One section, sixteen bars, repeating. The behaviour the form system
     * replaced, declared as a form so nothing about this Score moved.
     *
     * `open` is `[0.25, 1]` because the expression it stands in for was
     * `0.25 + phrase * 0.75`, and every layer is `auto` because the entry
     * thresholds below are what decided them.
     */
    form: [
      {
        id: 'phrase',
        bars: 16,
        backbeat: 'auto',
        hats: 'auto',
        bass: 'auto',
        stab: 'auto',
        lead: 'auto',
        chord: 'auto',
        parts: 'auto',
        open: [0.25, 1],
        hook: false,
      },
    ],
    hookIntensity: 0.85,

    phraseBars: 16,
    // Two phrases at 112 BPM is a little over a minute — long enough that the
    // line is a hook rather than a tour of the library, short enough that nobody
    // sits through the same two motifs for eleven minutes.
    varyBars: 32,
    maxAccentsPerStep: 3,
    intensitySmoothing: 0.04,
    siegeSmoothing: 0.06,
    siegeFloor: 0.002,

    // §18.2 asked for 110 rising to 140. 140 is right for the *feeling* of
    // Meltdown and wrong as a continuous ramp: a groove needs a stable pulse.
    tempo: { base: 112, meltdown: 12 },

    hueColour: { thermal: 1, voltaic: 1.45, void: 0.7 },

    filter: {
      floor: 420,
      span: 5200,
      q: 1.1,
      intensityFloor: 0.5,
      intensitySpan: 0.5,
      glide: 0.08,
    },

    phrase: { answerFrom: 0.5, restFrom: 0.875 },

    gains: {
      kick: 0.95,
      // Scaled by intensity, so the menu does not get the same clap as a full run
      // with no wall of engine to sit behind.
      backbeatBase: 0.5,
      backbeatPerIntensity: 0.3,
      hat: 0.8,
      hatBleak: 0.45,
      bass: 0.85,
      stab: 0.9,
      motif: 0.9,
      sub: 0.7,
      chord: 0.85,
      chordBleak: 0.6,
    },

    entry: {
      hatDrive: 0.08,
      bass: 0.03,
      stabPhrase: 0.24,
      stabIntensity: 0.5,
      motifPhrase: 0.48,
      motifIntensity: 0.65,
      chordIntensity: 0.3,
    },

    register: { bass: -12, sub: -24, motif: 24, motifAnswer: 36, part: 24 },

    length: { sub: 2, chord: 0.45, chordBleak: 3.6 },

    // A little of this is the whole difference between a machine and a groove.
    swing: 0.25,

    duck: { depth: 0.34, recover: 0.75 },

    bus: { music: 0.9, stalled: 0.12 },

    accents: {
      // A *reduction*, which is the direction that stays comfortable: the engine
      // layer thins out rather than everything else getting louder to bury it.
      duckPerIntensity: 0.95,
      duckCap: 0.75,
      duckFloor: 0.3,
      weightGate: 0.55,
      gainBase: 0.3,
      gainSpan: 0.6,
      base: { kill: 2, pickup: 4 },
      maxDegree: 11,
    },

    occasion: {
      perStep: 2,
      // Three hits on the beat rather than one long swell — an occasion should
      // land *in* the track, not float above it.
      hits: 3,
      spacing: 0.5,
      decay: 0.18,
      length: 0.42,
      gain: 1,
      // Overheat resolves *down* a fourth: the one chord in the game that sounds
      // like something went wrong rather than right. Quieter than a level-up, not
      // louder — it is already the most stressful moment in the run.
      overheatShift: -5,
      overheatSubShift: -29,
      overheatSubGain: 0.55,
      overheatSubLength: 1.1,
      overheatGain: 0.45,
    },

    bigEvent: {
      subGain: 0.9,
      subLength: 0.45,
      chordGain: 1,
      chordLength: 0.4,
      hueGain: 0.8,
      hueRegister: 24,
      // Two steps of room. Any longer and the groove notices the hole.
      claim: 2,
    },

    siege: {
      hitGain: 0.62,
      // A fixed low E that has nothing to do with whatever key the run is in.
      droneHz: 41.2,
      droneLength: 4.2,
      // Small on purpose: a resonant filter with Q up to 14 is an amplifier, and
      // four oscillators through it at what looked like a sane 0.5 rendered at
      // peak 3.3. Measured, not guessed.
      droneGainBase: 0.28,
      droneGainPerSiege: 0.12,
      // Down to a quarter on the hit, back over the next two fifths of a beat.
      // The hole is what the ear hears as impact.
      droneDuckDepth: 0.26,
      droneDuckRecover: 0.42,
      screamFrom: 0.3,
      screamLength: 0.6,
      // Large because a bandpass at Q 3.2 over an FM carrier throws most of the
      // energy away — at a reasonable-looking 0.13 this rendered at peak 0.05.
      screamGainBase: 0.13,
      screamGainPerSiege: 0.15,
      screamRegister: 4,
      screamOctaves: 8,
      answerFrom: 0.75,
      answerLength: 1.5,
      answerGainBase: 0.11,
      answerGainPerSiege: 0.12,
      answerRegister: 11,
      answerStride: 3,
      // All the way out. Keeping a trace of the run's arrangement underneath left
      // mud under the drone, and the drone is the point.
      scoreTrim: 1,
      fxDry: 0.72,
      fxWet: 1.35,
      crossfade: 0.25,
      /**
       * §21b.7 — what the siege screams, as a line rather than a note.
       *
       * The first version played one pitch on alternate bars and got annoying,
       * which is exactly right: the ear files an unchanging shape as furniture
       * after about three repeats, however ugly the timbre is. Something that
       * keeps *moving* stays a threat.
       *
       * Degrees are semitones over the drone's root, from the Phrygian set — root,
       * ♭2, ♭3, 4, 5, ♭6, ♭7. Every interval in it is minor or flat, so the line
       * can wander without ever landing anywhere consoling, and the ♭2 against the
       * drone is the same semitone rub the Meltdown and breach voices are built
       * on.
       *
       * The walk is ten long against a hold that fires it maybe eight times, so it
       * does not come back round inside one gate. `up` is not a strict
       * alternation, because that is itself a pattern.
       */
      cries: [
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
      ],
    },

    interfere: {
      corner: 200,
      open: 20000,
      level: 0.06,
      // Fast in, slow out. The room stops working in a quarter of a second and
      // takes the best part of a second to come back, so it reads as something
      // being done to it rather than as a setting changing.
      inSeconds: 0.2,
      outSeconds: 0.9,
    },

    hoverThrottle: 0.045,
  },

  graph: {
    // A low shelf before the limiter: down where the kick and bass live, which is
    // where "oomph" comes from.
    lowShelf: { hz: 110, gain: 5 },

    limiter: {
      // Deliberately aggressive. This is a leveller, not a mastering compressor —
      // musical transparency is worth nothing next to the promise that the volume
      // never rises.
      threshold: -34,
      knee: 4,
      ratio: 20,
      attack: 0.003,
      release: 0.12,
      // Driven into the limiter rather than merely caught by it, then brought
      // straight back down. A threshold the quiet passages never reach only
      // levels the loud ones, which leaves the loud ones louder.
      drive: 12,
      // Calibrated by measurement, not arithmetic: with the limiter working this
      // hard the drive is not what sets the output, so `1/drive` is the wrong
      // number and produced a game nobody could hear.
      trim: 0.75,
    },

    // Dotted eighth is the classic dub delay: it lands between the beats rather
    // than on them, so the echoes read as counter-rhythm instead of as a stutter.
    delay: { note: 0.75, feedback: 0.52, damp: 1700, glide: 0.2 },

    // Narrow and high, then ring-modulated: everything below about 700Hz and
    // above 3kHz goes, which takes the body out of a shot and leaves the part
    // that sounds broken. 180Hz is low enough that the sidebands land inside the
    // band the filter kept, so it reads as the sound being torn.
    siegeFx: { band: 1500, q: 2.4, ringHz: 180 },

    busGains: { punch: 0.95, music: 0.9, engine: 0.5, ui: 0.5, siege: 0 },

    /**
     * Space, at zero send.
     *
     * There is no reverb anywhere else in this graph, which is most of why the
     * game sounds present and close rather than distant. The bus exists so that a
     * Score which wants distance has somewhere to send to; `current` sends
     * nothing, so the schedule is unchanged and these three numbers are inert.
     */
    reverb: { send: 0, seconds: 2.6, damp: 3200, predelay: 0.02 },
  },

  voices: {
    kick: {
      spec: {
        punch: { from: 190, to: 35, drop: 0.075, decay: 0.42, click: 0.5, clickHz: 900 },
        tight: { from: 220, to: 44, drop: 0.045, decay: 0.19, click: 0.85, clickHz: 1600 },
        deep: { from: 120, to: 28, drop: 0.13, decay: 0.85, click: 0.12, clickHz: 420 },
      },
      gain: 1.15,
      attack: 0.003,
      clickAttack: 0.001,
      clickDecay: 0.012,
      clickHp: 400,
    },

    hat: { hz: 7000, attack: 0.001, closed: 0.035, open: 0.16, gain: 0.16 },

    sub: { attack: 0.02, gain: 0.45 },

    bass: {
      // Dub bass is a pitch you feel arriving and leaving, not a note you hear
      // played: almost a sine, long, no filter movement at all.
      sub: { length: 3.2, attack: 0.02, gain: 0.75, triangle: 0.25 },
      // A 303. The squelch is the envelope, not the resonance — that is the part
      // everyone gets wrong. Snap wide open, collapse fast.
      acid: {
        accentLength: 1.35,
        attack: 0.004,
        gain: 0.5,
        accentGain: 0.75,
        peak: 15,
        accentPeak: 26,
        peakCeiling: 7000,
        start: 1.4,
        startFloor: 90,
        land: 1.6,
        landFloor: 80,
        rise: 0.012,
        fall: 0.55,
        accentFall: 0.9,
        glide: 0.055,
      },
      pluck: {
        attack: 0.006,
        gain: 0.6,
        cutoff: 14,
        cutoffCeiling: 4200,
        land: 2.2,
        landFloor: 70,
        fall: 0.8,
        subLevel: 0.5,
      },
    },

    stab: {
      // Hammond by way of a drawbar: fundamental, octave, and the fifth above
      // that. Warm, and unmistakably not a saw.
      organ: {
        length: 0.17,
        attack: 0.004,
        gain: 0.1,
        drawbar: [
          [1, 1],
          [2, 0.5],
          [3, 0.28],
        ],
        level: 0.33,
        register: 24,
      },
      filtered: {
        saw: { wave: 'sawtooth', length: 0.14, gain: 0.13, open: 5200, close: 1100, q: 4 },
        // Heavily filtered and short, meant to be fed to the delay and heard
        // mostly as its own echoes.
        dub: { wave: 'triangle', length: 0.1, gain: 0.16, open: 1500, close: 500, q: 2 },
      },
      attack: 0.003,
      detune: 6,
      level: 0.4,
      register: 24,
    },

    lead: {
      /**
       * A struck bell — bright in the attack, a tone immediately after.
       *
       * It used to be FM at a ratio of 2.41 with an index of 2.4 held for most of
       * the note and **no filter at all**. An inharmonic ratio at that index
       * throws sidebands a long way either side of the carrier and every one went
       * straight out; Orbital also sits at register +12 and a voltaic build adds
       * another +12, so the worst case was a dense inharmonic spray two octaves
       * up. Harmonic ratio, shallow index, and a ceiling.
       */
      bell: {
        length: 0.75,
        attack: 0.006,
        gain: 0.07,
        ratio: 2,
        depth: 1.05,
        depthEnd: 0.02,
        collapse: 0.2,
        ceiling: 4800,
        cutoff: 5,
        q: 0.6,
      },
      // The 303 again but an octave up and shorter: reedy and vocal, and it
      // slides, which is what makes a line sound played rather than sequenced.
      acid: {
        length: 0.22,
        attack: 0.004,
        gain: 0.075,
        q: 14,
        start: 1.6,
        peak: 9,
        peakCeiling: 9000,
        rise: 0.02,
        land: 2,
        fall: 0.7,
        glide: 0.05,
      },
      pluck: {
        length: 0.19,
        attack: 0.004,
        gain: 0.09,
        open: 6,
        close: 1.5,
        q: 7,
        octave: 2.002,
        octaveLevel: 0.35,
      },
    },

    // A chord that *hits*. The old pad had a two-second attack on an eight-bar
    // chord: it swelled with no relationship to the grid, which is exactly what
    // "ethereal, no connection" describes. Harmony here is carried rhythmically.
    chord: {
      attack: 0.006,
      gain: 0.13,
      open: 3400,
      close: 900,
      q: 2.2,
      detune: 5,
      level: 0.3,
      register: 24,
    },
  },
};
