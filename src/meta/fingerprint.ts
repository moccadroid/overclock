/**
 * Which game a run was played against.
 *
 * `analytics.ts` segments the corpus on this, and its reason is worth restating
 * because it is the whole justification for the file: *averaging a metric across
 * a balance change is a confident way to prove the balance change did nothing.*
 * Two runs can be the same build and different games.
 *
 * ---
 *
 * **Why this is not `hashTunables()` any more.**
 *
 * That function digests `TUNABLE` and nothing else, and it was right when
 * `tunables.ts` *was* the balance surface. It is not, and increasingly is not by
 * design: the draft pool, the progression graph, the wave table, the wave
 * events, the enemies and every node are declarative data now, and a change to
 * any of them changes the game while leaving that hash untouched.
 *
 * Measured, not theorised: the fix that stopped a Cache fielding suppression
 * edits `waveevents.json`, alters what every Cache in the game does, and does
 * not move `tun` by a single bit. Runs from before and after would have pooled
 * into one population under a heading that exists to stop exactly that.
 *
 * So the fingerprint covers every surface, and reports them **separately as well
 * as together**. `all` is what to group by; `parts` is what says *which* thing
 * moved, which is the difference between "these two populations differ" and "the
 * draft pool changed and nothing else did".
 *
 * **Profiles are named, not hashed.** `draftpool.json` holds three policies and
 * only one is live; the file's digest is identical whichever it is. The hash
 * answers "did the data change", the id answers "which of it was in force", and
 * neither substitutes for the other.
 *
 * **Additive.** A new field, beside `tun` rather than replacing it, so the
 * schema rule holds: additive changes do not bump `TELEMETRY_VERSION`, and every
 * document already in the corpus stays readable. Analysis prefers `cfg` and
 * falls back — an absent field means "not measured", never zero.
 */
import {
  ACTIONS,
  ARENAS,
  AXIOMS,
  DISCOVERIES,
  DRAFT_POOL,
  DRAFT_POOLS,
  ENEMIES,
  MODIFIERS,
  TRIGGERS,
  WAVES,
  WAVE_EVENTS,
} from '../content/index';
import { LOADBEARING, TUNABLE } from '../sim/tunables';
import { ACTIVE, PROGRESSIONS } from './progression';

/** FNV-1a over a string. Short, stable, and not a security boundary. */
function digest(json: string): string {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < json.length; i++) {
    h = Math.imul(h ^ json.charCodeAt(i), 16777619) >>> 0;
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * Every balance surface, in a fixed order.
 *
 * Ordered explicitly rather than by `Object.keys`, because the combined hash is
 * built from these in sequence and a reordering would invalidate the whole
 * corpus for no reason anybody could see.
 */
const SURFACES: readonly (readonly [string, () => unknown])[] = [
  // Two tables, not one: crossing a LOADBEARING number is a design conversation
  // (§0) and crossing a TUNABLE one is a Tuesday. A corpus that cannot tell them
  // apart cannot tell you which kind of change you are looking at.
  ['tunables', () => TUNABLE],
  ['loadbearing', () => LOADBEARING],
  ['draftpool', () => DRAFT_POOLS],
  ['progression', () => PROGRESSIONS],
  ['triggers', () => TRIGGERS],
  ['actions', () => ACTIONS],
  ['modifiers', () => MODIFIERS],
  ['enemies', () => ENEMIES],
  ['waves', () => WAVES],
  ['waveevents', () => WAVE_EVENTS],
  ['axioms', () => AXIOMS],
  ['arenas', () => ARENAS],
  // Not obviously balance, and it is: a Discovery carries a `score`, and which
  // ones exist decides what a progression graph is able to gate behind them.
  ['discoveries', () => DISCOVERIES],
];

/**
 * The surfaces, by name. Exported so a test can check the list against the data
 * directory rather than against somebody's memory — a balance file that exists
 * and is not fingerprinted is worse than no fingerprint, because the corpus then
 * reports two different games as one and says nothing about it.
 */
export const SURFACE_NAMES: readonly string[] = SURFACES.map(([name]) => name);

export interface Fingerprint {
  /** One digest over every surface. The thing to group a corpus by. */
  all: string;
  /** Per surface, so a difference can say which file moved. */
  parts: Record<string, string>;
  /** Which profile was live where the data holds several. Not hashable. */
  profiles: Record<string, string>;
}

/**
 * Computed once per run, at the boundary, from the live tables.
 *
 * Walking the tables rather than reading the files: a digest of what the code
 * actually loaded cannot disagree with what the code actually loaded, and a
 * digest of a file on disk can.
 */
export function fingerprint(): Fingerprint {
  const parts: Record<string, string> = {};
  for (const [name, read] of SURFACES) {
    parts[name] = digest(JSON.stringify(read()));
  }
  return {
    all: digest(SURFACES.map(([name]) => `${name}:${parts[name]}`).join('|')),
    parts,
    profiles: {
      draftPool: DRAFT_POOL.id,
      progression: ACTIVE.id,
    },
  };
}
