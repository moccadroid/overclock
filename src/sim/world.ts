/**
 * The World: one run's complete simulation state and its fixed-step update.
 *
 * Determinism contract (GDD §0):
 *   - advance() is called at a fixed SIM_DT; nothing here reads wall-clock time.
 *   - every random draw comes from `this.rng`.
 *   - iteration order over entities is stable (order-preserving compaction).
 * A given (seed, axiom, input sequence) reproduces bit-for-bit. See world.test.ts.
 */
import { HAZARDS, HAZARD_KINDS, type HazardCtx } from './hazards';
import { Rng } from './rng';
import {
  AFFIX_IDS,
  TRAIT_RUNNERS,
  mergeAffixes,
  num,
  traitOf,
  traitsOf,
  type TraitCtx,
  type TraitSpec,
} from './traits';
import { SpatialGrid, type SpatialItem } from './spatial';
import { FlowField } from './flowfield';
import { CycleBudget } from './cycles';
import { DiscoveryTracker } from './discoveries';
import { Engine, type FireContext, type Program } from './engine';
import { LOADBEARING, SAFETY, SIM_DT, TUNABLE } from './tunables';
import { atan2 as patan2, clamp, cos as pcos, hypot, pow as ppow, sin as psin } from './num';
import {
  HUES,
  type ActionDef,
  type ArenaDef,
  type AxiomDef,
  type EnemyDef,
  type EventType,
  type GameEvent,
  type BiomeDef,
  type LevelDef,
  type Hue,
  type WaveEventDef,
  type WaveParcel,
  type WaveTransform,
  type RuinRect,
  type WaveTemplateDef,
} from './types';
import {
  ACTION_BY_ID,
  ENEMY_BY_ID,
  TRIGGER_BY_ID,
  VARIANTS_BY_FAMILY,
  WAVE_BY_ID,
  WAVE_EVENT_BY_ID,
  WAVES,
  arena as getArena,
  axiom as getAxiom,
  enemy as getEnemy,
  familyOf,
} from '../content/index';

export interface InputState {
  moveX: number;
  moveY: number;
  dash: boolean;
  /** Hold-to-channel for beacons and terminals (§4.2, §21). */
  interact: boolean;
}

export const NO_INPUT: InputState = { moveX: 0, moveY: 0, dash: false, interact: false };

export type EnemyState = 'seek' | 'windup' | 'dash';

export interface Enemy extends SpatialItem {
  id: number;
  defId: string;
  hue: Hue;
  vx: number;
  vy: number;
  hp: number;
  maxHp: number;
  radius: number;
  state: EnemyState;
  timer: number;
  aimX: number;
  aimY: number;
  /** Render hint: seconds of kill-flash remaining (§17.2). */
  flash: number;
  spawnAge: number;
  /** §12.3 — spawned by a channelled Beacon, so it drops more. */
  enriched: boolean;
  /** §10.3 — elite affixes rolled at spawn. */
  affixes: EliteAffix[];
  /**
   * §10.2, §10.3 — this individual's traits: its def's, plus its affixes'.
   *
   * Per enemy rather than per def, because affixes are rolled at spawn and two
   * Motes of the same kind can now genuinely differ. This is what made an affix
   * and a variant's own idea stop being two mechanisms.
   */
  traits: readonly TraitSpec[];
  /**
   * §10.2 — whether this tick's traits armed the shared steering block.
   *
   * Recomputed every tick from the trait list rather than stored on the def, so
   * a trait can turn steering off for a beat — which is what a future "rooted"
   * or "stunned" trait is, with no new branch anywhere.
   */
  steers: boolean;
  /** Phasing affix: currently untargetable. */
  phased: boolean;
  /** Facing, for the Bulwark's shield arc and the Lancer's beam. */
  facing: number;
  /** §12.4 — came out of a Cache: tougher, and it hits harder. */
  hardened?: boolean;
  /**
   * §12.5 — the contact-damage multiplier this enemy arrived with.
   *
   * Was a `hardened ? TUNABLE.hardenedDamage : 1` at the point of impact, which
   * meant the number lived a long way from the wave that chose it and only one
   * wave could ever choose it. It is a `toughen` op's `damage` now, so it is in
   * waveevents.json next to the HP it travels with.
   */
  damageScale?: number;
  /** Interceptor: fractional progress toward the next meal (area hits). */
  mealProgress?: number;
  /** Interceptor: how many projectiles it has eaten. */
  meals: number;
  /** Lancer: beam state timer. */
  beamTimer: number;
  beamActive: number;
  /** Per-enemy movement personality: weave phase and a personal speed. */
  wobble: number;
  speedScale: number;
  /**
   * §23.1 — the Shove guard. Knockback displacement is budgeted per enemy per
   * second, because "permanent knockback walls" is a named tension break: if
   * stacked Shoves can hold the horde off indefinitely, the game stops asking
   * the player to move and that is a bug, not a power break.
   */
  shoveBudget: number;
  shoveWindow: number;
}

/** §10.3 — Wardens and Meltdown-tier enemies roll one or two of these. */
export type EliteAffix = 'volatile' | 'phasing' | 'anchored';

/** §12.5 — what a transform chain produces: one enemy, fully specified. */
interface SpawnRecipe {
  enemy: string;
  affixes: number;
  /** §10.3 — affix ids this arrival may not roll. See the `affix` transform. */
  affixExclude: string[];
  hpScale: number;
  damageScale: number;
  enriched: boolean;
}

export interface Projectile extends SpatialItem {
  id: number;
  vx: number;
  vy: number;
  life: number;
  damage: number;
  pierce: number;
  hue: Hue;
  depth: number;
  programIndex: number;
  radius: number;
  /** Corrupted projectiles damage the player too (§6.2 Instability II). */
  corrupted: boolean;
  hits: number[];
  age: number;
  /** Ricochet — bounces left. */
  bounces: number;
  /** Volatile — detonation output at end of life, 0 for none. */
  volatile: number;
  /** Leech — fraction of dealt damage returned as Integrity. */
  leech: number;
  /** Fragment — steering strength toward a target, 0 for a straight shot. */
  seek: number;
  /** Siphon — Heat shed on hit. */
  siphon: number;
}

/**
 * §7.3 — what falls on the floor.
 *
 * `xp` is the ordinary drop. `magnet` is the rare one: picking it up sweeps
 * every XP shard on the map into you at once, wherever it is. It exists because
 * walking over shards one at a time is the least interesting thing in the game,
 * and the two obvious fixes are both worse — a bigger collect radius makes the
 * shards meaningless, and an automatic sweep on level-up makes them invisible.
 * A rare, loud, worth-crossing-the-arena-for object keeps the pickup a
 * *decision* while removing the tedium.
 */
export type PickupKind = 'xp' | 'magnet';

export interface Pickup extends SpatialItem {
  id: number;
  kind: PickupKind;
  hue: Hue;
  value: number;
  vx: number;
  vy: number;
  age: number;
  /**
   * Called in by a Magnet: it is crossing the arena under its own power and
   * ignores the collect radius. See sweepShards — the sweep used to be a state
   * change with no picture, which is the least satisfying possible way to spend
   * the rarest object in the game.
   */
  called?: boolean;
}

/** §5.4 Mine — a proximity charge left where the player stood. */
export interface Mine extends SpatialItem {
  id: number;
  hue: Hue;
  damage: number;
  radius: number;
  triggerRadius: number;
  arm: number;
  life: number;
  maxLife: number;
  depth: number;
  programIndex: number;
  leech: number;
  /** §5.5 Volatile — detonates for this share of its damage when its life ends. */
  volatile: number;
}

/** §5.4 Orbital — a persistent body circling the avatar. Stacks. */
export interface Orbital extends SpatialItem {
  id: number;
  hue: Hue;
  damage: number;
  radius: number;
  orbitRadius: number;
  orbitSpeed: number;
  angle: number;
  life: number;
  maxLife: number;
  depth: number;
  programIndex: number;
  leech: number;
  /** §5.5 Volatile — detonates for this share of its damage when its life ends. */
  volatile: number;
  /** Per-enemy hit cooldowns, so an orbital does not shred on contact. */
  cooldowns: Map<number, number>;
}

/** §5.4 Rupture — a burst scheduled to land at a marked position. */
interface PendingBurst {
  time: number;
  x: number;
  y: number;
  radius: number;
  damage: number;
  hue: Hue;
  depth: number;
  programIndex: number;
  leech: number;
  alive: boolean;
}

/** GDD §5.4 Field — a persistent damage zone. The Void archetype's space control. */
export interface Zone extends SpatialItem {
  id: number;
  hue: Hue;
  radius: number;
  life: number;
  maxLife: number;
  damage: number;
  tickInterval: number;
  tickTimer: number;
  depth: number;
  programIndex: number;
  /** Pull — inward acceleration applied every tick, 0 for a plain Field. */
  force: number;
  leech: number;
  /** §5.5 Volatile — detonates for this share of its damage when its life ends. */
  volatile: number;
}

/**
 * Everything you walk to and hold Interact on. All three share one shape because
 * they share one interaction (§21: hold-to-complete with visible progress and
 * generous interrupt-resume).
 *
 * - `beacon`   §12.3 — call the next wave early and enriched; Threat ticks up.
 * - `recompile` §9    — delete the Engine, forge a Kernel, rebuild steeper.
 * - `extract`  §12.4 — bank the run at ×1.0 and walk away.
 */
/**
 * §12.4 — points of interest. A POI is a thing on the map worth walking to:
 * you hold E on it and something happens.
 *
 * This is a registry rather than a switch because the map is going to grow. The
 * cost of the next POI has to be one entry in POIS, one effect in POI_EFFECTS,
 * and one colour in the renderer's table — no new timer field, no new branch in
 * the spawner, no new branch in the completion path.
 */
export type TerminalKind =
  | 'beacon'
  | 'recompile'
  | 'extract'
  | 'cache'
  | 'gate'
  | 'cooler'
  /** LEVELS §6 — authored, one-shot, placed at run start like gates. */
  | 'station'
  | 'fragment';

export interface PoiDef {
  kind: TerminalKind;
  /** Seconds of channelling. */
  channelTime: number;
  /** §9.1 — Recompile must be channelled standing still. */
  requiresStillness: boolean;
  /** How many may exist at once. */
  maxAlive: number;
  /** Seconds between placements. Zero means "place once and never again". */
  interval: number;
  /** Not before this point in the run. */
  fromTime: number;
  /** Where to look for a spot, as a ring around the player. */
  ring: [number, number];
  /** Some POIs live at an authored landmark instead of a found spot. */
  atLandmark?: boolean;
}

export interface Terminal extends SpatialItem {
  id: number;
  kind: TerminalKind;
  /** 0..1 channel progress. Decays if the player leaves or stops holding. */
  progress: number;
  age: number;
  channelTime: number;
  /** §9.1 — Recompile must be channelled while stationary. */
  requiresStillness: boolean;
  /**
   * §21b.5 — a gate is *held*, not pressed: stand anywhere inside this radius
   * and it fills, step outside and it drains. Zero for ordinary POIs, which are
   * channelled at arm's length with E.
   */
  holdRadius?: number;
  /** The gate this terminal is, if it is one. */
  gateId?: string;
  /** Whether the hardened wave has already been called. */
  woken?: boolean;
  /**
   * §21b.7 — how many siege parcels this gate has delivered.
   *
   * Rewinds with `progress`, because the schedule is the bar rather than a clock
   * of its own. There is deliberately no timer beside it: a second clock would
   * let the siege and the thing it is supposed to be describing disagree.
   */
  siegePulse?: number;
  /**
   * STORY-AND-TONE §7.2 — a dead gate: placed, visible, and unresponsive.
   * Standing in it does nothing until something with `revives` clears this.
   */
  dead?: boolean;
  /** LEVELS §6 — the authored spot this terminal is, if it is one. */
  poiId?: string;
  /** The beat a station opens, or the document a fragment recovers. */
  doc?: string;
  /** Which section of `doc` a fragment recovers. */
  section?: number;
  /** Far-off label override for authored POIs. */
  label?: string;
}

/**
 * Every POI in the game. Order is the order they are considered each tick, which
 * is stable because this is a literal — determinism (§0) forbids anything else.
 */
export const POIS: readonly PoiDef[] = [
  {
    kind: 'beacon',
    channelTime: TUNABLE.beaconChannelTime,
    requiresStillness: false,
    maxAlive: TUNABLE.maxBeacons,
    interval: TUNABLE.beaconInterval,
    fromTime: 0,
    ring: [TUNABLE.spawnRingMin * 0.5, TUNABLE.spawnRingMax],
  },
  {
    kind: 'cache',
    channelTime: TUNABLE.cacheChannelTime,
    requiresStillness: false,
    maxAlive: 1,
    interval: TUNABLE.cacheInterval,
    fromTime: TUNABLE.cacheFromTime,
    ring: [TUNABLE.spawnRingMin * 0.7, TUNABLE.spawnRingMax * 1.2],
  },
  {
    // §21b.4 The Cooler — the first POI that is a *place*. It is never
    // channelled: it works because you are standing in it, which makes "where
    // am I" a decision rather than "what did I press". Placed by its biome.
    kind: 'cooler',
    channelTime: 1,
    requiresStillness: false,
    maxAlive: 0,
    interval: 0,
    fromTime: 0,
    ring: [0, 0],
  },
  {
    // §21b.5 — gates are placed once at run start by placeGates, never by the
    // scheduler. maxAlive 0 keeps the scheduler's hands off them entirely.
    kind: 'gate',
    channelTime: 20,
    requiresStillness: false,
    maxAlive: 0,
    interval: 0,
    fromTime: 0,
    ring: [0, 0],
  },
  {
    // §9.1 — Recompile terminals appear from minute 8.
    kind: 'recompile',
    channelTime: TUNABLE.recompileChannelTime,
    requiresStillness: true,
    maxAlive: 1,
    interval: TUNABLE.recompileInterval,
    fromTime: TUNABLE.recompileFromTime,
    ring: [TUNABLE.spawnRingMin * 0.6, TUNABLE.spawnRingMax],
  },
  {
    // §12.4 — one Extract terminal, at a fixed landmark, from minute 15.
    kind: 'extract',
    channelTime: TUNABLE.extractChannelTime,
    requiresStillness: false,
    maxAlive: 1,
    interval: 0,
    fromTime: TUNABLE.extractFromTime,
    ring: [0, 0],
    atLandmark: true,
  },
  {
    // LEVELS §6 — a station: an authored Bureau sheet, read in place. Placed by
    // placeAuthoredPois at run start; maxAlive 0 keeps the scheduler off it.
    kind: 'station',
    channelTime: TUNABLE.stationChannelTime,
    requiresStillness: false,
    maxAlive: 0,
    interval: 0,
    fromTime: 0,
    ring: [0, 0],
  },
  {
    // LEVELS §6 — a fragment: one section of a document, recovered where it
    // lies. Placed by placeAuthoredPois at run start, like the station.
    kind: 'fragment',
    channelTime: TUNABLE.stationChannelTime,
    requiresStillness: false,
    maxAlive: 0,
    interval: 0,
    fromTime: 0,
    ring: [0, 0],
  },
];

/**
 * §5 — Action primitive to implementation.
 *
 * The last if-chain in the sim, and it sat in the system the GDD calls the game:
 * twelve primitives behind a `switch (def.primitive)`, each arm calling a
 * differently-shaped private method with a different subset of arguments in a
 * different order. Adding an Action meant a string, a case, a bespoke method and
 * a row in `PRIMITIVE_FIELDS` over in engine.ts — with nothing checking the last
 * two agreed. A primitive missing from `PRIMITIVE_FIELDS` silently ignores every
 * modifier, which is the "card exists and does nothing" failure this codebase
 * has already shipped twice in other systems.
 *
 * It was split three ways as well: `convert` handled *before* the switch, `buff`
 * and `knockback` inside it, the rest in their own methods. Three places to look
 * for "what does an Action do".
 *
 * ---
 *
 * **`phase` is not decoration.** `each` runs once per instance, inside the loop
 * that rolls output, damage and corruption. `all` runs once for the whole cast,
 * *before* any of that — which is what `convert` did by returning early, and
 * that early return skips an `rng.chance` draw per instance. Model it any other
 * way and the RNG stream shifts: a balance change wearing a refactor's clothes,
 * and the pinned hashes would say so.
 */
interface ActionRunner {
  phase: 'each' | 'all';
  run(w: World, c: ActionCast): void;
}

/** One cast of one Action. Reused per fire — this is the hottest path there is. */
interface ActionCast {
  def: ActionDef;
  damage: number;
  depth: number;
  index: number;
  x: number;
  y: number;
  hue: Hue;
  ctx: FireContext;
  corrupted: boolean;
  spread: number[] | null;
  /** §5.5 — how many copies. Only an `all` runner reads it. */
  instances: number;
}

const ACTION_RUNNERS: Record<string, ActionRunner> = {
  projectile: {
    phase: 'each',
    run: (w, c) =>
      w.actProjectile(c.def.id, c.damage, c.depth, c.index, c.x, c.y, c.ctx, c.corrupted, c.hue, c.spread),
  },
  burst: {
    phase: 'each',
    run: (w, c) => w.actBurst(c.def.id, c.damage, c.depth, c.index, c.x, c.y, c.ctx, c.hue),
  },
  chain: {
    phase: 'each',
    run: (w, c) => w.actChain(c.def.id, c.damage, c.depth, c.index, c.x, c.y, c.hue, c.ctx),
  },
  zone: {
    phase: 'each',
    run: (w, c) => w.actZone(c.def.id, c.damage, c.depth, c.index, c.x, c.y, c.hue, c.ctx),
  },
  // A vortex is a zone that pulls. Same runner; the difference is in the data,
  // which is the whole point of having a table.
  vortex: {
    phase: 'each',
    run: (w, c) => w.actZone(c.def.id, c.damage, c.depth, c.index, c.x, c.y, c.hue, c.ctx),
  },
  mine: {
    phase: 'each',
    run: (w, c) => w.actMine(c.def, c.damage, c.depth, c.index, c.ctx, c.hue),
  },
  delayed: {
    phase: 'each',
    run: (w, c) => w.actRupture(c.def, c.damage, c.depth, c.index, c.x, c.y, c.ctx, c.hue),
  },
  beam: {
    phase: 'each',
    run: (w, c) => w.actBeam(c.def, c.damage, c.depth, c.index, c.x, c.y, c.ctx, c.hue),
  },
  orbital: {
    phase: 'each',
    run: (w, c) => w.actOrbital(c.def, c.damage, c.depth, c.index, c.ctx, c.hue),
  },
  buff: {
    phase: 'each',
    run: (w, c) => w.actSurge(c.def, c.ctx),
  },
  knockback: {
    phase: 'each',
    run: (w, c) => w.actShove(c.def, c.damage, c.depth, c.index, c.x, c.y, c.ctx, c.hue),
  },
  // §7.4 — Convert exchanges resources instead of dealing damage, so it runs
  // before there is any damage to speak of and never rolls for corruption.
  convert: {
    phase: 'all',
    run: (w, c) => {
      for (let n = 0; n < c.instances; n++) w.actConvert(c.def, c.depth);
    },
  },
};

/** The primitives that have an implementation. Compared against the data. */
export const ACTION_PRIMITIVES = Object.keys(ACTION_RUNNERS);

/** What channelling one does. One entry per POI, and nothing else to touch. */
const POI_EFFECTS: Record<TerminalKind, (w: World, t: Terminal) => void> = {
  beacon: (w) => {
    w.stats.beaconsChannelled++;
    w.threat += TUNABLE.beaconThreatBump;
    w.spawnWaveNow(true);
    // §12.3 — you called this wave in. Until now that was silent, so the one
    // thing on the map you channel *in order to be attacked* announced itself
    // with nothing at all.
    w.cueNow('summons', 'voltaic');
    w.mark('beacon', 'beacon');
  },
  cache: (w, t) => w.openCacheNow(t.x, t.y),
  gate: (w, t) => w.openGateNow(t),
  cooler: () => {},
  // Does not fire immediately: the player chooses how much to sacrifice.
  recompile: (w) => {
    w.pendingRecompileChoice = true;
  },
  // §12.4 — banked at x1.0. No Meltdown multiplier ever applies.
  extract: (w) => {
    w.ending = 'extracted';
    w.player.alive = false;
    w.mark('extract', 'extracted');
  },
  // LEVELS §6 — the sheet is the app's to show; the sim only says which one.
  // Time freezes while it is read, so this is a flag, not a branch.
  station: (w, t) => {
    w.pendingSheet = { doc: t.doc ?? '', station: true };
    w.mark('station', t.doc ?? 'station');
  },
  // LEVELS §6 — one section of one document, recovered where it lies. The
  // sheet opens on the spot — recovering a confidential file and seeing
  // nothing reads as a bug, not as discretion — and the arc ingests
  // `stats.recovered` at run-end; the sim never learns what it held.
  fragment: (w, t) => {
    w.stats.recovered.push({ doc: t.doc ?? '', section: t.section ?? 0 });
    w.pendingSheet = { doc: t.doc ?? '', section: t.section ?? 0 };
    w.cueNow('level', 'void');
    w.mark('fragment', `${t.doc ?? 'document'} recovered`);
  },
};

export type ContainmentKind = 'sweeper' | 'cell' | 'nullfront';

/**
 * §11.4 — the runtime's immune response, Meltdown only. These scale in frequency
 * and overlap, never in HP: by minute 26 the player threads simultaneous
 * Sweepers, cells and fronts while their engine deletes everything else. Death
 * comes from geometry, not attrition.
 */
export interface Containment extends SpatialItem {
  id: number;
  kind: ContainmentKind;
  age: number;
  life: number;
  maxLife: number;
  /** Sweeper: unit direction of travel, and the gap centre along the wall. */
  dirX: number;
  dirY: number;
  gapAt: number;
  /** Cell: current radius, and where its gaps sit. */
  radius: number;
  gapAngles: number[];
  /** Null front: how far the edge has advanced into the arena. */
  advance: number;
  telegraph: number;
}

/**
 * A death, handed to the renderer so it can decompose the shape into line
 * segments (§17.1). Derived presentation data: drained by the renderer every
 * frame, never read by the simulation, and deliberately excluded from the state
 * hash so it cannot affect determinism.
 */
/**
 * §14 — something that took Integrity off you. Carries the enemy's identity, not
 * a sentence about it: the Results screen draws the silhouette you have been
 * learning all run, and a name you can match to it.
 */
export interface DamageSource {
  /** Stable tally key. The enemy's id, or a slug for a hazard. */
  id: string;
  label: string;
  /** Set when an enemy dealt it. */
  enemyId?: string;
  /** §10.1 silhouette, so the UI need not look the enemy up again. */
  shape?: string;
  /** How it reached you — contact, beam, detonation, containment. */
  mode?: string;
}

/**
 * Something worth hearing. §18 — "the soundtrack *is* the engine", so the audio
 * layer needs the same events the sim already computes, tagged with the two
 * things that decide how a note sounds: which hue it belongs to and how deep in
 * a cascade it fired.
 *
 * Presentation-only, like VisualDeath. Nothing in src/sim reads it back, which
 * is what lets audio drop voices, lag, or be muted without touching the run.
 */
export interface AudioCue {
  kind:
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
  hue: Hue;
  /** Cascade depth — pitch climbs with it, so a deep cascade audibly rises. */
  depth: number;
  /** 0..1 loudness hint. Voice-stealing keeps the loudest when it has to cut. */
  weight: number;
}

/** A blow landed on the player. Presentation-only, like VisualDeath. */
export interface VisualHurt {
  x: number;
  y: number;
  amount: number;
  /** What did it — the enemy's name, or the hazard's. */
  label: string;
  /** Fraction of max Integrity, so the renderer can size the shout. */
  severity: number;
}

export interface VisualDeath {
  x: number;
  y: number;
  radius: number;
  shape: string;
  hue: Hue;
}

/** Short-lived visual records for instantaneous actions. Sim-owned so replays match. */
export interface Fx {
  id: number;
  kind: 'burst' | 'chain' | 'hurt' | 'crit' | 'rupture';
  hue: Hue;
  x: number;
  y: number;
  radius: number;
  points: number[];
  life: number;
  maxLife: number;
  alive: boolean;
}

/**
 * A spawn that has been decided but has not arrived yet. Waves are queued with
 * staggered arrival times so a template streams in rather than appearing as one
 * clump (§12.2 — the composition is the design, its delivery should not be a
 * single instant).
 */
interface PendingSpawn {
  time: number;
  enemy: string;
  x: number;
  y: number;
  hue: Hue;
  enriched: boolean;
  /** §12.4 — from a Cache: arrives wearing an elite affix. */
  /** §10.3 — how many elite affixes to roll. Zero for an ordinary arrival. */
  affixes: number;
  /**
   * ...and which ones it may not be. Carried on the spawn rather than checked at
   * the roll, because by then the only thing left is an enemy id: which *wave*
   * asked for it is exactly the information that has been thrown away, and it is
   * the only thing that knows a Cache must not switch your Engine off.
   */
  affixExclude: readonly string[];
  /** §21b.7 — arrived through a door, and is allowed to be seen doing it. */
  visible: boolean;
  /** §21b.7 — queued by a siege; dropped if the gate opens before it lands. */
  siege: boolean;
  hpScale: number;
  damageScale: number;
  alive: boolean;
}

interface ScheduledFire {
  time: number;
  programIndex: number;
  outputMul: number;
  depth: number;
  x: number;
  y: number;
  alive: boolean;
}

export interface Player {
  x: number;
  y: number;
  /**
   * Where the avatar was at the start of this tick.
   *
   * Presentation reads it; the simulation never does. It lives here because only
   * the sim knows when a tick began. The renderer runs at the display's rate —
   * 144Hz on the machine this was reported from — while the sim steps at 60, so
   * without it the avatar's position updates every 2.4 frames while the camera
   * smoothing moves every frame, and the one object the player is looking at
   * judders against a world that does not.
   */
  prevX: number;
  prevY: number;
  vx: number;
  vy: number;
  integrity: number;
  maxIntegrity: number;
  iframes: number;
  dashTimer: number;
  dashCooldown: number;
  dirX: number;
  dirY: number;
  /** §7.4 Convert: Stim — fractional move-speed bonus, and its remaining time. */
  speedBoost: number;
  speedBoostTime: number;
  /** §7.4 Convert: Bleed — fractional output bonus, and its remaining time. */
  outputBoost: number;
  outputBoostTime: number;
  alive: boolean;
}

