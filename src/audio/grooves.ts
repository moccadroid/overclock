/**
 * Grooves. The base rhythm, as a thing you can change on its own.
 *
 * Eight Scores in and the beat had barely moved, and the reason was structural
 * rather than a failure of nerve: a Score that spreads `...deep` inherits every
 * cell it does not explicitly replace, so `deep`, `vault` and `choir` all shipped
 * with **the same fifty-one cells** — the same kicks, the same hats, the same
 * backbeats. Changing the instruments and the tempo while keeping the patterns
 * gets you the same song played by a different band, which is exactly what it
 * sounded like.
 *
 * A Groove is the drums, lifted out: a kit's worth of kick, backbeat and hat
 * cells, plus the feel and the swing that go with them. It overrides whatever the
 * Score brought, so **rhythm and sound are now two dials instead of one** — any
 * song can be played half-time, or shuffled, or broken, or with no drums at all,
 * and eight songs times eight grooves is a great deal more music than eight songs.
 *
 * `null` is a legitimate choice and the default: the Score's own drums, as
 * authored. Nothing here changes a Score that nobody has pointed a Groove at,
 * which is what keeps the frozen ones frozen.
 */
import type { Feel as CellFeel, PercCell } from './cells';

export interface Groove {
  id: string;
  name: string;
  /** One line, for the list on the desk. */
  blurb: string;
  /** What the drums ask the arranger for. */
  feel: CellFeel;
  /** How far the offbeat sixteenths are pushed. */
  swing: number;
  kicks: PercCell[];
  backbeats: PercCell[];
  hats: PercCell[];
}

const SILENT = '................';

/**
 * Four on the floor.
 *
 * The one the game has always played, kept as an explicit choice rather than an
 * absence — "the default groove" and "no groove" being different things matters
 * the moment you can pick.
 */
const four: Groove = {
  id: 'four',
  name: 'Four',
  blurb: 'Four on the floor. The one you know.',
  feel: 'straight',
  swing: 0,
  kicks: [
    { id: 'floor', pattern: 'x...x...x...x...', energy: 2, feel: 'straight', space: 'sparse' },
    { id: 'floor-hard', pattern: 'X...x...X...x...', energy: 3, feel: 'straight', space: 'sparse' },
    { id: 'rolling', pattern: 'x...x...x..xx...', energy: 4, feel: 'rolling', space: 'mid' },
    { id: 'gallop', pattern: 'X..xx...X..xx...', energy: 5, feel: 'rolling', space: 'busy' },
  ],
  backbeats: [
    { id: 'two-four', pattern: '....x.......x...', energy: 2, feel: 'straight', space: 'sparse' },
    { id: 'two-four-hard', pattern: '....X.......X...', energy: 3, feel: 'straight', space: 'sparse' },
    { id: 'ghosted', pattern: '....X..o....X..o', energy: 4, feel: 'rolling', space: 'mid' },
    { id: 'roll-in', pattern: '....X...ooooX...', energy: 5, feel: 'rolling', space: 'busy' },
  ],
  hats: [
    { id: 'offbeat', pattern: '..x...x...x...x.', energy: 2, feel: 'straight', space: 'sparse' },
    { id: 'eighths', pattern: 'x.x.x.x.x.x.x.x.', energy: 3, feel: 'straight', space: 'mid' },
    { id: 'sixteenths', pattern: '.o.x.o.x.o.x.o.x', energy: 4, feel: 'straight', space: 'busy' },
    { id: 'driving', pattern: 'oxoxoxoxoxoxox-x', energy: 5, feel: 'rolling', space: 'busy' },
  ],
};

/**
 * Half-time. The single biggest change to how a track *feels* for the least
 * change to what is in it.
 *
 * The backbeat moves from two-and-four to **three alone**, which halves the
 * perceived tempo without touching the clock — the same 104 BPM reads as 52 and
 * everything above it suddenly has twice as much room. The kick gets out of the
 * way to let that happen: one on the downbeat and one late, rather than four.
 */
const half: Groove = {
  id: 'half',
  name: 'Half-time',
  blurb: 'Backbeat on 3 alone. Halves the feel without touching the tempo.',
  feel: 'straight',
  swing: 0.06,
  kicks: [
    { id: 'one', pattern: 'X...............', energy: 1, feel: 'straight', space: 'sparse' },
    { id: 'one-late', pattern: 'X...........x...', energy: 2, feel: 'straight', space: 'sparse' },
    { id: 'lean', pattern: 'X.......x...x...', energy: 3, feel: 'straight', space: 'mid' },
    { id: 'push', pattern: 'X..x....x...x..x', energy: 4, feel: 'rolling', space: 'mid' },
    { id: 'drag', pattern: 'X..x..x.x...x.x.', energy: 5, feel: 'broken', space: 'busy' },
  ],
  backbeats: [
    { id: 'three', pattern: '........X.......', energy: 2, feel: 'straight', space: 'sparse' },
    { id: 'three-ghost', pattern: '........X.....o.', energy: 3, feel: 'straight', space: 'sparse' },
    { id: 'three-lead', pattern: '..o.....X...o...', energy: 4, feel: 'rolling', space: 'mid' },
    { id: 'three-roll', pattern: '..o.o...X...ooo.', energy: 5, feel: 'rolling', space: 'busy' },
  ],
  hats: [
    { id: 'wide', pattern: '..o...........x.', energy: 1, feel: 'straight', space: 'sparse' },
    { id: 'offbeat', pattern: '..x...x...x...x.', energy: 2, feel: 'straight', space: 'sparse' },
    { id: 'eighths', pattern: 'x.x.x.x.x.x.x.x.', energy: 3, feel: 'straight', space: 'mid' },
    { id: 'sixteenths', pattern: '.o.x.o.x.o.x.o.x', energy: 5, feel: 'straight', space: 'busy' },
  ],
};

