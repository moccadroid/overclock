/**
 * The Library. GDD §15.2 — what persists between runs.
 *
 * §15.1 is the iron rule and this module is where it would be broken, so it is
 * worth restating: **meta-progression grants breadth and knowledge, never
 * power.** There is no stat here. There is no currency that buys damage. A
 * day-one account and a hundred-hour account entering the same run with the
 * same picks are identically strong. What a hundred hours buys you is a wider
 * draft pool, more Axioms to start from, and a Codex that tells you what a
 * Suppressor does before it does it.
 *
 * Everything is stored as ids. Nothing here is a number the sim reads as a
 * multiplier, and that is deliberate — there is no field to accidentally add
 * one to.
 */
import { ALL_NODES, AXIOMS, DISCOVERIES } from '../content/index';

const STORAGE_KEY = 'overclock.library.v1';

/**
 * §15.2 — "fresh accounts start with a curated ~60% of nodes: enough for every
 * archetype, thin enough to learn."
 *
 * The locked set is chosen so that every archetype is playable on run one. What
 * is held back is the *spicy* half: the nodes that reward understanding a system
 * you have not met yet. You cannot appreciate On Overheat before you have
 * overheated, and Convert is incoherent before fuel means anything to you.
 */
const LOCKED_AT_START: readonly string[] = [
  // Triggers that reference a system the player has not met.
  'on_overheat',
  'on_convert',
  'on_dash',
  'on_wave',
  // The fuel-economy layer, meaningless before fuel is legible.
  'convert_bleed',
  'convert_rectify',
  'convert_cashout',
  'convert_coolant',
  'convert_stim',
  'siphon',
  // Actions whose value is positional or delayed rather than immediate.
  'orbital',
  'rupture',
  'mine',
  // Modifiers that trade against a cost the player cannot yet price.
  'overdrive',
  'ground',
  'resonate',
  'quantize',
  'attune',
  'volatile',
];

/**
 * Axioms available before any milestone. §15.2 says three, but three on run one
 * is three ways to be confused at once: an Axiom is a *starting Program*, and
 * you cannot evaluate one before you know what a Program is. Ignition — the
 * plainest possible `Clock -> Bolt` — is the only honest first choice.
 *
 * Circuit arrives once you have built a loop; Feedback, which is nothing but a
 * loop, once you have taken one deep.
 */
const STARTING_AXIOMS: readonly string[] = ['ignition'];

export interface LibraryData {
  /** Discovery ids earned, ever. */
  discoveries: string[];
  /** Node and Axiom ids unlocked beyond the starting set. */
  unlocked: string[];
  /** Enemy ids encountered, for the Codex. */
  codex: string[];
  runs: number;
  bestScore: number;
  bestDepth: number;
  bestTime: number;
  /**
   * §20 — preferences, kept in their own object rather than beside the
   * progression fields. §15.1's guard scans this shape for numbers that could
   * become multipliers, and a volume slider sitting next to `bestScore` would
   * either trip it or force the guard to be loosened. Neither is worth it:
   * settings are not progression, so they live somewhere else.
   */
  settings: { muted: boolean; volume: number; track: string };
}

function emptyData(): LibraryData {
  return {
    discoveries: [],
    unlocked: [],
    codex: [],
    runs: 0,
    bestScore: 0,
    bestDepth: 0,
    bestTime: 0,
    settings: { muted: false, volume: 0.7, track: '' },
  };
}

export class Library {
  private data: LibraryData = emptyData();

  constructor() {
    this.load();
  }

  // ------------------------------------------------------------------ storage

