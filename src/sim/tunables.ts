/**
 * Every number the design document marks [T] lives here, in one file, so the
 * first-playable tuning pass (GDD §25.2) has a single surface to work on and the
 * headless harness can sweep it.
 *
 * TUNABLE   = GDD-marked [T]. Free to change during prototyping.
 * LOADBEARING = unmarked in the GDD. Changing one is a design conversation (§0).
 */

/** Fixed simulation step. Not a design number — a determinism guarantee. */
export const SIM_HZ = 60;
export const SIM_DT = 1 / SIM_HZ;

export const TUNABLE = {
  // ---- §4.1 avatar ----
  playerIntegrity: 100,
  /** §4.1 — crossing the visible field takes roughly 3s at this speed. */
  playerMoveSpeed: 300,
  dashDuration: 0.15,
  dashSpeedMult: 3,
  dashIFrames: 0.15,
  dashCooldown: 3,
  /**
   * §4.1 says ~1.5x avatar diameter (=46). That was sized for a boxed arena; in
   * an open world the player outruns their own drops and the opening starves.
   */
  collectRadius: 190,
  playerRadius: 15,

  // ---- §6 cycles & heat ----
  /**
   * Capacity is a *static* reservation now, and it binds.
   *
   * It used to be 100 against a peak measured static load of 27 — a constraint
   * that was never once the reason you could not do something. With the dynamic
   * budget gone this is the only build tension left, so it has to bite: 55 puts
   * a typical three-row Engine around 70-85% reserved, which is where a choice
   * between rows starts being a choice.
   */
  cycleCapacityBase: 55,
  /**
   * Heat from cascade depth. See cycles.ts for why the overdraw model is gone.
   *
   * The first three links are free, so a Clock row or a shallow bounce never
   * heats and a new player can ignore the gauge entirely. Past that each event
   * charges in proportion to how deep it is, which makes a whole chain's cost
   * quadratic in its depth — spectacular and brief rather than free and
   * permanent.
   */
  heatFreeDepth: 2,
  // Calibrated against real event rates rather than guessed. A cascade runs
  // 50-500 events a second; at 100/s and two links past free that is 10 Heat a
  // second, which the 8/s decay very nearly cancels. Six past free is 30/s and
  // climbs. Twelve past free saturates the cap. The point is that the whole
  // band between "free" and "on fire" is reachable, which is exactly what the
  // overdraw model never managed.
  // Retuned down from 0.1 after the trigger payloads were priced against
  // measured event rates: more output per fire meant deeper, faster cascades,
  // and a probe run went from 6 overheats to 34 — one every ten seconds, which
  // is not a dial any more, it is weather.
  heatPerDepthEvent: 0.06,
  /**
   * §6.2 — the volume charge. See CycleBudget.chargeVolume for the curve and for
   * why it saturates instead of scaling.
   *
   * Free allowance first: 150 events/sec is a busy three-row Engine at minute
   * four, and it pays nothing. Everything above it is priced on a curve that
   * reaches half of `heatVolumeMax` at `heatVolumeHalf` events over the line.
   */
  heatFreeEventRate: 200,
  heatVolumeMax: 16,
  heatVolumeHalf: 1200,
  heatGainMaxPerSec: 45,
  heatDecayPerSec: 8,
  overheatStallSeconds: 3,
  overheatHeatReset: 50,
  instability1Misfire: 0.05,
  instability2Misfire: 0.15,
  instability2Corruption: 0.1,

  // ---- §11.2 suppression ----
  /** Seconds an Action already in flight keeps resolving after a zone lands. */
  suppressionGrace: 0,

  // ---- §11.3 interceptors ----
  /** Interceptor spawn weight scales with the player's live projectile count. */
  interceptorPerProjectile: 0.02,
  interceptorMaxWeight: 5,

  // ---- §10.3 elite affixes ----
  wardenFromThreat: 7,
  wardenInterval: 90,
  affixAdaptiveRate: 0.05,
  affixVolatileDamage: 22,
  affixVolatileRadius: 150,
  affixPhaseInterval: 3.5,
  affixPhaseDuration: 1,
  affixAnchoredZone: 190,
  /**
   * §10.2 Interceptor — how many projectiles it may eat before it is full.
   *
   * Seventeen meals at +10% compounding is a five-fold radius: a 14-unit body
   * becomes a 70-unit one, which is the biggest ordinary thing in the arena and
   * still fits on the screen twice over. Past that it stops eating and becomes a
   * Glutton, which is a bomb rather than a wall.
   */
  interceptorMaxMeals: 18,
  /**
   * How much of the radius growth the HP growth gets. Half: a Glutton is
   * enormous and killable, where matching them made it neither.
   */
  interceptorHpGrowthShare: 0.5,
  /**
   * How much of a meal a non-projectile hit is worth. A third: a Nova build
   * still grows Gluttons, three times slower than a build that feeds them whole
   * bolts, which is the right ordering — spraying projectiles should still be
   * the fastest way to build the thing that punishes spraying projectiles.
   */
  interceptorAreaMealShare: 0.34,
  /** A Glutton's death radius, as a multiple of its own body. */
  interceptorBlastScale: 2.2,
  interceptorBlastDamage: 34,
  /**
   * §11.2 — how many suppression fields may exist at once, queued included.
   *
   * Two, because a Suppressor does not add damage, it *subtracts the game*: with
   * three or more the arena grows regions where nothing you own does anything,
   * and "my engine stopped" is indistinguishable from "the engine is broken".
   * Two still forces you to move; a wall of them just forces you to wait.
   */
  suppressorsAlive: 2,

  /** §8.2 Momentum — the ceiling on the untouched bonus. */
  momentumCap: 0.4,

  // ---- §5.3 the new triggers ----
  /**
   * On Idle — how long a row must go without firing before it fires itself.
   */
  idleSeconds: 2,
  /** On Depth — the cascade depth that counts as deep. Matches heatFreeDepth+3. */
  onDepthAt: 5,

  // ---- §5.3 / §5.5 node behaviour ----
  /** §8.2 — base crit chance. Crits hit harder and emit their own event. */
  critChance: 0.05,
  critMultiplier: 2,
  /**
   * Overdrive buys output with Heat directly, bypassing the budget. Deliberately
   * modest per fire: against the 8/sec decay it is nearly free on a slow Clock
   * and genuinely dangerous on a high-frequency cascade, which is the tradeoff
   * worth having.
   */
  overdriveHeatPerFire: 1.5,
  /** Volatile detonation radius. */
  volatileRadius: 90,
  /**
   * Cascade pricing. §23.1: a power break that still costs Cycles and still
   * requires the player to move is protected content — answer it "by pricing,
   * never by deleting the interaction". So a cascade that walks across the
   * arena stays possible, and simply gets more expensive and less rewarding the
   * further it travels from the thing that started it.
   *
   * Output falls off geometrically with depth; Cycle cost climbs linearly. At
   * depth 5 that is roughly 29% output for 3.5x the price, which throttles a
   * runaway without ever refusing to run it.
   *
   * The weight sits deliberately on the cost side. Deleted damage is invisible —
   * the player just notices things dying slower and blames the game. Cost is
   * legible: it drains Cycles, which becomes Heat, which is now a gauge you can
   * watch climb. Same throttle, but the player can see the bill.
   */
  cascadeOutputFalloff: 0.78,
  /**
   * And how far it reaches, per link.
   *
   * Measured on a recorded cascade build: hits at depth 0 landed 308 units from
   * the player on average, hits at depth 8+ landed 685 with a maximum of 1,600 —
   * and 95% of all hits were deep ones. A cascade did not spread, it *walked*,
   * because every link starts where the last one landed and then travels its own
   * full range again. The result is a screen where everything dies everywhere,
   * most of it off the top and bottom of the view.
   *
   * So reach decays with depth exactly as output does. A depth-12 bolt travels
   * 22% as far as a depth-0 one: the chain still crosses ground, but it converges
   * on where it started instead of migrating off the map.
   */
  cascadeReachFalloff: 0.88,
  cascadeCostGrowth: 0.5,
  /** Orbitals stack, so they need a ceiling and a per-enemy hit cadence. */
  maxOrbitals: 14,
  orbitalHitCooldown: 0.45,
  /**
   * §23.1 — displacement budget per enemy per second for Shove. "Permanent
   * knockback walls" is a named tension break: if stacked Shoves can hold the
   * horde off forever the game stops asking the player to move, and that is a
   * bug to fix rather than a power break to protect.
   */
  shoveBudgetPerSecond: 320,
  /**
   * §17.1 — "every avoidable hit is preceded by a drawn line." A Lancer beam had
   * no length limit, so a Lancer you could not see could kill you along a line
   * you were never shown. The range is now barely past its standoff: if it can
   * hit you, it is close enough to be on screen and therefore dodgeable.
   */
  lancerBeamRange: 900,
  /**
   * And a §23.1 guard on the other side of the same problem. Lancers arriving in
   * numbers turned "the reason to keep moving" into an unavoidable crossfire —
   * measured at 88% of a whole run's damage. Only this many may charge at once;
   * the rest wait their turn, so the arena never has more telegraphs than a
   * player can read.
   */
  maxChargingLancers: 2,
  /** §18.2 — the beat grid. Quantize snaps to it; audio will lock to it later. */
  beatsPerMinute: 110,
  quantizeBonus: 0.25,

  // ---- §7.3 ground clutter ----
  /**
   * §7.3 — "when ground shards exceed ~200, the oldest merge into fewer, richer
   * shards. Invisible when it works; mandatory." It is mandatory because at this
   * kill volume uncollected loot buries the arena: the enemies stop being
   * visible behind their own drops.
   */
  /**
   * §7.3 puts this at ~200, but at 200 a big kill visibly *loses* loot: the mass
   * of drops is the reward, and merging them away makes a screen-clear read as
   * sad rather than triumphant. There is frame budget for far more, so
   * consolidation is now a safety valve against unbounded growth rather than a
   * routine tidy-up — it should almost never be visible.
   */
  pickupSoftCap: 700,
  /**
   * §7.3 The Magnet — the rare drop that sweeps every shard on the map.
   *
   * The pair of numbers is a cadence, not odds: the cooldown sets how often one
   * *can* exist, the chance decides how long after that it takes to actually
   * fall. Forty seconds and 2% means roughly one a minute in ordinary play, and
   * — because the cooldown is wall-clock rather than per-kill — still roughly
   * one a minute when the Engine is deleting two thousand enemies a second.
   */
  // Halved in frequency after play: one a minute was often enough that the
  // sweep stopped being an event. Eighty seconds is roughly one every two
  // level-ups.
  magnetCooldown: 80,
  magnetDropChance: 0.02,
  /** Radius within which drops of the same kind merge. Local, so piles keep their shape. */
  consolidateRadius: 90,
  consolidateInterval: 0.6,


  // ---- §8 leveling & draft ----
  /**
   * The first level-up has its own cost. §3 demands "a decision every ~30
   * seconds" and the opening is the one place a starting Engine cannot keep up —
   * bending the whole curve to fix the first 40 seconds distorts everything after
   * it, so the opening gets its own lever.
   */
  xpFirstLevel: 5,
  /**
   * Retuned for the sustained-pressure director. Holding density instead of
   * dumping fixed waves raised kills per run from ~3.9k to ~26k, so a curve
   * built for the old volume delivered a draft every ten seconds.
   */
  /**
   * Retuned after §5.4's origin fix. Actions now originate on the avatar rather
   * than wherever the triggering event happened, which is a large nerf to
   * cascade builds — `On Hit -> Bolt` used to spawn its projectile *at the
   * enemy*, granting free range on every rebound.
   */
  xpBase: 11,
  xpGrowth: 1.34,
  xpPerShard: 1,
  draftCards: 3,
  rerollsPerRun: 2,
  /**
   * §8.3 — what a reroll costs once the banked ones are gone, in Heat, rising
   * with each reroll in the same draft. Twelve is about a second and a half of
   * venting: real, payable, and it stacks into something you have to think about
   * if you reroll three times looking for one card.
   */
  rerollHeatCost: 12,
  /**
   * §8.2 — a node offered and refused this many times stops being offered.
   *
   * Measured: a run refused six Program Slots and the pool kept asking. The
   * draft is supposed to read what you own; reading what you have *rejected* is
   * the same idea and it costs one counter.
   */
  refusalsBeforeDrop: 3,
  purgesPerRun: 1,
  /**
   * §8.3 — "+1 from certain drafts". The two tools differ in kind, so they are
   * priced differently: a Reroll is another look at the pool you have, a Purge
   * permanently narrows that pool. Purge is the tailoring tool and therefore the
   * scarce one — it comes two at a time and appears about a third as often.
   */
  rerollCardAmount: 2,
  purgeCardAmount: 2,
  maxQueuedDrafts: 3,
  capacityUpgradeAmount: 15,

  // ---- §5.7 scrap ----
  scrapOutputBonus: 0.04,

  /**
   * §20.1 — how many detonations may be on screen at once.
   *
   * Measured before this existed: a Nova cascade at 5,882 EPS held six thousand
   * live effects and cost 65ms a frame, 58 of them inside the bloom composite.
   */
  maxFx: 300,
  /**
   * §20.1 — how close a live detonation has to be for a new one of the same hue
   * to be redundant, as a fraction of the new one's radius.
   *
   * Half a radius is deep overlap: the two rings are the same ring. Raising it
   * starts eating detonations that were telling you about a different place.
   */
  fxCrowdRadius: 0.5,
  /**
   * ...and how much life the one already there must have left, as a fraction.
   *
   * Above half, so the ring on screen is still early enough to read as the
   * explosion the suppressed one would have drawn. A ring that is nearly done
   * is not standing in for anything, and the new detonation is allowed.
   */
  fxCrowdLife: 0.55,

  // ---- §21b.4 the Cooler ----
  /**
   * A place you stand to vent. Worth more than any Coolant card and impossible
   * to take with you — the trade is that using it means being somewhere.
   */
  coolerRadius: 240,
  coolerVenting: 26,

  // ---- §12.4 the Cache ----
  /**
   * A POI you channel for a free draft, paid for by the current composition
   * arriving again in its hardest form. The interval is deliberately close to
   * the level cadence (§1.3's decision every ~30s): a Cache should feel like an
   * *extra* draft you fought for, not a replacement for levelling.
   */
  cacheChannelTime: 2.2,
  cacheInterval: 75,
  cacheFromTime: 45,
  /**
   * LEVELS §6 — stations and fragments. Short, because the price of a document
   * is walking to it, not standing still next to it while the room closes in.
   */
  stationChannelTime: 1.2,
  /**
   * How big the menagerie is, as a share of the director's density target.
   *
   * Came down from 1.15 once the gate siege existed to be the hard thing. A
   * Cache is a purchase — you get a card and pay for it — and it was landing at
   * more than a full density target of hardened enemies on top of the flow,
   * which is siege weight for a box you walk past.
   */
  cacheWaveFraction: 0.8,
  /**
   * The ring the menagerie arrives in, around the Cache itself. Wide, because
   * everything landing on top of you is a shove rather than a fight, and it
   * should read as the *place* waking up.
   */
  /**
   * §12.4 — how far past the run's current Threat a Cache may reach when it
   * hardens a wave, in Threat points.
   *
   * This is the whole "strong upgrade, not a jump to the ceiling" dial. At 0 a
   * Cache spawns exactly the wave you were already fighting and the price is
   * fake; far too high and it is the old behaviour, where minute two and minute
   * twenty opened the same box. The room's roster tier caps it regardless.
   */
  cacheThreatLead: 2,
  /**
   * §21b.5 — how fast a hold drains when you step off it, as a fraction of how
   * fast it fills. Ordinary POIs only.
   *
   * `gateDrainRate` used to sit beside this at a quarter of the fill rate, on
   * the reasoning that losing twenty seconds of holding to one dodge punishes
   * playing well. True, and it turned out to be the smaller half of the problem:
   * a siege is *scheduled off the bar*, so a bar that rewinds re-delivers waves
   * that were already fought. Backing off meant meeting the same parcel again,
   * and hovering just below a threshold meant farming one forever. A gate does
   * not drain at all now — see `updateTerminals` — and the dial is gone rather
   * than left at zero, because a knob that does nothing answers "where do I tune
   * this" with a lie.
   */
  poiDrainRate: 0.6,
  /**
   * §9.1 — how still "standing still" is, in units per second.
   *
   * Recompile is the one POI that must be channelled stationary. Nonzero
   * because a controller's dead zone and a keyboard's release frame both leave a
   * few units of drift, and failing a twelve-second channel on that is a bug the
   * player experiences as the game lying.
   */
  stillnessSpeed: 12,
  /** §5.4 Orbital — contact padding, so a graze counts as a hit. */
  orbitContactPad: 12,
  /**
   * §21b.7 — the gate siege's shape lives in waveevents.json, not here.
   *
   * `siegeDensity`, `siegeOpening`, `siegeInterval`, `siegeAffixes` and the ring
   * bounds used to be read from this file. They were superseded when called
   * waves became data and then sat here for a week reading like live dials while
   * nothing looked at them — the same trap `RosterDef.events[].maxAlive` was.
   * A knob that does nothing is worse than no knob: it answers the question
   * "where do I tune this" with a lie.
   *
   * The one that is still real is this, because it scales the *director*, which
   * is not part of any wave event.
   *
   * §21b.7 — how much of the ambient floor the director still holds while a gate
   * is being held.
   *
   * `sustainPressure` *maintains* density rather than budgeting it, so during a
   * hold every siege enemy killed inside the pressure radius opened a deficit
   * the director closed within a second at sixty-seven a second. Killing bought
   * nothing and retreating bought nothing: the fight was not hard, it was
   * unresolvable. At a third, killing visibly thins the room and walking out
   * resets it, while the arena still does not fall silent between parcels.
   *
   * It scales the floor only. Siege parcels are sized off the unscaled target,
   * or this one number would quietly shrink the siege too — but it and the
   * parcel shares in waveevents.json are still one balance decision in two
   * files, and moving either alone will not do what you expect.
   */
  siegeAmbientFraction: 0.35,
  cacheRingMin: 380,
  cacheRingMax: 900,
  /**
   * What "hardened" is worth. A Cache's wave is opt-in difficulty, so it is the
   * one place in the game where a straight multiplier is honest: the player
   * pressed the button, the card is already in their hand, and the elite version
   * of a wave has to be *significantly* stronger or the price was fake.
   */
  // §12.5 — hardenedHp and hardenedDamage used to live here. They are `toughen`
  // ops in waveevents.json now, next to the wave that chooses them, because a
  // single global "how much harder is hardened" only ever fits one wave and the
  // game has four.

  /**
   * §21b.6 — how far behind the player an enemy may fall before it is moved to
   * the front. Three screen-widths: far enough that nothing is ever recycled
   * while it could plausibly be seen, close enough that the fight travels with
   * the player on a map twenty screens across.
   */
  recycleDistance: 2900,
  /**
   * §21b.7 — how far in front of a barrier a siege emerges, in units.
   *
   * Far enough clear of the wall that nothing starts inside it and gets pathed
   * around its own doorway; close enough that the door is visibly where they are
   * coming from. The gate circle sits about 290 units from the barrier face, so
   * this also keeps the mouth outside `spawnSafeRadius` of a player holding it —
   * the safe radius still enforces that, this just means it rarely has to.
   */
  doorMouth: 60,

  // ---- §12 director ----
  /**
   * LEVELS §1 — Threat reaches ~24 by the 13:00 Meltdown line, the scale the
   * wave bands use. Was 0.02 against a 20:00 line; the run was re-cut to
   * ~15 minutes total and the slope moved so the endgame bands still arrive.
   */
  threatPerSecond: 0.031,
  /**
   * §12.1 — how much Threat one *step* is, for the player's benefit only.
   *
   * Threat is continuous underneath and nothing about the director changes here.
   * What changes is that it becomes sayable: people do not perceive a smooth
   * invisible variable, they perceive events, which is exactly why Heat is a
   * float with named tiers and nobody has ever said "I am at 63 Heat".
   *
   * 1.8 is ninety seconds. The binding constraint is that a step must be rarer
   * than a composition rotation (`compositionDuration`, 26s) — at parity every
   * rotation would be an escalation and the player would learn to ignore both.
   * Two to three compositions per step, and about a dozen steps before Meltdown,
   * which is a legible number of difficulty levels to have lived through.
   */
  threatPerStep: 1.8,
  /** How long one composition holds before the director rotates to another. */
  compositionDuration: 26,
  /** The burst that announces a new composition, as a fraction of target density. */
  compositionArrivalFraction: 0.28,
  /**
   * The density the director actively *maintains*, not a cap it stops at.
   *
   * A wave used to be a fixed quantity: spawn N, and if the player cleared them
   * the arena sat empty until the next one. That produced exactly the wrong
   * rhythm — delete everything, then wander around collecting in silence. A wave
   * is now a *composition*, and the director keeps feeding that composition in
   * until it is replaced. The screen should never empty.
   */
  /**
   * The base has to stay low: resupply is now fast enough to reach the target
   * almost immediately, so the target *is* the difficulty curve. A base of 30
   * met a starting Engine with a standing wall of 30 enemies and killed every
   * run inside five minutes.
   */
  targetAliveBase: 10,
  targetAlivePerThreat: 16,
  /**
   * Density is measured within this radius of the player, not arena-wide. A
   * global count let a queue trailing behind you consume the whole budget, so
   * nothing spawned ahead and you could simply outrun the game.
   */
  pressureRadius: 1500,
  /**
   * Share of spawns placed ahead of the player's travel while they are moving.
   * Fleeing should cost something without becoming a wall.
   */
  forwardSpawnBias: 0.6,

  // ---- enemy movement personality ----
  /** Slow per-enemy weave, so a shared flow field does not produce one queue. */
  weaveRate: 1.1,
  weaveAmount: 0.5,
  /** Separation, so they spread across a front instead of stacking on a point. */
  separationRadiusMult: 4.5,
  separationStrength: 0.85,
  speedVariance: 0.18,
  /** Ceiling, for the §16.1 legibility budget and for frame time. */
  maxAliveHard: 900,
  /**
   * How fast the director can close a density deficit, enemies per second. This
   * has to exceed a strong engine's kill rate or the arena empties anyway — the
   * ceiling on pressure is the density target, not the rate of resupply.
   */
  refillRateBase: 30,
  refillRatePerThreat: 8,
  /** How much of the deficit it tries to close each second, 0..1. */
  refillAggression: 0.55,
  /**
   * Enemies this far from the player are silently removed, with no drops. Not in
   * the GDD, but required once the arena is bigger than the view: without it,
   * stragglers the player has outrun accumulate forever and eat the population
   * budget that should be producing pressure where the player actually is.
   */
  despawnRadius: 2600,
  /**
   * §12.2 — "No spawn-on-top-of-player, ever." The guarantee is load-bearing;
   * only the radius is tunable. Enforced in World.updateDirector.
   */
  spawnSafeRadius: 260,
  /**
   * §12.2 — spawns arrive off-screen. The sim has no camera (that would make the
   * simulation depend on the viewport and break determinism across window
   * sizes), so it reasons about a *nominal* view: the largest field any window
   * can show. The ring sits outside that rectangle's half-diagonal
   * (hypot(950, 450) ~= 1051), with margin.
   */
  nominalViewWidth: 1900,
  nominalViewHeight: 900,
  spawnRingMin: 1180,
  spawnRingMax: 1480,
  /** Candidate directions considered when placing a wave. */
  spawnCandidates: 12,
  /** Spread of arrival times within a composition's announcing burst. */
  waveArrivalSpread: 1.6,
  /** Seconds an enemy takes to draw itself in (§17.1). Presentation only. */
  spawnFadeTime: 0.28,

  // ---- §12.3 wave beacons ----
  beaconInterval: 75,
  beaconChannelTime: 1.5,
  beaconDropBonus: 0.5,
  beaconThreatBump: 1.0,
  beaconRadius: 34,
  maxBeacons: 2,

  // ---- §9 Recompile ----
  /** LEVELS §1 — terminals from ~5:20, the same share of a 13:00 build phase
   * that minute 8 was of a 20:00 one. */
  recompileFromTime: 320,
  recompileInterval: 70,
  recompileChannelTime: 3,
  recompileCapacityGain: 20,
  /**
   * §9.1 — K scales with the deleted Engine's *recent average* output, measured
   * as an EWMA with this half-life. It has to be an average over a window rather
   * than an all-time peak: with a peak, the number you get is the same whenever
   * you press the button, and §9.2's "Recompiling at your peak clearly beats
   * hoarding" becomes false.
   */
  kernelAverageHalfLife: 10,
  /**
   * These have to be generous. §9.2: "The Kernel formula must make Recompiling
   * at your peak clearly better than hoarding — hoarding a solved build to
   * Meltdown should be the noob trap." Measured at the first pass, the reverse
   * was true: a pilot that never recompiled outlived one that did by 50%.
   */
  kernelBasePercent: 15,
  kernelPercentPerEps: 1.5,
  kernelMaxPercent: 220,
  /**
   * The Kernel scales with sacrificed share raised to this power.
   *
   * At 1.0 (linear) the incentive gradient runs backwards: burning your weakest
   * row four times pays the same as burning everything once, but costs almost
   * nothing in survival — so nibbling dominates and §9.2's "Recompiling at your
   * peak clearly beats hoarding" is false in the other direction. Above 1, a
   * large sacrifice pays disproportionately more than the sum of small ones,
   * which is what makes committing the correct greedy play.
   */
  kernelShareExponent: 1.9,
  /** Rebuild surge: double XP, and the next few drafts widen. */
  /**
   * §9.1's documented values. These were briefly raised to 6x/180s while testing
   * whether rebuild speed was the binding constraint on Recompile (it was not),
   * and leaving them there turned the surge into the mechanic's real payout:
   * burning a near-dead row bought 34s of sextupled XP for no meaningful loss.
   * A reward that large must not be purchasable that cheaply.
   */
  rebuildSurgeTime: 120,
  rebuildSurgeXpMult: 2,
  rebuildSurgeDrafts: 3,
  rebuildSurgeCards: 4,

  // ---- §12.4 Extraction ----
  /**
   * LEVELS §1 — there is always a way out from 5:00. The terminal stands at
   * the arena's far landmark (in the Sink), so in practice it appears at 5:00
   * or the moment the Sink opens, whichever is later. The operations order
   * derives its clock from this number; onboarding notice 4 defers to the
   * operations order rather than quoting a time that can rot.
   */
  extractFromTime: 300,
  extractChannelTime: 5,

  // ---- §13.2 Meltdown ----
  /**
   * LEVELS §1 — the run is ~15 minutes total: 13:00 of build, then a Meltdown
   * the player should not survive past ~2:00 of. The multiplier steps twice as
   * fast as it did against the 20:00 line, because ×2-at-death was never a
   * third act — in a two-minute Meltdown the number has to move while it lasts.
   */
  meltdownAt: 780,
  meltdownMultiplierStep: 0.25,
  meltdownStepSeconds: 15,

  // ---- §11.4 Containment ----
  /**
   * LEVELS §1 — tightened for the two-minute Meltdown: overlap should become
   * unsurvivable around +2:00. Unmeasured until real runs reach it — no harness
   * run ever has (BALANCE.md) — so these are the first guess, not the last.
   */
  containmentFirstDelay: 8,
  containmentIntervalBase: 12,
  containmentIntervalMin: 3,
  containmentIntervalPerMinute: 2.4,
  sweeperSpeed: 210,
  sweeperGapWidth: 260,
  sweeperDamage: 26,
  cellDuration: 7,
  cellStartRadius: 620,
  cellEndRadius: 90,
  cellGaps: 3,
  cellDamagePercent: 0.18,
  nullFrontDuration: 10,
  nullFrontDepth: 620,
  nullFrontDamage: 14,

  // ---- §13 scoring ----
  epsSmoothingWindow: 5,
  /** Sampling period for the Results run-trace chart (§14). */
  epsTraceInterval: 0.5,
  scorePerKernel: 250,
  scorePerMirrorKill: 500,
} as const;

