/**
 * FOUR SONGS. `?score=lattice | furnace | basin | marrow`
 *
 * Two rules, and the second one was learned the hard way.
 *
 * **One cell per slot, `spread: 0`.** Everything before these handed the arranger
 * a vocabulary, and an arranger with choices converges — nine Scores came back as
 * one because the selector's house style is stronger than any parameter you feed
 * it. These give it nothing to choose. What you hear is what is written here.
 *
 * **Every one of them keeps a beat.** The first version made them differ by
 * *taking the drums away* — one with no kit at all, one with almost none. This
 * is a bullet-heaven and the floor under it has to hold, so all four have a kick
 * on every quarter and a backbeat, neither of which is ever gated. Everything
 * above those two builds with the fight — see `build`.
 *
 * **And every one of them is the same speed.** Tempo is not on the table: the
 * beat is what the player is moving to, so a song that arrives at a different
 * BPM changes the game rather than the music. All four run at 112, which is what
 * the game runs at. Everything else is fair game and everything else is where
 * they differ.
 *
 *   FURNACE  acid. A 303 line and a saw stab, bright and relentless.
 *   LATTICE  bells. The floor is square; everything over it is three-against-four.
 *   BASIN    dub. Offbeat organ chords in a long delay, and a click for a melody.
 *   MARROW   weight. Slam kick, anvil, a drone bass and a ♭II that never resolves.
 */
import type { PartTuning, PartVoice } from '../parts';
import type { Score } from '../score';
import type { Hue } from '../../sim/types';
import { current } from './current';
import { deep } from './deep';

const one = <T>(x: T): T[] => [x];

/**
 * One tempo, for every song.
 *
 * 112 is the tempo the game runs at and it is not a per-song choice: the beat is
 * what the player is moving to, and a track that arrives at a different speed
 * changes the game rather than the music. Songs differ in everything above it —
 * the kit, the bass, the melody, the harmony, the room — and not in this.
 */
const TEMPO = { base: 112, meltdown: 8 } as const;

/** No wandering: the whole point is that these play what is written. */
const pinned = (base: Score): Score['feel'] => ({
  ...base.feel,
  weights: { ...base.feel.weights, spread: 0 },
  kitVaries: false,
});

/**
 * One section, no hook — and every layer on `auto`, which is the point.
 *
 * These were all `'force'`, which meant the whole song played from bar one
 * regardless of what was happening in front of it. `'force'` does not merely
 * ignore the thresholds in `build` below, it makes them unreachable: `gate()`
 * returns true for a forced layer without ever consulting the entry rule.
 *
 * I did that so a song would be fully audible the moment you clicked it in the
 * MUSIC window, and it was the wrong trade twice over — it deleted the thing that
 * makes this soundtrack the player's rather than the composer's, and it was not
 * even necessary, because the audition wanders `intensity` from 0.08 to 1.0 on a
 * four-minute cycle and so demonstrates the build-up on its own.
 *
 * The backbeat stays forced. Everything else earns its place.
 */
const straight = (id: string, open: readonly [number, number]) =>
  one({
    id,
    bars: 8,
    backbeat: 'force' as const,
    hats: 'auto' as const,
    bass: 'auto' as const,
    stab: 'auto' as const,
    lead: 'auto' as const,
    chord: 'auto' as const,
    parts: 'auto' as const,
    open,
    hook: false,
  });

/**
 * Drums, bass, and one harmonic layer — not five.
 *
 * Marrow kept arriving as a pile of competing lines, and the reason was never the
 * tune: it has *five* pitched layers, and each is derived independently. The
 * motif, the stab, the chord, the Engine's parts and the accents all played at
 * once, all disagreeing. No amount of writing a better melody fixes four other
 * voices arguing with it underneath — a good melody in a crowd is still a crowd.
 *
 * So four of the five are gated out at the source rather than turned down, and
 * the one that stays is the *chord*. That is the right survivor: it is the only
 * layer whose whole job is to agree with itself. A pad plays the chord tones
 * together, so it cannot produce counterpoint — it can only harmonise.
 *
 * The cost is worth stating: with `parts: 'out'` this Score does not react to the
 * player's build, because the parts layer *is* that reaction. Marrow trades
 * responsiveness for coherence. The other three still respond.
 */
const kitBassStrings = (id: string, open: readonly [number, number]) =>
  one({
    id,
    bars: 8,
    backbeat: 'force' as const,
    hats: 'auto' as const,
    bass: 'auto' as const,
    // The strings, and the Engine — both on `auto`, so they arrive with the
    // fight rather than sitting there from bar one.
    chord: 'auto' as const,
    parts: 'auto' as const,
    // These two are the pile-up, and they stay out at any intensity. Marrow is
    // the one Score in the playlist that never gets a melody.
    stab: 'out' as const,
    lead: 'out' as const,
    open,
    hook: false,
  });

