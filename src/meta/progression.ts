/**
 * Progression. GDD §15.2 — and, more to the point, a system the simulation has
 * never heard of.
 *
 * **The contract this module exists to keep:** the sim takes a set of node ids
 * and has no idea why that set is what it is. `RunConfig.availableNodes` is the
 * whole seam. Progression, a balance experiment, a Library that has been reset,
 * or "we cut the Convert cards this week" all produce the same input, and
 * nothing downstream can tell them apart. Delete this file and the game runs
 * exactly as it does now with everything available — which is the only honest
 * test that the boundary is where it claims to be.
 *
 * That is why this lives in `src/meta` and its data lives in `src/meta/data`
 * rather than `src/content/data`: content is what the sim consumes. A `locked`
 * flag on a node record would be a progression concept smuggled into the
 * simulation's vocabulary, and the sim would then have an opinion about
 * something that is none of its business.
 *
 * ---
 *
 * **One list, not two.** This replaces a hand-written `LOCKED_AT_START` array
 * that sat in the storage module and had to agree with `unlocks` over in
 * discoveries.json. Nothing checked that they did, and they didn't: it listed
 * `convert_rectify` and `attune`, neither of which is a node id in this game.
 * Two entries locking nothing, invisible, because the test that would have
 * caught it could only see nodes that exist.
 *
 * So there is no lock list. A thing is gated **because something grants it**,
 * and available otherwise. The gating graph is the only list, an id in it is
 * validated against the registries like every other content reference, and
 * "locked with no way out" is not a bug you can express any more.
 *
 * Axioms ride the same rule rather than a `startingAxioms` field. Circuit and
 * Feedback are granted by Discoveries and Ignition is not, which is precisely
 * the old behaviour — the field would have been a second way to say the same
 * thing, and a second way to say it is a second way to disagree.
 */
import raw from './data/progression.json';
import { ALL_NODES, AXIOMS, DISCOVERIES } from '../content/index';
import { validateCollection, type RegistrySet, type Schema } from '../content/validate';

/** One Discovery, and what earning it opens up. */
export interface GrantDef {
  discovery: string;
  unlocks: readonly string[];
}

export interface ProgressionDef {
  id: string;
  /** Exactly one profile is active. Flipping it is a data edit, not a commit. */
  active?: boolean;
  description: string;
  grants: readonly GrantDef[];
}

const schema: Schema = {
  id: { type: 'string', required: true },
  active: { type: 'boolean' },
  description: { type: 'string', required: true },
  grants: {
    type: 'array',
    required: true,
    items: {
      type: 'object',
      fields: {
        discovery: { type: 'string', required: true, ref: 'discovery' },
        unlocks: {
          type: 'array',
          required: true,
          items: { type: 'string', ref: 'unlockable' },
        },
      },
    },
  },
};

/**
 * Built here rather than imported from the content registry, because the
 * dependency only runs one way: content knows nothing about progression, so
 * progression is the side that does the looking up.
 */
const registries: RegistrySet = {
  discovery: new Set(DISCOVERIES.map((d) => d.id)),
  unlockable: new Set([...ALL_NODES.map((n) => n.id), ...AXIOMS.map((a) => a.id)]),
};

export const PROGRESSIONS = validateCollection<ProgressionDef>(
  'progression.json',
  raw,
  schema,
  registries,
);

/**
 * The profile in force. A run asks for its node set once, at the start, and
 * carries it in its config — nothing reads this mid-run.
 */
export const ACTIVE: ProgressionDef = (() => {
  const on = PROGRESSIONS.filter((p) => p.active);
  if (on.length !== 1) {
    throw new Error(
      `progression.json: exactly one profile must be active, found ${on.length} ` +
        `(${on.map((p) => p.id).join(', ') || 'none'})`,
    );
  }
  return on[0]!;
})();

export function progression(id: string): ProgressionDef {
  const p = PROGRESSIONS.find((x) => x.id === id);
  if (!p) throw new Error(`Unknown progression profile "${id}"`);
  return p;
}

/** What a Discovery opens, under a given profile. Empty for most of them. */
export function grantsOf(discoveryId: string, prog: ProgressionDef = ACTIVE): readonly string[] {
  return prog.grants.find((g) => g.discovery === discoveryId)?.unlocks ?? [];
}

/**
 * Which Discovery is the key to a gated id, or null if nothing gates it.
 *
 * The first one that grants it: two Discoveries granting the same node is
 * deliberate (On Overheat has two routes), and the UI wants one hint, not both.
 */
export function grantedBy(id: string, prog: ProgressionDef = ACTIVE): string | null {
  return prog.grants.find((g) => g.unlocks.includes(id))?.discovery ?? null;
}

/** Everything this profile puts behind a Discovery. Available is the complement. */
export function gatedBy(prog: ProgressionDef = ACTIVE): ReadonlySet<string> {
  return new Set(prog.grants.flatMap((g) => g.unlocks));
}

export interface ResolvedLibrary {
  /** Node ids for `RunConfig.availableNodes`. */
  nodes: string[];
  axioms: string[];
}

/**
 * The whole subsystem, in one function: a set of earned Discoveries in, the
 * node and Axiom ids a run may use out.
 *
 * `alsoGranted` carries ids a stored Library banked under an older gating graph.
 * Availability is otherwise derived fresh every time, so editing the graph takes
 * effect immediately instead of only for accounts created afterwards — which is
 * the property that makes a progression profile a *tuning* surface rather than a
 * migration.
 */
export function resolve(
  earned: Iterable<string>,
  options: { progression?: ProgressionDef; alsoGranted?: Iterable<string> } = {},
): ResolvedLibrary {
  const prog = options.progression ?? ACTIVE;
  const gated = gatedBy(prog);
  const held = new Set(options.alsoGranted ?? []);
  for (const id of earned) for (const u of grantsOf(id, prog)) held.add(u);

  const open = (id: string) => !gated.has(id) || held.has(id);
  return {
    nodes: ALL_NODES.filter((n) => open(n.id)).map((n) => n.id),
    axioms: AXIOMS.filter((a) => open(a.id)).map((a) => a.id),
  };
}
