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
  | 'convert'
  /** A Program has been idle: it has not fired for a couple of seconds. */
  | 'idle'
  /** Heat crossed into a new Instability tier, on the way up. */
  | 'threshold'
  /** A cascade reached the depth where Heat starts charging in earnest. */
  | 'depth'
  /** A Magnet was collected and the whole floor came in. */
  | 'sweep'
  /** A gorged Interceptor went up. */
  | 'glutton'
  /** The player crossed into a suppression field. */
  | 'enter';

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
export type FireField =
  | 'output'
  | 'count'
  | 'echo'
  | 'pierce'
  | 'area'
  | 'rate'
  | 'duration'
  /** Ricochet — projectiles bounce to a new target. */
  | 'bounce'
  /** Leech — fraction of damage returned as Integrity. */
  | 'leech'
  /** Volatile — effects detonate at end of life for this share of output. */
  | 'volatile'
  /** Quantize — snap fires to the audio grid, for a bonus when on-beat. */
  | 'quantize'
  /** Attune — the Action takes the hue of your fullest gauge. */
  | 'attune'
  /** Overdrive — big output, and every fire adds Heat directly. */
  | 'overdrive'
  /** §5.6 Resonate — this row also fires when the row above it fires. */
  | 'resonate'
  /** §5.6 Ground — the row above costs less; this row outputs less. */
  | 'ground'
  /** §5.6 Stagger — everything this row does lands a beat late. */
  | 'stagger'
  /** Fork — extra chain jumps. */
  | 'jumps'
  /** Conduct — how far flight, beams and chains reach. */
  | 'range'
  /** Slug — projectile speed, traded against output. */
  | 'speed'
  /** Seeker — projectiles steer toward what they were aimed at. */
  | 'seek'
  /** Bloom — area effects detonate a second time, smaller. */
  | 'bloom'
  /** Insulate — this row produces no Heat. */
  | 'insulate'
  /** Grounding Rod — this row's events resolve at cascade depth 0. */
  | 'rootDepth'
  /** Mirror — take the Action of the row above. */
  | 'mirror'
  /** Governor — an output ceiling, in exchange for half the Cycles. */
  | 'governor';

/**
 * §7.4 — what a Convert card exchanges.
 *
 * Fuel is gone, so the currencies are Integrity and **Heat**. That is a better
 * arbitrage layer than the one it replaces: Heat is the resource a deep cascade
 * *produces*, so these are the Actions that turn the game's central pressure
 * back into progress. Running hot becomes a position to trade out of rather than
 * only a penalty to survive.
 */
export interface ConvertSpec {
  costKind: 'integrity' | 'heat';
  costAmount: number;
  gainKind: 'xp' | 'heat' | 'speed' | 'output';
  gainAmount: number;
  /** Stim and Bleed: seconds the effect lasts. */
  duration?: number;
}

export interface ModifierOp {
  target: FireField;
  /** Additive delta, applied before `mul` within the same op. */
  add?: number;
  /** Multiplicative factor. */
  mul?: number;
}

/**
 * §8.2 — "pool weighted by what the player owns and their Axiom". Relative draft
 * frequency, default 1. Content needs a way to say "this is a specialist card":
 * with five Convert cards among ten Actions, an unweighted pool hands out an
 * Engine that deals no damage.
 */
export interface PoolWeighted {
  poolWeight?: number;
}

export interface TriggerDef extends PoolWeighted {
  id: string;
  kind: 'trigger';
  name: string;
  /** GDD §5.3 — Cycle cost per event. */
  cycleCost: number;
  /** Event type this trigger listens for. */
  listens: EventType;
  /** Self-scheduled triggers (Clock) declare a base interval in seconds. */
  interval?: number;
  /**
   * Output multiplier applied to whatever this Trigger fires, default 1.
   *
   * Triggers differ enormously in how often they fire — On Hit can fire fifty
   * times a second, On Wave once every twenty-six. Without this, the rare ones
   * are strictly worse than Clock at everything and exist only as curiosities:
   * "On Wound pairs with Leech" is not true if On Wound never fires. Paying rare
   * triggers a bigger payload per fire is what makes them burst archetypes
   * (§5.3 says as much about On Wave) rather than traps.
   */
  payload?: number;
  description: string;
}

export type ActionPrimitive =
  | 'projectile'
  | 'burst'
  | 'chain'
  | 'zone'
  | 'convert'
  /** Mine — a proximity charge left where you stood. */
  | 'mine'
  /** Rupture — a burst that lands at a target's position after a delay. */
  | 'delayed'
  /** Beam — an instant line to the farthest enemy in range. */
  | 'beam'
  /** Orbital — a persistent body circling the avatar. Stacks. */
  | 'orbital'
  /** Surge — a short self-buff on the engine's own rate. */
  | 'buff'
  /** Pull — a vortex that drags enemies toward a point. */
  | 'vortex'
  /** Shove — radial knockback. See §23.1's displacement guard. */
  | 'knockback';