/**
 * Shuffle. Everything lands a little late and nothing lands square.
 *
 * Three-against-four throughout — a hit every third sixteenth, which does not
 * divide sixteen and so drifts against the bar before resolving. The ear hears
 * triplets even though nothing here is one; you cannot put real ones on a
 * sixteenth grid, and this is the move that has stood in for them since drum
 * machines had sixteen buttons.
 */
const shuffle: Groove = {
  id: 'shuffle',
  name: 'Shuffle',
  blurb: 'Swung and drifting. Triplets faked on a sixteenth grid.',
  feel: 'swung',
  swing: 0.3,
  kicks: [
    { id: 'lope', pattern: 'x.....x.....x...', energy: 2, feel: 'swung', space: 'sparse' },
    { id: 'swung', pattern: 'x...x..ox...x..o', energy: 3, feel: 'swung', space: 'mid' },
    { id: 'triplet', pattern: 'x..x..x...x.x...', energy: 4, feel: 'broken', space: 'mid' },
    { id: 'stagger', pattern: 'x..x..x..x..x..x', energy: 5, feel: 'broken', space: 'busy' },
  ],
  backbeats: [
    { id: 'late', pattern: '.....x.......x..', energy: 2, feel: 'swung', space: 'sparse' },
    { id: 'late-ghost', pattern: '.....x..o....x..', energy: 3, feel: 'swung', space: 'mid' },
    { id: 'triplet-ghost', pattern: '....x..o..o.x...', energy: 4, feel: 'broken', space: 'mid' },
    { id: 'flail', pattern: '..o..x..o..x..o.', energy: 5, feel: 'swung', space: 'busy' },
  ],
  hats: [
    { id: 'shuffle', pattern: '..x..o..x..o..x.', energy: 3, feel: 'swung', space: 'mid' },
    { id: 'sparse', pattern: '..x.....x.....x.', energy: 2, feel: 'swung', space: 'sparse' },
    { id: 'cross', pattern: 'x..x..x..x..x..x', energy: 4, feel: 'broken', space: 'mid' },
    { id: 'roll', pattern: 'oxooxooxooxooxo.', energy: 5, feel: 'swung', space: 'busy' },
  ],
};

/**
 * A break. Kick and snare interlocking instead of taking turns.
 *
 * The oldest sampled rhythm there is, and structurally the opposite of
 * four-on-the-floor: the kick answers the snare rather than marking time under
 * it, so the bar has a *conversation* in it. Nothing lands on all four quarters
 * and the second half never repeats the first.
 */
const breaks: Groove = {
  id: 'breaks',
  name: 'Breaks',
  blurb: 'Kick and snare interlocking. Nothing marks the quarters.',
  feel: 'broken',
  swing: 0.12,
  kicks: [
    { id: 'plain', pattern: 'X.......x.......', energy: 1, feel: 'broken', space: 'sparse' },
    { id: 'answer', pattern: 'X.....x.......X.', energy: 3, feel: 'broken', space: 'mid' },
    { id: 'amen', pattern: 'X..x..x....X..x.', energy: 4, feel: 'broken', space: 'mid' },
    { id: 'chopped', pattern: 'X.x...x.X....x.x', energy: 5, feel: 'broken', space: 'busy' },
  ],
  backbeats: [
    { id: 'two-four', pattern: '....X.......X...', energy: 2, feel: 'broken', space: 'sparse' },
    { id: 'ghosted', pattern: '....X..o..o.X...', energy: 3, feel: 'broken', space: 'mid' },
    { id: 'pushed', pattern: '....X.....X.X...', energy: 4, feel: 'broken', space: 'mid' },
    { id: 'shredded', pattern: '..o.X.o.X.o.X.oo', energy: 5, feel: 'broken', space: 'busy' },
  ],
  hats: [
    { id: 'offbeat', pattern: '..x...x...x...x.', energy: 2, feel: 'straight', space: 'sparse' },
    { id: 'ride', pattern: 'x.x.x.x.x.x.x.x.', energy: 3, feel: 'straight', space: 'mid' },
    { id: 'busy', pattern: 'oxoxoxoxoxoxoxox', energy: 4, feel: 'straight', space: 'busy' },
    { id: 'burst', pattern: '..x...x...xxxxx.', energy: 5, feel: 'broken', space: 'busy' },
  ],
};

