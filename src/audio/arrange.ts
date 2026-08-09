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
  type Mood,
  type PercCell,
  type Space,
  type StabCell,
} from './cells';
import type { Groove } from './grooves';
import type { FeelTuning, Score } from './score';
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
  /**
   * Which pass through the material this is. Bumped on a timer by the audio
   * layer; every increment reselects the *melodic* cells and leaves the kit,
   * the key and the groove alone.
   *
   * It exists because of an eleven-minute run where the Engine stopped changing
   * at 8:18 and so did the music. An arrangement keyed only to the build stops
   * developing the moment the build is finished — which is exactly when the
   * player has attention spare to listen to it. Techno repeats; it does not
   * repeat *forever*. It swaps the line every so many bars and keeps the kit.
   */
  variation?: number;
  /**
   * The melodic cells currently playing, so a variation pass can move off them.
   * Handed over by the audio layer from the plan it is already running.
   */
  avoid?: { motif?: string; bass?: string; stab?: string; hats?: string };
  /**
   * §13.2 — 0 during the build, above 0 once Meltdown has begun.
   *
   * Until this existed the phase reached the audio layer and moved exactly one
   * number: the tempo, by twelve BPM. Act three sounded like act two in a hurry.
   * It clamps the harmony to the dark cells; the layer stripping that goes with
   * it lives in audio.ts, because what is *playing* is a per-bar decision and
   * this file only chooses the material.
   */
  meltdown?: number;
  /**
   * The drums, overriding whatever the Score brought. `undefined` keeps them.
   *
   * A separate axis because it *is* one: eight Scores had barely moved the beat,
   * since a Score that spreads another inherits every cell it does not replace.
   * Rhythm and sound are two questions and this is the second dial.
   */
  groove?: Groove | null;
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

