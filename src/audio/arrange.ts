/**
 * The arranger. GDD §18.1 — "the soundtrack *is* the engine."
 *
 * `cells.ts` holds authored fragments. This file decides which ones the player's
 * Engine is asking for. Between them they replace what used to be three
 * hand-written tracks keyed by Axiom id — a system where the Axiom chose the
 * whole song and the build changed almost nothing, which made §18.1 a comment
 * rather than a fact.
 *
 * The rule every mapping here is held to: **a player must be able to learn to
 * hear it.** If nobody could ever say "the bass went squelchy because I drafted
 * Overdrive", the mapping is noise wearing meaning as a costume, and it would be
 * better to hard-code the value.
 *
 * Selection is deterministic. The same Engine always produces the same
 * arrangement — a build is a thing you can return to, and a track that reshuffled
 * itself on identical input would make that untrue.
 *
 * The Axiom keeps a role, but the same one it has everywhere else in the game:
 * a *bias*, like `poolBias` in the draft. It nudges selection. It no longer
 * dictates.
 */
import {
  pool,
  type Feel,
  type HarmonyCell,
  type MelodicCell,
  type PercCell,
  type Space,
  type StabCell,
} from './cells';
import type { BassVoice, KickVoice, LeadVoice, PercVoice, StabVoice } from './voices';

export type ArrangeHue = 'thermal' | 'voltaic' | 'void';

/** A live Program, reduced to what matters musically. */
export interface EngineRow {
  triggerId: string;
  primitive: string;
  hue: ArrangeHue;
  modifiers: string[];
}

export interface ArrangeInput {
  axiomId: string;
  rows: EngineRow[];
  /** 0..1, smoothed. Drives how much arrangement the run has earned. */
  intensity: number;
}

export interface Arrangement {
  /** Stable for the run. Semitones from A. */
  key: number;
  harmony: HarmonyCell;
  kick: PercCell;
  backbeat: PercCell;
  hats: PercCell;
  bass: MelodicCell;
  motif: MelodicCell;
  stab: StabCell;
  swing: number;

  kickVoice: KickVoice;
  percVoice: PercVoice;
  bassVoice: BassVoice;
  stabVoice: StabVoice;
  leadVoice: LeadVoice;
  padWave: OscillatorType;

  bassQ: number;
  bassBrightness: number;
  /** 0..1 send into the dub delay. */
  echo: number;
  /** How eagerly the hat layers arrive. */
  drive: number;
  /** Everything that went into this, for the Music screen and for debugging. */
  signature: string;
}

/**
 * The Axiom's contribution: a key, a default feel, and how much the track
 * shuffles. Small on purpose — three numbers, against a build that contributes
 * a dozen decisions.
 */
const AXIOM_BIAS: Record<string, { key: number; feel: Feel; swing: number }> = {
  ignition: { key: 0, feel: 'straight', swing: 0 },
  circuit: { key: 3, feel: 'rolling', swing: 0 },
  feedback: { key: -4, feel: 'swung', swing: 0.18 },
};

/** §16.3's hue discipline, applied to the drum kit. */
const HUE_KICK: Record<ArrangeHue, KickVoice> = {
  thermal: 'punch',
  voltaic: 'tight',
  void: 'deep',
};
const HUE_PERC: Record<ArrangeHue, PercVoice> = {
  thermal: 'clap',
  voltaic: 'snare',
  void: 'rim',
};
const HUE_STAB: Record<ArrangeHue, StabVoice> = {
  thermal: 'organ',
  voltaic: 'saw',
  void: 'dub',
};

/** Where each Action primitive sits, which is also where it sits on screen. */
const PRIMITIVE_REGISTER: Record<string, number> = {
  burst: 0,
  zone: 0,
  delayed: 0,
  knockback: 1,
  vortex: 1,
  chain: 1,
  beam: 1,
  convert: 1,
  mine: 1,
  projectile: 2,
  orbital: 2,
  buff: 2,
};

