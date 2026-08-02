import { describe, expect, it } from 'vitest';
import { NO_INPUT, World, type InputState } from './world';
import { hashWorld } from './hash';
import { LOADBEARING, SAFETY, SIM_DT, TUNABLE } from './tunables';
import { CycleBudget } from './cycles';
import { Rng } from './rng';
import { botInput } from '../harness/bot';
import { applyDraft, rollDraft } from './draft';

/** Run with the harness pilot, which actually collects fuel and XP. */
function runPiloted(world: World, seconds: number): void {
  const ticks = Math.round(seconds / SIM_DT);
  for (let i = 0; i < ticks; i++) world.advance(botInput(world));
}

/** A scripted, wall-clock-free input sequence. Same ticks -> same inputs. */
function scriptedInput(tick: number): InputState {
  const t = tick * SIM_DT;
  return {
    moveX: Math.cos(t * 0.7),
    moveY: Math.sin(t * 0.45),
    dash: tick % 300 === 0,
    interact: false,
  };
}

function runFor(world: World, seconds: number): void {
  const ticks = Math.round(seconds / SIM_DT);
  for (let i = 0; i < ticks; i++) world.advance(scriptedInput(world.tickCount));
}

describe('determinism (GDD §0)', () => {
  it('two worlds with the same seed and inputs stay bit-identical', () => {
    const a = new World({ seed: 'alpha', axiomId: 'ignition' });
    const b = new World({ seed: 'alpha', axiomId: 'ignition' });
    runFor(a, 60);
    runFor(b, 60);
    expect(hashWorld(a)).toBe(hashWorld(b));
    expect(a.stats.kills).toBe(b.stats.kills);
    expect(a.score).toBe(b.score);
  });

  it('different seeds diverge', () => {
    const a = new World({ seed: 'alpha', axiomId: 'ignition' });
    const b = new World({ seed: 'beta', axiomId: 'ignition' });
    runFor(a, 30);
    runFor(b, 30);
    expect(hashWorld(a)).not.toBe(hashWorld(b));
  });

  it('replays identically when resumed from the same seed mid-run', () => {
    const a = new World({ seed: 'gamma', axiomId: 'circuit' });
    runFor(a, 20);
    const checkpoint = hashWorld(a);

    const b = new World({ seed: 'gamma', axiomId: 'circuit' });
    runFor(b, 20);
    expect(hashWorld(b)).toBe(checkpoint);

    runFor(a, 20);
    runFor(b, 20);
    expect(hashWorld(a)).toBe(hashWorld(b));
  });
});

describe('the run actually runs', () => {
  it('spawns, kills, drops fuel and levels the player', () => {
    const w = new World({ seed: 'run-1', axiomId: 'ignition' });
    // Two minutes should clear the §8.1 cadence target of a level every 30-45s.
    runPiloted(w, 120);
    expect(w.stats.fires).toBeGreaterThan(0);
    expect(w.stats.kills).toBeGreaterThan(0);
    expect(w.stats.events).toBeGreaterThan(0);
    expect(w.level).toBeGreaterThan(1);
    expect(w.score).toBeGreaterThan(0);
    expect(w.fuel.thermal + w.fuel.voltaic + w.fuel.void).toBeGreaterThan(0);
  });

  it('never spawns an enemy on top of the player', () => {
    const w = new World({ seed: 'spawn-safety', axiomId: 'ignition' });
    for (let i = 0; i < 60 * 60; i++) {
      const before = w.enemies.length;
      w.advance(scriptedInput(w.tickCount));
      if (w.enemies.length > before) {
        for (let j = before; j < w.enemies.length; j++) {
          const e = w.enemies[j]!;
          const d = Math.hypot(e.x - w.player.x, e.y - w.player.y);
          // Splitter children are allowed to appear near the player; wave spawns
          // come from off-screen edges and are held at the safe radius (§12.2).
          if (e.defId !== 'charger') {
            expect(d).toBeGreaterThanOrEqual(TUNABLE.spawnSafeRadius - 0.001);
          }
        }
      }
    }
  });
});

