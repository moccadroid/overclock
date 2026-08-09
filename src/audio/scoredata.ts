/**
 * Scores as data. GDD §18.
 *
 * A Score was code and only code: to keep one you had to write a TypeScript
 * module, and to change one you had to rebuild. That is fine for the authored
 * defaults and useless for everything else — you cannot save a mix you like,
 * hand one to somebody, diff two of them, or tune numbers without a compiler in
 * the loop.
 *
 * This file makes a Score a **document**. `cells.ts` already struck exactly this
 * deal for the vocabulary (JSON, validated, hand-editable, persisted); the rest
 * of the Score now gets the same one.
 *
 * ---
 *
 * **Numbers are data. Decisions stay code.** That is the whole design and it is
 * the reason this is a small file rather than a plugin system.
 *
 * Every value anybody has actually tuned — gains, filter corners, registers,
 * tempo, reverb, the song form, the cell library, every voice parameter — is a
 * number or a table, and all of it round-trips. What does not serialise is the
 * handful of *rules*: `chooseMood` is a judgement with a paragraph of reasoning
 * behind it, and "more rows means darker" cannot be written as JSON without
 * inventing a language to write it in.
 *
 * So a document names a Score it `extends`, inherits the rules from it, and
 * overrides the data. That is not a compromise bolted on afterwards — it is
 * exactly how every Score in `scores/` is already written (`...deep`, then the
 * changes), so the format matches the thing it is describing.
 *
 * **What you get:** save the Score you are hearing, reload it, hand it to
 * somebody, or hand-edit the JSON. **What you do not:** a genuinely new *rule*
 * still needs a line of TypeScript, and it should.
 */
import {
  emptyLibrary,
  GROUPS,
  validate,
  type CellLibrary,
} from './cells';
import type { Score } from './score';

/** Format version, so a document written today can be recognised later. */
export const SCORE_FORMAT = 1;

/**
 * A saved Score.
 *
 * Everything but `id`, `name` and `extends` is optional: a document carries only
 * what it *changes*, so it reads as a list of decisions rather than as a dump.
 */
export interface ScoreData {
  format: number;
  id: string;
  name: string;
  /** Which registered Score supplies the rules. */
  extends: string;
  cells?: Partial<Record<(typeof GROUPS)[number], unknown[]>>;
  tonality?: Record<string, unknown>;
  feel?: Record<string, unknown>;
  mix?: Record<string, unknown>;
  graph?: Record<string, unknown>;
  voices?: Record<string, unknown>;
  /**
   * Rules this Score does not inherit, as the id of the Score that owns them.
   *
   * `{ "bassVoice": "vault" }` means "take `feel.bassVoice` from the registered
   * Score `vault`". Rules are code — `chooseMood` is a judgement, not a table —
   * so a document *references* them rather than containing them.
   *
   * This exists because the first version of the format did not have it and
   * silently lost them: `vault` overrides `bassVoice` and `brightness`, JSON
   * dropped both, and the reloaded Score fell back to `deep`'s and played a
   * different bass. It round-tripped, it validated, and it was a different song.
   * A format that loses part of the music is worse than no format, so
   * `toScoreData` now refuses to write a rule it cannot name.
   */
  rules?: Record<string, string>;
}

/** Every `feel` field that holds behaviour rather than data. */
const RULE_FIELDS = [
  'chooseMood',
  'chooseFeel',
  'shiftSpace',
  'bassVoice',
  'leadVoice',
  'echo',
  'brightness',
  'bassQ',
  'drive',
] as const;

/** …and the same, one level down inside `ask`. */
const ASK_FIELDS = [
  'kickEnergy',
  'backbeatEnergy',
  'hatEnergy',
  'hatSpace',
  'bassEnergy',
  'motifEnergy',
  'motifRegister',
  'stabEnergy',
  'stabSpace',
  'space',
] as const;

type RuleKey = string;

function ruleValue(score: Score, key: RuleKey): unknown {
  return key.startsWith('ask.')
    ? (score.feel.ask as unknown as Plain)[key.slice(4)]
    : (score.feel as unknown as Plain)[key];
}

