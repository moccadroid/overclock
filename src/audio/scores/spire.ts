/**
 * SPIRE — the fast one. `?score=spire`.
 *
 * Six Scores in a row went darker, slower or emptier, which after a while stops
 * being a range and starts being a rut. This one goes the other way on purpose:
 * 132 BPM, a filter that opens further than anything else here, bells over an
 * acid line, and a rolling kick that never lets go.
 *
 * It is not a return to `current`. `current` is *bright* — major chords, a tune
 * in the top octave, everything consoling. This is **fast without being kind**:
 * the harmony is still modal and minor, the ♭II is still in the pool, and the
 * lead is a bell rather than a melody. Trance energy on a Phrygian scale, which
 * is a much older and much less comfortable combination than either half
 * suggests.
 *
 * Worth having for a practical reason as well as a musical one: this is a
 * bullet-heaven, and a soundtrack that only knows how to be ominous has nothing
 * to give a run that is going well.
 */
import type { Score } from '../score';
import { deep } from './deep';

export const spire: Score = {
  ...deep,
  id: 'spire',
  name: 'Spire',
  blurb: 'Fast, not kind. Bells over acid, 132 BPM.',

  cells: {
    ...deep.cells,

    // Relentless. Every one of these keeps all four quarters and adds to them.
    kicks: [
      { id: 'four', pattern: 'x...x...x...x...', energy: 2, feel: 'straight', space: 'sparse' },
      { id: 'roll', pattern: 'x...x...x..xx...', energy: 3, feel: 'rolling', space: 'mid' },
      { id: 'drive', pattern: 'X...x...X...x..x', energy: 4, feel: 'rolling', space: 'mid' },
      { id: 'gallop', pattern: 'X..xx...X..xx...', energy: 5, feel: 'rolling', space: 'busy' },
    ],

    // Claps on 2 and 4, and proud of it.
    backbeats: [
      { id: 'two-four', pattern: '....X.......X...', energy: 2, feel: 'straight', space: 'sparse' },
      { id: 'ghosted', pattern: '....X..o....X..o', energy: 4, feel: 'rolling', space: 'mid' },
      { id: 'roll-in', pattern: '....X...ooooX...', energy: 5, feel: 'rolling', space: 'busy' },
    ],

    hats: [
      { id: 'offbeat', pattern: '..x...x...x...x.', energy: 2, feel: 'straight', space: 'sparse' },
      { id: 'eighths', pattern: 'x.x.x.x.x.x.x.x.', energy: 3, feel: 'straight', space: 'mid' },
      { id: 'sixteenths', pattern: 'oxoxoxoxoxoxoxox', energy: 4, feel: 'straight', space: 'busy' },
      { id: 'driving', pattern: 'oxoxoxoxoxoxox-x', energy: 5, feel: 'rolling', space: 'busy' },
    ],

    // A 303 that moves. Accents and slides, because at this tempo a static bass
    // is a drone and a drone at 132 is a mistake.
    basslines: [
      { id: 'pump', steps: '..0...0...0...0.', energy: 2, register: 'low', space: 'sparse' },
      { id: 'roll', steps: '0.0.0.0.0.0.0.2.', accent: 'x.......x.......', energy: 3,
        register: 'low', space: 'busy' },
      { id: 'acid', steps: '0.0.2.0.1.0.2.1.', accent: 'x...x.......x...',
        slide: '..~.....~.......', energy: 4, register: 'low', space: 'busy' },
      { id: 'acid-climb', steps: '0.1.2.1.0.2.1.2.', accent: 'x...x...x...x...',
        slide: '..~...~...~.....', energy: 5, register: 'low', space: 'busy' },
    ],

    // Up top, and moving. These are hooks rather than signals.
    motifs: [
      { id: 'ring', steps: '....a.......b...', energy: 2, register: 'high', space: 'sparse' },
      { id: 'peal', steps: '..a...b...c...b.', energy: 3, register: 'high', space: 'mid' },
      { id: 'climb', steps: 'a.b.c.b.a.b.c...', energy: 4, register: 'high', space: 'busy' },
      { id: 'chime', steps: 'a...c...b...c...' + 'a...b...c...b...', energy: 4,
        register: 'high', space: 'mid' },
      { id: 'cascade', steps: 'c.b.a.b.c.b.a...' + 'c.b.a.c.b.a.b.c.', energy: 5,
        register: 'high', space: 'busy' },
    ],

    stabs: [
      { id: 'offbeat', pattern: '..x...x...x...x.', energy: 3, space: 'mid' },
      { id: 'pushed', pattern: '...x..x....x.x..', energy: 4, space: 'busy' },
      { id: 'downbeat', pattern: 'x.......x.......', energy: 2, space: 'sparse' },
      { id: 'hammer', pattern: 'x.x.x.x.x.x.x.x.', energy: 5, space: 'busy' },
    ],
  },

  feel: {
    ...deep.feel,

    /**
     * The Engine, at speed.
     *
     * Sixteenths where the default has quarters, and every Action gets a short
     * bright voice with a moving contour — so four Programs read as an arpeggio
     * pattern rather than as four held notes. The opposite decision from `rust`,
     * from the same table.
     */
    parts: {
      ...deep.feel.parts,
      rhythm: {
        clock: [0, 2, 4, 6, 8, 10, 12, 14],
        on_hit: [0, 1, 2, 3, 8, 9, 10, 11],
        on_kill: [4, 5, 6, 12, 13, 14],
        on_crit: [3, 7, 11, 15],
        on_pickup: [2, 6, 10, 14],
        on_dash: [1, 5, 9, 13],
        on_wound: [7, 15],
        on_wave: [0, 8],
        on_overheat: [0, 4, 8, 12],
        on_convert: [1, 3, 5, 7, 9, 11, 13, 15],
      },
      voice: {
        projectile: { voice: 'pluck', register: 24 },
        burst: { voice: 'stab', register: 0 },
        chain: { voice: 'acid', register: 12 },
        beam: { voice: 'acid', register: 0 },
        zone: { voice: 'stab', register: -12 },
        orbital: { voice: 'bell', register: 24 },
        mine: { voice: 'tick', register: 12 },
        delayed: { voice: 'tick', register: 0 },
        vortex: { voice: 'riser', register: 12 },
        knockback: { voice: 'noise', register: 12 },
        buff: { voice: 'bell', register: 24 },
        convert: { voice: 'pluck', register: 12 },
      },
      contour: {
        ...deep.feel.parts.contour,
        pluck: [[0, 2, 4, 2], [0, 4, 2, 6]],
        acid: [[0, 1, 2, 4, 2, 1]],
        bell: [[0, 4, 2, 6, 4, 2]],
      },
      maxSteps: 16,
    },

    hueKick: { thermal: 'punch', voltaic: 'tight', void: 'punch' },
    huePerc: { thermal: 'clap', voltaic: 'snare', void: 'clap' },
    hueStab: { thermal: 'saw', voltaic: 'saw', void: 'organ' },
    // Acid low, bells high. The two sounds this Score is made of.
    bassVoice: () => 'acid',
    leadVoice: () => 'bell',
    // Busy is the default and sparse has to be earned, which is the opposite of
    // every other Score here.
    ask: { ...deep.feel.ask, space: (size) => (size >= 5 ? 'mid' : 'busy'),
           hatSpace: () => 'busy', stabSpace: () => 'mid' },
    echo: (count) => Math.min(0.7, 0.1 + count('echo') * 0.4 + count('ricochet') * 0.2),
    brightness: (count) =>
      Math.max(0.6, Math.min(1.9, 1.15 + count('overdrive') * 0.35 + count('amplify') * 0.2 -
        count('ground') * 0.3)),
    drive: (size) => 0.9 + Math.min(1, size / 4) * 0.9,
    axiomBias: {
      ignition: { key: 0, feel: 'rolling', swing: 0 },
      circuit: { key: 3, feel: 'rolling', swing: 0 },
      feedback: { key: -4, feel: 'straight', swing: 0.1 },
    },
  },

  mix: {
    ...deep.mix,
    tempo: { base: 132, meltdown: 8 },

    /**
     * Shorter sections and a hard drop, because at this tempo sixteen bars goes
     * past in half a minute and a 32-bar break would be an interruption rather
     * than a breath.
     */
    form: [
      { id: 'intro', bars: 8, backbeat: 'out', hats: 'auto', bass: 'auto', stab: 'out',
        lead: 'out', chord: 'auto', parts: 'out', open: [0.3, 0.55], hook: false },
      { id: 'verse', bars: 32, backbeat: 'auto', hats: 'auto', bass: 'auto', stab: 'auto',
        lead: 'auto', chord: 'auto', parts: 'auto', open: [0.45, 0.7], hook: false },
      { id: 'build', bars: 16, backbeat: 'auto', hats: 'force', bass: 'force', stab: 'force',
        lead: 'out', chord: 'auto', parts: 'auto', open: [0.55, 1], hatEvery: 2, hook: false },
      { id: 'chorus', bars: 32, backbeat: 'auto', hats: 'force', bass: 'force', stab: 'force',
        lead: 'force', chord: 'force', parts: 'auto', open: [0.8, 0.98], hook: true, restFrom: 1 },
      { id: 'break', bars: 8, backbeat: 'out', hats: 'out', bass: 'out', stab: 'out',
        lead: 'out', chord: 'force', parts: 'out', open: [0.6, 0.2], hook: false },
      { id: 'drop', bars: 16, backbeat: 'force', hats: 'force', bass: 'force', stab: 'force',
        lead: 'out', chord: 'out', parts: 'force', open: [1, 0.9], hatEvery: 1, hook: false },
      { id: 'chorus-2', bars: 32, backbeat: 'auto', hats: 'force', bass: 'force', stab: 'force',
        lead: 'force', chord: 'force', parts: 'auto', open: [0.85, 1], hook: true, restFrom: 1 },
    ],

    // The widest filter in the game, and the least resonant — this one is meant
    // to be open rather than to sing.
    filter: { floor: 500, span: 6400, q: 1.2, intensityFloor: 0.5, intensitySpan: 0.5, glide: 0.06 },
    hueColour: { thermal: 1.05, voltaic: 1.4, void: 0.85 },
    register: { ...deep.mix.register, bass: -12, sub: -12, motif: 24, motifAnswer: 36 },
    gains: { ...deep.mix.gains, hat: 0.85, stab: 0.85, motif: 0.9, kick: 0.98, chord: 0.7 },
    entry: { ...deep.mix.entry, stabPhrase: 0.15, stabIntensity: 0.35,
             motifPhrase: 0.35, motifIntensity: 0.5, chordIntensity: 0.15 },
    phrase: { answerFrom: 0.5, restFrom: 0.9 },
    duck: { depth: 0.28, recover: 0.7 },
  },

  graph: {
    ...deep.graph,
    reverb: { send: 0.14, seconds: 1.8, damp: 4200, predelay: 0.012, highpass: 0 },
    delay: { note: 0.75, feedback: 0.45, damp: 2600, glide: 0.2 },
  },

  /**
   * Five voltaic rows, every one high and fast. Bells and acid, tight kick,
     * snare, and the busiest arrangement the engine will produce.
   */
  demo: {
    axiomId: 'circuit',
    from: 11,
    rows: [
      { triggerId: 'on_hit', primitive: 'projectile', hue: 'voltaic', modifiers: ['accelerate'] },
      { triggerId: 'on_crit', primitive: 'orbital', hue: 'voltaic', modifiers: ['amplify'] },
      { triggerId: 'clock', primitive: 'chain', hue: 'voltaic', modifiers: ['split'] },
      { triggerId: 'on_kill', primitive: 'buff', hue: 'voltaic', modifiers: [] },
      { triggerId: 'on_pickup', primitive: 'projectile', hue: 'voltaic', modifiers: [] },
    ],
  },
};