describe('navigation (GDD §22 — ruins are cover, not walls that trap)', () => {
  /** The Heap's ruin at x 2400..2540, y 980..1320 — a tall block. */
  it('an enemy walks around a ruin instead of pressing against it', () => {
    const w = new World({ seed: 'nav', axiomId: 'ignition' });
    // Player just west of the block, enemy directly east of it: the straight
    // line between them is fully obstructed.
    w.player.x = 2330;
    w.player.y = 1150;
    w.enemies.length = 0;
    const e = w.spawnEnemy('drifter', 2610, 1150, 'thermal')!;
    w.engine.programs.forEach((p) => {
      p.triggerId = null;
      p.actionId = null;
    });
    w.engine.recompile();
    w.syncBudget();

    const startDistance = Math.hypot(e.x - w.player.x, e.y - w.player.y);
    let closest = startDistance;
    for (let i = 0; i < 60 * 12; i++) {
      w.advance(NO_INPUT);
      if (!e.alive) break;
      closest = Math.min(closest, Math.hypot(e.x - w.player.x, e.y - w.player.y));
    }

    // Without navigation it would sit against the far face, ~280 units away.
    expect(closest).toBeLessThan(60);
  });

  it('leaves open-field pursuit alone', () => {
    const w = new World({ seed: 'nav-open', axiomId: 'ignition' });
    w.player.x = 700;
    w.player.y = 700;
    w.enemies.length = 0;
    const e = w.spawnEnemy('drifter', 700, 1150, 'thermal')!;
    w.engine.programs.forEach((p) => {
      p.triggerId = null;
      p.actionId = null;
    });
    w.engine.recompile();
    w.syncBudget();

    for (let i = 0; i < 60 * 4; i++) {
      w.advance(NO_INPUT);
      if (!e.alive) break;
    }
    // A clear approach should be close to a straight line: no sideways detour.
    expect(Math.abs(e.x - 700)).toBeLessThan(40);
    expect(Math.hypot(e.x - w.player.x, e.y - w.player.y)).toBeLessThan(60);
  });
});

describe('the horde is continuous, not lumpy', () => {
  it('holds density against an engine that clears the screen', () => {
    // The failure this guards against: an engine strong enough to delete
    // everything buys itself seconds of empty arena. A wave is a composition the
    // director keeps feeding, not a quantity it dumps once.
    const w = new World({ seed: 'pressure', axiomId: 'ignition' });
    const rows: [string, string, string | null][] = [
      ['clock', 'nova', 'amplify'],
      ['on_kill', 'nova', 'split'],
      ['on_hit', 'arc', 'amplify'],
    ];
    rows.forEach(([trigger, action, modifier], i) => {
      const p = w.engine.programs[i]!;
      p.triggerId = trigger;
      p.actionId = action;
      p.modifierIds[0] = modifier;
    });
    w.engine.recompile();
    w.syncBudget();

    runPiloted(w, 90);

    let starved = 0;
    let worstGap = 0;
    let gap = 0;
    const ticks = 60 * 150;
    for (let i = 0; i < ticks; i++) {
      w.player.alive = true;
      w.player.integrity = w.player.maxIntegrity;
      w.advance(botInput(w));
      // "Starved" means well under the density the director is aiming to hold.
      if (w.enemies.length < w.targetAlive * 0.25) {
        starved++;
        gap++;
        worstGap = Math.max(worstGap, gap);
      } else {
        gap = 0;
      }
    }

    expect(w.stats.kills).toBeGreaterThan(500);
    expect(starved / ticks).toBeLessThan(0.1);
    expect(worstGap / 60).toBeLessThan(3);
  });

  it('never leaves the arena empty for long', () => {
    const w = new World({ seed: 'stream', axiomId: 'ignition' });
    // A deliberately over-powered engine: clears everything it can reach, which
    // is exactly the case where clumped spawning left dead air.
    const p = w.engine.programs[1]!;
    p.triggerId = 'on_kill';
    p.actionId = 'nova';
    p.modifierIds[0] = 'amplify';
    w.engine.recompile();
    w.syncBudget();

    // Skip the opening, then watch how long the arena sits empty.
    runPiloted(w, 45);

    let emptyTicks = 0;
    let longestEmptyRun = 0;
    let current = 0;
    const ticks = 60 * 120;
    for (let i = 0; i < ticks; i++) {
      w.advance(botInput(w));
      if (w.enemies.length === 0) {
        emptyTicks++;
        current++;
        longestEmptyRun = Math.max(longestEmptyRun, current);
      } else {
        current = 0;
      }
    }

    // Under 2% dead air, and never a gap longer than a couple of seconds.
    expect(emptyTicks / ticks).toBeLessThan(0.02);
    expect(longestEmptyRun / 60).toBeLessThan(2.5);
  });
});