// The tables that used to live here — the Axiom bias, the three hue-to-voice
// maps, the primitive registers and the cascade triggers — are now
// `score.feel`. See score.ts: they were the taste in this file, and taste is the
// thing a Score exists to hold. What is left is mechanism.

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
  weights: FeelTuning['weights'],
  candidates: readonly T[],
  want: Want,
  seed: number,
  /**
   * Cell ids this pass should move away from, and how hard.
   *
   * Nine motifs in the library and a run that heard two of them: the jitter
   * below is deliberately too small to overrule a real preference, which also
   * makes it too small to ever pick anything else. Rather than raise it — and
   * start getting cells that do not fit the build — a variation pass says which
   * cell it just used, and that one takes a penalty big enough to lose a tie it
   * would otherwise always win. Preference still beats novelty; novelty only
   * breaks ties.
   */
  avoid?: string,
): T {
  const scored: { cell: T; score: number }[] = [];
  let bestScore = -Infinity;

  for (const cell of candidates) {
    const c = cell as T & { feel?: Feel; space?: Space; register?: string; needsSeventh?: boolean };
    if (c.needsSeventh && want.seventhAvailable === false) continue;

    let score = -Math.abs(cell.energy - want.energy) * weights.energy;
    if (want.feel && c.feel === want.feel) score += weights.feel;
    if (want.space && c.space === want.space) score += weights.space;
    if (want.register && c.register === want.register) score += weights.register;
    if (avoid && cell.id === avoid) score -= weights.avoid;
    // A deterministic jitter, small enough never to beat a real preference but
    // large enough that two equally good cells do not always resolve the same
    // way for every build in the game.
    score += (hash(cell.id + seed) % 100) / weights.jitterScale;

    scored.push({ cell, score });
    if (score > bestScore) bestScore = score;
  }
  if (scored.length === 0) return candidates[0]!;

  /**
   * Everything close enough to the winner, not just the winner.
   *
   * This used to be a plain argmax, and that is why a library of twelve motifs
   * only ever produced three. The scorer is *decisive* — a cell one step off the
   * wanted energy loses two points and the jitter tops out below one, so for a
   * fixed build the answer is fixed, and no amount of authoring more cells
   * changes it. Measured: one build heard 3 of 12 motifs over seventeen minutes,
   * and 1 of 9 kicks.
   *
   * `spread` says how much worse than the best a cell may be and still be
   * *plausible*. Everything inside that band goes on a shortlist and the seed —
   * which moves with the variation counter — decides between them. So preference
   * still rules (nothing outside the band is ever reachable), the choice is still
   * deterministic for a given build and pass, and the library actually gets used.
   *
   * `spread: 0` reduces to the old argmax exactly, because the per-cell jitter
   * makes true ties vanishingly unlikely. That is what `current` sets, and it is
   * why nothing about it moved.
   */
  const band = scored.filter((s) => s.score >= bestScore - weights.spread);
  if (band.length === 1) return band[0]!.cell;
  return band[hash(`pick:${seed}:${band.length}`) % band.length]!.cell;
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

export function arrange(input: ArrangeInput, score: Score): Arrangement {
  const T = score.feel;
  const bias = T.axiomBias[input.axiomId] ?? T.axiomBias[T.defaultAxiom]!;
  const rows = input.rows;
  // The variation counter is part of the signature: `setEngine` refuses a plan
  // whose signature it already has, so a pass that changed nothing but the
  // melodic seeds would be silently dropped.
  const vary = input.variation ?? 0;

  /**
   * The build, as a string. This is what the selection seed is derived from, and
   * it deliberately says nothing about the Score.
   *
   * Two strings rather than one, and the reason is worth writing down because the
   * first attempt got it wrong and the schedule golden caught it. The *signature*
   * is a dedupe key — "is this the same thing that is already playing" — so it has
   * to include the Score, or switching Score on an unchanged build produces a
   * matching fingerprint and the switch is silently dropped. The *seed* is a
   * deterministic tie-break — "same build, same arrangement" — and mixing the
   * Score into that would reshuffle which cell a build gets for no reason, which
   * is exactly what happened: one prepended field moved a Meltdown harmony from
   * `lament` to `drone` and transposed the whole bar by five semitones.
   */
  const build =
    `${input.axiomId}|v${vary}|${input.meltdown ? 'm' : ''}` +
    rows.map((r) => `${r.triggerId}:${r.primitive}:${r.hue}:${r.modifiers.join(',')}`).join(';');
  // The Groove joins the *signature* and not the `build` above, for exactly the
  // reason the Score id does: `build` feeds `hash()`, so mixing a groove into it
  // would reshuffle the melodic selection as well and changing the drums would
  // silently change the tune.
  const groove = input.groove ?? null;
  const signature = `${score.id}|${groove ? `${groove.id}|` : ''}${build}`;
  const seed = hash(build);
  // The drums keep the *build's* seed, so the kit and the groove are stable for
  // as long as the Engine is. Everything melodic moves with the variation.
  // The drums keep the *build's* seed, so the kit is stable for as long as the
  // Engine is — unless the Score asks otherwise, in which case the variation
  // counter folds in and the beat develops with everything else. One kick
  // pattern for a whole run is stability; it is also monotony, and which of the
  // two it reads as is a taste call rather than a law.
  const kitSeed = hash(
    `${input.axiomId}|${T.kitVaries ? `v${vary}|` : ''}` +
      rows.map((r) => `${r.triggerId}:${r.primitive}:${r.hue}`).join(';'),
  );

  // The Score's cells plus whatever the player has written. Read once, so a cell
  // added mid-audition cannot change the arrangement halfway through building it.
  const CELLS = pool(score.cells);

  const hue = dominantHue(rows);
  const modifiers = rows.flatMap((r) => r.modifiers);
  const count = (id: string): number => modifiers.filter((m) => m === id).length;

  // The arrangement grows with the Engine, not with the clock. Two live rows is
  // a sketch; five is a track.
  const size = rows.length;
  const i = input.intensity;

  // What a *section* is, on top of what the build is.
  //
  // Reselecting cells with a different seed was not enough on its own: the
  // energy and space the build asks for narrow the field so hard that only two
  // motifs in a library of nine were ever plausible, and the pass alternated
  // between them. So a variation also moves the ask — one section runs a little
  // denser, the next a little sparser. That is what a section *is* in this
  // genre, and it opens the library without ever asking for a cell that does
  // not fit the Engine.
  const lift = T.lift[vary % T.lift.length] ?? 0;
  const shiftSpace = (base: Space): Space => T.shiftSpace(base, lift);

  // ---- harmony ------------------------------------------------------------
  //
  // What the Engine is *for* — the Score decides how that reads. See
  // `feel.chooseMood`.
  const hasCascade = rows.some((r) => T.cascadeTriggers.has(r.triggerId));
  const hasConvert = rows.some(
    (r) => r.triggerId === 'on_convert' || r.primitive === 'convert',
  );
  const mood: Mood = T.chooseMood({
    size,
    meltdown: input.meltdown ?? 0,
    hasCascade,
    hasConvert,
  });
  const inMood = CELLS.harmonies.filter((h) => h.mood === mood);
  const harmony = inMood[(seed + vary * 3) % Math.max(1, inMood.length)] ?? CELLS.harmonies[0]!;
  // Whether any chord in the progression has a fourth tone to reach for.
  //
  // Was `quality === 'min7'`, which is the same answer for every Score that only
  // defines the four original shapes and the wrong one for any Score that adds a
  // ninth or a sixth. The rule was always "is there a tone at that index", so it
  // now asks that.
  const seventhAvailable = harmony.chords.some(
    (c) => (score.tonality.chords[c.quality]?.length ?? 0) > 3,
  );

  // ---- drums --------------------------------------------------------------
  const feel: Feel = T.chooseFeel(count, groove ? groove.feel : bias.feel);

  const kick = pick(
    T.weights,
    groove ? groove.kicks : CELLS.kicks,
    { energy: T.ask.kickEnergy(size), feel, space: 'sparse' },
    kitSeed,
  );
  const backbeat = pick(
    T.weights,
    groove ? groove.backbeats : CELLS.backbeats,
    { energy: T.ask.backbeatEnergy(i), feel },
    kitSeed + 1,
  );
  const hats = pick(
    T.weights,
    groove ? groove.hats : CELLS.hats,
    { energy: T.ask.hatEnergy(i, lift), feel, space: shiftSpace(T.ask.hatSpace(i)) },
    seed + 2,
    input.avoid?.hats,
  );

  // ---- bass ---------------------------------------------------------------
  const lowest = rows
    .map((r) => T.primitiveRegister[r.primitive] ?? 1)
    .reduce((a, b) => Math.min(a, b), 2);
  const highest = rows
    .map((r) => T.primitiveRegister[r.primitive] ?? 1)
    .reduce((a, b) => Math.max(a, b), 0);
  const hasOrbital = rows.some((r) => r.primitive === 'orbital');
  const registers = { hue, lowest, highest, hasOrbital };

  const bassVoice: BassVoice = T.bassVoice(registers);

  const bass = pick(
    T.weights,
    CELLS.basslines,
    {
      energy: T.ask.bassEnergy(i, lift),
      register: 'low',
      space: shiftSpace(T.ask.space(size)),
      seventhAvailable,
    },
    seed + 3,
    input.avoid?.bass,
  );

  // ---- lead and stab ------------------------------------------------------
  const leadVoice: LeadVoice = T.leadVoice(registers);

  const motif = pick(
    T.weights,
    CELLS.motifs,
    {
      energy: T.ask.motifEnergy(i, lift),
      register: T.ask.motifRegister(highest),
      // Same ladder the bass uses, for the same reason — and because asking only
      // ever for sparse or mid made every busy motif in the library unreachable.
      // A one-row Engine has room for a two-bar line; a five-row one does not.
      space: shiftSpace(T.ask.space(size)),
      seventhAvailable,
    },
    seed + 4,
    input.avoid?.motif,
  );

  const stab = pick(
    T.weights,
    CELLS.stabs,
    { energy: T.ask.stabEnergy(size, lift), space: shiftSpace(T.ask.stabSpace(size)) },
    seed + 5,
    input.avoid?.stab,
  );

  return {
    key: bias.key,
    harmony,
    kick,
    backbeat,
    hats,
    bass,
    motif,
    stab,
    swing: groove ? groove.swing : bias.swing,
    kickVoice: T.hueKick[hue],
    percVoice: size === 0 ? T.emptyPercVoice : T.huePerc[hue],
    bassVoice,
    stabVoice: T.hueStab[hue],
    leadVoice,
    padWave: T.huePadWave[hue],
    bassQ: T.bassQ(bassVoice, count),
    bassBrightness: T.brightness(count),
    echo: T.echo(count),
    drive: T.drive(size),
    signature,
  };
}

/** The arrangement for an Engine that has not been built yet. */
export function openingArrangement(axiomId: string, score: Score): Arrangement {
  return arrange({ axiomId, rows: [], intensity: 0 }, score);
}
