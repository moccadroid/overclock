import { describe, expect, it } from 'vitest';
import { validateCollection, type Schema } from './validate';
import { ACTIONS, ALL_NODES, AXIOMS, ENEMIES, MODIFIERS, TRIGGERS, WAVES } from './index';

const schema: Schema = {
  id: { type: 'string', required: true },
  power: { type: 'number', required: true, min: 0, max: 10 },
  kind: { type: 'string', oneOf: ['a', 'b'] },
  target: { type: 'string', ref: 'thing' },
};
const registries = { thing: new Set(['one', 'two']) };

describe('content validation', () => {
  it('accepts well-formed records', () => {
    expect(() =>
      validateCollection('t.json', [{ id: 'x', power: 3, kind: 'a', target: 'one' }], schema, registries),
    ).not.toThrow();
  });

  it('rejects missing required fields', () => {
    expect(() => validateCollection('t.json', [{ id: 'x' }], schema, registries)).toThrow(
      /required field missing/,
    );
  });

  it('rejects out-of-range numbers and bad enums', () => {
    expect(() =>
      validateCollection('t.json', [{ id: 'x', power: 99 }], schema, registries),
    ).toThrow(/max 10/);
    expect(() =>
      validateCollection('t.json', [{ id: 'x', power: 1, kind: 'z' }], schema, registries),
    ).toThrow(/not one of/);
  });

  it('rejects dangling cross-references', () => {
    expect(() =>
      validateCollection('t.json', [{ id: 'x', power: 1, target: 'nope' }], schema, registries),
    ).toThrow(/not a known thing id/);
  });

  it('rejects duplicate ids and unknown fields', () => {
    expect(() =>
      validateCollection(
        't.json',
        [
          { id: 'x', power: 1 },
          { id: 'x', power: 1 },
        ],
        schema,
        registries,
      ),
    ).toThrow(/duplicate id/);
    expect(() =>
      validateCollection('t.json', [{ id: 'x', power: 1, wat: 1 }], schema, registries),
    ).toThrow(/unknown field/);
  });

  it('reports every problem in one pass', () => {
    try {
      validateCollection('t.json', [{ power: -1, kind: 'q' }], schema, registries);
      expect.unreachable('should have thrown');
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toMatch(/3 problems/);
    }
  });
});

describe('shipped content loads and cross-references resolve', () => {
  it('loads every collection', () => {
    expect(TRIGGERS.length).toBeGreaterThan(0);
    expect(ACTIONS.length).toBeGreaterThan(0);
    expect(MODIFIERS.length).toBeGreaterThan(0);
    expect(ENEMIES.length).toBeGreaterThan(0);
    expect(WAVES.length).toBeGreaterThan(0);
    expect(AXIOMS.length).toBeGreaterThan(0);
  });

  it('has no duplicate node ids across kinds', () => {
    const ids = ALL_NODES.map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every wave band is reachable and ordered', () => {
    for (const wave of WAVES) {
      expect(wave.minThreat).toBeLessThan(wave.maxThreat);
      expect(wave.entries.length).toBeGreaterThan(0);
    }
    // Something must be spawnable at the very start of a run.
    expect(WAVES.some((w) => w.minThreat === 0)).toBe(true);
  });

  it('every Axiom starter is a complete, live Program', () => {
    for (const ax of AXIOMS) {
      expect(TRIGGERS.some((t) => t.id === ax.starter.trigger)).toBe(true);
      expect(ACTIONS.some((a) => a.id === ax.starter.action)).toBe(true);
      expect(ax.starter.modifiers.length).toBeLessThanOrEqual(3);
    }
  });
});