/**
 * Broken. The industrial kit: an event that interrupts the bar rather than the
 * grid the bar is built from.
 */
const broken: Groove = {
  id: 'broken',
  name: 'Broken',
  blurb: 'Limping and metallic. The bar never settles.',
  feel: 'broken',
  swing: 0.1,
  kicks: [
    { id: 'drag', pattern: 'X.........X.....', energy: 1, feel: 'broken', space: 'sparse' },
    { id: 'iron', pattern: 'X.....x..X......', energy: 2, feel: 'broken', space: 'sparse' },
    { id: 'lurch', pattern: 'X..x......X.....', energy: 3, feel: 'broken', space: 'mid' },
    { id: 'hammer', pattern: 'X...X.....X.X...', energy: 4, feel: 'broken', space: 'mid' },
    { id: 'seizure', pattern: 'X.XX..X...X.XX..', energy: 5, feel: 'broken', space: 'busy' },
  ],
  backbeats: [
    { id: 'toll', pattern: '........X.......', energy: 1, feel: 'broken', space: 'sparse' },
    { id: 'clang', pattern: '......X.........', energy: 2, feel: 'broken', space: 'sparse' },
    { id: 'double', pattern: '......X...X.....', energy: 3, feel: 'broken', space: 'mid' },
    { id: 'chain', pattern: '..o...X...o...o.', energy: 4, feel: 'rolling', space: 'mid' },
    { id: 'flail', pattern: '..o.X.o...X.o.X.', energy: 5, feel: 'broken', space: 'busy' },
  ],
  hats: [
    { id: 'absent', pattern: '..............x.', energy: 1, feel: 'broken', space: 'sparse' },
    { id: 'breath', pattern: '......o.......x.', energy: 2, feel: 'broken', space: 'sparse' },
    { id: 'creak', pattern: '..o.......o...x.', energy: 3, feel: 'broken', space: 'mid' },
    { id: 'skitter', pattern: '..o.o.....o.oxo.', energy: 4, feel: 'broken', space: 'mid' },
    { id: 'steam', pattern: '.o.o.o.o.o.o.o-.', energy: 5, feel: 'rolling', space: 'busy' },
  ],
};

/**
 * Rolling. Continuous low percussion with no strong downbeat — the bar is a
 * wheel rather than a line, which is the one thing on this list that gets more
 * hypnotic the longer it runs.
 */
const rolling: Groove = {
  id: 'rolling',
  name: 'Rolling',
  blurb: 'Continuous and circular. No downbeat to hold on to.',
  feel: 'rolling',
  swing: 0.05,
  kicks: [
    { id: 'turn', pattern: 'x..x..x...x.x...', energy: 3, feel: 'rolling', space: 'mid' },
    { id: 'wheel', pattern: 'x.x...x.x.x...x.', energy: 4, feel: 'rolling', space: 'busy' },
    { id: 'low', pattern: 'x.....x.....x...', energy: 2, feel: 'rolling', space: 'sparse' },
    { id: 'spin', pattern: 'x.xx..x.x.xx..x.', energy: 5, feel: 'rolling', space: 'busy' },
  ],
  backbeats: [
    { id: 'ring', pattern: '..o...o...o...o.', energy: 2, feel: 'rolling', space: 'mid' },
    { id: 'ring-hard', pattern: '..o.x..o..o.x..o', energy: 4, feel: 'rolling', space: 'busy' },
    { id: 'edge', pattern: '......o.......o.', energy: 1, feel: 'rolling', space: 'sparse' },
    { id: 'clatter', pattern: '.oo.o.oo.o.oo.o.', energy: 5, feel: 'rolling', space: 'busy' },
  ],
  hats: [
    { id: 'ticking', pattern: '..o...o...o...o.', energy: 2, feel: 'rolling', space: 'sparse' },
    { id: 'rolling', pattern: 'oxooxooxooxooxo.', energy: 4, feel: 'rolling', space: 'busy' },
    { id: 'sixteenths', pattern: '.o.x.o.x.o.x.o.x', energy: 3, feel: 'straight', space: 'mid' },
    { id: 'wash', pattern: 'oooxoooxoooxooo-', energy: 5, feel: 'rolling', space: 'busy' },
  ],
};

/** Nothing. The rhythm comes from whatever else is moving. */
const none: Groove = {
  id: 'none',
  name: 'None',
  blurb: 'No drums at all. Let the sequencer keep time.',
  feel: 'straight',
  swing: 0,
  kicks: [{ id: 'none', pattern: SILENT, energy: 1, feel: 'straight', space: 'sparse' }],
  backbeats: [{ id: 'none', pattern: SILENT, energy: 1, feel: 'straight', space: 'sparse' }],
  hats: [{ id: 'none', pattern: SILENT, energy: 1, feel: 'straight', space: 'sparse' }],
};

export const GROOVES: Readonly<Record<string, Groove>> = {
  four,
  half,
  shuffle,
  breaks,
  broken,
  rolling,
  none,
};

export function resolveGroove(id: string | null | undefined): Groove | null {
  if (!id || id === 'score') return null;
  return GROOVES[id] ?? null;
}