/** Triggers that fire on your own output — the ones that make a loop. */
const CASCADE_TRIGGERS = new Set(['on_hit', 'on_kill', 'on_crit']);

/** Stable hash, so identical builds tie-break identically. */
function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

interface Want {
  energy: number;
  feel?: Feel;
  space?: Space;
  register?: string;
  /** Cells needing a seventh are only playable over a min7. */
  seventhAvailable?: boolean;
}

/**
 * Score every candidate and take the best, breaking ties by build hash.
 *
 * Scored rather than filtered: a filter that matches nothing has to fall back to
 * something arbitrary, and "arbitrary" is how a careful mapping turns into
 * randomness. Scoring always has an answer and the answer is always the closest
 * available.
 */
function pick<T extends { id: string; energy: number }>(
  candidates: readonly T[],
  want: Want,
  seed: number,
): T {
  let best = candidates[0]!;
  let bestScore = -Infinity;

  for (const cell of candidates) {
    const c = cell as T & { feel?: Feel; space?: Space; register?: string; needsSeventh?: boolean };
    if (c.needsSeventh && want.seventhAvailable === false) continue;

    let score = -Math.abs(cell.energy - want.energy) * 2;
    if (want.feel && c.feel === want.feel) score += 3;
    if (want.space && c.space === want.space) score += 2;
    if (want.register && c.register === want.register) score += 4;
    // A deterministic jitter, small enough never to beat a real preference but
    // large enough that two equally good cells do not always resolve the same
    // way for every build in the game.
    score += (hash(cell.id + seed) % 100) / 120;

    if (score > bestScore) {
      bestScore = score;
      best = cell;
    }
  }
  return best;
}

/** Which hue the Engine mostly speaks in. */
function dominantHue(rows: readonly EngineRow[]): ArrangeHue {
  const counts: Record<ArrangeHue, number> = { thermal: 0, voltaic: 0, void: 0 };
  for (const row of rows) counts[row.hue]++;
  let best: ArrangeHue = 'thermal';
  for (const hue of ['voltaic', 'void'] as const) {
    if (counts[hue] > counts[best]) best = hue;
  }
  return best;
}

