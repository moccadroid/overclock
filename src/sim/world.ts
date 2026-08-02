/**
 * The World: one run's complete simulation state and its fixed-step update.
 *
 * Determinism contract (GDD §0):
 *   - advance() is called at a fixed SIM_DT; nothing here reads wall-clock time.
 *   - every random draw comes from `this.rng`.
 *   - iteration order over entities is stable (order-preserving compaction).
 * A given (seed, axiom, input sequence) reproduces bit-for-bit. See world.test.ts.
 */
import { Rng } from './rng';
import { SpatialGrid, type SpatialItem } from './spatial';
import { FlowField } from './flowfield';
import { CycleBudget } from './cycles';
import { DiscoveryTracker } from './discoveries';
import { Engine, type FireContext, type Program } from './engine';
import { LOADBEARING, SAFETY, SIM_DT, TUNABLE } from './tunables';
import {
  HUES,
  type ActionDef,
  type ArenaDef,
  type AxiomDef,
  type EnemyDef,
  type EventType,
  type GameEvent,
  type Hue,
  type WaveTemplateDef,
} from './types';
import {
  ACTION_BY_ID,
  ENEMY_BY_ID,
  TRIGGER_BY_ID,
  WAVES,
  arena as getArena,
  axiom as getAxiom,
  enemy as getEnemy,
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
  /** Adaptive affix: personal, per-hue resistance that climbs as it is hit. */
  adaptive: Record<Hue, number>;
  /** Phasing affix: currently untargetable. */
  phased: boolean;
  /** Facing, for the Bulwark's shield arc and the Lancer's beam. */
  facing: number;
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
export type EliteAffix = 'adaptive' | 'volatile' | 'phasing' | 'anchored';

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
  /** Siphon — fuel stolen from the target's hue on hit. */
  siphon: number;
}

export type PickupKind = 'fuel' | 'xp';

export interface Pickup extends SpatialItem {
  id: number;
  kind: PickupKind;
  hue: Hue;
  value: number;
  vx: number;
  vy: number;
  age: number;
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
export type TerminalKind = 'beacon' | 'recompile' | 'extract';

export interface Terminal extends SpatialItem {
  id: number;
  kind: TerminalKind;
  /** 0..1 channel progress. Decays if the player leaves or stops holding. */
  progress: number;
  age: number;
  channelTime: number;
  /** §9.1 — Recompile must be channelled while stationary. */
  requiresStillness: boolean;
}

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
  /** Discoveries already in the Library, so a repeat does not re-announce. */
  knownDiscoveries?: ReadonlySet<string>;
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

export type TraceMarkerKind = 'level' | 'recompile' | 'meltdown' | 'extract' | 'death' | 'beacon';

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
  damageTaken: number;
  beaconsChannelled: number;
  converts: number;
  crits: number;
  /** Seconds spent in each Heat tier — the instrument for tuning §6.3. */
  tierSeconds: [number, number, number, number];
  /** Total Cycles the engine asked for. Compare against capacity x time. */
  cyclesSpent: number;
  /** Kills per enemy id. Feeds Discoveries and the Results breakdown. */
  killsByEnemy: Map<string, number>;
  /** Kills landed while a Suppressor had your Triggers offline (§11.2). */
  suppressedKills: number;
  /** Conversions that spent Integrity you could not spare (§7.4). */
  desperateConverts: number;
  peakHeat: number;
  /** Seconds until the first level-up — §3's "a decision every ~30 seconds". */
  firstLevelTime: number;
  /** Times a runtime safety valve fired. Non-zero means investigate, not tune. */
  safetyTrips: number;
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

  fuel: Record<Hue, number> = { thermal: 0, voltaic: 0, void: 0 };
  /**
   * Fuel spent and gained per second, per hue, smoothed.
   *
   * Without these the economy is opaque: a gauge pinned at zero looks broken
   * when it actually means "your engine is burning this exactly as fast as it
   * arrives", and a gauge sitting full looks healthy when it actually means
   * "nothing you own can spend this".
   */
  fuelBurn: Record<Hue, number> = { thermal: 0, voltaic: 0, void: 0 };
  fuelGain: Record<Hue, number> = { thermal: 0, voltaic: 0, void: 0 };
  private fuelBurnTick: Record<Hue, number> = { thermal: 0, voltaic: 0, void: 0 };
  private fuelGainTick: Record<Hue, number> = { thermal: 0, voltaic: 0, void: 0 };

