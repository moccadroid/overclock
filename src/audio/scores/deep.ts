/**
 * DEEP — the dark one. `?score=deep`.
 *
 * **Not approved.** `current` is a transcription of a sound that exists; this is
 * a proposal about one that might. Nothing here is frozen and no golden holds it,
 * because a golden on an unapproved look is just a way of making it hard to
 * change. It stays that way until somebody has listened to it.
 *
 * ---
 *
 * **The brief.** Moodier, more dangerous, more mysterious — while staying minimal
 * techno, and *without* becoming the gate. That last part is the whole design
 * constraint. The gate voice is genuinely frightening and it works because it is
 * an event: atonal, six seconds, declamatory. You cannot live inside it. Dread
 * does not scale to an hour.
 *
 * What does scale is **atmosphere**, and atmosphere is made of three things this
 * score did not have:
 *
 *   **Space.** There was no reverb anywhere in the graph. Everything was dry,
 *   and dry means present, close and safe. Distance is most of what "mysterious"
 *   is, and dub techno is a genre largely *made* of it.
 *
 *   **Ambiguity.** Every chord shape in `current` is consonant and the two most
 *   common progressions both land on a major chord. A `driving` build got
 *   i-min7 → ♭VII-maj; a `lifting` build got i-min → ♭VI-maj. Those are hopeful.
 *   You cannot arrange your way out of a major resolution.
 *
 *   **Restraint.** The filter opened to 5.6kHz, the lead answered itself *two to
 *   three octaves* above the chord, and almost nothing ever dropped out.
 *
 * Note what is *not* here: nothing is louder, nothing is more distorted, and no
 * layer was added. Every lever below is space, register, or absence — which is
 * why it stays minimal rather than becoming heavy metal with a 4/4 kick.
 *
 * Inherits from `current` and overrides deliberately, so this file reads as the
 * list of decisions rather than as a second copy of everything.
 */
import type { Score } from '../score';
import { current } from './current';