/**
 * The song assembles as you play. This is the whole point of the soundtrack.
 *
 * `intensity` is not a mood setting, it is measured: `log10(1 + eps) / 2.4`,
 * capped at 1, where `eps` is Engine events per second — your shots, your hits,
 * your kills. So these thresholds are a running order, and the fight decides how
 * far down it you get:
 *
 *   eps    1     3     5    10    20    50   100
 *   i      .13   .25   .32  .43   .55   .71  .84
 *
 * The kick is never gated, so the floor is a kick and a bassline. From there the
 * hats arrive almost at once, then the Engine's own layer — which *is* your build,
 * one part per Program — then the stab, then the harmony, and the melody last, at
 * the level a real fight reaches. Nothing is free.
 *
 * `stabPhrase` and `motifPhrase` are deliberately out of reach. Those two layers
 * have a second way in — position within the eight-bar section — and `phrase` is
 * 0..1, so a threshold of 2 can never be met. The stab and the melody are opened
 * by what you do and by nothing else. The hats keep their time-based route,
 * because a bar of hats in a quiet stretch reads as the track breathing.
 */
const build = {
  // Almost immediately: this is the floor, not a reward.
  bass: 0.04,
  // `drive` is intensity times the arrangement's own drive, so this is lower than
  // it looks.
  hatDrive: 0.1,
  // Your build, made audible.
  parts: 0.15,
  stabIntensity: 0.26,
  chordIntensity: 0.4,
  // The payoff. Around 20 events a second.
  motifIntensity: 0.55,
  // Unreachable on purpose. See above.
  stabPhrase: 2,
  motifPhrase: 2,
};

/**
 * The doodling — and why all four songs used to do the same doodling.
 *
 * Everything above is the *written* part of a song: the kick, the bassline, the
 * melody, the chords. During play they are not the loudest thing you hear. The
 * Engine is. Every Program in the build gets a part, and those parts fire on the
 * order of 500 notes across 64 bars against the motif's 63 — an order of
 * magnitude more music than the melody, running the whole time.
 *
 * That layer was four module constants in `parts.ts`: which sixteenths each
 * Trigger fires on, which instrument each Action gets, and the figure each
 * instrument walks. Shared by every Score. So four songs could disagree about
 * every note that was written down and still play the *same continuous line* on
 * top of it — same rhythm, same register, same little four-note shape coming
 * round every bar. That is the "doodling", and it is why swapping the voices
 * underneath it changed the colour of these songs without changing the song.
 *
 * The same went for `accentVoice`: the blips a shot or a kill fires were three
 * hardcoded sounds, the same three in every Score.
 *
 * So each song below carries its own tables. The differences are structural
 * rather than timbral — how often a part fires, where in the bar, how far it
 * moves — because structure is what survives being played over a drum kit.
 */
const partsOf = (
  rhythm: Record<string, readonly number[]>,
  voice: Record<string, { voice: PartVoice; register: number }>,
  contour: Record<string, readonly (readonly number[])[]>,
  hueRegister: Record<Hue, number>,
  maxSteps: number,
): PartTuning => ({ rhythm, voice, contour, hueRegister, maxSteps });

/** FURNACE: nothing rests. Sixteenths, offbeats, everything high and acid. */
const FURNACE_PARTS = partsOf(
  {
    clock: [0, 2, 4, 6, 8, 10, 12, 14],
    on_hit: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    on_kill: [1, 3, 5, 7, 9, 11, 13, 15],
    on_crit: [6, 14],
    on_pickup: [0, 3, 6, 9, 12, 15],
    on_dash: [2, 6, 10, 14],
    on_wound: [4, 12],
    on_wave: [0, 8],
    on_overheat: [0, 4, 8, 12],
    on_convert: [1, 5, 9, 13],
  },
  {
    projectile: { voice: 'acid', register: 12 },
    burst: { voice: 'acid', register: 0 },
    chain: { voice: 'acid', register: 12 },
    beam: { voice: 'acid', register: 0 },
    zone: { voice: 'pluck', register: 12 },
    orbital: { voice: 'pluck', register: 24 },
    mine: { voice: 'tick', register: 12 },
    delayed: { voice: 'tick', register: 24 },
    vortex: { voice: 'acid', register: 12 },
    knockback: { voice: 'noise', register: 12 },
    buff: { voice: 'acid', register: 24 },
    convert: { voice: 'pluck', register: 12 },
  },
  {
    // Long runs. An acid line is a line, not a note that keeps coming back.
    acid: [
      [0, 1, 2, 3, 4, 3, 2, 1],
      [0, 2, 4, 2, 0, -1, 0, 2],
    ],
    pluck: [[0, 3, 1, 4, 2, 5, 3, 6]],
    tick: [[0, 0, 2, 0, 4, 0, 2, 0]],
    noise: [[0]],
    stab: [[0, 2, 4, 2]],
    drone: [[0, 1]],
    bell: [[0, 4, 2, 6]],
    sweep: [[0, 3]],
    riser: [[0, 2, 4, 6]],
    organ: [[0, 2]],
  },
  { thermal: 12, voltaic: 12, void: 0 },
  10,
);

