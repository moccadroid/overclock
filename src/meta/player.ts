/**
 * Who played it — as far as a browser can honestly say.
 *
 * A random id, written once and kept. Not derived from anything about the
 * machine or the person: fingerprinting is unreliable, actively broken by
 * Safari and Firefox, and would claim a precision this cannot have. What this
 * identifies is a browser profile on a device. Clearing storage, private
 * browsing, a second browser or a second machine all produce a new player, and
 * any retention number read off it is a floor rather than a count.
 *
 * Its own storage key, like `runstore` and `cellstore`, and deliberately outside
 * `LibraryData`: §15.1's guard scans that shape for numbers that could become
 * multipliers, and identity is not progression. It also means clearing the
 * Library does not reset the id, and resetting the id does not cost unlocks.
 *
 * Lives in its own module rather than inside telemetry because the leaderboard
 * will want the same id to hang a name off, and two sources of "who is this"
 * would immediately disagree.
 */
const STORAGE_KEY = 'overclock.player.v1';

function generate(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  let s = '';
  for (let i = 0; i < 32; i++) s += Math.floor(Math.random() * 16).toString(16);
  return s;
}

/**
 * The id for this browser, minting one on first call.
 *
 * Returns null when storage is unavailable — private browsing, a full quota, a
 * disabled setting. A run from an unidentifiable player is still a run worth
 * having, so this never invents a per-session id to fill the gap: that would
 * quietly inflate the player count with ghosts who each played exactly once.
 */
export function playerId(): string | null {
  try {
    const existing = localStorage.getItem(STORAGE_KEY);
    if (existing) return existing;
    const fresh = generate();
    localStorage.setItem(STORAGE_KEY, fresh);
    return fresh;
  } catch {
    return null;
  }
}

/** Forget this browser. Debug, and whatever "start over" ends up meaning. */
export function resetPlayerId(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to do and nothing that matters.
  }
}

/**
 * How much game this player had behind them *entering* the run.
 *
 * Read at run start, never at the end. A Discovery earned on the killing tick
 * belongs to the next run's experience, not this one's — measured at the end,
 * every run would look slightly more experienced than the player actually was,
 * and the first run of all would report having already found things.
 */
export interface PlayerExperience {
  runs: number;
  discoveries: number;
  unlocked: number;
  codex: number;
  bestScore: number;
  bestDepth: number;
  bestTime: number;
}
