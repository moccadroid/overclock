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
  telegraph: 0.95,
  /** 3 — enemies, elites, player effects at the moment they fire. */
  entity: 0.88,
  /** 4 — projectiles and effects in flight, fuel and XP pickups. */
  inFlight: 0.74,
  /** 5 — arena structure, grid, annotations, spent trails. */
  structure: 0.26,
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
  /**
   * §20.1 exposes this as "Bloom intensity 0-100% (default 70)". The first pass
   * sat at the documented default and read dull — the bands beneath it were too
   * conservative, so the glow had nothing bright to work with. Emissives now sit
   * higher and bloom harder, which also leaves Meltdown somewhere to escalate to.
   */
  bloomIntensity: 1.05,
  bloomStrength: 20,
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
  /** World units between grid vertices while anything is warping space. */
  gridWarpStep: 26,

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


/**
 * §20.1 — visual presets.
 *
 * Sliders were the wrong control. Three of them means eight combinations that
 * look wrong for every one that looks good, and a "0%" that turned the game off
 * rather than turning an effect off — because they were multipliers over a
 * baseline that already *is* the look.
 *
 * So: presets, and **SCHEMATIC is the floor, not the middle.** It is exactly what
 * the game looked like before any of this existed — §16's restrained document,
 * which is the design. Everything above it is a player choosing excess, and the
 * excess is allowed to be genuinely excessive.
 */
export interface ViewPreset {
  id: string;
  name: string;
  note: string;
  /** Multiplier over VISUAL.bloomIntensity. 1 = the tuned baseline. */
  bloom: number;
  /** Emissive brightness before the blur — how hot things burn. */
  glow: number;
  /** §17.2 screenshake, which some people cannot tolerate at all. */
  shake: number;
  /** Post-pass, all zero at the floor. See gfx/post.ts. */
  barrel: number;
  aberration: number;
  scan: number;
  grain: number;
  vignette: number;
  bleed: number;
}

export const VIEW_PRESETS: ViewPreset[] = [
  {
    id: 'schematic',
    name: 'Schematic',
    note: 'the drawing, undecorated. What §16 actually asks for.',
    bloom: 1,
    glow: 1,
    shake: 1,
    barrel: 0,
    aberration: 0,
    scan: 0,
    grain: 0,
    vignette: 0,
    bleed: 0,
  },
  {
    id: 'phosphor',
    name: 'Phosphor',
    note: 'a CRT in a dark room. Scanlines, a curved tube, light that lingers.',
    bloom: 2,
    glow: 1.35,
    shake: 1,
    barrel: 0.07,
    aberration: 0.3,
    scan: 0.26,
    grain: 0.07,
    vignette: 0.3,
    bleed: 0.3,
  },
  {
    id: 'overdrive',
    name: 'Overdrive',
    note: 'too much light and no apology for it. Everything bleeds outward.',
    bloom: 3.2,
    glow: 1.8,
    shake: 1.15,
    barrel: 0.05,
    aberration: 0.45,
    scan: 0.1,
    grain: 0.09,
    vignette: 0.34,
    bleed: 0.95,
  },
  {
    id: 'divergence',
    name: 'Divergence',
    note: 'the Meltdown look, all the time. Barely legible, and that is the point.',
    bloom: 4.2,
    glow: 2.2,
    shake: 1.35,
    barrel: 0.14,
    aberration: 0.85,
    scan: 0.3,
    grain: 0.16,
    vignette: 0.42,
    bleed: 1.4,
  },
];

export const VIEW_PRESET_BY_ID = new Map(VIEW_PRESETS.map((p) => [p.id, p]));

/** The live view settings. Mutated by `applyPreset`; read by the renderer. */
export const VIEW: ViewPreset = { ...VIEW_PRESETS[0]! };

export function applyPreset(id: string): void {
  Object.assign(VIEW, VIEW_PRESET_BY_ID.get(id) ?? VIEW_PRESETS[0]!);
}
