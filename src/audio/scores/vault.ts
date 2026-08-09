/**
 * VAULT — dark synths, booming bass. `?score=vault`.
 *
 * **Not approved.**
 *
 * ---
 *
 * The brief was blunt and so is this: booming bass, dark, synths. No new
 * synthesis method to prove, no genre to demonstrate. Just the low end doing its
 * job and everything above it staying out of the way.
 *
 * **The bass was never a taste problem.** It was pitched below hearing. The bass
 * plays at `chordRoot + register.bass`, `register.bass` was -12, and every dark
 * Score also dropped its key — so the two stacked. `choir` on its feedback Axiom
 * put the fundamental at `semiHz(-24)`, which is **13.75 Hz**: inaudible on any
 * speaker ever made, while still spending the limiter's entire headroom and
 * ducking everything else through it. Two Scores in a row sounded thin *because
 * of* the bass, not despite it.
 *
 * So the arithmetic is done deliberately here. Keys sit between -3 and +2, and
 * `register.bass` is 0 rather than -12, which puts the fundamental between 46 and
 * 62Hz — the octave where a bass is actually felt, and where the `boom` voice's
 * resonant upper layer gives a laptop something to move. Darkness is not
 * altitude. It comes from the harmony and the filter, both of which are still
 * here.
 *
 * The rest is restraint: the reverb is less than half what `choir` used, because
 * a long tail over a big bass is mud, and everything melodic is a synth with a
 * hard front edge so nothing arrives backwards.
 */
import type { Score } from '../score';
import { deep } from './deep';

export const vault: Score = {
  ...deep,
  id: 'vault',
  name: 'Vault',

  feel: {
    ...deep.feel,

    /**
     * Keys near the middle, not the floor.
     *
     * Dropping the key is the obvious way to sound darker and it is a trap: it
     * moves the *bass* down as well, and the bass is the one voice with nowhere
     * left to go. These three sit close together and the darkness is carried by
     * the harmony and the filter instead.
     */
    axiomBias: {
      ignition: { key: -1, feel: 'straight', swing: 0 },
      circuit: { key: 2, feel: 'rolling', swing: 0 },
      feedback: { key: -3, feel: 'swung', swing: 0.16 },
    },

    // The boom on everything low. There is one bass voice in this Score and it
    // is the loudest thing in it.
    bassVoice: ({ lowest, hue }) => (lowest <= 1 ? 'boom' : hue === 'voltaic' ? 'acid' : 'boom'),

    /**
     * The bass drum is allowed to be the biggest thing in the room.
     *
     * The first version of this Score used `tight` on two hues out of three,
     * reasoning that a small kick leaves the bottom of the spectrum free for the
     * bassline. That is a mixing-desk answer to a musical question, and it
     * produced exactly what it deserved: a thin, clicky drum with nothing under
     * it. `tight` decays in 0.19s and puts its click at 0.85 — it is the
     * *smallest* kick in the game, chosen for the Score that most needed the
     * largest.
     *
     * `slam` has a body, an octave partial so it survives a laptop, and a room.
     * The two do not have to fight over one octave: the kick's fundamental sits
     * at 45Hz and the bass now sits at 46-62, and the sidechain below carves the
     * hole rather than the arrangement avoiding it.
     */
    hueKick: { thermal: 'slam', voltaic: 'punch', void: 'slam' },
    huePerc: { thermal: 'rim', voltaic: 'snare', void: 'rim' },
    hueStab: { thermal: 'dub', voltaic: 'saw', void: 'dub' },

    // Bright enough to hear the filter move, never bright enough to sparkle.
    brightness: (count) =>
      Math.max(
        0.4,
        Math.min(1.4, 0.85 + count('overdrive') * 0.3 + count('amplify') * 0.18 - count('ground') * 0.3),
      ),
  },

  mix: {
    ...deep.mix,

    tempo: { base: 104, meltdown: 12 },

    /**
     * The whole point of the file.
     *
     * `bass: 0` puts the fundamental in the 46-62Hz octave rather than an octave
     * under it. `sub: -12` rather than -24 for the same reason — the downbeat sub
     * was at 13-27Hz and doing nothing but eating headroom.
     */
    register: { ...deep.mix.register, bass: 0, sub: -12, motif: 12, motifAnswer: 24 },

    // The bass is the lead instrument here and is mixed like one. Everything
    // above it comes down to make room, which is what "booming" actually is —
    // a balance, not a volume.
    gains: {
      ...deep.mix.gains,
      bass: 1.05,
      // The downbeat sub is redundant now that the kick has a body of its own —
      // two sines an octave apart on the same beat is not twice the weight, it
      // is a phase problem.
      sub: 0.3,
      // Back down from 1.1. `slam` already carries more transient than `punch`;
      // scaling it up on top was the second half of the overload, and level was
      // never what made it hit anyway.
      kick: 0.92,
      backbeatBase: 0.4,
      backbeatPerIntensity: 0.22,
      hat: 0.5,
      stab: 0.7,
      motif: 0.72,
      chord: 0.6,
    },

    /**
     * A deeper, longer sidechain — the other half of "oomph".
     *
     * The kick ducks the music bus, and the bass is on it. `current` dips to 34%
     * and recovers over three quarters of a beat, which is a gentle sidechain
     * aimed at *clarity*: it stops the kick and the bass fighting for the same
     * octave and is otherwise meant to be inaudible.
     *
     * Here it is meant to be heard. Down to 20% and back over most of a beat, so
     * the bass swells up under every kick instead of merely getting out of the
     * way. That pumping is not a side effect of the technique in this genre, it
     * *is* the technique — and it costs nothing, because it only ever turns
     * things down.
     */
    duck: { depth: 0.2, recover: 0.88 },

    // Dark, and resonant enough that the sweep is audible as a filter rather
    // than as a volume change.
    filter: { ...deep.mix.filter, floor: 320, span: 3000, q: 2.6, intensityFloor: 0.4 },
    hueColour: { thermal: 0.9, voltaic: 1.1, void: 0.62 },

    // The bass never rests. Everything else has to earn its place.
    entry: { ...deep.mix.entry, bass: 0.0, stabPhrase: 0.3, motifPhrase: 0.5, motifIntensity: 0.7 },
  },

  graph: {
    ...deep.graph,

    /**
     * Less than half of `choir`'s send, and a much shorter tail.
     *
     * A five-second reverb behind a big low end is mud, and behind an offbeat
     * stab pattern it is the wash that got reported as "half the song is playing
     * in reverse". Reverb is a *depth* control, and past a certain point it stops
     * adding depth and starts removing the front of every sound.
     */
    reverb: { send: 0.18, seconds: 2.2, damp: 2600, predelay: 0.018 },
    delay: { ...deep.graph.delay, feedback: 0.5, damp: 1500 },

    // The shelf comes down: with the bass finally in the right octave, boosting
    // 110Hz on top of it is how the limiter ends up doing all the work.
    lowShelf: { hz: 80, gain: 3 },
  },
};