  private load(): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Partial<LibraryData>;
      // Merge field by field rather than trusting the blob: a Library written by
      // an older build must never crash a newer one, and a hand-edited one must
      // never crash anything.
      const base = emptyData();
      this.data = {
        discoveries: array(parsed.discoveries) ?? base.discoveries,
        unlocked: array(parsed.unlocked) ?? base.unlocked,
        codex: array(parsed.codex) ?? base.codex,
        runs: number(parsed.runs) ?? base.runs,
        bestScore: number(parsed.bestScore) ?? base.bestScore,
        bestDepth: number(parsed.bestDepth) ?? base.bestDepth,
        bestTime: number(parsed.bestTime) ?? base.bestTime,
        settings: {
          muted: parsed.settings?.muted === true,
          volume: number(parsed.settings?.volume) ?? base.settings.volume,
          // '' means "let the seed choose", which is the default and the one
          // that keeps a shared seed sounding the same for everyone.
          track: typeof parsed.settings?.track === 'string' ? parsed.settings.track : '',
        },
      };
    } catch {
      // A corrupt Library costs you unlocks, not the ability to play.
      this.data = emptyData();
    }
  }

  private save(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.data));
    } catch {
      // Private browsing, quota, disabled storage. Play on without persistence.
    }
  }

  // -------------------------------------------------------------------- reads

  get snapshot(): Readonly<LibraryData> {
    return this.data;
  }

  get earnedDiscoveries(): ReadonlySet<string> {
    return new Set(this.data.discoveries);
  }

  /** Node ids this account may be offered. Passed into the run, never read live. */
  get availableNodes(): string[] {
    const unlocked = new Set(this.data.unlocked);
    return ALL_NODES.filter((n) => !LOCKED_AT_START.includes(n.id) || unlocked.has(n.id)).map(
      (n) => n.id,
    );
  }

  get availableAxioms(): string[] {
    const unlocked = new Set(this.data.unlocked);
    return AXIOMS.filter((a) => STARTING_AXIOMS.includes(a.id) || unlocked.has(a.id)).map(
      (a) => a.id,
    );
  }

  isUnlocked(id: string): boolean {
    if (!LOCKED_AT_START.includes(id) && !AXIOMS.some((a) => a.id === id)) return true;
    if (STARTING_AXIOMS.includes(id)) return true;
    return this.data.unlocked.includes(id);
  }

  /** Which Discovery, if any, is the key to a given locked id. */
  unlockedBy(id: string): string | null {
    return DISCOVERIES.find((d) => d.unlocks.includes(id))?.id ?? null;
  }

  // ------------------------------------------------------------------- writes

  /**
   * Bank a Discovery. Returns the ids it unlocked that were not already held —
   * the caller shows those, and showing "unlocked: nothing new" would be worse
   * than showing nothing.
   */
  earn(discoveryId: string): string[] {
    const def = DISCOVERIES.find((d) => d.id === discoveryId);
    if (!def) return [];
    if (!this.data.discoveries.includes(discoveryId)) this.data.discoveries.push(discoveryId);

    const fresh = def.unlocks.filter((u) => !this.data.unlocked.includes(u));
    this.data.unlocked.push(...fresh);
    this.save();
    return fresh;
  }

  /** §15.2 — Codex entries fill in on first encounter. */
  see(enemyIds: Iterable<string>): void {
    let changed = false;
    for (const id of enemyIds) {
      if (this.data.codex.includes(id)) continue;
      this.data.codex.push(id);
      changed = true;
    }
    if (changed) this.save();
  }

  setAudio(muted: boolean, volume: number): void {
    this.data.settings = { ...this.data.settings, muted, volume };
    this.save();
  }

  setTrack(track: string): void {
    this.data.settings = { ...this.data.settings, track };
    this.save();
  }

  recordRun(result: { score: number; depth: number; time: number }): void {
    this.data.runs++;
    this.data.bestScore = Math.max(this.data.bestScore, result.score);
    this.data.bestDepth = Math.max(this.data.bestDepth, result.depth);
    this.data.bestTime = Math.max(this.data.bestTime, result.time);
    this.save();
  }

  /** Debug and "start over" only. */
  reset(): void {
    this.data = emptyData();
    this.save();
  }
}

function array(v: unknown): string[] | null {
  return Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : null;
}
function number(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
