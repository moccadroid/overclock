/**
 * Discoveries. GDD §15.3.
 *
 * "Discoveries are the tutorialization system — the game teaches its own
 * exploits by naming them." There is no tutorial level (§15.4); this is what
 * replaces it. Each one is a thing a player might do by accident, caught and
 * named the moment it happens, with a line explaining why it mattered.
 *
 * Detection lives in the sim and is therefore deterministic: the same seed and
 * the same inputs earn the same Discoveries in the same order. Granting them —
 * writing to the Library, unlocking nodes — is the app's job, because that
 * touches storage and the sim never does.
 *
 * The player-facing half (name, hint, what it teaches, what it unlocks) is data
 * in discoveries.json. The condition is code, because a condition is code. The
 * two are cross-checked at load: an id in one and not the other is a build
 * error, not a silent no-op.
 */
import { DISCOVERIES } from '../content/index';
import type { World } from './world';

/** Timers and edge-detectors a condition needs across ticks. */
export interface DiscoveryState {
  /** Seconds held continuously in each Heat tier, reset by an Overheat. */
  tierHeld: [number, number, number, number];
  /** Seconds firing with no Clock-driven row live. */
  unclockedFiring: number;
  overheatsSeen: number;
  /** Reached Instability II and came back down without an Overheat. */
  recoveredFromTier2: boolean;
  /** Overheat count when tier 2 was last entered, to tell recovery from reset. */
  tier2At: number;
}

export type DiscoveryCheck = (w: World, s: DiscoveryState) => boolean;

/** Does this Program's Trigger drive itself, independent of your output? */
function isSelfDriving(triggerId: string | null): boolean {
  return triggerId === 'clock' || triggerId === 'on_wave';
}

export const DISCOVERY_CHECKS: Record<string, DiscoveryCheck> = {
  first_cut: (w) => w.engine.scrapStacks > 0,
  sculptor: (w) => w.purged.size >= 4,
  chain_reaction: (w) => w.stats.maxDepth >= 4,
  depth_six: (w) => w.stats.maxDepth >= 6,
  deep_six: (w) => w.stats.maxDepth >= 10,

  // Firing while nothing metronomic is live: the Engine is feeding itself.
  self_sustaining: (_w, s) => s.unclockedFiring >= 10,

  surfing: (w, s) => s.tierHeld[1] >= 45 && s.overheatsSeen === w.stats.overheats,
  deep_water: (w, s) => s.tierHeld[2] >= 20 && s.overheatsSeen === w.stats.overheats,

  controlled_burn: (w) =>
    w.engine.programs.some(
      (p, i) => p.triggerId === 'on_overheat' && p.actionId !== null && w.engine.compiled[i]?.live,
    ) && w.stats.overheats > 0,

  arbitrage: (w) => w.stats.converts >= 20,
  // Fuel is gone; these two now measure the thing that replaced it. Running
  // deep and staying cold is the skill the new economy actually asks for.
  full_tanks: (w) => w.stats.maxDepth >= 8 && w.stats.overheats === 0,
  siphoned: (w) => w.budget.heat >= 60 && w.stats.maxDepth >= 6,

  flank_it: (w) => w.stats.killsByEnemy.get('bulwark') !== undefined,
  blackout: (w) => w.stats.suppressedKills > 0,
  untouchable: (w) => w.time >= 180 && w.stats.damageTaken === 0,
  swarmed: (w) => w.stats.peakConcurrentEnemies >= 120,

  prestige: (w) => w.kernels > 0,
  divergence: (w) => w.phase === 'meltdown',
  double_or_nothing: (w) => w.peakMeltdownMultiplier >= 2,
  contained: (w) => w.ending === 'contained',
  beacon_runner: (w) => w.stats.beaconsChannelled >= 3,

  wide_load: (w) => w.engine.compiled.filter((c) => c.live).length >= 5,
  overtuned: (w) => {
    const live = w.engine.programs.filter((_, i) => w.engine.compiled[i]?.live);
    if (live.length < 3) return false;
    const total = live.reduce((s, p) => s + p.recentEvents, 0);
    if (total < 40) return false;
    return live.some((p) => p.recentEvents / total >= 0.9);
  },
  critical_mass: (w) => w.stats.crits >= 200,
  volatile_thinking: (w) => w.stats.peakEps >= 400,
  bloodletting: (w) => w.stats.desperateConverts > 0,

  // §7.3 / §10.2 / §11.2 — the systems added after the first pass, each taught
  // by the thing a player does with it by accident before they do it on purpose.
  magnetised: (w) => w.stats.magnets >= 3,
  force_fed: (w) => w.stats.gluttonsPopped > 0,
  trespass: (w) => w.stats.suppressorsKilledInside > 0,
  deep_end: (w) => w.stats.maxDepth >= 8 && w.stats.overheats === 0,
  thermostat: (_w, s) => s.recoveredFromTier2,
  reflection: (w) => w.engine.compiled.filter((c) => c.live).length >= 5,
};

/**
 * Watches a run and reports Discoveries as they are earned. One instance per
 * World; `drain()` hands the ids to the presentation layer exactly once.
 */
export class DiscoveryTracker {
  readonly earned = new Set<string>();
  private readonly pending: string[] = [];
  private readonly state: DiscoveryState = {
    tierHeld: [0, 0, 0, 0],
    unclockedFiring: 0,
    overheatsSeen: 0,
    recoveredFromTier2: false,
    tier2At: -1,
  };

  /** Ids already in the player's Library, so a repeat does not re-announce. */
  constructor(private readonly already: ReadonlySet<string> = new Set()) {}

  update(world: World, dt: number): void {
    this.advanceState(world, dt);

    for (const d of DISCOVERIES) {
      if (this.earned.has(d.id)) continue;
      const check = DISCOVERY_CHECKS[d.id];
      if (!check || !check(world, this.state)) continue;
      this.earned.add(d.id);
      // Already in the Library: it still counts for score, but the stinger is
      // for the first time. Nobody wants to be taught the same thing twice.
      if (!this.already.has(d.id)) this.pending.push(d.id);
    }
  }

  private advanceState(world: World, dt: number): void {
    const tier = world.budget.tier;
    // An Overheat is the failure this is measuring survival against, so it
    // resets every held-tier timer rather than only the one you were in.
    if (world.stats.overheats > this.state.overheatsSeen) {
      this.state.overheatsSeen = world.stats.overheats;
      this.state.tierHeld = [0, 0, 0, 0];
    }
    for (let t = 0; t < 4; t++) this.state.tierHeld[t] = t === tier ? this.state.tierHeld[t]! + dt : 0;

    // Thermostat: went up into II and came back down with the Engine intact.
    if (tier >= 2) this.state.tier2At = world.stats.overheats;
    else if (tier <= 1 && this.state.tier2At === world.stats.overheats && this.state.tier2At >= 0) {
      this.state.recoveredFromTier2 = true;
    }

    const selfDriven = world.engine.programs.some(
      (p, i) => world.engine.compiled[i]?.live && isSelfDriving(p.triggerId),
    );
    const firing = world.eps > 1;
    this.state.unclockedFiring = !selfDriven && firing ? this.state.unclockedFiring + dt : 0;
  }

  /** Hand over newly earned ids. Called by the app, never by the sim. */
  drain(): string[] {
    return this.pending.splice(0, this.pending.length);
  }
}
