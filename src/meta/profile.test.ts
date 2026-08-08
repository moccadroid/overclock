import { describe, expect, it, beforeEach } from 'vitest';
import { Library } from './profile';
import { ALL_NODES, AXIOMS, DISCOVERIES } from '../content/index';
import { DISCOVERY_CHECKS } from '../sim/discoveries';
import { gatedBy, grantsOf, progression } from './progression';

/**
 * §15.2's curated pool is a *design*, and the design stays under test whether or
 * not it is the profile in force. Every case below that is about gating names
 * `default` explicitly; the ones about storage use whatever is active, because
 * remembering what you earned is not a progression decision.
 */
const CURATED = progression('default');

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
    const lib = new Library(CURATED);
    const share = lib.availableNodes.length / ALL_NODES.length;
    expect(share).toBeGreaterThan(0.5);
    expect(share).toBeLessThan(0.7);
  });

  it('every archetype is reachable on run one', () => {
    // §15.2: "enough for every archetype, thin enough to learn". A starting pool
    // missing a whole hue or the ability to build a loop is not thin, it is
    // broken — the first run would have no way to express a direction.
    const lib = new Library(CURATED);
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
    const lib = new Library(CURATED);
    expect(lib.availableAxioms).toEqual(['ignition']);

    // Circuit for building a loop; Feedback — which is nothing but a loop — for
    // taking one deep.
    expect(lib.earn('chain_reaction')).toContain('circuit');
    expect(lib.earn('deep_six')).toContain('feedback');
    expect(new Library(CURATED).availableAxioms).toEqual(['ignition', 'circuit', 'feedback']);
  });

  it('earning the same Discovery twice unlocks nothing the second time', () => {
    const lib = new Library(CURATED);
    expect(lib.earn('chain_reaction').length).toBeGreaterThan(0);
    expect(lib.earn('chain_reaction')).toEqual([]);
  });

  it('survives a corrupt or half-written Library', () => {
    localStorage.setItem('overclock.library.v1', '{"discoveries":42,"unlocked":null');
    const lib = new Library();
    expect(lib.snapshot.discoveries).toEqual([]);
    expect(lib.availableNodes.length).toBeGreaterThan(0);
  });

  it('§20.1 — a Library written before calibration existed has not calibrated', () => {
    // The migration that matters, because every account in the wild is one of
    // these. A missing `gamma` has to land on the identity — anything else moves
    // a picture the player never asked to have moved — and a missing
    // `calibrated` has to read as false, or the one screen this feature is for
    // never shows to the people who needed it enough to report it.
    localStorage.setItem(
      'overclock.library.v1',
      JSON.stringify({ runs: 3, settings: { volume: 0.4, phosphor: 'amber' } }),
    );
    const lib = new Library();
    expect(lib.snapshot.settings.gamma).toBe(1);
    expect(lib.snapshot.settings.calibrated).toBe(false);
    // And the settings it *did* have survive the arrival of two new ones.
    expect(lib.snapshot.settings.volume).toBe(0.4);
    expect(lib.snapshot.settings.phosphor).toBe('amber');

    lib.setDisplay({ gamma: 1.45, calibrated: true });
    const reopened = new Library();
    expect(reopened.snapshot.settings.gamma).toBe(1.45);
    expect(reopened.snapshot.settings.calibrated).toBe(true);
  });

  it('an account keeps what it banked when the gating graph is re-cut', () => {
    // §15.2 — the Library only ever grows. Availability is derived, so editing
    // progression.json takes effect immediately; the stored `unlocked` list is
    // what stops that edit taking something away from an account that earned it.
    localStorage.setItem(
      'overclock.library.v1',
      JSON.stringify({ discoveries: [], unlocked: ['mirror'] }),
    );
    expect(new Library(CURATED).availableNodes).toContain('mirror');
  });

  it('every Discovery is detectable, and every grant names something real', () => {
    // The classic content bug this guards: a reward that unlocks an id nobody
    // grants, or a Discovery in the data with no condition behind it. Both are
    // invisible until a player fails to get something.
    for (const d of DISCOVERIES) {
      expect(DISCOVERY_CHECKS[d.id], `no condition for "${d.id}"`).toBeTypeOf('function');
    }
    for (const id of Object.keys(DISCOVERY_CHECKS)) {
      expect(DISCOVERIES.some((d) => d.id === id), `orphan condition "${id}"`).toBe(true);
    }

    // Under the old model this had a matching half — "everything locked must
    // have a way out" — which could not be written down without a second list
    // to compare against, and which passed while two ids in that list were not
    // nodes at all. Gating *is* granting now, so the failure it looked for is
    // no longer expressible. What is left worth checking is the other
    // direction, and the validator does that at load: every id in a grant is a
    // real node or Axiom.
    const known = new Set([...ALL_NODES.map((n) => n.id), ...AXIOMS.map((a) => a.id)]);
    for (const id of gatedBy(CURATED)) expect(known.has(id)).toBe(true);
  });

  it('reproduces the hand-written lock list it replaced', () => {
    // The migration, pinned. `LOCKED_AT_START` was 29 ids maintained by hand
    // beside a `unlocks` field that was supposed to agree with it; this asserts
    // the derived gate is the same set, minus the two entries that named
    // nothing. If a future edit to progression.json changes who starts gated,
    // that is a design decision and this is where it gets noticed.
    const gated = [...gatedBy(CURATED)].filter((id) => ALL_NODES.some((n) => n.id === id));
    expect(gated.sort()).toEqual(
      [
        'convert_bleed', 'convert_cashout', 'convert_coolant', 'convert_stim',
        'grounding_rod', 'ground', 'governor', 'insulate', 'mine', 'mirror',
        'on_convert', 'on_dash', 'on_depth', 'on_enter', 'on_glutton',
        'on_overheat', 'on_sweep', 'on_threshold', 'on_wave', 'orbital',
        'overdrive', 'quantize', 'resonate', 'rupture', 'siphon', 'stagger',
        'volatile',
      ].sort(),
    );
    // ...and the Axioms ride the same rule rather than a second list.
    expect([...gatedBy(CURATED)].filter((id) => AXIOMS.some((a) => a.id === id)).sort()).toEqual([
      'circuit',
      'feedback',
    ]);
  });

  it('the open profile gates nothing', () => {
    // The switch. Progression off must be indistinguishable from progression
    // never having existed: every node, every Axiom, no grants to consult.
    const lib = new Library(progression('open'));
    expect(lib.availableNodes.length).toBe(ALL_NODES.length);
    expect(lib.availableAxioms.length).toBe(AXIOMS.length);
    expect(gatedBy(progression('open')).size).toBe(0);
    for (const d of DISCOVERIES) expect(grantsOf(d.id, progression('open'))).toEqual([]);
  });
});
