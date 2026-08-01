/**
 * Cycles, Heat and Overclock. GDD §6.
 *
 * Design intent (§6.3): Overclock is a dial, not a line. Running permanently in
 * Instability I is a legitimate strategy. Nothing here caps the player — going
 * over budget produces instability the player authored, not a designer's wall.
 */
import { TUNABLE } from './tunables';
import type { Rng } from './rng';

export type HeatTier = 0 | 1 | 2 | 3;

export class CycleBudget {
  capacity: number;
  staticLoad = 0;
  /** Dynamic Cycles currently available to spend on events. */
  available: number;
  heat = 0;
  /** Seconds remaining of an Overheat stall (§6.2). */
  stall = 0;
  /** Set when demand exceeded supply this tick — blocks Heat decay. */
  private overdrawn = false;
  /** Diagnostics for the HUD ring and the harness. */
  spentThisTick = 0;
  deficitThisTick = 0;

  constructor(capacity: number = TUNABLE.cycleCapacityBase) {
    this.capacity = capacity;
    this.available = this.headroom;
  }

  /** Cycles left for dynamic work once live Programs have reserved theirs. */
  get headroom(): number {
    return Math.max(0, this.capacity - this.staticLoad);
  }

  get tier(): HeatTier {
    if (this.heat >= 100) return 3;
    if (this.heat >= 70) return 2;
    if (this.heat >= 40) return 1;
    return 0;
  }

  get misfireChance(): number {
    const t = this.tier;
    if (t === 1) return TUNABLE.instability1Misfire;
    if (t >= 2) return TUNABLE.instability2Misfire;
    return 0;
  }

  get corruptionChance(): number {
    return this.tier >= 2 ? TUNABLE.instability2Corruption : 0;
  }

  get stalled(): boolean {
    return this.stall > 0;
  }

  setStaticLoad(load: number): void {
    this.staticLoad = load;
    if (this.available > this.headroom) this.available = this.headroom;
  }

  beginTick(dt: number): void {
    this.overdrawn = false;
    this.spentThisTick = 0;
    this.deficitThisTick = 0;
    if (this.stall > 0) {
      this.stall = Math.max(0, this.stall - dt);
      return;
    }
    // §6.1 — regenerates at capacity/sec.
    this.available = Math.min(
      this.headroom,
      this.available + this.capacity * TUNABLE.cycleRegenPerCapacity * dt,
    );
  }

  /**
   * Charge an event's Cycle cost. Never refuses: the deficit becomes Heat (§6.2).
   * Running out of Cycles doesn't stop the engine — it Overclocks it.
   */
  spend(cost: number): void {
    this.spentThisTick += cost;
    if (this.available >= cost) {
      this.available -= cost;
      return;
    }
    const deficit = cost - this.available;
    this.available = 0;
    this.heat += deficit * TUNABLE.heatPerCycleDeficit;
    this.deficitThisTick += deficit;
    this.overdrawn = true;
  }

  /**
   * Close the tick. Returns true if an Overheat just triggered, in which case the
   * caller must emit the On Overheat event (§5.3) — builds catch it deliberately.
   */
  endTick(dt: number): boolean {
    if (this.stall > 0) return false;
    if (!this.overdrawn) {
      this.heat = Math.max(0, this.heat - TUNABLE.heatDecayPerSec * dt);
    }
    if (this.heat >= 100) {
      this.heat = TUNABLE.overheatHeatReset;
      this.stall = TUNABLE.overheatStallSeconds;
      this.available = 0;
      return true;
    }
    return false;
  }

  /** §6.2 — misfire roll. A misfired event is silently dropped. */
  rollMisfire(rng: Rng): boolean {
    const c = this.misfireChance;
    return c > 0 && rng.chance(c);
  }

  /** Fraction of the Ring that is statically reserved (§19.4). */
  get staticFraction(): number {
    return this.capacity > 0 ? Math.min(1, this.staticLoad / this.capacity) : 0;
  }

  /** Fraction of the Ring currently spent dynamically. */
  get dynamicFraction(): number {
    const h = this.headroom;
    return h > 0 ? Math.min(1, (h - this.available) / h) : 1;
  }
}
