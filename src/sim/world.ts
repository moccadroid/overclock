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
import { Engine, type Program } from './engine';
import { LOADBEARING, SAFETY, SIM_DT, TUNABLE } from './tunables';
import { HUES, type ArenaDef, type EventType, type GameEvent, type Hue } from './types';
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
}

/**
 * GDD §12.3 Wave Beacon. Channel it to pull the next wave in early and enriched,
 * permanently ticking Threat up. Ignoring beacons is safe and slow; chaining them
 * is the greed line. This is what makes traversing the arena a decision.
 */
export interface Beacon extends SpatialItem {
  id: number;
  /** 0..1 channel progress. Resets if the player leaves or stops holding. */
  progress: number;
  age: number;
}

/** Short-lived visual records for instantaneous actions. Sim-owned so replays match. */
export interface Fx {
  id: number;
  kind: 'burst' | 'chain' | 'hurt';
  hue: Hue;
  x: number;
  y: number;
  radius: number;
  points: number[];
  life: number;
  maxLife: number;
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
  alive: boolean;
}

export interface RunConfig {
  seed: string;
  axiomId: string;
  arenaId?: string;
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
  /** Seconds spent in each Heat tier — the instrument for tuning §6.3. */
  tierSeconds: [number, number, number, number];
  /** Total Cycles the engine asked for. Compare against capacity x time. */
  cyclesSpent: number;
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
  beacons: Beacon[] = [];
  fx: Fx[] = [];

  fuel: Record<Hue, number> = { thermal: 0, voltaic: 0, void: 0 };
  xp = 0;
  xpToNext: number;
  level = 1;
  /** §19.4 — drafts queue up to 3. */
  pendingDrafts = 0;
  rerolls = TUNABLE.rerollsPerRun;
  purges = TUNABLE.purgesPerRun;
  /** Node ids removed from this run's pool by Purge (§8.3). */
  purged = new Set<string>();

  threat = 0;
  waveTimer = 2;
  beaconTimer = 20;
  score = 0;
  eps = 0;

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
    tierSeconds: [0, 0, 0, 0],
    cyclesSpent: 0,
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
  private grid: SpatialGrid<Enemy>;
  private flow: FlowField;
  private readonly flowSample = { x: 0, y: 0 };
  private nextId = 1;
  private eventsThisTick = 0;

  constructor(config: RunConfig) {
    this.config = config;
    this.rng = new Rng(config.seed);
    this.arena = getArena(config.arenaId ?? 'heap');
    this.grid = new SpatialGrid<Enemy>(this.arena.width, this.arena.height);
    this.flow = new FlowField(this.arena);

    const ax = getAxiom(config.axiomId);
    this.engine = new Engine();
    const p0 = this.engine.programs[0]!;
    p0.triggerId = ax.starter.trigger;
    p0.actionId = ax.starter.action;
    ax.starter.modifiers.forEach((m, i) => {
      if (i < p0.modifierIds.length) p0.modifierIds[i] = m;
    });
    this.engine.recompile();

    this.budget = new CycleBudget(TUNABLE.cycleCapacityBase + ax.capacityDelta);
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
      alive: true,
    };

    this.xpToNext = TUNABLE.xpBase;
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
    this.updatePickups(dt);
    this.updateFx(dt);
    this.updateBeacons(input, dt);
    this.updateDirector(dt);

    if (!this.budget.stalled) {
      this.advanceClocks(dt);
      this.runScheduled();
      this.drainEvents();
    }

    if (this.budget.endTick(dt)) {
      this.stats.overheats++;
      this.emit({ type: 'overheat', depth: 0, x: this.player.x, y: this.player.y });
      if (!this.budget.stalled) this.drainEvents();
    }

    this.stats.tierSeconds[this.budget.tier] += dt;
    this.stats.cyclesSpent += this.budget.spentThisTick;
    if (this.budget.heat > this.stats.peakHeat) this.stats.peakHeat = this.budget.heat;

    this.compact();
    this.updateScore(dt);
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