export interface RunConfig {
  seed: string;
  axiomId: string;
  arenaId?: string;
  /**
   * §15.2 — node ids this account has unlocked. Part of the run config rather
   * than something the sim reads from storage, so a replay is reproducible from
   * seed + axiom + pool and the sim keeps its promise never to touch the world
   * outside itself. Omitted means every node.
   */
  availableNodes?: readonly string[];
  /**
   * §8.2 — which draft policy this run rolls under, by id from draftpool.json.
   * Omitted means the active profile.
   *
   * Part of the config for the same reason `availableNodes` is: the draft draws
   * from the run's Rng, so a replay that rolled under a different policy would
   * diverge on the first card. Recorded alongside the seed.
   */
  draftPoolId?: string;
  /** Discoveries already in the Library, so a repeat does not re-announce. */
  knownDiscoveries?: ReadonlySet<string>;
  /**
   * LEVELS §6 — authored POI ids already read or recovered. They are simply
   * never placed. Computed by the story's `configure()`; part of the config so
   * a replay reproduces exactly the map the player saw.
   */
  recoveredPois?: readonly string[];
  /**
   * LEVELS §4 — level ids whose gates start open: barrier gone, gate terminal
   * never placed, room camera-visible from the first frame. The endgame state
   * where the site has stopped resealing itself.
   */
  openLevels?: readonly string[];
  /**
   * LEVELS §2.3 — the tutorial contract: opening the gate into this level
   * *concludes* the run, banked like an extraction. The orientation shift is
   * over when the operator proves they can open a partition, and it repeats
   * until they do. Set by the story while the tutorial is unbeaten.
   */
  concludeOnOpen?: string;
  /**
   * LEVELS §2.3 — density multiplier, 0..1. Scales the director's live target,
   * which also sizes cache menageries and siege parcels. The tutorial runs
   * gentler than the game it is teaching. Omitted means 1.
   */
  pressure?: number;
  /**
   * STORY-AND-TONE §7.2 — gate ids that are placed dead: present, visible,
   * and unresponsive to a hold. A dead gate is revived by a gate whose
   * `revives` names it. The wall stays up either way.
   */
  deadGates?: readonly string[];
  /** No extraction terminal this run. The last frontier has a lock instead. */
  noExtract?: boolean;
  /** Where the extraction terminal stands, overriding the arena's landmark. */
  extractAt?: { x: number; y: number };
  /**
   * STORY-AND-TONE §7.1 — the growing starter. Rows installed after the
   * Axiom's own, filling empty program slots in order. The story hands these
   * out between runs; the sim only installs what it is given.
   */
  bonusRows?: readonly { trigger: string; modifiers: readonly string[]; action: string }[];
  /** Extra Cycle capacity to carry the bonus rows. */
  bonusCapacity?: number;
  /** Testing hook: bring Meltdown forward. Never set in a scored run. */
  meltdownAt?: number;
}

export type RunPhase = 'build' | 'meltdown';

/** How a run ended (§2.1). There is no "you win". */
export type RunEnding = 'alive' | 'died-early' | 'extracted' | 'contained';

/** §14 — one sample of the run-trace chart, the Results screen's hero element. */
export interface TraceSample {
  t: number;
  eps: number;
}

export type TraceMarkerKind =
  | 'level'
  | 'recompile'
  | 'meltdown'
  | 'extract'
  | 'death'
  | 'beacon'
  | 'cache'
  | 'gate'
  /** LEVELS §6 — an onboarding station read, a document section recovered. */
  | 'station'
  | 'fragment'
  /** §12.1 — the run's difficulty crossing a step. See `threatStep`. */
  | 'threat';

export interface TraceMarker {
  t: number;
  kind: TraceMarkerKind;
  label: string;
}

export interface RunStats {
  events: number;
  kills: number;
  fires: number;
  misfires: number;
  droppedByDepth: number;
  maxDepth: number;
  peakEps: number;
  peakConcurrentEnemies: number;
  overheats: number;
  /** Magnets collected. A run\'s XP tedium, counted. */
  magnets: number;
  /** §21b.6 — enemies moved from behind the player to in front of them. */
  recycled: number;
  /** §21b.5 — gates held open. */
  gatesOpened: number;
  /** §12.4 — Caches channelled. */
  cachesOpened: number;
  /** Gorged Interceptors detonated. */
  gluttonsPopped: number;
  /** Suppressors killed from inside their own field. */
  suppressorsKilledInside: number;
  damageTaken: number;
  beaconsChannelled: number;
  converts: number;
  crits: number;
  /** Seconds spent in each Heat tier — the instrument for tuning §6.3. */
  tierSeconds: [number, number, number, number];
  /** Total Cycles the engine asked for. Compare against capacity x time. */
  /** Kills per enemy id. Feeds Discoveries and the Results breakdown. */
  killsByEnemy: Map<string, number>;
  /** Kills landed while a Suppressor had your Triggers offline (§11.2). */
  suppressedKills: number;
  /**
   * §11.2 — seconds the player's Triggers were switched off by a field.
   *
   * A counter rather than a trajectory column: this is a transient with an exact
   * integral, and the trajectory samples every ten seconds for *shape*. A field
   * you walk through in four seconds is invisible to a sample and is the whole
   * of the complaint — "my Engine went quiet" is the most player-visible failure
   * state in the game and until now the corpus had no column for it at all.
   */
  suppressedSeconds: number;
  /** How many separate times they walked into one. Duration alone hides a lot. */
  suppressionEntries: number;
  /** Conversions that spent Integrity you could not spare (§7.4). */
  desperateConverts: number;
  peakHeat: number;
  /** Seconds until the first level-up — §3's "a decision every ~30 seconds". */
  firstLevelTime: number;
  /** Times a runtime safety valve fired. Non-zero means investigate, not tune. */
  safetyTrips: number;
  /**
   * LEVELS §6 — document sections recovered from fragment POIs this run. The
   * arc folds these into `story.held` at run-end; nothing in the sim reads it.
   */
  recovered: { doc: string; section: number }[];
}

export class World {
  readonly rng: Rng;
  readonly config: RunConfig;
  readonly arena: ArenaDef;
  time = 0;
  tickCount = 0;

  engine: Engine;
  budget: CycleBudget;

  player: Player;
  enemies: Enemy[] = [];
  projectiles: Projectile[] = [];
  pickups: Pickup[] = [];
  zones: Zone[] = [];
  mines: Mine[] = [];
  orbitals: Orbital[] = [];
  private pendingBursts: PendingBurst[] = [];
  terminals: Terminal[] = [];
  containment: Containment[] = [];
  fx: Fx[] = [];
  /** Drained by the renderer each frame; capped so a headless run cannot grow it. */
  visualDeaths: VisualDeath[] = [];
  /**
   * §17.1 — every blow you take, as a number, drained by the renderer.
   *
   * Damage numbers are usually noise: eight thousand kills a run means eight
   * thousand of them, and none is worth reading. Damage *taken* is the opposite
   * — i-frames mean at most two a second, and until now you could only learn how
   * hard a Lancer hits by dying and reading the post-mortem.
   */
  visualHurts: VisualHurt[] = [];
  /** §18 — drained by the audio layer each frame. See AudioCue. */
  audioCues: AudioCue[] = [];



  xp = 0;
  xpToNext: number;
  level = 1;
  /** §19.4 — drafts queue up to 3. */
  pendingDrafts = 0;
  rerolls = TUNABLE.rerollsPerRun;
  purges = TUNABLE.purgesPerRun;
  /** §8.3 — rerolls taken in the current draft. Each one costs more Heat. */
  rerollsThisDraft = 0;
  /** §8.3 — a node id held over for the next draft, or null. */
  locked: string | null = null;
  /** §8.3 — how many times each node has been offered and refused. */
  refused = new Map<string, number>();
  /** Node ids in the offer currently on the table. See applyDraft. */
  lastOffer: string[] = [];
  /** Node ids removed from this run's pool by Purge (§8.3). */
  purged = new Set<string>();
  /**
   * §8.2 — accumulated stat-card bonuses.
   *
   * The first four are deliberately small. The last three are the class stats,
   * and they are not: they multiply one *kind* of Action and do nothing at all
   * to the others, which is what makes taking one a decision about the build you
   * are in rather than a number that always goes up.
   */
  bonuses = {
    crit: 0,
    magnet: 0,
    speed: 0,
    power: 0,
    travels: 0,
    area: 0,
    lingers: 0,
    reach: 0,
    coolant: 0,
    capacitor: 0,
    salvage: 0,
    momentum: 0,
    dashHaste: 0,
  };

  /** Class-stat multipliers, read at the point of use so they cannot go stale. */
  get areaMul(): number {
    return 1 + this.bonuses.area;
  }

  get durationMul(): number {
    return 1 + this.bonuses.lingers;
  }

  /**
   * How far anything of yours reaches, as a multiplier.
   *
   * Base ranges are deliberately short now — shorter than the screen, so a kill
   * you never saw is a rare event rather than the normal case. Reach is how you
   * buy that back, and it is the one axis of power the draft can hand out that
   * changes *where you have to stand* rather than how big a number is.
   */
  get reachMul(): number {
    return 1 + this.bonuses.reach;
  }
  /**
   * §14 — a Results screen that cannot say how you died teaches nothing. The
   * final blow answers "what got me"; the tally answers "what was actually
   * killing me all run", which is usually a different thing.
   *
   * Keyed by source id so a Lancer's beam and its body are one entry: the thing
   * to recognise next run is the Lancer, not the delivery mechanism.
   */
  damageBySource = new Map<string, { source: DamageSource; amount: number }>();
  deathCause: DamageSource | null = null;

  threat = 0;
  /** §12 — the composition currently being fed into the arena. */
  composition: WaveTemplateDef | null = null;
  compositionTimer = 0;
  /** Fractional spawns carried between ticks so the stream is smooth. */
  private refillDebt = 0;
  private consolidateTimer = 0;
  /** Seconds until another Magnet may drop. See maybeDropMagnet. */
  private magnetCooldown = 0;
  /**
   * Heat integrated over the run, in heat-seconds. The honest measure of "how
   * hot did this Engine run" — a peak can be one Leech touching you.
   */
  heatIntegral = 0;
  /** §5.3 On Enter — was the player in a hazard last tick? */
  private wasInHazard = false;
  /** §5.3 On Threshold — the Heat tier last seen, so only climbs fire. */
  private lastTier = 0;
  /** §8.2 Momentum — seconds since the player was last hurt. */
  private sinceHurt = 0;
  /**
   * Capacity before the Capacitor stat.
   *
   * Capacitor is the first thing that changes capacity *continuously* — it pays
   * per empty row, so it has to be recomputed whenever the Engine changes. That
   * means syncBudget writes `budget.capacity`, which means every permanent gain
   * (the Axiom's delta, a Capacity card, a Recompile) has to be banked here
   * instead, or the next sync would erase it.
   */
  baseCapacity: number = TUNABLE.cycleCapacityBase;
  /** §5.3 On Depth — cascades that already announced themselves this tick. */
  private deepThisTick = new Set<number>();
  /** §12.4 — per-POI placement countdowns. See POIS. */
  private readonly poiTimers = new Map<TerminalKind, number>([['beacon', 20]]);
  wardenTimer: number = TUNABLE.wardenInterval;
  containmentTimer: number = TUNABLE.containmentFirstDelay;
  score = 0;
  eps = 0;
  /** Smoothed Cycles/sec the engine is drawing. Shown against capacity (§6). */
  /** Smoothed cascade depth. The cause Heat now has, for the HUD. */
  depthAverage = 0;
  /** §5.4 Surge — engine-rate bonus and its remaining time. */
  surgeRate = 0;
  surgeRateTime = 0;

  // ---- run structure (§9, §13.2) ----
  phase: RunPhase = 'build';
  ending: RunEnding = 'alive';
  /** §13.2 — climbs +0.25 every 30s of Meltdown survived, uncapped. */
  meltdownMultiplier = 1;
  peakMeltdownMultiplier = 1;
  kernels = 0;
  /** §9.1 — seconds of doubled XP remaining. */
  surgeTime = 0;
  surgeDrafts = 0;
  /** §9.1 — smoothed recent output of the live Engine; the Kernel's basis. */
  outputAverage = 0;
  /** The best that average ever reached, for the wasted-Kernel readout (§9.2). */
  peakOutputAverage = 0;
  /** §15.3 — watches for named moments. Drained by the presentation layer. */
  readonly discoveries: DiscoveryTracker;
  /** §14 — the run's story. */
  trace: TraceSample[] = [];
  markers: TraceMarker[] = [];
  private traceTimer = 0;

  stats: RunStats = {
    events: 0,
    kills: 0,
    fires: 0,
    misfires: 0,
    droppedByDepth: 0,
    maxDepth: 0,
    peakEps: 0,
    peakConcurrentEnemies: 0,
    overheats: 0,
    magnets: 0,
    recycled: 0,
    gatesOpened: 0,
    cachesOpened: 0,
    gluttonsPopped: 0,
    suppressorsKilledInside: 0,
    damageTaken: 0,
    beaconsChannelled: 0,
    converts: 0,
    crits: 0,
    tierSeconds: [0, 0, 0, 0],
    killsByEnemy: new Map(),
    suppressedKills: 0,
    suppressedSeconds: 0,
    suppressionEntries: 0,
    desperateConverts: 0,
    peakHeat: 0,
    firstLevelTime: 0,
    safetyTrips: 0,
    recovered: [],
  };

  /** Rolling window of per-tick event counts for the 5s EPS smoothing (§13.1). */
  private epsWindow: number[] = [];
  private epsWindowSum = 0;
  private readonly epsWindowSize = Math.round(TUNABLE.epsSmoothingWindow / SIM_DT);

  private eventQueue: GameEvent[] = [];
  private scheduled: ScheduledFire[] = [];
  /** Enemy ids already claimed by this execution's Split copies. Reused. */
  private readonly splitTaken: number[] = [];
  private pendingSpawns: PendingSpawn[] = [];
  private grid: SpatialGrid<Enemy>;
  private flow: FlowField;
  /**
   * §21b.5 — walls that are still up, and the biomes that are open.
   *
   * A barrier is a ruin: collision, pathing and rendering all already handle
   * ruins, so a gate opening is a ruin being removed rather than a new kind of
   * object. `ruins` is the live list everything else reads.
   */
  ruins: RuinRect[] = [];
  readonly openBiomes = new Set<string>();
  /**
   * Levels the player has already stood in. Seeded with the starting room in
   * `constructor`, so the run does not announce the room it begins in.
   */
  private readonly breached = new Set<string>();
  /**
   * §21b — the levels you may see. The first is unlocked at the start; a gate
   * adds the one it opens.
   *
   * The camera clamps to the union of these, which is what makes a gate a
   * *reveal*: until it is held, the next room is not merely walled off, it is
   * off camera. `openBiomes` doubles as this set — a gate's `opens` names a
   * level now — so one unlock mechanism serves both.
   */
  get unlockedLevels(): readonly LevelDef[] {
    const levels = this.arena.levels ?? [];
    if (levels.length === 0) return [];
    return levels.filter((l, i) => i === 0 || this.openBiomes.has(l.id));
  }

  /**
   * The level the player is standing in, or the first if none contains them.
   *
   * Named `currentLevel` because `level` is already the Engine's XP level, and
   * two different "levels" on one object is how you write a bug you cannot see.
   */
  get currentLevel(): LevelDef | null {
    return this.levelAt(this.player.x, this.player.y);
  }

  /**
   * §21b — which room a point belongs to.
   *
   * Levels do not tile the arena. The Heap ends at x=3800 and The Sink begins at
   * x=4400, with the gate and its barrier in between, so there is a six-hundred
   * unit corridor that is inside no level at all — and the fallback here was
   * `levels[0]`. Walk through the door and, until you are clear of the corridor,
   * the director believes you are back in the tutorial room: its roster, its
   * families, and now its Threat ceiling. Read straight off a real run, the HUD
   * announced `room holds at 3` at 510s, four minutes after The Sink was entered.
   *
   * Nearest-by-distance instead. A point outside every room belongs to the room
   * it is closest to, which for a doorway is the one you are walking into.
   */
  levelAt(x: number, y: number): LevelDef | null {
    const levels = this.arena.levels ?? [];
    let nearest: LevelDef | null = null;
    let bestD2 = Infinity;
    for (const l of levels) {
      const dx = Math.max(l.x - x, 0, x - (l.x + l.w));
      const dy = Math.max(l.y - y, 0, y - (l.y + l.h));
      const d2 = dx * dx + dy * dy;
      if (d2 === 0) return l;
      if (d2 < bestD2) {
        bestD2 = d2;
        nearest = l;
      }
    }
    return nearest;
  }
  private readonly flowSample = { x: 0, y: 0 };
  private nextId = 1;
  private eventsThisTick = 0;

  /**
   * §10.2 — the trait contract, instantiated once.
   *
   * Rebuilt per enemy would allocate once per enemy per frame, which at a
   * thousand enemies is a garbage-collection pause dressed as an abstraction.
   * The four mutable fields are overwritten in the loop; everything else is a
   * bound method and never changes.
   */
  private readonly traitCtx: TraitCtx;
  /** §11.4 — the hazard contract, instantiated once. See traitCtx.
   */
  private readonly hazardCtx: HazardCtx;
  /** §5 — one cast, reused. The fire path runs thousands of times a second. */
  private readonly actionCast: ActionCast = {
    def: null as unknown as ActionDef,
    damage: 0,
    depth: 0,
    index: 0,
    x: 0,
    y: 0,
    hue: 'thermal',
    ctx: null as unknown as FireContext,
    corrupted: false,
    spread: null,
    instances: 1,
  };

  constructor(config: RunConfig) {
    this.config = config;
    this.discoveries = new DiscoveryTracker(config.knownDiscoveries);
    this.rng = new Rng(config.seed);
    this.arena = getArena(config.arenaId ?? 'heap');
    this.grid = new SpatialGrid<Enemy>(this.arena.width, this.arena.height);
    // LEVELS §4 — levels the story says start open: no barrier, no gate, the
    // camera sees them from frame one. The site has stopped resealing itself.
    const preOpened = new Set(config.openLevels ?? []);
    for (const id of preOpened) this.openBiomes.add(id);
    // §21b.5 — barriers are ruins, so the live list is the arena's plus every
    // *closed* gate's wall, and the field is baked from the live list. A relay
    // has no wall; a pre-opened room's wall was never baked.
    this.ruins = [
      ...this.arena.ruins,
      ...(this.arena.gates ?? [])
        .filter((g) => g.barrier && !(g.opens && preOpened.has(g.opens)))
        .map((g) => g.barrier!),
    ];
    this.flow = new FlowField(this.arena);
    this.flow.rebuild(this.ruins);

    this.engine = new Engine();
    this.installAxiomStarter();

    this.baseCapacity =
      TUNABLE.cycleCapacityBase + getAxiom(config.axiomId).capacityDelta + (config.bonusCapacity ?? 0);
    this.budget = new CycleBudget(this.baseCapacity);
    this.budget.setStaticLoad(this.engine.staticLoad);
    this.placeGates();
    this.placeAuthoredPois();

    this.player = {
      x: this.arena.spawnX,
      y: this.arena.spawnY,
      prevX: this.arena.spawnX,
      prevY: this.arena.spawnY,
      vx: 0,
      vy: 0,
      integrity: TUNABLE.playerIntegrity,
      maxIntegrity: TUNABLE.playerIntegrity,
      iframes: 0,
      dashTimer: 0,
      dashCooldown: 0,
      dirX: 0,
      dirY: -1,
      speedBoost: 0,
      speedBoostTime: 0,
      outputBoost: 0,
      outputBoostTime: 0,
      alive: true,
    };
    this.traitCtx = {
      dt: 0,
      time: 0,
      enemy: null as unknown as Enemy,
      def: null as unknown as EnemyDef,
      spec: null as unknown as TraitSpec,
      player: this.player,
      arena: this.arena,
      projectiles: this.projectiles,
      collide: (body, radius) => this.resolveRuins(body, radius),
      sampleFlow: (x, y, out) => this.flow.sample(x, y, out),
      flowCellSize: this.flow.cellSize,
      neighbours: (x, y, radius, fn) => this.grid.queryRadius(x, y, radius, fn),
      fx: (kind, hue, x, y, radius, life) => this.pushFx(kind, hue, x, y, radius, [], life),
      cue: (kind, hue, depth, weight) => this.cue(kind, hue, depth, weight),
      feed: (e, share) => this.feedInterceptor(e, share),
      touch: (e, def) => this.touchPlayer(e, def),
      hurt: (amount, cause) => this.hurtPlayer(amount, cause),
      beam: (e, ux, uy) =>
        this.pushFx(
          'chain',
          e.hue,
          e.x,
          e.y,
          0,
          [e.x, e.y, e.x + ux * TUNABLE.lancerBeamRange, e.y + uy * TUNABLE.lancerBeamRange],
          0.18,
        ),
      lancers: { charging: 0 },
    };

    this.hazardCtx = {
      player: this.player,
      arena: this.arena,
      chance: (q) => this.rng.chance(q),
      range: (lo, hi) => this.rng.range(lo, hi),
      next: () => this.rng.next(),
      hurt: (amount, cause) => this.hurtPlayer(amount, cause),
    };

    this.xpToNext = TUNABLE.xpFirstLevel;
  }

  /** §8.4 — the Axiom's starter Program, at run start and after a Recompile. */
  private installAxiomStarter(): void {
    const ax = getAxiom(this.config.axiomId);
    const install = (row: number, def: AxiomDef['starter']): void => {
      const p = this.engine.programs[row];
      if (!p) return;
      p.triggerId = def.trigger;
      p.actionId = def.action;
      def.modifiers.forEach((m, i) => {
        if (i < p.modifierIds.length) p.modifierIds[i] = m;
      });
    };
    // The seed goes first, so it reads top-down as cause then consequence.
    if (ax.seed) {
      install(0, ax.seed);
      install(1, ax.starter);
    } else {
      install(0, ax.starter);
    }

    // STORY-AND-TONE §7.1 — the growing starter. Filled into empty rows after
    // the Axiom's own; anything past the last empty row is dropped silently,
    // because the story hands these out and the sim only installs.
    for (const row of this.config.bonusRows ?? []) {
      const slot = this.engine.programs.findIndex((p) => !p.triggerId && !p.actionId);
      if (slot < 0) break;
      install(slot, { trigger: row.trigger, modifiers: [...row.modifiers], action: row.action });
    }
    this.engine.recompile();
  }

  // ---------------------------------------------------------------- main step

  advance(input: InputState, dt: number = SIM_DT): void {
    if (!this.player.alive) return;

    this.time += dt;
    this.tickCount++;
    this.eventsThisTick = 0;

    this.budget.beginTick(dt);

    this.updatePlayer(input, dt);
    // Rebuild navigation before anything steers. Cheap, and a no-op unless the
    // player has left their cell.
    this.flow.update(this.player.x, this.player.y);
    this.updateEnemies(dt);
    this.recycleStragglers();
    this.grid.rebuild(this.enemies);
    this.updateProjectiles(dt);
    this.updateZones(dt);
    this.updateMines(dt);
    this.updateOrbitals(dt);
    this.releasePendingBursts();
    this.updatePickups(dt);
    this.consolidatePickups(dt);
    if (this.magnetCooldown > 0) this.magnetCooldown = Math.max(0, this.magnetCooldown - dt);
    this.updateFx(dt);
    this.updateTerminals(input, dt);
    this.updateBreach();
    this.updateMeltdown(dt);
    this.updateDirector(dt);
    if (this.surgeTime > 0) this.surgeTime = Math.max(0, this.surgeTime - dt);
    this.surgeRateTime = Math.max(0, this.surgeRateTime - dt);
    if (this.surgeRateTime <= 0) this.surgeRate = 0;

    // §11.2 — inside a Suppressor's zone the player's Triggers do not fire.
    // Actions already in flight resolve; nothing new starts.
    const wasInHazard = this.wasInHazard;
    const wasSuppressed = this.suppressedNow;
    this.suppressedNow = this.suppressed;
    // Integrated here, where the state is already known for the tick. Counting
    // the crossing separately because forty seconds in one field and forty
    // one-second crossings are different games and the same number.
    if (this.suppressedNow) {
      this.stats.suppressedSeconds += dt;
      if (!wasSuppressed) this.stats.suppressionEntries++;
    }
    // §5.3 On Enter — fired on the *crossing*, which is the one instant inside a
    // suppression field where a Trigger still works. Walking in is a decision;
    // this is what pays for it.
    // §5.3 On Enter — crossing into *any* hazard. A trigger that only fires on
    // one enemy type is a card nobody takes; Containment (§11.4) is the same
    // shape of danger and the same moment of decision.
    const inHazard = this.suppressedNow || this.insideContainment;
    if (inHazard && !wasInHazard) {
      this.emit({ type: 'enter', depth: 0, x: this.player.x, y: this.player.y });
    }
    this.wasInHazard = inHazard;


    // §5.3 On Threshold — Heat crossing a tier, climbing only. Cooling back down
    // through a tier is relief, not an event.
    const tier = this.budget.tier;
    if (tier > this.lastTier) {
      this.emit({ type: 'threshold', depth: 0, x: this.player.x, y: this.player.y });
    }
    this.lastTier = tier;

    if (!this.budget.stalled) {
      if (!this.suppressedNow) this.advanceClocks(dt);
      this.runScheduled();
      this.drainEvents();
    }

    // §21b.4 — where you are standing changes how fast you vent. A Cooler is
    // worth more than any single Coolant card, and it cannot be taken with you:
    // the trade is that using it means being in one place.
    let vent = this.bonuses.coolant;
    const biome = this.biome;
    if (biome?.ventMultiplier) {
      vent += TUNABLE.heatDecayPerSec * (biome.ventMultiplier - 1);
    }
    for (const t of this.terminals) {
      if (!t.alive || t.kind !== 'cooler') continue;
      const dx = this.player.x - t.x;
      const dy = this.player.y - t.y;
      if (dx * dx + dy * dy < TUNABLE.coolerRadius * TUNABLE.coolerRadius) {
        vent += TUNABLE.coolerVenting;
        break;
      }
    }
    this.budget.extraVenting = vent;

    // §6.2 — the tick's event volume, priced before the gauge is closed.
    this.budget.chargeVolume(this.eventsThisTick, dt);

    if (this.budget.endTick(dt)) {
      this.stats.overheats++;
      this.cue('overheat', 'thermal', 0, 1);
      this.emit({ type: 'overheat', depth: 0, x: this.player.x, y: this.player.y });
      if (!this.budget.stalled) this.drainEvents();
    }

    this.stats.tierSeconds[this.budget.tier] += dt;
    this.heatIntegral += this.budget.heat * dt;
    // Smoothed, so the HUD shows a depth you can read rather than a per-tick
    // number that flickers. This is the number Heat is *caused by*, and showing
    // it beside the gauge is the whole point of moving Heat onto depth.
    const depthDecay = ppow(0.5, dt / 0.6);
    this.depthAverage =
      this.depthAverage * depthDecay + this.budget.depthThisTick * (1 - depthDecay);
    if (this.budget.heat > this.stats.peakHeat) this.stats.peakHeat = this.budget.heat;

    this.compact();
    this.updateScore(dt);
    // §15.3 — last, so a Discovery sees the finished tick rather than a
    // half-updated one. Deterministic: same seed, same inputs, same Discoveries.
    this.discoveries.update(this, dt);
  }

