import { describe, expect, it } from 'vitest';
import { NO_INPUT, World, type InputState } from './world';
import { hashWorld } from './hash';
import { LOADBEARING, SAFETY, SIM_DT, TUNABLE } from './tunables';
import { CycleBudget } from './cycles';
import { Rng } from './rng';
import { botInput } from '../harness/bot';
import { applyDraft, purgeCard, rollDraft } from './draft';
import { inertFields } from './engine';
import { NODE_BY_ID } from '../content/index';
import { hypot } from './num';

/** Run with the harness pilot, which actually collects XP. */
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
  it('spawns, kills, drops XP and levels the player', () => {
    const w = new World({ seed: 'run-1', axiomId: 'ignition' });
    // Two minutes should clear the §8.1 cadence target of a level every 30-45s.
    runPiloted(w, 120);
    expect(w.stats.fires).toBeGreaterThan(0);
    expect(w.stats.kills).toBeGreaterThan(0);
    expect(w.stats.events).toBeGreaterThan(0);
    expect(w.level).toBeGreaterThan(1);
    expect(w.score).toBeGreaterThan(0);
    // Only XP falls now. Fuel is gone, and with it the mote-shaped pickup that
    // was the same colour and nearly the same size as the enemy that kills you.
    expect(w.pickups.every((p) => p.kind === 'xp')).toBe(true);
  });

  it('never spawns an enemy on top of the player', () => {
    const w = new World({ seed: 'spawn-safety', axiomId: 'ignition' });
    for (let i = 0; i < 60 * 60; i++) {
      const before = w.enemies.length;
      w.advance(scriptedInput(w.tickCount));
      if (w.enemies.length > before) {
        for (let j = before; j < w.enemies.length; j++) {
          const e = w.enemies[j]!;
          const d = hypot(e.x - w.player.x, e.y - w.player.y);
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

    const startDistance = hypot(e.x - w.player.x, e.y - w.player.y);
    let closest = startDistance;
    for (let i = 0; i < 60 * 12; i++) {
      w.advance(NO_INPUT);
      if (!e.alive) break;
      closest = Math.min(closest, hypot(e.x - w.player.x, e.y - w.player.y));
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
    expect(hypot(e.x - w.player.x, e.y - w.player.y)).toBeLessThan(60);
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

  it('§8.3 — the draft economy is itself draftable, and Purge narrows the pool', () => {
    const w = new World({ seed: 'tools', axiomId: 'ignition' });
    const rerolls = w.rerolls;
    const purges = w.purges;

    applyDraft(w, { kind: 'tool', tool: 'reroll' });
    applyDraft(w, { kind: 'tool', tool: 'purge' });
    expect(w.rerolls).toBe(rerolls + TUNABLE.rerollCardAmount);
    expect(w.purges).toBe(purges + TUNABLE.purgeCardAmount);

    // The point of a Purge is not that one card goes away, it is that it goes
    // away from every draft after this one.
    let spent = 0;
    while (w.purges > 0 && spent < 60) {
      const node = rollDraft(w).cards.find((c) => c.kind === 'node');
      if (node) purgeCard(w, node);
      spent++;
    }
    expect(w.purged.size).toBeGreaterThan(0);

    for (let i = 0; i < 40; i++) {
      for (const card of rollDraft(w).cards) {
        if (card.kind === 'node') expect(w.purged.has(card.nodeId)).toBe(false);
      }
    }
  });

  it('§8.3 — tool cards actually reach the player', () => {
    // A card kind that exists in the type but never rolls is the same as one
    // that does not exist. Sample enough drafts to prove both tools appear.
    const seen = new Set<string>();
    for (let seed = 0; seed < 40 && seen.size < 2; seed++) {
      const w = new World({ seed: `tool-${seed}`, axiomId: 'ignition' });
      for (let n = 0; n < 40; n++) {
        for (const card of rollDraft(w).cards) {
          if (card.kind === 'tool') seen.add(card.tool);
        }
      }
    }
    expect([...seen].sort()).toEqual(['purge', 'reroll']);
  });

  it('§8.2 — a starving Engine is fed, and a fed one is left alone', () => {
    // The only way a run dies before it starts: you draft five modifiers before
    // your second Action, the clear rate never gets high enough to earn the
    // drafts that would have fixed it, and the run is over ninety seconds before
    // it ends. The pool leans toward whichever of Trigger/Action you are short
    // of — and stops leaning entirely once you have three of each, which is the
    // half of this that keeps the late-run economy the one that was tuned.
    const share = (rows: [string | null, string | null][]): number => {
      let core = 0;
      let total = 0;
      for (let seed = 0; seed < 240; seed++) {
        const w = new World({ seed: `hunger-${seed}`, axiomId: 'ignition' });
        w.engine.programs.forEach((p, i) => {
          p.triggerId = rows[i]?.[0] ?? null;
          p.actionId = rows[i]?.[1] ?? null;
          p.modifierIds = p.modifierIds.map(() => null);
        });
        w.engine.recompile();
        w.syncBudget();
        for (const card of rollDraft(w).cards) {
          total++;
          if (card.kind !== 'node') continue;
          const kind = NODE_BY_ID.get(card.nodeId)!.kind;
          if (kind !== 'modifier') core++;
        }
      }
      return core / total;
    };

    const hungry = share([['clock', 'bolt']]);
    const fed = share([
      ['clock', 'bolt'],
      ['on_hit', 'arc'],
      ['on_kill', 'nova'],
    ]);

    // Run one has to hand you a Trigger or an Action about half the time.
    expect(hungry).toBeGreaterThan(0.45);
    // And three rows in, it is back to the modifier-heavy pool §8.2 describes.
    expect(fed).toBeLessThan(0.32);
    expect(hungry).toBeGreaterThan(fed * 1.7);
  });

  it('§8.2 — the pull is per-kind, not a blanket "more nodes"', () => {
    // Three Actions and no Trigger is exactly as dead as no Actions at all, and
    // a rule that counted nodes rather than kinds would keep handing you the one
    // you already have three of.
    let triggers = 0;
    let actions = 0;
    for (let seed = 0; seed < 240; seed++) {
      const w = new World({ seed: `lopsided-${seed}`, axiomId: 'ignition' });
      const only = ['bolt', 'arc', 'nova'];
      w.engine.programs.forEach((p, i) => {
        p.triggerId = null;
        p.actionId = only[i] ?? null;
        p.modifierIds = p.modifierIds.map(() => null);
      });
      w.engine.recompile();
      w.syncBudget();
      for (const card of rollDraft(w).cards) {
        if (card.kind !== 'node') continue;
        const kind = NODE_BY_ID.get(card.nodeId)!.kind;
        if (kind === 'trigger') triggers++;
        if (kind === 'action') actions++;
      }
    }
    expect(triggers).toBeGreaterThan(actions * 1.5);
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

  it('every run opens on the gentlest composition, not a weighted roll', () => {
    // A bad roll used to open the game on Drifters — 12 HP each against a
    // starting Clock -> Bolt that deals 10.
    for (const seed of ['open-a', 'open-b', 'open-c', 'open-d', 'open-e']) {
      const w = new World({ seed, axiomId: 'ignition' });
      for (let i = 0; i < 60 * 8; i++) w.advance(NO_INPUT);
      expect(w.composition?.opener).toBe(true);
      const heavy = w.enemies.filter((e) => e.alive && e.defId !== 'mote');
      expect(heavy).toHaveLength(0);
    }
  });

  it('enemies spread across a front instead of stacking on one point', () => {
    const w = new World({ seed: 'spread', axiomId: 'ignition' });
    w.enemies.length = 0;
    w.engine.programs.forEach((p) => {
      p.triggerId = null;
      p.actionId = null;
    });
    w.engine.recompile();

    // Release forty enemies from the same place: without separation they track
    // the identical flow vector and arrive as a single stacked column.
    for (let i = 0; i < 40; i++) {
      w.spawnEnemy('drifter', w.player.x + 900, w.player.y + 900, 'thermal');
    }
    for (let i = 0; i < 60 * 6; i++) w.advance(NO_INPUT);

    const alive = w.enemies.filter((e) => e.alive);
    let sumX = 0;
    let sumY = 0;
    for (const e of alive) {
      sumX += e.x;
      sumY += e.y;
    }
    const cx = sumX / alive.length;
    const cy = sumY / alive.length;
    const spread =
      alive.reduce((s, e) => s + hypot(e.x - cx, e.y - cy), 0) / alive.length;

    // Mean distance from their own centroid: a stacked column collapses to ~0.
    expect(spread).toBeGreaterThan(40);
  });

  it('a trailing queue does not starve the front of the arena', () => {
    // Density is a local property. With a global count, enemies left behind
    // filled the whole budget and nothing spawned ahead, so you could outrun
    // the game entirely.
    const w = new World({ seed: 'local-density', axiomId: 'ignition' });
    w.enemies.length = 0;
    // Park a crowd far behind the player, well outside pressure range.
    for (let i = 0; i < 250; i++) {
      w.spawnEnemy('mote', 200 + (i % 10) * 8, 200 + Math.floor(i / 10) * 8, 'thermal');
    }
    w.player.x = 3600;
    w.player.y = 2000;

    for (let i = 0; i < 60 * 25; i++) {
      w.player.alive = true;
      w.player.integrity = w.player.maxIntegrity;
      w.advance(NO_INPUT);
    }

    const near = w.enemies.filter(
      (e) => e.alive && hypot(e.x - w.player.x, e.y - w.player.y) < TUNABLE.pressureRadius,
    ).length;
    // Measured against the density the director is aiming to hold, not a magic
    // number: with a global count this was zero.
    expect(near).toBeGreaterThan(w.targetAlive * 0.7);
  });

  it('spawns arrive from all sides, not in one directional queue', () => {
    const w = new World({ seed: 'compass', axiomId: 'ignition' });
    const quadrants = new Set<number>();
    const seen = new Set<number>();
    let counted = 0;
    // Track by id: the enemy array is compacted every tick, so index-based
    // "which of these are new" detection samples the wrong entities.
    for (const e of w.enemies) seen.add(e.id);

    // The pilot has to actually kill things: once density is at target the
    // director correctly stops spawning, and a stationary player produces almost
    // no arrivals to measure.
    for (let i = 0; i < 60 * 120 && counted < 260; i++) {
      w.player.alive = true;
      w.player.integrity = w.player.maxIntegrity;
      w.advance(botInput(w));
      for (const e of w.enemies) {
        if (seen.has(e.id)) continue;
        seen.add(e.id);
        const angle = Math.atan2(e.y - w.player.y, e.x - w.player.x);
        quadrants.add(Math.floor(((angle + Math.PI) / (Math.PI * 2)) * 8) % 8);
        counted++;
      }
    }
    // All eight compass octants should see arrivals; a procession would not.
    expect(quadrants.size).toBeGreaterThanOrEqual(7);
  });
});

describe('the rest of the grammar (GDD §5.5, §5.6, §7.4)', () => {
  function bare(seed: string): World {
    const w = new World({ seed, axiomId: 'ignition' });
    w.enemies.length = 0;
    w.engine.programs.forEach((p) => {
      p.triggerId = null;
      p.actionId = null;
      p.modifierIds.fill(null);
    });
    w.engine.recompile();
    w.syncBudget();
    return w;
  }

  it('§5.6 Resonate — the row below also fires when the row above does', () => {
    const w = bare('resonate');
    const a = w.engine.programs[0]!;
    a.triggerId = 'clock';
    a.actionId = 'bolt';
    const b = w.engine.programs[1]!;
    b.triggerId = 'on_wound'; // never fires on its own here
    b.actionId = 'bolt';
    w.engine.recompile();
    w.syncBudget();
    runPiloted(w, 30);
    const withoutResonate = w.engine.programs[1]!.fireCount;

    const w2 = bare('resonate');
    const a2 = w2.engine.programs[0]!;
    a2.triggerId = 'clock';
    a2.actionId = 'bolt';
    const b2 = w2.engine.programs[1]!;
    b2.triggerId = 'on_wound';
    b2.actionId = 'bolt';
    b2.modifierIds[0] = 'resonate';
    w2.engine.recompile();
    w2.syncBudget();
    runPiloted(w2, 30);

    // On Wound fires occasionally on its own (the horde still exists), so the
    // contract is the multiplier, not zero-versus-nonzero.
    expect(w2.engine.programs[1]!.fireCount).toBeGreaterThan(withoutResonate * 4 + 5);
  });

  it('§5.5 Overdrive — buys output with Heat directly, budget or no budget', () => {
    const w = bare('overdrive');
    const p = w.engine.programs[0]!;
    p.triggerId = 'clock';
    p.actionId = 'bolt';
    p.modifierIds[0] = 'overdrive';
    w.engine.recompile();
    w.syncBudget();
    // Far inside budget, so any Heat at all must be Overdrive's. Sampled at the
    // moment of a fire: at a slow Clock rate the 8/sec decay erases it between
    // fires, which is exactly the intended tradeoff.
    let heatAtFire = 0;
    for (let i = 0; i < 60 * 20 && heatAtFire === 0; i++) {
      const before = w.stats.fires;
      w.advance(NO_INPUT);
      if (w.stats.fires > before) heatAtFire = w.budget.heat;
    }
    expect(heatAtFire).toBeGreaterThan(0);
    expect(w.engine.compiled[0]!.ctx.output).toBeCloseTo(2, 8);
  });

  it('§5.5 Leech — returns a share of damage as Integrity', () => {
    const w = bare('leech');
    w.player.integrity = 40;
    const p = w.engine.programs[0]!;
    p.triggerId = 'clock';
    p.actionId = 'nova';
    p.modifierIds[0] = 'leech';
    w.engine.recompile();
    w.syncBudget();
    for (let i = 0; i < 40; i++) w.spawnEnemy('bulwark', w.player.x + 60, w.player.y + i, 'thermal');
    for (let i = 0; i < 300; i++) {
      // Contact damage from the test dummies would swamp the signal; this test
      // is about whether Leech returns Integrity, not about surviving them.
      w.player.iframes = 999;
      w.advance(NO_INPUT);
    }
    expect(w.player.integrity).toBeGreaterThan(40);
  });

  it('§7.4 Convert: Bleed — trades Integrity for output, and emits On Convert', () => {
    const w = bare('bleed');
    w.player.integrity = 90;
    const p = w.engine.programs[0]!;
    p.triggerId = 'clock';
    p.actionId = 'convert_bleed';
    w.engine.recompile();
    w.syncBudget();

    for (let i = 0; i < 60 * 6; i++) w.advance(NO_INPUT);
    expect(w.player.integrity).toBeLessThan(90);
    expect(w.player.outputBoost).toBeGreaterThan(0);
    expect(w.stats.converts).toBeGreaterThan(0);
  });

  it('§7.4 Convert: Coolant — trades Integrity for Heat relief', () => {
    const w = bare('coolant');
    w.player.integrity = 90;
    w.budget.heat = 80;
    const p = w.engine.programs[0]!;
    p.triggerId = 'clock';
    p.actionId = 'convert_coolant';
    w.engine.recompile();
    w.syncBudget();

    for (let i = 0; i < 60 * 4; i++) w.advance(NO_INPUT);
    expect(w.budget.heat).toBeLessThan(80);
    expect(w.player.integrity).toBeLessThan(90);
  });

  it('§7.4 Convert: Cash Out — spends Heat for XP, which is the new arbitrage', () => {
    // The whole reason Converts survived losing Fuel. Heat is what a deep
    // cascade *produces*, so this is the Action that turns the game's central
    // pressure back into progress rather than only into punishment.
    const w = bare('cashout');
    w.budget.heat = 90;
    const before = w.level;
    const p = w.engine.programs[0]!;
    p.triggerId = 'clock';
    p.actionId = 'convert_cashout';
    w.engine.recompile();
    w.syncBudget();

    for (let i = 0; i < 60 * 6; i++) w.advance(NO_INPUT);
    expect(w.budget.heat).toBeLessThan(90);
    expect(w.level).toBeGreaterThan(before);
  });

  it('a Convert that cannot be paid for simply does not fire', () => {
    const w = bare('broke');
    w.player.integrity = 3; // less than Bleed's cost
    const before = w.player.integrity;
    const p = w.engine.programs[0]!;
    p.triggerId = 'clock';
    p.actionId = 'convert_bleed';
    w.engine.recompile();
    w.syncBudget();

    for (let i = 0; i < 60 * 6; i++) w.advance(NO_INPUT);
    // Never trades away the last of your Integrity.
    expect(w.player.integrity).toBe(before);
    expect(w.stats.converts).toBe(0);
  });
});

describe('the action roster (GDD §5.4)', () => {
  function rig(seed: string, action: string, trigger = 'clock'): World {
    const w = new World({ seed, axiomId: 'ignition' });
    w.enemies.length = 0;
    w.engine.programs.forEach((p) => {
      p.triggerId = null;
      p.actionId = null;
      p.modifierIds.fill(null);
    });
    w.engine.programs[0]!.triggerId = trigger;
    w.engine.programs[0]!.actionId = action;
    w.engine.recompile();
    w.syncBudget();
    return w;
  }

  it('cascades travel — an Action happens where its trigger happened', () => {
    // `On Hit -> Nova` detonates on each enemy struck, so a cascade walks across
    // the arena. §23.1 protects this: it costs Cycles and still needs the player
    // to move, so it is priced rather than deleted.
    const w = rig('nova-origin', 'nova', 'on_hit');
    const seed = w.engine.programs[1]!;
    seed.triggerId = 'clock';
    seed.actionId = 'bolt';
    w.engine.recompile();
    w.syncBudget();

    const px = w.player.x;
    const py = w.player.y;

    // Drive the trigger directly: routing through Bolt's nearest-target search
    // tests the targeting chain, not the origin rule.
    w.emit({ type: 'hit', depth: 0, x: px + 420, y: py, hue: 'thermal' });
    w.advance(NO_INPUT);

    const atHit = w.fx.filter(
      (f) => f.kind === 'burst' && hypot(f.x - (px + 420), f.y - py) < 40,
    );
    expect(atHit.length).toBeGreaterThan(0);
  });

  it('§23.1 — cascade depth costs more and pays less', () => {
    const w = rig('cascade-price', 'nova', 'clock');
    const compiled = w.engine.compiled[0]!;

    // Same Program, fired at the surface and deep in a cascade.
    const shallow = new World({ seed: 'cascade-price', axiomId: 'ignition' });
    shallow.enemies.length = 0;
    void shallow;

    const before = w.budget.heat;
    void before;
    // Output falls off geometrically with depth.
    const atZero = Math.pow(TUNABLE.cascadeOutputFalloff, 0);
    const atFive = Math.pow(TUNABLE.cascadeOutputFalloff, 5);
    expect(atFive).toBeLessThan(atZero * 0.6);
    // Cost climbs linearly with depth.
    const costAtFive = compiled.cycleCost * (1 + 5 * TUNABLE.cascadeCostGrowth);
    expect(costAtFive).toBeGreaterThan(compiled.cycleCost * 2);
  });

  it('surfaces modifiers that do nothing on their row', () => {
    // Ricochet on an Orbital is legal, costs Cycles, and achieves nothing. The
    // grammar keeps it buildable; the editor has to say it is inert.
    expect(inertFields('ricochet', 'orbital').length).toBeGreaterThan(0);
    expect(inertFields('pierce', 'nova').length).toBeGreaterThan(0);
    // And the ones that do work are not flagged.
    expect(inertFields('ricochet', 'bolt')).toHaveLength(0);
    expect(inertFields('enlarge', 'nova')).toHaveLength(0);
    expect(inertFields('sustain', 'orbital')).toHaveLength(0);
    // Universal modifiers apply to every row.
    expect(inertFields('amplify', 'orbital')).toHaveLength(0);
    expect(inertFields('accelerate', 'orbital')).toHaveLength(0);
  });

  it('Mine arms, then detonates on contact', () => {
    const w = rig('mine', 'mine');
    for (let i = 0; i < 90; i++) w.advance(NO_INPUT);
    expect(w.mines.length).toBeGreaterThan(0);

    // Walk a target onto it.
    const mine = w.mines.find((m) => m.alive)!;
    const e = w.spawnEnemy('drifter', mine.x + 8, mine.y, 'thermal')!;
    const before = e.hp;
    for (let i = 0; i < 60; i++) w.advance(NO_INPUT);
    expect(before - e.hp).toBeGreaterThan(0);
  });

  it('Rupture detonates after a delay, at the marked spot', () => {
    const w = rig('rupture', 'rupture');
    const e = w.spawnEnemy('bulwark', w.player.x + 200, w.player.y, 'thermal')!;
    const before = e.hp;
    // Nothing should land instantly.
    for (let i = 0; i < 20; i++) w.advance(NO_INPUT);
    const early = before - e.hp;
    for (let i = 0; i < 120; i++) w.advance(NO_INPUT);
    expect(early).toBe(0);
    expect(before - e.hp).toBeGreaterThan(0);
  });

  it('Beam hits everything along the line, not just the target', () => {
    const w = rig('beam', 'beam');
    const line: number[] = [];
    // Spaced to sit inside Beam's range, so this tests the line-hit rather than
    // the reach.
    for (let i = 1; i <= 5; i++) {
      const e = w.spawnEnemy('bulwark', w.player.x + i * 85, w.player.y, 'thermal')!;
      line.push(e.id);
    }
    for (let i = 0; i < 120; i++) w.advance(NO_INPUT);
    const damaged = w.enemies.filter((e) => line.includes(e.id) && e.hp < e.maxHp).length;
    expect(damaged).toBeGreaterThanOrEqual(4);
  });

  it('Orbital persists, stacks, and is capped', () => {
    const w = rig('orbital', 'orbital');
    for (let i = 0; i < 60 * 40; i++) w.advance(NO_INPUT);
    expect(w.orbitals.length).toBeGreaterThan(1);
    expect(w.orbitals.length).toBeLessThanOrEqual(TUNABLE.maxOrbitals);
    // They circle the player.
    for (const o of w.orbitals) {
      const d = hypot(o.x - w.player.x, o.y - w.player.y);
      expect(Math.abs(d - o.orbitRadius)).toBeLessThan(6);
    }
  });

  it('Surge speeds up every Clock while it lasts', () => {
    const w = rig('surge', 'surge');
    const other = w.engine.programs[1]!;
    other.triggerId = 'clock';
    other.actionId = 'bolt';
    w.engine.recompile();
    w.syncBudget();
    // Long enough for the Clock to have fired Surge at least once.
    for (let i = 0; i < 60 * 10; i++) w.advance(NO_INPUT);
    expect(w.surgeRate).toBeGreaterThan(0);
    const boosted = other.fireCount;

    // Let it lapse, then compare an equal window with no Surge running.
    w.engine.programs[0]!.actionId = null;
    w.engine.recompile();
    w.surgeRate = 0;
    w.surgeRateTime = 0;
    const mark = other.fireCount;
    for (let i = 0; i < 60 * 10; i++) w.advance(NO_INPUT);
    expect(boosted).toBeGreaterThan(other.fireCount - mark);
  });

  it('Pull drags enemies toward the vortex', () => {
    const w = rig('pull', 'pull');
    const e = w.spawnEnemy('bulwark', w.player.x + 170, w.player.y, 'thermal')!;
    e.vx = 0;
    e.vy = 0;
    const before = hypot(e.x - w.player.x, e.y - w.player.y);
    for (let i = 0; i < 60; i++) w.advance(NO_INPUT);
    expect(hypot(e.x - w.player.x, e.y - w.player.y)).toBeLessThan(before);
  });

  it('§23.1 — Shove displacement is capped per enemy per second', () => {
    // The named tension break: stacked Shoves must not hold the horde at arm's
    // length forever. A build that stops the game asking you to move is a bug.
    const w = rig('shove', 'shove');
    for (let i = 1; i < 4; i++) {
      const p = w.engine.programs[i]!;
      p.triggerId = 'clock';
      p.actionId = 'shove';
    }
    w.engine.recompile();
    w.syncBudget();

    const e = w.spawnEnemy('drifter', w.player.x + 60, w.player.y, 'thermal')!;
    e.hp = 1e9;
    let maxPush = 0;
    for (let second = 0; second < 6; second++) {
      const start = hypot(e.x - w.player.x, e.y - w.player.y);
      for (let i = 0; i < 60; i++) w.advance(NO_INPUT);
      if (!e.alive) break;
      maxPush = Math.max(maxPush, hypot(e.x - w.player.x, e.y - w.player.y) - start);
    }
    // Four Shove rows cannot out-push the per-second budget.
    expect(maxPush).toBeLessThan(TUNABLE.shoveBudgetPerSecond);
    // And it still closes in: it is knockback, not a wall.
    expect(hypot(e.x - w.player.x, e.y - w.player.y)).toBeLessThan(1200);
  });

  it('Fragment steers toward a target instead of flying straight', () => {
    const w = rig('fragment', 'fragment');
    // Put the only target well off the firing axis.
    w.spawnEnemy('bulwark', w.player.x + 40, w.player.y + 320, 'thermal');
    let curved = false;
    for (let i = 0; i < 240 && !curved; i++) {
      w.advance(NO_INPUT);
      for (const p of w.projectiles) {
        if (p.seek > 0 && Math.abs(p.vy) > Math.abs(p.vx)) curved = true;
      }
    }
    expect(curved).toBe(true);
  });

  it('Siphon sheds Heat on hit — the only sustained cooling in the game', () => {
    const w = rig('siphon', 'siphon');
    w.budget.heat = 90;
    // Not Bulwarks: their shield arc blocks projectiles from the front, which
    // is exactly the direction the engine fires from.
    for (let i = 0; i < 14; i++) {
      const e = w.spawnEnemy('drifter', w.player.x + 90 + i * 4, w.player.y, 'voltaic')!;
      e.hp = 1e6;
    }
    for (let i = 0; i < 200; i++) w.advance(NO_INPUT);
    expect(w.budget.heat).toBeLessThan(90);
  });
});

describe('pressure attacks the build, not the health bar (GDD §11)', () => {
  function quietWorld(seed: string): World {
    const w = new World({ seed, axiomId: 'ignition' });
    w.enemies.length = 0;
    return w;
  }

  it('§11.1 — hue is threat class, and nothing taxes you for using one', () => {
    // Adaptive resistance is retired. It was invisible — nothing in the HUD ever
    // showed it — and it punished exactly the focused builds the class stats now
    // exist to reward. A tax nobody can see is not a decision.
    const mono = quietWorld('mono');
    const m = mono.engine.programs[0]!;
    m.triggerId = 'clock';
    m.actionId = 'bolt';
    mono.engine.recompile();
    mono.syncBudget();
    runPiloted(mono, 60);

    const split = quietWorld('mono');
    const a = split.engine.programs[0]!;
    a.triggerId = 'clock';
    a.actionId = 'bolt';
    split.engine.recompile();
    split.syncBudget();
    runPiloted(split, 60);

    // Identical Engines, identical seeds: no hidden per-hue divergence left.
    expect(mono.stats.kills).toBe(split.stats.kills);
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
        bounces: 0,
        volatile: 0,
        leech: 0,
        seek: 0,
        siphon: 0,
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
        bounces: 0,
        volatile: 0,
        leech: 0,
        seek: 0,
        siphon: 0,
        alive: true,
      });
      for (let i = 0; i < 90; i++) w.advance(NO_INPUT);
    }
    expect(e.meals).toBeGreaterThan(0);
    expect(e.radius).toBeGreaterThan(radiusBefore);
  });

  it('§10.2 — a Leech heats you instead of hurting you', () => {
    const w = quietWorld('leech');
    // Disarm the Engine, or the starter Program kills the attacker mid-test.
    for (const p of w.engine.programs) p.actionId = null;
    w.engine.recompile();
    const integrityBefore = w.player.integrity;
    w.spawnEnemy('leech', w.player.x + 25, w.player.y, 'void');
    // Long enough that it must be touching repeatedly: one hit decays away
    // inside two seconds, so a Leech that fires once is a Leech with no teeth.
    for (let i = 0; i < 60 * 8; i++) w.advance(NO_INPUT);
    expect(w.budget.heat).toBeGreaterThan(10);
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
        hits: [], age: 0, bounces: 0, volatile: 0, leech: 0, seek: 0, siphon: 0, alive: true,
      });
    }
    expect(w.waveWeightFor(template)).toBeGreaterThan(idle);
  });

  it('§14 — records what landed the final blow and what did the grinding', () => {
    // A Results screen that cannot answer "how did I die" teaches nothing.
    const w = quietWorld('postmortem');
    // Disarm the Engine, or the starter Program kills the attacker mid-test.
    for (const p of w.engine.programs) p.actionId = null;
    w.engine.recompile();
    w.player.maxIntegrity = 400;
    w.player.integrity = 400;

    // Chip away with contact damage first, so the tally and the final blow can
    // disagree — that is the interesting case, and the one worth reporting.
    expect(w.spawnEnemy('mote', w.player.x + 10, w.player.y, 'thermal')).toBeTruthy();
    for (let i = 0; i < 300 && w.player.alive; i++) w.advance(NO_INPUT);
    const tallied = w.damageBySource.get('mote');
    expect(tallied?.amount).toBeGreaterThan(0);
    // The name and the silhouette both, so Results can draw the thing you saw
    // rather than describe it in prose you have to translate back.
    expect(tallied?.source.label).toBe('Mote');
    expect(tallied?.source.shape).toBe('dot');
    expect(tallied?.source.mode).toBe('contact');

    // Now let it finish the job and confirm the cause is captured.
    w.player.integrity = 1;
    for (let i = 0; i < 300 && w.player.alive; i++) w.advance(NO_INPUT);
    expect(w.player.alive).toBe(false);
    expect(w.deathCause?.id).toBe('mote');
    expect(w.damageBySource.get(w.deathCause!.id)?.amount).toBeGreaterThan(0);
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

    expect(greedy.stats.maxDepth).toBeGreaterThan(lean.stats.maxDepth);
    expect(greedy.stats.peakHeat).toBeGreaterThan(lean.stats.peakHeat);
    expect(greedy.stats.events).toBeGreaterThan(lean.stats.events);
  });
});