  /** Fire every live Program whose Trigger listens for this event type. */
  private dispatch(ev: GameEvent): void {
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
      this.engine.clocks[i] = (this.engine.clocks[i] ?? 0) + dt;
      let guard = 0;
      while (this.engine.clocks[i]! >= compiled.interval && guard++ < 32) {
        this.engine.clocks[i] = this.engine.clocks[i]! - compiled.interval;
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

    this.budget.spend(compiled.cycleCost);

    if (this.budget.rollMisfire(this.rng)) {
      this.stats.misfires++;
      return;
    }

    program.fireCount++;
    program.tickEvents++;
    this.stats.fires++;

    for (const exec of compiled.executions) {
      if (exec.delay <= 0) {
        this.execute(index, exec.outputMul, depth, x, y);
      } else if (this.scheduled.length < SAFETY.maxScheduledFires) {
        this.scheduled.push({
          time: this.time + exec.delay,
          programIndex: index,
          outputMul: exec.outputMul,
          depth,
          x,
          y,
          alive: true,
        });
      }
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

    for (let n = 0; n < instances; n++) {
      // §7.2 — fuelled fire consumes 1 fuel of the Action's hue for +50% output.
      let fuelBonus = 1;
      if (this.fuel[def.hue] >= 1) {
        this.fuel[def.hue] -= 1;
        fuelBonus = 1 + TUNABLE.fueledFireOutputBonus;
      }
      const output = compiled.ctx.output * outputMul * fuelBonus * this.engine.globalOutput;
      const damage = def.damage * output;
      const corrupted =
        this.budget.corruptionChance > 0 && this.rng.chance(this.budget.corruptionChance);

      switch (def.primitive) {
        case 'projectile':
          this.spawnProjectile(def.id, damage, depth, index, x, y, compiled.ctx.pierce, corrupted);
          break;
        case 'burst':
          this.doBurst(def.id, damage, depth, index, x, y, compiled.ctx.area);
          break;
        case 'chain':
          this.doChain(def.id, damage, depth, index, x, y);
          break;
        case 'zone':
          this.dropZone(def.id, damage, depth, index, x, y, compiled.ctx.area, compiled.ctx.duration);
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
    pierce: number,
    corrupted: boolean,
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
      pierce: (def.pierce ?? 0) + Math.round(pierce),
      hue: def.hue,
      depth,
      programIndex,
      radius: 4,
      corrupted,
      hits: [],
      age: 0,
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
  ): void {
    const def = ACTION_BY_ID.get(actionId)!;
    const radius = (def.radius ?? 100) * Math.max(0.1, area);
    this.grid.queryRadius(x, y, radius, (enemy) => {
      this.damageEnemy(enemy, damage, depth, programIndex, def.hue);
    });
    this.pushFx('burst', def.hue, x, y, radius, [], 0.22);
  }

  private doChain(
    actionId: string,
    damage: number,
    depth: number,
    programIndex: number,
    x: number,
    y: number,
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
      this.damageEnemy(target, damage, depth, programIndex, def.hue);
    }
    if (points.length > 2) this.pushFx('chain', def.hue, x, y, 0, points, 0.14);
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
  ): void {
    if (this.zones.length >= SAFETY.maxEntities) return;
    const def = ACTION_BY_ID.get(actionId)!;
    const radius = (def.radius ?? 130) * Math.max(0.1, area);

    let bestX = x;
    let bestY = y;
    let bestCount = -1;
    const samples = Math.min(6, this.enemies.length);
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
      hue: def.hue,
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
      alive: true,
    });
  }

  private updateZones(dt: number): void {
    for (const z of this.zones) {
      if (!z.alive) continue;
      z.life -= dt;
      if (z.life <= 0) {
        z.alive = false;
        continue;
      }
      z.tickTimer -= dt;
      if (z.tickTimer > 0) continue;
      z.tickTimer = z.tickInterval;
      this.grid.queryRadius(z.x, z.y, z.radius, (enemy) => {
        this.damageEnemy(enemy, z.damage, z.depth, z.programIndex, z.hue);
      });
    }
  }

  // ------------------------------------------------------------------ beacons

  /**
   * §12.3 — hold Interact inside a Beacon to pull the next wave in early and
   * enriched, permanently bumping Threat. Channelling is interruptible and
   * resumes from zero, with visible progress (§21).
   */
  private updateBeacons(input: InputState, dt: number): void {
    this.beaconTimer -= dt;
    if (this.beaconTimer <= 0 && this.beacons.length < TUNABLE.maxBeacons) {
      this.beaconTimer = TUNABLE.beaconInterval;
      const spot = this.findOpenSpot(TUNABLE.spawnRingMin * 0.5, TUNABLE.spawnRingMax);
      this.beacons.push({
        id: this.nextId++,
        x: spot.x,
        y: spot.y,
        progress: 0,
        age: 0,
        alive: true,
      });
    }

    for (const b of this.beacons) {
      if (!b.alive) continue;
      b.age += dt;
      const near =
        Math.hypot(this.player.x - b.x, this.player.y - b.y) < TUNABLE.beaconRadius + TUNABLE.playerRadius;
      if (near && input.interact) {
        b.progress += dt / TUNABLE.beaconChannelTime;
        if (b.progress >= 1) {
          b.alive = false;
          this.stats.beaconsChannelled++;
          this.threat += TUNABLE.beaconThreatBump;
          this.spawnWave(true);
        }
      } else if (b.progress > 0) {
        b.progress = Math.max(0, b.progress - dt / TUNABLE.beaconChannelTime);
      }
    }
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
      if (hidden > bestHidden) {
        bestHidden = hidden;
        best = { x, y };
      }
    }
    return best;
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

  // ------------------------------------------------------------------- damage

  private damageEnemy(
    enemy: Enemy,
    damage: number,
    depth: number,
    programIndex: number,
    hue: Hue,
  ): void {
    if (!enemy.alive || damage <= 0) return;
    enemy.hp -= damage;
    enemy.flash = 0.04;

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

    const def = getEnemy(enemy.defId);
    // §12.3 — beacon-called waves drop enriched.
    const bonus = enemy.enriched ? 1 + TUNABLE.beaconDropBonus : 1;
    const fuelDrops = Math.round(def.fuel * bonus);
    for (let i = 0; i < fuelDrops; i++) this.dropPickup('fuel', enemy.x, enemy.y, enemy.hue, 1);
    this.dropPickup('xp', enemy.x, enemy.y, enemy.hue, def.xp * bonus);

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

  private hurtPlayer(amount: number): void {
    const p = this.player;
    if (p.iframes > 0) return;
    p.integrity -= amount;
    p.iframes = 0.5;
    this.stats.damageTaken += amount;
    this.pushFx('hurt', 'thermal', p.x, p.y, 0, [], 0.14);
    this.emit({ type: 'wound', depth: 0, x: p.x, y: p.y });
    if (p.integrity <= 0) {
      p.integrity = 0;
      p.alive = false;
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

    const speed = TUNABLE.playerMoveSpeed * (p.dashTimer > 0 ? TUNABLE.dashSpeedMult : 1);
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
    for (const e of this.enemies) {
      if (!e.alive) continue;
      e.spawnAge += dt;
      e.flash = Math.max(0, e.flash - dt);
      const def = getEnemy(e.defId);

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
        e.vx = sx * def.speed;
        e.vy = sy * def.speed;
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

      // Contact damage.
      const dx = p.x - e.x;
      const dy = p.y - e.y;
      const d2 = dx * dx + dy * dy;
      const r = e.radius + TUNABLE.playerRadius;
      if (d2 < r * r) this.hurtPlayer(def.contactDamage);

      // Outrun stragglers stop existing — see TUNABLE.despawnRadius.
      if (d2 > TUNABLE.despawnRadius * TUNABLE.despawnRadius && e.spawnAge > 4) {
        e.alive = false;
      }
    }
  }

  private updateProjectiles(dt: number): void {
    for (const proj of this.projectiles) {
      if (!proj.alive) continue;
      proj.age += dt;
      proj.life -= dt;
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
        proj.alive = false;
        continue;
      }

      if (proj.corrupted && this.player.iframes <= 0) {
        const dx = this.player.x - proj.x;
        const dy = this.player.y - proj.y;
        const r = TUNABLE.playerRadius + proj.radius;
        if (dx * dx + dy * dy < r * r) {
          this.hurtPlayer(4);
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
        proj.hits.push(enemy.id);
        this.damageEnemy(enemy, proj.damage, proj.depth, proj.programIndex, proj.hue);
        if (proj.hits.length > proj.pierce) proj.alive = false;
      });
    }
  }

  private updatePickups(dt: number): void {
    const p = this.player;
    for (const item of this.pickups) {
      if (!item.alive) continue;
      item.age += dt;
      const dx = p.x - item.x;
      const dy = p.y - item.y;
      const d = Math.hypot(dx, dy) || 1;

      if (d < TUNABLE.collectRadius) {
        // §17.2 — quadratic magnet ease-in.
        const pull = 260 * (1 - d / TUNABLE.collectRadius) + 90;
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
          this.fuel[item.hue] = Math.min(TUNABLE.fuelGaugeCap, this.fuel[item.hue] + item.value);
        } else {
          this.gainXp(item.value);
        }
        this.emit({ type: 'pickup', depth: 0, x: p.x, y: p.y, hue: item.hue });
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
    this.waveTimer -= dt;
    if (this.waveTimer > 0) return;

    this.waveTimer = Math.max(
      TUNABLE.waveIntervalMin,
      TUNABLE.waveIntervalBase - this.threat * TUNABLE.waveIntervalPerThreat,
    );

    // Soft population throttle — see TUNABLE.maxAliveBase. Difficulty keeps
    // rising through composition and Threat; only raw pile-up is capped.
    const maxAlive = TUNABLE.maxAliveBase + this.threat * TUNABLE.maxAlivePerThreat;
    if (this.enemies.length >= maxAlive) return;

    this.spawnWave(false);
  }

  /**
   * §12.2 — a wave template arrives from one compass direction, off-screen.
   * The ring radius is viewport-independent on purpose: the simulation must not
   * know how big the player's window is, or two players on different monitors
   * would get different runs from the same seed.
   */
  private spawnWave(enriched: boolean): void {
    const eligible = WAVES.filter((w) => this.threat >= w.minThreat && this.threat <= w.maxThreat);
    if (eligible.length === 0) return;
    const template = this.rng.pickWeighted(
      eligible,
      eligible.map((w) => w.weight),
    );

    const { x: ox, y: oy } = this.pickSpawnOrigin();

    for (const entry of template.entries) {
      for (let i = 0; i < entry.count; i++) {
        const rx = ox + this.rng.range(-entry.spread, entry.spread);
        const ry = oy + this.rng.range(-entry.spread, entry.spread);
        // The template's spread can drag a cluster member back into view; push
        // it out again before the hard no-spawn-on-player guarantee.
        const hidden = this.pushOutsideView(rx, ry);
        const safe = this.pushOutsideSafeRadius(hidden.x, hidden.y);
        const e = this.spawnEnemy(
          entry.enemy,
          clamp(safe.x, 20, this.arena.width - 20),
          clamp(safe.y, 20, this.arena.height - 20),
          this.rng.pick(HUES),
        );
        if (e) e.enriched = enriched;
      }
    }
    this.emit({ type: 'wave', depth: 0, x: ox, y: oy });
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
      alive: true,
    };
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
    this.xp += amount * TUNABLE.xpPerShard;
    while (this.xp >= this.xpToNext) {
      this.xp -= this.xpToNext;
      this.level++;
      this.xpToNext = Math.ceil(TUNABLE.xpBase * Math.pow(TUNABLE.xpGrowth, this.level - 1));
      if (this.stats.firstLevelTime === 0) this.stats.firstLevelTime = this.time;
      if (this.pendingDrafts < TUNABLE.maxQueuedDrafts) this.pendingDrafts++;
    }
  }

  /** Called by the draft layer once a card is applied, so static load stays in sync. */
  syncBudget(): void {
    this.budget.setStaticLoad(this.engine.staticLoad);
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
    if (this.enemies.length > this.stats.peakConcurrentEnemies) {
      this.stats.peakConcurrentEnemies = this.enemies.length;
    }
    // §13.1 — score is the integral of EPS over the run.
    this.score += this.eps * dt;

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
    compactInPlace(this.beacons);
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

export type { Program };
export type { EventType };
