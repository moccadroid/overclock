import { describe, expect, it } from 'vitest';
import { validateCollection, type Schema } from './validate';
import {
  ACTIONS,
  ALL_NODES,
  AXIOMS,
  DRAFT_POOL,
  DRAFT_POOLS,
  ENEMIES,
  MODIFIERS,
  TRIGGERS,
  WAVES,
  WAVE_EVENTS,
} from './index';
import { World } from '../sim/world';
import { rollDraft, STAT_CARDS, STAT_KINDS } from '../sim/draft';
import { AFFIX_IDS, AFFIX_TRAITS, TRAIT_RUNNERS, deriveTraits } from '../sim/traits';
import { HAZARDS, HAZARD_KINDS } from '../sim/hazards';
import { HAZARD_DRAW } from '../app/renderer';
import { SHAPE_NAMES, shapeOutline } from '../app/gfx/shapes';
import { ACTION_PRIMITIVES } from '../sim/world';
import { PRIMITIVE_FIELDS } from '../sim/engine';
import { ARENA_BY_ID } from './index';
import { SHELL } from '../app/visual';
import { CHECKPOINTS, configure } from '../story/arc';

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

  it('an affix exclusion names an affix that exists', () => {
    // A typo here is silent and expensive: the wave rolls the affix it meant to
    // forbid, and the exclusion reads as present in the data. That is how a
    // Cache kept fielding suppression under a line that said it must not.
    for (const event of WAVE_EVENTS) {
      for (const step of event.via) {
        if (step.op !== 'affix' || !step.exclude) continue;
        for (const id of step.exclude) {
          expect(AFFIX_IDS, `wave event "${event.id}" excludes unknown affix "${id}"`).toContain(id);
        }
      }
    }
  });

  it('every draft profile is runnable, not just the active one', () => {
    // A variant nobody has run is a variant that names an op that was renamed
    // two months ago, and it is discovered mid-sweep. draft.ts validates the
    // whole file at load, so an unknown filter or op is already a build failure;
    // this is the other half — that each profile actually produces cards.
    for (const profile of DRAFT_POOLS) {
      const world = new World({ seed: `profile-${profile.id}`, axiomId: 'ignition' });
      const cards = rollDraft(world, profile).cards;
      expect(cards.length, `profile "${profile.id}" rolled nothing`).toBeGreaterThan(0);
    }
  });

  it('each pool filter is the only thing enforcing its own rule', () => {
    // `affordable` used to return `landed !== null && load <= capacity`, and
    // `autoSlot` returns null when there is no free slot — so it quietly
    // enforced `placeable` as well. Invisible while both always ran, and it made
    // the first variant anyone wrote a no-op: dropping `placeable` produced
    // results identical to `default` down to the last digit, which reads as "the
    // experiment showed no effect" rather than "the experiment did not run".
    const fill = () => {
      const w = new World({ seed: 'filters', axiomId: 'ignition' });
      // Every row has a Trigger, so no drafted Trigger can land anywhere.
      for (const p of w.engine.programs) p.triggerId = 'clock';
      w.engine.recompile();
      return w;
    };
    const triggersOffered = (poolId: string) => {
      const w = fill();
      const profile = DRAFT_POOLS.find((p) => p.id === poolId)!;
      let seen = 0;
      for (let i = 0; i < 300; i++) {
        for (const c of rollDraft(w, profile).cards) {
          if (c.kind === 'node' && TRIGGERS.some((t) => t.id === c.nodeId)) seen++;
        }
      }
      return seen;
    };

    expect(triggersOffered('default'), 'a Trigger with nowhere to go was offered').toBe(0);
    expect(
      triggersOffered('no_placeable_filter'),
      'dropping the placeable filter changed nothing — some other filter is enforcing it',
    ).toBeGreaterThan(0);
  });

  it('the stat vocabulary, the verbs and the roll table all agree', () => {
    // Three lists that had to match, and twice did not: a stat existed in the
    // type, had an effect, and was in no roll table, so it was documented and
    // undraftable. Two of those three are now one list in data; this is the
    // third edge.
    for (const profile of DRAFT_POOLS) {
      const stats = profile.stats.map((s) => s.stat);
      expect(new Set(stats).size, `profile "${profile.id}" lists a stat twice`).toBe(stats.length);
      expect([...stats].sort()).toEqual([...STAT_KINDS].sort());
    }
  });

  it('the filler slice covers the whole roll, in order', () => {
    // The bands are cumulative bounds on one 0..1 draw, not widths. Unsorted or
    // not reaching 1 and some roll lands in no band at all — which would fall
    // back to the last entry and read as a weighting decision nobody made.
    for (const profile of DRAFT_POOLS) {
      const bounds = profile.filler.slice.map((s) => s.upTo);
      expect([...bounds], `profile "${profile.id}" filler bands are out of order`).toEqual(
        [...bounds].sort((a, b) => a - b),
      );
      expect(bounds[bounds.length - 1], `profile "${profile.id}" filler leaves a gap`).toBe(1);
    }
  });

  it('a card body never restates a number the card also applies', () => {
    // `+40 max Integrity` was written twice, in two languages, and the Momentum
    // card said `+45%` while the cap it described was 40%. Interpolation is what
    // fixes that, so the data has to actually use it.
    for (const s of DRAFT_POOL.stats) {
      const magnitude = s.format === 'percent' ? `${Math.round(s.amount * 100)}%` : `${s.amount}`;
      expect(
        s.body.includes(magnitude),
        `stat "${s.stat}" spells out "${magnitude}" instead of interpolating {n}`,
      ).toBe(false);
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
  it('every Action primitive has a runner and a modifier list (GDD §5)', () => {
    // Two tables in two files that had to agree and nothing checked them. A
    // primitive missing from ACTION_RUNNERS is a card that fires and does
    // nothing; missing from PRIMITIVE_FIELDS is subtler and worse — the card
    // works, and every modifier on its row is silently ignored, so the player
    // is paying Cycles for stats that never apply.
    for (const action of ACTIONS) {
      expect(
        ACTION_PRIMITIVES,
        `action "${action.id}" has primitive "${action.primitive}" and no runner`,
      ).toContain(action.primitive);
      expect(
        PRIMITIVE_FIELDS[action.primitive],
        `primitive "${action.primitive}" takes no modifiers — every one on its row is ignored`,
      ).toBeDefined();
    }
    // ...and nothing implemented that no Action can reach.
    for (const primitive of ACTION_PRIMITIVES) {
      expect(
        ACTIONS.some((a) => a.primitive === primitive),
        `primitive "${primitive}" is implemented but no Action uses it`,
      ).toBe(true);
    }
  });
});

describe('LEVELS 3.2b — the decomposition ladder', () => {
  /**
   * The global SHELL is the campaign's **floor**, and rooms escalate upward from
   * it. It was left at TERMINAL after look development, which does not read as a
   * wrong default: it means every room including the Heap is fully decomposed, so
   * run 1 looks like the ending and the descent has nowhere to go. LEVELS 3.2b
   * warns about it in prose; this is the same warning that fails a build.
   */
  it('keeps the baseline at sound, so rooms have somewhere to climb from', () => {
    expect(SHELL.dissolve).toBe(0);
    expect(SHELL.decay).toBe(0);
    expect(SHELL.shred).toBe(0);
  });

  it('gives the Heap nothing, because it is the one room allowed to be normal', () => {
    const heap = ARENA_BY_ID.get('heap')!.levels!.find((l: { id: string }) => l.id === 'heap')!;
    expect(heap.shell?.['dissolve'] ?? 0).toBe(0);
  });

  /**
   * The Archive sits *below* the Sink deliberately — stillness is its texture and
   * wear that moves would spend it — so this asserts the authored shape rather
   * than a naive "deeper is always worse".
   */
  it('climbs Sink → Store → Cell, with the Archive held back', () => {
    const dissolveOf = (arena: string, level: string): number => {
      const lv = ARENA_BY_ID.get(arena)!.levels!.find((l: { id: string }) => l.id === level);
      return (lv?.shell?.['dissolve'] as number | undefined) ?? 0;
    };
    const sink = dissolveOf('heap', 'sink');
    const archive = dissolveOf('heap_archive', 'archive');
    const store = dissolveOf('heap_store', 'store');
    const cell = dissolveOf('heap_cell', 'cell');
    expect(sink).toBeGreaterThan(0);
    expect(archive).toBeLessThan(sink);
    expect(store).toBeGreaterThan(sink);
    expect(cell).toBeGreaterThan(store);
  });

  /**
   * And the site itself comes apart across the campaign. Zero for the first two
   * shifts so the tutorial keeps its honest picture of normal, and shallow after
   * — a fast climb steals the room ladder's job.
   */
  it('raises the site floor late and shallowly', () => {
    const base = { seed: 'decay-test', axiomId: 'ignition' };
    const decayAt = (name: string): number =>
      configure(CHECKPOINTS[name]!, base).siteDecay ?? 0;
    expect(decayAt('fresh')).toBe(0);
    expect(decayAt('contact')).toBe(0);
    expect(decayAt('deadgate')).toBeGreaterThan(0);
    expect(decayAt('final')).toBeGreaterThan(decayAt('deadgate'));
    expect(decayAt('final')).toBeLessThan(1);
  });
  /**
   * The rot is per-room, and only the deep rooms carry it. It was global — the
   * TERMINAL stage in LEVELS 3.2b names all three dials on one room, so a global
   * decay could not express the ladder at all, and every room was stuck at zero.
   * `shred` is the one dial with a real frame cost, so exactly one room may have
   * it and it is the last one.
   */
  it('gives the rot only to the deep rooms, and shred only to the Cell', () => {
    const shellOf = (arena: string, level: string): Record<string, number> =>
      (ARENA_BY_ID.get(arena)!.levels!.find((l: { id: string }) => l.id === level)?.shell ??
        {}) as Record<string, number>;
    expect(shellOf('heap', 'heap')['decay'] ?? 0).toBe(0);
    expect(shellOf('heap', 'sink')['decay'] ?? 0).toBe(0);
    expect(shellOf('heap_store', 'store')['decay'] ?? 0).toBeGreaterThan(0);
    expect(shellOf('heap_cell', 'cell')['decay'] ?? 0).toBeGreaterThan(
      shellOf('heap_store', 'store')['decay'] ?? 0,
    );

    const withShred = ['heap', 'sink', 'archive', 'store', 'cell'].filter((id) => {
      for (const arena of ['heap', 'heap_archive', 'heap_store', 'heap_cell']) {
        const sh = shellOf(arena, id);
        if ((sh['shred'] ?? 0) > 0) return true;
      }
      return false;
    });
    expect(withShred).toEqual(['cell']);
  });
});