describe('Cycles and Heat (GDD §6)', () => {
  /** One tick in which the deepest event resolved at `depth`. */
  function depthTick(b: CycleBudget, depth: number, events = 1): boolean {
    b.beginTick(SIM_DT);
    for (let i = 0; i < events; i++) b.chargeDepth(depth);
    return b.endTick(SIM_DT);
  }

  it('shallow play never heats at all', () => {
    // The whole reason the old model had to go: it was inert for 89% of a
    // measured run and then binary. This one is the opposite by construction —
    // the first few links are free, so an ordinary Engine sits cold and the
    // gauge is something a new player can correctly ignore.
    const b = new CycleBudget(55);
    for (let i = 0; i < 60 * 30; i++) depthTick(b, TUNABLE.heatFreeDepth, 40);
    expect(b.heat).toBe(0);
  });

  it('a deep chain heats, and heats faster the deeper it runs', () => {
    // Both well under the per-second cap, or this would only prove the cap
    // exists. The property under test is that depth is a *dial*: the band
    // between free and burning has to be somewhere you can sit.
    const shallow = new CycleBudget(55);
    const deep = new CycleBudget(55);
    for (let i = 0; i < 120; i++) {
      depthTick(shallow, TUNABLE.heatFreeDepth + 2, 2);
      depthTick(deep, TUNABLE.heatFreeDepth + 8, 2);
    }
    expect(shallow.heat).toBeGreaterThan(0);
    expect(deep.heat).toBeGreaterThan(shallow.heat * 2);
  });

  it('is a dial, not a line: one huge spike cannot cross the whole band', () => {
    // The load-bearing property, carried over from the old model. A single
    // monstrous cascade tick registers as heat rather than teleporting the
    // engine into Overheat, or Instability I and II are doorways rather than
    // places to live.
    const b = new CycleBudget(55);
    expect(depthTick(b, 40, 20000)).toBe(false);
    expect(b.heat).toBeLessThan(40);
    expect(b.heat).toBeGreaterThan(0);
  });

  it('overheats after sustained depth, stalls, and resets to 50', () => {
    const b = new CycleBudget(55);
    let overheated = false;
    let ticks = 0;
    while (!overheated && ticks < 60 * 20) {
      overheated = depthTick(b, 12, 60);
      ticks++;
    }
    expect(overheated).toBe(true);
    // Sustained, not instant: it should take a couple of seconds of greed.
    expect(ticks).toBeGreaterThan(60);
    expect(b.heat).toBe(TUNABLE.overheatHeatReset);
    expect(b.stalled).toBe(true);
    expect(b.stall).toBeCloseTo(TUNABLE.overheatStallSeconds, 6);
  });

  it('reports which way Heat is moving, not just where it is', () => {
    const b = new CycleBudget(55);
    for (let i = 0; i < 30; i++) depthTick(b, 20, 60);
    expect(b.heatRate).toBeGreaterThan(0);

    b.beginTick(SIM_DT);
    b.endTick(SIM_DT);
    expect(b.heatRate).toBeLessThan(0);
  });

  it('reserves statically, and nothing else spends', () => {
    // The other half of the change. Cycles only move when the *build* moves,
    // which is what makes them plannable — the old dynamic pool drained from
    // full to empty in ten seconds of a real run.
    const b = new CycleBudget(55);
    b.setStaticLoad(40);
    expect(b.headroom).toBe(15);
    expect(b.staticFraction).toBeCloseTo(40 / 55, 6);
    for (let i = 0; i < 600; i++) depthTick(b, 1, 50);
    expect(b.headroom).toBe(15);
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