const ALL_RULES: readonly RuleKey[] = [
  ...RULE_FIELDS,
  ...ASK_FIELDS.map((f) => `ask.${f}`),
];

// ------------------------------------------------------------------ merging

type Plain = Record<string, unknown>;

const isPlain = (v: unknown): v is Plain =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Set);

/**
 * Deep-merge an override onto a base.
 *
 * Objects merge; **arrays and primitives replace**. That distinction is
 * load-bearing rather than a default: merging arrays would make it impossible to
 * shorten a song form or drop a cell, and half-merging one — a four-section form
 * laid over an eight-section one leaving the last four behind — is the kind of
 * bug that produces music nobody wrote.
 */
function merge<T>(base: T, over: unknown): T {
  if (over === undefined) return base;
  if (!isPlain(base) || !isPlain(over)) return over as T;
  const out: Plain = { ...base };
  for (const [key, value] of Object.entries(over)) {
    out[key] = merge((base as Plain)[key], value);
  }
  return out as T;
}

/**
 * Values a Score holds that JSON cannot.
 *
 * `cascadeTriggers` is a `Set` and everything in `feel` beginning `choose`, plus
 * the `ask` block, are functions. They are skipped on the way out and inherited
 * on the way in.
 */
function isSerialisable(value: unknown): boolean {
  return typeof value !== 'function';
}

function plainify(value: unknown): unknown {
  if (value instanceof Set) return [...value];
  if (Array.isArray(value)) return value.map(plainify);
  if (isPlain(value)) {
    const out: Plain = {};
    for (const [k, v] of Object.entries(value)) {
      if (isSerialisable(v)) out[k] = plainify(v);
    }
    return out;
  }
  return value;
}

