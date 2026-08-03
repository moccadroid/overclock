/**
 * Why the arranger chose what it chose.
 *
 * `arrange.ts` is held to one rule: **a player must be able to learn to hear
 * it.** That rule has been asserted in tests and hoped for everywhere else. This
 * file makes it checkable by a human — hand it an Engine and the arrangement it
 * produced, and it names the decision behind every slot.
 *
 * Deliberately a *separate* file that reads the input and the output rather than
 * a `reasons` field on `Arrangement`. The arranger does not need to know it is
 * being watched, and a run should not allocate a paragraph of English every time
 * a Program is recompiled.
 *
 * The consequence is that this file restates knowledge `arrange.ts` owns, and
 * can therefore drift from it. That is a real cost, accepted for a real reason:
 * the alternative is a debug concern reaching into the thing being debugged. The
 * test at the bottom of `audio.test.ts` pins the pairs that matter.
 */
import type { ArrangeInput, Arrangement } from './arrange';

export interface Reason {
  /** Which slot of the arrangement. */
  slot: string;
  /** What landed there. */
  value: string;
  /** The Engine fact that put it there, in the player's vocabulary. */
  why: string;
}

const CASCADE = new Set(['on_hit', 'on_kill', 'on_crit']);

function countOf(input: ArrangeInput, id: string): number {
  return input.rows.flatMap((r) => r.modifiers).filter((m) => m === id).length;
}

function dominant(input: ArrangeInput): string {
  const counts: Record<string, number> = { thermal: 0, voltaic: 0, void: 0 };
  for (const row of input.rows) counts[row.hue] = (counts[row.hue] ?? 0) + 1;
  let best = 'thermal';
  for (const hue of ['voltaic', 'void']) {
    if ((counts[hue] ?? 0) > (counts[best] ?? 0)) best = hue;
  }
  return best;
}

export function explain(input: ArrangeInput, plan: Arrangement): Reason[] {
  const size = input.rows.length;
  const hue = dominant(input);
  const rows = input.rows;
  const out: Reason[] = [];

  const hasConvert = rows.some((r) => r.triggerId === 'on_convert' || r.primitive === 'convert');
  const hasCascade = rows.some((r) => CASCADE.has(r.triggerId));
  out.push({
    slot: 'harmony',
    value: `${plan.harmony.id} · ${plan.harmony.mood}`,
    why: hasConvert
      ? 'you spend to fire, so the harmony never settles'
      : hasCascade
        ? 'your Engine feeds on its own output, so it never resolves'
        : size >= 3
          ? 'three rows and nothing loops — it climbs'
          : 'a metronome build stays dark and modal',
  });

  out.push({
    slot: 'key',
    value: `${plan.key >= 0 ? '+' : ''}${plan.key} from A`,
    why: `the ${input.axiomId} Axiom — the only thing it still decides outright`,
  });

  const accelerate = countOf(input, 'accelerate');
  out.push({
    slot: 'kick',
    value: `${plan.kick.id} · ${plan.kickVoice}`,
    why:
      (accelerate > 0 ? 'Accelerate makes the kick roll; ' : '') +
      `${size} live ${size === 1 ? 'row' : 'rows'} sets its weight, ${hue} picks the drum`,
  });

  out.push({
    slot: 'backbeat',
    value: `${plan.backbeat.id} · ${plan.percVoice}`,
    why: `${hue} — thermal claps, voltaic snares, void ticks a rim`,
  });

  out.push({
    slot: 'hats',
    value: plan.hats.id,
    why: 'how hard the run is going right now, not what you built',
  });

  // `pick()` scores rather than filters, so what the Engine *asked* for and what
  // the pool could *supply* are two different things. Saying only the first is
  // how a reason column becomes a liar — and the gap is the most useful thing on
  // this screen, because it means the library is missing a cell.
  const wantSpace = size >= 4 ? 'sparse' : size >= 2 ? 'mid' : 'busy';
  const bassAsked =
    size >= 4
      ? 'four rows leave it no room, so it asks for almost nothing'
      : size >= 2
        ? 'two rows, so it asks to keep out of their way'
        : 'one row, so the bass gets the bar';
  out.push({
    slot: 'bass',
    value: `${plan.bass.id} · ${plan.bassVoice} · ${plan.bass.space}`,
    why:
      `${plan.bassVoice === 'sub' ? 'your lowest Action already owns that octave, so it stays under it; ' : ''}` +
      bassAsked +
      (plan.bass.space === wantSpace
        ? ''
        : ` — no ${wantSpace} line fit, so the pool's closest was ${plan.bass.space}`),
  });

  const wantMotif = size >= 4 ? 'sparse' : 'mid';
  out.push({
    slot: 'motif',
    value: `${plan.motif.id} · ${plan.leadVoice} · ${plan.motif.space}`,
    why:
      (rows.some((r) => r.primitive === 'orbital')
        ? 'an Orbital circles, so the lead is a bell'
        : 'the highest Action you own sets its register') +
      (plan.motif.space === wantMotif
        ? ''
        : ` — asked ${wantMotif}, the pool's closest was ${plan.motif.space}`),
  });

  out.push({
    slot: 'stab',
    value: `${plan.stab.id} · ${plan.stabVoice}`,
    why: `${hue}, and it thins out as the Engine fills`,
  });

  const echo = countOf(input, 'echo');
  const ricochet = countOf(input, 'ricochet');
  out.push({
    slot: 'echo',
    value: plan.echo.toFixed(2),
    why:
      echo + ricochet === 0
        ? 'no Echo and no Ricochet — the room is dry'
        : `${echo} Echo, ${ricochet} Ricochet — things that come back get a delay`,
  });

  const overdrive = countOf(input, 'overdrive');
  const amplify = countOf(input, 'amplify');
  const ground = countOf(input, 'ground');
  out.push({
    slot: 'bass tone',
    value: `Q ${plan.bassQ} · brightness ${plan.bassBrightness.toFixed(2)}`,
    why:
      overdrive + amplify + ground === 0
        ? 'nothing sharpening or dampening it yet'
        : [
            overdrive ? `${overdrive} Overdrive opens it` : '',
            amplify ? `${amplify} Amplify pushes it` : '',
            ground ? `${ground} Ground darkens it` : '',
          ]
            .filter(Boolean)
            .join(', '),
  });

  out.push({
    slot: 'swing',
    value: plan.swing.toFixed(2),
    why: `the ${input.axiomId} Axiom`,
  });

  return out;
}