/** LATTICE: threes over a four. Sparse, high, and it never lands with the kick. */
const LATTICE_PARTS = partsOf(
  {
    clock: [0, 3, 6, 9, 12],
    on_hit: [0, 3, 6, 9, 12, 15],
    on_kill: [2, 5, 8, 11, 14],
    on_crit: [7],
    on_pickup: [1, 4, 7, 10, 13],
    on_dash: [6],
    on_wound: [11],
    on_wave: [0],
    on_overheat: [0, 5, 10],
    on_convert: [3, 9, 15],
  },
  {
    projectile: { voice: 'bell', register: 24 },
    burst: { voice: 'organ', register: 12 },
    chain: { voice: 'tick', register: 24 },
    beam: { voice: 'organ', register: 12 },
    zone: { voice: 'organ', register: 0 },
    orbital: { voice: 'bell', register: 24 },
    mine: { voice: 'tick', register: 12 },
    delayed: { voice: 'riser', register: 12 },
    vortex: { voice: 'sweep', register: 12 },
    knockback: { voice: 'tick', register: 24 },
    buff: { voice: 'riser', register: 24 },
    convert: { voice: 'organ', register: 12 },
  },
  {
    // Wide leaps. Bells ring long enough that a stepwise line turns to mush.
    bell: [
      [0, 4, 2, 6],
      [0, 5, 3, 7],
    ],
    pluck: [[0, 6, 3, 5]],
    organ: [[0, 4]],
    tick: [[0, 7]],
    acid: [[0, 2]],
    stab: [[0, 4]],
    drone: [[0]],
    sweep: [[0, 3]],
    riser: [[0, 4, 2, 6]],
    noise: [[0]],
  },
  { thermal: 12, voltaic: 12, void: 12 },
  6,
);

/**
 * BASIN: one chord, locked to the stab. Not three melodies.
 *
 * This is the fix for "the higher notes all go in different directions". Every
 * part row gets its own chord degree (`tone: index % 3`), and it *used* to also
 * get its own rhythm from its Trigger, its own figure from its voice's contour,
 * and its own octave from the hue — so three rows produced three independent
 * lines, moving at different rates, in different registers, over a fourth line
 * (the melody) and a fifth (the chord). Five voices going five ways is not
 * counterpoint, it is a crowd.
 *
 * Three constraints fix it, and they are all the same idea — *stop the rows
 * disagreeing*:
 *
 *   - Every Trigger fires on a subset of the same four sixteenths, 2/6/10/14,
 *     which is where the organ stab already is. Rows differ in how *often* they
 *     play, never in where.
 *   - Every contour is `[[0]]`. Nothing walks. A row holds the one degree it was
 *     given, so three rows spell a triad instead of three tunes.
 *   - One register, one octave, no hue offset. Nothing sits above the melody.
 *
 * What is left is a soft chord pad that breathes with the engine and locks to the
 * offbeat — and the only thing in the song that moves is the melody, which is the
 * point of having one.
 *
 * Everything sharp is also gone: `tick` is a Q-9 bandpass on a square at three
 * times the pitch, which is a spike, and `noise` is a burst. Neither belongs in a
 * soft groove, so this table is organ, drone and bell only.
 */
const BASIN_PARTS = partsOf(
  {
    clock: [2, 6, 10, 14],
    on_hit: [2, 6, 10, 14],
    on_kill: [6, 14],
    on_crit: [10],
    on_pickup: [2, 10],
    on_dash: [14],
    on_wound: [6],
    on_wave: [2],
    on_overheat: [2, 10],
    on_convert: [6, 14],
  },
  {
    projectile: { voice: 'organ', register: 0 },
    burst: { voice: 'organ', register: 0 },
    chain: { voice: 'organ', register: 0 },
    beam: { voice: 'drone', register: 0 },
    zone: { voice: 'organ', register: 0 },
    orbital: { voice: 'bell', register: 0 },
    mine: { voice: 'organ', register: 0 },
    delayed: { voice: 'organ', register: 0 },
    vortex: { voice: 'organ', register: 0 },
    knockback: { voice: 'drone', register: 0 },
    buff: { voice: 'bell', register: 0 },
    convert: { voice: 'organ', register: 0 },
  },
  {
    // Nothing moves. See above.
    organ: [[0]],
    drone: [[0]],
    bell: [[0]],
    tick: [[0]],
    stab: [[0]],
    sweep: [[0]],
    riser: [[0]],
    pluck: [[0]],
    acid: [[0]],
    noise: [[0]],
  },
  { thermal: 0, voltaic: 0, void: 0 },
  4,
);