/** Only what actually differs, so a document reads as a diff. */
function diff(base: unknown, next: unknown): unknown {
  if (!isPlain(base) || !isPlain(next)) {
    return JSON.stringify(plainify(base)) === JSON.stringify(plainify(next)) ? undefined : plainify(next);
  }
  const out: Plain = {};
  for (const [key, value] of Object.entries(next)) {
    if (!isSerialisable(value)) continue;
    const sub = diff((base as Plain)[key], value);
    if (sub !== undefined) out[key] = sub;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

// ------------------------------------------------------------- serialisation

/**
 * Capture a Score as a document, against the Score it extends.
 *
 * The cell library is compared whole and written whole when it differs: cells
 * are content rather than settings, and a half-described library is not a
 * library.
 */
export function toScoreData(
  score: Score,
  base: Score,
  /**
   * Every registered Score, so a rule the base does not supply can be traced to
   * whichever Score owns it. Without this the only honest thing to do with an
   * unnameable rule is refuse, and refusing to save `vault` would make the whole
   * format useless for the one Score anybody has kept.
   */
  owners: Readonly<Record<string, Score>> = { [base.id]: base },
  extendsId = base.id,
): ScoreData {
  const data: ScoreData = {
    format: SCORE_FORMAT,
    id: score.id,
    name: score.name,
    extends: extendsId,
  };

  const rules: Record<string, string> = {};
  for (const key of ALL_RULES) {
    const mine = ruleValue(score, key);
    if (mine === ruleValue(base, key)) continue;
    const owner = Object.entries(owners).find(([, s]) => ruleValue(s, key) === mine);
    if (!owner) {
      throw new Error(
        `score "${score.id}": rule "${key}" is not owned by any registered Score, so it cannot be saved. ` +
          `Rules are code — register the Score that defines it, or inherit the rule.`,
      );
    }
    rules[key] = owner[0];
  }
  if (Object.keys(rules).length > 0) data.rules = rules;

  const cellsDiffer = GROUPS.some(
    (g) => JSON.stringify(score.cells[g]) !== JSON.stringify(base.cells[g]),
  );
  if (cellsDiffer) {
    data.cells = {};
    for (const g of GROUPS) data.cells[g] = score.cells[g] as unknown[];
  }

  for (const key of ['tonality', 'feel', 'mix', 'graph', 'voices'] as const) {
    const d = diff(base[key], score[key]);
    if (d !== undefined) data[key] = d as Record<string, unknown>;
  }
  return data;
}

/**
 * Rebuild a Score from a document.
 *
 * `resolve` looks up the base by id — passed in rather than imported so this
 * file does not have to depend on the registry, which depends on the Scores,
 * which would close a cycle.
 */
export function fromScoreData(data: ScoreData, resolve: (id: string) => Score | undefined): Score {
  const base = resolve(data.extends);
  if (!base) {
    throw new Error(`score "${data.id}": extends "${data.extends}", which is not registered`);
  }

  const cells: CellLibrary = data.cells
    ? (Object.fromEntries(
        GROUPS.map((g) => [g, (data.cells![g] ?? []) as never]),
      ) as unknown as CellLibrary)
    : base.cells;

  // Tables merge; rules are then pulled wholesale from whichever Score owns them.
  const feel = merge(base.feel, data.feel) as unknown as Plain;
  for (const [key, ownerId] of Object.entries(data.rules ?? {})) {
    const owner = resolve(ownerId);
    if (!owner) {
      throw new Error(`score "${data.id}": rule "${key}" comes from "${ownerId}", which is not registered`);
    }
    const value = ruleValue(owner, key);
    if (typeof value !== 'function') {
      throw new Error(`score "${data.id}": rule "${key}" is not a rule on "${ownerId}"`);
    }
    if (key.startsWith('ask.')) {
      feel.ask = { ...(feel.ask as Plain), [key.slice(4)]: value };
    } else {
      feel[key] = value;
    }
  }

  const score: Score = {
    ...base,
    id: data.id,
    name: data.name,
    cells,
    tonality: merge(base.tonality, data.tonality),
    feel: feel as unknown as Score['feel'],
    mix: merge(base.mix, data.mix),
    graph: merge(base.graph, data.graph),
    voices: merge(base.voices, data.voices),
  };

  validate(score.cells, score.tonality.chords);
  return score;
}

// ------------------------------------------------------------------ parsing

/**
 * Parse a document out of arbitrary text, or explain why it will not.
 *
 * Defensive throughout, for the reason `cellstore.ts` gives: this is a blob a
 * player is *invited* to hand-edit, and a bad one must cost them that document
 * and nothing else.
 */
export function parseScoreData(text: string): { data: ScoreData } | { error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { error: `not JSON — ${(err as Error).message}` };
  }
  if (!isPlain(raw)) return { error: 'expected an object' };

  const format = raw.format;
  if (typeof format !== 'number') return { error: 'missing "format"' };
  if (format > SCORE_FORMAT) {
    return { error: `format ${format} is newer than this build understands (${SCORE_FORMAT})` };
  }
  for (const key of ['id', 'name', 'extends'] as const) {
    if (typeof raw[key] !== 'string' || (raw[key] as string).length === 0) {
      return { error: `"${key}" must be a non-empty string` };
    }
  }
  if (raw.cells !== undefined) {
    if (!isPlain(raw.cells)) return { error: '"cells" must be an object of cell groups' };
    for (const g of GROUPS) {
      const list = (raw.cells as Plain)[g];
      if (list !== undefined && !Array.isArray(list)) {
        return { error: `"cells.${g}" must be an array` };
      }
    }
    // Musically checked by `validate` once the chord table is known.
    const library = emptyLibrary();
    for (const g of GROUPS) {
      const list = ((raw.cells as Plain)[g] ?? []) as unknown[];
      (library[g] as unknown[]).push(...list);
    }
  }
  for (const key of ['tonality', 'feel', 'mix', 'graph', 'voices'] as const) {
    if (raw[key] !== undefined && !isPlain(raw[key])) {
      return { error: `"${key}" must be an object` };
    }
  }
  return { data: raw as unknown as ScoreData };
}

/** A document as text, stable and readable so it diffs and hand-edits well. */
export function stringifyScoreData(data: ScoreData): string {
  return `${JSON.stringify(data, null, 2)}\n`;
}
