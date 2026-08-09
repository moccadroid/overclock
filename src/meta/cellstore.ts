/**
 * Player-written cells, persisted.
 *
 * Its own storage key rather than a field on the Library, for a specific reason:
 * §15.1's guard scans `LibraryData` for numbers that could become multipliers,
 * and a cell carries three of them (`energy`, `barsPerChord`, `root`). Putting
 * them there would either trip that guard or force it to be loosened, and the
 * guard is worth more than the tidiness. These are not progression — they are
 * content, like a saved seed.
 *
 * Everything here is defensive. This blob is the one thing in the game a player
 * is *invited* to hand-edit, and a bad one must cost you your cells and nothing
 * else.
 */
import {
  emptyLibrary,
  GROUPS,
  setUserCells,
  validate,
  type CellGroup,
  type CellLibrary,
} from '../audio/cells';

const STORAGE_KEY = 'overclock.cells.v1';

/** Parse a library out of arbitrary JSON text, or explain why it will not. */
export function parseLibrary(text: string): { library: CellLibrary } | { error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { error: `not JSON — ${(err as Error).message}` };
  }
  if (!raw || typeof raw !== 'object') return { error: 'expected an object of cell groups' };

  const source = raw as Record<string, unknown>;
  const library = emptyLibrary();
  const seen = new Set<string>();

  for (const group of GROUPS) {
    const list = source[group];
    if (list === undefined) continue;
    if (!Array.isArray(list)) return { error: `"${group}" must be an array` };
    for (const cell of list) {
      if (!cell || typeof cell !== 'object') return { error: `"${group}" holds a non-object` };
      const id = (cell as { id?: unknown }).id;
      if (typeof id !== 'string' || id.length === 0) {
        return { error: `every cell needs an id (in "${group}")` };
      }
      if (seen.has(id)) return { error: `two cells share the id "${id}"` };
      seen.add(id);
      // Structurally checked above, musically checked by validate() below.
      (library[group] as unknown[]).push(cell);
    }
  }

  try {
    validate(library);
  } catch (err) {
    return { error: (err as Error).message };
  }
  return { library };
}

export function countCells(library: CellLibrary): number {
  return GROUPS.reduce((n, group) => n + library[group].length, 0);
}

const SINGULAR: Record<CellGroup, string> = {
  kicks: 'kick',
  backbeats: 'backbeat',
  hats: 'hat',
  basslines: 'bassline',
  motifs: 'motif',
  stabs: 'stab',
  harmonies: 'harmony',
};

/** Groups that actually hold something, for a one-line summary. */
export function summarise(library: CellLibrary): string {
  const parts = GROUPS.filter((g) => library[g].length > 0).map((g) => {
    const n = library[g].length;
    return `${n} ${n === 1 ? SINGULAR[g] : g}`;
  });
  return parts.length === 0 ? 'nothing yet' : parts.join(' · ');
}

export function loadUserCells(): CellLibrary {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return emptyLibrary();
    const result = parseLibrary(raw);
    // A library that no longer validates is dropped rather than repaired. It
    // only got here by being valid once, so this means a hand edit or a schema
    // change, and silently keeping half of it is worse than keeping none.
    return 'library' in result ? result.library : emptyLibrary();
  } catch {
    return emptyLibrary();
  }
}

export function saveUserCells(library: CellLibrary): void {
  try {
    if (countCells(library) === 0) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, JSON.stringify(library));
  } catch {
    // Private browsing, quota, disabled storage. The cells still work this session.
  }
}

/**
 * Load from storage and hand to the arranger. Called once at boot.
 *
 * `chords` is the active Score's chord table. Without it a hand-written harmony
 * naming a shape the Score does not define would be accepted here and then fall
 * back at play time — silently, and only in the bars that harmony covers.
 */
export function installUserCells(
  chords?: Readonly<Record<string, readonly number[]>>,
): CellLibrary {
  const library = loadUserCells();
  setUserCells(countCells(library) > 0 ? library : null, chords);
  return library;
}

export type { CellGroup, CellLibrary };