  // ------------------------------------------------------------------- events

  /** Enqueue an event. Depth beyond the cap is dropped silently (§5.2). */
  emit(event: GameEvent): void {
    if (event.depth > LOADBEARING.cascadeDepthCap) {
      this.stats.droppedByDepth++;
      return;
    }
    if (this.eventQueue.length >= SAFETY.maxEventsPerTick) return;
    if (event.depth > this.stats.maxDepth) this.stats.maxDepth = event.depth;
    this.eventQueue.push(event);
  }

  private drainEvents(): void {
    // Head-index queue: cascades can enqueue thousands of events per tick and
    // Array.shift() would make draining quadratic.
    let head = 0;
    let processed = 0;
    while (head < this.eventQueue.length) {
      if (++processed > SAFETY.maxEventsPerTick) {
        // Runtime safety valve, never a balance lever (§5.2).
        this.stats.safetyTrips++;
        break;
      }
      const ev = this.eventQueue[head++]!;
      this.countEvent();
      this.dispatch(ev);
    }
    this.eventQueue.length = 0;
  }

  /** Cached once per tick: recomputing it per event would be O(events x enemies). */
  suppressedNow = false;

  /** Fire every live Program whose Trigger listens for this event type. */
  private dispatch(ev: GameEvent): void {
    if (this.suppressedNow) return;
    for (let i = 0; i < this.engine.programs.length; i++) {
      const compiled = this.engine.compiled[i]!;
      if (!compiled.live) continue;
      const trig = TRIGGER_BY_ID.get(this.engine.programs[i]!.triggerId!)!;
      if (trig.listens !== ev.type) continue;
      // A Clock program never fires off the event bus; it self-schedules.
      if (trig.interval !== undefined && ev.type === 'clock') continue;
      this.fireProgram(i, ev.depth, ev.x, ev.y);
    }
  }

  private advanceClocks(dt: number): void {
    for (let i = 0; i < this.engine.programs.length; i++) {
      const compiled = this.engine.compiled[i]!;
      if (!compiled.live) continue;

      // §5.3 On Idle — a row that has gone quiet fires itself.
      //
      // This started life as "On Lull: nothing has died for two seconds", which
      // is a condition a player can neither see nor cause, on a card they would
      // therefore never take. Measured: offered four times across two runs and
      // refused every time. As a *per-row* idle it is a card with a use on every
      // build — the safety net under a Trigger that has stopped feeding.
      const program = this.engine.programs[i]!;
      if (program.triggerId && TRIGGER_BY_ID.get(program.triggerId)?.listens === 'idle') {
        const quiet = this.time - (this.engine.lastFired[i] ?? -Infinity);
        if (quiet >= TUNABLE.idleSeconds) {
          this.engine.lastFired[i] = this.time;
          this.fireProgram(i, 0, this.player.x, this.player.y);
        }
        continue;
      }

      if (compiled.interval <= 0) continue;
      // §5.4 Surge speeds up every Clock the player owns while it is active.
      const interval = compiled.interval / (1 + this.surgeRate);
      this.engine.clocks[i] = (this.engine.clocks[i] ?? 0) + dt;
      let guard = 0;
      while (this.engine.clocks[i]! >= interval && guard++ < 32) {
        this.engine.clocks[i] = this.engine.clocks[i]! - interval;
        this.fireProgram(i, 0, this.player.x, this.player.y);
      }
    }
  }

  /**
   * Fire one Program. Charges Cycles, rolls misfire, then runs the Echo-expanded
   * execution schedule — immediate executions now, delayed ones queued.
   */
  private fireProgram(index: number, depth: number, x: number, y: number): void {
    const compiled = this.engine.compiled[index];
    const program = this.engine.programs[index];
    if (!compiled?.live || !program) return;

    // Per-Action cooldown, checked before charging: an engine should not burn
    // Cycles — and therefore generate Heat — on a fire that was never going to
    // happen. See ActionDef.cooldown for why persistent Actions need this.
    const action = program.actionId ? ACTION_BY_ID.get(program.actionId) : undefined;
    if (action?.cooldown) {
      if (this.time - (this.engine.lastFired[index] ?? -Infinity) < action.cooldown) return;
      this.engine.lastFired[index] = this.time;
    }

    // §6.2 — depth is what heats you. Firing itself is free: Cycles are a static
    // reservation now, so a fire has already been paid for by existing. What has
    // not been paid for is *how deep into a cascade* this fire is, and that is
    // charged here, per event, so a chain's total cost grows with its own depth.
    // §5.5 Grounding Rod — this row's events start a fresh cascade. Everything
    // downstream of it is depth 0 again: no falloff, no Heat for how deep it
    // was. It is the most expensive modifier in the game (x1.6) for exactly that
    // reason, and it is the answer to a build that runs deep and cooks itself.
    if (compiled.ctx.rootDepth > 0) depth = 0;

    // §5.5 Insulate — a row that makes no Heat at all, for a quarter of its
    // output. Heat is charged from depth, so this is where it is skipped.
    if (compiled.ctx.insulate <= 0) this.budget.chargeDepth(depth);
    // §5.3 On Depth — the Engine listening to itself. Fired once per Program per
    // tick at the depth where Heat starts charging in earnest, so a build can
    // route its deepest cascades into something else. Gated per tick because a
    // deep chain resolves hundreds of events and each of them is "deep".
    if (depth >= TUNABLE.onDepthAt && !this.deepThisTick.has(index)) {
      this.deepThisTick.add(index);
      this.emit({ type: 'depth', depth, x: this.player.x, y: this.player.y });
    }

    if (this.budget.rollMisfire(this.rng)) {
      this.stats.misfires++;
      return;
    }

    program.fireCount++;
    program.tickEvents++;
    this.stats.fires++;
    const fireDef = program.actionId ? ACTION_BY_ID.get(program.actionId) : null;
    this.cue('fire', fireDef?.hue ?? 'thermal', depth, Math.min(1, compiled.cycleCost / 8));

    // §5.5 Overdrive — "every fire adds Heat directly", budget or no budget.
    // This is the node that lets a player choose instability rather than be
    // handed it, which §6.3 calls an intended archetype.
    if (compiled.ctx.overdrive > 0) {
      this.budget.addHeat(TUNABLE.overdriveHeatPerFire * compiled.ctx.overdrive);
    }

    // §5.5 Quantize — snap to the beat grid. Landing on-beat pays a bonus; the
    // grid exists in the simulation now so audio can lock to the same clock.
    let beatBonus = 1;
    if (compiled.ctx.quantize > 0) {
      const step = 60 / TUNABLE.beatsPerMinute / 4;
      const phase = (this.time % step) / step;
      beatBonus = phase < 0.25 || phase > 0.75 ? 1 + TUNABLE.quantizeBonus : 1;
    }

    for (const exec of compiled.executions) {
      if (exec.delay <= 0) {
        this.execute(index, exec.outputMul * beatBonus, depth, x, y);
      } else if (this.scheduled.length < SAFETY.maxScheduledFires) {
        this.scheduled.push({
          time: this.time + exec.delay,
          programIndex: index,
          outputMul: exec.outputMul * beatBonus,
          depth,
          x,
          y,
          alive: true,
        });
      }
    }

    // §5.6 Resonate — the row below also fires when this one does. Chains of
    // Resonate form an exponential ladder, which is the point; the cascade depth
    // cap is what keeps it finite.
    const below = this.engine.compiled[index + 1];
    if (below?.live && below.ctx.resonate > 0) {
      this.fireProgram(index + 1, depth + 1, x, y);
    }
  }

  private runScheduled(): void {
    if (this.scheduled.length === 0) return;
    let due = false;
    for (const s of this.scheduled) {
      if (s.alive && s.time <= this.time) {
        s.alive = false;
        due = true;
        this.execute(s.programIndex, s.outputMul, s.depth, s.x, s.y);
      }
    }
    if (due) {
      let w = 0;
      for (let r = 0; r < this.scheduled.length; r++) {
        const s = this.scheduled[r]!;
        if (s.alive) this.scheduled[w++] = s;
      }
      this.scheduled.length = w;
    }
  }

  /** Run one execution of a Program's Action, `count` instances of it. */
  private execute(index: number, outputMul: number, depth: number, x: number, y: number): void {
    const compiled = this.engine.compiled[index];
    const program = this.engine.programs[index];
    if (!compiled?.live || !program?.actionId) return;

    const def = ACTION_BY_ID.get(program.actionId)!;
    const instances = Math.max(1, Math.round(compiled.ctx.count));

    const runner = ACTION_RUNNERS[def.primitive];
    if (!runner) return;

    const hue = def.hue;

    // §5.5 Split — copies take the *next* target, not the same one.
    //
    // Every instance used to aim at grid.nearest() from the same origin at the
    // same speed, so three copies flew as one pixel and Split was a damage
    // multiplier with no picture. Handing each copy the next-nearest enemy makes
    // it what the card implies: a card that covers a crowd. Cleared per
    // execution, and reset when the targets run out so a Split into a single
    // enemy still puts all of it into that enemy.
    const spread = def.primitive === 'projectile' && instances > 1 ? this.splitTaken : null;
    if (spread) spread.length = 0;

    // §7.4 — an `all` runner owns the whole cast and runs before output, damage
    // or corruption exist. Convert is the only one, and it must stay this side
    // of the loop: its early return is what keeps the corruption draw off the
    // stream, and moving it would shift every seed.
    const cast = this.actionCast;
    cast.def = def;
    cast.depth = depth;
    cast.index = index;
    cast.hue = hue;
    cast.ctx = compiled.ctx;
    cast.spread = spread;
    cast.instances = instances;
    if (runner.phase === 'all') {
      cast.damage = 0;
      cast.x = x;
      cast.y = y;
      cast.corrupted = false;
      runner.run(this, cast);
      return;
    }

    // Actions happen where the triggering event happened, unless they say
    // otherwise — see ActionDef.origin. This is what lets a cascade travel.
    const atPlayer = def.origin === 'player';
    const ox = atPlayer ? this.player.x : x;
    const oy = atPlayer ? this.player.y : y;

    for (let n = 0; n < instances; n++) {
      // ...and pays less. Together these let a cascade run wild near its source
      // and run out of steam as it travels, rather than being cut off.
      const depthFalloff = ppow(TUNABLE.cascadeOutputFalloff, depth);
      const output =
        compiled.ctx.output *
        outputMul *
        depthFalloff *
        this.engine.globalOutput *
        (1 + this.bonuses.power) *
        // §8.2 Momentum — output for staying untouched, capped so a passive
        // build cannot farm it by hiding. Resets the instant anything lands.
        (1 + Math.min(TUNABLE.momentumCap, this.sinceHurt * this.bonuses.momentum)) *
        // §7.4 Convert: Bleed — Integrity spent, damage back, for a few seconds.
        (1 + this.player.outputBoost);
      const damage = def.damage * output;
      const corrupted =
        this.budget.corruptionChance > 0 && this.rng.chance(this.budget.corruptionChance);

      cast.damage = damage;
      cast.x = ox;
      cast.y = oy;
      cast.corrupted = corrupted;
      runner.run(this, cast);
    }
  }

  // ------------------------------------------------------------------ actions

  /**
   * §5 — the verbs an Action primitive may use, reached by `ACTION_RUNNERS`.
   *
   * Thin on purpose. The bodies below are unchanged; what these buy is one
   * argument order per verb instead of eleven call sites each passing a
   * different subset in a different order, and a table the coverage test can
   * compare against `actions.json` and `PRIMITIVE_FIELDS`.
   */
  actProjectile(
    id: string,
    damage: number,
    depth: number,
    index: number,
    x: number,
    y: number,
    ctx: FireContext,
    corrupted: boolean,
    hue: Hue,
    spread: number[] | null,
  ): void {
    this.spawnProjectile(id, damage, depth, index, x, y, ctx, corrupted, hue, spread);
  }

  actBurst(
    id: string,
    damage: number,
    depth: number,
    index: number,
    x: number,
    y: number,
    ctx: FireContext,
    hue: Hue,
  ): void {
    this.doBurst(id, damage, depth, index, x, y, ctx.area * this.areaMul, hue, ctx.leech, ctx.bloom);
  }

  actChain(
    id: string,
    damage: number,
    depth: number,
    index: number,
    x: number,
    y: number,
    hue: Hue,
    ctx: FireContext,
  ): void {
    this.doChain(id, damage, depth, index, x, y, hue, ctx);
  }

  actZone(
    id: string,
    damage: number,
    depth: number,
    index: number,
    x: number,
    y: number,
    hue: Hue,
    ctx: FireContext,
  ): void {
    this.dropZone(
      id,
      damage,
      depth,
      index,
      x,
      y,
      ctx.area * this.areaMul,
      ctx.duration * this.durationMul,
      hue,
      ctx,
    );
  }

  actMine(
    def: ActionDef,
    damage: number,
    depth: number,
    index: number,
    ctx: FireContext,
    hue: Hue,
  ): void {
    this.dropMine(def, damage, depth, index, ctx, hue);
  }

  actRupture(
    def: ActionDef,
    damage: number,
    depth: number,
    index: number,
    x: number,
    y: number,
    ctx: FireContext,
    hue: Hue,
  ): void {
    this.markRupture(def, damage, depth, index, x, y, ctx, hue);
  }

  actBeam(
    def: ActionDef,
    damage: number,
    depth: number,
    index: number,
    x: number,
    y: number,
    ctx: FireContext,
    hue: Hue,
  ): void {
    this.fireBeam(def, damage, depth, index, x, y, ctx, hue);
  }

  actOrbital(
    def: ActionDef,
    damage: number,
    depth: number,
    index: number,
    ctx: FireContext,
    hue: Hue,
  ): void {
    this.addOrbital(def, damage, depth, index, ctx, hue);
  }

  actSurge(def: ActionDef, ctx: FireContext): void {
    this.applySurge(def, ctx);
  }

  actShove(
    def: ActionDef,
    damage: number,
    depth: number,
    index: number,
    x: number,
    y: number,
    ctx: FireContext,
    hue: Hue,
  ): void {
    this.doShove(def, damage, depth, index, x, y, ctx, hue);
  }

  actConvert(def: ActionDef, depth: number): void {
    this.runConvert(def, depth);
  }

  private spawnProjectile(
    actionId: string,
    damage: number,
    depth: number,
    programIndex: number,
    x: number,
    y: number,
    ctx: FireContext,
    corrupted: boolean,
    hue: Hue,
    spread: number[] | null = null,
  ): void {
    if (this.projectiles.length >= SAFETY.maxEntities) return;
    const def = ACTION_BY_ID.get(actionId)!;
    let target = spread
      ? this.grid.nearest(x, y, Infinity, (e) => spread.includes(e.id))
      : this.grid.nearest(x, y);
    // Out of fresh targets: start the list again rather than firing into empty
    // space. Three copies into one enemy is still three copies into one enemy.
    if (!target && spread && spread.length > 0) {
      spread.length = 0;
      target = this.grid.nearest(x, y);
    }
    if (target && spread) spread.push(target.id);
    let dx: number;
    let dy: number;
    if (target) {
      dx = target.x - x;
      dy = target.y - y;
      const len = hypot(dx, dy) || 1;
      dx /= len;
      dy /= len;
    } else {
      // No target: fire along facing so the engine is never silently idle (§17.3).
      dx = this.player.dirX;
      dy = this.player.dirY;
    }
    // Ballistics' other half. The card has always said "+1 Pierce and +20%
    // projectile speed" and only the Pierce was ever implemented — the speed
    // term existed in the text and nowhere else. It matters twice over now:
    // range is speed x lifetime, so this is also the flight-only range stat
    // sitting next to Reach, which covers everything.
    const speed = (def.speed ?? 400) * (1 + this.bonuses.travels * 0.2) * ctx.speed;
    this.projectiles.push({
      id: this.nextId++,
      x,
      y,
      vx: dx * speed,
      vy: dy * speed,
      life: (def.lifetime ?? 2) * this.reachMul * ctx.range * ppow(TUNABLE.cascadeReachFalloff, depth),
      damage,
      pierce: (def.pierce ?? 0) + Math.round(ctx.pierce) + this.bonuses.travels,
      hue,
      depth,
      programIndex,
      radius: 4,
      corrupted,
      hits: [],
      age: 0,
      bounces: Math.round(ctx.bounce),
      volatile: ctx.volatile,
      leech: ctx.leech,
      seek: (def.seek ?? 0) + ctx.seek,
      siphon: def.siphon ?? 0,
      alive: true,
    });
  }

  private doBurst(
    actionId: string,
    damage: number,
    depth: number,
    programIndex: number,
    x: number,
    y: number,
    area: number,
    hue: Hue,
    leech = 0,
    bloom = 0,
  ): void {
    const def = ACTION_BY_ID.get(actionId)!;
    const radius = (def.radius ?? 100) * Math.max(0.1, area);
    this.grid.queryRadius(x, y, radius, (enemy) => {
      this.damageEnemy(enemy, damage, depth, programIndex, hue, leech);
    });
    this.pushFx('burst', hue, x, y, radius, [], 0.22);

    // §5.5 Bloom — a second, smaller detonation right after the first. Deferred
    // rather than immediate, because two explosions in one frame is just one
    // explosion with a bigger number on it. Rupture's own scheduler carries it:
    // a delayed burst at a position is exactly what that is.
    if (bloom > 0 && this.pendingBursts.length < SAFETY.maxScheduledFires) {
      this.pendingBursts.push({
        time: this.time + 0.16,
        x,
        y,
        radius: radius * 0.7,
        damage: damage * bloom,
        hue,
        depth,
        programIndex,
        leech,
        alive: true,
      });
    }
  }

  private doChain(
    actionId: string,
    damage: number,
    depth: number,
    programIndex: number,
    x: number,
    y: number,
    hue: Hue,
    ctx: FireContext,
  ): void {
    const leech = ctx.leech;
    const def = ACTION_BY_ID.get(actionId)!;
    const jumps = (def.jumps ?? 3) + Math.round(ctx.jumps);
    const range = (def.range ?? 200) * this.reachMul * ctx.range * ppow(TUNABLE.cascadeReachFalloff, depth);
    const hit: number[] = [];
    const points: number[] = [x, y];
    let cx = x;
    let cy = y;
    for (let j = 0; j < jumps; j++) {
      const target = this.grid.nearest(cx, cy, range, (e) => hit.includes(e.id));
      if (!target) break;
      hit.push(target.id);
      points.push(target.x, target.y);
      cx = target.x;
      cy = target.y;
      this.damageEnemy(target, damage, depth, programIndex, hue, leech);
    }
    if (points.length > 2) this.pushFx('chain', hue, x, y, 0, points, 0.14);
  }

  /**
   * §5.4 Field — a persistent zone placed on the densest nearby enemy cluster.
   * "Densest" is sampled from a handful of live enemies rather than solved
   * exactly: cheap, deterministic, and it reads correctly in play.
   */
  private dropZone(
    actionId: string,
    damage: number,
    depth: number,
    programIndex: number,
    x: number,
    y: number,
    area: number,
    duration: number,
    hue: Hue,
    ctx: FireContext,
  ): void {
    const def = ACTION_BY_ID.get(actionId)!;
    const radius = (def.radius ?? 130) * Math.max(0.1, area);

    // Evict the oldest rather than refusing the newest: a Field build should
    // keep feeling responsive at the cap, not silently stop working.
    if (this.zones.length >= SAFETY.maxZones) {
      let oldest = -1;
      let oldestLife = Infinity;
      for (let i = 0; i < this.zones.length; i++) {
        const z = this.zones[i]!;
        if (z.alive && z.life < oldestLife) {
          oldestLife = z.life;
          oldest = i;
        }
      }
      if (oldest >= 0) this.zones[oldest]!.alive = false;
      else return;
    }

    let bestX = x;
    let bestY = y;
    let bestCount = -1;
    // Only Field hunts for a cluster (§5.4: "at the densest nearby enemy
    // cluster"). Pull happens where its trigger happened, or it reads as a
    // vortex appearing at random.
    const samples = def.origin === 'cluster' ? Math.min(6, this.enemies.length) : 0;
    for (let i = 0; i < samples; i++) {
      const candidate = this.enemies[this.rng.int(this.enemies.length)]!;
      if (!candidate.alive) continue;
      let count = 0;
      this.grid.queryRadius(candidate.x, candidate.y, radius, () => {
        count++;
      });
      if (count > bestCount) {
        bestCount = count;
        bestX = candidate.x;
        bestY = candidate.y;
      }
    }

    this.zones.push({
      id: this.nextId++,
      hue,
      x: bestX,
      y: bestY,
      radius,
      life: (def.lifetime ?? 3) * Math.max(0.1, duration),
      maxLife: (def.lifetime ?? 3) * Math.max(0.1, duration),
      damage,
      tickInterval: def.tickInterval ?? 0.35,
      tickTimer: 0,
      depth,
      programIndex,
      force: def.force ?? 0,
      leech: ctx.leech,
      volatile: ctx.volatile,
      alive: true,
    });
  }

  /** §5.4 Mine — a proximity charge at the avatar's position. */
  private dropMine(
    def: ActionDef,
    damage: number,
    depth: number,
    programIndex: number,
    ctx: FireContext,
    hue: Hue,
  ): void {
    if (this.mines.length >= SAFETY.maxZones) this.mines[0]!.alive = false;
    const life = (def.lifetime ?? 8) * Math.max(0.1, (ctx.duration * this.durationMul));
    this.mines.push({
      id: this.nextId++,
      hue,
      x: this.player.x,
      y: this.player.y,
      damage,
      radius: (def.radius ?? 100) * Math.max(0.1, (ctx.area * this.areaMul)),
      triggerRadius: (def.triggerRadius ?? 44) * Math.max(0.1, (ctx.area * this.areaMul)),
      arm: def.armTime ?? 0.3,
      life,
      maxLife: life,
      depth,
      programIndex,
      leech: ctx.leech,
      volatile: ctx.volatile,
      alive: true,
    });
  }

  /** §5.4 Rupture — a delayed explosion at the target's position. */
  private markRupture(
    def: ActionDef,
    damage: number,
    depth: number,
    programIndex: number,
    x: number,
    y: number,
    ctx: FireContext,
    hue: Hue,
  ): void {
    const target = this.grid.nearest(x, y, 900);
    const tx = target ? target.x : x;
    const ty = target ? target.y : y;
    const radius = (def.radius ?? 120) * Math.max(0.1, (ctx.area * this.areaMul));
    if (this.pendingBursts.length < SAFETY.maxScheduledFires) {
      this.pendingBursts.push({
        time: this.time + (def.delay ?? 0.7),
        x: tx,
        y: ty,
        radius,
        damage,
        hue,
        depth,
        programIndex,
        leech: ctx.leech,
        alive: true,
      });
    }
    // §17.1 — the mark is drawn before the detonation lands.
    this.pushFx('rupture', hue, tx, ty, radius, [], def.delay ?? 0.7);
  }

  private releasePendingBursts(): void {
    if (this.pendingBursts.length === 0) return;
    let due = false;
    for (const b of this.pendingBursts) {
      if (!b.alive || b.time > this.time) continue;
      b.alive = false;
      due = true;
      this.grid.queryRadius(b.x, b.y, b.radius, (enemy) => {
        this.damageEnemy(enemy, b.damage, b.depth, b.programIndex, b.hue, b.leech);
      });
      this.pushFx('burst', b.hue, b.x, b.y, b.radius, [], 0.24);
    }
    if (due) {
      let w = 0;
      for (let r = 0; r < this.pendingBursts.length; r++) {
        const b = this.pendingBursts[r]!;
        if (b.alive) this.pendingBursts[w++] = b;
      }
      this.pendingBursts.length = w;
    }
  }

  /** §5.4 Beam — an instant line to the farthest enemy in range. */
  private fireBeam(
    def: ActionDef,
    damage: number,
    depth: number,
    programIndex: number,
    x: number,
    y: number,
    ctx: FireContext,
    hue: Hue,
  ): void {
    const range = (def.range ?? 800) * this.reachMul * ctx.range * ppow(TUNABLE.cascadeReachFalloff, depth);
    // Farthest, not nearest: the point of a beam is everything on the way.
    let far: Enemy | null = null;
    let farD2 = 0;
    for (const e of this.enemies) {
      if (!e.alive || e.phased) continue;
      const dx = e.x - x;
      const dy = e.y - y;
      const d2 = dx * dx + dy * dy;
      if (d2 <= range * range && d2 > farD2) {
        farD2 = d2;
        far = e;
      }
    }
    const angle = far ? patan2(far.y - y, far.x - x) : patan2(this.player.dirY, this.player.dirX);
    const ux = pcos(angle);
    const uy = psin(angle);
    const width = (def.beamWidth ?? 12) * Math.max(0.1, (ctx.area * this.areaMul));

    for (const e of this.enemies) {
      if (!e.alive) continue;
      const px = e.x - x;
      const py = e.y - y;
      const along = px * ux + py * uy;
      if (along < 0 || along > range) continue;
      if (Math.abs(px * -uy + py * ux) > width + e.radius) continue;
      this.damageEnemy(e, damage, depth, programIndex, hue, ctx.leech);
    }
    this.pushFx('chain', hue, x, y, width, [x, y, x + ux * range, y + uy * range], 0.16);
  }

