/**
 * ANTHEM — the one with an actual tune. `?score=anthem`.
 *
 * Nine Scores had come back as "variations on the same theme", and after the
 * ninth it was worth asking what the theme actually *was*. It was not the
 * instruments and it was not the beat. It was two rules in the validator:
 *
 *   **Every melodic note was a chord tone.** `tone()` indexed into the three or
 *   four notes of the chord sounding underneath, so nothing in the game could
 *   ever play a passing note, a step, or anything the harmony did not already
 *   contain. Every "melody" was the current triad in some order. That is an
 *   arpeggio, and no amount of new timbre makes an arpeggio into a tune.
 *
 *   **Harmony could not move.** One or two chords, minimum two bars each, always
 *   opening on the tonic — enforced, with the reason given as "techno is modal".
 *   So the fastest a progression could possibly turn over was one change every
 *   two bars, and most Scores sat on a single chord for eight.
 *
 * Both are gone now, and this Score is what they were in the way of.
 *
 * **Melody.** Every motif and bassline here is a `scale` cell: the digits read as
 * degrees of the key's scale rather than as chord tones, so the lines move by
 * *step*. `0.1.2...3.2.1...` is a phrase that walks up and comes back — three of
 * those notes are not in the chord underneath at any given moment, which is
 * exactly why it sounds like something somebody sang rather than something a
 * machine spelled out.
 *
 * **Harmony that goes somewhere.** Four chords, one bar each, so the ground moves
 * under the tune every two seconds instead of every sixteen. `descent` is
 * ♭VI–♭VII–i, the oldest lift in modal music; `circle` never lands on the tonic
 * at all until the fourth bar.
 *
 * It is still this game — minor, modal, no major resolution anywhere, the same
 * eight-layer engine and the same limiter. It just has a tune in it.
 */
import type { Score } from '../score';
import { deep } from './deep';

