/**
 * PULSE — no drums at all. `?score=pulse`.
 *
 * Every Score before this one is a variation on the same skeleton: kick,
 * backbeat, hats, bass, stab, lead, chord, parts. Change the cells, change the
 * instruments, change the harmony — the *ensemble* never moves, and an ensemble
 * that never moves is most of why five different Scores kept arriving as the same
 * song wearing different clothes.
 *
 * So this one takes the drum kit out entirely. There is no kick, no backbeat and
 * no hats: those cells exist and are sixteen steps of silence, which the
 * validator accepts and the sequencer plays as nothing.
 *
 * **The pulse comes from the sequencer instead** — a bassline running sixteenths
 * that never stops, with the phrase filter crawling across it. That is the whole
 * Berlin School idea and the reason it works without percussion: a running
 * arpeggio *is* a rhythm section, and a resonant filter moving over one is the
 * event you listen for. Tangerine Dream managed forty years on it.
 *
 * Two consequences worth naming, because both needed a seam that did not exist:
 * the downbeat sub had to become switchable (it was unconditional, so a Score
 * with no kick still got a thud on every bar — a kick by another name), and the
 * chord had to be able to arrive as a held pad rather than chopped onto the grid.
 * `gatedChord` exists precisely *because* pads float; with no drums underneath,
 * floating is correct and the chopped version is the wrong one.
 */
import type { Score } from '../score';
import { deep } from './deep';

/** Sixteen steps of nothing. The drum kit, declared absent. */
const SILENT = '................';

