/**
 * Visual constants for the §16/§17 dialect: blueprint structure, phosphor
 * behaviour.
 *
 * These are presentation-only — nothing here may affect simulation outcomes
 * (§20.1 requires particle density and trail length to be user settings that
 * "never change gameplay outcomes"). Most of this file becomes the Video
 * settings panel in a later milestone.
 */
import type { Hue } from '../sim/types';

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
  /**
   * The mass: everything you cannot walk through.
   *
   * Neutral, not blue, and **darker than the floor in every channel**. Both
   * halves matter. The hue separation is what makes a block read as absence
   * rather than as a dark piece of the same room; the value ordering is what
   * keeps structure out of the bands above it (§16.2).
   *
   * The value is not a taste call, it is arithmetic. `background` is (0.024,
   * 0.039, 0.071); the first attempt at this sat at 0x0b0b0f, which is *higher*
   * in red and green — so the blocks were literally brighter than the ground
   * they sat on and read, correctly, as grey boxes.
   */
  mass: 0x030309,
  player: 0xffffff,
  thermal: 0xffb000,
  voltaic: 0x00e5ff,
  void: 0xb44cff,
  /** Reserved exclusively for "you are being hurt / your engine is corrupted". */
  signal: 0xff2a3c,
  xp: 0xdfe8f5,
  beacon: 0x9fd0ff,
} as const;

/**
 * §16.3 — hue is threat class, so this is the one table that says what a hue
 * looks like.
 *
 * It was three tables: the renderer's, a copy in the shell's title screen, and a
 * third in the file register. Three places to edit when a hue moves, and the
 * shell's copies were already the thing making the register's plate not match
 * the fight it describes. There is one now, and it lives beside the palette it
 * reads from.
 */
export const HUE_COLOR: Record<Hue, number> = {
  thermal: PALETTE.thermal,
  voltaic: PALETTE.voltaic,
  void: PALETTE.void,
};

/**
 * §21b.5 — the gate opening, as a score rather than a formula.
 *
 * The first version was one eased number over a fixed duration, which meant
 * every change to the choreography was a change to an expression: the pause
 * before it gives, the shove when it does, the light that floods first and dies
 * back — none of those exist as anything you can move. A wall coming down is a
 * *sequence of beats*, and beats want to be data.
 *
 * Each step names where the values should have arrived by the end of it and how
 * to get there. Add a step, reorder them, hold one longer — the renderer plays
 * whatever is here and knows nothing about what the steps mean.
 *
 *   open  0..1  how far the barrier has retracted
 *   glow  0..1  how hot the cut surface burns
 *   shake 0..1  screenshake, scaled by the §17.2 ceiling
 */
export interface GateStep {
  seconds: number;
  open: number;
  glow: number;
  shake: number;
  /** How the step travels to its values. Default 'linear'. */
  ease?: 'linear' | 'in' | 'out';
}

export const GATE_SEQUENCE: readonly GateStep[] = [
  // It wakes. Light in the seam and a shove, a full second before anything
  // moves — the point is that you cannot be looking elsewhere when it goes.
  { seconds: 1.2, open: 0.01, glow: 0.9, shake: 0.55, ease: 'out' },
  // Then it strains. Barely moving, still shaking: something enormous taking up
  // slack. This is the beat that makes the next one land.
  { seconds: 1.6, open: 0.05, glow: 0.5, shake: 0.3, ease: 'in' },
  // And it goes.
  { seconds: 2.2, open: 0.55, glow: 1, shake: 1, ease: 'in' },
  // Running clear, the light dying back as the passage becomes ordinary space.
  { seconds: 1.4, open: 1, glow: 0.35, shake: 0.6, ease: 'out' },
];
/** Where a gate's animation has got to, `t` seconds in. */
export function sampleGate(t: number): { open: number; glow: number; shake: number; done: boolean } {
  let from = { open: 0, glow: 0, shake: 0 };
  let elapsed = 0;
  for (const step of GATE_SEQUENCE) {
    if (t < elapsed + step.seconds) {
      const k = step.seconds <= 0 ? 1 : (t - elapsed) / step.seconds;
      const e = step.ease === 'in' ? k * k : step.ease === 'out' ? 1 - (1 - k) * (1 - k) : k;
      return {
        open: from.open + (step.open - from.open) * e,
        glow: from.glow + (step.glow - from.glow) * e,
        shake: from.shake + (step.shake - from.shake) * e,
        done: false,
      };
    }
    elapsed += step.seconds;
    from = { open: step.open, glow: step.glow, shake: step.shake };
  }
  return { ...from, done: true };
}