describe('Recompile (GDD §9)', () => {
  function buildEngine(w: World): void {
    const p = w.engine.programs[0]!;
    p.triggerId = 'clock';
    p.actionId = 'bolt';
    p.modifierIds[0] = 'amplify';
    w.engine.recompile();
    w.syncBudget();
  }

  it('deletes drafted nodes, reboots to the Axiom, and forges a Kernel', () => {
    const w = new World({ seed: 'kernel', axiomId: 'ignition' });
    buildEngine(w);
    w.engine.scrapStacks = 3;
    runPiloted(w, 40);

    const capacityBefore = w.budget.capacity;
    const percent = w.recompile();

    expect(percent).toBeGreaterThan(0);
    // Every drafted node is gone...
    expect(w.engine.programs.slice(1).every((p) => !p.triggerId && !p.actionId)).toBe(true);
    expect(w.engine.programs[0]!.modifierIds.every((m) => m === null)).toBe(true);
    // ...but the Axiom's starter is restored (DECISIONS D-28). An Engine with no
    // live Program deals no damage, so it earns no XP, so it can never rebuild
    // itself — leaving it empty is a dead end, not a hard mode.
    expect(w.engine.programs[0]!.triggerId).toBe('clock');
    expect(w.engine.programs[0]!.actionId).toBe('bolt');
    expect(w.engine.compiled.some((c) => c.live)).toBe(true);
    // §9.1 — "Scrap bonuses are kept."
    expect(w.engine.scrapStacks).toBe(3);
    expect(w.engine.kernel).toBeCloseTo(1 + percent / 100, 8);
    expect(w.budget.capacity).toBe(capacityBefore + TUNABLE.recompileCapacityGain);
    expect(w.kernels).toBe(1);
    // Rebuild surge.
    expect(w.surgeTime).toBeCloseTo(TUNABLE.rebuildSurgeTime, 6);
    expect(w.surgeDrafts).toBe(TUNABLE.rebuildSurgeDrafts);
  });

  it('§9.2 — Recompiling at your peak beats hoarding', () => {
    // Two identical runs. One Recompiles while its engine is producing; the
    // other waits until the engine has been idle and its output has decayed.
    const hot = new World({ seed: 'peak', axiomId: 'ignition' });
    buildEngine(hot);
    runPiloted(hot, 60);
    const hotKernel = hot.recompile();

    const cold = new World({ seed: 'peak', axiomId: 'ignition' });
    buildEngine(cold);
    runPiloted(cold, 60);
    // Let it go quiet: strip the engine so EPS collapses before recompiling.
    for (const p of cold.engine.programs) {
      p.triggerId = null;
      p.actionId = null;
    }
    cold.engine.recompile();
    runPiloted(cold, 25);
    const coldKernel = cold.recompile();

    expect(hotKernel).toBeGreaterThan(coldKernel);
  });

  it('the rebuild surge doubles XP and widens the next drafts', () => {
    const w = new World({ seed: 'surge', axiomId: 'ignition' });
    buildEngine(w);
    w.recompile();
    const offer = rollDraft(w);
    expect(offer.cards).toHaveLength(TUNABLE.rebuildSurgeCards);

    applyDraft(w, offer.cards[0]!);
    expect(w.surgeDrafts).toBe(TUNABLE.rebuildSurgeDrafts - 1);
  });
});