export const pulse: Score = {
  ...deep,
  id: 'pulse',
  name: 'Pulse',
  blurb: 'No drums. A sequencer and a filter, 1975-style.',

  cells: {
    ...deep.cells,
    kicks: [{ id: 'none', pattern: SILENT, energy: 1, feel: 'straight', space: 'sparse' }],
    backbeats: [{ id: 'none', pattern: SILENT, energy: 1, feel: 'straight', space: 'sparse' }],
    hats: [{ id: 'none', pattern: SILENT, energy: 1, feel: 'straight', space: 'sparse' }],

    /**
     * The sequencer. This is the whole rhythm section.
     *
     * Sixteenths, unbroken, walking the chord — so the *harmony* supplies the
     * movement and the pattern supplies the pulse. `climb` and `fall` are the
     * same figure in opposite directions, which is what keeps two bars of it from
     * being one bar twice; `leap` throws an octave in, which is the gesture the
     * genre is actually built on.
     */
    basslines: [
      { id: 'walk', steps: '0121012101210121', energy: 2, register: 'low', space: 'busy' },
      { id: 'climb', steps: '0122012201220122', energy: 3, register: 'low', space: 'busy' },
      {
        id: 'fall',
        steps: '0121012101210121' + '2101210121012101',
        energy: 3,
        register: 'low',
        space: 'busy',
      },
      { id: 'leap', steps: '0a1a0a1a0a2a0a1a', energy: 4, register: 'low', space: 'busy' },
      {
        id: 'long-run',
        steps: '0121022101210221' + '0121012102210121',
        energy: 4,
        register: 'low',
        space: 'busy',
      },
      { id: 'octaves', steps: '0a0a1b1b2a2a1b0a', energy: 5, register: 'low', space: 'busy' },
    ],

    /**
     * Over the top: long notes, and not many of them.
     *
     * With a sequencer running underneath, a busy lead is two things competing
     * for the same attention. These hold.
     */
    motifs: [
      { id: 'hold', steps: 'a~~~~~~~~~~~~~~~', energy: 1, register: 'high', space: 'sparse' },
      { id: 'two-note', steps: 'a~~~~~~~b~~~~~~~', energy: 2, register: 'high', space: 'sparse' },
      {
        id: 'arc',
        steps: 'a~~~~~~~b~~~~~~~' + 'c~~~~~~~b~~~~~~~',
        energy: 3,
        register: 'high',
        space: 'mid',
      },
      { id: 'answer', steps: '....b~~~....a~~~', energy: 3, register: 'mid', space: 'mid' },
      {
        id: 'descent',
        steps: 'c~~~~~~~b~~~~~~~' + 'a~~~~~~~........',
        energy: 4,
        register: 'high',
        space: 'mid',
      },
    ],

    // The stab is gone as a rhythmic idea; one press a bar at most.
    stabs: [
      { id: 'none', pattern: SILENT, energy: 1, space: 'sparse' },
      { id: 'mark', pattern: 'x...............', energy: 3, space: 'sparse' },
    ],
  },

  feel: {
    ...deep.feel,
    // Held, not chopped. See the header — with no drums under it, a pad floating
    // free of the grid is the right answer rather than the old mistake.
    chordVoice: 'pad',
    // A 303 on everything: the sequencer *is* the track, so it gets the one voice
    // with a filter envelope per note.
    bassVoice: () => 'acid',
    leadVoice: ({ hasOrbital }) => (hasOrbital ? 'bell' : 'pluck'),
    // Always busy. The ladder that thins the bass as the Engine fills up is
    // exactly right everywhere else and exactly wrong here.
    ask: { ...deep.feel.ask, space: () => 'busy', hatSpace: () => 'sparse' },
    axiomBias: {
      ignition: { key: -1, feel: 'straight', swing: 0 },
      circuit: { key: 3, feel: 'straight', swing: 0 },
      feedback: { key: -4, feel: 'straight', swing: 0 },
    },
  },

  mix: {
    ...deep.mix,
    tempo: { base: 112, meltdown: 10 },

    /**
     * Long sections and enormous filter sweeps, because the sweep is the song.
     *
     * With no drums to mark structure, the only thing telling you where you are
     * is how open the filter is — so the sections are long enough to hear it move
     * and the range between them is wide enough to be a journey rather than a
     * wobble. `sub: 'out'` everywhere: no kick means no thud on the downbeat.
     */
    form: [
      { id: 'open', bars: 16, backbeat: 'out', hats: 'out', bass: 'force', stab: 'out',
        lead: 'out', chord: 'force', parts: 'out', sub: 'out', open: [0.1, 0.3], hook: false },
      { id: 'run', bars: 32, backbeat: 'out', hats: 'out', bass: 'force', stab: 'out',
        lead: 'auto', chord: 'force', parts: 'auto', sub: 'out', open: [0.3, 0.62], hook: false },
      { id: 'rise', bars: 32, backbeat: 'out', hats: 'out', bass: 'force', stab: 'auto',
        lead: 'force', chord: 'force', parts: 'auto', sub: 'out', open: [0.55, 1], hook: true,
        restFrom: 1 },
      { id: 'wide', bars: 32, backbeat: 'out', hats: 'out', bass: 'force', stab: 'out',
        lead: 'auto', chord: 'force', parts: 'auto', sub: 'out', open: [0.85, 0.5], hook: false },
      { id: 'ebb', bars: 16, backbeat: 'out', hats: 'out', bass: 'force', stab: 'out',
        lead: 'out', chord: 'force', parts: 'out', sub: 'out', open: [0.4, 0.12], hook: false },
      { id: 'return', bars: 32, backbeat: 'out', hats: 'out', bass: 'force', stab: 'auto',
        lead: 'force', chord: 'force', parts: 'auto', sub: 'out', open: [0.6, 0.95], hook: true,
        restFrom: 1 },
    ],

    // Wide open at the top and nearly shut at the bottom, with the resonance high
    // enough that the corner is audible as a pitch.
    filter: { floor: 200, span: 5600, q: 3.4, intensityFloor: 0.45, intensitySpan: 0.55, glide: 0.12 },
    hueColour: { thermal: 1, voltaic: 1.2, void: 0.75 },

    register: { ...deep.mix.register, bass: 0, motif: 24, motifAnswer: 36, sub: -12 },
    // The pad is held for four beats and the sequencer is loud. Nothing else is.
    length: { ...deep.mix.length, chord: 4 },
    gains: { ...deep.mix.gains, bass: 1.0, stab: 0.5, motif: 0.8, chord: 0.9, sub: 0 },
    entry: { ...deep.mix.entry, bass: 0, chordIntensity: 0, motifPhrase: 0.3, motifIntensity: 0.4 },
    // Nothing ducks, because nothing kicks.
    duck: { depth: 1, recover: 0.1 },
  },

  graph: {
    ...deep.graph,
    reverb: { send: 0.3, seconds: 3.6, damp: 3400, predelay: 0.03, highpass: 0 },
    delay: { note: 0.75, feedback: 0.6, damp: 2200, glide: 0.2 },
  },

  /**
   * Sparse and slow-firing — on_wave once a bar, on_dash twice — so the
     * sequencer underneath is never crowded.
   */
  demo: {
    axiomId: 'ignition',
    from: 3,
    rows: [
      { triggerId: 'clock', primitive: 'beam', hue: 'voltaic', modifiers: ['sustain'] },
      { triggerId: 'on_wave', primitive: 'buff', hue: 'thermal', modifiers: [] },
      { triggerId: 'on_dash', primitive: 'vortex', hue: 'void', modifiers: [] },
    ],
  },
};
