/**
 * CHOIR — the one built out of different physics. `?score=choir`.
 *
 * **Not approved.** Same standing as the others.
 *
 * ---
 *
 * **Why this exists.** Two attempts at "different" both came back as "the same
 * song with different instruments", and the reason was not the cells or the beat.
 * It was that **every voice in this game is the same synthesis method**:
 * oscillators into a lowpass into an envelope. Fifty-odd instruments, one
 * synthesiser. Change the oscillator, change the corner, change the pattern —
 * you are still listening to a filter sweep, and the ear knows.
 *
 * So this Score is built on the two methods the game did not have:
 *
 *   **A plucked string** (`bass: 'string'`) — Karplus-Strong. Noise fired into a
 *   delay line that feeds back through a damper. The delay length *is* the
 *   pitch, and the damper kills the high partials first, so it decays unevenly
 *   the way a physical object does. No envelope can imitate that, because the
 *   unevenness is not in the amplitude, it is in the spectrum.
 *
 *   **A throat** (`stab: 'choir'`, `lead: 'voice'`) — formant resonance. Three
 *   narrow bandpasses at *fixed absolute* frequencies. A lowpass says how bright;
 *   a formant bank says *what*, because that is physically what a mouth is. The
 *   resonances deliberately do not track the pitch — sing higher and your mouth
 *   stays the same shape — which is exactly what stops it collapsing back into a
 *   filter sweep.
 *
 * What it keeps from `deep`, on purpose: the harmony, the reverb, the song form,
 * and the melody actually being present. Those were the parts that landed. What
 * `industrial` got wrong was throwing them away *as well as* changing the sound.
 *
 * The melody is sung, the chords are sung, the bass is struck, and the drums are
 * the quietest thing in the mix.
 */
import type { Score } from '../score';
import { deep } from './deep';

export const choir: Score = {
  ...deep,
  id: 'choir',
  name: 'Choir',
  blurb: 'Sung. Plucked strings and formant voices.',

  feel: {
    ...deep.feel,

    /**
     * The new instruments, wired to the hues.
     *
     * The kick is the *soft* one on every hue. This Score's weight comes from the
     * string and the low voices; a hard kick over a choir is a different, worse
     * record, and the drum's job here is to mark time quietly rather than to lead.
     */
    hueKick: { thermal: 'deep', voltaic: 'punch', void: 'deep' },
    huePerc: { thermal: 'rim', voltaic: 'anvil', void: 'rim' },
    hueStab: { thermal: 'choir', voltaic: 'choir', void: 'choir' },
    emptyPercVoice: 'rim',

    // Struck, not played. Only a genuinely high-register build gets the 303, and
    // it is the exception that makes the rest read as deliberate.
    bassVoice: ({ lowest, hue }) =>
      lowest <= 1 ? 'string' : hue === 'voltaic' ? 'acid' : 'string',

    // Every lead is a throat. Orbital keeps its bell, because a bell against
    // voices is a genuinely different colour rather than a brighter one.
    leadVoice: ({ hasOrbital }) => (hasOrbital ? 'bell' : 'voice'),

    // Lower and wider apart, so the string sits where a string sits.
    axiomBias: {
      ignition: { key: -7, feel: 'straight', swing: 0.06 },
      circuit: { key: -2, feel: 'rolling', swing: 0 },
      feedback: { key: -12, feel: 'swung', swing: 0.2 },
    },
  },

  mix: {
    ...deep.mix,

    // Slow enough for a voice to hold a note and for the string to ring out.
    tempo: { base: 100, meltdown: 10 },

    /**
     * The lead comes back up.
     *
     * `deep` dropped it an octave because it was the brightest thing in the mix
     * and read as a tune. A throat is not bright — the formants cap it around
     * 3kHz whatever the pitch — so it can sit up where a melody belongs without
     * taking the room over.
     */
    register: { ...deep.mix.register, motif: 24, motifAnswer: 36 },

    // Voices are quiet things. The drums come down to meet them rather than the
    // other way around, which is the whole balance of this Score.
    gains: {
      ...deep.mix.gains,
      kick: 0.8,
      backbeatBase: 0.34,
      backbeatPerIntensity: 0.2,
      hat: 0.4,
      stab: 0.95,
      motif: 1,
      sub: 0.7,
      chord: 0.5,
    },

    // The filter stays fairly open: a formant bank is *already* a filter, and
    // closing a second one over it smears the vowels into mush.
    filter: { ...deep.mix.filter, floor: 380, span: 4200, q: 1.4, intensityFloor: 0.5 },
    hueColour: { thermal: 0.95, voltaic: 1.15, void: 0.7 },

    // The melody is the point, so it arrives sooner and rests less than `deep`'s.
    entry: { ...deep.mix.entry, motifPhrase: 0.4, motifIntensity: 0.55 },
    phrase: { answerFrom: 0.5, restFrom: 0.85 },
  },

  graph: {
    ...deep.graph,
    // A church, near enough. Long, and bright enough to keep the vowels legible —
    // damping a choir into the dark is how it stops sounding like people.
    reverb: { send: 0.4, seconds: 5.2, damp: 4200, predelay: 0.04, highpass: 0 },
    delay: { ...deep.graph.delay, feedback: 0.48, damp: 2400 },
  },

  /**
   * Two rows: a bell twice a bar and one long organ. A choir needs room and
     * four sequencers is not room.
   */
  demo: {
    axiomId: 'feedback',
    from: 9,
    rows: [
      { triggerId: 'on_crit', primitive: 'orbital', hue: 'thermal', modifiers: ['enlarge'] },
      { triggerId: 'clock', primitive: 'convert', hue: 'void', modifiers: ['sustain'] },
    ],
  },
};
