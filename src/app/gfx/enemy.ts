/**
 * What an enemy looks like. One definition, for every surface that draws one.
 *
 * `shapes.ts` promised that "the arena and the Results screen must draw an enemy
 * from the *same* geometry", and delivered exactly that — the coordinates. The
 * *drawing* stayed inline in `renderer.ts`, inside a pass that batches six
 * hundred Drifters by hue and health step, which is a performance shape and not
 * something another screen can call. So every other surface that wanted to show
 * an enemy wrote a lookalike, and the lookalikes were wrong in ways nobody could
 * check: a filled core instead of a stroked ring, a flat interior instead of one
 * that thins with damage, and no shield arc or suppression ring at all — which
 * are the two marks that make a Bulwark a Bulwark and a Suppressor a Suppressor.
 *
 * A register entry showing a body the player has never seen is worse than no
 * picture, because it teaches a silhouette that will not appear in the fight.
 *
 * ---
 *
 * **The batched pass still exists, and that is fine.**
 *
 * `drawEnemies()` cannot call a per-enemy function without giving up the
 * batching, and the batching is the difference between sixty frames and twenty
 * at wave density. What it *can* do is read the same numbers, which is what
 * `ENEMY_PAINT` is for: the paint is one definition even where the loop is two.
 */
import type { Graphics } from 'pixi.js';
import type { EnemyDef } from '../../sim/types';
import { BAND } from '../visual';
import { arcSegment, polygonPath, shapeCoreRadius, shapeOutline, tracePolyline } from './shapes';

/**
 * The paint. Every site that draws an enemy — batched or not, arena or shell —
 * reads these rather than retyping them.
 */
export const ENEMY_PAINT = {
  /** Outline weight, and the heavier one used for a damage flash. */
  outline: 2.2,
  outlineFlash: 3,
  /** §17.1 — the interior is the HP bar the game does not draw. Scaled by health. */
  fill: 0.08,
  /** The concentric core that separates a Drifter from a Mote. Stroked, not filled. */
  core: 1.5,
  /** §10.2 Bulwark — the arc has to be visible or "flank it" is a guess. */
  shield: 4,
  shieldOffset: 7,
  /** §10.2 Suppressor / §10.3 Anchored — the boundary of the field. */
  zone: 1,
  zoneColour: 0x6d7b8c,
} as const;

export interface EnemyPaint {
  colour: number;
  /** §17.1 draw-in, 0..1. How much of the perimeter has been traced. */
  born?: number;
  /** 0..1. Thins the interior as the thing takes damage. */
  health?: number;
  /** Taking a hit: heavier stroke, at the player's luminance band. */
  flash?: boolean;
  /**
   * A precomputed outline, when the caller already built one. The arena builds
   * every outline once a frame and reuses it across three passes; rebuilding it
   * here was 1,900 throwaway arrays a frame at this density.
   */
  outline?: readonly [number, number][];
  /**
   * Field radius in the same units as `r`, overriding `def.zoneRadius`. The
   * arena passes the anchored affix's radius; a portrait passes a scaled one,
   * because a field is drawn to the same scale as the body it belongs to.
   */
  zone?: number;
}

/** Outline, interior and core — the body, without the marks. */
export function drawEnemyBody(
  g: Graphics,
  def: EnemyDef,
  x: number,
  y: number,
  r: number,
  facing: number,
  p: EnemyPaint,
): void {
  const born = p.born ?? 1;
  const health = p.health ?? 1;
  const verts = p.outline ?? shapeOutline(def.shape, x, y, r, facing);

  tracePolyline(g, verts, born);
  g.stroke({
    width: p.flash ? ENEMY_PAINT.outlineFlash : ENEMY_PAINT.outline,
    color: p.colour,
    alpha: (p.flash ? BAND.player : BAND.entity) * born,
  });

  // Only once it has finished writing itself on: a half-traced outline with a
  // fill inside it reads as a solid object that is missing an edge.
  if (born >= 1) {
    g.beginPath();
    polygonPath(g, verts);
    g.fill({ color: p.colour, alpha: ENEMY_PAINT.fill * health });
  }

  const core = shapeCoreRadius(def.shape, r);
  if (core > 0) {
    g.circle(x, y, core).stroke({
      width: ENEMY_PAINT.core,
      color: p.colour,
      alpha: BAND.inFlight * born,
    });
  }
}

/**
 * The marks that come from the definition rather than from the run: the shield
 * arc and the field boundary.
 *
 * Separate from the body because the arena draws these for *every* enemy while
 * the body of an ordinary one comes from the batched pass. Anything that
 * depends on run state instead — enriched, a full Glutton, a hardened crown —
 * stays in the renderer, because a register entry has no run to read.
 */
export function drawEnemyMarks(
  g: Graphics,
  def: EnemyDef,
  x: number,
  y: number,
  r: number,
  facing: number,
  p: EnemyPaint,
): void {
  const born = p.born ?? 1;

  if (def.shieldArc) {
    arcSegment(
      g,
      x,
      y,
      r + ENEMY_PAINT.shieldOffset,
      facing - def.shieldArc / 2,
      facing + def.shieldArc / 2,
    );
    g.stroke({ width: ENEMY_PAINT.shield, color: p.colour, alpha: BAND.telegraph * born });
  }

  const zone = p.zone ?? def.zoneRadius ?? 0;
  if (zone > 0) {
    g.circle(x, y, zone).stroke({
      width: ENEMY_PAINT.zone,
      color: ENEMY_PAINT.zoneColour,
      alpha: BAND.structure * 1.4 * born,
    });
  }
}

/** One whole enemy, at rest: what a portrait wants. */
export function drawEnemy(
  g: Graphics,
  def: EnemyDef,
  x: number,
  y: number,
  r: number,
  facing: number,
  p: EnemyPaint,
): void {
  drawEnemyBody(g, def, x, y, r, facing, p);
  drawEnemyMarks(g, def, x, y, r, facing, p);
}
