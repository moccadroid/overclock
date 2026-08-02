/** Shared simulation types. Pure data — nothing here imports the renderer. */

/** GDD §7.1 — the three hues. */
export type Hue = 'thermal' | 'voltaic' | 'void';
export const HUES: readonly Hue[] = ['thermal', 'voltaic', 'void'];

/** GDD §5.2 — the event alphabet. Triggers listen; Actions emit. */
export type EventType =
  | 'clock'
  | 'hit'
  | 'kill'
  | 'crit'
  | 'pickup'
  | 'dash'
  | 'wound'
  | 'wave'
  | 'overheat'
  | 'convert';

export interface GameEvent {
  type: EventType;
  /** GDD §5.2 — child events inherit depth+1. */
  depth: number;
  x: number;
  y: number;
  hue?: Hue;
  /** Entity this event concerns (the enemy hit/killed), if any. */
  targetId?: number;
  /** Program that emitted this event, for attribution in the editor readout. */
  sourceProgram?: number;
}

export type NodeKind = 'trigger' | 'action' | 'modifier';

/** What a modifier op can transform in the fire context. */
export type FireField = 'output' | 'count' | 'echo' | 'pierce' | 'area' | 'rate' | 'duration';

export interface ModifierOp {
  target: FireField;
  /** Additive delta, applied before `mul` within the same op. */
  add?: number;
  /** Multiplicative factor. */
  mul?: number;
}

export interface TriggerDef {
  id: string;
  kind: 'trigger';
  name: string;
  /** GDD §5.3 — Cycle cost per event. */
  cycleCost: number;
  /** Event type this trigger listens for. */
  listens: EventType;
  /** Self-scheduled triggers (Clock) declare a base interval in seconds. */
  interval?: number;
  description: string;
}

export type ActionPrimitive = 'projectile' | 'burst' | 'chain' | 'zone';

export interface ActionDef {
  id: string;
  kind: 'action';
  name: string;
  hue: Hue;
  /** GDD §5.4 — Cycle cost per fire. */
  cycleCost: number;
  primitive: ActionPrimitive;
  damage: number;
  /** projectile */
  speed?: number;
  lifetime?: number;
  pierce?: number;
  /** burst */
  radius?: number;
  /** chain */
  jumps?: number;
  range?: number;
  /** zone — seconds between damage ticks */
  tickInterval?: number;
  description: string;
}

/** GDD §22 — an arena is authored content, not a constant. */
export interface RuinRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ArenaDef {
  id: string;
  name: string;
  width: number;
  height: number;
  spawnX: number;
  spawnY: number;
  /** §12.4 — the Extract terminal sits at a fixed arena landmark. */
  extractX: number;
  extractY: number;
  ruins: readonly RuinRect[];
  description: string;
}

export interface ModifierDef {
  id: string;
  kind: 'modifier';
  name: string;
  /** GDD §5.5 — multiplier on the Program's Cycle cost. */
  cycleMult: number;
  /** Applied in array order; modifiers themselves apply in slot order. */
  ops: readonly ModifierOp[];
  description: string;
}

export type NodeDef = TriggerDef | ActionDef | ModifierDef;

/** §10.1 — shape is behaviour. A silhouette must predict what a thing does. */
export type EnemyShape =
  | 'dot'
  | 'circle'
  | 'triangle'
  | 'square'
  | 'hexagon'
  | 'diamond'
  | 'ring'
  | 'crescent'
  | 'line'
  | 'pentagon';

export type EnemyBehavior = 'seek' | 'charge' | 'intercept' | 'suppress' | 'lance';

export interface EnemyDef {
  id: string;
  name: string;
  shape: EnemyShape;
  behavior: EnemyBehavior;
  hp: number;
  speed: number;
  radius: number;
  contactDamage: number;
  xp: number;
  fuel: number;
  /** GDD §10.2 Splitter — children spawned on death. */
  splitsInto?: { enemy: string; count: number };
  /** Charger and Lancer telegraph windup, seconds. */
  windup?: number;
  dashSpeed?: number;
  dashDuration?: number;
  /** Bulwark — half-angle of the front shield arc that blocks projectiles. */
  shieldArc?: number;
  /** Interceptor — fractional size/HP gain per projectile eaten. */
  growthPerMeal?: number;
  /** Suppressor — radius of the zone in which the player's Triggers do not fire. */
  zoneRadius?: number;
  /** Leech — fuel drained from the fullest gauge on contact. */
  fuelSteal?: number;
  /** Lancer — preferred distance, and the damage of its beam. */
  standoff?: number;
  beamDamage?: number;
  /** Warden — rolls elite affixes (§10.3). */
  elite?: boolean;
  description: string;
}

export interface WaveTemplateDef {
  id: string;
  /** Inclusive threat band this template is eligible in. */
  minThreat: number;
  maxThreat: number;
  weight: number;
  /**
   * Ambient trickle rather than a wave: drawn continuously between templates to
   * keep constant pressure. Stream templates should be small (1-2 enemies).
   */
  stream?: boolean;
  /**
   * §12.2 — the director's reactive inputs. `projectiles` raises this template's
   * weight with the player's live projectile count, which is what turns pure
   * spam into Interceptors rather than into a nerf.
   */
  reactive?: 'projectiles';
  entries: readonly { enemy: string; count: number; spread: number }[];
  description: string;
}

export interface AxiomDef {
  id: string;
  name: string;
  /** GDD §8.4 — a complete starter Program. */
  starter: { trigger: string; modifiers: readonly string[]; action: string };
  poolBias: Readonly<Record<string, number>>;
  capacityDelta: number;
  description: string;
}