  /** §11.1 — smoothed damage dealt per hue, the basis of adaptive resistance. */
  private damageByHue: Record<Hue, number> = { thermal: 0, voltaic: 0, void: 0 };
  /** Current resistance per hue, 0..cap. Always visible in the HUD (§19.4). */
  resistance: Record<Hue, number> = { thermal: 0, voltaic: 0, void: 0 };
  xp = 0;
  xpToNext: number;
  level = 1;
  /** §19.4 — drafts queue up to 3. */
  pendingDrafts = 0;
  rerolls = TUNABLE.rerollsPerRun;
  purges = TUNABLE.purgesPerRun;
  /** Node ids removed from this run's pool by Purge (§8.3). */
  purged = new Set<string>();
  /** §8.2 — accumulated stat-card bonuses. Deliberately small and boring. */
  bonuses = { crit: 0, magnet: 0, speed: 0, power: 0 };
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
  beaconTimer = 20;
  recompileTimer = 0;
  wardenTimer: number = TUNABLE.wardenInterval;
  containmentTimer: number = TUNABLE.containmentFirstDelay;
  score = 0;
  eps = 0;
  /** Smoothed Cycles/sec the engine is drawing. Shown against capacity (§6). */
  demandAverage = 0;
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
    damageTaken: 0,
    beaconsChannelled: 0,
    converts: 0,
    crits: 0,
    tierSeconds: [0, 0, 0, 0],
    cyclesSpent: 0,
    killsByEnemy: new Map(),
    suppressedKills: 0,
    desperateConverts: 0,
    peakHeat: 0,
    firstLevelTime: 0,
    safetyTrips: 0,
  };

  /** Rolling window of per-tick event counts for the 5s EPS smoothing (§13.1). */
  private epsWindow: number[] = [];
  private epsWindowSum = 0;
  private readonly epsWindowSize = Math.round(TUNABLE.epsSmoothingWindow / SIM_DT);

  private eventQueue: GameEvent[] = [];
  private scheduled: ScheduledFire[] = [];
  private pendingSpawns: PendingSpawn[] = [];
  private grid: SpatialGrid<Enemy>;
  private flow: FlowField;
  private readonly flowSample = { x: 0, y: 0 };
  private nextId = 1;
  private eventsThisTick = 0;
  /** §23.1 — Lancers currently mid-telegraph. Recounted each tick. */
  private chargingLancers = 0;

  constructor(config: RunConfig) {
    this.config = config;
    this.discoveries = new DiscoveryTracker(config.knownDiscoveries);
    this.rng = new Rng(config.seed);
    this.arena = getArena(config.arenaId ?? 'heap');
    this.grid = new SpatialGrid<Enemy>(this.arena.width, this.arena.height);
    this.flow = new FlowField(this.arena);

    this.engine = new Engine();
    this.installAxiomStarter();

    this.budget = new CycleBudget(
      TUNABLE.cycleCapacityBase + getAxiom(config.axiomId).capacityDelta,
    );
    this.budget.setStaticLoad(this.engine.staticLoad);

    this.player = {
      x: this.arena.spawnX,
      y: this.arena.spawnY,
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
      alive: true,
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
    this.grid.rebuild(this.enemies);
    this.updateProjectiles(dt);
    this.updateZones(dt);
    this.updateMines(dt);
    this.updateOrbitals(dt);
    this.releasePendingBursts();
    this.updatePickups(dt);
    this.consolidatePickups(dt);
    this.updateFx(dt);
    this.updateTerminals(input, dt);
    this.updateMeltdown(dt);
    this.updateDirector(dt);
    if (this.surgeTime > 0) this.surgeTime = Math.max(0, this.surgeTime - dt);
    this.surgeRateTime = Math.max(0, this.surgeRateTime - dt);
    if (this.surgeRateTime <= 0) this.surgeRate = 0;

    // §11.2 — inside a Suppressor's zone the player's Triggers do not fire.
    // Actions already in flight resolve; nothing new starts.
    this.suppressedNow = this.suppressed;

    if (!this.budget.stalled) {
      if (!this.suppressedNow) this.advanceClocks(dt);
      this.runScheduled();
      this.drainEvents();
    }

    if (this.budget.endTick(dt)) {
      this.stats.overheats++;
      this.emit({ type: 'overheat', depth: 0, x: this.player.x, y: this.player.y });
      if (!this.budget.stalled) this.drainEvents();
    }

    const fuelDecay = Math.pow(0.5, dt / 1.5);
    for (const hue of HUES) {
      this.fuelBurn[hue] =
        this.fuelBurn[hue] * fuelDecay + (this.fuelBurnTick[hue] / dt) * (1 - fuelDecay);
      this.fuelGain[hue] =
        this.fuelGain[hue] * fuelDecay + (this.fuelGainTick[hue] / dt) * (1 - fuelDecay);
      this.fuelBurnTick[hue] = 0;
      this.fuelGainTick[hue] = 0;
    }

    this.updateResistance(dt);
    this.stats.tierSeconds[this.budget.tier] += dt;
    this.stats.cyclesSpent += this.budget.spentThisTick;
    // Smoothed so the HUD can show a stable "you are drawing X/sec" rather than
    // a per-tick number that flickers too fast to read.
    const demandDecay = Math.pow(0.5, dt / 0.5);
    this.demandAverage =
      this.demandAverage * demandDecay + this.budget.demandPerSecond(dt) * (1 - demandDecay);
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
      if (!compiled.live || compiled.interval <= 0) continue;
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

    // §23.1 pricing: the deeper into a cascade this fire is, the more it costs.
    this.budget.spend(compiled.cycleCost * (1 + depth * TUNABLE.cascadeCostGrowth));

    if (this.budget.rollMisfire(this.rng)) {
      this.stats.misfires++;
      return;
    }

    program.fireCount++;
    program.tickEvents++;
    this.stats.fires++;

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

    // §7.4 — Convert exchanges resources instead of dealing damage.
    if (def.primitive === 'convert') {
      for (let n = 0; n < instances; n++) this.runConvert(def, depth);
      return;
    }

    // §5.5 Attune — the Action's hue shifts to your fullest gauge, which is the
    // clean answer to adaptive resistance for a mono-hue engine.
    const hue = compiled.ctx.attune > 0 ? this.fullestHue() : def.hue;

    // Actions happen where the triggering event happened, unless they say
    // otherwise — see ActionDef.origin. This is what lets a cascade travel.
    const atPlayer = def.origin === 'player';
    const ox = atPlayer ? this.player.x : x;
    const oy = atPlayer ? this.player.y : y;

    for (let n = 0; n < instances; n++) {
      // §7.2 — fuelled fire consumes 1 fuel of the Action's hue for +50% output.
      let fuelBonus = 1;
      if (this.fuel[hue] >= 1) {
        this.fuel[hue] -= 1;
        this.fuelBurnTick[hue] += 1;
        fuelBonus = 1 + TUNABLE.fueledFireOutputBonus;
      }
      // ...and pays less. Together these let a cascade run wild near its source
      // and run out of steam as it travels, rather than being cut off.
      const depthFalloff = Math.pow(TUNABLE.cascadeOutputFalloff, depth);
      const output =
        compiled.ctx.output *
        outputMul *
        fuelBonus *
        depthFalloff *
        this.engine.globalOutput *
        (1 + this.bonuses.power);
      const damage = def.damage * output;
      const corrupted =
        this.budget.corruptionChance > 0 && this.rng.chance(this.budget.corruptionChance);

      switch (def.primitive) {
        case 'projectile':
          this.spawnProjectile(def.id, damage, depth, index, ox, oy, compiled.ctx, corrupted, hue);
          break;
        case 'burst':
          this.doBurst(def.id, damage, depth, index, ox, oy, compiled.ctx.area, hue, compiled.ctx.leech);
          break;
        case 'chain':
          this.doChain(def.id, damage, depth, index, ox, oy, hue, compiled.ctx.leech);
          break;
        case 'zone':
        case 'vortex':
          this.dropZone(
            def.id,
            damage,
            depth,
            index,
            ox,
            oy,
            compiled.ctx.area,
            compiled.ctx.duration,
            hue,
          );
          break;
        case 'mine':
          this.dropMine(def, damage, depth, index, compiled.ctx, hue);
          break;
        case 'delayed':
          this.markRupture(def, damage, depth, index, ox, oy, compiled.ctx, hue);
          break;
        case 'beam':
          this.fireBeam(def, damage, depth, index, ox, oy, compiled.ctx, hue);
          break;
        case 'orbital':
          this.addOrbital(def, damage, depth, index, compiled.ctx, hue);
          break;
        case 'buff':
          this.applySurge(def, compiled.ctx);
          break;
        case 'knockback':
          this.doShove(def, damage, depth, index, ox, oy, compiled.ctx, hue);
          break;
      }
    }
  }

  // ------------------------------------------------------------------ actions

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
  ): void {
    if (this.projectiles.length >= SAFETY.maxEntities) return;
    const def = ACTION_BY_ID.get(actionId)!;
    const target = this.grid.nearest(x, y);
    let dx: number;
    let dy: number;
    if (target) {
      dx = target.x - x;
      dy = target.y - y;
      const len = Math.hypot(dx, dy) || 1;
      dx /= len;
      dy /= len;
    } else {
      // No target: fire along facing so the engine is never silently idle (§17.3).
      dx = this.player.dirX;
      dy = this.player.dirY;
    }
    const speed = def.speed ?? 400;
    this.projectiles.push({
      id: this.nextId++,
      x,
      y,
      vx: dx * speed,
      vy: dy * speed,
      life: def.lifetime ?? 2,
      damage,
      pierce: (def.pierce ?? 0) + Math.round(ctx.pierce),
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
      seek: def.seek ?? 0,
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
  ): void {
    const def = ACTION_BY_ID.get(actionId)!;
    const radius = (def.radius ?? 100) * Math.max(0.1, area);
    this.grid.queryRadius(x, y, radius, (enemy) => {
      this.damageEnemy(enemy, damage, depth, programIndex, hue, leech);
    });
    this.pushFx('burst', hue, x, y, radius, [], 0.22);
  }

  private doChain(
    actionId: string,
    damage: number,
    depth: number,
    programIndex: number,
    x: number,
    y: number,
    hue: Hue,
    leech = 0,
  ): void {
    const def = ACTION_BY_ID.get(actionId)!;
    const jumps = def.jumps ?? 3;
    const range = def.range ?? 200;
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
      leech: 0,
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
    const life = (def.lifetime ?? 8) * Math.max(0.1, ctx.duration);
    this.mines.push({
      id: this.nextId++,
      hue,
      x: this.player.x,
      y: this.player.y,
      damage,
      radius: (def.radius ?? 100) * Math.max(0.1, ctx.area),
      triggerRadius: (def.triggerRadius ?? 44) * Math.max(0.1, ctx.area),
      arm: def.armTime ?? 0.3,
      life,
      maxLife: life,
      depth,
      programIndex,
      leech: ctx.leech,
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
    const radius = (def.radius ?? 120) * Math.max(0.1, ctx.area);
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
    const range = def.range ?? 800;
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
    const angle = far ? Math.atan2(far.y - y, far.x - x) : Math.atan2(this.player.dirY, this.player.dirX);
    const ux = Math.cos(angle);
    const uy = Math.sin(angle);
    const width = (def.beamWidth ?? 12) * Math.max(0.1, ctx.area);

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
    const life = (def.lifetime ?? 12) * Math.max(0.1, ctx.duration);
    this.orbitals.push({
      id: this.nextId++,
      hue,
      x: this.player.x,
      y: this.player.y,
      damage,
      radius: (def.radius ?? 12) * Math.max(0.1, ctx.area),
      orbitRadius: (def.orbitRadius ?? 110) * Math.max(0.1, ctx.area),
      orbitSpeed: def.orbitSpeed ?? 2.2,
      angle: this.rng.next() * Math.PI * 2,
      life,
      maxLife: life,
      depth,
      programIndex,
      leech: ctx.leech,
      cooldowns: new Map(),
      alive: true,
    });
  }

  /** §5.4 Surge — a short self-buff on the engine's own rate. */
  private applySurge(def: ActionDef, ctx: FireContext): void {
    this.surgeRate = Math.max(this.surgeRate, def.rateBonus ?? 0.4);
    this.surgeRateTime = Math.max(
      this.surgeRateTime,
      (def.lifetime ?? 2) * Math.max(0.1, ctx.duration),
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
    const radius = (def.radius ?? 180) * Math.max(0.1, ctx.area);
    const impulse = def.knockback ?? 240;
    this.grid.queryRadius(x, y, radius, (enemy) => {
      const dx = enemy.x - x;
      const dy = enemy.y - y;
      const d = Math.hypot(dx, dy) || 1;
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

  private updateMines(dt: number): void {
    for (const m of this.mines) {
      if (!m.alive) continue;
      m.arm = Math.max(0, m.arm - dt);
      m.life -= dt;
      if (m.life <= 0) {
        m.alive = false;
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
        continue;
      }
      o.angle += o.orbitSpeed * dt;
      o.x = this.player.x + Math.cos(o.angle) * o.orbitRadius;
      o.y = this.player.y + Math.sin(o.angle) * o.orbitRadius;

      for (const [id, until] of o.cooldowns) {
        if (until <= this.time) o.cooldowns.delete(id);
      }
      this.grid.queryRadius(o.x, o.y, o.radius + 12, (enemy) => {
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
        continue;
      }
      // §5.4 Pull — a vortex drags everything toward its centre. Continuous, so
      // it is applied every tick rather than on the damage cadence.
      if (z.force > 0) {
        this.grid.queryRadius(z.x, z.y, z.radius, (enemy) => {
          const dx = z.x - enemy.x;
          const dy = z.y - enemy.y;
          const d = Math.hypot(dx, dy) || 1;
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

    const moving = Math.hypot(this.player.vx, this.player.vy) > 12;
    for (const t of this.terminals) {
      if (!t.alive) continue;
      t.age += dt;

      const near =
        Math.hypot(this.player.x - t.x, this.player.y - t.y) <
        TUNABLE.beaconRadius + TUNABLE.playerRadius;
      const channelling = near && input.interact && !(t.requiresStillness && moving);

      if (channelling) {
        t.progress += dt / t.channelTime;
        if (t.progress >= 1) {
          t.alive = false;
          this.completeTerminal(t);
        }
      } else if (t.progress > 0) {
        // Generous interrupt-resume: it drains rather than snapping to zero.
        t.progress = Math.max(0, t.progress - (dt / t.channelTime) * 0.6);
      }
    }
  }

  private spawnTerminals(dt: number): void {
    const count = (kind: TerminalKind): number =>
      this.terminals.reduce((n, t) => n + (t.alive && t.kind === kind ? 1 : 0), 0);

    this.beaconTimer -= dt;
    if (this.beaconTimer <= 0 && count('beacon') < TUNABLE.maxBeacons) {
      this.beaconTimer = TUNABLE.beaconInterval;
      const spot = this.findOpenSpot(TUNABLE.spawnRingMin * 0.5, TUNABLE.spawnRingMax);
      this.pushTerminal('beacon', spot.x, spot.y, TUNABLE.beaconChannelTime, false);
    }

    // §9.1 — Recompile terminals appear from minute 8.
    if (this.time >= TUNABLE.recompileFromTime) {
      this.recompileTimer -= dt;
      if (this.recompileTimer <= 0 && count('recompile') < 1) {
        this.recompileTimer = TUNABLE.recompileInterval;
        const spot = this.findOpenSpot(TUNABLE.spawnRingMin * 0.6, TUNABLE.spawnRingMax);
        this.pushTerminal('recompile', spot.x, spot.y, TUNABLE.recompileChannelTime, true);
      }
    }

    // §12.4 — one Extract terminal, at a fixed landmark, from minute 15.
    if (this.time >= TUNABLE.extractFromTime && count('extract') === 0) {
      this.pushTerminal(
        'extract',
        this.arena.extractX,
        this.arena.extractY,
        TUNABLE.extractChannelTime,
        false,
      );
    }
  }

  private pushTerminal(
    kind: TerminalKind,
    x: number,
    y: number,
    channelTime: number,
    requiresStillness: boolean,
  ): void {
    this.terminals.push({
      id: this.nextId++,
      kind,
      x,
      y,
      progress: 0,
      age: 0,
      channelTime,
      requiresStillness,
      alive: true,
    });
  }

  private completeTerminal(t: Terminal): void {
    if (t.kind === 'beacon') {
      this.stats.beaconsChannelled++;
      this.threat += TUNABLE.beaconThreatBump;
      this.spawnWave(true);
      this.mark('beacon', 'beacon');
      return;
    }
    if (t.kind === 'recompile') {
      // Does not fire immediately: the player chooses how much to sacrifice.
      this.pendingRecompileChoice = true;
      return;
    }
    // §12.4 — banked at ×1.0. No Meltdown multiplier ever applies.
    this.ending = 'extracted';
    this.player.alive = false;
    this.mark('extract', 'extracted');
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
    const total = live.reduce((s, p) => s + p.recentEvents, 0);
    const chosen = indices.filter((i) => this.engine.compiled[i]?.live);
    if (chosen.length === 0) return 0;
    if (total <= 0.01) return chosen.length / live.length;
    return chosen.reduce((s, i) => s + this.engine.programs[i]!.recentEvents, 0) / total;
  }

  /** What Kernel a given sacrifice would forge, for the selection UI. */
  kernelPreview(indices: readonly number[]): number {
    const share = this.outputShareOf(indices);
    if (share <= 0) return 0;
    // Super-linear in share, so committing beats nibbling — see the note on
    // TUNABLE.kernelShareExponent.
    const weight = Math.pow(share, TUNABLE.kernelShareExponent);
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
      p.tickEvents = 0;
    }
    this.engine.recompile();

    // If the whole Engine went, reboot to the Axiom rather than to nothing: an
    // Engine with no live Program earns no XP, so it can never rebuild itself.
    if (!this.engine.compiled.some((c) => c.live)) this.installAxiomStarter();

    this.engine.kernel *= 1 + percent / 100;
    this.engine.recompile();

    this.kernels++;
    this.budget.capacity += Math.round(TUNABLE.recompileCapacityGain * share);
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

  // --------------------------------------------------------------- meltdown

  /** §13.2 — at 20:00 the build phase ends. This is not a fail state, it is act three. */
  private updateMeltdown(dt: number): void {
    const meltdownAt = this.config.meltdownAt ?? TUNABLE.meltdownAt;
    if (this.phase === 'build') {
      if (this.time < meltdownAt) return;
      this.phase = 'meltdown';
      this.mark('meltdown', 'MELTDOWN');
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

      if (c.kind === 'sweeper') {
        c.x += c.dirX * TUNABLE.sweeperSpeed * dt;
        c.y += c.dirY * TUNABLE.sweeperSpeed * dt;
        if (armed) this.testSweeper(c);
      } else if (c.kind === 'cell') {
        const t = Math.min(1, Math.max(0, (c.age - c.telegraph) / TUNABLE.cellDuration));
        c.radius = TUNABLE.cellStartRadius + (TUNABLE.cellEndRadius - TUNABLE.cellStartRadius) * t;
        if (armed) this.testCell(c);
      } else {
        const t = Math.min(1, Math.max(0, (c.age - c.telegraph) / TUNABLE.nullFrontDuration));
        c.advance = TUNABLE.nullFrontDepth * Math.sin(t * Math.PI);
        if (armed) this.testNullFront(c);
      }
    }
  }

  private spawnContainment(): void {
    const kinds: ContainmentKind[] = ['sweeper', 'cell', 'nullfront'];
    const kind = this.rng.pick(kinds);
    const base = {
      id: this.nextId++,
      kind,
      age: 0,
      dirX: 0,
      dirY: 0,
      gapAt: 0,
      radius: 0,
      gapAngles: [] as number[],
      advance: 0,
      telegraph: 1.1,
      alive: true,
    };

    if (kind === 'sweeper') {
      // A wall crossing the whole arena with one gap. Positional test that
      // ignores DPS entirely — you cannot shoot your way out of geometry.
      const horizontal = this.rng.chance(0.5);
      const fromStart = this.rng.chance(0.5);
      const travel = horizontal ? this.arena.width : this.arena.height;
      this.containment.push({
        ...base,
        x: horizontal ? (fromStart ? -60 : this.arena.width + 60) : this.arena.width / 2,
        y: horizontal ? this.arena.height / 2 : fromStart ? -60 : this.arena.height + 60,
        dirX: horizontal ? (fromStart ? 1 : -1) : 0,
        dirY: horizontal ? 0 : fromStart ? 1 : -1,
        gapAt: this.rng.range(
          TUNABLE.sweeperGapWidth,
          (horizontal ? this.arena.height : this.arena.width) - TUNABLE.sweeperGapWidth,
        ),
        life: travel / TUNABLE.sweeperSpeed + 2.5,
        maxLife: travel / TUNABLE.sweeperSpeed + 2.5,
      });
      return;
    }

    if (kind === 'cell') {
      const gaps: number[] = [];
      for (let i = 0; i < TUNABLE.cellGaps; i++) {
        gaps.push(this.rng.next() * Math.PI * 2);
      }
      this.containment.push({
        ...base,
        x: this.player.x,
        y: this.player.y,
        radius: TUNABLE.cellStartRadius,
        gapAngles: gaps,
        telegraph: 1.4,
        life: TUNABLE.cellDuration + 2.4,
        maxLife: TUNABLE.cellDuration + 2.4,
      });
      return;
    }

    const horizontal = this.rng.chance(0.5);
    const fromStart = this.rng.chance(0.5);
    this.containment.push({
      ...base,
      x: horizontal ? (fromStart ? 0 : this.arena.width) : this.arena.width / 2,
      y: horizontal ? this.arena.height / 2 : fromStart ? 0 : this.arena.height,
      dirX: horizontal ? (fromStart ? 1 : -1) : 0,
      dirY: horizontal ? 0 : fromStart ? 1 : -1,
      life: TUNABLE.nullFrontDuration + 2.6,
      maxLife: TUNABLE.nullFrontDuration + 2.6,
    });
  }

  private testSweeper(c: Containment): void {
    const p = this.player;
    const along = c.dirX !== 0 ? p.y : p.x;
    const across = c.dirX !== 0 ? p.x - c.x : p.y - c.y;
    const inGap = Math.abs(along - c.gapAt) < TUNABLE.sweeperGapWidth / 2;
    if (!inGap && Math.abs(across) < 22 + TUNABLE.playerRadius) {
      this.hurtPlayer(TUNABLE.sweeperDamage, { id: 'sweeper', label: 'Sweeper', mode: 'containment' });
    }
  }

  private testCell(c: Containment): void {
    const p = this.player;
    const dx = p.x - c.x;
    const dy = p.y - c.y;
    const d = Math.hypot(dx, dy);
    if (Math.abs(d - c.radius) > 20 + TUNABLE.playerRadius) return;
    // Standing in one of the cage's gaps is how you get out.
    const angle = Math.atan2(dy, dx);
    for (const gap of c.gapAngles) {
      if (Math.abs(angleDelta(angle, gap)) < 0.34) return;
    }
    this.hurtPlayer(this.player.maxIntegrity * TUNABLE.cellDamagePercent, {
      id: 'cell',
      label: 'Containment Cell',
      mode: 'containment',
    });
  }

  /** §11.4 — shrinks the playable arena, forcing motion. */
  private testNullFront(c: Containment): void {
    const p = this.player;
    let inside = false;
    if (c.dirX > 0) inside = p.x < c.advance;
    else if (c.dirX < 0) inside = p.x > this.arena.width - c.advance;
    else if (c.dirY > 0) inside = p.y < c.advance;
    else inside = p.y > this.arena.height - c.advance;
    if (inside) {
      this.hurtPlayer(TUNABLE.nullFrontDamage, {
        id: 'nullfront',
        label: 'Null Front',
        mode: 'containment',
      });
    }
  }

  private mark(kind: TraceMarkerKind, label: string): void {
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
  private pickSpawnOrigin(): { x: number; y: number } {
    const halfW = TUNABLE.nominalViewWidth / 2;
    const halfH = TUNABLE.nominalViewHeight / 2;
    const offset = this.rng.next() * Math.PI * 2;
    const dist = this.rng.range(TUNABLE.spawnRingMin, TUNABLE.spawnRingMax);

    // Bias arrivals toward where the player is heading. Running away should not
    // be free: local density alone still let you outrun the horde, because what
    // you left behind stayed inside the pressure radius while the road ahead
    // stayed clear. Not a wall — just enough that fleeing costs something.
    const moveLen = Math.hypot(this.player.vx, this.player.vy);
    const forward = moveLen > 20 && this.rng.chance(TUNABLE.forwardSpawnBias);
    const fx = forward ? this.player.vx / moveLen : 0;
    const fy = forward ? this.player.vy / moveLen : 0;

    // Every direction that is genuinely off-screen is equally valid, and the
    // horde should arrive from all of them. Always taking the *most* hidden
    // candidate made spawns queue up along one compass line, which reads as a
    // procession rather than a swarm.
    const viable: { x: number; y: number }[] = [];
    let best = { x: this.player.x, y: this.player.y };
    let bestHidden = -Infinity;

    for (let i = 0; i < TUNABLE.spawnCandidates; i++) {
      const angle = offset + (i / TUNABLE.spawnCandidates) * Math.PI * 2;
      const x = clamp(this.player.x + Math.cos(angle) * dist, 30, this.arena.width - 30);
      const y = clamp(this.player.y + Math.sin(angle) * dist, 30, this.arena.height - 30);
      // How far outside the nominal view this lands. Positive means off-screen.
      const hidden = Math.max(
        Math.abs(x - this.player.x) - halfW,
        Math.abs(y - this.player.y) - halfH,
      );
      if (hidden > 0) {
        // When biasing forward, only keep candidates roughly ahead of travel.
        if (!forward || (Math.cos(angle) * fx + Math.sin(angle) * fy) > 0.25) {
          viable.push({ x, y });
        }
      }
      if (hidden > bestHidden) {
        bestHidden = hidden;
        best = { x, y };
      }
    }
    // Near an arena corner nothing may be fully hidden; fall back to the least
    // visible option rather than spawning in the player's lap.
    return viable.length > 0 ? viable[this.rng.int(viable.length)]! : best;
  }

  /** A point at a given distance band from the player that is not inside a ruin. */
  private findOpenSpot(minDist: number, maxDist: number): { x: number; y: number } {
    for (let attempt = 0; attempt < 12; attempt++) {
      const angle = this.rng.next() * Math.PI * 2;
      const dist = this.rng.range(minDist, maxDist);
      const x = clamp(this.player.x + Math.cos(angle) * dist, 60, this.arena.width - 60);
      const y = clamp(this.player.y + Math.sin(angle) * dist, 60, this.arena.height - 60);
      if (!this.insideRuin(x, y, 40)) return { x, y };
    }
    return { x: this.arena.spawnX, y: this.arena.spawnY };
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
    if (this.fx.length >= SAFETY.maxEntities) return;
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
   * §11.1 — the population builds resistance to each hue in proportion to that
   * hue's share of your recent damage, capped at 60%.
   *
   * Its job is to make mono-hue a *choice with a price*, not a mistake: an
   * engine strong enough to pay the tax may still push straight through. The
   * counters are diversifying, Attune, Rectify conversions — or brute force.
   *
   * A floor keeps the early game clean: nothing resists you until one hue
   * genuinely dominates, so a player is never taxed for owning one Action.
   */
  private updateResistance(dt: number): void {
    const decay = Math.pow(0.5, dt / TUNABLE.resistanceHalfLife);
    let total = 0;
    for (const hue of HUES) {
      this.damageByHue[hue] *= decay;
      total += this.damageByHue[hue];
    }
    if (total <= 0.0001) {
      for (const hue of HUES) this.resistance[hue] = 0;
      return;
    }
    for (const hue of HUES) {
      const share = this.damageByHue[hue] / total;
      const over = (share - TUNABLE.resistanceFloor) / (1 - TUNABLE.resistanceFloor);
      this.resistance[hue] = Math.max(0, Math.min(1, over)) * TUNABLE.resistanceCap;
    }
  }

  /** §11.2 — is the player inside a Suppressor's zone? Triggers do not fire there. */
  get suppressed(): boolean {
    for (const e of this.enemies) {
      if (!e.alive) continue;
      const def = getEnemy(e.defId);
      const radius = e.affixes.includes('anchored')
        ? TUNABLE.affixAnchoredZone
        : (def.zoneRadius ?? 0);
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

    // §5.3 On Crit — a crit both hits harder and emits its own event, so crit
    // investment is a build axis rather than a stat.
    let crit = false;
    if (this.rng.chance(TUNABLE.critChance + this.bonuses.crit)) {
      crit = true;
      damage *= TUNABLE.critMultiplier;
    }

    // §11.1 — global adaptive resistance, plus the elite's personal version.
    let resisted = damage * (1 - this.resistance[hue]);
    if (enemy.affixes.includes('adaptive')) {
      resisted *= 1 - Math.min(TUNABLE.resistanceCap, enemy.adaptive[hue]);
      enemy.adaptive[hue] = Math.min(1, enemy.adaptive[hue] + TUNABLE.affixAdaptiveRate);
    }

    this.damageByHue[hue] += damage;
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
    if (this.suppressedNow) this.stats.suppressedKills++;

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
    const fuelDrops = Math.round(def.fuel * bonus);
    for (let i = 0; i < fuelDrops; i++) this.dropPickup('fuel', enemy.x, enemy.y, enemy.hue, 1);
    this.dropPickup('xp', enemy.x, enemy.y, enemy.hue, def.xp * bonus);

    // §10.3 Volatile — a telegraphed death explosion.
    if (enemy.affixes.includes('volatile')) {
      this.pushFx('burst', enemy.hue, enemy.x, enemy.y, TUNABLE.affixVolatileRadius, [], 0.3);
      const dx = this.player.x - enemy.x;
      const dy = this.player.y - enemy.y;
      const reach = TUNABLE.affixVolatileRadius + TUNABLE.playerRadius;
      if (dx * dx + dy * dy < reach * reach) this.hurtPlayer(TUNABLE.affixVolatileDamage, {
          id: def.id,
          label: def.name,
          enemyId: def.id,
          shape: def.shape,
          mode: 'Volatile detonation',
        });
    }

    if (def.splitsInto) {
      for (let i = 0; i < def.splitsInto.count; i++) {
        const a = (i / def.splitsInto.count) * Math.PI * 2;
        const child = this.spawnEnemy(
          def.splitsInto.enemy,
          enemy.x + Math.cos(a) * 24,
          enemy.y + Math.sin(a) * 24,
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
    p.integrity -= amount;
    p.iframes = 0.5;
    this.stats.damageTaken += amount;
    const tallied = this.damageBySource.get(cause.id);
    if (tallied) tallied.amount += amount;
    else this.damageBySource.set(cause.id, { source: cause, amount });
    this.pushFx('hurt', 'thermal', p.x, p.y, 0, [], 0.14);
    this.emit({ type: 'wound', depth: 0, x: p.x, y: p.y });
    if (p.integrity <= 0) {
      p.integrity = 0;
      p.alive = false;
      this.deathCause = cause;
      // §14 — "CONTAINED" in Meltdown, "Garbage collected" before it. Never
      // shaming language either way.
      this.ending = this.phase === 'meltdown' ? 'contained' : 'died-early';
      this.mark('death', this.ending === 'contained' ? 'CONTAINED' : 'garbage collected');
    }
  }

  // ------------------------------------------------------------------ updates

  private updatePlayer(input: InputState, dt: number): void {
    const p = this.player;
    p.iframes = Math.max(0, p.iframes - dt);
    p.dashCooldown = Math.max(0, p.dashCooldown - dt);
    p.dashTimer = Math.max(0, p.dashTimer - dt);

    let mx = input.moveX;
    let my = input.moveY;
    const len = Math.hypot(mx, my);
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
      p.dashCooldown = TUNABLE.dashCooldown;
      p.iframes = Math.max(p.iframes, TUNABLE.dashIFrames);
      this.emit({ type: 'dash', depth: 0, x: p.x, y: p.y });
    }

    p.speedBoostTime = Math.max(0, p.speedBoostTime - dt);
    if (p.speedBoostTime <= 0) p.speedBoost = 0;

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
    for (const r of this.arena.ruins) {
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
    for (const r of this.arena.ruins) {
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
    this.chargingLancers = 0;
    for (const e of this.enemies) if (e.alive && e.beamActive > 0) this.chargingLancers++;

    for (const e of this.enemies) {
      if (!e.alive) continue;
      e.spawnAge += dt;
      e.flash = Math.max(0, e.flash - dt);
      // §23.1 — refresh the per-second knockback budget.
      e.shoveWindow -= dt;
      if (e.shoveWindow <= 0) {
        e.shoveWindow = 1;
        e.shoveBudget = TUNABLE.shoveBudgetPerSecond;
      }
      const def = getEnemy(e.defId);

      // §10.3 Phasing — untargetable for a beat, on a steady cycle.
      if (e.affixes.includes('phasing')) {
        const cycle = TUNABLE.affixPhaseInterval + TUNABLE.affixPhaseDuration;
        e.phased = e.spawnAge % cycle > TUNABLE.affixPhaseInterval;
      }

      // §10.2 — the behaviours that are not "walk at the player".
      if (def.behavior === 'intercept') {
        this.updateInterceptor(e, def, dt);
        continue;
      }
      if (def.behavior === 'suppress') {
        this.updateSuppressor(e, def, dt);
        continue;
      }
      if (def.behavior === 'lance') {
        this.updateLancer(e, def, dt);
        continue;
      }

      if (def.windup !== undefined) {
        // Charger: seek -> telegraphed windup -> dash (§10.2, §17.1).
        e.timer -= dt;
        if (e.state === 'seek') {
          const d = Math.hypot(p.x - e.x, p.y - e.y);
          if (d < 320 && e.timer <= 0) {
            e.state = 'windup';
            e.timer = def.windup;
            const len = d || 1;
            e.aimX = (p.x - e.x) / len;
            e.aimY = (p.y - e.y) / len;
          }
        } else if (e.state === 'windup') {
          e.vx = 0;
          e.vy = 0;
          // Re-aim at the moment of commitment so the drawn telegraph is honest.
          if (e.timer <= 0) {
            e.state = 'dash';
            e.timer = def.dashDuration ?? 0.4;
            e.vx = e.aimX * (def.dashSpeed ?? 500);
            e.vy = e.aimY * (def.dashSpeed ?? 500);
          }
        } else if (e.state === 'dash' && e.timer <= 0) {
          e.state = 'seek';
          e.timer = 1.2;
        }
      }

      if (e.state === 'seek') {
        const dx = p.x - e.x;
        const dy = p.y - e.y;
        const len = Math.hypot(dx, dy) || 1;

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
        const weave = Math.sin(this.time * TUNABLE.weaveRate + e.wobble) * TUNABLE.weaveAmount;
        const cos = Math.cos(weave);
        const sin = Math.sin(weave);
        let vx = sx * cos - sy * sin;
        let vy = sx * sin + sy * cos;

        let sepX = 0;
        let sepY = 0;
        const near = e.radius * TUNABLE.separationRadiusMult;
        this.grid.queryRadius(e.x, e.y, near, (other) => {
          if (other === e) return;
          const ox = e.x - other.x;
          const oy = e.y - other.y;
          const d = Math.hypot(ox, oy);
          if (d < 0.001 || d > near) return;
          const push = (1 - d / near) / d;
          sepX += ox * push;
          sepY += oy * push;
        });
        const sepLen = Math.hypot(sepX, sepY);
        if (sepLen > 0.001) {
          vx += (sepX / sepLen) * TUNABLE.separationStrength;
          vy += (sepY / sepLen) * TUNABLE.separationStrength;
        }

        const norm = Math.hypot(vx, vy) || 1;
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
   * §10.2 Leech — "contact steals 5 fuel of your fullest gauge (no damage)".
   * Pressure aimed at the economy rather than the health bar (§11).
   */
  private touchPlayer(e: Enemy, def: EnemyDef): void {
    if (def.fuelSteal) {
      if (e.beamTimer > 0) return; // per-enemy steal cooldown
      e.beamTimer = 1.2;
      let fullest: Hue = 'thermal';
      for (const hue of HUES) if (this.fuel[hue] > this.fuel[fullest]) fullest = hue;
      this.fuel[fullest] = Math.max(0, this.fuel[fullest] - def.fuelSteal);
      this.pushFx('hurt', fullest, this.player.x, this.player.y, 0, [], 0.16);
      return;
    }
    if (def.contactDamage > 0) {
      this.hurtPlayer(def.contactDamage, {
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
  private updateInterceptor(e: Enemy, def: EnemyDef, dt: number): void {
    let target: Projectile | null = null;
    let bestD2 = 700 * 700;
    for (const proj of this.projectiles) {
      if (!proj.alive) continue;
      const dx = proj.x - e.x;
      const dy = proj.y - e.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestD2) {
        bestD2 = d2;
        target = proj;
      }
    }

    const goalX = target ? target.x : this.player.x;
    const goalY = target ? target.y : this.player.y;
    const dx = goalX - e.x;
    const dy = goalY - e.y;
    const len = Math.hypot(dx, dy) || 1;
    e.facing = Math.atan2(dy, dx);
    e.vx = (dx / len) * def.speed;
    e.vy = (dy / len) * def.speed;
    e.x += e.vx * dt;
    e.y += e.vy * dt;
    this.resolveRuins(e, e.radius);

    // Eat anything it reaches.
    if (target && bestD2 < (e.radius + 10) ** 2) {
      target.alive = false;
      e.meals++;
      const growth = 1 + (def.growthPerMeal ?? 0.1);
      e.radius *= growth;
      e.maxHp *= growth;
      e.hp *= growth;
      this.pushFx('burst', e.hue, e.x, e.y, e.radius + 8, [], 0.12);
    }

    const pd = Math.hypot(this.player.x - e.x, this.player.y - e.y);
    if (pd < e.radius + TUNABLE.playerRadius) this.touchPlayer(e, def);
  }

  /**
   * §10.2 Suppressor — "never attacks; projects a zone where your Triggers don't
   * fire". Fragile on purpose: the answer is to kill it or leave.
   */
  private updateSuppressor(e: Enemy, def: EnemyDef, dt: number): void {
    // Drifts to a standoff just inside its own zone, so the zone covers the
    // player without the Suppressor walking into contact range.
    const dx = this.player.x - e.x;
    const dy = this.player.y - e.y;
    const d = Math.hypot(dx, dy) || 1;
    const want = (def.zoneRadius ?? 200) * 0.6;
    const push = d > want ? 1 : -0.6;
    e.vx = (dx / d) * def.speed * push;
    e.vy = (dy / d) * def.speed * push;
    e.x += e.vx * dt;
    e.y += e.vy * dt;
    this.resolveRuins(e, e.radius);
  }

  /**
   * §10.2 Lancer — keeps distance and fires a telegraphed beam across the arena.
   * §17.1: the beam draws as a guide line first, then flashes to full width.
   */
  private updateLancer(e: Enemy, def: EnemyDef, dt: number): void {
    const dx = this.player.x - e.x;
    const dy = this.player.y - e.y;
    const d = Math.hypot(dx, dy) || 1;
    const standoff = def.standoff ?? 500;

    if (e.beamActive > 0) {
      e.beamActive -= dt;
      e.vx = 0;
      e.vy = 0;
    } else {
      const push = d > standoff * 1.15 ? 1 : d < standoff * 0.85 ? -1 : 0;
      e.vx = (dx / d) * def.speed * push;
      e.vy = (dy / d) * def.speed * push;
      e.x += e.vx * dt;
      e.y += e.vy * dt;
      this.resolveRuins(e, e.radius);

      e.beamTimer -= dt;
      // §23.1 — only so many may be charging at once. Lancers arriving in
      // numbers turned a dodgeable telegraph into an unavoidable crossfire; the
      // rest simply hold their shot rather than being removed from the fight.
      if (e.beamTimer <= 0 && this.chargingLancers < TUNABLE.maxChargingLancers) {
        e.beamTimer = (def.windup ?? 0.9) + 2.4;
        e.beamActive = def.windup ?? 0.9;
        e.facing = Math.atan2(dy, dx);
        this.chargingLancers++;
      }
    }

    // Fires at the end of the telegraph, along the aim drawn at the start.
    if (e.beamActive > 0 && e.beamActive - dt <= 0) {
      const ux = Math.cos(e.facing);
      const uy = Math.sin(e.facing);
      const px = this.player.x - e.x;
      const py = this.player.y - e.y;
      const along = px * ux + py * uy;
      const across = Math.abs(px * -uy + py * ux);
      // §17.1 — a finite beam. It used to run the length of the arena, so a
      // Lancer off screen could kill you along a line you were never shown.
      if (along > 0 && along < TUNABLE.lancerBeamRange && across < 16 + TUNABLE.playerRadius) {
        this.hurtPlayer(def.beamDamage ?? 16, {
          id: def.id,
          label: def.name,
          enemyId: def.id,
          shape: def.shape,
          mode: 'beam',
        });
      }
      this.pushFx(
        'chain',
        e.hue,
        e.x,
        e.y,
        0,
        [e.x, e.y, e.x + ux * TUNABLE.lancerBeamRange, e.y + uy * TUNABLE.lancerBeamRange],
        0.18,
      );
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
          const d = Math.hypot(dx, dy) || 1;
          const speed = Math.hypot(proj.vx, proj.vy) || 1;
          proj.vx += (dx / d) * proj.seek * speed * dt;
          proj.vy += (dy / d) * proj.seek * speed * dt;
          const norm = Math.hypot(proj.vx, proj.vy) || 1;
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
          const incoming = Math.atan2(proj.y - enemy.y, proj.x - enemy.x);
          const facing = Math.atan2(this.player.y - enemy.y, this.player.x - enemy.x);
          if (Math.abs(angleDelta(incoming, facing)) < shield / 2) {
            proj.alive = false;
            this.pushFx('burst', enemy.hue, proj.x, proj.y, 14, [], 0.1);
            return;
          }
        }
        proj.hits.push(enemy.id);
        // §5.4 Siphon — "steals 1 fuel of the target's hue on hit".
        if (proj.siphon > 0) {
          this.fuel[enemy.hue] = Math.min(
            TUNABLE.fuelGaugeCap,
            this.fuel[enemy.hue] + proj.siphon,
          );
          this.fuelGainTick[enemy.hue] += proj.siphon;
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
            const len = Math.hypot(dx, dy) || 1;
            const speed = Math.hypot(proj.vx, proj.vy) || 1;
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

  /** The hue you are currently richest in. Used by Attune and by Bleed. */
  fullestHue(): Hue {
    let best: Hue = 'thermal';
    for (const hue of HUES) if (this.fuel[hue] > this.fuel[best]) best = hue;
    return best;
  }

  private emptiestHue(): Hue {
    let worst: Hue = 'thermal';
    for (const hue of HUES) if (this.fuel[hue] < this.fuel[worst]) worst = hue;
    return worst;
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

    // Rectify moves fuel between gauges rather than spending it outright.
    if (spec.rebalance) {
      const from = this.fullestHue();
      const to = this.emptiestHue();
      if (from === to || this.fuel[from] < spec.costAmount) return;
      this.fuel[from] -= spec.costAmount;
      this.fuel[to] = Math.min(TUNABLE.fuelGaugeCap, this.fuel[to] + spec.gainAmount);
      this.finishConvert(def, depth);
      return;
    }

    // Pay.
    let payHue: Hue = 'thermal';
    if (spec.costKind === 'integrity') {
      // Never let a Convert kill you outright: it is a trade, not a gamble.
      if (this.player.integrity <= spec.costAmount + 1) return;
      if (this.player.integrity < 40) this.stats.desperateConverts++;
      this.player.integrity -= spec.costAmount;
    } else {
      payHue = this.fullestHue();
      if (this.fuel[payHue] < spec.costAmount) return;
      this.fuel[payHue] -= spec.costAmount;
    }

    // Receive.
    switch (spec.gainKind) {
      case 'fuel': {
        const target = spec.costKind === 'integrity' ? this.fullestHue() : payHue;
        this.fuel[target] = Math.min(TUNABLE.fuelGaugeCap, this.fuel[target] + spec.gainAmount);
        break;
      }
      case 'xp':
        this.gainXp(this.xpToNext * spec.gainAmount);
        break;
      case 'heat':
        this.budget.addHeat(-spec.gainAmount);
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
      const d = Math.hypot(dx, dy) || 1;

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
        if (item.kind === 'fuel') {
          const before = this.fuel[item.hue];
          this.fuel[item.hue] = Math.min(TUNABLE.fuelGaugeCap, before + item.value);
          this.fuelGainTick[item.hue] += this.fuel[item.hue] - before;
        } else {
          this.gainXp(item.value);
        }
        this.emit({ type: 'pickup', depth: 0, x: p.x, y: p.y, hue: item.hue });
      }
    }
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
        // not load-bearing and shards merge freely. Fuel must not: merging hues
        // would silently convert one gauge into another.
        if (host.kind === 'fuel' && other.hue !== host.hue) continue;
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
    this.threat += TUNABLE.threatPerSecond * dt;

    this.releasePendingSpawns();

    // Rotate the composition, and announce the new one with an arrival burst.
    this.compositionTimer -= dt;
    if (this.compositionTimer <= 0 || !this.composition) {
      this.compositionTimer = TUNABLE.compositionDuration;
      this.rotateComposition();
    }

    // §10.2 — Wardens punctuate the flow once Threat is high enough.
    if (this.threat >= TUNABLE.wardenFromThreat) {
      this.wardenTimer -= dt;
      if (this.wardenTimer <= 0) {
        this.wardenTimer = TUNABLE.wardenInterval;
        const origin = this.pickSpawnOrigin();
        this.queueSpawn('warden', origin.x, origin.y, 40, 0, false);
      }
    }

    this.sustainPressure(dt);
  }

  /** Live density the director is actively trying to hold. */
  get targetAlive(): number {
    return Math.min(
      TUNABLE.maxAliveHard,
      TUNABLE.targetAliveBase + this.threat * TUNABLE.targetAlivePerThreat,
    );
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

    // Count only what is near the player, not the whole arena.
    //
    // A global count meant a queue trailing behind you filled the entire budget,
    // so nothing spawned ahead and you could outrun the game. Pressure is a
    // local property: what matters is how many enemies are where you are.
    const present = this.nearbyEnemyCount() + this.pendingSpawns.length;
    const deficit = this.targetAlive - present;
    if (deficit <= 0) {
      this.refillDebt = 0;
      return;
    }

    const maxRate = TUNABLE.refillRateBase + this.threat * TUNABLE.refillRatePerThreat;
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
    const eligible = WAVES.filter((w) => this.threat >= w.minThreat && this.threat <= w.maxThreat);
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
    this.queueSpawn(entry.enemy, origin.x, origin.y, entry.spread, delay, enriched);
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
      const hidden = this.pushOutsideView(s.x, s.y);
      const safe = this.pushOutsideSafeRadius(hidden.x, hidden.y);
      const e = this.spawnEnemy(
        s.enemy,
        clamp(safe.x, 20, this.arena.width - 20),
        clamp(safe.y, 20, this.arena.height - 20),
        s.hue,
      );
      if (e) e.enriched = s.enriched;
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

    const burst = Math.round(this.targetAlive * TUNABLE.compositionArrivalFraction * 1.5);
    for (let i = 0; i < burst; i++) {
      this.spawnFromComposition(composition, enriched, this.rng.next() * TUNABLE.waveArrivalSpread);
    }
    const origin = this.pickSpawnOrigin();
    this.emit({ type: 'wave', depth: 0, x: origin.x, y: origin.y });
  }

  /** Place one spawn around an origin and queue it to arrive after `delay`. */
  private queueSpawn(
    enemy: string,
    ox: number,
    oy: number,
    spread: number,
    delay: number,
    enriched: boolean,
  ): void {
    if (this.pendingSpawns.length >= SAFETY.maxEntities) return;
    const rx = ox + this.rng.range(-spread, spread);
    const ry = oy + this.rng.range(-spread, spread);
    // Spread can drag a cluster member back into view; push it out again before
    // the hard no-spawn-on-player guarantee.
    const hidden = this.pushOutsideView(rx, ry);
    const safe = this.pushOutsideSafeRadius(hidden.x, hidden.y);
    this.pendingSpawns.push({
      time: this.time + delay,
      enemy,
      x: clamp(safe.x, 20, this.arena.width - 20),
      y: clamp(safe.y, 20, this.arena.height - 20),
      hue: this.rng.pick(HUES),
      enriched,
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

    const scale =
      Math.max(halfW / Math.max(1e-3, Math.abs(dx)), halfH / Math.max(1e-3, Math.abs(dy))) * 1.06;
    return { x: this.player.x + dx * scale, y: this.player.y + dy * scale };
  }

  private pushOutsideSafeRadius(x: number, y: number): { x: number; y: number } {
    const dx = x - this.player.x;
    const dy = y - this.player.y;
    const d = Math.hypot(dx, dy);
    const min = TUNABLE.spawnSafeRadius;
    if (d >= min) return { x, y };
    // Degenerate case: spawn point exactly on the player — push along facing.
    const ux = d > 0.001 ? dx / d : -this.player.dirX;
    const uy = d > 0.001 ? dy / d : -this.player.dirY;
    return { x: this.player.x + ux * min, y: this.player.y + uy * min };
  }

  // ------------------------------------------------------------------ spawning

  spawnEnemy(defId: string, x: number, y: number, hue: Hue): Enemy | null {
    if (this.enemies.length >= SAFETY.maxEntities) return null;
    const def = ENEMY_BY_ID.get(defId);
    if (!def) throw new Error(`Unknown enemy "${defId}"`);
    const e: Enemy = {
      id: this.nextId++,
      defId,
      hue,
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
      adaptive: { thermal: 0, voltaic: 0, void: 0 },
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
    // everything substantial (§13.2).
    const eliteRoll =
      def.elite === true || (this.phase === 'meltdown' && def.hp >= 20 && this.rng.chance(0.25));
    if (eliteRoll) {
      const pool: EliteAffix[] = ['adaptive', 'volatile', 'phasing', 'anchored'];
      const count = def.elite === true ? 1 + this.rng.int(2) : 1;
      for (let i = 0; i < count; i++) {
        const pick = pool[this.rng.int(pool.length)]!;
        if (!e.affixes.includes(pick)) e.affixes.push(pick);
      }
    }

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
      vx: Math.cos(a) * s,
      vy: Math.sin(a) * s,
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
      this.mark('level', `level ${this.level}`);
      // level 2 costs xpBase, and the curve compounds from there. Level 1's cost
      // was set separately in the constructor.
      this.xpToNext = Math.ceil(TUNABLE.xpBase * Math.pow(TUNABLE.xpGrowth, this.level - 2));
      if (this.stats.firstLevelTime === 0) this.stats.firstLevelTime = this.time;
      if (this.pendingDrafts < TUNABLE.maxQueuedDrafts) this.pendingDrafts++;
    }
  }

  /** Called by the draft layer once a card is applied, so static load stays in sync. */
  syncBudget(): void {
    this.budget.setStaticLoad(this.engine.staticLoad);
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
    const outputDecay = Math.pow(0.5, dt / TUNABLE.kernelAverageHalfLife);
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
    const decay = Math.pow(0.5, dt / 2);
    for (const p of this.engine.programs) {
      p.recentEvents = p.recentEvents * decay + (p.tickEvents / dt) * (1 - decay);
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

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
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