export const anthem: Score = {
  ...deep,
  id: 'anthem',
  name: 'Anthem',
  blurb: 'A real tune. Stepwise melody over four chords a bar.',

  tonality: {
    ...deep.tonality,
    // Natural minor. The ♭6 and ♭7 are what keep a stepwise line from sounding
    // like a film score.
    scale: [0, 2, 3, 5, 7, 8, 10],
  },

  cells: {
    ...deep.cells,

    /**
     * Progressions that turn over.
     *
     * A bar each, so the harmony moves at walking pace and the melody above it
     * has somewhere to be going. None of them resolve to a major chord; the lift
     * comes from *movement*, which is a different and much older trick.
     */
    harmonies: [
      // ♭VI – ♭VII – i – i. The lift, without a major chord in sight.
      {
        id: 'descent',
        chords: [
          { root: 8, quality: 'min' },
          { root: 10, quality: 'min' },
          { root: 0, quality: 'min' },
          { root: 0, quality: 'min' },
        ],
        barsPerChord: 1,
        mood: 'lifting',
      },
      // i – ♭VII – ♭VI – ♭VII. Andalusian, walking down and refusing to arrive.
      {
        id: 'andalusian',
        chords: [
          { root: 0, quality: 'min' },
          { root: 10, quality: 'min' },
          { root: 8, quality: 'min' },
          { root: 10, quality: 'min' },
        ],
        barsPerChord: 1,
        mood: 'driving',
      },
      // Three bars away from home before it comes back.
      {
        id: 'circle',
        chords: [
          { root: 5, quality: 'min' },
          { root: 10, quality: 'min7' },
          { root: 8, quality: 'min' },
          { root: 0, quality: 'min' },
        ],
        barsPerChord: 1,
        mood: 'suspended',
      },
      // The Phrygian ♭II, given a bar of its own so you hear it arrive.
      {
        id: 'phrygian-turn',
        chords: [
          { root: 0, quality: 'min' },
          { root: 1, quality: 'maj' },
          { root: 0, quality: 'min' },
          { root: 10, quality: 'min' },
        ],
        barsPerChord: 1,
        mood: 'dark',
      },
      // Slower, for when the Engine is full and the tune needs air.
      {
        id: 'long-fall',
        chords: [
          { root: 0, quality: 'min' },
          { root: 8, quality: 'min' },
        ],
        barsPerChord: 2,
        mood: 'dark',
      },
    ],

    /**
     * Tunes, at last.
     *
     * Read them as shapes rather than as note names. `walk-up` leaves home, gets
     * to the fourth and comes back — a question and its answer. `sigh` falls by
     * step from the fifth, which is the oldest sad gesture there is. `reach` goes
     * up to the ♭7 and hangs there, which is the oldest unresolved one.
     *
     * Two things make these possible and neither existed an hour ago: the digits
     * are *degrees*, so the notes between the chord tones are available; and the
     * chord changes every bar, so a held note becomes a different interval as the
     * ground moves under it. That second one is free counterpoint.
     */
    motifs: [
      { id: 'walk-up', scale: true, steps: '0.1.2...3.2.1...', energy: 2, register: 'high', space: 'mid' },
      { id: 'sigh', scale: true, steps: '4...3...2.......', energy: 1, register: 'high', space: 'sparse' },
      {
        id: 'arch',
        scale: true,
        steps: '0.2.4...6.4.2...' + '0.2.4...2.0.....',
        energy: 3,
        register: 'high',
        space: 'mid',
      },
      {
        id: 'call-answer',
        scale: true,
        steps: '4.3.2.4.0~~~....' + '5.4.3.5.2~~~....',
        energy: 3,
        register: 'high',
        space: 'mid',
      },
      {
        id: 'hymn',
        scale: true,
        steps: '0~~~2~~~4~~~3~~~' + '2~~~0~~~1~~~0~~~',
        energy: 2,
        register: 'mid',
        space: 'sparse',
      },
      {
        id: 'run',
        scale: true,
        steps: '0123456a6543210.',
        energy: 5,
        register: 'high',
        space: 'busy',
      },
      {
        id: 'turn',
        scale: true,
        steps: '2.1.0.1.2.3.2...' + '4.3.2.3.4.5.4...',
        energy: 4,
        register: 'high',
        space: 'busy',
      },
    ],

    /**
     * A bass that walks rather than pumps.
     *
     * Scale cells again, so it can pass *between* the chord tones on the way to
     * the next chord — which is the entire job of a bassline in any music with a
     * progression in it, and was impossible while every note had to be a chord
     * tone.
     */
    basslines: [
      { id: 'root', scale: true, steps: '0~~~~~~~0~~~~~~~', energy: 1, register: 'low', space: 'sparse' },
      { id: 'walk', scale: true, steps: '0...2...4...2...', energy: 2, register: 'low', space: 'mid' },
      { id: 'step-up', scale: true, steps: '0.1.2.3.4.3.2.1.', energy: 4, register: 'low', space: 'busy' },
      { id: 'lead-in', scale: true, steps: '0.....6.0.....1.', energy: 3, register: 'low', space: 'mid' },
      { id: 'drive', scale: true, steps: '0.0.0.6.0.0.1.2.', energy: 5, register: 'low', space: 'busy' },
    ],
  },

  feel: {
    ...deep.feel,

    /**
     * The Engine, as counterpoint.
     *
     * Long notes on the offbeats, in the middle register, so the Programs answer
     * the tune instead of covering it. A melody needs something to be *against*,
     * and four sequencers hammering sixteenths is not that.
     */
    parts: {
      ...deep.feel.parts,
      rhythm: {
        clock: [0, 8],
        on_hit: [4, 12],
        on_kill: [6, 14],
        on_crit: [10],
        on_pickup: [2],
        on_dash: [6],
        on_wound: [12],
        on_wave: [0],
        on_overheat: [8],
        on_convert: [4, 12],
      },
      voice: {
        projectile: { voice: 'pluck', register: 0 },
        burst: { voice: 'organ', register: -12 },
        chain: { voice: 'organ', register: 0 },
        beam: { voice: 'drone', register: -12 },
        zone: { voice: 'drone', register: -12 },
        orbital: { voice: 'bell', register: 12 },
        mine: { voice: 'pluck', register: 0 },
        delayed: { voice: 'organ', register: -12 },
        vortex: { voice: 'sweep', register: 0 },
        knockback: { voice: 'noise', register: 0 },
        buff: { voice: 'bell', register: 12 },
        convert: { voice: 'organ', register: 0 },
      },
      maxSteps: 6,
    },

    // The tune is the point, so it gets the clearest voice in the box and the
    // bass stays out of its way.
    leadVoice: ({ hasOrbital }) => (hasOrbital ? 'bell' : 'pluck'),
    bassVoice: ({ lowest }) => (lowest === 0 ? 'sub' : 'pluck'),
    hueStab: { thermal: 'organ', voltaic: 'organ', void: 'dub' },
    axiomBias: {
      ignition: { key: -2, feel: 'straight', swing: 0.05 },
      circuit: { key: 1, feel: 'rolling', swing: 0 },
      feedback: { key: -5, feel: 'swung', swing: 0.16 },
    },
    ask: {
      ...deep.feel.ask,
      // The melody wants room, not density.
      space: (size) => (size >= 4 ? 'sparse' : 'mid'),
      hatSpace: () => 'mid',
    },
  },

  mix: {
    ...deep.mix,
    tempo: { base: 108, meltdown: 10 },

    /**
     * The lead is present far more than anywhere else here, because for once
     * there is something worth listening to it play. It enters early, it does not
     * rest until the last eighth, and both choruses force it.
     */
    entry: { ...deep.mix.entry, motifPhrase: 0.2, motifIntensity: 0.35, stabPhrase: 0.25 },
    phrase: { answerFrom: 0.5, restFrom: 0.875 },
    register: { ...deep.mix.register, bass: 0, sub: -12, motif: 12, motifAnswer: 24 },
    gains: { ...deep.mix.gains, motif: 0.95, stab: 0.6, hat: 0.55, chord: 0.55, bass: 0.9 },
    filter: { ...deep.mix.filter, floor: 400, span: 4200, q: 1.6, intensityFloor: 0.5 },
    hueColour: { thermal: 1, voltaic: 1.2, void: 0.75 },
  },

  graph: {
    ...deep.graph,
    // Enough room to sound like a place, not so much that the melody smears.
    reverb: { send: 0.2, seconds: 2.6, damp: 3400, predelay: 0.02, highpass: 0 },
    delay: { ...deep.graph.delay, feedback: 0.42, damp: 2200 },
  },

  /**
   * Three rows, all sparse Triggers, so the counterpoint answers the tune
     * instead of burying it. One bell, two plucks.
   */
  demo: {
    axiomId: 'ignition',
    from: 6,
    rows: [
      { triggerId: 'clock', primitive: 'projectile', hue: 'thermal', modifiers: [] },
      { triggerId: 'on_crit', primitive: 'orbital', hue: 'voltaic', modifiers: [] },
      { triggerId: 'on_kill', primitive: 'mine', hue: 'thermal', modifiers: [] },
    ],
  },
};