/** MARROW: low and off the grid. Weight arriving where the beat isn't. */
const MARROW_PARTS = partsOf(
  {
    clock: [0, 8],
    on_hit: [0, 4, 8, 12],
    on_kill: [4, 12],
    on_crit: [8],
    on_pickup: [8],
    on_dash: [12],
    on_wound: [4],
    on_wave: [0],
    on_overheat: [0, 8],
    on_convert: [4, 12],
  },
  {
    // Every primitive, one voice: `noise`.
    //
    // Marrow has to do two things that pull against each other — react to the
    // build, and never add another note. `noise` is the only way to have both:
    // the Engine's layer becomes *percussion*, so a bigger build is heard as more
    // of the kit rather than as more voices arguing over the strings.
    //
    // The cost is that you cannot tell a Beam from a Vortex here, which you can in
    // the other three. That is the trade this Score keeps making.
    projectile: { voice: 'noise', register: 0 },
    burst: { voice: 'noise', register: -12 },
    chain: { voice: 'noise', register: 0 },
    beam: { voice: 'noise', register: -12 },
    zone: { voice: 'noise', register: 0 },
    orbital: { voice: 'noise', register: 0 },
    mine: { voice: 'noise', register: 0 },
    delayed: { voice: 'noise', register: 0 },
    vortex: { voice: 'noise', register: -12 },
    knockback: { voice: 'noise', register: 0 },
    buff: { voice: 'noise', register: 0 },
    convert: { voice: 'noise', register: 0 },
  },
  {
    // Down, or nowhere. Nothing in this song rises.
    drone: [[0]],
    tick: [[0, 0, 0, -1]],
    noise: [[0]],
    sweep: [[0]],
    organ: [[0, 0, 0, 2]],
    bell: [[0]],
    pluck: [[0]],
    acid: [[0]],
    stab: [[0]],
    riser: [[0]],
  },
  { thermal: 0, voltaic: 0, void: 0 },
  5,
);

// ---------------------------------------------------------------- FURNACE

/** Acid. The 303 is the song and everything else is scaffolding for it. */
export const furnace: Score = {
  ...current,
  id: 'furnace',
  listed: true,
  name: 'Furnace',
  blurb: 'Acid. A 303 line and a saw stab, wall of hats.',
  cells: {
    ...current.cells,
    kicks: one({ id: 'drive', pattern: 'X...X...X...X...', energy: 4, feel: 'rolling', space: 'mid' }),
    backbeats: one({ id: 'hard', pattern: '....X..o....X..o', energy: 4, feel: 'rolling', space: 'mid' }),
    hats: one({ id: 'wall', pattern: 'oxoxoxoxoxoxox-x', energy: 5, feel: 'rolling', space: 'busy' }),
    basslines: one({
      id: 'engine',
      steps: '0.0.2.0.1.0.2.1.',
      accent: 'x...x...x...x...',
      slide: '..~.....~...~...',
      energy: 5,
      register: 'low',
      space: 'busy',
    }),
    motifs: one({
      id: 'siren',
      scale: true,
      steps: '4.4.6.4.a.6.4.2.',
      energy: 5,
      register: 'high',
      space: 'busy',
    }),
    stabs: one({ id: 'offbeat', pattern: '..x...x...x...x.', energy: 4, space: 'mid' }),
    harmonies: one({
      id: 'drive',
      chords: [
        { root: 0, quality: 'min' },
        { root: 10, quality: 'maj' },
      ],
      barsPerChord: 2,
      mood: 'driving',
    }),
  },
  feel: {
    ...pinned(current),
    parts: FURNACE_PARTS,
    accentVoice: { thermal: 'acid', voltaic: 'stab', void: 'tick' },
    hueKick: { thermal: 'punch', voltaic: 'punch', void: 'punch' },
    huePerc: { thermal: 'clap', voltaic: 'clap', void: 'clap' },
    hueStab: { thermal: 'saw', voltaic: 'saw', void: 'saw' },
    bassVoice: () => 'acid',
    leadVoice: () => 'acid',
    echo: () => 0.25,
    axiomBias: {
      ignition: { key: 2, feel: 'rolling', swing: 0 },
      circuit: { key: 2, feel: 'rolling', swing: 0 },
      feedback: { key: 2, feel: 'rolling', swing: 0 },
    },
  },
  mix: {
    ...current.mix,
    tempo: TEMPO,
    form: straight('go', [0.75, 1]),
    register: { ...current.mix.register, bass: -12, motif: 24, motifAnswer: 24 },
    gains: { ...current.mix.gains, kick: 0.8, hat: 0.8, stab: 0.95, motif: 1.1, bass: 0.7, sub: 0.3, part: 0.72 },
    entry: build,
    filter: { floor: 800, span: 6200, q: 1.5, intensityFloor: 0.8, intensitySpan: 0.2, glide: 0.06 },
    duck: { depth: 0.3, recover: 0.7 },
  },
  graph: {
    ...current.graph,
    reverb: { send: 0.1, seconds: 1.4, damp: 5000, predelay: 0.01, highpass: 0 },
    delay: { note: 0.75, feedback: 0.35, damp: 3000, glide: 0.2 },
  },
  demo: {
    axiomId: 'circuit',
    from: 0,
    rows: [
      { triggerId: 'on_hit', primitive: 'chain', hue: 'voltaic', modifiers: ['accelerate'] },
      { triggerId: 'clock', primitive: 'projectile', hue: 'voltaic', modifiers: ['split'] },
    ],
  },
};

