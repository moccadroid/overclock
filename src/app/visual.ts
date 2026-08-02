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
 * §20.1 — the visual effects, as toggles.
 *
 * Presets were the wrong shape twice over. As sliders they gave eight
 * combinations that look wrong for every one that looks good; as four named
 * bundles they made every choice all-or-nothing, so wanting lighting but not
 * scanlines meant picking the bundle that had both and living with it.
 *
 * Toggles are the honest control: each one is a single effect at a value tuned
 * to look right *on its own*, and they stack. Turn everything off and you have
 * §16's restrained schematic, unchanged and not paying for a single shader.
 * Turn everything on and the arena is lit by your own engine and barely legible.
 *
 * LIGHTING is the one that matters. The rest are lens dressing on top of a
 * picture; lighting changes what the picture *is*.
 */
export interface ViewEffect {
  id: string;
  name: string;
  note: string;
  /** What this effect contributes. Combined by taking the max of each field. */
  values: Partial<ViewState>;
}

export interface ViewState {
  /** Multiplier over VISUAL.bloomIntensity. 1 = the tuned baseline. */
  bloom: number;
  /** Emissive brightness before the blur — how hot things burn. */
  glow: number;
  /** §17.2 screenshake, which some people cannot tolerate at all. */
  shake: number;
  /** How much light surfaces catch. See gfx/lights.ts. */
  lit: number;
  /** How much light is visible in the air. */
  haze: number;
  barrel: number;
  aberration: number;
  scan: number;
  grain: number;
  vignette: number;
  bleed: number;
}

const BASE: ViewState = {
  bloom: 1,
  glow: 1,
  shake: 1,
  lit: 0,
  haze: 0,
  barrel: 0,
  aberration: 0,
  scan: 0,
  grain: 0,
  vignette: 0,
  bleed: 0,
};

export const VIEW_EFFECTS: ViewEffect[] = [
  {
    id: 'lighting',
    name: 'Lighting',
    note: 'everything emits. Shots light the grid they fly over; a Nova floods the room.',
    values: { lit: 0.22, haze: 0.4, glow: 1.15 },
  },
  {
    id: 'bloom',
    name: 'Bloom',
    note: 'light spills past its edges, and keeps spilling. Three stacked passes.',
    values: { bloom: 2.2, glow: 1.3 },
  },
  {
    id: 'chromatic',
    name: 'Chromatic',
    note: 'the lens splits colour toward the edges, the way real glass does.',
    values: { aberration: 0.6 },
  },
  {
    id: 'tube',
    name: 'Tube',
    note: 'a CRT: curved glass, scanlines, and darkness in the corners.',
    values: { barrel: 0.09, scan: 0.3, vignette: 0.36 },
  },
  {
    id: 'grain',
    name: 'Grain',
    note: 'the black field is never quite black. Animated, subtle, alive.',
    values: { grain: 0.11 },
  },
];

export const VIEW_EFFECT_IDS = VIEW_EFFECTS.map((e) => e.id);

/** The live view state. Mutated by `applyEffects`; read by the renderer. */
export const VIEW: ViewState = { ...BASE };

/**
 * Combine the enabled effects.
 *
 * Max rather than sum: two effects that both raise `glow` should not raise it
 * twice, and an effect's tuned value is what it should look like whether or not
 * something else happens to touch the same field.
 */
export function applyEffects(enabled: readonly string[]): void {
  Object.assign(VIEW, BASE);
  for (const id of enabled) {
    const effect = VIEW_EFFECTS.find((e) => e.id === id);
    if (!effect) continue;
    for (const [key, value] of Object.entries(effect.values)) {
      const k = key as keyof ViewState;
      VIEW[k] = Math.max(VIEW[k], value as number);
    }
  }
}
