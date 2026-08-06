/**
 * The overarching state of the game. NARRATIVE §6, §12.
 *
 * **The state is the truth; the rules are transitions on it.** An earlier design
 * had this backwards — the log of which rules had fired *was* the state, and
 * "put the story at chapter III" meant replaying every rule up to that point.
 * That only ever reaches states on the golden path, runs effects out of the
 * context they were written for, and cannot express the states worth testing:
 * *at R2 but the archive was never entered*, *holding a document at clearance 0*.
 *
 * So this is a plain serialisable value. Setting the story to any state is an
 * assignment, and a test fixture is a literal.
 *
 * The compromise, stated plainly: **you cannot set state you cannot name.** The
 * named fields are the ones NARRATIVE actually commits to; `flags` carries
 * whatever we have not thought of yet, so a new idea does not need a migration.
 */

/** Where the arc is. Authored names, never an index — §6.1. */
export type Chapter = 'I' | 'II' | 'III' | 'IV' | 'V';

export interface Story {
  chapter: Chapter;
  /** §5.4 — read permission. Goes up, and can be taken away. */
  clearance: number;
  /** §6.3 — documents accrete. Which sections of each the operator holds. */
  held: Record<string, number[]>;
  /**
   * Transmissions waiting to be typed on the terminal, in order.
   *
   * Persisted rather than delivered on the spot, because §8's channel arrives
   * *between* runs and the player may not be looking at the terminal when the
   * condition comes true. Only an acknowledged delivery removes one, so a
   * message interrupted by a reload is still there.
   */
  queue: string[];
  /**
   * Which arena the next run is built from, or null for the default. §6.2 — the
   * campaign's rooms are levels in an arena definition, so this one string is
   * the whole of "the story decides where you find yourself".
   */
  arena: string | null;
  /** §5.2 — the site restoration index. 04 now; 05 after the first RESET. */
  revision: string;
  /** §12 — what survives a cycle. Scars, not features. */
  scars: string[];
  /** Anything not yet worth a field of its own. */
  flags: Record<string, number>;
  /** Bookkeeping: which once-only rules have run. Never read for meaning. */
  fired: string[];
}

export const START: Story = {
  chapter: 'I',
  clearance: 0,
  held: {},
  queue: [],
  arena: null,
  revision: '04',
  scars: [],
  flags: {},
  fired: [],
};

/**
 * §12 — the cycle ends and the site is restored from backup.
 *
 * One function, so what survives a RESET is one readable line rather than a
 * scatter of conditionals. Everything goes except the scars and the revision
 * index, which is the one scar that cannot be missed and the one nobody notices
 * first.
 */
export function nextCycle(story: Story): Story {
  return {
    ...START,
    scars: [...story.scars],
    revision: String(Number(story.revision) + 1).padStart(2, '0'),
  };
}