// ---------------------------------------------------------------- LATTICE

/**
 * Bells, and a cross-rhythm that never touches the floor.
 *
 * The kick stays on all four quarters — the game needs that and it is not
 * negotiable. Everything *above* it runs in threes: the hats hit every third
 * sixteenth, the stab every sixth, the bell melody every sixth. Those do not
 * divide sixteen, so the top of the track walks around the bar and only comes
 * home every second one while the floor never moves.
 *
 * That is the oldest way to make a square beat feel strange without weakening
 * it, and it is the opposite of the first attempt at this song, which got the
 * strangeness by deleting the drums.
 */
export const lattice: Score = {
  ...deep,
  id: 'lattice',
  listed: true,
  name: 'Lattice',
  blurb: 'Bells in three over a square floor. The top never lands.',
  cells: {
    ...deep.cells,
    kicks: one({ id: 'floor', pattern: 'X..X..X...X..X..', energy: 3, feel: 'broken', space: 'mid' }),
    backbeats: one({ id: 'ghost', pattern: '....X.......X...', energy: 2, feel: 'straight', space: 'mid' }),
    hats: one({ id: 'threes', pattern: '..x..x..x..x..x.', energy: 4, feel: 'broken', space: 'mid' }),
    basslines: one({
      id: 'pendulum',
      scale: true,
      steps: '0.....4.....2...',
      energy: 3,
      register: 'low',
      space: 'mid',
    }),
    motifs: one({
      id: 'box',
      scale: true,
      steps: '4~~~~~2~~~~~0~~~' + '1~~~~~2~~~~~~~~~',
      energy: 3,
      register: 'high',
      space: 'mid',
    }),
    stabs: one({ id: 'threes', pattern: 'x.....x.....x...', energy: 3, space: 'mid' }),
    harmonies: one({
      id: 'turn',
      chords: [
        { root: 0, quality: 'min' },
        { root: 8, quality: 'maj' },
        { root: 5, quality: 'min' },
        { root: 10, quality: 'maj' },
      ],
      barsPerChord: 2,
      mood: 'lifting',
    }),
  },
  feel: {
    ...pinned(deep),
    parts: LATTICE_PARTS,
    accentVoice: { thermal: 'bell', voltaic: 'pluck', void: 'organ' },
    hueKick: { thermal: 'punch', voltaic: 'punch', void: 'punch' },
    huePerc: { thermal: 'rim', voltaic: 'rim', void: 'rim' },
    hueStab: { thermal: 'organ', voltaic: 'organ', void: 'organ' },
    leadVoice: () => 'bell',
    bassVoice: () => 'pluck',
    echo: () => 0.4,
    axiomBias: {
      ignition: { key: 3, feel: 'broken', swing: 0 },
      circuit: { key: 3, feel: 'broken', swing: 0 },
      feedback: { key: 3, feel: 'broken', swing: 0 },
    },
  },
  mix: {
    ...deep.mix,
    tempo: TEMPO,
    form: straight('turn', [0.5, 0.8]),
    length: { ...deep.mix.length, chord: 2 },
    register: { ...deep.mix.register, bass: 0, motif: 24, motifAnswer: 24 },
    gains: { ...deep.mix.gains, kick: 0.78, hat: 0.6, stab: 0.85, motif: 1.2, bass: 0.62, sub: 0.3, chord: 0.6, part: 0.7 },
    entry: build,
    filter: { ...deep.mix.filter, floor: 600, span: 3800, q: 1.2, intensityFloor: 0.7 },
    duck: { depth: 0.35, recover: 0.7 },
  },
  graph: {
    ...deep.graph,
    reverb: { send: 0.3, seconds: 2.8, damp: 4200, predelay: 0.02, highpass: 0 },
    delay: { note: 0.75, feedback: 0.44, damp: 2600, glide: 0.2 },
  },
  demo: {
    axiomId: 'ignition',
    from: 0,
    rows: [{ triggerId: 'on_crit', primitive: 'orbital', hue: 'voltaic', modifiers: [] }],
  },
};

// ------------------------------------------------------------------ BASIN
//
// Replaces TUNDRA, which was thrown out.
//
// Tundra chased "a choir in a big room" and never landed it, through four
// attempts. The post-mortem is worth keeping, because every reason was a
// different one: the formant `voice` lead is a thin, midrange instrument that a
// drum kit walks straight over; a 5.4-second reverb over a sustained pad is a
// wash rather than a room; its melody was one held note a bar; its bass was a
// Karplus-Strong string ringing longer than the gap between its notes; and its
// audition ran a *single* Program, so the layer that fills a song out was one
// voice wide. Four fixes, still bad — at which point the concept, not the
// parameters, is the thing that is wrong.
//
// So this is a different genre rather than another pass. Dub: the chord is on
// the offbeat and the delay is the instrument. It is the only thing in the
// playlist that swings, the only one where the space comes from a delay rather
// than a reverb, and the only one whose melody is a click rather than a tune —
// three axes of difference that survive a drum kit, which is more than "a
// different lead voice" ever managed. It shares its four-on-the-floor with
// furnace, deliberately: the drive belongs on every beat and the difference
// belongs above it.