export const LOADBEARING = {
  /** §5.1 — Programs start at 4, expandable to 8. */
  programSlotsStart: 4,
  programSlotsMax: 8,
  /** §5.1 — three modifier slots per Program. */
  modifierSlotsPerProgram: 3,
  /** §5.2 — hard cascade depth cap. Runtime safety, not balance. */
  cascadeDepthCap: 12,
  /** §5.5 — Split makes 3 copies. */
  splitCopies: 3,
} as const;

/**
 * Runtime safety valves. Not design numbers: these exist so a degenerate build
 * cannot hang the browser. Crossing one is a bug worth logging, never a balance
 * lever (GDD §5.2: "The wall exists for the runtime's safety, not for balance").
 */
export const SAFETY = {
  maxEventsPerTick: 24000,
  maxEntities: 6000,
  maxFireExecutions: 256,
  maxScheduledFires: 8000,
  /**
   * Live persistent zones. `On Hit -> Field` is self-feeding: every hit drops a
   * zone, every zone tick lands hits, and those hits drop more zones. Observed
   * at 5,237 live zones against 3 remaining enemies. The Cycle economy does
   * respond (it stalls), but a runtime cannot be left to discover that at five
   * thousand entities. Oldest zone is evicted when the cap is reached.
   */
  maxZones: 45,
} as const;

/**
 * Camera. The arena is authored content (src/content/data/arenas.json), far
 * larger than the viewport — §19.4's off-screen edge indicators and §12.3's
 * beacons only mean anything if there is somewhere to be that you cannot see.
 */
export const CAMERA = {
  /** Design width of the visible field. The view scales to fit the window. */
  viewWidth: 1600,
  viewHeight: 900,
  /** How far the view leads the player's movement, in world units. */
  lookahead: 130,
  /** Seconds for the camera to close most of the distance to its target. */
  smoothing: 0.12,
} as const;
