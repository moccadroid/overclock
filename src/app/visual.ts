/**
 * Visual constants for the §16/§17 dialect: blueprint structure, phosphor
 * behaviour.
 *
 * These are presentation-only — nothing here may affect simulation outcomes
 * (§20.1 requires particle density and trail length to be user settings that
 * "never change gameplay outcomes"). Most of this file becomes the Video
 * settings panel in a later milestone.
 */

/**
 * §16.2 — the legibility law. Reserved luminance bands, strictly enforced.
 * Nothing but the player may sit at 1.0, ever: you must be able to find yourself
 * in a full-chaos screenshot in under a second (§23.3).
 */
export const BAND = {
  /** 1 — the player. Nothing else. */
  player: 1.0,
  /** 2 — active threats mid-telegraph. */
  telegraph: 0.85,
  /** 3 — enemies, elites, player effects at the moment they fire. */
  entity: 0.7,
  /** 4 — projectiles and effects in flight, fuel and XP pickups. */
  inFlight: 0.5,
  /** 5 — arena structure, grid, annotations, spent trails. */
  structure: 0.22,
} as const;

export const PALETTE = {
  background: 0x060a12,
  structure: 0x2a3a52,
  player: 0xffffff,
  thermal: 0xffb000,
  voltaic: 0x00e5ff,
  void: 0xb44cff,
  /** Reserved exclusively for "you are being hurt / your engine is corrupted". */
  signal: 0xff2a3c,
  xp: 0xdfe8f5,
  beacon: 0x9fd0ff,
} as const;

export const VISUAL = {
  // ---- §16.1 bloom ----
  /** Becomes the "Bloom intensity 0-100% (default 70)" setting in §20.1. */
  bloomIntensity: 0.7,
  bloomStrength: 14,
  /** Bloom runs at reduced resolution; it is a glow, not a detail pass. */
  bloomResolution: 0.4,

  // ---- §16.4 / §17 motion ----
  /** Seconds an entity takes to trace itself in. */
  drawInTime: 0.26,
  /** Seconds a killed entity's line segments take to fade. */
  decomposeTime: 0.42,
  decomposeSpeed: 110,
  /** §17.2 — victim's stroke flashes white before decomposition. */
  killFlashTime: 0.05,
  /** Trail length in seconds of travel; becomes the §20.1 trail setting. */
  trailSeconds: 0.055,
  trailSegments: 5,
  /** Player dash afterimages. */
  afterimageCount: 3,
  afterimageTime: 0.22,

  // ---- §17.2 impact ----
  /** Hitstop per significant kill, and the hard per-second budget on it, so a
   *  cascade reads as a stutter-roar rather than a freeze. */
  hitstopSeconds: 0.024,
  hitstopBudgetPerSec: 0.12,
  /** Screenshake: tiny, frequent, hard ceiling regardless of chaos. */
  shakePerKill: 0.5,
  shakeMax: 7,
  shakeDecay: 9,

  // ---- §16.5 the grid as an instrument ----
  gridSpacing: 120,
  /** How far the grid distorts around the avatar under load, in world units. */
  gridWarpRadius: 260,
  gridWarpAmount: 13,
  gridSubdivisions: 10,

  // ---- §16.7 degradation ladder ----
  /** 1: vertex jitter on player effects (Instability I). */
  jitterInstability1: 1.1,
  /** 2: chromatic aberration at screen edges (Instability II). */
  aberrationInstability2: 3.2,
  /** 4: scanline tears on Overheat. */
  tearBands: 5,
  tearAmount: 26,
  /**
   * §21 — photosensitivity is a first-class constraint. Every ladder step ships
   * with a reduced variant at design time; this scales all of them at once and
   * becomes the §20.4 master toggle. 1 = full, 0.2 = safe mode.
   */
  degradationIntensity: 1,
} as const;

export type Band = keyof typeof BAND;