/** Dub. The chord is on the offbeat and the delay does the rest. */
export const basin: Score = {
  ...deep,
  id: 'basin',
  listed: true,
  name: 'Basin',
  blurb: 'Dub. Offbeat organ chords in a long delay, and a click for a melody.',
  cells: {
    ...deep.cells,
    // On every beat, and nothing else. The half-time version put a sixteenth
    // pickup before the downbeat, which is a stutter rather than a groove — it
    // arrives a beat early and takes the drive out of the bar it is meant to
    // announce. This shares its pulse with furnace and earns its difference
    // above the kick instead: the swing, the offbeat chord, the delay.
    kicks: one({ id: 'well', pattern: 'X...X...X...X...', energy: 3, feel: 'swung', space: 'mid' }),
    backbeats: one({ id: 'rim', pattern: '....X.......X...', energy: 2, feel: 'swung', space: 'mid' }),
    hats: one({ id: 'shuffle', pattern: '..x...x...x...x.', energy: 3, feel: 'swung', space: 'mid' }),
    basslines: one({
      id: 'well',
      scale: true,
      // Deep and simple, and on `sub` rather than `string` so it does not ring
      // into the next note. Dub bass is a pitch, not a phrase.
      steps: '0~~~~~~~~~~~~~~~' + '0~~~~~~~4~~~~~~~',
      energy: 2,
      register: 'low',
      space: 'sparse',
    }),
    motifs: one({
      id: 'signal',
      scale: true,
      /**
       * A click rhythm that happens to have a pitch.
       *
       * The old line was four long held notes walking up a scale — a tune, and a
       * thin one, sitting in the middle of the mix asking to be listened to. Cold
       * techno does the opposite: the melodic part is a percussion figure with
       * almost no tonal movement, and what you follow is *where the notes land*.
       *
       * So the pitches barely move — the second degree for eleven of the twelve
       * notes, with one step up and one down in the second bar, and nothing held.
       * Played on `blip`, which is a click with a note in it.
       */
      steps: '..2.2..2..2.2..2' + '..2.2..2..3.2..1',
      energy: 3,
      register: 'mid',
      space: 'mid',
    }),
    // The whole song. An organ chord on every offbeat eighth, through the delay.
    stabs: one({ id: 'skank', pattern: '..X...X...X...X.', energy: 3, space: 'mid' }),
    harmonies: one({
      id: 'well',
      chords: [
        { root: 0, quality: 'min7' },
        { root: 8, quality: 'sus' },
      ],
      barsPerChord: 4,
      mood: 'suspended',
    }),
  },
  feel: {
    ...pinned(deep),
    parts: BASIN_PARTS,
    accentVoice: { thermal: 'organ', voltaic: 'organ', void: 'bell' },
    hueKick: { thermal: 'deep', voltaic: 'deep', void: 'deep' },
    huePerc: { thermal: 'rim', voltaic: 'rim', void: 'rim' },
    /**
     * `organ`, not `dub`.
     *
     * `dub` is detuned triangles behind a lowpass sweeping 1500 to 500Hz at Q 2,
     * two octaves up. A resonant sweep down through the midrange is how you
     * synthesise a vowel, and this one fired on every offbeat eighth into a
     * 0.66-feedback delay, so the vowel repeated for the length of the song. It
     * measured as the only layer carrying the 700-3000Hz band at all — muting it
     * dropped that band 1.5dB while every other layer moved by nothing.
     *
     * `organ` is drawbars: sines at the first three harmonics, a soft attack and
     * no filter movement whatsoever. Nothing sweeps, so nothing talks. It is also
     * the more honest dub chord — the records this borrows from are organ chords
     * through a delay, not filter sweeps.
     */
    hueStab: { thermal: 'organ', voltaic: 'organ', void: 'organ' },
    // A click with a note in it. See `blip` in voices.ts for why none of the
    // other four leads is right for this.
    leadVoice: () => 'blip',
    bassVoice: () => 'sub',
    // Rhythmic, not a pad. The pad was half of tundra's wash.
    chordVoice: 'gated',
    // Dub is the echo. This is the highest send in the playlist by a distance.
    echo: () => 0.6,
    // And the only swing in it.
    axiomBias: {
      ignition: { key: -2, feel: 'swung', swing: 0.16 },
      circuit: { key: -2, feel: 'swung', swing: 0.16 },
      feedback: { key: -2, feel: 'swung', swing: 0.16 },
    },
  },
  mix: {
    ...deep.mix,
    tempo: TEMPO,
    form: straight('well', [0.45, 0.72]),
    register: { ...deep.mix.register, bass: 0, motif: 12, motifAnswer: 24, part: 0 },
    gains: {
      ...deep.mix.gains,
      kick: 0.85,
      hat: 0.5,
      stab: 1,
      motif: 0.9,
      bass: 0.85,
      chord: 0.35,
      sub: 0.25,
      part: 0.45,
    },
    entry: build,
    filter: { ...deep.mix.filter, floor: 420, span: 4400, q: 1.4, intensityFloor: 0.7 },
    // A deep pump. In dub the sidechain is audible on purpose.
    duck: { depth: 0.28, recover: 0.86 },
  },
  graph: {
    ...deep.graph,
    // A long, dark, self-feeding delay — the actual instrument. And a small room
    // behind it, highpassed, so the low end stays dry.
    delay: { note: 0.75, feedback: 0.66, damp: 1600, glide: 0.25 },
    reverb: { send: 0.18, seconds: 2.6, damp: 3000, predelay: 0.025, highpass: 300 },
  },
  // Three rows, not one. Tundra auditioned a single Program, so the layer that
  // fills a song out was one voice wide and the song sounded like a sketch.
  demo: {
    axiomId: 'circuit',
    from: 1,
    rows: [
      { triggerId: 'clock', primitive: 'chain', hue: 'void', modifiers: ['echo'] },
      { triggerId: 'on_hit', primitive: 'zone', hue: 'thermal', modifiers: [] },
      { triggerId: 'on_kill', primitive: 'orbital', hue: 'voltaic', modifiers: ['sustain'] },
    ],
  },
};

