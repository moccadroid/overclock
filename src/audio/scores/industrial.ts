/**
 * INDUSTRIAL — the broken one. `?score=industrial`.
 *
 * **Not approved.** Same standing as `deep`: a proposal, not a frozen look.
 *
 * ---
 *
 * **Why this exists.** `deep` was reported as "still very much sounds like the
 * old music", and that was correct. It inherited `...current.cells` and replaced
 * only the harmonies, so all 51 other cells — every kick, every hat, every
 * bassline, every motif — were byte-identical. It also inherited every voice
 * design and merely retuned filter corners. Different lighting, identical bones:
 * the same instruments playing the same rhythms.
 *
 * The bones are three things, and this Score replaces all three:
 *
 *   **The pulse.** Every kick in the shared library is a variation on
 *   `x...x...x...x...`. Four-on-the-floor is not *a* feature of techno, it is
 *   the thing that makes one track sound like the last one however it is
 *   filtered. Nothing here lands on all four quarters. The kick is an event that
 *   interrupts the bar rather than the grid the bar is built from.
 *
 *   **The instruments.** New voices, not retuned ones: `crush` (a kick that
 *   falls for a fifth of a second and rings for over one), `anvil` (struck
 *   inharmonic metal instead of filtered noise), `drone` (a bass that is a
 *   surface rather than a line), `hit` (a hydraulic press where the chord stab
 *   used to be). See voices.ts.
 *
 *   **The density.** Almost nothing plays. The hats are a rumour, the backbeat
 *   is one strike in a bar, and the bass is a single held note. What makes this
 *   frightening is how much room there is between the hits.
 *
 * Note what is *still* true: nothing is louder and nothing is distorted. The
 * grit is ring modulation, which multiplies and therefore cannot raise RMS —
 * §18.4 holds, and it holds for the same reason it always did.
 */
import type { Score } from '../score';
import { deep } from './deep';