export function arrange(input: ArrangeInput): Arrangement {
  const bias = AXIOM_BIAS[input.axiomId] ?? AXIOM_BIAS.ignition!;
  const rows = input.rows;
  const signature =
    `${input.axiomId}|` +
    rows.map((r) => `${r.triggerId}:${r.primitive}:${r.hue}:${r.modifiers.join(',')}`).join(';');
  const seed = hash(signature);

  // Authored cells plus whatever the player has written. Read once, so a cell
  // added mid-audition cannot change the arrangement halfway through building it.
  const CELLS = pool();

  const hue = dominantHue(rows);
  const modifiers = rows.flatMap((r) => r.modifiers);
  const count = (id: string): number => modifiers.filter((m) => m === id).length;

  // The arrangement grows with the Engine, not with the clock. Two live rows is
  // a sketch; five is a track.
  const size = rows.length;
  const i = input.intensity;

  // ---- harmony ------------------------------------------------------------
  //
  // Read off what the Engine is *for*. A build that feeds on its own output
  // never resolves, so neither does its harmony; an economy build sits
  // suspended; a metronome build stays dark and modal.
  const hasCascade = rows.some((r) => CASCADE_TRIGGERS.has(r.triggerId));
  const hasConvert = rows.some(
    (r) => r.triggerId === 'on_convert' || r.primitive === 'convert',
  );
  const mood = hasConvert ? 'suspended' : hasCascade ? 'driving' : size >= 3 ? 'lifting' : 'dark';
  const harmony =
    CELLS.harmonies.filter((h) => h.mood === mood)[seed % Math.max(1, CELLS.harmonies.filter((h) => h.mood === mood).length)] ??
    CELLS.harmonies[0]!;
  const seventhAvailable = harmony.chords.some((c) => c.quality === 'min7');

  // ---- drums --------------------------------------------------------------
  //
  // Accelerate makes a row fire more often, so it makes the kick roll. That is
  // the most direct build-to-beat mapping in here and the easiest to hear.
  const feel: Feel = count('accelerate') > 0 ? 'rolling' : bias.feel;

  const kick = pick(CELLS.kicks, { energy: 1 + Math.min(4, size), feel, space: 'sparse' }, seed);
  const backbeat = pick(
    CELLS.backbeats,
    { energy: Math.max(1, Math.round(1 + i * 4)), feel },
    seed + 1,
  );
  const hats = pick(
    CELLS.hats,
    { energy: Math.max(1, Math.round(1 + i * 4)), feel, space: i > 0.6 ? 'busy' : 'mid' },
    seed + 2,
  );

  // ---- bass ---------------------------------------------------------------
  //
  // The lowest Action you own picks the bass voice, because that is the one
  // competing with it for the same octave. A Nova build gets a sub that stays
  // out of its way; an Arc build gets a 303 that answers it.
  const lowest = rows
    .map((r) => PRIMITIVE_REGISTER[r.primitive] ?? 1)
    .reduce((a, b) => Math.min(a, b), 2);
  const bassVoice: BassVoice = lowest === 0 ? 'sub' : hue === 'voltaic' ? 'acid' : 'pluck';

  // More rows means less room, so the bass gets sparser as the Engine fills up.
  // This is the single most important rule in the file: without it, a five-row
  // build and a busy bassline are competing for the same bar.
  const bassSpace: Space = size >= 4 ? 'sparse' : size >= 2 ? 'mid' : 'busy';
  const bass = pick(
    CELLS.basslines,
    {
      energy: Math.max(1, Math.round(1 + i * 3)),
      register: 'low',
      space: bassSpace,
      seventhAvailable,
    },
    seed + 3,
  );

  // ---- lead and stab ------------------------------------------------------
  const highest = rows
    .map((r) => PRIMITIVE_REGISTER[r.primitive] ?? 1)
    .reduce((a, b) => Math.max(a, b), 0);
  const hasOrbital = rows.some((r) => r.primitive === 'orbital');
  const leadVoice: LeadVoice = hasOrbital ? 'bell' : hue === 'voltaic' ? 'acid' : 'pluck';

  const motif = pick(
    CELLS.motifs,
    {
      energy: Math.max(1, Math.round(1 + i * 3)),
      register: highest === 2 ? 'high' : 'mid',
      space: size >= 4 ? 'sparse' : 'mid',
      seventhAvailable,
    },
    seed + 4,
  );

  const stab = pick(
    CELLS.stabs,
    { energy: Math.max(1, Math.min(4, size)), space: size >= 4 ? 'sparse' : 'mid' },
    seed + 5,
  );

  // ---- timbre -------------------------------------------------------------
  //
  // Every one of these is a modifier you can point at. Draft Echo and the room
  // opens up; draft Ground and the bass goes dark. Immediate, and legible.
  const echo = Math.min(0.85, count('echo') * 0.4 + count('ricochet') * 0.2);
  const brightness =
    1 + count('overdrive') * 0.35 + count('amplify') * 0.2 - count('ground') * 0.3;

  return {
    key: bias.key,
    harmony,
    kick,
    backbeat,
    hats,
    bass,
    motif,
    stab,
    swing: bias.swing,
    kickVoice: HUE_KICK[hue],
    percVoice: HUE_PERC[hue],
    bassVoice,
    stabVoice: HUE_STAB[hue],
    leadVoice,
    padWave: hue === 'voltaic' ? 'square' : 'sawtooth',
    bassQ: bassVoice === 'acid' ? 14 + count('overdrive') * 3 : 7,
    bassBrightness: Math.max(0.4, Math.min(1.9, brightness)),
    echo,
    drive: 0.6 + Math.min(1, size / 4) * 0.8,
    signature,
  };
}

/** The arrangement for an Engine that has not been built yet. */
export function openingArrangement(axiomId: string): Arrangement {
  return arrange({ axiomId, rows: [], intensity: 0 });
}
