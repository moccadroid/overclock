/**
 * Saved Scores, persisted.
 *
 * Its own storage key, and the same deal `cellstore.ts` strikes for cells: this
 * is a blob a player is invited to hand-edit, so everything here is defensive
 * and a bad document costs you that document and nothing else.
 *
 * A saved Score is data laid over a registered one — see `scoredata.ts` for why
 * the rules stay in code. So the base has to exist at load time, which means a
 * document written against a Score that later disappears is refused rather than
 * half-applied.
 */
import {
  fromScoreData,
  parseScoreData,
  stringifyScoreData,
  type ScoreData,
} from '../audio/scoredata';
import { registerScores, SCORES, type Score } from '../audio/score';

const STORAGE_KEY = 'overclock.scores.v1';

export function loadScoreDocuments(): ScoreData[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const list: unknown = JSON.parse(raw);
    if (!Array.isArray(list)) return [];
    const out: ScoreData[] = [];
    for (const entry of list) {
      const result = parseScoreData(JSON.stringify(entry));
      // A document that no longer parses is dropped rather than repaired. It got
      // here by being valid once, so this means a hand edit or a format change,
      // and keeping half of it is worse than keeping none.
      if ('data' in result) out.push(result.data);
    }
    return out;
  } catch {
    return [];
  }
}

export function saveScoreDocuments(documents: readonly ScoreData[]): void {
  try {
    if (documents.length === 0) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, JSON.stringify(documents));
  } catch {
    // Private browsing, quota, disabled storage. They still work this session.
  }
}

/**
 * Turn saved documents into Scores and hand them to the registry.
 *
 * Called once at boot, before anything asks for a Score by id. A document whose
 * base is missing, or whose cells do not validate, is skipped with a warning —
 * one bad save must not cost you the others, and must never cost you silence.
 */
export function installUserScores(): Score[] {
  const built: Score[] = [];
  for (const data of loadScoreDocuments()) {
    try {
      built.push(fromScoreData(data, (id) => SCORES[id]));
    } catch (err) {
      console.warn(`[audio] saved score "${data.id}" skipped — ${(err as Error).message}`);
    }
  }
  if (built.length > 0) registerScores(built);
  return built;
}

/** Add or replace a saved document, keeping the rest. */
export function upsertScoreDocument(data: ScoreData): ScoreData[] {
  const documents = loadScoreDocuments().filter((d) => d.id !== data.id);
  documents.push(data);
  saveScoreDocuments(documents);
  return documents;
}

export function removeScoreDocument(id: string): ScoreData[] {
  const documents = loadScoreDocuments().filter((d) => d.id !== id);
  saveScoreDocuments(documents);
  return documents;
}

export { stringifyScoreData, parseScoreData, type ScoreData };