/**
 * §16.5 — the shell, in numbers.
 *
 * Every value the block field uses, in one place, because this is a look that
 * gets tuned by eye and hunting for a constant inside a GLSL string literal is
 * not tuning, it is archaeology.
 */
export const SHELL = {
  /**
   * Block edge length per layer, world units, back to front.
   *
   * The first is the black base and the two after it are the grey mass that
   * covers it. How *many* grey blocks land on a given slab is area over cell
   * squared, so the only lever on density is these two numbers — dropping them
   * by a factor of root two doubles the count. That is the whole of "saturate
   * the black with grey"; it needs no extra layer.
   */
  sizes: [260, 124, 78] as [number, number, number],
  /** Body brightness per layer, as a fraction of PALETTE.mass. */
  shades: [0.5, 0.74, 1.0] as [number, number, number],
  /**
   * Parallax per layer: how far it slides away from the player.
   *
   * Small, and it has to stay small. A block is *sampled* at the parallaxed
   * position but *clipped* against the cap in true world space, so any real
   * amount of this biases the whole mass toward the side facing the player —
   * the far edge gets pulled in behind the clip and the near edge pushed out
   * past it. At 0.064 that read as every obstacle extending mostly on the side
   * you were standing on, which is not depth, it is a lopsided shape.
   */
  depth: [0, 0.01, 0.02] as [number, number, number],
  /**
   * Quarter-notes for one full extend / drag / contract. Eight is two bars,
   * which reads slow and geological; four is brisk, two is restless. This is
   * the dial that decides how agitated the room is.
   */
  cycleBeats: 8,
  /**
   * Shape of the swell across the bar. 1 is a pure cosine — the mass rises into
   * the downbeat and falls away from it, with no instant anywhere.
   *
   * The first version used the audio clock's own envelope, which is a hard jump
   * to 1 on the beat and an exponential decay. That is right for a grid line
   * flashing and wrong for a wall breathing: the step reads as a glitch, not as
   * a pulse. Raise this above 1 to sharpen the peak without reintroducing the
   * discontinuity.
   */
  swell: 1,
  /** How far a block may extend, as a fraction of its wall's reach. */
  extend: 1.6,
  /** Cell inset — the seams between slabs — and how much the bar takes back. */
  inset: 0.04,
  insetPulse: 0.05,
  /**
   * How far inside the mass a cell's centre must sit before it draws, as a
   * fraction of its own size, per layer.
   *
   * Without this, membership is decided at the centre and a 260-unit cell one
   * unit inside the collider paints a 260-unit slab hanging 130 units out of
   * it. Those were the big static spurs — not the animation, quantisation.
   *
   * **Signed.** Positive is a requirement to be inside; negative is permission
   * to be outside.
   *
   * The base is positive and large: the black mass only draws where it is
   * properly inside, so it stays a description of where the collider is. On a
   * ruin narrower than a base cell it never draws at all and the backing — the
   * identical shade — stands in, which is exactly right.
   *
   * The greys are negative, and that is the black-under-grey relationship. They
   * were positive, which is a rule saying "grey may not go near the edge" — the
   * exact opposite of what grey is for. Grey is the layer that overhangs, spills
   * past the black and gets pulled back; it has to be allowed to start outside.
   * `cap` bounds every block regardless, so this costs nothing in collider
   * accuracy — it only decides which cells are allowed to try.
   */
  biases: [0.4, -0.12, -0.2] as [number, number, number],
  /**
   * Per-layer multiplier on the extension. The base barely travels; the grey
   * layers do all the moving.
   */
  layerExtend: [0.1, 1.0, 1.3] as [number, number, number],
  /**
   * Per-layer grid stagger, in cells.
   *
   * Aligned grids share their seams: a column that misses on one layer tends
   * to miss on the next, and across a ruin only one or two cells wide that
   * reads as the grey bunching to one side and leaving the rest bare —
   * permanently, because placement never moves. Half a cell out of step puts
   * one layer's centre over the other's seam.
   */
  gridOffset: [0, 0, 0.5] as [number, number, number],
  /**
   * The smallest share of the reach any block gets.
   *
   * The amplitude is squared, which on its own leaves most blocks barely moving
   * and a few reaching far — a row of nubs with the occasional spike. The floor
   * guarantees every block has some travel in it.
   */
  ampFloor: 0.25,
  /**
   * Ceiling on the extension, as a fraction of the block's own size.
   *
   * A small block on a deep reach elongates to five times its width and reads
   * as a line — the one shape this vocabulary does not have. This is what keeps
   * a slab a slab while the amplitude goes up.
   */
  maxStretch: 0.75,
  /**
   * How much cover the mass gives up directly over the ship, and over what
   * radius in world units.
   *
   * **Zero.** It was 0.7, which does not thin anything — scaling premultiplied
   * coverage by 0.3 inside a 110-unit radius erases the slab, and a measured
   * scan of the mass's alpha showed a hole that tracked the ship as it moved.
   * That is the whole reason the player was never occluded while the enemies
   * always were: the geometry was fine, the avatar was carrying a hole with it.
   *
   * §16.2's "you must be able to find yourself" is real, but the ghost layer
   * already answers it — every emissive reads through the mass as a faint
   * outline, player and enemies alike. Cutting the mass away as well solved the
   * same problem twice, and the second solution undid the effect.
   *
   * Raise it only if the ghost alone proves too subtle, and then in small
   * amounts: anything near 1 is a hole, not a veil.
   */
  veil: 0,
  veilRadius: 110,
  /** Per-cell placement offset, as a fraction of the cell. */
  jitter: 0.12,
  /** The lit top-left hairline. Near zero on purpose. */
  edge: 0.3,
  /**
   * Hard drop shadow: strength, and offset as a fraction of block size.
   *
   * The three layers each cast one, and the shader takes the deepest rather
   * than compounding them — see the shadow pass. Multiplying was what turned a
   * spot lying under all three into a nine-per-cent pit of flat black.
   */
  shadow: 0.5,
  shadowOffset: [0.1, 0.14] as [number, number],
  /**
   * Solid backing over the collider itself, as a fraction of PALETTE.mass.
   *
   * Exactly the darkest layer's shade, so the two are indistinguishable. The
   * backing exists only so a hole can never open onto the floor inside a
   * collider; it must never be *seen* as a surface of its own. Below the layer
   * range it reads as a separate darker plane and the slabs look like they are
   * floating over a pit.
   */
  backing: 0.5,
  /**
   * How much of the light field the mass catches.
   *
   * The mass is drawn above the post pass so light cannot travel through a solid
   * thing — but taking it to zero meant a slab never brightened when a
   * detonation went off beside it, and a room whose walls do not answer light
   * reads as the lighting being switched off. This gives them a share.
   *
   * Small on purpose. In two dimensions there is no telling "beside" from
   * "above", so the same term that lights a wall next to a Nova also lights the
   * slab you are standing under. At this strength the first reads and the second
   * stays under the ghost.
   */
  massLit: 0.6,
  /**
   * What a gate's shake of 1.0 is worth, as a multiple of the §17.2 ceiling.
   *
   * Above 1 on purpose, and it is the only thing in the game allowed past that
   * ceiling. The cap exists so that a screen full of detonations cannot shake
   * itself into nonsense — a hundred small events competing. A gate is one
   * event, once a level, and it is supposed to be the largest thing that has
   * ever happened to the room.
   */
  gateShake: 2.4,
  /**
   * How strongly things under the mass show through it.
   *
   * The alpha of a faint additive copy of the emissive layer, drawn over the
   * mass. Under a slab it is the only thing visible and reads as an outline;
   * over open floor it lands on strokes that are already drawn and does nothing
   * but lift them slightly. Too high and everything on the floor gets brighter
   * than its band allows.
   */
  ghost: 0.22,
  /**
   * §21b.5 — the seal's reach, as a fraction of the barrier's height.
   *
   * Not the size of the source. The hot core is a sixth of this and the halo
   * runs a little past it, cut off at four and a half times out; a barrier 420
   * units tall therefore has a bright point around fifteen units across
   * throwing light four hundred. That ratio *is* the effect. Widening the core
   * to something you can actually see turns it back into a red sticker.
   */
  sealRadius: 0.2,
  /**
   * How hard the seal burns. Multiplies every term, so it is the one dial to
   * reach for. It is emissive — added over the door without touching coverage —
   * so above about 1.6 the core blows the whole doorway to white.
   */
  sealGlow: 1.0,
  /**
   * §21b.5 — the ember bar down each jamb of the doorway.
   *
   * This and the motes below are what replaced fourteen rectangles of bolted-on
   * gate frame. The frame read well and trapped enemies in its own corners;
   * light does the same job and cannot corner anything.
   */
  jambGlow: 0.42,
  /** How thickly the doorway draws motes in along its jambs. */
  gateMotes: 0.8,
  /**
   * How far the outer shell's blocks may hang inward over the floor.
   *
   * The wall itself stands exactly on the arena rect — the collider — and this
   * is only the churn past it. An attempt to move the wall *into* the level
   * with a second inset was reverted: it put up to 355 units of solid black on
   * walkable floor along every edge, which is a lie in the wrong direction and
   * flattened a border that was already right.
   */
  shellReach: 165,
  /**
   * A ruin's churn: a fraction of its short side, hard-capped.
   *
   * This is the *only* difference between how the border behaves and how an
   * obstacle behaves — the shader is one code path. The border has 140 units to
   * move in and reads as architecture rearranging; at 40 an obstacle had barely
   * half a block of travel and read as a wobble with no weight behind it.
   *
   * The cost is honest and worth knowing: ruins block projectiles, so wherever
   * the mass overhangs its collider a shot passes through something that looks
   * solid. That is the forgiving direction — the dangerous one, cover that is
   * smaller than it looks, is ruled out by dilate-never-erode — but it is a lie,
   * and this number is how big the lie is allowed to get. Because the amplitude
   * is squared, typical protrusion is about a third of it; the cap is what a
   * block reaches at the top of its cycle.
   */
  ruinReach: 0.45,
  ruinReachMax: 50,
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
    note: 'shots light the ground they cross',
    values: { lit: 0.4, haze: 0.7, glow: 1.15 },
  },
  {
    id: 'bloom',
    name: 'Bloom',
    note: 'bright things spill past their edges',
    values: { bloom: 2.2, glow: 1.3 },
  },
  {
    id: 'chromatic',
    name: 'Chromatic',
    note: 'colour splits toward the corners',
    values: { aberration: 0.6 },
  },
  {
    id: 'tube',
    name: 'Tube',
    note: 'CRT curve, scanlines, vignette',
    values: { barrel: 0.09, scan: 0.3, vignette: 0.36 },
  },
  {
    id: 'grain',
    name: 'Grain',
    note: 'the black is never quite black',
    values: { grain: 0.11 },
  },
];

