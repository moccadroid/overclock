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
 *
 * **This module is storage.** It used to also own the gating rules, as a
 * hand-written `LOCKED_AT_START` array that no test could reconcile with the
 * Discoveries that were supposed to open it — and which listed two ids that
 * were not nodes at all. Deciding what is available is progression's job now
 * (src/meta/progression.ts); this remembers what you have earned and asks.
 */
import { DISCOVERIES } from '../content/index';
import { ACTIVE, grantedBy, grantsOf, resolve, type ProgressionDef } from './progression';

const STORAGE_KEY = 'overclock.library.v1';

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
  settings: {
    muted: boolean;
    /**
     * Three levels, because "the music is too loud" and "the shots are too
     * loud" are different complaints and one slider can only answer one.
     * `volume` is the master; the other two attenuate under it.
     */
    volume: number;
    music: number;
    effects: number;
    /**
     * §20.1 — which visual effects are on. Ids, like everything else here: the
     * numbers live in `visual.ts` where they can be tuned together, and §15.1's
     * no-numbers guard stays honest by construction rather than by exception.
     */
    fx: string[];
    /**
     * §18.2 — hold a detonation's picture for the next sixteenth, up to ~34ms.
     * Its own flag rather than one of `fx`, because the quality presets sweep
     * that list and this is a feel decision, not a fidelity one.
     */
    beatSync: boolean;
    /**
     * Which tube the terminal is being read on. An id from `PHOSPHOR`.
     *
     * Its own setting rather than one of `fx`, for the same reason `beatSync`
     * is: the `fx` list is swept by the quality presets, and this is not a
     * fidelity decision. Choosing amber costs you the ability to tell thermal
     * from signal red — a real trade the presets have no business making.
     */
    phosphor: string;
    /** Scanline depth on the terminal, 0..1. 0 is a flat panel. */
    scanlines: number;
  };
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
    settings: {
      muted: false,
      volume: 0.7,
      music: 0.85,
      effects: 0.9,
      fx: ['lighting', 'bloom'],
      beatSync: true,
      phosphor: 'colour',
      scanlines: 0.3,
    },
  };
}

export class Library {
  private data: LibraryData = emptyData();

  /**
   * Which gating graph this Library answers under. Defaults to the active one,
   * so nothing at a call site has to know progression exists — but it is an
   * argument rather than a global read, which is what lets a test (or the
   * harness) exercise §15.2's curated pool while the shipped profile is open.
   */
  constructor(private readonly progression: ProgressionDef = ACTIVE) {
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
          music: number(parsed.settings?.music) ?? base.settings.music,
          effects: number(parsed.settings?.effects) ?? base.settings.effects,
          fx: array(parsed.settings?.fx) ?? base.settings.fx,
          beatSync: parsed.settings?.beatSync !== false,
          phosphor: string(parsed.settings?.phosphor) ?? base.settings.phosphor,
          scanlines: number(parsed.settings?.scanlines) ?? base.settings.scanlines,
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

  /**
   * What this account may use, resolved fresh from the gating graph every time.
   *
   * `unlocked` is still consulted rather than trusted alone: it is what a stored
   * Library banked under whatever graph was in force when it was written, so an
   * account never loses a node because the graph was re-cut. Everything else is
   * derived, which is what lets progression.json be edited — or switched off —
   * without a migration.
   */
  private get library(): { nodes: string[]; axioms: string[] } {
    return resolve(this.data.discoveries, {
      progression: this.progression,
      alsoGranted: this.data.unlocked,
    });
  }

  /** Node ids this account may be offered. Passed into the run, never read live. */
  get availableNodes(): string[] {
    return this.library.nodes;
  }

  get availableAxioms(): string[] {
    return this.library.axioms;
  }

  isUnlocked(id: string): boolean {
    const { nodes, axioms } = this.library;
    return nodes.includes(id) || axioms.includes(id);
  }

  /** Which Discovery, if any, is the key to a given gated id. */
  unlockedBy(id: string): string | null {
    return grantedBy(id, this.progression);
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

    // Banked as well as derived. Deriving alone would be enough to *play*, but
    // the stored list is what survives a later re-cut of the gating graph, and
    // §15.2's promise is that the Library only ever grows.
    const fresh = grantsOf(discoveryId, this.progression).filter(
      (u) => !this.data.unlocked.includes(u),
    );
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

  setAudio(levels: Partial<Pick<LibraryData['settings'], 'muted' | 'volume' | 'music' | 'effects'>>): void {
    this.data.settings = { ...this.data.settings, ...levels };
    this.save();
  }

  toggleEffect(id: string): void {
    const on = this.data.settings.fx;
    const fx = on.includes(id) ? on.filter((e) => e !== id) : [...on, id];
    this.data.settings = { ...this.data.settings, fx };
    this.save();
  }

  /** The tube the terminal is read on, and how hard the beam misses a row. */
  setGlass(g: Partial<Pick<LibraryData['settings'], 'phosphor' | 'scanlines'>>): void {
    this.data.settings = { ...this.data.settings, ...g };
    this.save();
  }

  setBeatSync(beatSync: boolean): void {
    this.data.settings = { ...this.data.settings, beatSync };
    this.save();
  }

  /** §20.1 — set the whole visual toggle set at once, for the quality presets. */
  setEffects(fx: string[]): void {
    this.data.settings = { ...this.data.settings, fx: [...fx] };
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
function string(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}
