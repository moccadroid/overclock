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
  /** §4.1 — crossing the visible field takes roughly 3s at this speed. */
  playerMoveSpeed: 300,
  dashDuration: 0.15,
  dashSpeedMult: 3,
  dashIFrames: 0.15,
  dashCooldown: 3,
  /**
   * §4.1 says ~1.5x avatar diameter (=46). That was sized for a boxed arena; in
   * an open world the player outruns their own drops and the opening starves.
   */
  collectRadius: 95,
  playerRadius: 15,

  // ---- §6 cycles & heat ----
  cycleCapacityBase: 100,
  /** Regen per second == capacity (GDD §6.1: "regenerating at capacity/sec"). */
  cycleRegenPerCapacity: 1.0,
  /**
   * Heat accrues from how far over budget you are, not from raw unmet Cycles.
   *
   * Charging Heat per deficit-Cycle made a single big cascade tick cross the
   * whole 0-100 band, so Overheat became a wall the engine bounced off every few
   * seconds — the opposite of §6.3's "dial, not a line". Instead: overdraw is
   * measured as a multiple of what regen supplies, and Heat climbs at a bounded
   * rate. Running at 2x budget is a place you can live; running at 10x is not.
   */
  heatGainPerOverdraw: 22,
  heatGainMaxPerSec: 45,
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
  xpBase: 11,
  xpGrowth: 1.3,
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
   * Enemies this far from the player are silently removed, with no drops. Not in
   * the GDD, but required once the arena is bigger than the view: without it,
   * stragglers the player has outrun accumulate forever and eat the population
   * budget that should be producing pressure where the player actually is.
   */
  despawnRadius: 2600,
  /**
   * §12.2 — "No spawn-on-top-of-player, ever." The guarantee is load-bearing;
   * only the radius is tunable. Enforced in World.updateDirector.
   */
  spawnSafeRadius: 260,
  /**
   * §12.2 — spawns arrive off-screen. The sim has no camera (that would make the
   * simulation depend on the viewport and break determinism across window
   * sizes), so it spawns on a ring sized to sit just outside a nominal view.
   */
  spawnRingMin: 1050,
  spawnRingMax: 1350,

  // ---- §12.3 wave beacons ----
  beaconInterval: 75,
  beaconChannelTime: 1.5,
  beaconDropBonus: 0.5,
  beaconThreatBump: 1.0,
  beaconRadius: 34,
  maxBeacons: 2,

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

/**
 * Camera. The arena is authored content (src/content/data/arenas.json), far
 * larger than the viewport — §19.4's off-screen edge indicators and §12.3's
 * beacons only mean anything if there is somewhere to be that you cannot see.
 */
export const CAMERA = {
  /** Design width of the visible field. The view scales to fit the window. */
  viewWidth: 1600,
  viewHeight: 900,
  /** How far the view leads the player's movement, in world units. */
  lookahead: 130,
  /** Seconds for the camera to close most of the distance to its target. */
  smoothing: 0.12,
} as const;