describe('Meltdown and Containment (GDD §11.4, §13.2)', () => {
  it('enters Meltdown on time and climbs the multiplier', () => {
    const w = new World({ seed: 'melt', axiomId: 'ignition', meltdownAt: 20 });
    // This is about the clock, not about survival — advance() no-ops once the
    // player is down, which would stop time and the multiplier with it.
    const survive = (seconds: number): void => {
      for (let i = 0; i < Math.round(seconds / SIM_DT); i++) {
        w.player.alive = true;
        w.player.integrity = w.player.maxIntegrity;
        w.advance(botInput(w));
      }
    };

    expect(w.phase).toBe('build');
    survive(21);
    expect(w.phase).toBe('meltdown');
    expect(w.meltdownMultiplier).toBeCloseTo(1, 6);

    survive(61);
    // +0.25 per 30s survived, uncapped.
    expect(w.meltdownMultiplier).toBeCloseTo(1.5, 6);
    expect(w.markers.some((m) => m.kind === 'meltdown')).toBe(true);
  });

  it('spawns Containment only in Meltdown, and escalates it', () => {
    const w = new World({ seed: 'contain', axiomId: 'ignition', meltdownAt: 20 });
    runPiloted(w, 19);
    expect(w.containment).toHaveLength(0);

    runPiloted(w, 90);
    expect(w.containment.length).toBeGreaterThan(0);
    const kinds = new Set<string>();
    for (let i = 0; i < 60 * 240; i++) {
      // Keep the pilot alive: this test is about what the director produces,
      // not about whether a bot can survive Containment. `alive` matters as much
      // as integrity — advance() no-ops once the player is down.
      w.player.alive = true;
      w.player.integrity = w.player.maxIntegrity;
      w.advance(botInput(w));
      for (const c of w.containment) kinds.add(c.kind);
      if (kinds.size === 3) break;
    }
    // All three antagonists exist and appear.
    expect(kinds.size).toBe(3);
  });

  it('every Containment unit is telegraphed before it can hurt you (§17.1)', () => {
    const w = new World({ seed: 'telegraph', axiomId: 'ignition', meltdownAt: 5 });
    runPiloted(w, 6);
    let checked = 0;
    for (let i = 0; i < 60 * 120; i++) {
      w.advance(NO_INPUT);
      for (const c of w.containment) {
        if (c.age < c.telegraph) {
          expect(c.telegraph).toBeGreaterThan(0.5);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('death in Meltdown is CONTAINED, not a failure', () => {
    const w = new World({ seed: 'contained', axiomId: 'ignition', meltdownAt: 5 });
    for (let i = 0; i < 60 * 400 && w.player.alive; i++) w.advance(NO_INPUT);
    expect(w.player.alive).toBe(false);
    expect(w.ending).toBe('contained');
  });
});

describe('scoring and the run trace (GDD §13.3, §14)', () => {
  it('folds the Meltdown multiplier into score and reports the parts', () => {
    const w = new World({ seed: 'score', axiomId: 'ignition', meltdownAt: 30 });
    const p = w.engine.programs[0]!;
    p.triggerId = 'clock';
    p.actionId = 'bolt';
    w.engine.recompile();
    runPiloted(w, 120);

    const score = w.finalScore();
    expect(score.output).toBeGreaterThan(0);
    expect(score.multiplier).toBeGreaterThan(1);
    expect(score.total).toBe(score.output + score.kernelBonus + score.mirrorBonus);
  });

  it('records a trace and annotates it with the run\'s events', () => {
    const w = new World({ seed: 'trace', axiomId: 'ignition', meltdownAt: 40 });
    runPiloted(w, 90);
    expect(w.trace.length).toBeGreaterThan(100);
    expect(w.markers.some((m) => m.kind === 'level')).toBe(true);
    expect(w.markers.some((m) => m.kind === 'meltdown')).toBe(true);
    // Sampled on a fixed cadence that must not drift across a 25-minute run.
    const span = w.trace[w.trace.length - 1]!.t - w.trace[0]!.t;
    const meanCadence = span / (w.trace.length - 1);
    expect(meanCadence).toBeCloseTo(TUNABLE.epsTraceInterval, 3);
  });

  it('extraction banks at x1.0 and never gets the Meltdown multiplier', () => {
    const w = new World({ seed: 'extract', axiomId: 'ignition' });
    runPiloted(w, 30);
    w.terminals.length = 0;
    w.terminals.push({
      id: 1,
      kind: 'extract',
      x: w.player.x,
      y: w.player.y,
      progress: 0,
      age: 0,
      channelTime: TUNABLE.extractChannelTime,
      requiresStillness: false,
      alive: true,
    });
    for (let i = 0; i < 60 * 8 && w.player.alive; i++) {
      w.advance({ moveX: 0, moveY: 0, dash: false, interact: true });
    }
    expect(w.ending).toBe('extracted');
    expect(w.finalScore().multiplier).toBe(1);
  });
});

describe('runaway containment and arena legibility', () => {
  it('caps live zones, so On Hit -> Field cannot bury the runtime', () => {
    // Observed in play at 5,237 live zones against 3 remaining enemies: every
    // hit drops a zone, every zone tick lands hits, those hits drop more zones.
    const w = new World({ seed: 'field-runaway', axiomId: 'ignition' });
    const a = w.engine.programs[0]!;
    a.triggerId = 'on_hit';
    a.actionId = 'field';
    const b = w.engine.programs[1]!;
    b.triggerId = 'clock';
    b.actionId = 'nova';
    w.engine.recompile();
    w.syncBudget();

    let peakZones = 0;
    for (let i = 0; i < 60 * 120; i++) {
      w.player.alive = true;
      w.player.integrity = w.player.maxIntegrity;
      w.advance(botInput(w));
      peakZones = Math.max(peakZones, w.zones.length);
    }
    expect(peakZones).toBeLessThanOrEqual(SAFETY.maxZones);
    // The build still works — it is capped, not disabled.
    expect(w.stats.kills).toBeGreaterThan(200);
  });

  it('§7.3 — ground shards consolidate instead of burying the arena', () => {
    const w = new World({ seed: 'consolidate', axiomId: 'ignition' });
    // Leave row 0 as the Axiom's Clock -> Bolt: an On Kill row cannot produce
    // the kill that starts it.
    const p = w.engine.programs[1]!;
    p.triggerId = 'on_kill';
    p.actionId = 'nova';
    p.modifierIds[0] = 'split';
    w.engine.recompile();
    w.syncBudget();

    let peakPickups = 0;
    for (let i = 0; i < 60 * 180; i++) {
      w.player.alive = true;
      w.player.integrity = w.player.maxIntegrity;
      // Stand still so nothing is collected: the ground has to manage itself.
      w.advance(NO_INPUT);
      peakPickups = Math.max(peakPickups, w.pickups.length);
    }
    // Consolidation runs on an interval, so allow it headroom above the cap.
    expect(peakPickups).toBeLessThan(TUNABLE.pickupSoftCap * 2.5);
    expect(w.stats.kills).toBeGreaterThan(100);
  });

  it('spawns arrive from all sides, not in one directional queue', () => {
    const w = new World({ seed: 'compass', axiomId: 'ignition' });
    const quadrants = new Set<number>();
    let counted = 0;
    for (let i = 0; i < 60 * 90 && counted < 120; i++) {
      const before = w.enemies.length;
      w.advance(NO_INPUT);
      for (let j = before; j < w.enemies.length; j++) {
        const e = w.enemies[j]!;
        const angle = Math.atan2(e.y - w.player.y, e.x - w.player.x);
        quadrants.add(Math.floor(((angle + Math.PI) / (Math.PI * 2)) * 8) % 8);
        counted++;
      }
    }
    // All eight compass octants should see arrivals; a procession would not.
    expect(quadrants.size).toBeGreaterThanOrEqual(7);
  });
});

describe('pressure attacks the build, not the health bar (GDD §11)', () => {
  function quietWorld(seed: string): World {
    const w = new World({ seed, axiomId: 'ignition' });
    w.enemies.length = 0;
    return w;
  }

  it('§11.1 — mono-hue output builds resistance to that hue, capped', () => {
    const w = quietWorld('resist');
    const p = w.engine.programs[0]!;
    p.triggerId = 'clock';
    p.actionId = 'bolt'; // thermal only
    w.engine.recompile();
    w.syncBudget();

    runPiloted(w, 120);

    expect(w.resistance.thermal).toBeGreaterThan(0.2);
    expect(w.resistance.thermal).toBeLessThanOrEqual(TUNABLE.resistanceCap + 1e-9);
    // Hues you have not used are not taxed.
    expect(w.resistance.voltaic).toBe(0);
  });

  it('§11.1 — splitting damage between hues is taxed far less than mono-hue', () => {
    // Resistance follows the share of *damage*, not the number of Actions owned:
    // an Action that ticks an area will dominate the split however many other
    // Actions sit beside it. Two comparable single-hit Actions are the honest
    // test of the mapping.
    const mono = quietWorld('mono');
    const m = mono.engine.programs[0]!;
    m.triggerId = 'clock';
    m.actionId = 'bolt';
    mono.engine.recompile();
    mono.syncBudget();
    runPiloted(mono, 120);

    const split = quietWorld('mono');
    const a = split.engine.programs[0]!;
    a.triggerId = 'clock';
    a.actionId = 'bolt'; // thermal
    const b = split.engine.programs[1]!;
    b.triggerId = 'clock';
    b.actionId = 'arc'; // voltaic
    split.engine.recompile();
    split.syncBudget();
    runPiloted(split, 120);

    const worstMono = Math.max(mono.resistance.thermal, mono.resistance.voltaic);
    const worstSplit = Math.max(split.resistance.thermal, split.resistance.voltaic);

    // The contract is the relationship, not an absolute number: Arc chains to
    // three targets and so out-damages Bolt, which keeps the split uneven even
    // with one Action per hue. Splitting must simply cost less than mono-hue.
    expect(worstSplit).toBeLessThan(worstMono);
    expect(worstSplit).toBeLessThan(TUNABLE.resistanceCap * 0.85);
  });

  it('§11.2 — a Suppressor silences triggers, and killing it restores them', () => {
    const w = quietWorld('suppress');
    const p = w.engine.programs[0]!;
    p.triggerId = 'clock';
    p.actionId = 'bolt';
    w.engine.recompile();
    w.syncBudget();

    // Firing normally first.
    for (let i = 0; i < 120; i++) w.advance(NO_INPUT);
    const baseline = w.stats.fires;
    expect(baseline).toBeGreaterThan(0);

    const suppressor = w.spawnEnemy('suppressor', w.player.x + 40, w.player.y, 'void')!;
    for (let i = 0; i < 180; i++) w.advance(NO_INPUT);
    expect(w.suppressedNow).toBe(true);
    const whileSuppressed = w.stats.fires - baseline;
    expect(whileSuppressed).toBe(0);

    // It is fragile on purpose: remove it and the engine comes straight back.
    suppressor.alive = false;
    for (let i = 0; i < 180; i++) w.advance(NO_INPUT);
    expect(w.suppressedNow).toBe(false);
    expect(w.stats.fires).toBeGreaterThan(baseline);
  });

  it('§10.2 — a Bulwark blocks projectiles from the front but not the flank', () => {
    const w = quietWorld('bulwark');
    w.engine.programs.forEach((p) => {
      p.triggerId = null;
      p.actionId = null;
    });
    w.engine.recompile();

    const shootAt = (ox: number, oy: number): number => {
      const e = w.spawnEnemy('bulwark', w.player.x + 200, w.player.y, 'thermal')!;
      const before = e.hp;
      w.projectiles.push({
        id: 9001,
        x: e.x + ox,
        y: e.y + oy,
        vx: -ox * 6,
        vy: -oy * 6,
        life: 2,
        damage: 30,
        pierce: 0,
        hue: 'thermal',
        depth: 0,
        programIndex: 0,
        radius: 4,
        corrupted: false,
        hits: [],
        age: 0,
        alive: true,
      });
      for (let i = 0; i < 30; i++) w.advance(NO_INPUT);
      const dealt = before - e.hp;
      e.alive = false;
      return dealt;
    };

    // The Bulwark faces the player, who is to its west; hit it from the west.
    const fromFront = shootAt(-60, 0);
    const fromBehind = shootAt(60, 0);
    expect(fromFront).toBe(0);
    expect(fromBehind).toBeGreaterThan(0);
  });

  it('§10.2 — an Interceptor eats projectiles and grows', () => {
    const w = quietWorld('intercept');
    w.engine.programs.forEach((p) => {
      p.triggerId = null;
      p.actionId = null;
    });
    w.engine.recompile();

    const e = w.spawnEnemy('interceptor', w.player.x + 260, w.player.y, 'voltaic')!;
    const radiusBefore = e.radius;
    for (let n = 0; n < 4; n++) {
      w.projectiles.push({
        id: 9100 + n,
        x: w.player.x + 200,
        y: w.player.y,
        vx: 0,
        vy: 0,
        life: 5,
        damage: 1,
        pierce: 0,
        hue: 'thermal',
        depth: 0,
        programIndex: 0,
        radius: 4,
        corrupted: false,
        hits: [],
        age: 0,
        alive: true,
      });
      for (let i = 0; i < 90; i++) w.advance(NO_INPUT);
    }
    expect(e.meals).toBeGreaterThan(0);
    expect(e.radius).toBeGreaterThan(radiusBefore);
  });

  it('§10.2 — a Leech drains fuel instead of dealing damage', () => {
    const w = quietWorld('leech');
    w.fuel.thermal = 40;
    const integrityBefore = w.player.integrity;
    w.spawnEnemy('leech', w.player.x + 25, w.player.y, 'thermal');
    for (let i = 0; i < 120; i++) w.advance(NO_INPUT);
    expect(w.fuel.thermal).toBeLessThan(40);
    expect(w.player.integrity).toBe(integrityBefore);
  });

  it('§11.3 — projectile spam raises the Interceptor template weight', () => {
    const w = quietWorld('reactive');
    const template = { id: 'x', minThreat: 0, maxThreat: 99, weight: 10, reactive: 'projectiles' as const, entries: [], description: '' };
    const idle = w.waveWeightFor(template);
    for (let i = 0; i < 120; i++) {
      w.projectiles.push({
        id: 9200 + i, x: 0, y: 0, vx: 0, vy: 0, life: 9, damage: 0, pierce: 0,
        hue: 'thermal', depth: 0, programIndex: 0, radius: 4, corrupted: false,
        hits: [], age: 0, alive: true,
      });
    }
    expect(w.waveWeightFor(template)).toBeGreaterThan(idle);
  });
});

describe('cascade physics (GDD §5.2)', () => {
  it('respects the hard depth cap and terminates a self-feeding loop', () => {
    const w = new World({ seed: 'cascade', axiomId: 'ignition' });
    // On Hit -> Bolt is the simplest infinite feedback loop in the game.
    const p = w.engine.programs[1]!;
    p.triggerId = 'on_hit';
    p.actionId = 'bolt';
    w.engine.recompile();
    w.syncBudget();

    runFor(w, 45);

    expect(w.stats.maxDepth).toBeLessThanOrEqual(LOADBEARING.cascadeDepthCap);
    expect(w.stats.events).toBeGreaterThan(0);
    // The loop must be stopped by the Cycle economy, not by the safety valve
    // (§5.2: "the wall exists for the runtime's safety, not for balance").
    expect(w.stats.safetyTrips).toBe(0);
  });

  it('a greedier engine draws more Cycles and runs hotter', () => {
    // Asserts the relationship rather than a magic number: Heat is a burst gauge
    // and its absolute level is a live tuning surface (§23.2), but "more engine
    // costs more Cycles and produces more Heat" must hold at any tuning.
    const lean = new World({ seed: 'heat', axiomId: 'ignition' });
    runPiloted(lean, 150);

    const greedy = new World({ seed: 'heat', axiomId: 'ignition' });
    const p1 = greedy.engine.programs[1]!;
    p1.triggerId = 'on_hit';
    p1.actionId = 'nova';
    p1.modifierIds[0] = 'split';
    p1.modifierIds[1] = 'echo';
    const p2 = greedy.engine.programs[2]!;
    p2.triggerId = 'on_kill';
    p2.actionId = 'arc';
    p2.modifierIds[0] = 'echo';
    p2.modifierIds[1] = 'split';
    const p3 = greedy.engine.programs[3]!;
    p3.triggerId = 'on_pickup';
    p3.actionId = 'field';
    p3.modifierIds[0] = 'split';
    greedy.engine.recompile();
    greedy.syncBudget();
    runPiloted(greedy, 150);

    expect(greedy.stats.cyclesSpent).toBeGreaterThan(lean.stats.cyclesSpent * 2);
    expect(greedy.stats.peakHeat).toBeGreaterThan(lean.stats.peakHeat);
    expect(greedy.stats.events).toBeGreaterThan(lean.stats.events);
  });
});

describe('Cycle budget (GDD §6)', () => {
  /** Drive one tick that draws `cost` Cycles. Returns true if it overheated. */
  function overdrawTick(b: CycleBudget, cost: number): boolean {
    b.beginTick(SIM_DT);
    b.spend(cost);
    return b.endTick(SIM_DT);
  }

  it('never refuses to fire — the deficit becomes Heat instead', () => {
    const b = new CycleBudget(100);
    overdrawTick(b, 1000);
    expect(b.available).toBe(0);
    expect(b.heat).toBeGreaterThan(0);
  });

  it('decays Heat only while under budget', () => {
    const b = new CycleBudget(100);
    for (let i = 0; i < 30; i++) overdrawTick(b, 400);
    const hot = b.heat;
    expect(hot).toBeGreaterThan(0);

    b.beginTick(SIM_DT);
    b.endTick(SIM_DT);
    expect(b.heat).toBeCloseTo(hot - TUNABLE.heatDecayPerSec * SIM_DT, 6);
  });

  it('is a dial, not a line: one huge spike cannot cross the whole band', () => {
    // The load-bearing property of the Heat model. A single monstrous cascade
    // tick should register as heat, not teleport the engine into Overheat —
    // otherwise Instability I and II are doorways rather than places to live.
    const b = new CycleBudget(100);
    expect(overdrawTick(b, 100000)).toBe(false);
    expect(b.heat).toBeLessThan(40);
    expect(b.heat).toBeGreaterThan(0);
  });

  it('overheats after sustained overdraw, stalls, and resets to 50', () => {
    const b = new CycleBudget(100);
    let overheated = false;
    let ticks = 0;
    while (!overheated && ticks < 60 * 20) {
      overheated = overdrawTick(b, 400);
      ticks++;
    }
    expect(overheated).toBe(true);
    // Sustained, not instant: it should take a couple of seconds of greed.
    expect(ticks).toBeGreaterThan(60);
    expect(b.heat).toBe(TUNABLE.overheatHeatReset);
    expect(b.stalled).toBe(true);
    expect(b.stall).toBeCloseTo(TUNABLE.overheatStallSeconds, 6);
  });

  it('reports instability tiers on the documented thresholds', () => {
    const b = new CycleBudget(100);
    b.heat = 0;
    expect(b.tier).toBe(0);
    b.heat = 40;
    expect(b.tier).toBe(1);
    expect(b.misfireChance).toBeCloseTo(TUNABLE.instability1Misfire, 10);
    b.heat = 70;
    expect(b.tier).toBe(2);
    expect(b.misfireChance).toBeCloseTo(TUNABLE.instability2Misfire, 10);
  });
});

describe('Rng', () => {
  it('reproduces a stream from a saved state', () => {
    const a = new Rng('seed');
    for (let i = 0; i < 50; i++) a.next();
    const b = Rng.restore(a.save());
    const left = Array.from({ length: 20 }, () => a.next());
    const right = Array.from({ length: 20 }, () => b.next());
    expect(left).toEqual(right);
  });

  it('stays within range', () => {
    const r = new Rng('bounds');
    for (let i = 0; i < 5000; i++) {
      const v = r.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
      expect(r.int(7)).toBeLessThan(7);
    }
  });
});