export const VIEW_EFFECT_IDS = VIEW_EFFECTS.map((e) => e.id);

/**
 * §20.1 — named starting points, with the toggles still underneath.
 *
 * Presets alone were rejected once already, and correctly: wanting lighting but
 * not scanlines meant taking a bundle with both. But five checkboxes with a
 * paragraph each is documentation, not a settings screen — you have to read the
 * whole thing before you can change anything.
 *
 * So: pick a preset in one click, or open the toggles and disagree with it. The
 * preset row reads CUSTOM the moment your set is not one of these, which is the
 * part that makes both halves honest.
 */
export const VIEW_PRESETS: { id: string; name: string; effects: string[] }[] = [
  { id: 'off', name: 'OFF', effects: [] },
  { id: 'minimal', name: 'MINIMAL', effects: ['lighting'] },
  // The shipped default, so a player who has never opened this screen sees a
  // named preset rather than CUSTOM. A settings pane that opens on "custom" is
  // telling you that you already changed something, which is a small lie.
  { id: 'standard', name: 'STANDARD', effects: ['lighting', 'bloom'] },
  { id: 'high', name: 'HIGH', effects: ['lighting', 'bloom', 'grain'] },
  { id: 'full', name: 'FULL', effects: VIEW_EFFECT_IDS.slice() },
];

/** Which preset a toggle set corresponds to, or null when it is nobody's. */
export function presetFor(enabled: readonly string[]): string | null {
  const set = new Set(enabled);
  const match = VIEW_PRESETS.find(
    (p) => p.effects.length === set.size && p.effects.every((id) => set.has(id)),
  );
  return match?.id ?? null;
}

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