export interface ActionDef extends PoolWeighted {
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
  /**
   * Minimum seconds between fires of this Action, per Program.
   *
   * Needed for persistent Actions. A Field tick damages every enemy inside it,
   * and every one of those is a hit — so `On Hit -> Field` places a zone per
   * enemy per tick, and each new zone does the same. Capping the live zone count
   * does not help, because the runaway is in the *rate*. A per-Program cooldown
   * is the honest fix: it bounds how often an Action can place, without touching
   * the event grammar that makes cascades work.
   */
  cooldown?: number;
  /**
   * Where the Action happens. Default is `event` — wherever the thing that
   * triggered it happened — so `On Hit -> Nova` detonates on each enemy struck
   * and cascades walk across the arena.
   *
   * §5.4 says Nova is "around avatar", and anchoring everything to the player
   * does match the letter of it. But that *deletes the interaction*, and §23.1
   * is explicit: a power break that still costs Cycles and still requires the
   * player to move is protected content, to be answered "by pricing, never by
   * deleting". So the cascade stays and the depth pricing pays for it. Actions
   * that are meaningless anywhere but on the avatar (Mine, Orbital, Surge)
   * anchor there regardless.
   */
  origin?: 'player' | 'event' | 'cluster';

  /** §7.4 — set when `primitive` is `convert`. */
  convert?: ConvertSpec;

  /** Mine: seconds before it can trigger, and its trigger radius. */
  armTime?: number;
  triggerRadius?: number;
  /** Rupture: seconds between marking a target and the detonation. */
  delay?: number;
  /** Beam: half-width of the damaged line. */
  beamWidth?: number;
  /** Orbital: orbit distance and angular speed. */
  orbitRadius?: number;
  orbitSpeed?: number;
  /** Surge: fractional engine-rate bonus while active. */
  rateBonus?: number;
  /** Pull: inward acceleration applied inside the vortex. */
  force?: number;
  /** Shove: outward impulse applied to everything in radius. */
  knockback?: number;
  /** Fragment: a projectile that steers toward a target and detonates. */
  seek?: number;
  /** Siphon: Heat shed on hit. The only sustained cooling in the game. */
  siphon?: number;
  description: string;
}

/** GDD §22 — an arena is authored content, not a constant. */
export interface RuinRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * §21b.4 — a region of the arena with its own character.
 *
 * A biome is *not* an enemy roster. The director owns what spawns and it spawns
 * around the player wherever they are; a biome with its own creatures would
 * fight that and would mean walking somewhere to meet a list. A biome is
 * terrain, the POIs it guarantees, one legible rule, and a colour.
 */
export interface BiomeDef {
  id: string;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Background tint while inside. The cheapest "where am I" there is. */
  tint?: number;
  /**
   * §21b.4 — the screen-space field this biome runs, if any.
   *
   * A tint says the floor is a different colour; a field says the room is a
   * different room. Adding one is a JSON edit plus a branch in the post shader,
   * which is the whole reason it is a name rather than a pile of numbers.
   */
  field?: BiomeField;
  /** The one rule. Multiplies base Heat venting while the player is inside. */
  ventMultiplier?: number;
  /** Multiplies XP from shards collected inside. */
  xpMultiplier?: number;
  /** POIs this biome guarantees, placed inside it when it opens. */
  poi?: readonly string[];
  description: string;
}

/**
 * §21b.4 — a screen-space field, as a kind plus its numbers.
 *
 * The kind still resolves to a branch in the post shader and always will: a
 * Voronoi fracture, rising motes and signal static are three genuinely different
 * programs, and a data language expressive enough to describe all three would be
 * a worse language than GLSL. Pretending otherwise is how you get an uber-shader
 * nobody can read.
 *
 * What *was* wrong is that every number inside those programs was a literal — the
 * frost cell size, the ember mote density, the tint each one pushes — so the only
 * biome that could ever look like frost was the one called frost. Now the shape
 * is code and the palette is data, which is the same split the hazards took: a
 * second ice room at half the cell size and a green tint is a JSON edit.
 */