// ----------------------------------------------------------------- MARROW

/** Weight. The heaviest kit in the game, on all four, with a ♭II over it. */
export const marrow: Score = {
  ...deep,
  id: 'marrow',
  listed: true,
  name: 'Marrow',
  blurb: 'Slam kick, anvil, drone bass, a bII that never lands.',
  cells: {
    ...deep.cells,
    kicks: one({ id: 'slam', pattern: 'X...X...X...X..x', energy: 4, feel: 'straight', space: 'sparse' }),
    backbeats: one({ id: 'anvil', pattern: '....X.......X..X', energy: 3, feel: 'straight', space: 'mid' }),
    hats: one({ id: 'creak', pattern: '..o.x...o.o.x.x.', energy: 3, feel: 'broken', space: 'mid' }),
    basslines: one({
      id: 'grind',
      scale: true,
      steps: '0~~~0~~~0~~~1~~~' + '0~~~0~~~6~~~1~~~',
      energy: 3,
      register: 'low',
      space: 'sparse',
    }),
    motifs: one({
      id: 'dirge',
      scale: true,
      // An arc, inside the two bars a cell is allowed. Up to the sixth across the
      // first bar, home across the second — so the line goes somewhere instead of
      // returning to where it started. (16 or 32 steps only; 64 does not exist.)
      /**
       * A melody, written to the rules rather than assembled out of notes.
       *
       * What was here was `0 2 3 5 6 | 5 3 2 1 0` — every scale degree in order,
       * up and back down. That is a *scale*, not a tune: it has no motif, so
       * there is nothing to recognise; no leap, so there is no character; no
       * single high point, so there is no shape; and it ends by arriving back
       * where it started, so nothing resolves. Adding notes to it was never going
       * to help, because none of them were the missing thing.
       *
       * The scale is natural minor — `[0,2,3,5,7,8,10]` — so the degrees below
       * read 0=tonic, 1=2nd, 2=♭3, 3=4th, 4=5th, 5=♭6, 6=♭7.
       *
       *   bar 1   0 . . . 4 . . . 3 . . . 2 . . .     tonic, up a 5th, 4th, ♭3
       *   bar 2   1 . . . 5 . . . 3 . . 1 . 0 . .     2nd,   up a 5th, 4th, 2nd, tonic
       *
       * **Motif and sequence.** One idea — *leap up a fifth, then walk back down*
       * — stated in bar 1 from the tonic and repeated in bar 2 from the note
       * above it. Repetition and sequence are the two cheapest sources of
       * memorability there are, and the old line had neither.
       *
       * **Gap-fill.** The fifth opens a gap and the stepwise descent closes it.
       * Ears expect a leap to be paid back; this pays it back twice.
       *
       * **One climax.** ♭6 is the highest note in the phrase and it happens
       * exactly once, 63% of the way through — near enough the golden section
       * that it lands where a listener is already waiting for the peak. It is
       * also a chord tone of the ♭II this song hangs on, so the high point of the
       * melody is the moment the harmony bites.
       *
       * **Question and answer.** Bar 1 stops on the ♭3: in the chord, but not
       * home, so it hangs. Bar 2 closes 2nd→tonic, which is an actual cadence.
       * Bar 1 asks and bar 2 answers, which is why two bars feel finished.
       *
       * **Rhythm carries the same argument.** Bar 1 is four even quarters — a
       * plain statement. Bar 2 adds two eighths in the descent, so the answer
       * moves more than the question did.
       *
       * Range is a sixth, and every interval is a step or a fifth. It is singable,
       * which is the only test that matters.
       */
      steps: '0~~~4~~~3~~~2~~~' + '1~~~5~~~3~~1~0~~',
      energy: 2,
      register: 'mid',
      space: 'sparse',
    }),
    stabs: one({ id: 'press', pattern: '..X...X.....X.X.', energy: 3, space: 'mid' }),
    harmonies: one({
      id: 'sink',
      chords: [
        { root: 0, quality: 'min' },
        { root: 1, quality: 'maj' },
      ],
      barsPerChord: 4,
      mood: 'dark',
    }),
  },
  feel: {
    ...pinned(deep),
    parts: MARROW_PARTS,
    /**
     * Unpitched, all three.
     *
     * `tick` was the last keyboard in the song and it did not look like one in a
     * list of voice names: it is a Q-9 bandpass on a square at three times the
     * pitch, which is a short, plinky, *tuned* blip — a struck key. Two of the
     * three hues fired one on every accent. An accent here is a hit, so all
     * three are noise now and none of them has a note in it.
     */
    accentVoice: { thermal: 'noise', voltaic: 'noise', void: 'noise' },

    /**
     * `pad` — detuned saws, slow swell. Synth strings.
     *
     * `gated` chops the chord onto the grid, which is right when a lead carries
     * the tune and the harmony must stay out of its way. There is no lead here any
     * more, so the harmony *is* the top of the song and it should sustain: ±11
     * cents of detune across two sawtooths per chord tone, an attack over a third
     * of the note, a long tail, through a 1.4kHz lowpass. That is a string
     * section, and `pad` is already routed to the reverb.
     */
    chordVoice: 'pad',
    /**
     * Sawtooths on all three hues.
     *
     * The inherited table puts a square on voltaic, which is a synth-brass sound
     * — one hue in three would have arrived as a different instrument, and since
     * the audition rotates the hue every seventeen seconds you would hear the
     * strings turn into brass and back for no reason.
     */
    huePadWave: { thermal: 'sawtooth', voltaic: 'sawtooth', void: 'sawtooth' },
    hueKick: { thermal: 'slam', voltaic: 'slam', void: 'slam' },
    huePerc: { thermal: 'anvil', voltaic: 'anvil', void: 'anvil' },
    hueStab: { thermal: 'hit', voltaic: 'hit', void: 'hit' },
    bassVoice: () => 'drone',
    leadVoice: () => 'voice',
    echo: () => 0.4,
    axiomBias: {
      ignition: { key: -1, feel: 'straight', swing: 0 },
      circuit: { key: -1, feel: 'straight', swing: 0 },
      feedback: { key: -1, feel: 'straight', swing: 0 },
    },
  },
  mix: {
    ...deep.mix,
    tempo: TEMPO,
    /**
     * Dark, not muted.
     *
     * This was [0.25, 0.5], which put the lowpass on the music bus at 639-1037Hz
     * for the entire song. Everything above it — the hats, the anvil's attack,
     * every harmonic that makes the melody a melody — was removed, and since the
     * kick is routed to `punchBus` and never filtered, what came out was a kick
     * and a blanket. The song was playing the whole time; none of it was
     * arriving. Heaviness is a spectrum you can hear the bottom of, not the
     * absence of a top.
     */
    form: kitBassStrings('toll', [0.6, 0.9]),
    register: { ...deep.mix.register, bass: 0, sub: -12, motif: 24, motifAnswer: 24 },
    length: { ...deep.mix.length, chord: 3.5 },
    gains: {
      ...deep.mix.gains,
      part: 0.7,
      kick: 0.8,
      backbeatBase: 0.65,
      backbeatPerIntensity: 0,
      hat: 0.72,
      // Gated out by the form — kept only so re-enabling is a one-word change.
      stab: 0.95,
      motif: 1.25,
      bass: 0.9,
      // The strings and the bass are the whole song above the kit.
      chord: 0.78,
      sub: 0.25,
    },
    entry: build,
    filter: { ...deep.mix.filter, floor: 300, span: 3400, q: 2.8, intensityFloor: 0.55 },
    duck: { depth: 0.18, recover: 0.9 },
  },
  graph: {
    ...deep.graph,
    reverb: { send: 0.52, seconds: 4.2, damp: 1800, predelay: 0.035, highpass: 250 },
    lowShelf: { hz: 90, gain: 5 },
    delay: { note: 0.75, feedback: 0.5, damp: 1200, glide: 0.25 },
  },
  demo: {
    axiomId: 'ignition',
    from: 0,
    rows: [{ triggerId: 'on_kill', primitive: 'zone', hue: 'void', modifiers: ['sustain'] }],
  },
};
