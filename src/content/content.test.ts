import { describe, expect, it } from 'vitest';
import { validateCollection, type Schema } from './validate';
import { ACTIONS, ALL_NODES, AXIOMS, ENEMIES, MODIFIERS, TRIGGERS, WAVES } from './index';
import { World } from '../sim/world';
import { rollDraft, STAT_CARDS } from '../sim/draft';
import { AFFIX_IDS, AFFIX_TRAITS, TRAIT_RUNNERS, deriveTraits } from '../sim/traits';
import { HAZARDS, HAZARD_KINDS } from '../sim/hazards';
import { HAZARD_DRAW } from '../app/renderer';
import { SHAPE_NAMES, shapeOutline } from '../app/gfx/shapes';

/** The declared vocabularies, mirrored from types.ts so drift is a failure. */
const SHAPES = [
  'dot',
  'circle',
  'triangle',
  'square',
  'hexagon',
  'diamond',
  'ring',
  'crescent',
  'line',
  'pentagon',
];
const MARKS = ['shield', 'charge', 'phase', 'brood', 'crown', 'spines'];

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
  'idle',
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

describe('every vocabulary has an implementation (GDD §10, §11.4, §16.4)', () => {
  /**
   * The class of bug this exists for is specific and has already happened twice
   * in this codebase: a thing is added to a type, and to a table, and never to
   * the one place that actually reaches for it. It is invisible — the content
   * validates, the build passes, the tests pass, and the feature silently does
   * nothing.
   *
   * The traits refactor produced a third instance within an hour: porting
   * phasing to a trait stopped Ghost variants phasing at all, and every existing
   * test still passed, because level one is tier 0 and no Ghost ever spawns in
   * one. These are the measurements that would have caught it by construction.
   */

  it('every enemy resolves to traits that all have runners', () => {
    for (const e of ENEMIES) {
      const traits = deriveTraits(e);
      expect(traits.length, `${e.id} does nothing at all`).toBeGreaterThan(0);
      for (const spec of traits) {
        expect(
          TRAIT_RUNNERS[spec.t],
          `enemy "${e.id}" wants trait "${spec.t}", which nothing implements`,
        ).toBeDefined();
      }
    }
  });

  it("every enemy's own idea survives into its trait list", () => {
    // The Ghost regression, generalised: a def that declares a passive idea must
    // still be carrying it after derivation, whatever else changes.
    for (const e of ENEMIES) {
      if (e.phaseInterval === undefined) continue;
      const phase = deriveTraits(e).find((t) => t.t === 'phase');
      expect(phase, `"${e.id}" declares phaseInterval and lost it`).toBeDefined();
      expect(phase!.interval).toBe(e.phaseInterval);
    }
  });

  it('every affix grants traits that all have runners', () => {
    for (const id of AFFIX_IDS) {
      const entry = AFFIX_TRAITS[id]!;
      expect(entry.traits.length, `affix "${id}" grants nothing`).toBeGreaterThan(0);
      for (const spec of entry.traits) {
        expect(TRAIT_RUNNERS[spec.t], `affix "${id}" wants trait "${spec.t}"`).toBeDefined();
      }
    }
  });

  it('every hazard the sim can spawn, the renderer can draw', () => {
    // A hazard that spawns and does not draw is invisible damage, which is the
    // worst failure this system has: the player takes a hit from nothing.
    for (const kind of HAZARD_KINDS) {
      expect(HAZARD_DRAW[kind], `hazard "${kind}" has no drawing`).toBeDefined();
    }
    for (const kind of Object.keys(HAZARD_DRAW)) {
      expect(HAZARDS[kind], `"${kind}" is drawn but can never spawn`).toBeDefined();
    }
  });

  it('the shape table and the shape type agree in both directions', () => {
    // A shape in the type with no table row silently drew a 16-gon: a circle
    // where a silhouette should be, which §16.4 cannot afford because outline is
    // how enemies are learned.
    for (const shape of SHAPES) expect(SHAPE_NAMES).toContain(shape);
    for (const shape of SHAPE_NAMES) expect(SHAPES).toContain(shape);
  });

  it('every enemy shape has geometry, and every mark has a glyph', () => {
    for (const e of ENEMIES) {
      const outline = shapeOutline(e.shape, 0, 0, 10, 0);
      expect(outline.length, `shape "${e.shape}" (${e.id}) draws nothing`).toBeGreaterThan(1);
      // A shape with no case falls through to a 16-gon, so "has geometry" is
      // not enough on its own — it must also be a shape the type admits.
      expect(SHAPES).toContain(e.shape);
      expect(SHAPE_NAMES, `shape "${e.shape}" is in the type but not the table`).toContain(
        e.shape,
      );
      for (const mark of e.marks ?? []) expect(MARKS).toContain(mark);
    }
  });
});
