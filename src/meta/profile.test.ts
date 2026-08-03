import { describe, expect, it, beforeEach } from 'vitest';
import { Library } from './profile';
import { DISCOVERIES, ALL_NODES, AXIOMS } from '../content/index';
import { DISCOVERY_CHECKS } from '../sim/discoveries';

/**
 * The sim runs headless, so the test environment has no DOM. An in-memory shim
 * is enough here: what is under test is the merge and guard logic around
 * storage, not the browser API itself.
 */
const store = new Map<string, string>();
globalThis.localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: (i: number) => [...store.keys()][i] ?? null,
  get length() {
    return store.size;
  },
} as Storage;

describe('the Library (GDD §15)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('§15.1 — grants breadth, never power', () => {
    // The iron rule, enforced structurally: the stored shape has no numeric
    // field the sim could read as a multiplier. If someone adds one, this fails
    // and they have to argue with §15.1 rather than with a reviewer.
    const lib = new Library();
    for (const d of DISCOVERIES) lib.earn(d.id);
    const data = lib.snapshot as unknown as Record<string, unknown>;

    const powerish = Object.entries(data).filter(
      ([key, value]) => typeof value === 'number' && !key.startsWith('best') && key !== 'runs',
    );
    expect(powerish).toEqual([]);

    // Preferences live in their own object precisely so this scan stays strict.
    // If settings ever migrate up to the top level, the guard has to be loosened
    // — and a loosened guard is how a damage multiplier gets in.
    expect(typeof data.settings).toBe('object');

    // And the visual effects are *ids*, not numbers. Sliders would put floats in
    // the Library, and floats one refactor away from the progression fields is
    // how the guard above eventually gets loosened.
    //
    // They live under `fx` rather than `effects` because `effects` is now the
    // sound-effects volume. The names collided the moment audio grew a second
    // level, and a settings key that means two things is how the wrong one gets
    // read.
    const fx = (data.settings as { fx: unknown }).fx;
    expect(Array.isArray(fx)).toBe(true);
    for (const e of fx as unknown[]) expect(typeof e).toBe('string');
  });

  it('§15.2 — a fresh account starts with roughly 60% of the node pool', () => {
    const lib = new Library();
    const share = lib.availableNodes.length / ALL_NODES.length;
    expect(share).toBeGreaterThan(0.5);
    expect(share).toBeLessThan(0.7);
  });

  it('every archetype is reachable on run one', () => {
    // §15.2: "enough for every archetype, thin enough to learn". A starting pool
    // missing a whole hue or the ability to build a loop is not thin, it is
    // broken — the first run would have no way to express a direction.
    const lib = new Library();
    const available = new Set(lib.availableNodes);
    const kinds = ALL_NODES.filter((n) => available.has(n.id));

    expect(kinds.some((n) => n.kind === 'trigger' && n.id === 'clock')).toBe(true);
    // Loops need a Trigger that listens to your own output.
    expect(kinds.some((n) => ['on_hit', 'on_kill'].includes(n.id))).toBe(true);
    for (const hue of ['thermal', 'voltaic', 'void']) {
      expect(kinds.some((n) => n.kind === 'action' && n.hue === hue)).toBe(true);
    }
    // And something to sharpen a row with.
    expect(kinds.filter((n) => n.kind === 'modifier').length).toBeGreaterThanOrEqual(8);
  });

  it('starts with Ignition alone, and earns the other two by playing', () => {
    // An Axiom is a starting Program, and you cannot evaluate one before you
    // know what a Program is. Three on run one is three ways to be confused.
    const lib = new Library();
    expect(lib.availableAxioms).toEqual(['ignition']);

    // Circuit for building a loop; Feedback — which is nothing but a loop — for
    // taking one deep.
    expect(lib.earn('chain_reaction')).toContain('circuit');
    expect(lib.earn('deep_six')).toContain('feedback');
    expect(new Library().availableAxioms).toEqual(['ignition', 'circuit', 'feedback']);
  });

  it('earning the same Discovery twice unlocks nothing the second time', () => {
    const lib = new Library();
    expect(lib.earn('chain_reaction').length).toBeGreaterThan(0);
    expect(lib.earn('chain_reaction')).toEqual([]);
  });

  it('survives a corrupt or half-written Library', () => {
    localStorage.setItem('overclock.library.v1', '{"discoveries":42,"unlocked":null');
    const lib = new Library();
    expect(lib.snapshot.discoveries).toEqual([]);
    expect(lib.availableNodes.length).toBeGreaterThan(0);
  });

  it('every unlockable is reachable, and every Discovery is detectable', () => {
    // The classic content bug this guards: a reward that unlocks an id nobody
    // grants, or a Discovery in the data with no condition behind it. Both are
    // invisible until a player fails to get something.
    const reachable = new Set(DISCOVERIES.flatMap((d) => d.unlocks));
    const known = new Set([...ALL_NODES.map((n) => n.id), ...AXIOMS.map((a) => a.id)]);
    for (const id of reachable) expect(known.has(id)).toBe(true);

    for (const d of DISCOVERIES) {
      expect(DISCOVERY_CHECKS[d.id], `no condition for "${d.id}"`).toBeTypeOf('function');
    }
    for (const id of Object.keys(DISCOVERY_CHECKS)) {
      expect(DISCOVERIES.some((d) => d.id === id), `orphan condition "${id}"`).toBe(true);
    }

    // Everything locked at start must have a way out of the lock.
    const lib = new Library();
    const locked = ALL_NODES.filter((n) => !lib.availableNodes.includes(n.id));
    for (const n of locked) {
      expect(lib.unlockedBy(n.id), `"${n.id}" is locked with no Discovery granting it`).toBeTruthy();
    }
  });
});
