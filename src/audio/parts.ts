/**
 * The Engine, as an arrangement. GDD §18.1 — "the soundtrack *is* the engine."
 *
 * Until now that was a lie with a nice comment on it: the track was a table
 * keyed by Axiom, and the Engine was allowed to add decoration on top. This
 * module makes the claim true. **Every Program becomes a part**, and the part is
 * derived from the row itself:
 *
 *   Action     the instrument — voice family and register
 *   Trigger    the rhythm — a 16-step pattern from what it listens to
 *   Modifiers  the processing — how that part is treated
 *   Hue        the band it occupies
 *
 * `Clock › Bolt` is a steady pluck on the four. Add Split and it flams. Add Echo
 * and it feeds the delay. Swap the Action for Nova and the same rhythm drops two
 * octaves into a sub hit. Four live rows are four interlocking sequenced lines,
 * which is what a techno track actually is.
 *
 * The important split, and the reason this works as music rather than as
 * sonification:
 *
 *   **The pattern comes from your build. The accents come from your play.**
 *
 * A build is stable for minutes at a time, so the sequence is hypnotic and
 * repeating — which the genre needs. Play is second-to-second, so it lands on
 * top as performance. Rebuilding your Engine audibly rewrites the track.
 *
 * Pure and dependency-light on purpose: it takes ids, not sim objects, so audio
 * still never imports the simulation.
 */

export type PartVoice =
  | 'pluck'
  | 'stab'
  | 'acid'
  | 'drone'
  | 'bell'
  | 'tick'
  | 'sweep'
  | 'noise'
  | 'riser'
  | 'organ';

/**
 * The four tables that decide what a live Program sounds like.
 *
 * These were module constants, and that made this — the **densest layer in the
 * whole mix** — identical in every Score. Measured over 64 bars, the parts fire
 * around 576 notes against the motif's 63; nine Scores produced three distinct
 * part patterns between them. Whatever else changed, the loudest continuous
 * thing you were listening to was the same music every time.
 */
export interface PartTuning {
  /** Which sixteenths a Trigger fires on. */
  rhythm: Readonly<Record<string, readonly number[]>>;
  /** Which instrument and register an Action primitive gets. */
  voice: Readonly<Record<string, { voice: PartVoice; register: number }>>;
  /** How each voice moves across the bar, as chord degrees. */
  contour: Readonly<Record<string, readonly (readonly number[])[]>>;
  /** §16.3 — hue moves a part up or down a register. */
  hueRegister: Readonly<Record<string, number>>;
  /** Density cap. A part with no gaps is not a part, it is a drone. */
  maxSteps: number;
}

export interface ProgramShape {
  triggerId: string | null;
  modifierIds: readonly (string | null)[];
  actionId: string | null;
  live: boolean;
}

export interface Part {
  /** 16-step mask. True = play. */
  pattern: boolean[];
  voice: PartVoice;
  /** Semitone offset from the chord root. Negative is bass register. */
  register: number;
  /** Which chord tone this part favours — spreads rows across the harmony. */
  tone: number;
  /**
   * Chord degrees to walk across the bar, added to `tone`.
   *
   * Without this a part played **one pitch, every time it fired, for the whole
   * run** — `tone` is fixed and the chord only moves when the arrangement does.
   * On a sixteenth-rate row that is the same note sixteen times a bar, which is
   * what a held Beam sounded like: not a riff, a fault.
   *
   * Offsets are chord *degrees*, not semitones, so anything they land on is
   * already in the harmony — the line can move without being able to go wrong.
   * Indexed by the step, so it is a figure that repeats rather than noise.
   */
  contour: readonly number[];
  gain: number;
  /** 0..1 send into the dub delay. */
  echo: number;
  /** Extra filter drive. Overdrive and Amplify raise it. */
  bite: number;
  /** Note length multiplier. Sustain and Enlarge stretch it. */
  length: number;
  /** True when this part should slide between notes. */
  glide: boolean;
}

/**
 * Rhythm by Trigger.
 *
 * Chosen so the *feel* matches what the Trigger does in play: a Clock is a
 * metronome, so it lands on the beat; On Hit is the highest-frequency event in
 * the game, so it is sixteenths; On Crit is rare, so it is two accents a bar. A
 * player who knows what a Trigger does can hear which ones they own.
 */
