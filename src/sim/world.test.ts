import { describe, expect, it } from 'vitest';
import { World, type InputState } from './world';
import { hashWorld } from './hash';
import { LOADBEARING, SIM_DT, TUNABLE } from './tunables';
import { CycleBudget } from './cycles';
import { Rng } from './rng';
import { botInput } from '../harness/bot';

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