export interface BiomeField {
  kind: 'frost' | 'ember' | 'static';
  /** 0..1 overall strength, before the biome's own fade-in. */
  amount?: number;
  /** Feature size in screen pixels — frost cells, ember spacing, static bands. */
  scale?: number;
  /** How hard the field's own marks are drawn over the picture. */
  intensity?: number;
  /** How much of the screen it reaches, 0 edges-only to 1 everywhere. */
  reach?: number;
  /** The colour it pushes, as 0..1 RGB. */
  tint?: readonly [number, number, number];
}

/**
 * §21b.5 — a gate: the thing that opens the map.
 *
 * Held rather than pressed. You stand in the circle while it fills, it drains
 * if you leave, and the neighbourhood arrives the moment you start. That makes
 * opening the map an event instead of a button, and it reuses the Cache's
 * hardened menagerie for the price.
 */
export interface GateDef {
  id: string;
  name: string;
  x: number;
  y: number;
  /** The circle you have to stand in. Large — this is ground you hold. */
  radius: number;
  /** Seconds of standing, and how fast it drains when you step out. */
  holdSeconds: number;
  /** The biome this opens. */
  opens: string;
  /** The wall that falls with it. A ruin, so collision and pathing are free. */
  barrier: RuinRect;
}

/**
 * §21b — a level: one room of the run, and the only one you can see.
 *
 * Levels are laid out in a single arena rather than loaded one at a time, so a
 * gate opening can *reveal* the next one — the camera clamps to the levels you
 * have unlocked, and everything beyond that is wall. One arena also means one
 * flow field, one spawn budget and one coordinate space, which is the whole
 * reason it is worth doing this way.
 */
export interface LevelDef {
  id: string;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Structure hue while you are in here. The cheapest "somewhere else". */
  tint?: number;
  /**
   * What a gate *into* this level burns like as it cuts.
   *
   * The light coming through an opening is light from the other side, so it
   * belongs to the room you are about to enter rather than the one you are
   * leaving. It is separate from `tint` because a structure hue has to stay at
   * band 5 and this is the brightest thing structure is ever allowed to be.
   */
  light?: number;
  /** §12.4 — the Extract terminal lives in exactly one level. */
  extract?: boolean;
  roster: RosterDef;
  description: string;
}

/**
 * §10.4 — what this level is allowed to spawn. **No numbers are multiplied.**
 *
 * A Mote on the last level has exactly the stats it has on the first. What a
 * level changes is which creatures the director may reach for: which families
 * exist here at all, and how far up their variant ladder substitution may climb.
 * That is the whole of difficulty progression, and it is the reason a wave of
 * forty plain Motes stays legal forever — a crisis early, a breather later, and
 * the pacing comes free.
 */
export interface RosterDef {
  /** Highest variant tier substitution may reach. 0 is base creatures only. */
  tier: number;
  /** Families that may appear. Anything else is remapped to one of these. */
  families: readonly string[];
  /** Rare arrivals used as events, each with its own live cap. */
  events?: readonly { id: string; maxAlive: number }[];
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
  /** §21b — the Core is implicit: everything not inside a biome. */
  biomes?: readonly BiomeDef[];
  /** §21b — the rooms of the run, in order. The first is where you start. */
  levels?: readonly LevelDef[];
  gates?: readonly GateDef[];
  description: string;
}

export interface ModifierDef extends PoolWeighted {
  /**
   * The field this modifier exists for. If the Action ignores it, the modifier
   * is inert — whatever else its ops happen to touch.
   *
   * Without this, a card that grants X and costs Y reads as useful on an Action
   * that ignores X, because Y still lands. See inertFields.
   */
  keyField?: FireField;
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

/**
 * §16.4 — the mark vocabulary. One added glyph on a known silhouette, so the
 * learning cost of a variant is one mark rather than one shape.
 */
export type EnemyMark = 'shield' | 'charge' | 'phase' | 'brood' | 'crown' | 'spines';

export type EnemyBehavior = 'seek' | 'charge' | 'intercept' | 'suppress' | 'lance';

export interface EnemyDef {
  id: string;
  name: string;
  shape: EnemyShape;
  /**
   * §16.3 — hue is *threat class*, and it is a property of the enemy rather than
   * of the wave that spawned it.
   *
   *   thermal  rushers   — come straight at you
   *   voltaic  harassers — hit or interfere from range
   *   void     anchors   — soak, hold ground, disable
   *
   * It used to be a damage type that nothing interacted with: enemies had a
   * colour, Actions had a colour, and the two never met except through an
   * adaptive resistance nothing ever displayed. Colour that means nothing is
   * noise, and this arena has enough. Now it predicts behaviour, which is a
   * thing you can read while dodging — which is exactly where an Interceptor
   * hiding inside your own bullet cloud needed to be readable.
   */
  hue: Hue;
  behavior: EnemyBehavior;
  hp: number;
  speed: number;
  radius: number;
  contactDamage: number;
  xp: number;
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
  /** Leech — Heat added on contact. Pressure on the economy, not the health bar. */
  heatOnTouch?: number;
  /** Lancer — preferred distance, and the damage of its beam. */
  standoff?: number;
  beamDamage?: number;
  /** Warden — rolls elite affixes (§10.3). */
  elite?: boolean;