  /** §5.4 Orbital — persistent, and they stack. */
  private addOrbital(
    def: ActionDef,
    damage: number,
    depth: number,
    programIndex: number,
    ctx: FireContext,
    hue: Hue,
  ): void {
    if (this.orbitals.length >= TUNABLE.maxOrbitals) this.orbitals[0]!.alive = false;
    const life = (def.lifetime ?? 12) * Math.max(0.1, (ctx.duration * this.durationMul));
    this.orbitals.push({
      id: this.nextId++,
      hue,
      x: this.player.x,
      y: this.player.y,
      damage,
      radius: (def.radius ?? 12) * Math.max(0.1, (ctx.area * this.areaMul)),
      orbitRadius: (def.orbitRadius ?? 110) * Math.max(0.1, (ctx.area * this.areaMul)),
      orbitSpeed: def.orbitSpeed ?? 2.2,
      angle: this.rng.next() * Math.PI * 2,
      life,
      maxLife: life,
      depth,
      programIndex,
      leech: ctx.leech,
      volatile: ctx.volatile,
      cooldowns: new Map(),
      alive: true,
    });
  }

  /** §5.4 Surge — a short self-buff on the engine's own rate. */
  private applySurge(def: ActionDef, ctx: FireContext): void {
    this.surgeRate = Math.max(this.surgeRate, def.rateBonus ?? 0.4);
    this.surgeRateTime = Math.max(
      this.surgeRateTime,
      (def.lifetime ?? 2) * Math.max(0.1, (ctx.duration * this.durationMul)),
    );
  }

  /**
   * §5.4 Shove — radial knockback, with §23.1's guard.
   *
   * Each enemy has a displacement budget per second. Stacked Shoves therefore
   * cannot hold the horde at arm's length forever: "permanent knockback walls"
   * is a named tension break, and a build that stops the game asking you to move
   * is a bug rather than a power break.
   */
  private doShove(
    def: ActionDef,
    damage: number,
    depth: number,
    programIndex: number,
    x: number,
    y: number,
    ctx: FireContext,
    hue: Hue,
  ): void {
    const radius = (def.radius ?? 180) * Math.max(0.1, (ctx.area * this.areaMul));
    const impulse = def.knockback ?? 240;
    this.grid.queryRadius(x, y, radius, (enemy) => {
      const dx = enemy.x - x;
      const dy = enemy.y - y;
      const d = hypot(dx, dy) || 1;
      const falloff = 1 - d / radius;
      const wanted = impulse * falloff;
      const allowed = Math.min(wanted, enemy.shoveBudget);
      if (allowed > 0) {
        enemy.shoveBudget -= allowed;
        enemy.x += (dx / d) * allowed * SIM_DT * 6;
        enemy.y += (dy / d) * allowed * SIM_DT * 6;
        this.resolveRuins(enemy, enemy.radius);
      }
      if (damage > 0) this.damageEnemy(enemy, damage, depth, programIndex, hue, ctx.leech);
    });
    this.pushFx('burst', hue, x, y, radius, [], 0.2);
  }

  /**
   * §5.5 Volatile, for anything with a life.
   *
   * A Field that ends, a Mine that times out, an Orbital that runs down: each
   * leaves a detonation worth `share` of its damage. The card has always said
   * "effects detonate at the end of their life" and until now only projectiles
   * did — which made Volatile a no-op on 14 of 17 Actions, including the three
   * whose entire nature is *having* an end of life.
   */
  private expire(
    share: number,
    damage: number,
    radius: number,
    x: number,
    y: number,
    hue: Hue,
    depth: number,
    programIndex: number,
    leech: number,
  ): void {
    if (share <= 0) return;
    this.grid.queryRadius(x, y, radius, (enemy) => {
      this.damageEnemy(enemy, damage * share, depth, programIndex, hue, leech);
    });
    this.pushFx('burst', hue, x, y, radius, [], 0.22);
  }

  private updateMines(dt: number): void {
    for (const m of this.mines) {
      if (!m.alive) continue;
      m.arm = Math.max(0, m.arm - dt);
      m.life -= dt;
      if (m.life <= 0) {
        m.alive = false;
        this.expire(m.volatile, m.damage, m.radius, m.x, m.y, m.hue, m.depth, m.programIndex, m.leech);
        continue;
      }
      if (m.arm > 0) continue;
      let triggered = false;
      this.grid.queryRadius(m.x, m.y, m.triggerRadius, () => {
        triggered = true;
      });
      if (!triggered) continue;
      m.alive = false;
      this.grid.queryRadius(m.x, m.y, m.radius, (enemy) => {
        this.damageEnemy(enemy, m.damage, m.depth, m.programIndex, m.hue, m.leech);
      });
      this.pushFx('burst', m.hue, m.x, m.y, m.radius, [], 0.26);
    }
  }

  private updateOrbitals(dt: number): void {
    for (const o of this.orbitals) {
      if (!o.alive) continue;
      o.life -= dt;
      if (o.life <= 0) {
        o.alive = false;
        this.expire(o.volatile, o.damage, o.radius * 4, o.x, o.y, o.hue, o.depth, o.programIndex, o.leech);
        continue;
      }
      o.angle += o.orbitSpeed * dt;
      o.x = this.player.x + pcos(o.angle) * o.orbitRadius;
      o.y = this.player.y + psin(o.angle) * o.orbitRadius;

      for (const [id, until] of o.cooldowns) {
        if (until <= this.time) o.cooldowns.delete(id);
      }
      this.grid.queryRadius(o.x, o.y, o.radius + TUNABLE.orbitContactPad, (enemy) => {
        if (o.cooldowns.has(enemy.id)) return;
        o.cooldowns.set(enemy.id, this.time + TUNABLE.orbitalHitCooldown);
        this.damageEnemy(enemy, o.damage, o.depth, o.programIndex, o.hue, o.leech);
      });
    }
  }

  private updateZones(dt: number): void {
    for (const z of this.zones) {
      if (!z.alive) continue;
      z.life -= dt;
      if (z.life <= 0) {
        z.alive = false;
        this.expire(z.volatile, z.damage, z.radius, z.x, z.y, z.hue, z.depth, z.programIndex, z.leech);
        continue;
      }
      // §5.4 Pull — a vortex drags everything toward its centre. Continuous, so
      // it is applied every tick rather than on the damage cadence.
      if (z.force > 0) {
        this.grid.queryRadius(z.x, z.y, z.radius, (enemy) => {
          const dx = z.x - enemy.x;
          const dy = z.y - enemy.y;
          const d = hypot(dx, dy) || 1;
          const pull = z.force * (1 - d / z.radius) * dt;
          enemy.x += (dx / d) * pull;
          enemy.y += (dy / d) * pull;
        });
      }

      z.tickTimer -= dt;
      if (z.tickTimer > 0) continue;
      z.tickTimer = z.tickInterval;
      this.grid.queryRadius(z.x, z.y, z.radius, (enemy) => {
        this.damageEnemy(enemy, z.damage, z.depth, z.programIndex, z.hue, z.leech);
      });
    }
  }

  // ---------------------------------------------------------------- terminals

  /**
   * Spawn and channel every terminal type. Channelling is interruptible and
   * resumes from zero, with visible progress (§21); Recompile additionally
   * requires stillness (§9.1).
   */
  private updateTerminals(input: InputState, dt: number): void {
    this.spawnTerminals(dt);

    const moving = hypot(this.player.vx, this.player.vy) > TUNABLE.stillnessSpeed;
    for (const t of this.terminals) {
      if (!t.alive) continue;
      t.age += dt;

      // A dead gate ages and draws, and that is all it does. No fill, no
      // siege, no drain — the circle is furniture until something revives it.
      if (t.dead) continue;

      const d = hypot(this.player.x - t.x, this.player.y - t.y);
      const inside = t.holdRadius ? d < t.holdRadius : d < TUNABLE.beaconRadius + TUNABLE.playerRadius;
      // §21b.5 — ground you hold needs no keypress. Standing there *is* the
      // input, which is what makes it a fight rather than a button.
      const channelling = inside && (t.holdRadius ? true : input.interact) &&
        !(t.requiresStillness && moving);

      if (channelling) {
        // The neighbourhood wakes the moment you commit, not when you finish.
        if (t.gateId && !t.woken) {
          t.woken = true;
          this.pendingDrafts = Math.max(0, this.pendingDrafts - 1);
          this.mark('gate', `${t.kind} contested`);
        }
        if (t.gateId) this.updateSiege(t);
        t.progress += dt / t.channelTime;
        if (t.progress >= 1) {
          t.alive = false;
          this.completeTerminal(t);
        }
      } else if (t.progress > 0 && !t.gateId) {
        // Generous interrupt-resume: it drains rather than snapping to zero.
        t.progress = Math.max(0, t.progress - (dt / t.channelTime) * TUNABLE.poiDrainRate);
      }
      // §21b.7 — a gate does not drain at all. Ground taken is taken.
      //
      // It used to, slowly, and slowly was the worst of both. The siege is
      // scheduled off `progress`, so a bar that rewinds re-delivers parcels the
      // player has already fought: stand off a little and the same wave arrives
      // again, and again, until either it kills them or they learn to hover just
      // under a threshold and farm it. One dial produced both a treadmill and an
      // exploit.
      //
      // Monotonic makes the intended play the obvious one: hold until a parcel
      // lands, back off and kill it, come back and take the next slice. Retreat
      // stops being punished *and* stops being free — the bar simply waits, and
      // the room you are standing in does not.
    }
  }

  /**
   * §21b.7 — the gate is the fight. Holding it is the boss wave.
   *
   * For a while this called `openCache` on commit, which meant the hardest
   * moment in the map was, literally, a Cache — same code, same weight, and it
   * even spent one of your queued Drafts to do it. Twenty-two seconds of holding
   * ground deserves better than a menagerie you can also buy from a box.
   *
   * So: pulses, not one wave, and each one bigger than the last. The escalation
   * is the mechanic — the bar filling is also the threat rising, and the last
   * five seconds are meant to be the worst five seconds of the run so far. Three
   * things separate it from a Cache:
   *
   *   **It comes from the other side.** The roster is the *destination* room's,
   *   not the one you are standing in. What resists you is what is behind the
   *   door, which is why the fight gets harder the deeper the map goes without a
   *   single number being tuned per gate.
   *
   *   **Threat does not gate it.** A Cache reaches a few points past the current
   *   wave; a siege reaches the room's ceiling immediately. You are not being
   *   sold a tier, you are being refused entry.
   *
   *   **Everything wears two affixes**, where a Cache's menagerie wears one.
   */
  private updateSiege(t: Terminal): void {
    const gate = (this.arena.gates ?? []).find((g) => g.id === t.gateId);
    if (!gate) return;
    const event = WAVE_EVENT_BY_ID.get('gate_siege');
    if (!event) return;

    // The siege *is* the bar.
    //
    // The first version ran the parcels off a wall clock that started the moment
    // the player was inside the circle. A gate needs no keypress — standing
    // there is the input — so walking across the ring on the way past started
    // the boss wave, and a test caught the bot doing exactly that: four parcels
    // of hardened enemies for a gate it never held, and a hundred things on the
    // map that nothing had asked for.
    //
    // Reading `progress` instead fixes both halves. Brushing the circle earns a
    // couple of percent and no parcel, and because progress *drains* when you
    // leave, so does the siege: walk away and the schedule rewinds with the bar,
    // which is the honest reading of "you stopped taking this ground". Resuming
    // re-earns the parcels you rewound past.
    const held = t.progress * t.channelTime;
    const due = event.parcels.filter((p) => p.at <= held).length;
    const delivered = t.siegePulse ?? 0;
    // Never rewound. The counter only ever climbs, so each parcel is delivered
    // exactly once per gate however the hold goes — which is the other half of
    // the bar not draining, and the half that actually stops the treadmill. A
    // rewinding counter re-fought the same wave every time the player stepped
    // out and back in, and rewarded hovering just under a threshold.
    if (due <= delivered) return;
    const next = delivered;
    t.siegePulse = delivered + 1;

    // The room behind the door decides what comes through it. This is the whole
    // reason `via` is the caller's to resolve: the event says "the ceiling of
    // whatever roster you were handed", and the gate is the only thing that
    // knows the roster in question is not the one the player is standing in.
    const into = (this.arena.levels ?? []).find((l) => l.id === gate.opens);
    this.callWave({
      event,
      x: t.x,
      y: t.y,
      via: this.rosterVia(into ?? this.currentLevel),
      only: next,
      // §21b.7 — and it comes through the barrier, not out of the ground around
      // you. The wall is the thing being defended and the thing being breached.
      door: gate.barrier,
    });

    // One announcement, on the first parcel. After that the wave is the warning.
    if (next === 0) {
      this.pushFx('rupture', 'void', t.x, t.y, 520, [], 0.9);
      if (event.cue) this.cue(event.cue, 'void', 0, 1);
      this.mark('gate', `${gate.name} contested`);
    }
  }

  /**
   * §21b.5 — put every gate on the map at run start.
   *
   * Placed once and left standing, rather than scheduled like other POIs: a gate
   * you can see and cannot yet reach is a promise, and the whole reason the map
   * unlocks instead of being explored is that the player can see where it goes.
   */
  private placeGates(): void {
    const preOpened = new Set(this.config.openLevels ?? []);
    const dead = new Set(this.config.deadGates ?? []);
    for (const gate of this.arena.gates ?? []) {
      // LEVELS §4 — a gate whose room starts open was opened in a previous run;
      // its barrier was never baked and there is nothing left to hold.
      if (gate.opens && preOpened.has(gate.opens)) continue;
      const t = this.pushTerminal('gate', gate.x, gate.y, gate.holdSeconds, false);
      t.holdRadius = gate.radius;
      t.gateId = gate.id;
      // STORY-AND-TONE §7.2 — placed dead: present, visible, unresponsive.
      if (dead.has(gate.id)) t.dead = true;
    }
  }

  /**
   * LEVELS §6 — put every authored POI in *unlocked* rooms on the map at run
   * start.
   *
   * Placed once and left standing, like gates and for the same reason: a
   * station or a file is a place, and a place that appears on a timer is a
   * service. Ids the config lists as already read or recovered are never
   * placed — the suppression *is* the persistence, and it keeps the sim from
   * ever touching storage.
   *
   * Sealed rooms get theirs from `openGate`, not here: a terminal that exists
   * behind a wall is a terminal the off-screen indicators point at, and an
   * arrow toward a room you cannot enter is a promise the map cannot keep.
   * The gate is the only thing allowed to point through a wall.
   */
  private placeAuthoredPois(): void {
    const levels = this.arena.levels ?? [];
    for (const [i, level] of levels.entries()) {
      if (i !== 0 && !this.openBiomes.has(level.id)) continue;
      this.placePoisFor(level);
    }
  }

  /** LEVELS §6 — one room's authored POIs, minus the ones already recovered. */
  private placePoisFor(level: LevelDef): void {
    const done = new Set(this.config.recoveredPois ?? []);
    for (const spot of level.pois ?? []) {
      if (done.has(spot.id)) continue;
      const def = POIS.find((p) => p.kind === spot.kind);
      const t = this.pushTerminal(spot.kind, spot.x, spot.y, def?.channelTime ?? 1.2, false);
      t.poiId = spot.id;
      t.doc = spot.doc;
      t.section = spot.section ?? 0;
      if (spot.label) t.label = spot.label;
    }
  }

  /** §21b.5 — a gate finished: the wall comes down and the biome is open. */
  private openGate(t: Terminal): void {
    const gate = (this.arena.gates ?? []).find((g) => g.id === t.gateId);
    if (!gate) return;

    // STORY-AND-TONE §7.2 — the relay: it opens nothing. It puts a dead gate
    // back on the board, and the wall that gate guards is still somebody's to
    // hold.
    if (gate.revives) {
      const target = this.terminals.find((x) => x.alive && x.gateId === gate.revives);
      if (target) target.dead = false;
      this.pushFx('rupture', 'voltaic', t.x, t.y, 420, [], 0.8);
      this.cue('gate', 'voltaic', 0, 1);
      this.mark('gate', `${gate.name} — power restored`);
      return;
    }
    if (!gate.opens) return;
    this.openBiomes.add(gate.opens);
    // LEVELS §6 — the room's stations and files exist from the moment the room
    // does. Deferred from run start so the indicators never point through a
    // wall; see placeAuthoredPois.
    const opened = (this.arena.levels ?? []).find((l) => l.id === gate.opens);
    if (opened) this.placePoisFor(opened);
    // The wall was a ruin; remove it and tell the field, or every enemy keeps
    // walking around something that is not there.
    const wall = gate.barrier;
    if (wall) {
      this.ruins = this.ruins.filter((r) => !(r.x === wall.x && r.y === wall.y && r.w === wall.w));
      this.flow.rebuild(this.ruins);
      this.flow.update(this.player.x, this.player.y, true);
    }

    // Whatever the biome guarantees, placed now that it can be reached.
    const biome = (this.arena.biomes ?? []).find((b) => b.id === gate.opens);
    for (const kind of biome?.poi ?? []) {
      const poi = POIS.find((p) => p.kind === kind);
      if (!poi) continue;
      const x = biome!.x + this.rng.range(biome!.w * 0.2, biome!.w * 0.8);
      const y = biome!.y + this.rng.range(biome!.h * 0.2, biome!.h * 0.8);
      this.pushTerminal(poi.kind, x, y, poi.channelTime, poi.requiresStillness);
    }

    // A Magnet in the doorway. You have been holding this circle for twenty-two
    // seconds while the room emptied around you — the shards from all of it are
    // scattered behind you, and the next room is in front. This is the one
    // moment in a run where "leave with everything you earned" is a thing the
    // game can simply hand you, so it does. Bypasses the drop cadence entirely:
    // it is a reward for the gate, not a roll on a kill.
    // In the doorway, not on the terminal. The circle you hold and the wall that
    // opens are different places — dropping the reward on the circle puts it
    // behind you the moment you walk through.
    const b = gate.barrier ?? { x: gate.x - 12, y: gate.y - 12, w: 24, h: 24 };
    this.dropPickup('magnet', b.x + b.w / 2, b.y + b.h / 2, 'voltaic', 1);

    // §21b.7 — the siege ends with the hold that summoned it.
    //
    // A parcel streams in over a few seconds, so the last one can still be
    // pouring when the bar completes. Letting it finish is a smaller version of
    // the bug reported as "AFTER the gate opened, a TON kept spawning" — and the
    // schedule that would avoid it lives in data and will be edited, so this is
    // a guarantee rather than an arithmetic coincidence. The ordinary flow is
    // untouched: only what the siege queued is dropped.
    for (const s of this.pendingSpawns) if (s.siege) s.alive = false;

    this.pushFx('rupture', 'voltaic', gate.x, gate.y, 900, [], 1.2);
    this.cue('gate', 'voltaic', 0, 1);
    this.mark('gate', `${gate.name} open`);
    this.stats.gatesOpened++;

    // LEVELS §2.3 — the tutorial contract: this gate opening IS the shift's
    // goal, and the run concludes on it, banked like an extraction. The stamp
    // reads CONCLUDED — the one disposition the Bureau approves of — and the
    // orientation repeats every shift until the operator earns it.
    if (this.config.concludeOnOpen === gate.opens) {
      this.ending = 'extracted';
      this.player.alive = false;
      this.mark('extract', 'orientation complete');
    }
  }

  /**
   * Remove ruins matching a predicate, and tell the field.
   *
   * Exists for tests that need genuinely open ground: a test about pathing
   * should assert pathing, not whichever corner of the shipped arena happened to
   * be empty when it was written.
   */
  clearRuins(match: (r: RuinRect) => boolean): void {
    this.ruins = this.ruins.filter((r) => !match(r));
    this.flow.rebuild(this.ruins);
    this.flow.update(this.player.x, this.player.y, true);
  }

  /**
   * §21b.6 — is this point in ground the player has not opened?
   *
   * Levels as well as biomes. A locked level is not only walled off and off
   * camera, nothing arrives in it either — otherwise the room you are about to
   * be shown has already been fought in, and the reveal shows you a mess.
   */
  isSealed(x: number, y: number): boolean {
    for (const b of this.arena.biomes ?? []) {
      if (this.openBiomes.has(b.id)) continue;
      if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) return true;
    }

    const levels = this.arena.levels ?? [];
    if (levels.length === 0) return false;

