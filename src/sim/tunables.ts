/**
 * Every number the design document marks [T] lives here, in one file, so the
 * first-playable tuning pass (GDD §25.2) has a single surface to work on and the
 * headless harness can sweep it.
 *
 * TUNABLE   = GDD-marked [T]. Free to change during prototyping.
 * LOADBEARING = unmarked in the GDD. Changing one is a design conversation (§0).
 */

/** Fixed simulation step. Not a design number — a determinism guarantee. */
export const SIM_HZ = 60;
export const SIM_DT = 1 / SIM_HZ;

export const TUNABLE = {
  // ---- §4.1 avatar ----
  playerIntegrity: 100,
  playerMoveSpeed: 260, // arena units/sec; ~2.5s to cross the 1600-wide arena at ~1.5 crossings
  dashDuration: 0.15,
  dashSpeedMult: 3,
  dashIFrames: 0.15,
  dashCooldown: 3,
  collectRadius: 46, // ~1.5x avatar diameter
  playerRadius: 15,

  // ---- §6 cycles & heat ----
  cycleCapacityBase: 100,
  /** Regen per second == capacity (GDD §6.1: "regenerating at capacity/sec"). */
  cycleRegenPerCapacity: 1.0,
  /** Cycles of unmet demand -> Heat points. */
  heatPerCycleDeficit: 1.0,
  heatDecayPerSec: 8,
  overheatStallSeconds: 3,
  overheatHeatReset: 50,
  instability1Misfire: 0.05,
  instability2Misfire: 0.15,
  instability2Corruption: 0.1,

  // ---- §7 fuel ----
  fuelGaugeCap: 100,
  fuelPerKill: 1,
  fuelPerElite: 5,
  fueledFireOutputBonus: 0.5,

  // ---- §8 leveling & draft ----
  xpBase: 26,
  xpGrowth: 1.2,
  xpPerShard: 1,
  draftCards: 3,
  rerollsPerRun: 2,
  purgesPerRun: 1,
  maxQueuedDrafts: 3,
  capacityUpgradeAmount: 15,

  // ---- §5.7 scrap ----
  scrapOutputBonus: 0.04,

  // ---- §12 director ----
  /** Threat reaches ~24 by the 20:00 Meltdown line — the scale wave bands use. */
  threatPerSecond: 0.02,
  waveIntervalBase: 7.0,
  waveIntervalPerThreat: 0.2,
  waveIntervalMin: 2.0,
  /**
   * Soft population throttle. The director stops adding to the arena above this,
   * which keeps a starting engine from being buried before it can be built and
   * keeps entity counts inside the §16.1 legibility budget. Difficulty still
   * comes from composition and Threat (§11 bans HP inflation, not density caps).
   */
  maxAliveBase: 70,
  maxAlivePerThreat: 16,
  /**
   * §12.2 — "No spawn-on-top-of-player, ever." The guarantee is load-bearing;
   * only the radius is tunable. Enforced in World.updateDirector.
   */
  spawnSafeRadius: 260,

  // ---- §13 scoring ----
  epsSmoothingWindow: 5,
} as const;

export const LOADBEARING = {
  /** §5.1 — Programs start at 4, expandable to 8. */
  programSlotsStart: 4,
  programSlotsMax: 8,
  /** §5.1 — three modifier slots per Program. */
  modifierSlotsPerProgram: 3,
  /** §5.2 — hard cascade depth cap. Runtime safety, not balance. */
  cascadeDepthCap: 12,
  /** §5.5 — Split makes 3 copies. */
  splitCopies: 3,
} as const;

/**
 * Runtime safety valves. Not design numbers: these exist so a degenerate build
 * cannot hang the browser. Crossing one is a bug worth logging, never a balance
 * lever (GDD §5.2: "The wall exists for the runtime's safety, not for balance").
 */
export const SAFETY = {
  maxEventsPerTick: 24000,
  maxEntities: 6000,
  maxFireExecutions: 256,
  maxScheduledFires: 8000,
} as const;

/** §22 — The Heap. Fixed arena, no camera in M1. */
export const ARENA = {
  width: 1600,
  height: 900,
} as const;