  // ---- §10.4 variants -------------------------------------------------------
  //
  // A *family* is a silhouette and a behaviour: Mote, Drifter, Charger. A
  // *variant* is a member of that family carrying one extra idea — armour on its
  // front, a charge that detonates, a phase, a brood. Same shape, one added
  // mark, one new question for the player.
  //
  // This is deliberately data and not code. Difficulty in this game may not come
  // from multiplying a number by Threat (that was tried, and a Drifter at minute
  // eleven being pixel-identical to the one at minute one is exactly why it felt
  // fake); it comes from *what is on screen*. So the cost of the twentieth
  // variant has to be one JSON entry, and everything below exists to make that
  // true.

  /** Which family this belongs to. Defaults to its own id. */
  family?: string;
  /**
   * Visual marks, drawn by the renderer's mark table. Purely presentational —
   * they say what the def's other fields already do, so a variant is never
   * something the player has to discover by dying to it.
   */
  marks?: EnemyMark[];
  /**
   * Detonates on death, for this share of its contact damage, at this radius.
   * The Volatile elite affix in def form, so an ordinary enemy can carry it.
   */
  deathBlast?: { damage: number; radius: number };
  /** Phases in and out on its own, without being an elite. Seconds. */
  phaseInterval?: number;
  phaseDuration?: number;
  /**
   * §12 — substitution. Past `fromThreat`, this share of `family` spawns become
   * this variant instead. How a run's trash changes character without anything
   * being multiplied.
   */
  /**
   * §10.4 — when this variant may stand in for its family's base creature.
   *
   * `tier` is the level gate: a level's roster names the highest tier it will
   * ever let through, so the same threat band produces different creatures in
   * different rooms. That, and not a multiplier, is how the run gets harder.
   */
  substitutes?: { fromThreat: number; share: number; tier?: number };
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
  /**
   * §12.2 — the director's reactive inputs. `projectiles` raises this template's
   * weight with the player's live projectile count, which is what turns pure
   * spam into Interceptors rather than into a nerf.
   */
  reactive?: 'projectiles';
  /**
   * The composition a run opens with. Without this the first composition is a
   * weighted roll, and a bad roll opened the game on Drifters — twelve HP each
   * against a starting Clock -> Bolt. The first thirty seconds should not be a
   * dice throw.
   */
  opener?: boolean;
  entries: readonly { enemy: string; count: number; spread: number }[];
  description: string;
}

/**
 * §18.4 — every sound the simulation can ask for. Lives here rather than beside
 * `AudioCue` so wave data can name one without the content layer importing the
 * world.
 */
export type AudioCueKind =
  | 'fire'
  | 'kill'
  | 'pickup'
  | 'hurt'
  | 'overheat'
  | 'convert'
  | 'level'
  | 'gate'
  | 'breach'
  | 'summons'
  | 'hardened'
  | 'siege'
  | 'meltdown';

/**
 * §12.5 — one step in what a pool becomes at a particular call site.
 *
 * The chain is the part of the wave system that was always good and never
 * visible: `rosterAllows -> substitute -> harden` were three hardcoded calls
 * inside the spawner, in a fixed order, that nothing could reorder or reuse.
 * Naming them makes every wave in the game describable in the same vocabulary,
 * and a new kind of pressure becomes a new op rather than a fifth spawn loop.
 *
 * Note what is *not* in here: anywhere to look something up. `roster` carries a
 * resolved tier and family list, not "current" or "destination". A def that
 * names where to find its inputs is an enum the code has to switch on, and every
 * new source becomes a code change — which is the thing this exists to stop. The
 * caller resolves; the chain applies.
 */
export type WaveTransform =
  /** §21b — the room's vocabulary. Anything outside it is remapped into it. */
  | { op: 'roster'; tier: number; families: readonly string[]; events?: readonly string[] }
  /**
   * §10.4 — how far up the substitution ladder this wave may climb.
   *
   * `roll` is the ambient behaviour: eligible variants get their authored share,
   * ramped in over the band above `fromThreat`, so a wave is a mix. `best` takes
   * the hardest legal variant outright — what a called wave wants, because it is
   * a statement rather than a texture.
   *
   * `ceiling` ignores Threat entirely and reaches the roster's tier limit: the
   * map refusing you does not scale to how well you are doing.
   */
  | { op: 'escalate'; mode: 'roll' | 'best'; lead?: number; ceiling?: boolean }
  /** §10.3 — elite affixes, drawn without replacement. */
  | { op: 'affix'; count: number }
  /**
   * The one honest multiplier, and deliberately awkward to reach for.
   *
   * §10.4 is explicit that difficulty comes from substitution, not from scaling
   * numbers, and that rule is the reason a forty-Mote template can stay in the
   * pool forever. This op exists because opt-in difficulty is the one case where
   * a multiplier is fair — the player pressed the button. Every use is greppable
   * on purpose. If a second one appears without an argument for it, the wave
   * system has started lying about where its difficulty comes from.
   */
  | { op: 'toughen'; hp: number; damage?: number }
  /**
   * §12.4, §21b.7 — drop the room's punctuation out of this wave.
   *
   * Suppressors and Lancers are events: rare, individually capped, and built to
   * be answered by killing one thing or leaving. A called wave hardens whatever
   * it draws, and a hardened Suppressor is a 640hp Engine-off zone — the same
   * five-second inconvenience turned into a forty-second lockout, and on level
   * one it arrived at minute three. Called waves ask for a crowd; the room's
   * punctuation is not a crowd.
   *
   * Applied after `roster`, so it remaps into the families that step named.
   */
  | { op: 'noEvents' }
  /** §12.3 — the Beacon's enriched arrivals: more fuel, more of everything. */
  | { op: 'enrich' };

/**
 * §12.5 — one delivery inside a called wave.
 *
 * A list of these is a *score*, not a ramp. Two numbers interpolated can only
 * say "more, steadily"; an explicit list can say lull-then-spike, or nothing for
 * eight seconds while the player commits and then everything, or one heavy
 * parcel at the end. Wave design lives here, and it is authorable by hand and
 * trivially emitted by a generator.
 */
export interface WaveParcel {
  /** Seconds from the moment the wave is called. */
  at: number;
  /**
   * Size, as a share of the director's live density target.
   *
   * Relative on purpose. Every difficulty number in this game is expressed
   * against `targetAlive` or `threat`, so retuning the density curve retunes
   * everything with it instead of silently rebalancing half the events.
   */
  share: number;
  /**
   * Where it lands, as a ring around the call site. Omitted means the director's
   * own off-screen edge origins — which is what a Beacon wants, since it calls
   * the horde in rather than conjuring it around a place.
   */
  ring?: readonly [number, number];
  /** Per-enemy jitter on top of the ring. */
  spread?: number;
}

/**
 * §12.5 — a wave somebody called for, as opposed to the ambient flow.
 *
 * Pool, chain and schedule are three vocabularies rather than one record,
 * because they vary independently: a siege's six escalating parcels are a good
 * shape that has nothing to do with sieges, and would suit a Meltdown surge with
 * an entirely different pool. Fused into one struct, every combination is a new
 * row with every field repeated — which is the four hardcoded spawn loops this
 * replaces, moved into JSON and no better for it.
 */
export interface WaveEventDef {
  id: string;
  /** A `WaveTemplateDef` id. Omitted means the composition already running. */
  pool?: string;
  parcels: readonly WaveParcel[];
  /** Applied in order, after whatever the caller resolved and passed in. */
  via: readonly WaveTransform[];
  /** Fired once, on the first parcel. */
  cue?: AudioCueKind;
  description: string;
}

/**
 * GDD §15.3 — an achievement-like moment, caught and named in-run. `teaches` is
 * the load-bearing field: a Discovery that only says "you did a thing" is a
 * trophy, and this system exists to replace the tutorial, not to award trophies.
 */
export interface DiscoveryDef {
  id: string;
  name: string;
  /** What to do, shown in the Library while it is still locked. */
  hint: string;
  /** Why it mattered, shown once you have done it. */
  teaches: string;
  score: number;
  /** Node or Axiom ids added to the Library. §15.1: breadth, never power. */
  unlocks: readonly string[];
}

export interface AxiomDef {
  id: string;
  name: string;
  /** GDD §8.4 — a complete starter Program. */
  starter: { trigger: string; modifiers: readonly string[]; action: string };
  /**
   * A second row, for Axioms whose starter cannot produce its own first event.
   * `On Hit -> Bolt` needs a hit to make a hit; without something to catch, the
   * Axiom is inert for the whole run. The seed is the thing it catches.
   */
  seed?: { trigger: string; modifiers: readonly string[]; action: string };
  poolBias: Readonly<Record<string, number>>;
  capacityDelta: number;
  description: string;
}