    // Open ground is *inside an unlocked level*, not merely "outside a locked
    // one". The difference is the corridor.
    //
    // The Heap ends at x=3800 and The Sink starts at x=4400, so the six hundred
    // units between them — the gate's own doorway and the approach behind it —
    // belonged to no level at all, and the old test found no locked level
    // containing them and said "spawn away". Enemies appeared past the gate, in
    // ground the player had not opened and could not reach, and dropped shards
    // there. Reported from a screenshot: "enemies DO spawn in the next level".
    //
    // Stated the right way round, a gap between rooms is sealed for the same
    // reason a locked room is: the player cannot stand there yet.
    for (const l of levels) {
      if (l !== levels[0] && !this.openBiomes.has(l.id)) continue;
      if (x >= l.x && x <= l.x + l.w && y >= l.y && y <= l.y + l.h) return false;
    }
    return true;
  }

  /** §21b.4 — the biome the player is standing in, if any. */
  get biome(): BiomeDef | null {
    for (const b of this.arena.biomes ?? []) {
      if (!this.openBiomes.has(b.id)) continue;
      if (
        this.player.x >= b.x &&
        this.player.x <= b.x + b.w &&
        this.player.y >= b.y &&
        this.player.y <= b.y + b.h
      ) {
        return b;
      }
    }
    return null;
  }

  private spawnTerminals(dt: number): void {
    for (const poi of POIS) {
      // STORY-AND-TONE §7.2 — the last frontier has a lock instead.
      if (poi.kind === 'extract' && this.config.noExtract) continue;
      if (this.time < poi.fromTime) continue;
      let alive = 0;
      for (const t of this.terminals) if (t.alive && t.kind === poi.kind) alive++;
      if (alive >= poi.maxAlive) continue;

      // A one-shot POI (Extract) has no timer at all; everything else counts
      // down its own, kept in a map so adding a POI adds no field to the World.
      if (poi.interval > 0) {
        const left = (this.poiTimers.get(poi.kind) ?? poi.interval) - dt;
        if (left > 0) {
          this.poiTimers.set(poi.kind, left);
          continue;
        }
        this.poiTimers.set(poi.kind, poi.interval);
      }

      const spot = poi.atLandmark
        ? (this.config.extractAt ?? { x: this.arena.extractX, y: this.arena.extractY })
        : this.findOpenSpot(poi.ring[0], poi.ring[1]);
      // §12.4 — Extract stands at a fixed landmark, and that landmark is in the
      // last level. It must not appear before the room it stands in is open, or
      // the run's goal is a terminal behind a wall.
      if (poi.atLandmark && this.isSealed(spot.x, spot.y)) continue;
      this.pushTerminal(poi.kind, spot.x, spot.y, poi.channelTime, poi.requiresStillness);
    }
  }

  private pushTerminal(
    kind: TerminalKind,
    x: number,
    y: number,
    channelTime: number,
    requiresStillness: boolean,
  ): Terminal {
    const t: Terminal = {
      id: this.nextId++,
      kind,
      x,
      y,
      progress: 0,
      age: 0,
      channelTime,
      requiresStillness,
      alive: true,
    };
    this.terminals.push(t);
    return t;
  }

  private completeTerminal(t: Terminal): void {
    POI_EFFECTS[t.kind](this, t);
  }

  /**
   * §12.4 The Cache — the first POI that is a *decision* rather than a service.
   *
   * A free draft, and the neighbourhood wakes up: the composition currently
   * running, spawned again at once and hardened — every enemy in it forced to
   * the nastiest variant its family has, enriched, and wearing an elite affix.
   *
   * This is the shape the map wants more of. The Beacon calls a wave and bumps
   * Threat; the Cache trades a real fight for a real card, right now, at a place
   * you had to walk to. Difficulty you *opt into* is the only kind that can be
   * this sharp without being unfair.
   */
  /** Called by POI_EFFECTS. See openCache. */
  openCacheNow(x: number, y: number): void {
    this.openCache(x, y);
  }

  /** Called by POI_EFFECTS. See openGate. */
  openGateNow(t: Terminal): void {
    this.openGate(t);
  }

  /** Called by POI_EFFECTS, which only sees the public surface. */
  cueNow(kind: AudioCue['kind'], hue: Hue): void {
    this.cue(kind, hue, 0, 1);
  }

  /** Called by POI_EFFECTS. See spawnWave. */
  spawnWaveNow(enriched: boolean): void {
    this.spawnWave(enriched);
  }

  private openCache(cx = this.player.x, cy = this.player.y): void {
    this.pendingDrafts = Math.min(TUNABLE.maxQueuedDrafts, this.pendingDrafts + 1);
    this.stats.cachesOpened++;
    if (!this.composition) this.rotateComposition();
    const composition = this.composition;
    if (!composition) return;

    const event = WAVE_EVENT_BY_ID.get('cache_menagerie');
    if (event) {
      this.callWave({
        event,
        x: cx,
        y: cy,
        via: this.rosterVia(this.currentLevel),
      });
    }
    this.pushFx('rupture', 'void', this.player.x, this.player.y, 320, [], 0.6);
    this.cue('level', 'void', 0, 1);
    // ...and the fight you bought with it. The chime above is the card; this is
    // the composition coming back hardened, and it was inaudible before.
    this.cue('hardened', 'void', 0, 1);
    this.mark('cache', 'cache opened');
  }

  /**
   * §9 — Recompile. Delete the entire Engine, keep the Scrap bonuses, and forge
   * a Kernel whose size scales with what the deleted Engine was producing.
   *
   * §9.2 requires that Recompiling at your peak beats hoarding, so K is measured
   * against the best sustained output the Engine actually reached, not its state
   * at the moment you press the button.
   */
  /**
   * The share of the Engine's current output produced by the given rows.
   * Falls back to a headcount when nothing has fired recently, so a freshly
   * rebuilt Engine still yields a sensible number.
   */
  outputShareOf(indices: readonly number[]): number {
    const live = this.engine.programs.filter((_, i) => this.engine.compiled[i]?.live);
    if (live.length === 0) return 0;
    const total = live.reduce((s, p) => s + p.recentDamage, 0);
    const chosen = indices.filter((i) => this.engine.compiled[i]?.live);
    if (chosen.length === 0) return 0;
    if (total <= 0.01) return chosen.length / live.length;
    return chosen.reduce((s, i) => s + this.engine.programs[i]!.recentDamage, 0) / total;
  }

  /** What Kernel a given sacrifice would forge, for the selection UI. */
  kernelPreview(indices: readonly number[]): number {
    const share = this.outputShareOf(indices);
    if (share <= 0) return 0;
    // Super-linear in share, so committing beats nibbling — see the note on
    // TUNABLE.kernelShareExponent.
    const weight = ppow(share, TUNABLE.kernelShareExponent);
    return Math.min(
      TUNABLE.kernelMaxPercent,
      (TUNABLE.kernelBasePercent + TUNABLE.kernelPercentPerEps * this.outputAverage) * weight,
    );
  }

  /**
   * Sacrifice the given Program rows (default: all of them).
   *
   * Partial by design — see DECISIONS D-28. Sacrificing everything was measured
   * to be strictly worse than never recompiling, because in this game output and
   * survival are the same axis: you cannot buy a multiplier with all of your
   * production and live to use it. Burning a chosen subset makes the cost
   * something the player can size to what they can afford.
   */
  recompile(indices?: readonly number[]): number {
    const targets = (indices ?? this.engine.programs.map((_, i) => i)).filter(
      (i) => this.engine.compiled[i]?.live,
    );
    if (targets.length === 0) return 0;

    const share = this.outputShareOf(targets);
    const percent = this.kernelPreview(targets);

    // Capture the schematic before it burns, for the §19.7 ceremony.
    const rows = targets.map((i) => {
      const p = this.engine.programs[i]!;
      const mods = p.modifierIds.filter(Boolean);
      return [p.triggerId, ...mods, p.actionId].join(' › ');
    });

    for (const i of targets) {
      const p = this.engine.programs[i]!;
      p.triggerId = null;
      p.actionId = null;
      p.modifierIds.fill(null);
      p.recentEvents = 0;
      p.recentDamage = 0;
      p.tickDamage = 0;
      p.tickEvents = 0;
    }
    this.engine.recompile();

    // If the whole Engine went, reboot to the Axiom rather than to nothing: an
    // Engine with no live Program earns no XP, so it can never rebuild itself.
    if (!this.engine.compiled.some((c) => c.live)) this.installAxiomStarter();

    this.engine.kernel *= 1 + percent / 100;
    this.engine.recompile();

    this.kernels++;
    this.baseCapacity += Math.round(TUNABLE.recompileCapacityGain * share);
    this.syncBudget();
    this.syncBudget();

    // Rebuild surge (§9.1): double XP for 120s, and the next few drafts widen.
    // The surge scales with what was given up: burning one row does not deserve
    // the same recovery as burning the whole Engine.
    this.surgeTime = TUNABLE.rebuildSurgeTime * share;
    this.surgeDrafts = Math.max(1, Math.round(TUNABLE.rebuildSurgeDrafts * share));
    this.outputAverage *= 1 - share;
    this.lastKernelPercent = percent;
    this.lastRecompileTime = this.time;
    this.mark('recompile', `kernel +${percent.toFixed(0)}%`);
    // Drained by the presentation layer. Derived data, like visualDeaths.
    this.pendingCeremony = { rows, percent, kernel: this.engine.kernel };
    return percent;
  }

  lastKernelPercent = 0;
  lastRecompileTime = -Infinity;
  /** A channelled Recompile terminal is waiting for the player's selection. */
  pendingRecompileChoice = false;
  /**
   * LEVELS §6 — a channelled station or recovered fragment waiting for the app
   * to show its sheet. Set by POI_EFFECTS, cleared by the app, like
   * `pendingRecompileChoice` — the sim says which document; showing it is not
   * its job. `station` marks the ones whose reading is remembered forever;
   * `section` narrows a fragment to the part that was actually recovered.
   */
  pendingSheet: { doc: string; section?: number; station?: boolean } | null = null;
  pendingCeremony: { rows: string[]; percent: number; kernel: number } | null = null;

  /**
   * §9.2 — hoarding a solved Engine to Meltdown is the noob trap, and Results
   * says so out loud. This is the fraction of Kernel value left on the table.
   */
  get wastedKernelPercent(): number {
    if (this.peakOutputAverage <= 0) return 0;
    return Math.min(
      TUNABLE.kernelMaxPercent,
      TUNABLE.kernelBasePercent + TUNABLE.kernelPercentPerEps * this.peakOutputAverage,
    );
  }

  /**
   * §21b — the moment a room's garrison becomes real.
   *
   * A level's roster is read off `currentLevel`, which is positional: the tick
   * the player crosses the threshold, that room's families and its tier become
   * legal and the director starts building waves out of things the run has never
   * seen. Nothing announced it, because nothing *happened* — there is no spawn
   * to hang it on, only a rule quietly changing underneath the director.
   *
   * So this is the announcement. Once per room, on first entry, and never for
   * the room the run starts in: walking through your own front door is not an
   * event.
   */
  private updateBreach(): void {
    const level = this.currentLevel;
    if (!level || this.breached.has(level.id)) return;
    const first = this.breached.size === 0;
    this.breached.add(level.id);
    // Seeded on the first tick rather than in the constructor: `currentLevel`
    // reads the player's position, and the player does not exist yet that early.
    if (first) return;
    this.cue('breach', 'void', 0, 1);
    this.mark('gate', `${level.name ?? level.id} entered`);
  }

  // --------------------------------------------------------------- meltdown

  /** §13.2 — at 20:00 the build phase ends. This is not a fail state, it is act three. */
  private updateMeltdown(dt: number): void {
    const meltdownAt = this.config.meltdownAt ?? TUNABLE.meltdownAt;
    if (this.phase === 'build') {
      if (this.time < meltdownAt) return;
      this.phase = 'meltdown';
      this.mark('meltdown', 'MELTDOWN');
      // The one moment in a run that changes what the run *is*. It gets its own
      // sound, unquantised, for the same reason the gate does: it is an event,
      // not a hit, and snapping it to a sixteenth would only make it late.
      this.cue('meltdown', 'void', 0, 1);
      return;
    }

    const elapsed = this.time - meltdownAt;
    this.meltdownMultiplier =
      1 +
      TUNABLE.meltdownMultiplierStep * Math.floor(elapsed / TUNABLE.meltdownStepSeconds);
    this.peakMeltdownMultiplier = Math.max(this.peakMeltdownMultiplier, this.meltdownMultiplier);

    this.updateContainment(dt, elapsed);
  }

  /** Seconds since Meltdown began, or 0 during the build phase. */
  get meltdownTime(): number {
    const meltdownAt = this.config.meltdownAt ?? TUNABLE.meltdownAt;
    return this.phase === 'meltdown' ? this.time - meltdownAt : 0;
  }

  // -------------------------------------------------------------- containment

  private updateContainment(dt: number, meltdownElapsed: number): void {
    this.containmentTimer -= dt;
    if (this.containmentTimer <= 0) {
      // §11.4 — scales in frequency and overlap, never in HP.
      const minutes = meltdownElapsed / 60;
      this.containmentTimer = Math.max(
        TUNABLE.containmentIntervalMin,
        TUNABLE.containmentIntervalBase - minutes * TUNABLE.containmentIntervalPerMinute,
      );
      this.spawnContainment();
    }

    for (const c of this.containment) {
      if (!c.alive) continue;
      c.age += dt;
      c.life -= dt;
      if (c.life <= 0) {
        c.alive = false;
        continue;
      }
      // Everything is telegraphed before it can hurt you (§17.1, §21).
      const armed = c.age >= c.telegraph;

      const hazard = HAZARDS[c.kind];
      if (!hazard) continue;
      hazard.update(c, this.hazardCtx, dt);
      if (armed) hazard.test(c, this.hazardCtx);
    }
  }

  private spawnContainment(): void {
    // §0 — `rng.pick` walks the registry's key order, so adding a hazard shifts
    // the stream deliberately rather than by accident. The order is the file's.
    const kind = this.rng.pick(HAZARD_KINDS);
    const hazard = HAZARDS[kind];
    if (!hazard) return;
    this.containment.push({
      id: this.nextId++,
      kind: kind as ContainmentKind,
      age: 0,
      x: 0,
      y: 0,
      dirX: 0,
      dirY: 0,
      gapAt: 0,
      radius: 0,
      gapAngles: [],
      advance: 0,
      telegraph: 1.1,
      alive: true,
      ...hazard.spawn(this.hazardCtx),
    });
  }

  mark(kind: TraceMarkerKind, label: string): void {
    if (this.markers.length < 400) this.markers.push({ t: this.time, kind, label });
  }

  /**
   * Choose where a wave arrives from.
   *
   * Naively clamping a ring position into the arena collapses it toward the
   * player whenever they hug an edge — which is exactly how enemies ended up
   * materialising in full view. Instead: consider several directions, clamp each
   * candidate, and keep whichever ends up furthest outside the nominal view
   * rectangle. Near a corner there may be no fully-hidden option; this picks the
   * least-visible one available rather than silently doing the worst thing.
   */
  /**
   * §12.2 / §21b.6 — enemies that fall too far behind are recycled to the front.
   *
   * This is a bullet-heaven, not an RPG: the horde is a pressure field around
   * the player, not a population that lives somewhere. On a six-screen arena the
   * distinction barely showed; on a twenty-screen one it decides whether
   * `targetAlive` means anything at all, because a hundred enemies strung out
   * behind you are a hundred enemies not in the fight.
   *
   * Relocated rather than killed and respawned: the count stays exactly where
   * the director put it, no drop is lost, and nothing has to be re-rolled.
   */
  private recycleStragglers(): void {
    const limit = TUNABLE.recycleDistance * TUNABLE.recycleDistance;
    for (const e of this.enemies) {
      if (!e.alive) continue;
      const dx = e.x - this.player.x;
      const dy = e.y - this.player.y;
      if (dx * dx + dy * dy < limit) continue;
      // Anything anchored to a place stays there: a Suppressor's field and a
      // Glutton's fuse are both about *where they are*.
      if (e.meals > 0 || (getEnemy(e.defId).zoneRadius ?? 0) > 0) continue;
      const origin = this.pickSpawnOrigin();
      e.x = clamp(origin.x, 20, this.arena.width - 20);
      e.y = clamp(origin.y, 20, this.arena.height - 20);
      e.spawnAge = 0;
      this.stats.recycled++;
    }
  }

  private pickSpawnOrigin(): { x: number; y: number } {
    const halfW = TUNABLE.nominalViewWidth / 2;
    const halfH = TUNABLE.nominalViewHeight / 2;
    const offset = this.rng.next() * Math.PI * 2;
    const dist = this.rng.range(TUNABLE.spawnRingMin, TUNABLE.spawnRingMax);

    // Bias arrivals toward where the player is heading. Running away should not
    // be free: local density alone still let you outrun the horde, because what
    // you left behind stayed inside the pressure radius while the road ahead
    // stayed clear. Not a wall — just enough that fleeing costs something.
    const moveLen = hypot(this.player.vx, this.player.vy);
    const forward = moveLen > 20 && this.rng.chance(TUNABLE.forwardSpawnBias);
    const fx = forward ? this.player.vx / moveLen : 0;
    const fy = forward ? this.player.vy / moveLen : 0;

    // Every direction that is genuinely off-screen is equally valid, and the
    // horde should arrive from all of them. Always taking the *most* hidden
    // candidate made spawns queue up along one compass line, which reads as a
    // procession rather than a swarm.
    const viable: { x: number; y: number }[] = [];
    // §21b — same room, hidden, but not necessarily ahead. The tier below
    // `viable`, so the forward bias is the first thing given up rather than the
    // room constraint.
    const inRoom: { x: number; y: number }[] = [];
    let best = { x: this.player.x, y: this.player.y };
    let bestHidden = -Infinity;

    // §21b — the spawn ring is 1180-1480 units and rooms are 600 apart, so
    // standing anywhere near a doorway put most of the ring in the room next
    // door. Reported as "shit kept spawning in the first level" after crossing
    // into the second, and it is exactly that: the roster is the player's room,
    // the *placement* had never heard of rooms at all, so The Sink's enemies
    // arrived in The Heap and walked back through the gate.
    const here = this.currentLevel;

    for (let i = 0; i < TUNABLE.spawnCandidates; i++) {
      const angle = offset + (i / TUNABLE.spawnCandidates) * Math.PI * 2;
      const x = clamp(this.player.x + pcos(angle) * dist, 30, this.arena.width - 30);
      const y = clamp(this.player.y + psin(angle) * dist, 30, this.arena.height - 30);
      // How far outside the nominal view this lands. Positive means off-screen.
      const hidden = Math.max(
        Math.abs(x - this.player.x) - halfW,
        Math.abs(y - this.player.y) - halfH,
      );
      const sameRoom = !here || this.levelAt(x, y) === here;
      if (hidden > 0 && sameRoom) {
        inRoom.push({ x, y });
        // When biasing forward, only keep candidates roughly ahead of travel.
        if (!forward || (pcos(angle) * fx + psin(angle) * fy) > 0.25) {
          viable.push({ x, y });
        }
      }
      if (hidden > bestHidden) {
        bestHidden = hidden;
        best = { x, y };
      }
    }
    // Near an arena corner nothing may be fully hidden; fall back to the least
    // visible option rather than spawning in the player's lap. Room first,
    // heading second, visibility last — arriving from the wrong side of a door
    // you already walked through is worse than arriving slightly on-screen.
    if (viable.length > 0) return viable[this.rng.int(viable.length)]!;
    if (inRoom.length > 0) return inRoom[this.rng.int(inRoom.length)]!;
    return best;
  }

  /** A point at a given distance band from the player that is not inside a ruin. */
  /**
   * Somewhere in *this* room to put a thing the player has to walk to.
   *
   * §21b — everything the map offers belongs to the room the operator is in.
   * Enemies already work this way (the roster is the current level's); Beacons,
   * Caches, Coolers and the Magnets they hand out did not, and it showed twice:
   *
   *   **The ring did not know about rooms.** A point was clamped to the *arena*,
   *   so standing anywhere near a doorway scattered POIs back through it. The
   *   Heap and The Sink are 3800 and 3600 wide against a ring measured in
   *   hundreds — from the near edge of a new room, most of the ring is still the
   *   old one.
   *
   *   **The fallback was the arena's spawn point.** Twelve failed attempts and
   *   the thing was placed at `spawnX, spawnY` — which is not "somewhere safe",
   *   it is *the middle of the first room*, however many rooms ago that was. The
   *   more the ring failed, the more reliably everything piled up back at the
   *   start, which is exactly the shape of "all the new beacons are spawning in
   *   the last room".
   *
   * So: reject anything outside the current room, and when the ring cannot find
   * a spot, fall back inside that room rather than to the other end of the map.
   */
  /**
   * A POI must never sit inside a gate's hold circle: standing there fills the
   * gate whether or not the gate was the errand, so a Beacon in the circle
   * sells a boss wave as a wave call. The circle plus the interact reach is the
   * exclusion — close enough to touch one from the other is overlap too.
   */
  private insideGateCircle(x: number, y: number): boolean {
    const pad = TUNABLE.beaconRadius + TUNABLE.playerRadius;
    for (const gate of this.arena.gates ?? []) {
      if (hypot(x - gate.x, y - gate.y) < gate.radius + pad) return true;
    }
    return false;
  }

  private findOpenSpot(minDist: number, maxDist: number): { x: number; y: number } {
    const room = this.currentLevel;
    for (let attempt = 0; attempt < 24; attempt++) {
      const angle = this.rng.next() * Math.PI * 2;
      const dist = this.rng.range(minDist, maxDist);
      const x = clamp(this.player.x + pcos(angle) * dist, 60, this.arena.width - 60);
      const y = clamp(this.player.y + psin(angle) * dist, 60, this.arena.height - 60);
      if (this.insideRuin(x, y, 40)) continue;
      if (this.insideGateCircle(x, y)) continue;
      if (room && this.levelAt(x, y) !== room) continue;
      return { x, y };
    }

    // Nothing in the ring worked — a cramped room, or a corner. Anywhere in the
    // room that is not a wall will do; the point is that it is in *this* one.
    if (room) {
      for (let attempt = 0; attempt < 24; attempt++) {
        const x = room.x + this.rng.range(room.w * 0.15, room.w * 0.85);
        const y = room.y + this.rng.range(room.h * 0.15, room.h * 0.85);
        if (!this.insideRuin(x, y, 40) && !this.insideGateCircle(x, y)) return { x, y };
      }
      return { x: room.x + room.w / 2, y: room.y + room.h / 2 };
    }
    return { x: this.arena.spawnX, y: this.arena.spawnY };
  }

  private cue(kind: AudioCue['kind'], hue: Hue, depth: number, weight: number): void {
    // A 600-EPS cascade would otherwise queue thousands of cues per frame. The
    // mixer caps voices anyway; this caps the allocation.
    if (this.audioCues.length >= 96) return;
    this.audioCues.push({ kind, hue, depth, weight: Math.max(0, Math.min(1, weight)) });
  }

  private pushFx(
    kind: Fx['kind'],
    hue: Hue,
    x: number,
    y: number,
    radius: number,
    points: number[],
    life: number,
  ): void {
    // §16.2 / §20.1 — a *budget*, not a cap.
    //
    // Measured at 5,882 EPS on a Nova build: six thousand live detonations, a
    // 65ms frame, and 57.8ms of that inside the bloom composite uploading the
    // geometry. Effects shared the 6,000-entity safety cap, which is a net
    // against running out of memory, not a budget for what a frame may draw.
    //
    // When full, drop whichever is closest to finishing rather than refusing the
    // new one: the newest detonation is the one the player is looking at.
    //
    // There was a merge here for one commit, folding coincident detonations into
    // one. It was wrong twice over — it refreshed the survivor's life, so a
    // stream of hits at one spot produced a ring that never died and sat on the
    // player feeding bloom forever, and a merged ring is not what a detonation
    // looks like anyway. The budget and the batched draw were doing the work;
    // the merge was only doing damage.
    // §20.1 — and *before* the budget: do not spawn what carries nothing.
    //
    // The budget alone produced a second bug, reported as "the explosions do not
    // explode any more, they just appear and disappear". The draw never changed;
    // the arrival rate did. A detonation lives about a fifth of a second, so 300
    // slots hold roughly 1,400 arrivals a second — and a Nova cascade lands
    // several times that. Past the line, every push evicts one that is still
    // more than half alive, and a ring that is killed at 55% has grown from
    // 0.80r to 0.93r of its 1.08r finish. It never visibly expands. Worse, a
    // burst waits up to 45ms for the sixteenth before it is drawn at all, so the
    // shortest-lived ones were being evicted having never been drawn once.
    //
    // Evicting harder cannot fix that — the fix is to stop the flood upstream.
    // A detonation landing on top of a detonation of the same hue that is still
    // young adds no information: it is the same ring in the same place. Dropping
    // the newcomer keeps the arrival rate under the budget, so the effects that
    // do exist live their whole life and animate.
    //
    // Note what this deliberately does *not* do. It never touches the survivor.
    // A previous attempt merged the two and gave the survivor a fresh life and
    // the larger radius, which made a stream of hits on one spot into a ring
    // that never died, sat on the player and fed bloom forever. The survivor is
    // read-only here. Nothing can become immortal.
    if (kind === 'burst') {
      const near = radius * TUNABLE.fxCrowdRadius;
      const nearSq = near * near;
      for (const f of this.fx) {
        if (!f.alive || f.kind !== 'burst' || f.hue !== hue) continue;
        if (f.life < f.maxLife * TUNABLE.fxCrowdLife) continue;
        if (f.radius < radius * 0.8) continue;
        const dx = f.x - x;
        const dy = f.y - y;
        if (dx * dx + dy * dy <= nearSq) return;
      }
    }

    // Full means full: reclaim a dead slot if there is one, otherwise refuse.
    //
    // This used to evict the live effect closest to finishing, on the reasoning
    // that "the newest detonation is the one the player is looking at". That is
    // true when the budget is a rare edge and false when it is being hit a
    // thousand times a second — and past the line, every arrival cut short an
    // effect that was still 70% alive (measured, and now a test). The policy
    // turned every detonation into a flash to make room for the next flash.
    //
    // Refusing instead means whatever is accepted animates all the way through.
    // Nothing is starved for long: 300 slots at a fifth of a second each free up
    // well over a thousand times a second, so a refusal lasts a few frames at
    // the very worst. A representative sample of detonations that visibly
    // explode is a better picture than all of them appearing and vanishing.
    if (this.fx.length >= TUNABLE.maxFx) {
      let dead = -1;
      for (let i = 0; i < this.fx.length; i++) {
        if (!this.fx[i]!.alive) {
          dead = i;
          break;
        }
      }
      if (dead < 0) return;
      this.fx.splice(dead, 1);
    }
    this.fx.push({
      id: this.nextId++,
      kind,
      hue,
      x,
      y,
      radius,
      points,
      life,
      maxLife: life,
      alive: true,
    });
  }

  /**
   * §10.2, §10.3 — settle what this individual does.
   *
   * Called at spawn and again whenever its affixes change, which is the only
   * time the answer can move. Pure: no RNG, no ordering hazard, so it can be
   * called twice on the same enemy without consequence.
   */
  private resolveTraits(e: Enemy): void {
    const def = getEnemy(e.defId);
    e.traits = mergeAffixes(traitsOf(e.defId, def), e.affixes);
  }

  /**
   * §11.2, §10.3 — the affixes that may be rolled right now.
   *
   * Every affix is always eligible except the one that grants a suppression
   * field, which is withheld once the arena is already at its ceiling. A wave of
   * hardened enemies rolling from a pool of three would otherwise give roughly
   * two thirds of itself an Engine-off aura, which is not an elite modifier, it
   * is a second Suppressor with no cap and no telegraph.
   *
   * Withheld rather than rerolled: rerolling would spend a draw and shift the
   * stream by how full the arena happens to be, which is a determinism hazard
   * for something that is only meant to be a ceiling.
   */
  private affixPool(): EliteAffix[] {
    const pool = [...AFFIX_IDS] as EliteAffix[];
    if (this.suppressorCount() < TUNABLE.suppressorsAlive) return pool;
    return pool.filter((a) => a !== 'anchored');
  }

  /** How many of one kind are alive or already on their way. */
  private countAlive(defId: string): number {
    let n = 0;
    for (const e of this.enemies) if (e.alive && e.defId === defId) n++;
    for (const s of this.pendingSpawns) if (s.alive && s.enemy === defId) n++;
    return n;
  }

  /** Does this enemy definition carry a suppression field of its own? */
  private projectsZone(defId: string): boolean {
    return (getEnemy(defId).zoneRadius ?? 0) > 0;
  }

  /**
   * How many suppression fields exist right now, live and queued.
   *
   * Pending spawns count: they are already committed and will arrive within a
   * couple of seconds, so leaving them out lets a single burst queue six at once
   * and walk straight past the cap.
   */
  /**
   * §11.2 — live suppression, counted in **fields**.
   *
   * The rule has always said fields rather than enemies, and this counted neither:
   * it asked whether the *definition* carries a `zoneRadius`, so the only thing
   * it ever capped was actual Suppressors. An `anchored` elite projects a field
   * of its own, was never counted, and so was never limited.
   *
   * Read off a recorded run: forty-two simultaneous fields from anchored elites,
   * against a cap of two, with zero Suppressors alive. The player's Engine was
   * off across most of the arena and the thing responsible was not on the list
   * of things that can do that. Reported as "a TON of inhibitors kept spawning"
   * — they were not inhibitors, and that is exactly why nothing capped them.
   */
  private suppressorCount(): number {
    let n = 0;
    for (const e of this.enemies) {
      if (e.alive && (this.projectsZone(e.defId) || traitOf(e.traits, 'zone'))) n++;
    }
    for (const s of this.pendingSpawns) {
      if (s.alive && this.projectsZone(s.enemy)) n++;
    }
    return n;
  }

  /** §11.4 — is the player standing in an active Containment shape? */
  get insideContainment(): boolean {
    for (const c of this.containment) {
      if (!c.alive || c.age < c.telegraph) continue;
      const dx = this.player.x - c.x;
      const dy = this.player.y - c.y;
      if (dx * dx + dy * dy < c.radius * c.radius) return true;
    }
    return false;
  }

  /** §11.2 — is the player inside a Suppressor's zone? Triggers do not fire there. */
  get suppressed(): boolean {
    for (const e of this.enemies) {
      if (!e.alive) continue;
      const def = getEnemy(e.defId);
      // An affix-granted zone is prepended and so wins; a def's own is found
      // when there is no affix. One lookup, both cases.
      const zone = traitOf(e.traits, 'zone');
      const radius = zone ? num(zone, 'radius', 0) : (def.zoneRadius ?? 0);
      if (radius <= 0) continue;
      const dx = this.player.x - e.x;
      const dy = this.player.y - e.y;
      if (dx * dx + dy * dy < radius * radius) return true;
    }
    return false;
  }

  // ------------------------------------------------------------------- damage

  private damageEnemy(
    enemy: Enemy,
    damage: number,
    depth: number,
    programIndex: number,
    hue: Hue,
    leech = 0,
  ): void {
    if (!enemy.alive || damage <= 0) return;
    // §10.3 Phasing — periodically untargetable, which breaks lock-on cadence.
    if (enemy.phased) return;

    // §10.2 Interceptor — it eats *everything* of yours, not only bolts.
    //
    // "Hunts your projectiles and grows" was implemented literally, so a Nova or
    // a Field build never grew one past its birth size and never met the enemy
    // that exists to answer output. A hit from an area effect is a smaller meal
    // than swallowing a bolt whole — a third — but it is a meal, and it means the
    // counter to spray answers *every* kind of spray.
    if (enemy.meals < TUNABLE.interceptorMaxMeals && getEnemy(enemy.defId).growthPerMeal) {
      this.feedInterceptor(enemy, TUNABLE.interceptorAreaMealShare);
    }

    // §5.3 On Crit — a crit both hits harder and emits its own event, so crit
    // investment is a build axis rather than a stat.
    let crit = false;
    if (this.rng.chance(TUNABLE.critChance + this.bonuses.crit)) {
      crit = true;
      damage *= TUNABLE.critMultiplier;
    }

    // §11.1's adaptive resistance is retired. It was invisible — nothing in the
    // HUD ever showed it — and it punished exactly the focused single-hue builds
    // the class stats now exist to reward. A tax nobody can see is not a
    // decision, it is a worse number.
    const resisted = damage;

    // What actually landed, for the per-row DPS readout: an overkill counts only
    // for what the target had left.
    const landed = Math.min(resisted, Math.max(0, enemy.hp));
    const source = this.engine.programs[programIndex];
    if (source) source.tickDamage += landed;

    enemy.hp -= resisted;
    enemy.flash = 0.04;

    // §5.5 Leech — a fraction of damage dealt returns as Integrity.
    if (leech > 0 && this.player.integrity < this.player.maxIntegrity) {
      this.player.integrity = Math.min(
        this.player.maxIntegrity,
        this.player.integrity + resisted * leech,
      );
    }

    if (crit) {
      // A crit has to be visible or On Crit is a trigger for something the
      // player cannot perceive. Distinct mark, not a damage number.
      enemy.flash = Math.max(enemy.flash, 0.1);
      this.pushFx('crit', hue, enemy.x, enemy.y, enemy.radius + 12, [], 0.24);
      this.stats.crits++;
      this.emit({
        type: 'crit',
        depth: depth + 1,
        x: enemy.x,
        y: enemy.y,
        hue,
        targetId: enemy.id,
        sourceProgram: programIndex,
      });
    }

    const program = this.engine.programs[programIndex];
    if (program) {
      program.eventCount++;
      program.tickEvents++;
    }

    // §5.2 — a hit emits On Hit at depth+1; children inherit the cascade.
    this.emit({
      type: 'hit',
      depth: depth + 1,
      x: enemy.x,
      y: enemy.y,
      hue,
      targetId: enemy.id,
      sourceProgram: programIndex,
    });

    if (enemy.hp <= 0) this.killEnemy(enemy, depth, programIndex, hue);
  }

  private killEnemy(enemy: Enemy, depth: number, programIndex: number, hue: Hue): void {
    if (!enemy.alive) return;
    enemy.alive = false;
    this.stats.kills++;
    this.stats.killsByEnemy.set(enemy.defId, (this.stats.killsByEnemy.get(enemy.defId) ?? 0) + 1);
    this.cue('kill', hue, depth, Math.min(1, enemy.maxHp / 60));
    if (this.suppressedNow) {
      this.stats.suppressedKills++;
      if ((getEnemy(enemy.defId).zoneRadius ?? 0) > 0) this.stats.suppressorsKilledInside++;
    }

    const def = getEnemy(enemy.defId);

    if (this.visualDeaths.length < 512) {
      this.visualDeaths.push({
        x: enemy.x,
        y: enemy.y,
        radius: enemy.radius,
        shape: def.shape,
        hue: enemy.hue,
      });
    }

    // §12.3 — beacon-called waves drop enriched.
    const bonus = enemy.enriched ? 1 + TUNABLE.beaconDropBonus : 1;

    this.dropPickup('xp', enemy.x, enemy.y, enemy.hue, def.xp * bonus);
    this.maybeDropMagnet(enemy.x, enemy.y);

    // §10.3 Volatile — a telegraphed death explosion.
    // §10.4 — a Charged variant detonates on death without being an elite. Same
    // code path as the Volatile affix; the difference is only where it is
    // authored, which is the whole point of putting traits on the def.
    if (def.deathBlast) {
      const blast = def.deathBlast;
      this.pushFx('burst', enemy.hue, enemy.x, enemy.y, blast.radius, [], 0.3);
      this.emit({ type: 'glutton', depth, x: enemy.x, y: enemy.y, hue: enemy.hue });
      const dx = this.player.x - enemy.x;
      const dy = this.player.y - enemy.y;
      const reach = blast.radius + TUNABLE.playerRadius;
      if (dx * dx + dy * dy < reach * reach) {
        this.hurtPlayer(blast.damage, {
          id: def.id,
          label: def.name,
          enemyId: def.id,
          shape: def.shape,
          mode: 'detonation',
        });
      }
    }

    const affixBlast = traitOf(enemy.traits, 'deathBlast');
    if (affixBlast) {
      const blastRadius = num(affixBlast, 'radius', TUNABLE.affixVolatileRadius);
      this.pushFx('burst', enemy.hue, enemy.x, enemy.y, blastRadius, [], 0.3);
      this.emit({ type: 'glutton', depth, x: enemy.x, y: enemy.y, hue: enemy.hue });
      const dx = this.player.x - enemy.x;
      const dy = this.player.y - enemy.y;
      const reach = blastRadius + TUNABLE.playerRadius;
      if (dx * dx + dy * dy < reach * reach) this.hurtPlayer(num(affixBlast, 'damage', TUNABLE.affixVolatileDamage), {
          id: def.id,
          label: def.name,
          enemyId: def.id,
          shape: def.shape,
          mode: 'Volatile detonation',
        });
    }

    // §10.2 — a Glutton going up. Everything it ate, coming back out at once:
    // the biggest non-player explosion in the game, and the reason the cap is a
    // state rather than a limit. It damages the horde too, which is what makes
    // popping one *next to* something a play rather than a chore.
    if (def.behavior === 'intercept' && enemy.meals >= TUNABLE.interceptorMaxMeals) {
      const radius = enemy.radius * TUNABLE.interceptorBlastScale;
      this.pushFx('rupture', enemy.hue, enemy.x, enemy.y, radius, [], 0.45);
      this.cue('kill', enemy.hue, depth, 1);
      this.stats.gluttonsPopped++;
      this.emit({ type: 'glutton', depth, x: enemy.x, y: enemy.y, hue: enemy.hue });
      for (const other of this.enemies) {
        if (!other.alive || other.id === enemy.id) continue;
        const ox = other.x - enemy.x;
        const oy = other.y - enemy.y;
        if (ox * ox + oy * oy > radius * radius) continue;
        this.damageEnemy(other, TUNABLE.interceptorBlastDamage, depth + 1, programIndex, enemy.hue, 0);
      }
      const px = this.player.x - enemy.x;
      const py = this.player.y - enemy.y;
      const reach = radius + TUNABLE.playerRadius;
      if (px * px + py * py < reach * reach) {
        this.hurtPlayer(TUNABLE.interceptorBlastDamage, {
          id: def.id,
          label: def.name,
          enemyId: def.id,
          shape: def.shape,
          mode: 'Glutton detonation',
        });
      }
    }

    if (def.splitsInto) {
      for (let i = 0; i < def.splitsInto.count; i++) {
        const a = (i / def.splitsInto.count) * Math.PI * 2;
        const child = this.spawnEnemy(
          def.splitsInto.enemy,
          enemy.x + pcos(a) * 24,
          enemy.y + psin(a) * 24,
          enemy.hue,
        );
        if (child) child.enriched = enemy.enriched;
      }
    }

    this.emit({
      type: 'kill',
      depth: depth + 1,
      x: enemy.x,
      y: enemy.y,
      hue,
      targetId: enemy.id,
      sourceProgram: programIndex,
    });
  }

  private hurtPlayer(amount: number, cause: DamageSource): void {
    const p = this.player;
    if (p.iframes > 0) return;
    this.sinceHurt = 0;
    p.integrity -= amount;
    p.iframes = 0.5;
    this.stats.damageTaken += amount;
    const tallied = this.damageBySource.get(cause.id);
    if (tallied) tallied.amount += amount;
    else this.damageBySource.set(cause.id, { source: cause, amount });
    this.pushFx('hurt', 'thermal', p.x, p.y, 0, [], 0.14);
    this.cue('hurt', 'thermal', 0, Math.min(1, amount / Math.max(1, p.maxIntegrity * 0.2)));
    if (this.visualHurts.length < 32) {
      this.visualHurts.push({
        x: p.x,
        y: p.y,
        amount,
        label: cause.label,
        severity: p.maxIntegrity > 0 ? amount / p.maxIntegrity : 0,
      });
    }
    this.emit({ type: 'wound', depth: 0, x: p.x, y: p.y });
    if (p.integrity <= 0) {
      p.integrity = 0;
      p.alive = false;
      this.deathCause = cause;
      // §14 — one word, because it is one event.
      //
      // This read "garbage collected" before Meltdown: a programmer's joke in a
      // game where §13.6 bans winking. It survived the Results rewrite by hiding
      // here, in the sim, as a trace label, so it kept printing on the chart
      // after the screen that used to say it was gone.
      //
      // Replacing it with "COLLECTED" was the second mistake and a worse one.
      // This is a containment facility — the procedure section of every document
      // in §9 is a containment procedure, the disposition is INDEFINITE, and what
      // happens when the Engine is stopped is that it is *contained*. Splitting
      // the label by when the player died invents a distinction the Bureau does
      // not make and puts two words on the chart and the stamp for one event.
      // `ending` still carries the difference, because scoring needs it.
      this.ending = this.phase === 'meltdown' ? 'contained' : 'died-early';
      this.mark('death', 'CONTAINED');
    }
  }

  // ------------------------------------------------------------------ updates

  private updatePlayer(input: InputState, dt: number): void {
    this.player.prevX = this.player.x;
    this.player.prevY = this.player.y;
    const p = this.player;
    p.iframes = Math.max(0, p.iframes - dt);
    p.dashCooldown = Math.max(0, p.dashCooldown - dt);
    p.dashTimer = Math.max(0, p.dashTimer - dt);

    let mx = input.moveX;
    let my = input.moveY;
    const len = hypot(mx, my);
    if (len > 1) {
      mx /= len;
      my /= len;
    }
    if (len > 0.01) {
      p.dirX = input.moveX / len;
      p.dirY = input.moveY / len;
    }

    if (input.dash && p.dashCooldown <= 0 && p.dashTimer <= 0) {
      p.dashTimer = TUNABLE.dashDuration;
      // §4.1 — Capacitor Bank. Multiplicative so stacking it has diminishing
      // returns rather than reaching zero.
      p.dashCooldown = TUNABLE.dashCooldown / (1 + this.bonuses.dashHaste);
      p.iframes = Math.max(p.iframes, TUNABLE.dashIFrames + this.bonuses.dashHaste * 0.2);
      this.emit({ type: 'dash', depth: 0, x: p.x, y: p.y });
    }

    p.speedBoostTime = Math.max(0, p.speedBoostTime - dt);
    if (p.speedBoostTime <= 0) p.speedBoost = 0;
    p.outputBoostTime = Math.max(0, p.outputBoostTime - dt);
    if (p.outputBoostTime <= 0) p.outputBoost = 0;

    const speed =
      TUNABLE.playerMoveSpeed *
      (p.dashTimer > 0 ? TUNABLE.dashSpeedMult : 1) *
      (1 + p.speedBoost + this.bonuses.speed);
    p.vx = mx * speed;
    p.vy = my * speed;
    if (p.dashTimer > 0 && len < 0.01) {
      p.vx = p.dirX * speed;
      p.vy = p.dirY * speed;
    }
    p.x = clamp(p.x + p.vx * dt, TUNABLE.playerRadius, this.arena.width - TUNABLE.playerRadius);
    p.y = clamp(p.y + p.vy * dt, TUNABLE.playerRadius, this.arena.height - TUNABLE.playerRadius);
    this.resolveRuins(p, TUNABLE.playerRadius);
  }

  /**
   * Circle-vs-rect pushout against the arena's structure ruins (§22, The Heap:
   * "structure ruins as soft cover for herding"). Bodies slide along faces rather
   * than sticking, which is what turns a corner into a herding tool.
   */
  private resolveRuins(body: { x: number; y: number }, radius: number): boolean {
    let touched = false;
    for (const r of this.ruins) {
      const nx = clamp(body.x, r.x, r.x + r.w);
      const ny = clamp(body.y, r.y, r.y + r.h);
      const dx = body.x - nx;
      const dy = body.y - ny;
      const d2 = dx * dx + dy * dy;
      if (d2 >= radius * radius) continue;
      touched = true;
      if (d2 > 1e-6) {
        const d = Math.sqrt(d2);
        body.x = nx + (dx / d) * radius;
        body.y = ny + (dy / d) * radius;
      } else {
        // Centre is inside the rect — eject through the nearest face.
        const left = body.x - r.x;
        const right = r.x + r.w - body.x;
        const top = body.y - r.y;
        const bottom = r.y + r.h - body.y;
        const min = Math.min(left, right, top, bottom);
        if (min === left) body.x = r.x - radius;
        else if (min === right) body.x = r.x + r.w + radius;
        else if (min === top) body.y = r.y - radius;
        else body.y = r.y + r.h + radius;
      }
    }
    return touched;
  }

  /** True if the point sits inside any ruin — used for projectiles and spawns. */
  insideRuin(x: number, y: number, pad = 0): boolean {
    for (const r of this.ruins) {
      if (x >= r.x - pad && x <= r.x + r.w + pad && y >= r.y - pad && y <= r.y + r.h + pad) {
        return true;
      }
    }
    return false;
  }

  private updateEnemies(dt: number): void {
    const p = this.player;
    // Recounted every tick rather than tracked incrementally: a Lancer can die
    // mid-charge, and a leaked counter would silently mute the whole species.
    this.traitCtx.lancers.charging = 0;
    for (const e of this.enemies) if (e.alive && e.beamActive > 0) this.traitCtx.lancers.charging++;

    for (const e of this.enemies) {
      if (!e.alive) continue;
      e.spawnAge += dt;
      e.flash = Math.max(0, e.flash - dt);
      // A shared per-enemy cooldown. It used to tick only inside the Lancer
      // branch, which meant every other enemy that leaned on it — the Leech —
      // fired once and never again.
      if (e.beamTimer > 0) e.beamTimer -= dt;
      // §23.1 — refresh the per-second knockback budget.
      e.shoveWindow -= dt;
      if (e.shoveWindow <= 0) {
        e.shoveWindow = 1;
        e.shoveBudget = TUNABLE.shoveBudgetPerSecond;
      }
      const def = getEnemy(e.defId);

      // §10.3 Phasing — untargetable for a beat, on a steady cycle. Carried
      // either by the elite affix or by the def itself (§10.4 Ghost variants),
      // because a variant should not have to be an elite to have an idea.
      // The def's own phase is listed before any affix's, so a Ghost that also
      // rolled Phasing keeps the Ghost's timing — which is what it did before.
      const phase = traitOf(e.traits, 'phase');
      if (phase) {
        const phaseEvery = num(phase, 'interval', 0);
        const hold = num(phase, 'hold', TUNABLE.affixPhaseDuration);
        if (phaseEvery > 0) e.phased = e.spawnAge % (phaseEvery + hold) > phaseEvery;
      }

      // §10.2 — run this enemy's traits, in order.
      //
      // The first that reports `handled` owns the tick and stops both the rest
      // of the list and the shared tail below. That is exactly what the three
      // `continue`s here used to do, and the Charger's fall-through to the seek
      // block is now the plain fact that `dash` returns nothing and `seek` is
      // the next entry in its list.
      let handled = false;
      e.steers = false;
      const c = this.traitCtx;
      c.dt = dt;
      c.time = this.time;
      c.enemy = e;
      c.def = def;
      for (const spec of e.traits) {
        c.spec = spec;
        if (TRAIT_RUNNERS[spec.t]?.(c) === true) {
          handled = true;
          break;
        }
      }
      if (handled) continue;

      if (e.steers && e.state === 'seek') {
        const dx = p.x - e.x;
        const dy = p.y - e.y;
        const len = hypot(dx, dy) || 1;

        // Steer along the navigation field so ruins get walked around rather
        // than pressed against. Close in, or where the field is undefined, fall
        // back to a direct seek — the field's last cells all point at the player
        // anyway and direct motion reads better at contact range.
        let sx = dx / len;
        let sy = dy / len;
        if (len > this.flow.cellSize) {
          this.flow.sample(e.x, e.y, this.flowSample);
          if (this.flowSample.x !== 0 || this.flowSample.y !== 0) {
            sx = this.flowSample.x;
            sy = this.flowSample.y;
          }
        }

        // A shared flow field hands every enemy the identical vector, so they
        // converge onto one path and trail the player in a single queue. Three
        // corrections, all per-enemy, break that up without losing the pathing:
        //
        //  1. a slow weave, phase-offset per enemy, so paths differ
        //  2. separation from neighbours, so they spread instead of stacking
        //  3. a personal speed, so a group does not arrive as one rank
        const weave = psin(this.time * TUNABLE.weaveRate + e.wobble) * TUNABLE.weaveAmount;
        const cos = pcos(weave);
        const sin = psin(weave);
        let vx = sx * cos - sy * sin;
        let vy = sx * sin + sy * cos;

        let sepX = 0;
        let sepY = 0;
        const near = e.radius * TUNABLE.separationRadiusMult;
        this.grid.queryRadius(e.x, e.y, near, (other) => {
          if (other === e) return;
          const ox = e.x - other.x;
          const oy = e.y - other.y;
          const d = hypot(ox, oy);
          if (d < 0.001 || d > near) return;
          const push = (1 - d / near) / d;
          sepX += ox * push;
          sepY += oy * push;
        });
        const sepLen = hypot(sepX, sepY);
        if (sepLen > 0.001) {
          vx += (sepX / sepLen) * TUNABLE.separationStrength;
          vy += (sepY / sepLen) * TUNABLE.separationStrength;
        }

        const norm = hypot(vx, vy) || 1;
        const speed = def.speed * e.speedScale;
        e.vx = (vx / norm) * speed;
        e.vy = (vy / norm) * speed;
      }

      if (e.state !== 'windup') {
        e.x += e.vx * dt;
        e.y += e.vy * dt;
        // Enemies collide with ruins too — that is what makes cover work as a
        // herding tool rather than a wall the player hides behind forever.
        if (this.resolveRuins(e, e.radius) && e.state === 'dash') {
          e.state = 'seek';
          e.timer = 1.2;
        }
      }

      // Contact.
      const dx = p.x - e.x;
      const dy = p.y - e.y;
      const d2 = dx * dx + dy * dy;
      const r = e.radius + TUNABLE.playerRadius;
      if (d2 < r * r) this.touchPlayer(e, def);

      // Outrun stragglers stop existing — see TUNABLE.despawnRadius.
      if (d2 > TUNABLE.despawnRadius * TUNABLE.despawnRadius && e.spawnAge > 4) {
        e.alive = false;
      }
    }
  }

  /**
   * §10.2 Leech — contact heats you instead of hurting you.
   *
   * Pressure aimed at the economy rather than the health bar (§11), and with
   * Fuel gone the economy is Heat. Touching one shoves you toward Overheat,
   * which is worse for a deep-cascade engine than losing Integrity and harmless
   * to a shallow one — the enemy that punishes the build the game rewards.
   */
  private touchPlayer(e: Enemy, def: EnemyDef): void {
    if (def.heatOnTouch) {
      if (e.beamTimer > 0) return; // per-enemy cooldown
      e.beamTimer = 1.2;
      this.budget.addHeat(def.heatOnTouch);
      this.pushFx('hurt', e.hue, this.player.x, this.player.y, 0, [], 0.16);
      return;
    }
    if (def.contactDamage > 0) {
      this.hurtPlayer(def.contactDamage * (e.damageScale ?? 1), {
        id: def.id,
        label: def.name,
        enemyId: def.id,
        shape: def.shape,
        mode: 'contact',
      });
    }
  }

  /**
   * §10.2 Interceptor — "targets your *projectiles*, eats them, grows +10% per
   * meal". The intended counter to pure projectile spam: the answer is beams,
   * fields and novas, i.e. build diversity through threat rather than nerfs.
   */
  /**
   * Feed an Interceptor. `share` is how much of a meal it was: one for a
   * swallowed projectile, a fraction for being clipped by something with area.
   */
  private feedInterceptor(e: Enemy, share: number): void {
    const def = getEnemy(e.defId);
    if (!def.growthPerMeal) return;
    if (e.meals >= TUNABLE.interceptorMaxMeals) return;
    e.mealProgress = (e.mealProgress ?? 0) + share;
    if (e.mealProgress < 1) return;
    e.mealProgress -= 1;
    e.meals++;
    const growth = 1 + def.growthPerMeal;
    e.radius *= growth;
    // HP grows more slowly than the body. A Glutton should be enormous and
    // *killable*; matching the radius made it neither.
    const hpGrowth = 1 + def.growthPerMeal * TUNABLE.interceptorHpGrowthShare;
    e.maxHp *= hpGrowth;
    e.hp *= hpGrowth;
    this.pushFx('burst', e.hue, e.x, e.y, e.radius + 8, [], 0.12);
    if (e.meals >= TUNABLE.interceptorMaxMeals) {
      // Full. Announced once, loudly.
      this.pushFx('rupture', e.hue, e.x, e.y, e.radius * 1.6, [], 0.5);
      this.cue('fire', e.hue, 0, 1);
    }
  }

  private updateProjectiles(dt: number): void {
    for (const proj of this.projectiles) {
      if (!proj.alive) continue;
      proj.age += dt;
      proj.life -= dt;

      // §5.4 Fragment — "a short-lived autonomous mote that seeks and
      // detonates". Steers toward the nearest target rather than flying true.
      if (proj.seek > 0) {
        const target = this.grid.nearest(proj.x, proj.y, 600);
        if (target) {
          const dx = target.x - proj.x;
          const dy = target.y - proj.y;
          const d = hypot(dx, dy) || 1;
          const speed = hypot(proj.vx, proj.vy) || 1;
          proj.vx += (dx / d) * proj.seek * speed * dt;
          proj.vy += (dy / d) * proj.seek * speed * dt;
          const norm = hypot(proj.vx, proj.vy) || 1;
          proj.vx = (proj.vx / norm) * speed;
          proj.vy = (proj.vy / norm) * speed;
        }
      }

      proj.x += proj.vx * dt;
      proj.y += proj.vy * dt;

      if (
        proj.life <= 0 ||
        proj.x < -40 ||
        proj.y < -40 ||
        proj.x > this.arena.width + 40 ||
        proj.y > this.arena.height + 40 ||
        this.insideRuin(proj.x, proj.y)
      ) {
        this.expireProjectile(proj);
        continue;
      }

      if (proj.corrupted && this.player.iframes <= 0) {
        const dx = this.player.x - proj.x;
        const dy = this.player.y - proj.y;
        const r = TUNABLE.playerRadius + proj.radius;
        if (dx * dx + dy * dy < r * r) {
          this.hurtPlayer(4, {
            id: 'corrupted',
            label: 'Your own corrupted fire',
            mode: 'Instability II',
          });
          proj.alive = false;
          continue;
        }
      }

      this.grid.queryRadius(proj.x, proj.y, proj.radius + 16, (enemy) => {
        if (!proj.alive || !enemy.alive) return;
        if (proj.hits.includes(enemy.id)) return;
        const dx = enemy.x - proj.x;
        const dy = enemy.y - proj.y;
        const r = enemy.radius + proj.radius;
        if (dx * dx + dy * dy > r * r) return;
        // §10.2 Bulwark — a front shield arc that blocks projectiles. The
        // counter is to flank it, or to use something that is not a projectile.
        const shield = getEnemy(enemy.defId).shieldArc;
        if (shield) {
          const incoming = patan2(proj.y - enemy.y, proj.x - enemy.x);
          const facing = patan2(this.player.y - enemy.y, this.player.x - enemy.x);
          if (Math.abs(angleDelta(incoming, facing)) < shield / 2) {
            proj.alive = false;
            this.pushFx('burst', enemy.hue, proj.x, proj.y, 14, [], 0.1);
            return;
          }
        }
        proj.hits.push(enemy.id);
        // §5.4 Siphon — sheds Heat on hit.
        //
        // Fuel is gone and Heat is the resource, so the node that used to steal
        // one currency now vents the other. It is the only *sustained* cooling
        // in the game — Coolant is a burst — which makes it the piece a deep
        // cascade build is actually looking for.
        if (proj.siphon > 0) {
          this.budget.addHeat(-proj.siphon);
        }
        this.damageEnemy(enemy, proj.damage, proj.depth, proj.programIndex, proj.hue, proj.leech);
        if (proj.hits.length > proj.pierce) {
          // §5.5 Ricochet — spend a bounce to redirect at a fresh target rather
          // than dying. Pierce is exhausted first, so the two stack sensibly.
          const next =
            proj.bounces > 0
              ? this.grid.nearest(proj.x, proj.y, 420, (e) => proj.hits.includes(e.id))
              : null;
          if (next) {
            proj.bounces--;
            const dx = next.x - proj.x;
            const dy = next.y - proj.y;
            const len = hypot(dx, dy) || 1;
            const speed = hypot(proj.vx, proj.vy) || 1;
            proj.vx = (dx / len) * speed;
            proj.vy = (dy / len) * speed;
            proj.hits = [];
            proj.life = Math.max(proj.life, 0.6);
          } else {
            this.expireProjectile(proj);
          }
        }
      });
    }
  }

  /**
   * §7.4 — the arbitrage layer. Convert exchanges one resource for another, and
   * the exchange rates are called out as "the most sensitive tuning surface in
   * the game": degenerate loops like Bleed + Leech are *expected and welcome*
   * as long as they cost Cycles.
   *
   * A Convert only fires when it can pay, and emits On Convert when it resolves.
   */
  private runConvert(def: ActionDef, depth: number): void {
    const spec = def.convert;
    if (!spec) return;

    // Pay.
    if (spec.costKind === 'integrity') {
      // Never let a Convert kill you outright: it is a trade, not a gamble.
      if (this.player.integrity <= spec.costAmount + 1) return;
      if (this.player.integrity < 40) this.stats.desperateConverts++;
      this.player.integrity -= spec.costAmount;
    } else {
      // Heat is the currency now. Spending it is what makes running hot a
      // *position* rather than only a penalty — a deep cascade generates the
      // thing these Actions turn back into progress.
      if (this.budget.heat < spec.costAmount) return;
      this.budget.addHeat(-spec.costAmount);
    }

    // Receive.
    switch (spec.gainKind) {
      case 'xp':
        this.gainXp(this.xpToNext * spec.gainAmount);
        break;
      case 'heat':
        this.budget.addHeat(-spec.gainAmount);
        break;
      case 'output':
        this.player.outputBoost = Math.max(this.player.outputBoost, spec.gainAmount);
        this.player.outputBoostTime = Math.max(this.player.outputBoostTime, spec.duration ?? 4);
        break;
      case 'speed':
        this.player.speedBoost = Math.max(this.player.speedBoost, spec.gainAmount);
        this.player.speedBoostTime = Math.max(this.player.speedBoostTime, spec.duration ?? 3);
        break;
    }
    this.finishConvert(def, depth);
  }

  private finishConvert(def: ActionDef, depth: number): void {
    this.stats.converts++;
    this.cue('convert', def.hue, depth, 0.5);
    this.pushFx('burst', def.hue, this.player.x, this.player.y, 34, [], 0.2);
    this.emit({ type: 'convert', depth: depth + 1, x: this.player.x, y: this.player.y });
  }

  /** §5.5 Volatile — "effect detonates at end of life for 50% output". */
  private expireProjectile(proj: Projectile): void {
    if (!proj.alive) return;
    proj.alive = false;
    if (proj.volatile <= 0) return;
    const radius = TUNABLE.volatileRadius;
    this.grid.queryRadius(proj.x, proj.y, radius, (enemy) => {
      this.damageEnemy(
        enemy,
        proj.damage * proj.volatile,
        proj.depth,
        proj.programIndex,
        proj.hue,
        proj.leech,
      );
    });
    this.pushFx('burst', proj.hue, proj.x, proj.y, radius, [], 0.18);
  }

  private updatePickups(dt: number): void {
    const p = this.player;
    for (const item of this.pickups) {
      if (!item.alive) continue;
      item.age += dt;
      const dx = p.x - item.x;
      const dy = p.y - item.y;
      const d = hypot(dx, dy) || 1;

      if (item.called) {
        // Accelerating homing. Slow to leave, fast to arrive: eight hundred
        // shards crossing the arena at a constant speed is a wall of dots
        // arriving together, and the whole point is the stream.
        const speed = Math.min(1600, 300 + d * 1.7);
        item.x += (dx / d) * speed * dt;
        item.y += (dy / d) * speed * dt;
        item.vx *= 0.86;
        item.vy *= 0.86;
        item.x += item.vx * dt;
        item.y += item.vy * dt;
        if (d < TUNABLE.playerRadius + 14) {
          item.alive = false;
          this.gainXp(item.value);
          this.cue('pickup', item.hue, 0, 0.2);
          this.emit({ type: 'pickup', depth: 0, x: p.x, y: p.y, hue: item.hue });
        }
        continue;
      }

      const magnet = TUNABLE.collectRadius * (1 + this.bonuses.magnet);
      if (d < magnet) {
        // §17.2 — quadratic magnet ease-in.
        const pull = 260 * (1 - d / magnet) + 90;
        item.x += (dx / d) * pull * dt;
        item.y += (dy / d) * pull * dt;
      } else {
        item.vx *= 0.92;
        item.vy *= 0.92;
        item.x += item.vx * dt;
        item.y += item.vy * dt;
      }

      if (d < TUNABLE.playerRadius + 6) {
        item.alive = false;
        if (item.kind === 'magnet') this.sweepShards();
        else this.gainXp(item.value * (this.biome?.xpMultiplier ?? 1));
        this.cue('pickup', item.hue, 0, item.kind === 'xp' ? 0.3 : 0.2);
        this.emit({ type: 'pickup', depth: 0, x: p.x, y: p.y, hue: item.hue });
      }
    }
  }

  /**
   * Roll for a Magnet on a kill.
   *
   * A flat per-kill chance cannot work here, and that is worth spelling out: an
   * ordinary early minute is forty kills, and a late one measured **31,744 kills
   * in eleven minutes**. Any chance rare enough to be special at minute eleven
   * is a chance you will never see at minute one, and vice versa. So the roll is
   * gated on time instead — never two at once, never within `magnetCooldown` of
   * the last one, and then a low chance per kill. That makes the *cadence* the
   * tunable rather than the odds, and it behaves the same at 4 EPS and 2,000.
   */
  private maybeDropMagnet(x: number, y: number): void {
    if (this.magnetCooldown > 0) return;
    if (!this.rng.chance(TUNABLE.magnetDropChance)) return;
    for (const item of this.pickups) {
      if (item.alive && item.kind === 'magnet') return;
    }
    this.magnetCooldown = TUNABLE.magnetCooldown;
    this.dropPickup('magnet', x, y, 'voltaic', 1);
  }

  /**
   * The Magnet, collected: every XP shard on the map is *called*.
   *
   * Not consumed — called. The first version granted the total and deleted the
   * shards in one tick, which is correct and completely silent: the rarest
   * object in the game paid out as a number changing. Now every shard flares
   * outward and then flies to you, accelerating with distance, so a sweep is a
   * few seconds of the whole arena draining into the player. Each one still
   * emits On Pickup as it lands, which turns the burst into a run of cascade
   * roots and a run of notes rather than one lump.
   */
  private sweepShards(): void {
    for (const item of this.pickups) {
      if (!item.alive || item.kind !== 'xp' || item.called) continue;
      item.called = true;
      // Thrown outward first, so the flight starts with a flare rather than a
      // straight line. Costs nothing and it is most of what makes it read.
      const a = patan2(item.y - this.player.y, item.x - this.player.x);
      item.vx = pcos(a) * 220;
      item.vy = psin(a) * 220;
    }
    this.stats.magnets++;
    this.emit({ type: 'sweep', depth: 0, x: this.player.x, y: this.player.y });
    this.pushFx('burst', 'voltaic', this.player.x, this.player.y, 420, [], 0.5);
    this.cue('pickup', 'voltaic', 0, 1);
  }

  /**
   * §7.3 — shard consolidation. Once the ground is carrying more than the soft
   * cap, the oldest drops merge into fewer, richer ones: same kind, same hue,
   * within a radius, value summed so nothing is lost. Invisible when it works.
   */
  private consolidatePickups(dt: number): void {
    this.consolidateTimer -= dt;
    if (this.consolidateTimer > 0) return;
    this.consolidateTimer = TUNABLE.consolidateInterval;
    if (this.pickups.length <= TUNABLE.pickupSoftCap) return;

    // Oldest first — `pickups` is in creation order, so the surplus at the front
    // is what has been lying around longest.
    const surplus = this.pickups.length - TUNABLE.pickupSoftCap;
    const r2 = TUNABLE.consolidateRadius * TUNABLE.consolidateRadius;
    let merged = 0;

    for (let i = 0; i < this.pickups.length && merged < surplus; i++) {
      const host = this.pickups[i]!;
      if (!host.alive) continue;
      for (let j = i + 1; j < this.pickups.length && merged < surplus; j++) {
        const other = this.pickups[j]!;
        if (!other.alive) continue;
        if (other.kind !== host.kind) continue;
        // XP renders white regardless of which enemy dropped it, so its hue is
        // not load-bearing and shards merge freely.
        // would silently convert one gauge into another.
        const dx = other.x - host.x;
        const dy = other.y - host.y;
        if (dx * dx + dy * dy > r2) continue;
        host.value += other.value;
        other.alive = false;
        merged++;
      }
    }
  }

  private updateFx(dt: number): void {
    for (const f of this.fx) {
      if (!f.alive) continue;
      f.life -= dt;
      if (f.life <= 0) f.alive = false;
    }
  }

  private updateDirector(dt: number): void {
    // §12.1 — Threat rises with time and never decreases.
    const before = this.threatStep;
    this.threat += TUNABLE.threatPerSecond * dt;
    // ...and says so when it crosses a step. The rise is smooth and the *telling*
    // is not, for the same reason Heat has tiers: a continuous invisible number
    // is not something anybody can plan against, and a beat is.
    //
    // Marked even in a capped room, where by design nothing about the fight
    // changes — that is not a wasted notification, it is the signal. The step
    // climbs, the room cannot follow, and the gap between them is the game
    // saying how far ahead the next door has got without ever nagging.
    if (this.threatStep > before) {
      this.mark(
        'threat',
        this.roomThreatGap > 0
          ? `threat ${this.threatStep} · room holds at ${this.roomThreatStep}`
          : `threat ${this.threatStep}`,
      );
      this.cue('summons', 'void', 0, 0.5);
    }

    this.releasePendingSpawns();

    // Rotate the composition, and announce the new one with an arrival burst.
    this.compositionTimer -= dt;
    if (this.compositionTimer <= 0 || !this.composition) {
      this.compositionTimer = TUNABLE.compositionDuration;
      this.rotateComposition();
    }

    // §10.2 — Wardens punctuate the flow once Threat is high enough.
    if (this.roomThreat >= TUNABLE.wardenFromThreat) {
      this.wardenTimer -= dt;
      if (this.wardenTimer <= 0) {
        this.wardenTimer = TUNABLE.wardenInterval;
        const origin = this.pickSpawnOrigin();
        this.queueSpawn('warden', origin.x, origin.y, 40, 0, this.ambientVia());
      }
    }

    this.sustainPressure(dt);
  }

  /**
   * A rehearsal room: almost no enemies, so a thing can be *looked at*.
   *
   * Gates, level transitions and structure are all things you have to reach
   * before you can judge them, and reaching them through a live horde means
   * every attempt is a different fight. This is not a difficulty setting — it is
   * off unless a URL flag asks for it, it is never on in a scored run, and it
   * scales the director rather than disabling it so the game still behaves like
   * itself while you stand there and watch.
   */
  sandbox = false;

  /** §21b.7 — is any gate currently being held? The siege reads as a phase. */
  get gateHeld(): boolean {
    for (const t of this.terminals) {
      if (t.alive && t.gateId && t.progress > 0) return true;
    }
    return false;
  }

  /**
   * §21b — Threat as *this room* experiences it.
   *
   * `threat` is the run's clock and it only ever rises. `roomThreat` is what the
   * director is allowed to spend here, and in a capped room it stops. Every
   * question about what arrives — which compositions are eligible, how many, how
   * far substitution may climb, whether Wardens have started — asks this one.
   * `threat` itself stays the global figure, because that is what the *next*
   * room will be measured against and what the player is shown.
   *
   * One value rather than a cap per system, because "the room stopped" has to be
   * a single fact. Capping the composition and not the density gives you the
   * tutorial level's two families at four hundred bodies, which is not a plateau,
   * it is the same cliff wearing a friendlier roster.
   */
  get roomThreat(): number {
    const cap = this.currentLevel?.roster.threatCap;
    return cap === undefined ? this.threat : Math.min(this.threat, cap);
  }

  /**
   * How far the run has moved on without this room, in Threat.
   *
   * Zero in an uncapped room and while you are keeping up. Once it opens it is
   * the whole of the "you are behind" signal, and it is diegetic rather than a
   * nag: the number is what is waiting on the other side of the door, and the
   * room you are standing in cannot express it.
   */
  get roomThreatGap(): number {
    return Math.max(0, this.threat - this.roomThreat);
  }

  /** §12.1 — the run's Threat as a step the player can name. */
  get threatStep(): number {
    return Math.floor(this.threat / TUNABLE.threatPerStep);
  }

  /** ...and what this room is able to express, which in a capped one stops. */
  get roomThreatStep(): number {
    return Math.floor(this.roomThreat / TUNABLE.threatPerStep);
  }

  /** Live density the director is actively trying to hold. */
  get targetAlive(): number {
    const target = Math.min(
      TUNABLE.maxAliveHard,
      TUNABLE.targetAliveBase + this.roomThreat * TUNABLE.targetAlivePerThreat,
    );
    // LEVELS §2.3 — the tutorial's easing. Applied here so everything sized
    // off the target — ambient refill, cache menageries, siege parcels —
    // eases together. Guarded so an unset knob leaves the number bit-identical.
    const eased = this.config.pressure !== undefined ? target * this.config.pressure : target;
    return this.sandbox ? Math.max(1, Math.round(eased * 0.06)) : eased;
  }

  /**
   * Feed the current composition in continuously to close the density deficit.
   *
   * Density is *maintained*, not capped. This is not rubber-banding: the target
   * is a pure function of Threat, which only ever rises. Killing faster earns
   * more fuel, more XP and more EPS — it does not earn quiet.
   */
  private sustainPressure(dt: number): void {
    const composition = this.composition;
    if (!composition) return;

    // §21b.7 — the floor drops while a gate is held.
    //
    // Density is *maintained*, which is right for the run and wrong for a siege:
    // the parcels are the pressure, and a floor that refills behind every kill
    // means killing changes nothing. Scaling the floor is what makes the fight
    // resolvable and makes walking away a real option, without touching the
    // siege's own size — the parcels are sized off the unscaled target.
    const floor = this.gateHeld ? TUNABLE.siegeAmbientFraction : 1;

    // Count only what is near the player, not the whole arena.
    //
    // A global count meant a queue trailing behind you filled the entire budget,
    // so nothing spawned ahead and you could outrun the game. Pressure is a
    // local property: what matters is how many enemies are where you are.
    const present = this.nearbyEnemyCount() + this.pendingSpawns.length;
    const deficit = this.targetAlive * floor - present;
    if (deficit <= 0) {
      this.refillDebt = 0;
      return;
    }

    const maxRate =
      (TUNABLE.refillRateBase + this.roomThreat * TUNABLE.refillRatePerThreat) * floor;
    const rate = Math.min(maxRate, deficit * TUNABLE.refillAggression);
    this.refillDebt += rate * dt;

    let guard = 0;
    while (this.refillDebt >= 1 && guard++ < 64) {
      this.refillDebt -= 1;
      this.spawnFromComposition(composition, false, 0);
    }
  }

  /** Enemies close enough to be pressure, i.e. roughly on or near the screen. */
  private nearbyEnemyCount(): number {
    const r2 = TUNABLE.pressureRadius * TUNABLE.pressureRadius;
    let count = 0;
    for (const e of this.enemies) {
      if (!e.alive) continue;
      const dx = e.x - this.player.x;
      const dy = e.y - this.player.y;
      if (dx * dx + dy * dy <= r2) count++;
    }
    return count;
  }

  private rotateComposition(): void {
    const eligible = WAVES.filter((w) => this.roomThreat >= w.minThreat && this.roomThreat <= w.maxThreat);
    if (eligible.length === 0) return;

    // Every run opens on the designated opener, not on a weighted roll.
    const opener = this.composition === null ? eligible.find((w) => w.opener) : undefined;
    this.composition =
      opener ??
      this.rng.pickWeighted(
        eligible,
        eligible.map((w) => this.waveWeight(w)),
      );

    // The arrival: a real burst so a new composition announces itself, sized
    // against the density target rather than the template's own counts.
    const burst = Math.round(this.targetAlive * TUNABLE.compositionArrivalFraction);
    for (let i = 0; i < burst; i++) {
      this.spawnFromComposition(this.composition, false, this.rng.next() * TUNABLE.waveArrivalSpread);
    }
    const origin = this.pickSpawnOrigin();
    this.emit({ type: 'wave', depth: 0, x: origin.x, y: origin.y });
  }

  /** Draw one enemy from a composition, weighted by its entry counts. */
  private spawnFromComposition(
    template: WaveTemplateDef,
    enriched: boolean,
    delay: number,
  ): void {
    if (template.entries.length === 0) return;
    const entry = this.rng.pickWeighted(
      template.entries,
      template.entries.map((e) => e.count),
    );
    const origin = this.pickSpawnOrigin();
    this.queueSpawn(entry.enemy, origin.x, origin.y, entry.spread, delay, this.ambientVia(enriched));
  }

  /**
   * §12.2 — the director's reactive weighting. Interceptor templates get heavier
   * the more projectiles the player has in the air, so spam summons its own
   * counter. This is the design's answer to "don't nerf, apply pressure" (§23.1).
   */
  waveWeightFor(w: WaveTemplateDef): number {
    return this.waveWeight(w);
  }

  private waveWeight(w: WaveTemplateDef): number {
    if (w.reactive !== 'projectiles') return w.weight;
    const scale = Math.min(
      TUNABLE.interceptorMaxWeight,
      1 + this.projectiles.length * TUNABLE.interceptorPerProjectile,
    );
    return w.weight * scale;
  }

  /** Arrive any queued spawns whose time has come. */
  private releasePendingSpawns(): void {
    if (this.pendingSpawns.length === 0) return;
    let due = false;
    for (const s of this.pendingSpawns) {
      if (!s.alive || s.time > this.time) continue;
      s.alive = false;
      due = true;
      // Re-assert the off-screen and safe-radius guarantees against where the
      // player is NOW: they may have run most of a screen's width since this
      // spawn was queued.
      const hidden = s.visible ? { x: s.x, y: s.y } : this.pushOutsideView(s.x, s.y);
      const safe = this.pushOutsideSafeRadius(hidden.x, hidden.y);
      const e = this.spawnEnemy(
        s.enemy,
        clamp(safe.x, 20, this.arena.width - 20),
        clamp(safe.y, 20, this.arena.height - 20),
        s.hue,
      );
      if (e) {
        e.enriched = s.enriched;
        // §12.4 — the Cache's price. One affix each, rolled from the same pool
        // the Warden uses, so a menagerie is genuinely the wave you already know
        // wearing everything that makes it worse.
        // §10.3 — affixes, drawn without replacement. The same affix twice is
        // one affix and a wasted roll, and the pool is only three deep. A Cache
        // rolls one, a gate siege rolls two.
        if (s.affixes > 0) {
          // The wave's own veto, applied before the global ceiling's. §12.4: a
          // Cache is a purchase, and the thing it must never sell you is your
          // own Engine switched off — `noEvents` already keeps Suppressors out,
          // and `anchored` walked the same field in through the affix roll.
          const pool = this.affixPool().filter((a) => !s.affixExclude.includes(a));
          for (let n = 0; n < Math.min(s.affixes, pool.length); n++) {
            e.affixes.push(pool.splice(this.rng.int(pool.length), 1)[0]!);
          }
          e.hardened = true;
          this.resolveTraits(e);
        }
        // §10.4's exception, and the only one. See the `toughen` op: opt-in
        // difficulty is the one place a straight multiplier is honest, because
        // the player pressed the button. Reported as "everything died instantly"
        // the first time, because a hardened Mote was still a one-hit Mote.
        if (s.hpScale !== 1) {
          e.maxHp *= s.hpScale;
          e.hp = e.maxHp;
        }
        if (s.damageScale !== 1) e.damageScale = s.damageScale;
      }
    }
    if (due) {
      let w = 0;
      for (let r = 0; r < this.pendingSpawns.length; r++) {
        const s = this.pendingSpawns[r]!;
        if (s.alive) this.pendingSpawns[w++] = s;
      }
      this.pendingSpawns.length = w;
    }
  }

  /** One or two light enemies from a random direction, scaled by Threat. */
  /**
   * §12.3 — a channelled Beacon pulls the next wave in early and enriched. With
   * the director maintaining density continuously, "early" means a burst of the
   * current composition on top of the flow, not a replacement for it.
   */
  private spawnWave(enriched: boolean): void {
    if (!this.composition) this.rotateComposition();
    const composition = this.composition;
    if (!composition) return;

    void composition;
    void enriched;
    this.callWave({
      event: WAVE_EVENT_BY_ID.get('beacon_call')!,
      x: this.player.x,
      y: this.player.y,
      via: this.rosterVia(this.currentLevel),
    });
    const origin = this.pickSpawnOrigin();
    this.emit({ type: 'wave', depth: 0, x: origin.x, y: origin.y });
  }

  /**
   * §12.5 — run one enemy through a wave's transform chain.
   *
   * This is `rosterAllows -> substitute -> harden` made visible and reorderable.
   * Those were three private methods called in a fixed order inside the spawner,
   * each reaching into `this` for the room and the Threat, which is why every
   * called wave had to be its own loop with its own copies of the same logic.
   *
   * Order matters and is the caller's to choose. Roster first is almost always
   * right — remap into the room's vocabulary, *then* climb the ladder within it,
   * or you spend the climb on a family that gets swapped out afterwards.
   */
  private applyVia(enemy: string, via: readonly WaveTransform[]): SpawnRecipe {
    this.escalateTier = Infinity;
    this.escalateCap = Infinity;
    this.chainFamilies = [];
    const out: SpawnRecipe = {
      enemy,
      affixes: 0,
      affixExclude: [],
      hpScale: 1,
      damageScale: 1,
      enriched: false,
    };
    for (const step of via) {
      switch (step.op) {
        case 'roster':
          this.escalateTier = step.tier;
          this.escalateCap = step.cap ?? Infinity;
          this.chainFamilies = step.families;
          out.enemy = this.viaRoster(out.enemy, step.tier, step.families, step.events);
          break;
        case 'noEvents':
          // Whatever the roster let through as punctuation is remapped into an
          // ordinary family member. Passing no event list is the whole trick.
          out.enemy = this.viaRoster(out.enemy, this.escalateTier, this.chainFamilies);
          break;
        case 'escalate':
          out.enemy = this.viaEscalate(out.enemy, step);
          break;
        case 'affix':
          out.affixes += step.count;
          // Accumulated across the chain, never replaced: a room that forbids an
          // affix and an event that forbids another must both be obeyed, and
          // whichever ran second would otherwise win.
          if (step.exclude) out.affixExclude.push(...step.exclude);
          break;
        case 'toughen':
          out.hpScale *= step.hp;
          out.damageScale *= step.damage ?? 1;
          break;
        case 'enrich':
          out.enriched = true;
          break;
      }
    }
    return out;
  }

  /**
   * §21b — remap anything this room has never met.
   *
   * A wave template asks for a Charger; if the room's families do not include
   * chargers, it gets the base creature of a family that *is* here instead. The
   * template stays legal everywhere and the room decides what it means, which is
   * why a forty-Mote swarm can remain in the pool forever: a crisis on the first
   * level, a breather on the last, and the pacing costs nothing.
   *
   * Events — Suppressors, Lancers — are exempt. They are the room's punctuation
   * and carry their own live caps.
   */
  private viaRoster(
    enemy: string,
    tier: number,
    families: readonly string[],
    events?: readonly string[],
  ): string {
    if (families.length === 0) return enemy;
    const family = familyOf(enemy);
    if (families.includes(family)) {
      // The family is welcome here. The *variant* still has to be.
      //
      // `tier` was accepted and explicitly discarded, and that hole is the whole
      // of "tier 0 keeps elites out": it does, but only for elites arriving by
      // substitution. A template that names `mote_shielded` in its own entries
      // — `shield_wall` and `brood_nest` both do, and both are eligible at
      // Threat 6 — asked for a Mote-family creature, was told Motes are fine,
      // and walked a tier-1 elite into the tutorial room. Measured across the
      // real chains: nine distinct creatures reachable in a room authored to
      // hold two.
      //
      // Demoted to the family's base creature rather than dropped, because the
      // wave still wants a body in that slot: §10.4's "a wave of forty plain
      // Motes stays legal forever" only works if the room can *make* it plain.
      const variantTier = getEnemy(enemy).substitutes?.tier ?? 0;
      return variantTier > tier ? family : enemy;
    }
    if (events?.includes(enemy)) return enemy;
    return families[this.rng.int(families.length)]!;
  }

  /**
   * §10.4 — substitution: the same wave, made of different things.
   *
   * A wave template asks for "a Mote"; past a Threat band, some of those Motes
   * are Shielded or Charged instead. This is the whole of how a run gets harder
   * without a single number being multiplied — minute eleven looks different
   * from minute one because the things on screen *are different things*, and a
   * player can see the difference and answer it.
   *
   * Data-driven from the variant's own `substitutes` block, so a new variant
   * enters the game by existing.
   *
   * `roll` gives each eligible variant its authored share, ramped in over the
   * band above `fromThreat`, so the first Shielded Mote arrives alone rather
   * than as a whole wave of them — a texture. `best` takes the hardest legal one
   * outright, which is what a called wave wants, because a called wave is a
   * statement and a statement should not be a dice roll.
   *
   * The tier ceiling applies in both. It is the roster's, not this method's, and
   * a room can never field something it has never heard of (§21b) — that rule is
   * what makes the level structure mean anything.
   */
  private viaEscalate(
    enemy: string,
    step: { mode: 'roll' | 'best'; lead?: number; ceiling?: boolean },
  ): string {
    const options = VARIANTS_BY_FAMILY.get(familyOf(enemy));
    if (!options || options.length === 0) return enemy;
    const tier = this.escalateTier;
    // `ceiling` means the room's ceiling — which is what its own description in
    // waveevents.json has always claimed — and meant `Infinity` until a room had
    // a ceiling to name. That is most of why a gate siege was overwhelming: it
    // took the hardest variant every family had, at any Threat, and then applied
    // two affixes and quadruple HP on top. Uncapped rooms are unchanged.
    const reach = step.ceiling
      ? this.escalateCap
      : this.roomThreat + (step.lead ?? 0);

    if (step.mode === 'roll') {
      for (const variant of options) {
        const rule = variant.substitutes!;
        if ((rule.tier ?? 1) > tier) continue;
        if (reach < rule.fromThreat) continue;
        const ramp = Math.min(1, (reach - rule.fromThreat) / 4);
        if (this.rng.chance(rule.share * ramp)) return variant.id;
      }
      return enemy;
    }

    let best = enemy;
    let bestAt = -1;
    for (const variant of options) {
      const rule = variant.substitutes!;
      if ((rule.tier ?? 1) > tier) continue;
      if (rule.fromThreat > reach) continue;
      if (rule.fromThreat <= bestAt) continue;
      bestAt = rule.fromThreat;
      best = variant.id;
    }
    return best;
  }

  /**
   * The tier ceiling in force for the chain currently running.
   *
   * Set by `applyVia` when it sees a `roster` step and reset after, so escalate
   * is bounded by whichever room the *caller* named. A gate siege standing in
   * The Heap fields The Sink's roster, and that only works if the tier travels
   * with the families rather than being read off the player's position.
   */
  private escalateTier = Infinity;
  /**
   * ...and the Threat ceiling that travels with it, for `escalate: ceiling`.
   *
   * Same reasoning and the same trap: a gate's chain carries the *destination*
   * room's roster, so reading a cap off the room the player is standing in would
   * hand The Heap's ceiling to a wave made of The Sink.
   */
  private escalateCap = Infinity;
  /** The families the running chain's `roster` step named, for `noEvents`. */
  private chainFamilies: readonly string[] = [];

  /**
   * §12.5 — deliver a called wave.
   *
   * The one function that used to be four loops. Beacon, Cache and gate siege
   * were each a bespoke `for` over `composition.entries` with their own copies
   * of the ring maths, their own affix handling and their own tunables; the only
   * things that actually differed between them are now the three fields of a
   * `WaveEventDef`.
   *
   * `via` is what the *caller* resolved — in practice the roster, because that
   * is the one input an event cannot know for itself: a gate siege fields the
   * room behind the door, and everything else fields the room you are in. It is
   * applied before the event's own chain, so an event can climb the ladder
   * inside the vocabulary the caller handed it.
   *
   * `scale` exists for the gate, whose parcels are a score the player can cut
   * short by walking away. Everything else leaves it at 1.
   */
  private callWave(call: {
    event: WaveEventDef;
    x: number;
    y: number;
    via?: readonly WaveTransform[];
    scale?: number;
    /** Deliver only the parcel at this index. The gate ticks its own clock. */
    only?: number;
    /** §21b.7 — the doorway, for parcels that arrive through one. */
    door?: { x: number; y: number; w: number; h: number };
  }): void {
    const { event } = call;
    // No named pool means "whatever is already running" — a called wave is
    // usually the room you are in, arriving differently.
    if (!event.pool && !this.composition) this.rotateComposition();
    const template = event.pool ? WAVE_BY_ID.get(event.pool) : this.composition;
    if (!template || template.entries.length === 0) return;

    const via = [...(call.via ?? []), ...event.via];
    const scale = call.scale ?? 1;
    const weights = template.entries.map((e) => e.count);

    for (let p = 0; p < event.parcels.length; p++) {
      if (call.only !== undefined && call.only !== p) continue;
      const parcel = event.parcels[p]!;
      // §21b.7 — `at` is the schedule, and it must be applied exactly once.
      //
      // A caller passing `only` has already waited: the gate ticks its own bar
      // and hands over one parcel when that bar reaches `at`. Passing `at` on as
      // the spawn delay as well made the wait happen twice — the last parcel of
      // a siege, the biggest one, was delivered at bar-second 20.5 and then sat
      // in the queue for another 20.5 seconds, arriving about nineteen seconds
      // *after* the gate had opened and the fight was over. Reported as "AFTER
      // the gate opened, a TON kept spawning", and that is exactly what it was.
      const delay = call.only === undefined ? parcel.at : 0;
      this.deliverParcel(template, weights, parcel, via, call.x, call.y, scale, delay, call.door);
    }
  }

  /** One parcel of a called wave: size it, place it, queue it. */
  private deliverParcel(
    template: WaveTemplateDef,
    weights: readonly number[],
    parcel: WaveParcel,
    via: readonly WaveTransform[],
    cx: number,
    cy: number,
    scale: number,
    /** Seconds from now. Zero when the caller is driving the schedule itself. */
    delay: number,
    /** §21b.7 — the doorway a `from: 'door'` parcel pours through. */
    door?: { x: number; y: number; w: number; h: number },
  ): number {
    const count = Math.max(1, Math.round(this.targetAlive * parcel.share * scale));
    const spread = parcel.spread ?? 60;
    for (let i = 0; i < count; i++) {
      const entry = this.rng.pickWeighted(template.entries, weights);
      let ox: number;
      let oy: number;
      // §21b.7 — poured out of the doorway, in front of the player. Always.
      //
      // The first version put them on the player's side of the barrier and let
      // the generic safe-radius push sort out the rest. It cannot: the mouth sat
      // 60 units in front of the door, a player holding the gate stands about 120
      // from its face, and `spawnSafeRadius` is 260 — so the push moved them
      // *radially outward from the player*, which from that geometry means
      // straight past them and out the back. Reported as arriving behind, with no
      // way out, and it was: the only direction with room was backwards.
      //
      // So the placement owns the constraint instead of inheriting it. The door
      // has a normal (its short axis — the way the corridor runs) and a face (its
      // long one). Arrivals land on the face pointing at the player and are
      // separated *along the door*, never around the player. If the face is not
      // wide enough to clear the safe radius, they retreat along the normal into
      // the doorway — deeper into the gap they are coming out of — because the
      // one direction they must never be pushed is behind.
      if (parcel.from === 'door' && door) {
        const cxD = door.x + door.w / 2;
        const cyD = door.y + door.h / 2;
        // Short axis is the way through; long axis is the width of the opening.
        const normalX = door.w <= door.h;
        const halfN = (normalX ? door.w : door.h) / 2;
        const halfL = (normalX ? door.h : door.w) / 2;
        const pn = normalX ? this.player.x : this.player.y;

        const cn = normalX ? cxD : cyD;
        const cl = normalX ? cyD : cxD;
        // Which way is through: away from the player, deeper into the gap.
        const through = pn >= cn ? -1 : 1;


        // §12.2 — the safe radius is satisfied by *construction* rather than
        // corrected afterwards, and that is the whole fix. Measuring the point
        // and pushing it out is what put them behind: from a player standing
        // 120 units off a door, the only direction with 260 units of room is
        // backwards. Placing them a safe distance *along the normal* means the
        // constraint is met before the lateral spread is even chosen, so the
        // spread stays free and every one of them is in front.
        //
        // At the shipped gate that lands them around x 3960 — inside the barrier
        // itself. They are not arriving near the door, they are coming out of it.
        const depth = TUNABLE.spawnSafeRadius + 20 + this.rng.range(0, 60);
        // Clamped into the doorway itself, so they are always emerging from the
        // gap rather than hovering in front of it — and so the seal exception
        // below stays exactly as wide as the barrier and no wider.
        const n = clamp(pn + through * depth, cn - halfN, cn + halfN);
        const l = cl + this.rng.range(-1, 1) * (halfL + spread * 0.5);
        ox = clamp(normalX ? n : l, 40, this.arena.width - 40);
        oy = clamp(normalX ? l : n, 40, this.arena.height - 40);
        const pour = parcel.stream ? (i / count) * parcel.stream : 0;
        // The doorway is sealed ground — it is between the rooms, not inside
        // either — so the siege has to be told it may use its own door. Padded
        // laterally by the spread, never along the normal: the room behind is
        // still off limits.
        const pad = spread;
        const gap = normalX
          ? { x: door.x, y: door.y - pad, w: door.w, h: door.h + pad * 2 }
          : { x: door.x - pad, y: door.y, w: door.w + pad * 2, h: door.h };
        // Jitter is already in the placement above; passing it again would drag
        // them back inside the radius and hand the problem to the radial push.
        this.queueSpawn(entry.enemy, ox, oy, 0, delay + pour, via, true, true, gap);
        continue;
      }
      if (parcel.ring) {
        // A ring around the call site: the *place* waking up, which is what a
        // Cache and a gate both want — you are standing in the middle of it.
        const a = (i / count) * Math.PI * 2 + this.rng.next() * 0.4;
        const r = this.rng.range(parcel.ring[0], parcel.ring[1]);
        ox = clamp(cx + pcos(a) * r, 40, this.arena.width - 40);
        oy = clamp(cy + psin(a) * r, 40, this.arena.height - 40);
        // §21b.6 — a gate sits on a boundary, so a ring around one straddles
        // ground the player has not opened, and `queueSpawn` drops anything
        // landing there. Measured at a gate siege: about a quarter of every
        // parcel is discarded this way. That is left as it is — nothing may
        // arrive out of a sealed room, and the alternative is a wave walking
        // through the door it is defending — but it means a siege delivers
        // roughly three quarters of what the wave lab reports, and the lab is
        // the honest number for a ring in open ground.
      } else {
        // No ring: the director's own off-screen origins. A Beacon calls the
        // horde in from where the horde comes from; it does not conjure one.
        const origin = this.pickSpawnOrigin();
        ox = origin.x;
        oy = origin.y;
      }
      this.queueSpawn(entry.enemy, ox, oy, spread, delay, via);
    }
    return count;
  }

  /**
   * §12.5 — the ambient chain: this room, at the Threat the run has earned.
   *
   * The director's default, and the shape every other wave is a variation on.
   * Worth reading next to `waveevents.json`: the ambient flow *is* a wave event
   * whose parcel schedule happens to be "continuously", and writing it in the
   * same vocabulary is what makes the special ones tunable against it.
   */
  private ambientVia(enriched = false): WaveTransform[] {
    const via: WaveTransform[] = [...this.rosterVia(this.currentLevel)];
    via.push({ op: 'escalate', mode: 'roll' });
    if (enriched) via.push({ op: 'enrich' });
    return via;
  }

  /** §12.5 — resolve a room into the transform that speaks for it. */
  private rosterVia(level: LevelDef | null | undefined): WaveTransform[] {
    const roster = level?.roster;
    if (!roster) return [];
    const step: WaveTransform = {
      op: 'roster',
      tier: roster.tier,
      families: roster.families,
      events: roster.events?.map((e) => e.id),
    };
    if (roster.threatCap !== undefined) step.cap = roster.threatCap;
    return [step];
  }

  /** Place one spawn around an origin and queue it to arrive after `delay`. */
  private queueSpawn(
    enemy: string,
    ox: number,
    oy: number,
    spread: number,
    delay: number,
    /**
     * §12.5 — what this enemy becomes. One chain replaced three booleans and
     * three hardcoded method calls; the director passes `ambientVia()` and a
     * called wave passes whatever its event and its caller resolved.
     */
    via: readonly WaveTransform[],
    /**
     * §12.2 — let this one be seen arriving.
     *
     * "Spawns arrive off-screen" is presentation: it stops things blinking into
     * existence in front of you. A siege pouring through a door you are standing
     * at is the one case where watching them come *is* the effect, and pushing
     * them off-screen first means they appear behind the wall and walk back.
     *
     * The safe radius is not waived and never is — §12.2's "no spawn-on-top-of
     * -player, ever" is a guarantee rather than a preference.
     */
    visible = false,
    /**
     * §21b.7 — queued by a siege, and therefore cancelled when the gate opens.
     *
     * The siege *is* the hold. Streaming a parcel over three seconds means the
     * last one can still be pouring when the bar completes, which is a smaller
     * version of the bug that was reported as "AFTER the gate opened, a TON kept
     * spawning" — and a guarantee is worth more here than a schedule that
     * happens to fit, because the schedule lives in data and will be edited.
     */
    siege = false,
    /**
     * §21b.6 — ground this particular wave is allowed to use, sealed or not.
     *
     * `isSealed` is "not inside an unlocked room", which is the right rule and
     * deliberately includes the corridor: enemies must not appear in a room the
     * player has not opened. It also includes the *doorway*, and a siege pouring
     * out of a doorway is the one wave whose whole point is to start there —
     * with the seal test refusing it, `queueSpawn`'s mirror retry reflected each
     * arrival through the player and dropped it behind them, which is precisely
     * the death trap that was reported.
     *
     * So the exception is a rectangle, supplied by the caller that owns it, and
     * it is the gate's own barrier — never the room behind it.
     */
    allowIn?: { x: number; y: number; w: number; h: number },
  ): void {
    if (this.pendingSpawns.length >= SAFETY.maxEntities) return;

    // §11.2 — a hard ceiling on live suppression, counted in *fields* rather
    // than in enemies. A Suppressor switches your Engine off; three of them
    // drifting through the same quarter of the arena is not three times the
    // pressure, it is a region of the map where the game stops. The template
    // rolls are free to keep asking; past the cap the ask is dropped and the
    // director makes the density up with something that can be shot at.
    // §21b — the room's own cap on its punctuation.
    //
    // `RosterDef.events[].maxAlive` has been documented as "each with its own
    // live cap" since levels were added and read by absolutely nothing: the only
    // ceiling that existed was one global number for Suppressors, arena-wide.
    // The Heap declaring `maxAlive: 2` and The Sink declaring `3` were
    // decoration. This is the first time a room can say how much of its own
    // punctuation it wants, which is the dial the next arenas need.
    //
    // The global Suppressor cap stays as the backstop for arenas with no levels.
    if (this.suppressorCount() >= TUNABLE.suppressorsAlive && this.projectsZone(enemy)) return;
    const eventCap = this.currentLevel?.roster.events?.find((ev) => ev.id === enemy);
    if (eventCap && this.countAlive(enemy) >= eventCap.maxAlive) return;

    const recipe = this.applyVia(enemy, via);
    enemy = recipe.enemy;
    const rx = ox + this.rng.range(-spread, spread);
    const ry = oy + this.rng.range(-spread, spread);
    // Spread can drag a cluster member back into view; push it out again before
    // the hard no-spawn-on-player guarantee. Unless it is meant to be seen.
    const hidden = visible ? { x: rx, y: ry } : this.pushOutsideView(rx, ry);
    const safe = this.pushOutsideSafeRadius(hidden.x, hidden.y);
    // §21b.6 — nothing arrives in ground the player has not opened.
    //
    // Clamped *before* the test, not after. Testing the raw point and clamping
    // the stored one meant an out-of-arena point passed the check — nothing out
    // there is inside a locked level — and then landed wherever the clamp put
    // it, which is an arena corner and possibly a room the player cannot reach.
    let sx = clamp(safe.x, 20, this.arena.width - 20);
    let sy = clamp(safe.y, 20, this.arena.height - 20);
    const permitted =
      allowIn !== undefined &&
      sx >= allowIn.x &&
      sx <= allowIn.x + allowIn.w &&
      sy >= allowIn.y &&
      sy <= allowIn.y + allowIn.h;
    if (!permitted && this.isSealed(sx, sy)) {
      // One deterministic retry, reflected through the player.
      //
      // A gate sits on a boundary, so a ring drawn around one puts half its
      // arrivals in the room behind the door — measured at a siege, a hundred
      // and sixty of them dropped on the floor. Refusing them silently makes a
      // wave weaker than its own data says, which is the worst kind of balance
      // bug: the lab reports one number and the fight is another.
      //
      // The player's own position is open by definition, so the mirrored point
      // almost always is too. No extra RNG draw, so the stream is untouched.
      const mx = clamp(2 * this.player.x - sx, 20, this.arena.width - 20);
      const my = clamp(2 * this.player.y - sy, 20, this.arena.height - 20);
      if (this.isSealed(mx, my)) return;
      sx = mx;
      sy = my;
    }
    this.pendingSpawns.push({
      time: this.time + delay,
      enemy,
      x: sx,
      y: sy,
      hue: this.rng.pick(HUES),
      enriched: recipe.enriched,
      affixes: recipe.affixes,
      affixExclude: recipe.affixExclude,
      visible,
      siege,
      hpScale: recipe.hpScale,
      damageScale: recipe.damageScale,
      alive: true,
    });
  }

  /**
   * §12.2 — "No spawn-on-top-of-player, ever." Wave templates place enemies with
   * a spread around an edge origin, and a player hugging that edge can otherwise
   * end up inside the cluster. Rather than reroll (which would be unbounded and
   * seed-sensitive), push the point radially away from the player to the safe
   * distance: deterministic, single-pass, and preserves the template's shape.
   */
  /** Push a point out past the nominal view rectangle, if it falls inside it. */
  private pushOutsideView(x: number, y: number): { x: number; y: number } {
    const halfW = TUNABLE.nominalViewWidth / 2;
    const halfH = TUNABLE.nominalViewHeight / 2;
    const dx = x - this.player.x;
    const dy = y - this.player.y;
    if (Math.abs(dx) > halfW || Math.abs(dy) > halfH) return { x, y };

    // The *smallest* scale that clears either edge, not the largest.
    //
    // This was `Math.max`, which insists the point clear *both* axes — and for a
    // spawn roughly level with the player that means dividing by a guard
    // constant: with dy at zero, `halfH / 1e-3` is four hundred and seventy-seven
    // thousand. The point was flung a quarter of a billion units away, sailed
    // through the sealed test because nothing that far out is inside any level,
    // and was then clamped to the arena edge — which is inside the next room.
    //
    // That is the whole of "enemies spawn in the next level": not the director,
    // not the gate, a `max` that should always have been a `min`.
    const scale =
      Math.min(halfW / Math.max(1e-3, Math.abs(dx)), halfH / Math.max(1e-3, Math.abs(dy))) * 1.06;
    return { x: this.player.x + dx * scale, y: this.player.y + dy * scale };
  }

  private pushOutsideSafeRadius(x: number, y: number): { x: number; y: number } {
    const dx = x - this.player.x;
    const dy = y - this.player.y;
    const d = hypot(dx, dy);
    const min = TUNABLE.spawnSafeRadius;
    if (d >= min) return { x, y };
    // Degenerate case: spawn point exactly on the player — push along facing.
    const ux = d > 0.001 ? dx / d : -this.player.dirX;
    const uy = d > 0.001 ? dy / d : -this.player.dirY;
    return { x: this.player.x + ux * min, y: this.player.y + uy * min };
  }

  // ------------------------------------------------------------------ spawning

  /**
   * `hue` is accepted and ignored — it is the enemy's threat class now, and a
   * wave does not get to recolour what a Charger is. The parameter stays so
   * every caller keeps compiling and so a Splitter's children still read as
   * inheriting from their parent, which they do: they are the same enemy.
   */
  spawnEnemy(defId: string, x: number, y: number, _hue?: Hue): Enemy | null {
    if (this.enemies.length >= SAFETY.maxEntities) return null;
    const def = ENEMY_BY_ID.get(defId);
    if (!def) throw new Error(`Unknown enemy "${defId}"`);
    const e: Enemy = {
      id: this.nextId++,
      defId,
      hue: def.hue,
      x,
      y,
      vx: 0,
      vy: 0,
      hp: def.hp,
      maxHp: def.hp,
      radius: def.radius,
      state: 'seek',
      timer: def.windup !== undefined ? 0.5 : 0,
      aimX: 0,
      aimY: 0,
      flash: 0,
      spawnAge: 0,
      enriched: false,
      affixes: [],
      traits: [],
      steers: false,
      phased: false,
      facing: 0,
      meals: 0,
      beamTimer: def.windup ?? 0,
      beamActive: 0,
      wobble: this.rng.next() * Math.PI * 2,
      speedScale: this.rng.range(1 - TUNABLE.speedVariance, 1 + TUNABLE.speedVariance),
      shoveBudget: TUNABLE.shoveBudgetPerSecond,
      shoveWindow: 1,
      alive: true,
    };

    // §10.3 — Wardens always roll affixes; in Meltdown they are standard on
    // everything substantial (§13.2). Traits are resolved after, because an
    // affix is a trait and the list has to include it.
    const eliteRoll =
      def.elite === true || (this.phase === 'meltdown' && def.hp >= 20 && this.rng.chance(0.25));
    if (eliteRoll) {
      const pool = this.affixPool();
      const count = def.elite === true ? 1 + this.rng.int(2) : 1;
      for (let i = 0; i < count; i++) {
        const pick = pool[this.rng.int(pool.length)]!;
        if (!e.affixes.includes(pick)) e.affixes.push(pick);
      }
    }
    this.resolveTraits(e);

    this.enemies.push(e);
    return e;
  }

  private dropPickup(kind: PickupKind, x: number, y: number, hue: Hue, value: number): void {
    if (value <= 0) return;
    if (this.pickups.length >= SAFETY.maxEntities) return;
    const a = this.rng.next() * Math.PI * 2;
    const s = this.rng.range(20, 70);
    this.pickups.push({
      id: this.nextId++,
      kind,
      hue,
      value,
      x,
      y,
      vx: pcos(a) * s,
      vy: psin(a) * s,
      age: 0,
      alive: true,
    });
  }

  // ---------------------------------------------------------------- progression

  private gainXp(amount: number): void {
    // §9.1 — the rebuild surge doubles XP for 120s after a Recompile.
    const surge = this.surgeTime > 0 ? TUNABLE.rebuildSurgeXpMult : 1;
    this.xp += amount * TUNABLE.xpPerShard * surge;
    while (this.xp >= this.xpToNext) {
      this.xp -= this.xpToNext;
      this.level++;
      this.cue('level', 'voltaic', 0, 1);
      this.mark('level', `level ${this.level}`);
      // level 2 costs xpBase, and the curve compounds from there. Level 1's cost
      // was set separately in the constructor.
      this.xpToNext = Math.ceil(TUNABLE.xpBase * ppow(TUNABLE.xpGrowth, this.level - 2));
      if (this.stats.firstLevelTime === 0) this.stats.firstLevelTime = this.time;
      if (this.pendingDrafts < TUNABLE.maxQueuedDrafts) this.pendingDrafts++;
    }
  }

  /** Called by the draft layer once a card is applied, so static load stays in sync. */
  syncBudget(): void {
    this.budget.setStaticLoad(this.engine.staticLoad);
    // §6.1 Capacitor — capacity for rows you have *not* filled. A stat that pays
    // you for restraint, and the only card in the game that gets worse as you
    // build, which makes taking it a real read on where the run is going.
    const empty = this.engine.programs.filter((_, i) => !this.engine.compiled[i]?.live).length;
    this.budget.capacity = this.baseCapacity + this.bonuses.capacitor * empty;
  }

  /**
   * §13.3 — the final score.
   *
   *   Score = ∫EPS × Meltdown multiplier (peak)
   *         + Mirror kills × 500
   *         + Kernel count × 250
   *         + Discovery bonuses
   *
   * ∫EPS already has the multiplier folded in as it accrued, so peak multiplier
   * is reported rather than applied twice. Discoveries and the Mirror do not
   * exist yet and contribute zero.
   */
  finalScore(): {
    total: number;
    output: number;
    kernelBonus: number;
    mirrorBonus: number;
    multiplier: number;
  } {
    const output = Math.floor(this.score);
    const kernelBonus = this.kernels * TUNABLE.scorePerKernel;
    const mirrorBonus = 0;
    return {
      total: output + kernelBonus + mirrorBonus,
      output,
      kernelBonus,
      mirrorBonus,
      multiplier: this.peakMeltdownMultiplier,
    };
  }

  // ------------------------------------------------------------------ plumbing

  private countEvent(): void {
    this.eventsThisTick++;
    this.stats.events++;
  }

  private updateScore(dt: number): void {
    this.epsWindow.push(this.eventsThisTick);
    this.epsWindowSum += this.eventsThisTick;
    if (this.epsWindow.length > this.epsWindowSize) {
      this.epsWindowSum -= this.epsWindow.shift()!;
    }
    this.eps = this.epsWindowSum / (this.epsWindow.length * SIM_DT);
    if (this.eps > this.stats.peakEps) this.stats.peakEps = this.eps;
    // §9.1 — recent average output of the live Engine. Decays when the Engine
    // goes quiet, which is what makes Recompile timing a decision.
    const outputDecay = ppow(0.5, dt / TUNABLE.kernelAverageHalfLife);
    this.outputAverage = this.outputAverage * outputDecay + this.eps * (1 - outputDecay);
    this.peakOutputAverage = Math.max(this.peakOutputAverage, this.outputAverage);
    if (this.enemies.length > this.stats.peakConcurrentEnemies) {
      this.stats.peakConcurrentEnemies = this.enemies.length;
    }
    // §13.1 — score is the integral of EPS over the run, and §13.2 scales it by
    // the Meltdown multiplier as it accrues.
    this.score += this.eps * dt * this.meltdownMultiplier;

    // §14 — sample the run-trace chart.
    this.traceTimer += dt;
    if (this.traceTimer >= TUNABLE.epsTraceInterval) {
      // Subtract rather than reset, so sampling cannot drift over a 25-minute run.
      this.traceTimer -= TUNABLE.epsTraceInterval;
      if (this.trace.length < 4000) this.trace.push({ t: this.time, eps: this.eps });
    }

    // Per-row EPS attribution for the editor readout (§19.6): an exponential
    // moving average with a 2s half-life, so "share of total EPS" reacts fast
    // enough that a player can see a row go dead.
    const decay = ppow(0.5, dt / 2);
    for (const p of this.engine.programs) {
      p.recentEvents = p.recentEvents * decay + (p.tickEvents / dt) * (1 - decay);
      p.recentDamage = p.recentDamage * decay + (p.tickDamage / dt) * (1 - decay);
      p.tickDamage = 0;
      p.tickEvents = 0;
    }
  }

  private compact(): void {
    compactInPlace(this.enemies);
    compactInPlace(this.projectiles);
    compactInPlace(this.pickups);
    compactInPlace(this.zones);
    compactInPlace(this.mines);
    compactInPlace(this.orbitals);
    compactInPlace(this.terminals);
    compactInPlace(this.containment);
    compactInPlace(this.fx);
  }
}

function compactInPlace<T extends { alive: boolean }>(arr: T[]): void {
  let w = 0;
  for (let r = 0; r < arr.length; r++) {
    const item = arr[r]!;
    if (item.alive) arr[w++] = item;
  }
  arr.length = w;
}



/** Shortest signed distance between two angles, in radians. */
function angleDelta(a: number, b: number): number {
  let d = (a - b) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

export type { Program };
export type { EventType };