const TRIGGER_RHYTHM: Record<string, number[]> = {
  clock: [0, 4, 8, 12],
  on_hit: [0, 2, 4, 6, 8, 10, 12, 14],
  on_kill: [2, 3, 6, 10, 11, 14],
  on_crit: [7, 15],
  on_pickup: [2, 6, 10, 14],
  on_dash: [1, 9],
  on_wound: [5, 13],
  on_wave: [0],
  on_overheat: [0, 8],
  on_convert: [3, 7, 11, 15],
};

/**
 * Instrument by Action primitive.
 *
 * Register is in semitones from the chord root: a Nova is a low burst and a Bolt
 * is a high pluck, which matches what they *look* like. Rows therefore stack
 * into a mix by themselves rather than all crowding one octave.
 */
const ACTION_VOICE: Record<string, { voice: PartVoice; register: number }> = {
  projectile: { voice: 'pluck', register: 12 },
  burst: { voice: 'stab', register: -12 },
  chain: { voice: 'acid', register: 0 },
  beam: { voice: 'drone', register: 0 },
  zone: { voice: 'drone', register: -12 },
  orbital: { voice: 'bell', register: 12 },
  mine: { voice: 'tick', register: 0 },
  delayed: { voice: 'tick', register: -12 },
  vortex: { voice: 'sweep', register: 0 },
  knockback: { voice: 'noise', register: 0 },
  buff: { voice: 'riser', register: 12 },
  convert: { voice: 'organ', register: 0 },
};

/**
 * How a part moves across the bar, by instrument.
 *
 * Sustained voices move slowly or not at all — a drone that hops every step is
 * not a drone — and short ones can afford a figure. Every entry starts on 0 so
 * the part still *lands* on the chord tone it was assigned; the movement is
 * ornament around it rather than a different line.
 */
const CONTOURS: Record<PartVoice, readonly (readonly number[])[]> = {
  // Beam and Field. Two long notes a bar: it leans, it does not dance.
  drone: [
    [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1],
    [0, 0, 0, 0, 0, 0, 0, 0, 2, 2, 2, 2, 2, 2, 2, 2],
  ],
  // Orbital. A bell can arpeggiate; that is what bells are for.
  bell: [
    [0, 2, 1, 2],
    [0, 1, 2, 1],
  ],
  pluck: [
    [0, 0, 1, 0, 2, 0, 1, 0],
    [0, 2, 0, 1],
  ],
  acid: [[0, 0, 1, 0, 0, 2, 1, 0]],
  stab: [[0, 0, 0, 1]],
  tick: [[0, 1, 0, 2]],
  sweep: [[0, 0, 1, 1]],
  riser: [[0, 1, 2, 1]],
  organ: [[0, 0, 2, 2]],
  noise: [[0]],
};

function contourFor(tuning: PartTuning, voice: PartVoice, index: number): readonly number[] {
  const options = tuning.contour[voice] ?? [[0]];
  return options[index % options.length] ?? [0];
}


/** Hue moves a part up or down a register, keeping the three colours apart. */
const HUE_REGISTER: Record<string, number> = { thermal: -12, voltaic: 12, void: 0 };

/**
 * Turn a Program into a part.
 *
 * Returns null for a row that is not live: a row that cannot fire should not be
 * heard, and that makes the editor's "not live" warning audible as silence.
 */
export function derivePart(
  shape: ProgramShape,
  action: { primitive: string; hue: string } | null,
  index: number,
  /** The Score's tables. Defaults to the authored ones. */
  tuning: PartTuning = DEFAULT_PARTS,
): Part | null {
  if (!shape.live || !shape.triggerId || !action) return null;

  const steps = tuning.rhythm[shape.triggerId] ?? [0, 8];
  const instrument = tuning.voice[action.primitive] ?? { voice: 'pluck' as const, register: 0 };

  const pattern = new Array(16).fill(false);
  for (const s of steps) pattern[s % 16] = true;

  const part: Part = {
    pattern,
    voice: instrument.voice,
    register: instrument.register + (tuning.hueRegister[action.hue] ?? 0),
    // Rows fan out across the chord so two rows never play the same note. This
    // is what turns four parts into harmony rather than four copies.
    tone: index % 3,
    contour: contourFor(tuning, instrument.voice, index),
    gain: 1,
    echo: 0,
    bite: 0,
    length: 1,
    glide: false,
  };

  for (const id of shape.modifierIds) {
    if (id) applyModifier(part, id);
  }
  thin(part, tuning.maxSteps);
  return part;
}

