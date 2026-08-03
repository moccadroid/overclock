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
 *   **Heat** — accrues from cascade *depth* and from sheer *volume*. Shallow,
 *   quiet play never heats. A chain running ten deep heats hard, and so does an
 *   Engine resolving two thousand events a second however flat it is. Both have
 *   a cause you can see: the chain is drawn on screen, the depth is on the HUD,
 *   and the event rate is the number in the corner.
 *
 *   Depth alone was the first version, and it left the widest builds in the game
 *   paying nothing — Split, Echo and Resonate all multiply at the *same* depth.
 *   Three recorded runs converged on the same flat loop; it was the one shape
 *   the meter could not see. See chargeVolume.
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
  /**
   * Smoothed events per second, for the volume charge below.
   *
   * Smoothed rather than per-tick because a single frame of a cascade is not a
   * *rate*, and the gauge has to move at a speed a player can read.
   */
  eventRate = 0;
  /** Heat/sec currently coming from volume. Diagnostics and the HUD. */
  volumeRate = 0;

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

  /**
   * §8.2 Coolant — extra Heat vented per second, from stats. Added rather than
   * multiplied so it reads as a rate on the HUD: "-8/s venting" becomes "-10/s".
   */
  extraVenting = 0;

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
   * §6.2 — Heat from sheer *volume*, on top of Heat from depth.
   *
   * Depth alone was the whole model, and it had a hole the size of the game in
   * it: Split, Echo and Resonate multiply events at the *same* cascade depth, so
   * the widest engines in the game paid nothing at all. Measured across three
   * recorded runs, every one of them converged on `on_hit > echo > bolt`, which
   * ran at a peak of 3,375 events a second with six Overheats in nine minutes —
   * while a genuinely deep chain cooks itself in seconds. The dominant strategy
   * was dominant partly because it was the one shape Heat could not see.
   *
   * The curve saturates rather than scaling linearly, and that is the important
   * part. A linear price against an engine that grows a hundredfold over a run
   * is either nothing at minute two or a permanent stall at minute nine; there
   * is no coefficient that is both. Saturating means the pressure arrives early,
   * where it is a *decision* (Insulate this row? draft Coolant? take Governor?),
   * and then flattens, so a monstrous Engine runs permanently hot and
   * occasionally melts instead of being switched off.
   *
   *   200/s   free — ordinary play never sees this
   *   400/s   ~2.3 Heat/sec, against 8/s of base venting
   *   700/s   ~4.7
   *   1500/s  ~8.3, roughly break-even with venting
   *   3000/s  ~11.2, net positive: hot, with an Overheat every ~16s
   *
   * Insulate spares a row its *depth* charge and not this one, deliberately: a
   * wide loop is exactly what this exists to price, and a card that switched it
   * off would put the hole straight back.
   */
  chargeVolume(events: number, dt: number): void {
    if (dt <= 0) return;
    const instant = events / dt;
    // A third of a second of smoothing. One frame of a cascade is not a rate,
    // and the first pass at this was charging the spikes rather than the load.
    this.eventRate += (instant - this.eventRate) * Math.min(1, dt * 3);
    const over = Math.max(0, this.eventRate - TUNABLE.heatFreeEventRate);
    this.volumeRate =
      over <= 0 ? 0 : (TUNABLE.heatVolumeMax * over) / (over + TUNABLE.heatVolumeHalf);
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
    const fromDepth = dt > 0 ? this.heatThisTick / dt : 0;
    const gain = Math.min(TUNABLE.heatGainMaxPerSec, fromDepth + this.volumeRate);
    const decay = TUNABLE.heatDecayPerSec + this.extraVenting;
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
