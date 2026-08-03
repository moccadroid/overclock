/**
 * Cycles and Heat. GDD §6.
 *
 * ---
 *
 * **Cycles are a static reservation. Heat comes from cascade depth.**
 *
 * That is a rewrite of §6, and it is worth saying why, because the version it
 * replaces was carefully built and completely broken.
 *
 * Cycles used to be two resources wearing one name: a static reservation for
 * what your Engine *is*, and a per-event budget for what it *does*. The second
 * one could not work, and no tuning would have fixed it. A cascade's demand is
 * multiplicative — output is roughly `kills x depth`, and both terms rise
 * together — while supply was a constant. A constant against a multiplicative
 * term is not a curve, it is a cliff.
 *
 * Measured, from a recorded nine-minute run: available Cycles sat between 87%
 * and full for seven and a half minutes with Heat at exactly zero, then went
 * from full headroom to nothing in **ten seconds**. 91% of that run was spent at
 * Heat tier 0. The mechanic was inert for the whole game and then binary. You
 * cannot learn a system that never engages, and you cannot prepare for one that
 * resolves in ten seconds.
 *
 * So the per-event budget is gone, along with overdraw, deficits and misfires.
 * What remains:
 *
 *   **Cycles** — a static reservation. Every live node costs; capacity limits
 *   what fits. It changes only when *you* change the Engine, which makes it a
 *   number you can plan against instead of one you discover.
 *
 *   **Heat** — accrues from cascade *depth*. Shallow play never heats. A chain
 *   running ten deep heats hard. This prices the thing the game is named after,
 *   and unlike a hidden per-second integral it has a cause you can see: the
 *   chain is drawn on screen and the depth is on the HUD.
 *
 * Bounding cascades is still handled where it always was — §5.6's depth pricing
 * decays output geometrically with depth. Heat is the second half of that: the
 * first makes deep chains unrewarding, this makes them dangerous.
 */
import { TUNABLE } from './tunables';
import type { Rng } from './rng';

export type HeatTier = 0 | 1 | 2 | 3;

export class CycleBudget {
  capacity: number;
  staticLoad = 0;
  heat = 0;
  /** Seconds remaining of an Overheat stall (§6.2). */
  stall = 0;
  /**
   * Signed Heat change per second, for the gauge. Positive = building.
   *
   * Kept from the old model because the reason for it still holds: a gauge that
   * sits at zero and then leaps shows the player the punishment and never the
   * mechanism.
   */
  heatRate = 0;
  /** Heat asked for this tick, before decay. Diagnostics and the HUD. */
  heatThisTick = 0;
  /** Deepest cascade seen this tick — the HUD shows it beside the gauge. */
  depthThisTick = 0;

  constructor(capacity: number = TUNABLE.cycleCapacityBase) {
    this.capacity = capacity;
  }

  /** Cycles still unreserved. Negative is impossible: the draft refuses it. */
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

  /** Direct Heat change — Overdrive adds, Coolant subtracts. */
  addHeat(amount: number): void {
    this.heat = Math.max(0, Math.min(100, this.heat + amount));
  }

  setStaticLoad(load: number): void {
    this.staticLoad = load;
  }

  beginTick(dt: number): void {
    this.heatThisTick = 0;
    this.depthThisTick = 0;
    if (this.stall > 0) this.stall = Math.max(0, this.stall - dt);
  }

  /**
   * An event resolved at this cascade depth. GDD §6.2, rewritten.
   *
   * The first few links are free, so ordinary play — a Clock row, a shallow
   * On Kill bounce — never heats at all and the gauge stays where a new player
   * can ignore it. Past that the cost is linear in depth *per event*, which
   * makes the total quadratic in a deep chain: exactly the shape that lets a
   * cascade be spectacular and brief rather than free and permanent.
   */
  chargeDepth(depth: number): void {
    if (depth > this.depthThisTick) this.depthThisTick = depth;
    const over = depth - TUNABLE.heatFreeDepth;
    if (over <= 0) return;
    this.heatThisTick += over * TUNABLE.heatPerDepthEvent;
  }

  /**
   * Close the tick. Returns true if an Overheat just triggered, in which case the
   * caller must emit the On Overheat event (§5.3) — builds catch it deliberately.
   */
  endTick(dt: number): boolean {
    if (this.stall > 0) {
      this.heatRate = 0;
      return false;
    }

    // Capped per second so one enormous frame cannot jump the gauge from cold to
    // Overheat with nothing in between. The cap is what keeps this a *rate* the
    // player can watch rather than an event that happens to them.
    const gain = Math.min(TUNABLE.heatGainMaxPerSec, dt > 0 ? this.heatThisTick / dt : 0);
    const decay = TUNABLE.heatDecayPerSec;
    this.heatRate = gain - decay;
    this.heat = Math.max(0, this.heat + (gain - decay) * dt);

    if (this.heat >= 100) {
      this.heat = TUNABLE.overheatHeatReset;
      this.stall = TUNABLE.overheatStallSeconds;
      return true;
    }
    return false;
  }

  /** §6.2 — misfire roll. A misfired event is silently dropped. */
  rollMisfire(rng: Rng): boolean {
    const c = this.misfireChance;
    return c > 0 && rng.chance(c);
  }

  /** Fraction of capacity that is reserved (§19.4). */
  get staticFraction(): number {
    return this.capacity > 0 ? Math.min(1, this.staticLoad / this.capacity) : 0;
  }
}