export const deep: Score = {
  ...current,
  id: 'deep',
  name: 'Deep',
  blurb: 'Dark and wide. Phrygian harmony, long reverb.',

  cells: {
    ...current.cells,
    /**
     * The harmony, replaced wholesale. This is the single biggest change here.
     *
     * Every progression is minor or modal, and the one major chord in the set is
     * major *because* that is what makes it frightening: ♭II over a minor tonic
     * is the Phrygian cadence, and a major triad a semitone above the root is one
     * of the oldest "something is wrong" sounds there is. It is not consoling —
     * it is the opposite, and it needs the major third to bite.
     *
     * No shape here is new. Darkness came from the *progressions*, not from
     * inventing chords, which means every existing melodic cell still fits and
     * nothing had to be reauthored.
     */
    harmonies: [
      // Nowhere to go, held for eight bars. The floor of the whole score.
      { id: 'abyss', chords: [{ root: 0, quality: 'min7' }], barsPerChord: 8, mood: 'dark' },
      { id: 'drone', chords: [{ root: 0, quality: 'min' }], barsPerChord: 8, mood: 'dark' },
      // The Phrygian ♭II. The dangerous one.
      {
        id: 'phrygian',
        chords: [
          { root: 0, quality: 'min' },
          { root: 1, quality: 'maj' },
        ],
        barsPerChord: 4,
        mood: 'dark',
      },
      // i → iv. Sinks and stays sunk.
      {
        id: 'lament',
        chords: [
          { root: 0, quality: 'min' },
          { root: 5, quality: 'min' },
        ],
        barsPerChord: 4,
        mood: 'dark',
      },
      // Driving, but modal and minor — ♭VII where `current` put a major.
      {
        id: 'undertow',
        chords: [
          { root: 0, quality: 'min7' },
          { root: 10, quality: 'min' },
        ],
        barsPerChord: 4,
        mood: 'driving',
      },
      // Suspended: no third at all, so it refuses to say major or minor.
      {
        id: 'circling',
        chords: [
          { root: 0, quality: 'min7' },
          { root: 0, quality: 'sus' },
        ],
        barsPerChord: 8,
        mood: 'suspended',
      },
      {
        id: 'open-fifth',
        chords: [
          { root: 0, quality: 'sus' },
          { root: 10, quality: 'sus' },
        ],
        barsPerChord: 4,
        mood: 'suspended',
      },
      // The least dangerous thing in the score, and still minor: ♭VI *minor*
      // where `current` had ♭VI major. A one-row Engine gets this.
      {
        id: 'cold-lift',
        chords: [
          { root: 0, quality: 'min' },
          { root: 8, quality: 'min' },
        ],
        barsPerChord: 4,
        mood: 'lifting',
      },
    ],
  },

  feel: {
    ...current.feel,

    /**
     * Use the library instead of the top of it.
     *
     * `pick()` was an argmax, so a fixed build got a fixed answer and a
     * twelve-motif library produced three lines over seventeen minutes. A spread
     * of 2 — about one step of energy — puts every cell that genuinely fits on a
     * shortlist and lets the variation counter choose between them. And the kit
     * develops now, because one kick pattern for a whole run is not stability,
     * it is the thing you were hearing as sameness.
     */
    weights: { ...current.feel.weights, spread: 2 },
    kitVaries: true,

    /**
     * Inverted. **More rows means darker.**
     *
     * `current` had it backwards and it took writing this file to see it: a build
     * with three or more rows and no cascade got `lifting`, so the soundtrack grew
     * more consoling as the run escalated toward Meltdown. Here a big Engine is a
     * dangerous one, and the least dark harmony in the score belongs to a player
     * who owns almost nothing.
     */
    chooseMood: ({ meltdown, hasConvert, hasCascade, size }) =>
      meltdown
        ? 'dark'
        : size >= 4
          ? 'dark'
          : hasConvert
            ? 'suspended'
            : hasCascade
              ? 'driving'
              : size >= 2
                ? 'suspended'
                : size === 1
                  ? 'lifting'
                  : 'dark',

    // More weight, sooner. A sub under two registers instead of one.
    bassVoice: ({ lowest, hue }) => (lowest <= 1 ? 'sub' : hue === 'voltaic' ? 'acid' : 'pluck'),

    ask: {
      ...current.feel.ask,
      // Sparser one step earlier across the board. Space is the instrument.
      space: (size) => (size >= 3 ? 'sparse' : size >= 1 ? 'mid' : 'busy'),
      stabSpace: (size) => (size >= 3 ? 'sparse' : 'mid'),
      hatSpace: (i) => (i > 0.75 ? 'busy' : 'mid'),
    },

    /**
     * The delay is always doing something.
     *
     * `current` sent nothing to it unless the build happened to draft Echo or
     * Ricochet, so most runs never heard the dub delay at all — a whole effect
     * sitting in the graph, wired, damped, tuned to a dotted eighth, and silent.
     * A floor of 0.2 means every run gets a tail; Echo still audibly does more.
     */
    echo: (count) => Math.min(0.85, 0.2 + count('echo') * 0.4 + count('ricochet') * 0.2),

    // Darker by default, and it cannot get as bright at the top.
    brightness: (count) =>
      Math.max(
        0.35,
        Math.min(1.5, 0.8 + count('overdrive') * 0.35 + count('amplify') * 0.2 - count('ground') * 0.3),
      ),

    // Hats arrive later and thinner. They are the busiest thing in the mix and
    // the first thing that makes a track sound eager.
    drive: (size) => 0.4 + Math.min(1, size / 4) * 0.6,
  },

  mix: {
    ...current.mix,

    /**
     * The song.
     *
     * 192 bars — about seven and a half minutes at 106 — after which it comes
     * round. It is *meant* to come round: a form you can learn is the whole
     * difference between a song and a generator, and the variety belongs inside
     * the verses rather than in the order of the sections.
     *
     * The shape is the oldest one there is. State it, take it away, give it back
     * bigger:
     *
     *   INTRO   kick, sub, bass and a held chord. Enough to establish the key
     *           and nothing to hold on to yet — no backbeat, no hats, no tune.
     *   VERSE   the engine arrives. Cells vary every 32 bars, so no two verses
     *           are the same.
     *   BUILD   filter climbs, hats double, the lead vanishes. Tension is the
     *           absence of the thing you want.
     *   CHORUS  the hook — the same cells every time it comes back. This is the
     *           only section in the game that repeats on purpose.
     *   BREAK   everything but the kick and the reverb tail. The room, empty.
     *   DROP    the hardest the track gets: hats forced, filter wide, lead out,
     *           stab hammering. Techno's actual payoff.
     *
     * The lead resting at the end of a section is what makes the next downbeat
     * land, so most sections keep it; the chorus does not, because a hook that
     * ducks out for its last eight bars is not a hook.
     */
    form: [
      {
        id: 'intro',
        bars: 16,
        backbeat: 'out',
        hats: 'out',
        bass: 'auto',
        stab: 'out',
        lead: 'out',
        chord: 'force',
        parts: 'out',
        open: [0.16, 0.4],
        hook: false,
      },
      {
        id: 'verse',
        bars: 32,
        backbeat: 'auto',
        hats: 'auto',
        bass: 'auto',
        stab: 'auto',
        lead: 'auto',
        chord: 'auto',
        parts: 'auto',
        open: [0.3, 0.62],
        hook: false,
      },
      {
        id: 'build',
        bars: 16,
        backbeat: 'auto',
        hats: 'force',
        bass: 'auto',
        stab: 'force',
        // The lead is the thing being withheld. Everything else climbs.
        lead: 'out',
        chord: 'auto',
        parts: 'auto',
        open: [0.45, 1],
        hatEvery: 2,
        hook: false,
      },
      {
        id: 'chorus',
        bars: 32,
        backbeat: 'auto',
        hats: 'force',
        bass: 'force',
        stab: 'force',
        lead: 'force',
        chord: 'force',
        parts: 'auto',
        open: [0.72, 0.9],
        hook: true,
        // It plays all the way to the end. This is the part you are meant to
        // remember.
        restFrom: 1,
      },
      {
        id: 'verse-2',
        bars: 32,
        backbeat: 'auto',
        hats: 'auto',
        bass: 'auto',
        stab: 'auto',
        lead: 'auto',
        chord: 'auto',
        parts: 'auto',
        open: [0.34, 0.66],
        hook: false,
      },
      {
        id: 'break',
        bars: 16,
        backbeat: 'out',
        hats: 'out',
        bass: 'out',
        stab: 'out',
        lead: 'out',
        chord: 'force',
        parts: 'out',
        // Closing rather than opening — the one section that goes backwards.
        open: [0.5, 0.14],
        hook: false,
      },
      {
        id: 'drop',
        bars: 16,
        backbeat: 'force',
        hats: 'force',
        bass: 'force',
        stab: 'force',
        // No tune. A drop is rhythm and weight; a melody over it is a distraction.
        lead: 'out',
        chord: 'out',
        parts: 'force',
        open: [1, 0.85],
        hatEvery: 1,
        hook: false,
      },
      {
        id: 'chorus-2',
        bars: 32,
        backbeat: 'auto',
        hats: 'force',
        bass: 'force',
        stab: 'force',
        lead: 'force',
        chord: 'force',
        parts: 'auto',
        open: [0.78, 0.94],
        hook: true,
        restFrom: 1,
      },
    ],

    // Slower. Not much — six BPM — but tempo is felt as weight before it is heard
    // as speed, and 106 sits under the pulse rather than pushing it.
    tempo: { base: 106, meltdown: 12 },

    /**
     * The ceiling comes down and the resonance goes up.
     *
     * `current` opened to about 5.6kHz on a thermal build and 8kHz on a voltaic
     * one, with a Q of 1.1 — which is barely a filter, so the sweep read as "the
     * mix got louder" rather than as a filter moving. Half the ceiling and twice
     * the Q is darker *and* more characterful: the sweep starts to sing, which is
     * the sound the genre actually runs on.
     */
    filter: {
      ...current.mix.filter,
      floor: 300,
      span: 2900,
      q: 2.4,
      intensityFloor: 0.35,
      intensitySpan: 0.55,
    },

    // Colour, flattened and dimmed. Voltaic at 1.45 was the brightest thing in
    // the game and it multiplied straight into the filter span.
    hueColour: { thermal: 0.85, voltaic: 1.1, void: 0.6 },

    /**
     * The lead comes down an octave.
     *
     * It sat at +24, answering itself at +36 — two and three octaves over the
     * chord, on plucks and bells. That is the single brightest thing in the mix
     * and the reason the track reads as a *tune* rather than as a room.
     */
    register: { ...current.mix.register, motif: 12, motifAnswer: 24 },

    // Low end forward, everything above it back. Same total level — the limiter
    // sees to that — so this is balance, not volume.
    gains: {
      ...current.mix.gains,
      hat: 0.6,
      hatBleak: 0.35,
      stab: 0.75,
      motif: 0.7,
      sub: 0.85,
    },

    /**
     * Later entrances, and a longer rest.
     *
     * §13.2 already knew this — "this genre gets frightening when the room
     * empties, not when it fills" — but `current` only ever applied it under
     * Meltdown. Here the lead sits out the last quarter of every phrase instead
     * of the last eighth, and nothing melodic arrives until the phrase is
     * properly under way.
     */
    phrase: { answerFrom: 0.5, restFrom: 0.75 },
    entry: {
      ...current.mix.entry,
      stabPhrase: 0.35,
      stabIntensity: 0.6,
      motifPhrase: 0.55,
      motifIntensity: 0.75,
      chordIntensity: 0.22,
    },
  },

  graph: {
    ...current.graph,
    /**
     * Space, turned on.
     *
     * The largest single change in this file and the one that is hardest to argue
     * with: there was no reverb anywhere, and a mix with no reverb is a mix with
     * no distance. Fed from the stab, the lead and the chord only — the kick and
     * the sub stay dry, because a tail under the low end is mud rather than
     * atmosphere.
     *
     * Long and dark: three and a half seconds with the tail rolled off hard, so
     * late reflections arrive as a wash rather than as an echo you could count.
     */
    reverb: { send: 0.26, seconds: 3.4, damp: 2200, predelay: 0.03, highpass: 0 },

    // A touch more feedback and a darker repeat, since the delay is now always
    // audible rather than being a modifier's reward.
    delay: { ...current.graph.delay, feedback: 0.56, damp: 1300 },
  },

  voices: {
    ...current.voices,

    // Thinner and further back. A hat is the easiest thing in a mix to make
    // eager, and eager is the opposite of what this is for.
    hat: { ...current.voices.hat, hz: 8200, gain: 0.11 },

    stab: {
      ...current.voices.stab,
      filtered: {
        saw: { ...current.voices.stab.filtered.saw, open: 3200, close: 700, q: 5 },
        dub: { ...current.voices.stab.filtered.dub, open: 1100, close: 380 },
      },
    },

    lead: {
      // Every lead loses its top. The hue map is untouched — an Orbital build
      // still gets a bell and a voltaic one still gets a 303 — because that
      // distinction is *identity*, and darkening a voice is not the same as
      // taking it away.
      bell: { ...current.voices.lead.bell, ceiling: 3200, cutoff: 3.5, gain: 0.06 },
      acid: { ...current.voices.lead.acid, peak: 6, peakCeiling: 6000 },
      pluck: { ...current.voices.lead.pluck, open: 4, close: 1.2, q: 5 },
    },

    // Darker, and detuned wider: slow beating between the two voices is unease
    // you cannot name, which is worth more here than another dissonance you can.
    chord: { ...current.voices.chord, open: 2200, close: 600, detune: 9 },
  },

  /**
   * Three void-heavy rows: drones and ticks, no orbital, so no bell. Size 3
     * with a cascade lands it on `driving` and the deep kick.
   */
  demo: {
    axiomId: 'feedback',
    from: 5,
    rows: [
      { triggerId: 'on_hit', primitive: 'beam', hue: 'void', modifiers: ['sustain'] },
      { triggerId: 'on_kill', primitive: 'zone', hue: 'void', modifiers: [] },
      { triggerId: 'clock', primitive: 'mine', hue: 'thermal', modifiers: ['ground'] },
    ],
  },
};
