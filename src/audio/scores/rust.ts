/**
 * RUST — dub techno. `?score=rust`.
 *
 * The pulse stays. Everything else goes.
 *
 * **There is no lead at all.** Not quiet, not sparse — absent, in every section,
 * for the whole song. That is the one decision this Score is built on, and it is
 * the genre's actual rule rather than a stylistic flourish: Basic Channel and
 * everyone after them worked out that if you take the melody away, the *chord*
 * becomes the melody, and a chord you hear mostly as its own echoes becomes a
 * place rather than an event.
 *
 * So the stab is the only pitched thing above the bass, it is the `dub` voice
 * (short, heavily filtered, built to be fed to a delay), and the delay is turned
 * up until the repeats outnumber the hits. Feedback at 0.68 with the damping
 * low means every echo arrives darker than the last and the tail dissolves
 * rather than stopping — which is the entire personality of the genre and was
 * sitting in this graph unused because nothing ever sent enough into it.
 *
 * Underneath: a sub that holds, a kick that is felt rather than heard, and hats
 * brushed so far back they read as tape hiss.
 */
import type { Score } from '../score';
import { deep } from './deep';

export const rust: Score = {
  ...deep,
  id: 'rust',
  name: 'Rust',
  blurb: 'Dub techno. No melody: the chord is the melody.',

  cells: {
    ...deep.cells,

    // Soft and plain. The kick's job here is to be a floor, not a statement.
    kicks: [
      { id: 'floor', pattern: 'x...x...x...x...', energy: 2, feel: 'straight', space: 'sparse' },
      { id: 'floor-soft', pattern: 'x...o...x...o...', energy: 1, feel: 'straight', space: 'sparse' },
      { id: 'walk', pattern: 'x...x...x...x..x', energy: 3, feel: 'rolling', space: 'mid' },
    ],

    // Barely there. A rim on the offbeat, ghosted.
    backbeats: [
      { id: 'ghost', pattern: '....o.......o...', energy: 1, feel: 'straight', space: 'sparse' },
      { id: 'ghost-late', pattern: '....o.......o..o', energy: 2, feel: 'swung', space: 'sparse' },
      { id: 'tick', pattern: '....x.......o...', energy: 3, feel: 'straight', space: 'sparse' },
    ],

    hats: [
      { id: 'hiss', pattern: '..o...o...o...o.', energy: 1, feel: 'straight', space: 'sparse' },
      { id: 'hiss-open', pattern: '..o...-...o...o.', energy: 2, feel: 'straight', space: 'mid' },
      { id: 'shuffle', pattern: '..o..o..o..o..o.', energy: 3, feel: 'swung', space: 'mid' },
    ],

    // Held. A dub bass is a pitch you feel arriving and leaving.
    basslines: [
      { id: 'hold', steps: '0~~~~~~~~~~~~~~~', energy: 1, register: 'low', space: 'sparse' },
      { id: 'hold-two', steps: '0~~~~~~~2~~~~~~~', energy: 2, register: 'low', space: 'sparse' },
      { id: 'breathe', steps: '0~~~~~~~....0~~~', energy: 3, register: 'low', space: 'mid' },
      { id: 'step', steps: '0~~~0~~~2~~~1~~~', energy: 4, register: 'low', space: 'mid' },
    ],

    /**
     * Off the beat, and never on it.
     *
     * The stab is the whole top half of this record, so where it lands is the
     * arrangement. All of these avoid the downbeat: a chord on the one is a
     * *statement*, and a chord on the offbeat is a groove.
     */
    stabs: [
      { id: 'offbeat', pattern: '..x...x...x...x.', energy: 3, space: 'mid' },
      { id: 'sparse', pattern: '......x.........', energy: 1, space: 'sparse' },
      { id: 'two', pattern: '..x.......x.....', energy: 2, space: 'sparse' },
      { id: 'push', pattern: '..x...x.....x.x.', energy: 4, space: 'busy' },
      { id: 'skank', pattern: '..x..x..x..x..x.', energy: 5, space: 'busy' },
    ],

    // Present so the pool is not empty; never selected, because no section lets
    // the lead play.
    motifs: [
      { id: 'unused', steps: '................', energy: 1, register: 'mid', space: 'sparse' },
    ],
  },

  feel: {
    ...deep.feel,

    /**
     * The Engine, dubbed.
     *
     * Every Trigger fires half as often and never on the downbeat, and every
     * Action becomes a low sustained voice — so four live Programs read as a
     * chord breathing rather than as four sequencers. In a genre with no melody
     * the Engine's lines are the only moving pitches, so this is where the
     * variety has to come from.
     */
    parts: {
      ...deep.feel.parts,
      rhythm: {
        clock: [2, 10],
        on_hit: [6, 14],
        on_kill: [3, 11],
        on_crit: [7],
        on_pickup: [13],
        on_dash: [5],
        on_wound: [9],
        on_wave: [2],
        on_overheat: [6],
        on_convert: [3, 11],
      },
      voice: {
        projectile: { voice: 'drone', register: 0 },
        burst: { voice: 'drone', register: -12 },
        chain: { voice: 'organ', register: 0 },
        beam: { voice: 'drone', register: -12 },
        zone: { voice: 'drone', register: -12 },
        orbital: { voice: 'organ', register: 12 },
        mine: { voice: 'tick', register: -12 },
        delayed: { voice: 'drone', register: -12 },
        vortex: { voice: 'sweep', register: -12 },
        knockback: { voice: 'noise', register: 0 },
        buff: { voice: 'organ', register: 0 },
        convert: { voice: 'organ', register: 0 },
      },
      maxSteps: 4,
    },

    hueKick: { thermal: 'deep', voltaic: 'punch', void: 'deep' },
    huePerc: { thermal: 'rim', voltaic: 'rim', void: 'rim' },
    // The dub stab on every hue. This is not a Score where the hue changes the
    // instrument — it changes how bright the one instrument sits.
    hueStab: { thermal: 'dub', voltaic: 'dub', void: 'dub' },
    bassVoice: () => 'sub',
    // Everything sent to the delay, always, whatever the build drafted.
    echo: () => 0.85,
    drive: (size) => 0.3 + Math.min(1, size / 4) * 0.4,
    ask: { ...deep.feel.ask, space: () => 'sparse', hatSpace: () => 'sparse' },
    axiomBias: {
      ignition: { key: -2, feel: 'straight', swing: 0.08 },
      circuit: { key: 1, feel: 'straight', swing: 0 },
      feedback: { key: -4, feel: 'swung', swing: 0.2 },
    },
  },

  mix: {
    ...deep.mix,
    tempo: { base: 118, meltdown: 8 },

    /**
     * Four long sections and no chorus, because a hook is the thing this genre
     * declines to have. What changes between them is how much reverb and how
     * open the filter is — you are meant to lose track of where you are.
     */
    form: [
      { id: 'in', bars: 32, backbeat: 'out', hats: 'auto', bass: 'force', stab: 'auto',
        lead: 'out', chord: 'out', parts: 'auto', open: [0.2, 0.42], hook: false },
      { id: 'body', bars: 48, backbeat: 'auto', hats: 'auto', bass: 'force', stab: 'force',
        lead: 'out', chord: 'auto', parts: 'auto', open: [0.38, 0.66], hook: false },
      { id: 'submerge', bars: 32, backbeat: 'out', hats: 'out', bass: 'force', stab: 'auto',
        lead: 'out', chord: 'force', parts: 'out', sub: 'out', open: [0.5, 0.16], hook: false },
      { id: 'surface', bars: 48, backbeat: 'auto', hats: 'auto', bass: 'force', stab: 'force',
        lead: 'out', chord: 'auto', parts: 'auto', open: [0.34, 0.78], hook: false },
    ],

    filter: { floor: 260, span: 3400, q: 2.2, intensityFloor: 0.4, intensitySpan: 0.5, glide: 0.14 },
    hueColour: { thermal: 0.85, voltaic: 1.05, void: 0.6 },
    register: { ...deep.mix.register, bass: 0, sub: -12 },
    gains: { ...deep.mix.gains, kick: 0.82, backbeatBase: 0.3, backbeatPerIntensity: 0.15,
             hat: 0.34, stab: 0.9, bass: 0.95, sub: 0.4, chord: 0.4 },
    entry: { ...deep.mix.entry, bass: 0, stabPhrase: 0.1, stabIntensity: 0.2 },
    duck: { depth: 0.3, recover: 0.8 },
  },

  graph: {
    ...deep.graph,
    // The point of the whole file. Feedback high, damping low, so the repeats
    // pile up and darken instead of stopping.
    delay: { note: 0.75, feedback: 0.68, damp: 900, glide: 0.25 },
    reverb: { send: 0.24, seconds: 3.2, damp: 1800, predelay: 0.025, highpass: 0 },
  },

  /**
   * Two rows and a convert Trigger, so the mood is `suspended` and the Engine
     * is two long organ tones. Nothing here articulates.
   */
  demo: {
    axiomId: 'feedback',
    from: 7,
    rows: [
      { triggerId: 'on_convert', primitive: 'convert', hue: 'void', modifiers: ['echo'] },
      { triggerId: 'clock', primitive: 'zone', hue: 'void', modifiers: ['sustain'] },
    ],
  },
};