export const industrial: Score = {
  ...deep,
  id: 'industrial',
  name: 'Industrial',
  blurb: 'Broken. Nothing on the quarters. Struck metal.',

  cells: {
    /**
     * Kicks that are not metronomes.
     *
     * Read the patterns: not one of them puts a hit on all four quarters. `iron`
     * lands on 1, the back half of 2 and the front of 3 — so the bar leans and
     * never settles. `drag` is two hits in sixteen steps. `piston` is three
     * against four and drifts against the bar on purpose.
     *
     * The `crush` voice rings for over a second, so on the sparse cells the
     * previous hit is still decaying underneath the next one. That overlap is
     * the sound: not a beat, a machine cycling.
     */
    kicks: [
      { id: 'drag', pattern: 'X.........X.....', energy: 1, feel: 'broken', space: 'sparse' },
      { id: 'iron', pattern: 'X.....x..X......', energy: 2, feel: 'broken', space: 'sparse' },
      { id: 'stamp', pattern: 'X.......X...x...', energy: 2, feel: 'straight', space: 'sparse' },
      { id: 'lurch', pattern: 'X..x......X.....', energy: 3, feel: 'broken', space: 'mid' },
      { id: 'hammer', pattern: 'X...X.....X.X...', energy: 4, feel: 'broken', space: 'mid' },
      { id: 'piston', pattern: 'X..X..X...X..X..', energy: 4, feel: 'rolling', space: 'mid' },
      { id: 'seizure', pattern: 'X.XX..X...X.XX..', energy: 5, feel: 'broken', space: 'busy' },
      { id: 'grind', pattern: 'X..x..X..x..X.x.', energy: 5, feel: 'rolling', space: 'busy' },
    ],

    /**
     * One strike, mostly. Never on 2 and 4.
     *
     * A backbeat on 2 and 4 is the single most recognisable rhythmic gesture in
     * western popular music, and putting the anvil there would have made this a
     * rock track with a strange snare. Landing it on the back of 2, or on 3
     * alone, means the bar has no symmetry to hold on to.
     */
    backbeats: [
      { id: 'toll', pattern: '........X.......', energy: 1, feel: 'broken', space: 'sparse' },
      { id: 'clang', pattern: '......X.........', energy: 2, feel: 'broken', space: 'sparse' },
      { id: 'answer', pattern: '......X.......o.', energy: 3, feel: 'broken', space: 'mid' },
      { id: 'double', pattern: '......X...X.....', energy: 3, feel: 'broken', space: 'mid' },
      { id: 'chain', pattern: '..o...X...o...o.', energy: 4, feel: 'rolling', space: 'mid' },
      { id: 'flail', pattern: '..o.X.o...X.o.X.', energy: 5, feel: 'broken', space: 'busy' },
    ],

    /**
     * A rumour. The hats are the first thing that makes a track sound eager and
     * this one must not, so at low energy there is barely one a bar.
     */
    hats: [
      { id: 'absent', pattern: '..............x.', energy: 1, feel: 'broken', space: 'sparse' },
      { id: 'breath', pattern: '......o.......x.', energy: 2, feel: 'broken', space: 'sparse' },
      { id: 'creak', pattern: '..o.......o...x.', energy: 3, feel: 'broken', space: 'mid' },
      { id: 'skitter', pattern: '..o.o.....o.oxo.', energy: 4, feel: 'broken', space: 'mid' },
      { id: 'steam', pattern: '.o.o.o.o.o.o.o-.', energy: 5, feel: 'rolling', space: 'busy' },
    ],

    /**
     * Held. Not played.
     *
     * Every bassline in the shared library articulates — `pump`, `roll`,
     * `acid-classic` are all *lines*, and a line is something the ear follows as
     * a part. These are surfaces: one note, held for the bar or for two, moving
     * only when the harmony forces it to.
     */
    basslines: [
      {
        id: 'floor',
        steps: '0~~~~~~~~~~~~~~~',
        energy: 1,
        register: 'low',
        space: 'sparse',
      },
      {
        id: 'floor-two',
        steps: '0~~~~~~~~~~~~~~~' + '2~~~~~~~~~~~~~~~',
        energy: 2,
        register: 'low',
        space: 'sparse',
      },
      {
        id: 'sink',
        steps: '2~~~~~~~1~~~~~~~',
        energy: 2,
        register: 'low',
        space: 'sparse',
      },
      {
        id: 'breathe',
        steps: '0~~~~~~~....0~~~',
        energy: 3,
        register: 'low',
        space: 'mid',
      },
      {
        id: 'shudder',
        steps: '0~~~0~~~2~~~0~~~',
        energy: 4,
        register: 'low',
        space: 'mid',
      },
      {
        id: 'pulse',
        steps: '0..0..0...0..0..',
        energy: 5,
        register: 'low',
        space: 'busy',
      },
    ],

    /**
     * Signals, not tunes.
     *
     * The shared motifs are shapes — arches, pickups, call-and-answer — because
     * they were written to be *hummable*. These are the opposite: one or two
     * notes, low, long, arriving late in the bar with nothing before or after
     * them. A thing you notice rather than a thing you follow.
     *
     * Mid register throughout. The high octave is what made the old score read
     * as a tune.
     */
    motifs: [
      { id: 'signal', steps: '............0~~~', energy: 1, register: 'mid', space: 'sparse' },
      { id: 'toll-low', steps: '........1~~~~~~~', energy: 1, register: 'mid', space: 'sparse' },
      { id: 'two-tone', steps: '....2~~~....1~~~', energy: 2, register: 'mid', space: 'sparse' },
      { id: 'descend', steps: '2~~~~~~1~~~~0~~~', energy: 3, register: 'mid', space: 'mid' },
      { id: 'siren', steps: '1~~~~~~~2~~~~~~~' + '1~~~~~~~0~~~~~~~', energy: 3, register: 'mid', space: 'mid' },
      { id: 'stutter-call', steps: '....1.1.....2...', energy: 4, register: 'mid', space: 'mid' },
      // The one that reaches. Kept for choruses, where something has to.
      { id: 'reach', steps: '....a~~~....b~~~', energy: 4, register: 'high', space: 'mid' },
      { id: 'reach-fall', steps: 'b~~~~~~a~~~~c~~~' + 'b~~~~~~a~~~~~~~~', energy: 5, register: 'high', space: 'busy' },
    ],

    /** Presses. One or two a bar, off the grid. */
    stabs: [
      { id: 'press', pattern: '......X.........', energy: 1, space: 'sparse' },
      { id: 'press-late', pattern: '...........X....', energy: 2, space: 'sparse' },
      { id: 'two-press', pattern: '..X.......X.....', energy: 3, space: 'mid' },
      { id: 'stutter-press', pattern: 'X.X.......X.....', energy: 4, space: 'mid' },
      { id: 'cycle', pattern: '..X...X...X...X.', energy: 5, space: 'busy' },
    ],

    // The harmony is already right — `deep` replaced it with modal and Phrygian
    // progressions and there is nothing about them that is too bright for this.
    harmonies: deep.cells.harmonies,
  },

  feel: {
    ...deep.feel,

    /**
     * `broken` by default, on every Axiom.
     *
     * This matters more than it looks. `pick()` pays a cell for matching the
     * wanted feel, and the bias is where that want comes from — so a Score whose
     * default is `straight` will quietly prefer the straight cells in its own
     * library however broken the library is. The keys move too: low, and a
     * tritone apart between Axioms, so the three do not sound like transpositions
     * of one another.
     */
    axiomBias: {
      ignition: { key: -5, feel: 'broken', swing: 0.1 },
      circuit: { key: -11, feel: 'broken', swing: 0 },
      feedback: { key: -8, feel: 'broken', swing: 0.24 },
    },

    // The new instruments, wired to the hues. The hue discipline survives — three
    // distinguishable kits — but every one of them is now metal.
    hueKick: { thermal: 'crush', voltaic: 'tight', void: 'crush' },
    huePerc: { thermal: 'anvil', voltaic: 'anvil', void: 'rim' },
    hueStab: { thermal: 'hit', voltaic: 'hit', void: 'dub' },
    emptyPercVoice: 'rim',

    // Everything low sits on the drone. Only a high-register build gets a 303,
    // and even then it is fighting the floor rather than riding it.
    bassVoice: ({ lowest, hue }) =>
      lowest <= 1 ? 'drone' : hue === 'voltaic' ? 'acid' : 'drone',

    ask: {
      ...deep.feel.ask,
      // Sparse almost immediately. The room between the hits is the instrument.
      space: (size) => (size >= 2 ? 'sparse' : 'mid'),
      stabSpace: (size) => (size >= 2 ? 'sparse' : 'mid'),
      hatSpace: () => 'sparse',
      // Nothing above 3 unless the Engine is genuinely enormous, so the busy
      // cells stay rare enough to mean something.
      hatEnergy: (i, lift) => Math.max(1, Math.round(i * 3) + lift),
      motifEnergy: (i, lift) => Math.max(1, Math.round(1 + i * 2) + lift),
    },

    // Long tails on everything. The delay is the only thing filling the gaps.
    echo: (count) => Math.min(0.9, 0.34 + count('echo') * 0.4 + count('ricochet') * 0.2),
    drive: (size) => 0.25 + Math.min(1, size / 4) * 0.45,
  },

  mix: {
    ...deep.mix,

    // Slow and heavy. At 96 the kick reads as an impact rather than a pulse, and
    // the anvil has room to ring out before the next one.
    tempo: { base: 96, meltdown: 10 },

    // Same song, shorter opening. A bar is 2.5 seconds at this tempo, so `deep`'s
    // 16-bar intro would be forty seconds of almost nothing before a run starts —
    // fine on a record, much too long when somebody has just pressed START.
    form: deep.mix.form.map((s) => (s.id === 'intro' ? { ...s, bars: 8 } : s)),

    // Darker still, and the resonance high enough that the filter is an
    // instrument rather than a curtain.
    filter: { ...deep.mix.filter, floor: 240, span: 2100, q: 3.2, intensityFloor: 0.3 },
    hueColour: { thermal: 0.8, voltaic: 1.0, void: 0.55 },

    // The kick and the anvil are the loudest things here by a distance.
    gains: {
      ...deep.mix.gains,
      kick: 1.05,
      backbeatBase: 0.62,
      backbeatPerIntensity: 0.24,
      hat: 0.4,
      stab: 0.8,
      motif: 0.6,
      sub: 0.9,
      chord: 0.55,
    },

    // Almost nothing arrives early. Everything has to be earned.
    entry: {
      ...deep.mix.entry,
      hatDrive: 0.3,
      stabPhrase: 0.3,
      stabIntensity: 0.7,
      motifPhrase: 0.62,
      motifIntensity: 0.85,
      chordIntensity: 0.3,
    },

    // A cavern, and a delay long enough to blur the gaps between hits.
    // (graph below carries the reverb; this is the score's own send behaviour.)
  },

  graph: {
    ...deep.graph,
    reverb: { send: 0.34, seconds: 4.6, damp: 1500, predelay: 0.045, highpass: 0 },
    delay: { ...deep.graph.delay, feedback: 0.62, damp: 900 },
    // A touch more shelf: this Score lives almost entirely in the bottom two
    // octaves and the limiter is what stops that becoming loud rather than big.
    lowShelf: { hz: 95, gain: 6 },
  },

  /**
   * Rare Triggers — on_wound twice a bar, on_overheat twice — so the Engine
     * punctuates rather than plays. All low, all void and thermal.
   */
  demo: {
    axiomId: 'circuit',
    from: 4,
    rows: [
      { triggerId: 'on_wound', primitive: 'burst', hue: 'void', modifiers: ['ground'] },
      { triggerId: 'on_overheat', primitive: 'knockback', hue: 'thermal', modifiers: [] },
      { triggerId: 'clock', primitive: 'delayed', hue: 'void', modifiers: ['sustain'] },
    ],
  },
};