/**
 * Leave gaps.
 *
 * Modifiers add steps, and enough of them fill the bar — On Hit plus Split, or
 * On Hit plus Accelerate, both reached a solid sixteen. A part with no gaps is
 * not a part, it is a drone, and several of them at once is a wall.
 *
 * So density is capped after all modifiers rather than inside each one: the rule
 * is musical ("a line needs air"), not a property of any particular modifier,
 * and applying it once here means a new modifier cannot reintroduce the bug.
 * Offbeat sixteenths go first, from the end of the bar, which preserves the
 * downbeat and the part's identity.
 */
function thin(part: Part, max = 12): void {
  let count = part.pattern.filter(Boolean).length;
  for (let i = 15; i >= 0 && count > max; i -= 2) {
    if (part.pattern[i]) {
      part.pattern[i] = false;
      count--;
    }
  }
}

/**
 * Modifiers process the part.
 *
 * Each mapping is chosen so the *sound* of the modifier matches what it does to
 * the Program. Split makes three of something, so it flams. Echo repeats, so it
 * feeds the delay. Ground quiets and darkens, because that is what Ground does
 * to a row's output. Nobody has to be told these; they just line up.
 */
function applyModifier(part: Part, id: string): void {
  switch (id) {
    case 'split':
      // Three copies, so each hit becomes a flam.
      for (let i = 0; i < 16; i++) {
        if (part.pattern[i] && !part.pattern[(i + 1) % 16]) part.pattern[(i + 1) % 16] = true;
      }
      part.gain *= 0.8;
      break;
    case 'echo':
      part.echo = Math.min(1, part.echo + 0.55);
      break;
    case 'accelerate':
      // Fires more often, so the pattern subdivides.
      for (let i = 0; i < 16; i += 2) {
        if (part.pattern[i]) part.pattern[i + 1] = true;
      }
      break;
    case 'amplify':
      part.gain *= 1.3;
      part.bite += 0.25;
      break;
    case 'overdrive':
      part.gain *= 1.45;
      part.bite += 0.6;
      break;
    case 'focus':
      // Cancels Split: one note instead of many, and each one hits harder.
      for (let i = 1; i < 16; i += 2) part.pattern[i] = false;
      part.gain *= 1.5;
      break;
    case 'sustain':
      part.length *= 2.2;
      break;
    case 'enlarge':
      part.length *= 1.5;
      break;
    case 'pierce':
      part.length *= 1.3;
      break;
    case 'ricochet':
      part.echo = Math.min(1, part.echo + 0.3);
      break;
    case 'ground':
      part.gain *= 0.7;
      part.register -= 12;
      break;
    case 'quantize':
      // Locks hard to the beat — everything off the quarter is dropped.
      for (let i = 0; i < 16; i++) if (i % 4 !== 0) part.pattern[i] = false;
      break;
    case 'attune':
      part.glide = true;
      break;
    case 'resonate':
      part.gain *= 1.15;
      break;
    case 'volatile':
      part.length *= 1.4;
      part.bite += 0.2;
      break;
    case 'leech':
      part.gain *= 0.9;
      break;
    default:
      break;
  }
}

/** True when an arrangement has nothing in it — the bed plays alone. */
export function isSilent(parts: readonly (Part | null)[]): boolean {
  return parts.every((p) => p === null || p.pattern.every((x) => !x));
}

/** The authored tables, as a Score-shaped bundle. `current` points at this. */
export const DEFAULT_PARTS: PartTuning = {
  rhythm: TRIGGER_RHYTHM,
  voice: ACTION_VOICE,
  contour: CONTOURS,
  hueRegister: HUE_REGISTER,
  maxSteps: 12,
};
