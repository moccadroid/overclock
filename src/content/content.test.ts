import { describe, expect, it } from 'vitest';
import { validateCollection, type Schema } from './validate';
import { ACTIONS, ALL_NODES, AXIOMS, ENEMIES, MODIFIERS, TRIGGERS, WAVES } from './index';
import { World } from '../sim/world';
import { rollDraft, STAT_CARDS } from '../sim/draft';

/** The event alphabet, as the sim's own type declares it. */
const EVENT_KINDS = [
  'clock',
  'hit',
  'kill',
  'crit',
  'pickup',
  'dash',
  'wound',
  'wave',
  'overheat',
  'convert',
  'lull',
  'threshold',
  'depth',
  'sweep',
  'glutton',
  'enter',
];

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

  it('every stat card in the type is actually rollable', () => {
    // Twice now a stat has been added to StatKind and to STAT_CARDS and never to
    // the array rollDraft picks from — the class stats first, then Reach. Both
    // times the card existed, was documented, and could not be drawn. Both times
    // it took a measurement across whole runs to notice. This is that
    // measurement, as a build failure.
    const world = new World({ seed: 'stat-coverage', axiomId: 'ignition' });
    const seen = new Set<string>();
    for (let i = 0; i < 6000; i++) {
      for (const card of rollDraft(world).cards) {
        if (card.kind === 'stat') seen.add(card.stat);
      }
    }
    for (const stat of Object.keys(STAT_CARDS)) {
      expect(seen.has(stat), `stat "${stat}" is defined but never offered`).toBe(true);
    }
  });

  it('every Trigger listens for an event the sim actually emits', () => {
    // A Trigger whose event is never emitted is a card that cannot do anything,
    // and On Overheat spent a whole release in exactly that state because Heat
    // never reached 100. Emission is measured elsewhere; this checks the weaker
    // but automatable half: the event kind exists in the alphabet.
    const emitted = new Set<string>(EVENT_KINDS);
    for (const t of TRIGGERS) {
      expect(emitted.has(t.listens), `${t.id} listens for "${t.listens}"`).toBe(true);
    }
  });
});
