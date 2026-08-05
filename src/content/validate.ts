/**
 * Content validation.
 *
 * GDD §0: "all game content must be expressible as declarative, validated data
 * artifacts executed by a deterministic runtime." This module is the "validated"
 * half — a small schema description language with cross-reference checking, so a
 * typo in waves.json fails loudly at load instead of producing a silent no-op
 * wave three minutes into a run.
 */

export type FieldType = 'string' | 'number' | 'boolean' | 'object' | 'array';

export interface FieldSpec {
  type: FieldType;
  required?: boolean;
  /** Value must be one of these. */
  oneOf?: readonly string[];
  min?: number;
  max?: number;
  /** Value (or, for arrays, each entry) must be an id in this registry. */
  ref?: string;
  /** For arrays: spec applied to each element. */
  items?: FieldSpec;
  /** For objects: nested field specs. */
  fields?: Record<string, FieldSpec>;
}

export type Schema = Record<string, FieldSpec>;

/**
 * A rule that only applies to *some* records in a collection.
 *
 * The validator could already say "this field must be a number between 0 and 1".
 * It could not say "if `behavior` is `charge`, `windup` is required" — so an
 * enemy declaring a behaviour and omitting the field that behaviour needs
 * validated cleanly, loaded cleanly, and then misbehaved at runtime with no
 * error anywhere. That is the exact shape of bug this file exists to prevent,
 * and it had a hole in it.
 *
 * Deliberately not a general expression language: `when` a field equals a value,
 * `require` these others. Anything more expressive belongs in a test, where it
 * can say why.
 */
export interface ConditionalRule {
  when: { field: string; equals: string | number | boolean };
  require: readonly string[];
  /** Shown when it fails, so the message says the design rule and not the code. */
  because: string;
}

export class ContentError extends Error {
  constructor(
    readonly file: string,
    readonly path: string,
    message: string,
  ) {
    super(`[content] ${file}${path ? ` @ ${path}` : ''}: ${message}`);
    this.name = 'ContentError';
  }
}

export interface RegistrySet {
  [registry: string]: ReadonlySet<string>;
}

function checkValue(
  file: string,
  path: string,
  value: unknown,
  spec: FieldSpec,
  registries: RegistrySet,
  errors: ContentError[],
): void {
  const actual = Array.isArray(value) ? 'array' : typeof value;
  if (actual !== spec.type) {
    errors.push(new ContentError(file, path, `expected ${spec.type}, got ${actual}`));
    return;
  }

  if (spec.type === 'number') {
    const n = value as number;
    if (!Number.isFinite(n)) errors.push(new ContentError(file, path, 'not a finite number'));
    if (spec.min !== undefined && n < spec.min)
      errors.push(new ContentError(file, path, `${n} < min ${spec.min}`));
    if (spec.max !== undefined && n > spec.max)
      errors.push(new ContentError(file, path, `${n} > max ${spec.max}`));
  }

  if (spec.type === 'string') {
    const s = value as string;
    if (spec.oneOf && !spec.oneOf.includes(s))
      errors.push(new ContentError(file, path, `"${s}" not one of [${spec.oneOf.join(', ')}]`));
    if (spec.ref) {
      const reg = registries[spec.ref];
      if (!reg) errors.push(new ContentError(file, path, `unknown registry "${spec.ref}"`));
      else if (!reg.has(s))
        errors.push(new ContentError(file, path, `"${s}" is not a known ${spec.ref} id`));
    }
  }

  if (spec.type === 'array' && spec.items) {
    (value as unknown[]).forEach((entry, i) => {
      checkValue(file, `${path}[${i}]`, entry, spec.items!, registries, errors);
    });
  }

  if (spec.type === 'object' && spec.fields) {
    checkObject(file, path, value as Record<string, unknown>, spec.fields, registries, errors);
  }
}

function checkObject(
  file: string,
  path: string,
  obj: Record<string, unknown>,
  schema: Schema,
  registries: RegistrySet,
  errors: ContentError[],
): void {
  for (const [key, spec] of Object.entries(schema)) {
    const child = path ? `${path}.${key}` : key;
    const value = obj[key];
    if (value === undefined || value === null) {
      if (spec.required) errors.push(new ContentError(file, child, 'required field missing'));
      continue;
    }
    checkValue(file, child, value, spec, registries, errors);
  }
  for (const key of Object.keys(obj)) {
    if (!(key in schema)) {
      const child = path ? `${path}.${key}` : key;
      errors.push(new ContentError(file, child, 'unknown field (typo?)'));
    }
  }
}

/**
 * Validate an array of content records. Throws an aggregate error listing every
 * problem found — content authors get the full picture in one pass.
 */
export function validateCollection<T>(
  file: string,
  records: readonly unknown[],
  schema: Schema,
  registries: RegistrySet,
  rules: readonly ConditionalRule[] = [],
): readonly T[] {
  const errors: ContentError[] = [];
  const seenIds = new Set<string>();

  records.forEach((record, i) => {
    if (typeof record !== 'object' || record === null || Array.isArray(record)) {
      errors.push(new ContentError(file, `[${i}]`, 'record is not an object'));
      return;
    }
    const obj = record as Record<string, unknown>;
    const id = typeof obj['id'] === 'string' ? obj['id'] : `[${i}]`;
    if (typeof obj['id'] === 'string') {
      if (seenIds.has(id)) errors.push(new ContentError(file, id, 'duplicate id'));
      seenIds.add(id);
    }
    checkObject(file, id, obj, schema, registries, errors);
    for (const rule of rules) {
      if (obj[rule.when.field] !== rule.when.equals) continue;
      for (const needed of rule.require) {
        if (obj[needed] === undefined) {
          errors.push(
            new ContentError(
              file,
              id,
              `"${rule.when.field}" is "${String(rule.when.equals)}" so "${needed}" is ` +
                `required — ${rule.because}`,
            ),
          );
        }
      }
    }
  });

  if (errors.length > 0) {
    throw new Error(
      `Content validation failed for ${file} (${errors.length} problem${
        errors.length === 1 ? '' : 's'
      }):\n` + errors.map((e) => '  ' + e.message).join('\n'),
    );
  }
  return records as readonly T[];
}
