import { describe, expect, it } from 'vitest';
import { NO_INPUT, World, type InputState } from './world';
import { hashWorld } from './hash';
import * as TRAITS from './traits';
import type { WaveTransform } from './types';
import { LOADBEARING, SAFETY, SIM_DT, TUNABLE } from './tunables';
import { CycleBudget } from './cycles';
import { Rng } from './rng';
import { botInput } from '../harness/bot';
import { applyDraft, purgeCard, rollDraft } from './draft';
import { inertFields } from './engine';
import { ENEMY_BY_ID, NODE_BY_ID, WAVE_BY_ID, WAVE_EVENTS } from '../content/index';
import { atan2 as patan2, cos as pcos, hypot, pow as ppow, sin as psin } from './num';

/** Run with the harness pilot, which actually collects XP. */
function runPiloted(world: World, seconds: number): void {
  const ticks = Math.round(seconds / SIM_DT);
  for (let i = 0; i < ticks; i++) world.advance(botInput(world));
}

/** A scripted, wall-clock-free input sequence. Same ticks -> same inputs. */
function scriptedInput(tick: number): InputState {
  const t = tick * SIM_DT;
  return {
    moveX: pcos(t * 0.7),
    moveY: psin(t * 0.45),
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
    // XP and the occasional Magnet (§7.3) — and nothing else. Fuel is gone,
    // and with it the mote-shaped pickup that was the same colour and nearly
    // the same size as the enemy that kills you.
    expect(w.pickups.every((p) => p.kind === 'xp' || p.kind === 'magnet')).toBe(true);
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
    // Open field means open field. The test used to borrow whatever happened to
    // be empty in the shipped arena, so re-laying the level's ruins broke a test
    // about pathing — clear the corridor explicitly and it asserts the behaviour
    // rather than the content.
    w.clearRuins((r) => r.x <= 1400 && r.y <= 1600);
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
    // The bar moved from 0.32 to 0.35 when blank suppression landed: a modifier
    // that is inert on every Action you own is weighted to 12%, and that weight
    // has to go somewhere. Two thirds modifiers is still the shape §8.2 asks for.
    expect(fed).toBeLessThan(0.35);
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
    // +0.25 per 15s survived, uncapped — LEVELS §1: in a two-minute Meltdown
    // the number has to move while it lasts.
    expect(w.meltdownMultiplier).toBeCloseTo(2, 6);
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
        const angle = patan2(e.y - w.player.y, e.x - w.player.x);
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
    // Doubled output, measured as a ratio: ctx.output folds in the Trigger's
    // payload, which is no longer 1 for a Clock.
    const plain = bare('overdrive');
    plain.engine.programs[0]!.triggerId = 'clock';
    plain.engine.programs[0]!.actionId = 'bolt';
    plain.engine.recompile();
    expect(
      w.engine.compiled[0]!.ctx.output / plain.engine.compiled[0]!.ctx.output,
    ).toBeCloseTo(2, 8);
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
    const atZero = ppow(TUNABLE.cascadeOutputFalloff, 0);
    const atFive = ppow(TUNABLE.cascadeOutputFalloff, 5);
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
    // the reach. Base range is 300 now, down from 520 (see actions.json),
    // so the spacing came down with it.
    for (let i = 1; i <= 5; i++) {
      const e = w.spawnEnemy('bulwark', w.player.x + i * 52, w.player.y, 'thermal')!;
      // Frozen. They converge on the player otherwise, and two seconds of that
      // leaves them in a clump rather than on a line — which tests the chase
      // rather than the beam. Before the range cut the spacing was wide enough
      // to hide it; it is not a change in what the beam does.
      e.speedScale = 0;
      line.push(e.id);
    }
    for (let i = 0; i < 120; i++) w.advance(NO_INPUT);
    // Killed counts as damaged: at close spacing the beam finishes some of
    // them outright, and a corpse is not evidence the beam missed.
    const alive = new Map(w.enemies.map((e) => [e.id, e]));
    const damaged = line.filter((id) => {
      const e = alive.get(id);
      return !e?.alive || e.hp < e.maxHp;
    }).length;
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

  it('§11.2 — the director cannot field more than two suppression fields', () => {
    // A Suppressor does not add damage, it subtracts the game. Without a cap the
    // wave templates will happily queue six, and six overlapping dead zones is a
    // region of the arena where nothing the player owns does anything.
    const w = quietWorld('suppress');
    // Straight at the director's own queue: that is where the ceiling lives, and
    // spawnEnemy deliberately has no ceiling (a Splitter's children must always
    // arrive).
    const queue = (w as unknown as {
      queueSpawn(e: string, x: number, y: number, s: number, d: number, via: unknown[]): void;
    }).queueSpawn.bind(w);
    // An empty chain: spawn exactly what is asked for. The ceiling is what is
    // under test, not the roster remap that would otherwise turn these into
    // something the room prefers.
    for (let i = 0; i < 40; i++) {
      queue('suppressor', w.player.x + 900, w.player.y + 900, 40, i * 0.05, []);
      w.advance(NO_INPUT);
    }
    for (let i = 0; i < 300; i++) w.advance(NO_INPUT);
    const live = w.enemies.filter((e) => e.alive && e.defId === 'suppressor').length;
    expect(live).toBeGreaterThan(0);
    expect(live).toBeLessThanOrEqual(TUNABLE.suppressorsAlive);
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
    const leech = w.spawnEnemy('leech', w.player.x + 25, w.player.y, 'void')!;
    // Long enough that it must be touching repeatedly: one hit decays away
    // inside two seconds, so a Leech that fires once is a Leech with no teeth.
    //
    // The director keeps working through all eight seconds, and anything else it
    // sends can land an ordinary hit — which would be read here as the Leech
    // drawing blood. Keep the room to the two of them.
    for (let i = 0; i < 60 * 8; i++) {
      for (const e of w.enemies) if (e !== leech) e.alive = false;
      w.advance(NO_INPUT);
    }
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
    expect(greedy.stats.events).toBeGreaterThan(lean.stats.events);
    // Sustained Heat, not peak. Peak was measuring the wrong thing: a Leech
    // touching the player adds 16 Heat in one frame, so the *lean* run peaked
    // higher (15.9 vs 15.4) purely because it was slower at killing Leeches.
    // What the claim is actually about is the Heat an Engine *produces*, which
    // is a sustained level: measured, lean averages 0.13 and greedy 0.99.
    expect(greedy.heatIntegral / greedy.time).toBeGreaterThan(
      (lean.heatIntegral / lean.time) * 2,
    );
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

describe('a detonation gets to finish (GDD §20.1)', () => {
  type PushFx = (
    kind: string,
    hue: string,
    x: number,
    y: number,
    radius: number,
    points: number[],
    life: number,
  ) => void;

  function fxWorld(seed: string): { w: World; push: PushFx } {
    const w = new World({ seed, axiomId: 'ignition' });
    w.enemies.length = 0;
    w.fx.length = 0;
    const push = (w as unknown as { pushFx: PushFx }).pushFx.bind(w) as PushFx;
    return { w, push };
  }

  it('drops a detonation landing on top of a young identical one', () => {
    const { w, push } = fxWorld('crowd');
    push('burst', 'thermal', 1000, 1000, 120, [], 0.22);
    push('burst', 'thermal', 1010, 1005, 120, [], 0.22);
    expect(w.fx.length).toBe(1);

    // A different hue is a different thing happening and always gets through.
    push('burst', 'voltaic', 1000, 1000, 120, [], 0.22);
    // So does one far enough away to be about somewhere else.
    push('burst', 'thermal', 1400, 1000, 120, [], 0.22);
    expect(w.fx.length).toBe(3);
  });

  it('never lets the survivor outlive its own life', () => {
    // The regression this guards is a real one that shipped for a commit: a
    // merge that refreshed the survivor produced a ring which sat on the player
    // forever. Suppression must leave the survivor completely alone.
    const { w, push } = fxWorld('immortal');
    push('burst', 'thermal', 1000, 1000, 120, [], 0.22);
    const born = w.fx[0]!;
    for (let i = 0; i < 60; i++) {
      push('burst', 'thermal', 1000, 1000, 120, [], 0.22);
      w.advance(NO_INPUT);
    }
    expect(born.life).toBeLessThanOrEqual(0.22);
    expect(w.fx.some((f) => f === born && f.alive)).toBe(false);
  });

  it('under a cascade, no detonation is cut off part-way', () => {
    // The failure looked like "explosions appear and disappear". The draw never
    // changed — the budget started evicting live effects, and a ring killed at
    // 70% life has grown from 0.80r to 0.96r of its 1.08r finish, which is not
    // an explosion, it is a flash.
    //
    // So this asserts the thing the picture actually needs: once an effect is
    // accepted it is never removed while it still has life left. Scattered
    // positions on purpose, so crowd suppression cannot be what carries the
    // test — this is the budget's policy under a rate no suppression can help.
    const { w, push } = fxWorld('cascade');
    const rng = new Rng('cascade-positions');
    const lastSeen = new Map<number, number>();
    let truncated = 0;
    let peak = 0;

    for (let tick = 0; tick < 120; tick++) {
      for (let i = 0; i < 120; i++) {
        push('burst', 'thermal', rng.next() * 4000, rng.next() * 3000, 110, [], 0.22);
      }
      w.advance(NO_INPUT);
      peak = Math.max(peak, w.fx.length);
      const present = new Set<number>();
      for (const f of w.fx) {
        present.add(f.id);
        lastSeen.set(f.id, f.life);
      }
      for (const [id, life] of lastSeen) {
        if (present.has(id)) continue;
        // Gone from the pool. Fine if it had run out; a truncation if it had not.
        if (life > SIM_DT * 1.5) truncated++;
        lastSeen.delete(id);
      }
    }

    expect(peak).toBeLessThanOrEqual(TUNABLE.maxFx);
    expect(lastSeen.size).toBeGreaterThan(0);
    expect(truncated).toBe(0);
  });
});

describe('a room announces itself once (GDD §21b)', () => {
  it('fires on first entry, never for the starting room, never twice', () => {
    const w = new World({ seed: 'breach', axiomId: 'ignition' });
    const levels = w.arena.levels ?? [];
    expect(levels.length).toBeGreaterThan(1);

    // Drains, like the app does — the sim accumulates cues and the audio layer
    // empties them, so counting has to do the same or every check sees history.
    const drain = (): number => {
      const n = w.audioCues.filter((c) => c.kind === 'breach').length;
      w.audioCues.length = 0;
      return n;
    };

    // The room the run starts in is your own front door.
    w.advance(NO_INPUT);
    expect(drain()).toBe(0);

    // Cross into the second room. The gate is not involved — the roster is
    // positional, so standing in it is what makes its families legal.
    const next = levels[1]!;
    w.player.x = next.x + next.w / 2;
    w.player.y = next.y + next.h / 2;
    w.advance(NO_INPUT);
    expect(drain()).toBe(1);

    // Staying there is not a second breach.
    for (let i = 0; i < 30; i++) w.advance(NO_INPUT);
    expect(drain()).toBe(0);

    // Neither is going back and returning.
    const first = levels[0]!;
    w.player.x = first.x + first.w / 2;
    w.player.y = first.y + first.h / 2;
    w.advance(NO_INPUT);
    w.player.x = next.x + next.w / 2;
    w.player.y = next.y + next.h / 2;
    w.advance(NO_INPUT);
    expect(drain()).toBe(0);
  });
});

describe('the wave transform chain (GDD §12.5)', () => {
  type Via = readonly unknown[];
  type ApplyVia = (enemy: string, via: Via) => { enemy: string; affixes: number; hpScale: number };

  function chainOf(seed: string, threat: number): ApplyVia {
    const w = new World({ seed, axiomId: 'ignition' });
    w.enemies.length = 0;
    w.threat = threat;
    return (w as unknown as { applyVia: ApplyVia }).applyVia.bind(w) as ApplyVia;
  }

  const rosterOf = (id: string) => {
    const w = new World({ seed: 'x', axiomId: 'ignition' });
    const level = (w.arena.levels ?? []).find((l) => l.id === id)!;
    return {
      op: 'roster' as const,
      tier: level.roster.tier,
      families: level.roster.families,
    };
  };

  it('bounds escalation by the roster it was handed, not by the player position', () => {
    // The whole reason the chain carries a resolved roster instead of looking
    // one up: a gate siege standing in The Heap fields The Sink's garrison.
    const apply = chainOf('rooms', 40);
    const heap = apply('mote', [rosterOf('heap'), { op: 'escalate', mode: 'best', ceiling: true }]);
    const sink = apply('mote', [rosterOf('sink'), { op: 'escalate', mode: 'best', ceiling: true }]);
    expect(NODE_TIER(heap.enemy)).toBeLessThan(NODE_TIER(sink.enemy));
    expect(NODE_TIER(sink.enemy)).toBe(rosterOf('sink').tier);
  });

  it("'best' takes the hardest legal variant; 'roll' is a mix", () => {
    const apply = chainOf('modes', 40);
    const via = (mode: 'roll' | 'best') => [rosterOf('sink'), { op: 'escalate', mode }];
    // best is deterministic: same answer every time.
    const bests = new Set(Array.from({ length: 20 }, () => apply('mote', via('best')).enemy));
    expect(bests.size).toBe(1);
    // roll is a texture: at high Threat it must produce more than one answer.
    const rolls = new Set(Array.from({ length: 60 }, () => apply('mote', via('roll')).enemy));
    expect(rolls.size).toBeGreaterThan(1);
  });

  it("'ceiling' ignores Threat where a lead does not", () => {
    const early = chainOf('reach', 0);
    const sink = rosterOf('sink');
    const lead = early('mote', [sink, { op: 'escalate', mode: 'best', lead: 2 }]);
    const ceiling = early('mote', [sink, { op: 'escalate', mode: 'best', ceiling: true }]);
    // At Threat 0 a Cache reaches almost nothing; a siege reaches the ceiling.
    expect(NODE_GATE(lead.enemy)).toBeLessThanOrEqual(2);
    expect(NODE_GATE(ceiling.enemy)).toBeGreaterThan(NODE_GATE(lead.enemy));
  });

  it('accumulates affixes and the one honest multiplier', () => {
    const apply = chainOf('affix', 10);
    const plain = apply('mote', []);
    expect(plain.affixes).toBe(0);
    expect(plain.hpScale).toBe(1);
    const hard = apply('mote', [{ op: 'affix', count: 2 }, { op: 'toughen', hp: 4 }]);
    expect(hard.affixes).toBe(2);
    expect(hard.hpScale).toBe(4);
  });
});

describe('called waves are data (GDD §12.5)', () => {
  it('every shipped event names a pool the registry knows', () => {
    for (const e of WAVE_EVENTS) {
      expect(e.parcels.length).toBeGreaterThan(0);
      if (e.pool) expect(WAVE_BY_ID.get(e.pool)).toBeDefined();
    }
  });

  it('the gate siege is the hardest thing on the list', () => {
    const total = (id: string): number => {
      const e = WAVE_EVENTS.find((w) => w.id === id)!;
      return e.parcels.reduce((sum, p) => sum + p.share, 0);
    };
    // The ordering the design asks for: siege > cache > beacon.
    expect(total('gate_siege')).toBeGreaterThan(total('cache_menagerie'));
    expect(total('cache_menagerie')).toBeLessThan(total('beacon_call') + 1);
    const affixes = (id: string): number => {
      const e = WAVE_EVENTS.find((w) => w.id === id)!;
      return e.via.reduce((n, v) => (v.op === 'affix' ? n + v.count : n), 0);
    };
    // Two affixes against a Cache's one. Briefly it was one, and the siege came
    // back reported as "very weak, they died easily" — with the ambient floor
    // dropped there was not enough left for one affix to carry.
    expect(affixes('gate_siege')).toBeGreaterThan(affixes('cache_menagerie'));
    expect(affixes('beacon_call')).toBe(0);

    const reach = (id: string): WaveTransform | undefined =>
      WAVE_EVENTS.find((w) => w.id === id)!.via.find((v) => v.op === 'escalate');
    // A siege reaches the room's ceiling; a Cache reaches a couple of points
    // past the current wave. That, the parcel count and the total are the
    // ordering now.
    expect((reach('gate_siege') as { ceiling?: boolean }).ceiling).toBe(true);
    expect((reach('cache_menagerie') as { ceiling?: boolean }).ceiling).toBeUndefined();
    const parcels = (id: string): number => WAVE_EVENTS.find((w) => w.id === id)!.parcels.length;
    expect(parcels('gate_siege')).toBeGreaterThan(parcels('cache_menagerie'));

    // Only the Cache refuses the room's punctuation. A Suppressor in a siege is
    // the room defending itself and belongs there; a Suppressor in a box you
    // opened for a card is a forty-second lockout you bought by accident.
    const hasNoEvents = (id: string): boolean =>
      WAVE_EVENTS.find((w) => w.id === id)!.via.some((v) => v.op === 'noEvents');
    expect(hasNoEvents('cache_menagerie')).toBe(true);
    expect(hasNoEvents('gate_siege')).toBe(false);
    expect(hasNoEvents('beacon_call')).toBe(false);
  });

  it('a parcel schedule arrives spread out, not all at once', () => {
    const siege = WAVE_EVENTS.find((w) => w.id === 'gate_siege')!;
    const ats = siege.parcels.map((p) => p.at);
    expect(ats).toEqual([...ats].sort((a, b) => a - b));
    // Nothing at zero: brushing the ring must not start the boss wave.
    expect(ats[0]).toBeGreaterThan(0);
    // And it is a score, not a ramp — at least one parcel smaller than the one
    // before it, or the "lull then wall" shape is not actually in the data.
    const dips = siege.parcels.filter((p, i) => i > 0 && p.share < siege.parcels[i - 1]!.share);
    expect(dips.length).toBeGreaterThan(0);
  });
});

/** The Threat a substitute unlocks at; 0 for a base creature. */
function NODE_GATE(id: string): number {
  return ENEMY_BY_ID.get(id)?.substitutes?.fromThreat ?? 0;
}
/** The roster tier a substitute belongs to; 0 for a base creature. */
function NODE_TIER(id: string): number {
  return ENEMY_BY_ID.get(id)?.substitutes?.tier ?? 0;
}

describe('behaviour is pinned while it is being refactored', () => {
  /**
   * Golden hashes, so the traits refactor is provably balance-neutral.
   *
   * `hashWorld` folds in every enemy's position and state, so if a ported
   * behaviour changes the order of an RNG draw, the order of two float
   * operations, or which enemies run before which, these move. That is a much
   * stronger claim than reading the diff, and it is the reason the refactor
   * comes before the rebalancing rather than after: retuning on top of an
   * unverified port would make both unprovable.
   *
   * If a stage *intends* to change behaviour, these get updated in the same
   * commit, deliberately, with the reason in the message. An accidental change
   * is a failing test; a deliberate one is a two-line diff you have to justify.
   *
   * Delete along with REFACTOR.md once the last stage lands and the ordinary
   * determinism tests above are guard enough again.
   */
  //
  // MOVED 2026-08-05, deliberately, by the spawn-placement fix. `pushOutsideView`
  // used `Math.max` where it needed `Math.min`: a spawn roughly level with the
  // player divided a half-view by a 1e-3 guard and was flung a quarter of a
  // billion units, then clamped to the arena corner. Every wave in the game
  // placed some of itself wrongly, so every seed moves. The three below were
  // recorded after the fix and re-verified across repeat runs.
  //
  // `calledWaves` MOVED again, deliberately, by the Cache suppression fix. A
  // Cache now excludes `anchored` from its affix roll, so its enemies draw from
  // a two-affix pool instead of a three-affix one — different draws, different
  // world, from the first hardened arrival onward. Only the Cache scenario
  // walks that path, which is why it is the only pin that moved.
  //
  // ...and again by the room ceiling. The Heap caps at Threat 6, so the Cache
  // scenario's Threat of 8 no longer reaches past it: composition eligibility,
  // density and substitution all read `roomThreat`, and `escalate: ceiling`
  // means the room's ceiling rather than Infinity.
  //
  // ...and again, both of them this time, by the two room fixes read off a real
  // run. Spawn placement now refuses candidates in a neighbouring room, and The
  // Heap declares no Suppressor. Placement is upstream of everything — every
  // arrival lands somewhere else, so every seed moves.
  //
  // MOVED, all four, deliberately, by the LEVELS pass: the 15-minute re-cut
  // (threatPerSecond 0.02 → 0.031, so density and eligibility climb faster on
  // every seed), the Heap re-laid as Dock/Stacks/Spill/Forecourt (every ruin
  // moved, so every collision, path and spawn rejection moves), the room's
  // threat cap 6 → 5, and authored POIs placed at run start (two entries in
  // `terminals` shift every later id). Placement and pacing are upstream of
  // everything, so every seed moves. Recorded after the change, re-verified
  // across repeat runs.
  //
  // ...and again, by sealed-room POIs deferring to `openGate`. A fragment
  // behind a wall no longer exists at run start, so every id issued after the
  // authored placements shifts, and the indicators stop pointing at rooms the
  // player cannot enter.
  //
  // ...and again, by POIs refusing gate circles. A spot inside the hold ring
  // sells a boss wave as a wave call, so `findOpenSpot` rejects it — and every
  // rejection is an extra pair of Rng draws, so every seed moves.
  //
  // ...and again, by the files moving behind the first partition. The Heap
  // authors four stations and no fragments now, so the terminal id sequence —
  // and everything issued after it — shifts on every seed.
  const PINNED = {
    piloted: '789691d8',
    scripted: '6dd31cf2',
    menagerie: '0442958c',
    // `calledWaves` alone MOVED again, deliberately: the campaign re-authored
    // the Sink's files (three now, under the STORY-AND-TONE doc ids), and the
    // gate-hold scenario opens the Sink — so `openGate` places them and the
    // terminal ids after that point shift. Nothing else walks that path,
    // which is why it is the only pin that moved.
    calledWaves: 'ec8d59f3',
  };
  //
  // ...and once more, by the siege arriving *in* the doorway instead of in front
  // of it. The placement satisfies the safe radius by construction now rather
  // than being corrected outward afterwards — which is what used to shove every
  // arrival past the player and out the back — and the barrier is exempted from
  // the seal test, so the mirror retry no longer reflects them behind either.
  //
  // `calledWaves` again, by the siege coming through the door. Placement, count
  // and timing all move: a ring no longer scatters a quarter of each parcel into
  // the sealed room to be discarded, the parcel pours over three seconds instead
  // of one tick, and opening the gate now cancels whatever is still queued.

  /**
   * A scripted Cache and a scripted gate hold, because nothing else pins them.
   *
   * Three of the four spawn bugs found on 2026-08-05 — the placement fling, the
   * doubled parcel delay, the field-blind suppression ceiling — survived a fully
   * green suite, and all three lived on paths no pinned seed ever walked. The
   * bot does not reach the gate and never opens a box.
   *
   * Deterministic without being a replay: fixed seed, fixed Threat, fixed tick
   * numbers, and the player teleported rather than driven. That last part is the
   * point — a pilot good enough to hold a gate would itself be a thing that
   * changes, and the pin has to move only when the *sim* does.
   */
  function calledWaveScenario(): World {
    const w = new World({ seed: 'pin-called', axiomId: 'ignition' });
    w.threat = 8;
    w.enemies.length = 0;
    const gate = w.terminals.find((t) => t.kind === 'gate')!;

    for (let tick = 0; tick < 60 * 40; tick++) {
      // A Cache at four seconds: the hardened menagerie, on its own for a while.
      if (tick === 60 * 4) {
        (w as unknown as { openCacheNow(x: number, y: number): void }).openCacheNow(
          w.player.x,
          w.player.y,
        );
      }
      // From ten seconds, stand in the gate and do not leave. Twenty-two seconds
      // of bar means it opens around thirty-two, leaving eight seconds after to
      // catch anything that arrives once the fight is over.
      if (tick >= 60 * 10) {
        w.player.x = gate.x;
        w.player.y = gate.y;
      }
      w.player.integrity = w.player.maxIntegrity;
      w.advance(NO_INPUT);
    }
    return w;
  }

  it('a Cache and a gate hold are unchanged', () => {
    const w = calledWaveScenario();
    // Guard the guard: if the scenario stops exercising what it is named after,
    // the hash is still stable and still meaningless.
    expect(w.openBiomes.size, 'the gate should have opened').toBeGreaterThan(0);
    expect(w.stats.cachesOpened, 'the Cache should have opened').toBeGreaterThan(0);
    expect(w.enemies.filter((e) => e.affixes.length > 0).length).toBeGreaterThan(0);
    expect(hashWorld(w)).toBe(PINNED.calledWaves);
  });

  it('a piloted run is unchanged', () => {
    const w = new World({ seed: 'pin-piloted', axiomId: 'feedback' });
    runPiloted(w, 120);
    expect(hashWorld(w)).toBe(PINNED.piloted);
  });

  it('a scripted run is unchanged', () => {
    const w = new World({ seed: 'pin-scripted', axiomId: 'circuit' });
    runFor(w, 120);
    expect(hashWorld(w)).toBe(PINNED.scripted);
  });

  it('one of every behaviour, driven for a minute, is unchanged', () => {
    // The roster on level one remaps most families away, so a normal run never
    // exercises intercept, lance or charge. These are queued straight past the
    // director with an empty transform chain, which is the only way to get all
    // five behaviours running in one world.
    const w = new World({ seed: 'pin-menagerie', axiomId: 'ignition' });
    w.enemies.length = 0;
    const queue = (
      w as unknown as {
        queueSpawn(e: string, x: number, y: number, s: number, d: number, via: unknown[]): void;
      }
    ).queueSpawn.bind(w);

    const kinds = ['mote', 'drifter', 'charger', 'interceptor', 'suppressor', 'lancer'];
    kinds.forEach((kind, i) => {
      const angle = (i / kinds.length) * Math.PI * 2;
      for (let n = 0; n < 4; n++) {
        queue(
          kind,
          w.player.x + pcos(angle) * (700 + n * 40),
          w.player.y + psin(angle) * (700 + n * 40),
          30,
          n * 0.1,
          [],
        );
      }
    });

    runFor(w, 60);
    expect(w.enemies.some((e) => e.alive)).toBe(true);
    expect(hashWorld(w)).toBe(PINNED.menagerie);
  });
});

describe('nothing arrives where the player cannot go (GDD §21b.6)', () => {
  it('never places a spawn outside the arena or in sealed ground', () => {
    // Reported from a screenshot: shards past the gate, in the room the player
    // had not opened. Two faults stacked. `pushOutsideView` used `Math.max`
    // where it needed `Math.min`, so a spawn roughly level with the player
    // divided a half-view by a 1e-3 guard and flew a quarter of a billion units
    // out; and `isSealed` was tested on that raw point — nothing that far out is
    // inside any level — before the clamp dropped it in an arena corner, which
    // happens to be inside The Sink.
    const w = new World({ seed: 'placement', axiomId: 'ignition' });
    const push = (
      w as unknown as { pushOutsideView(x: number, y: number): { x: number; y: number } }
    ).pushOutsideView.bind(w);

    // The exact shape that broke: same y as the player, so dy is zero.
    for (const dx of [50, 600, 1200, -600]) {
      const out = push(w.player.x + dx, w.player.y);
      expect(Math.abs(out.x - w.player.x), `dx ${dx} flew away`).toBeLessThan(5000);
      expect(Number.isFinite(out.x) && Number.isFinite(out.y)).toBe(true);
    }

    // ...and end to end: run long enough for the director to place hundreds.
    for (let i = 0; i < 60 * 90; i++) w.advance(botInput(w));
    expect(w.enemies.length).toBeGreaterThan(10);
    for (const e of w.enemies) {
      expect(e.x >= 0 && e.x <= w.arena.width, `enemy at x=${e.x}`).toBe(true);
      expect(e.y >= 0 && e.y <= w.arena.height, `enemy at y=${e.y}`).toBe(true);
      // Nothing may be standing in a room that has not been opened.
      expect(w.isSealed(e.x, e.y), `enemy at ${Math.round(e.x)},${Math.round(e.y)}`).toBe(false);
    }
  });
});

describe("affixes and a variant's own ideas are one mechanism (GDD §10.3)", () => {
  it('a Ghost phases from its own def, with no affix involved', () => {
    // The pinned hashes cannot see this: level one is tier 0, so a normal run
    // never substitutes a Ghost, and the menagerie does not queue one. Porting
    // phasing to a trait silently broke it and every test still passed.
    const w = new World({ seed: 'ghost', axiomId: 'ignition' });
    w.enemies.length = 0;
    const queue = (
      w as unknown as {
        queueSpawn(e: string, x: number, y: number, s: number, d: number, via: unknown[]): void;
      }
    ).queueSpawn.bind(w);
    queue('mote_ghost', w.player.x + 600, w.player.y, 10, 0, []);
    for (let i = 0; i < 240; i++) w.advance(NO_INPUT);

    const ghost = w.enemies.find((e) => e.defId === 'mote_ghost');
    expect(ghost, 'the ghost should have spawned').toBeDefined();
    expect(ghost!.traits.some((t) => t.t === 'phase')).toBe(true);

    let sawPhased = false;
    let sawSolid = false;
    for (let i = 0; i < 400 && ghost!.alive; i++) {
      w.advance(NO_INPUT);
      if (ghost!.phased) sawPhased = true;
      else sawSolid = true;
    }
    expect(sawPhased, 'a Ghost must go untargetable').toBe(true);
    expect(sawSolid, '...and come back').toBe(true);
  });

  it('anchored overrides a def zone; phasing defers to a def phase', () => {
    const { AFFIX_TRAITS, deriveTraits, mergeAffixes, traitOf } = TRAITS;

    // Anchored replaces whatever zone the def had — it is prepended, so it wins.
    const anchored = mergeAffixes(deriveTraits({ behavior: 'seek' }), ['anchored']);
    expect(traitOf(anchored, 'zone')).toEqual(AFFIX_TRAITS.anchored!.traits[0]);

    // Phasing defers to the def's own timing — appended, so the def's wins.
    const ghostPlusAffix = mergeAffixes(
      deriveTraits({ behavior: 'seek', phaseInterval: 1.6, phaseDuration: 0.4 }),
      ['phasing'],
    );
    expect(traitOf(ghostPlusAffix, 'phase')!.interval).toBe(1.6);

    // With no def phase, the affix's timing is what is left.
    const plainPlusAffix = mergeAffixes(deriveTraits({ behavior: 'seek' }), ['phasing']);
    expect(traitOf(plainPlusAffix, 'phase')!.interval).toBe(TUNABLE.affixPhaseInterval);
  });

  it('§21b.7 — a siege stops when the gate opens', () => {
    // Reported as "AFTER the gate opened, a TON kept spawning". `parcel.at` is
    // the schedule *and* was being passed on as the spawn delay, so the wait
    // happened twice: the last and largest parcel was handed over at bar-second
    // 20.5 and then sat in the queue for another 20.5 seconds, arriving about
    // nineteen seconds after the fight was over. Measured across the five
    // seconds following the opening: 56 arrivals before the fix, 17 after —
    // and 17 is the ordinary flow, which is meant to continue.
    const w = new World({ seed: 'aftergate', axiomId: 'ignition' });
    w.threat = 8;
    w.enemies.length = 0;
    const t = w.terminals.find((x) => x.kind === 'gate')!;
    let openedAt = -1;
    let burst = 0;
    const proto = Object.getPrototypeOf(w) as { spawnEnemy: (...a: never[]) => unknown };
    const orig = proto.spawnEnemy;
    proto.spawnEnemy = function (this: unknown, ...a: never[]) {
      if (openedAt >= 0 && w.time - openedAt < 5) burst++;
      return orig.apply(this, a);
    };
    for (let i = 0; i < 60 * 45; i++) {
      if (openedAt < 0) {
        w.player.x = t.x;
        w.player.y = t.y;
      }
      w.player.integrity = w.player.maxIntegrity;
      w.advance(NO_INPUT);
      if (openedAt < 0 && w.openBiomes.size > 0) openedAt = w.time;
    }
    proto.spawnEnemy = orig;
    expect(openedAt, 'the gate should have opened').toBeGreaterThan(0);
    expect(burst, 'the siege must not keep arriving after it is over').toBeLessThan(35);
  });

  const suppressionFields = (w: World): number =>
    w.enemies.filter(
      (e) => e.alive && (e.traits.some((t) => t.t === 'zone') || e.defId === 'suppressor'),
    ).length;

  it('§12.4 — a Cache never switches your Engine off', () => {
    // The one the reports kept being about, and the one this test kept missing.
    //
    // It used to assert `peak <= suppressorsAlive`, i.e. "at most two Engine-off
    // fields around the box you just opened". That is a ceiling on the wrong
    // thing: the number was two rather than thirty-seven, so it read as fixed
    // every time, and the player opened a Cache and watched their Engine go
    // quiet anyway. `noEvents` keeps Suppressors out of a Cache; `anchored`
    // grants a suppression field of its own and was still in the affix pool, so
    // the wave fielded the exact thing it was written to exclude.
    //
    // A Cache is a purchase — a card, and a hard fight for it. Not a fight you
    // are not allowed to shoot back in. Zero, not a cap.
    const w = new World({ seed: 'cache-quiet', axiomId: 'ignition' });
    w.threat = 8;
    w.enemies.length = 0;
    (w as unknown as { openCacheNow(x: number, y: number): void }).openCacheNow(
      w.player.x,
      w.player.y,
    );
    // Counted by *source*, not by presence on screen. The director keeps running
    // during a Cache fight and its own composition may legitimately contain a
    // Suppressor — indistinguishable to the player, and not the same bug. This
    // asserts the half the Cache is responsible for; the ambient half is a
    // separate design question about whether opening a box should quiet the room.
    const fromCache = (w: World): number =>
      w.enemies.filter((e) => e.alive && e.hardened && (e.traits.some((t) => t.t === 'zone') || e.defId === 'suppressor'))
        .length;

    let peak = 0;
    let arrivals = 0;
    for (let i = 0; i < 60 * 20; i++) {
      w.player.integrity = w.player.maxIntegrity;
      w.advance(NO_INPUT);
      peak = Math.max(peak, fromCache(w));
      arrivals = Math.max(arrivals, w.enemies.filter((e) => e.alive && e.hardened).length);
    }
    expect(arrivals, 'the menagerie should have arrived at all').toBeGreaterThan(0);
    expect(peak, 'a Cache must field no suppression of its own').toBe(0);
  });

  it('§21b — a capped room stops, and the run does not', () => {
    // The tutorial room. `tier: 0` already kept elites out of The Heap; what it
    // never capped was *weight* — density is a pure function of Threat, Threat
    // is wall-clock, and neither had ever heard of a room. Twenty minutes in the
    // first level met the same two families at four hundred bodies: capped in
    // kind, unbounded in mass, which is not a plateau.
    const w = new World({ seed: 'room-cap', axiomId: 'ignition' });
    const cap = w.currentLevel!.roster.threatCap!;

    w.threat = cap / 2;
    const half = w.targetAlive;
    expect(w.roomThreat, 'below the cap the room is the run').toBeCloseTo(w.threat, 5);
    expect(w.roomThreatGap).toBe(0);

    w.threat = cap;
    const atCap = w.targetAlive;
    expect(atCap).toBeGreaterThan(half);

    // Far past it: the run's clock has run on and the room has not moved.
    w.threat = cap * 4;
    expect(w.roomThreat, 'the room holds').toBe(cap);
    expect(w.targetAlive, 'and so does its density').toBe(atCap);
    expect(w.roomThreatGap).toBeCloseTo(cap * 3, 5);
    // ...which is the whole of the "you are behind" signal, in steps.
    expect(w.threatStep).toBeGreaterThan(w.roomThreatStep);
  });

  it("§21b — a room's tier binds a template that names an elite outright", () => {
    // Substitution respected `tier`; the roster remap did not. It matched on
    // *family*, so a template whose own entries say `mote_shielded` — and
    // `shield_wall` and `brood_nest` both do, both eligible at Threat 6 — asked
    // for a Mote-family creature, was told Motes are fine, and put a tier-1
    // elite in a room authored to hold none.
    const w = new World({ seed: 'tier-binds', axiomId: 'ignition' });
    const roster = w.currentLevel!.roster;
    expect(roster.tier, 'the tutorial room is base creatures only').toBe(0);

    const via = (
      w as unknown as { rosterVia(l: unknown): unknown[] }
    ).rosterVia(w.currentLevel);
    const apply = (id: string): string =>
      (w as unknown as { applyVia(e: string, v: unknown[]): { enemy: string } }).applyVia(id, via)
        .enemy;

    // Demoted to the family's base creature, not dropped: the wave still wants a
    // body in that slot.
    expect(apply('mote_shielded')).toBe('mote');
    expect(apply('drifter_shielded')).toBe('drifter');
    expect(apply('drifter_brood')).toBe('drifter');
    // Base creatures of a family the room has are untouched...
    expect(apply('mote')).toBe('mote');
    expect(apply('drifter')).toBe('drifter');
  });

  it('§21b.7 — ground taken at a gate stays taken', () => {
    // The bar used to drain, slowly, and slowly was the worst of both. The siege
    // is scheduled off `progress`, so a bar that rewinds re-delivers parcels
    // already fought: step off and the same wave arrives again, and again, until
    // it kills you — or you learn to hover just under a threshold and farm one
    // forever. One dial produced a treadmill and an exploit at the same time.
    //
    // Monotonic makes the intended play the obvious one: hold until a parcel
    // lands, back off and clear it, come back for the next slice.
    const w = new World({ seed: 'gate-hold', axiomId: 'ignition' });
    const gate = w.terminals.find((t) => t.gateId)!;
    const HOLD: InputState = { moveX: 0, moveY: 0, dash: false, interact: true };

    // Take some ground, and at least one parcel with it.
    for (let i = 0; i < 60 * 8; i++) {
      w.player.integrity = w.player.maxIntegrity;
      w.player.x = gate.x;
      w.player.y = gate.y;
      w.advance(HOLD);
    }
    const taken = gate.progress;
    const parcels = gate.siegePulse ?? 0;
    expect(taken, 'should have taken some ground').toBeGreaterThan(0);
    expect(parcels, 'and met at least one parcel').toBeGreaterThan(0);

    // Now back off and fight — a long way off, for a long time.
    let lowest = taken;
    let pulses = parcels;
    for (let i = 0; i < 60 * 15; i++) {
      w.player.integrity = w.player.maxIntegrity;
      w.player.x = gate.x - 1600;
      w.player.y = gate.y;
      w.advance(NO_INPUT);
      lowest = Math.min(lowest, gate.progress);
      pulses = Math.min(pulses, gate.siegePulse ?? 0);
    }
    expect(lowest, 'a gate must not give ground back').toBe(taken);
    expect(pulses, 'and must not re-arm a parcel already delivered').toBe(parcels);

    // Returning continues from where it stopped rather than repeating anything.
    for (let i = 0; i < 60 * 4; i++) {
      w.player.integrity = w.player.maxIntegrity;
      w.player.x = gate.x;
      w.player.y = gate.y;
      w.advance(HOLD);
    }
    expect(gate.progress).toBeGreaterThan(taken);
    expect(gate.siegePulse ?? 0).toBeGreaterThanOrEqual(parcels);
  });

  it('§21b.7 — a siege comes through the door, not out of the ground', () => {
    // It was a ring 460-1000 units around the gate: half of it landing *behind*
    // the player in ground they had just cleared, and a quarter of every parcel
    // silently dropped for falling inside the sealed room it was defending. The
    // code even predicted this, in a comment ruling out "a wave walking through
    // the door it is defending" as the alternative. That is the right sentence:
    // the next room is coming through the gap.
    const w = new World({ seed: 'siege-door', axiomId: 'ignition' });
    const gate = w.terminals.find((t) => t.gateId)!;
    const arena = w.arena;
    const barrier = (arena.gates ?? []).find((g) => g.id === gate.gateId)!.barrier!;
    const doorX = barrier.x + barrier.w / 2;
    const doorY = barrier.y + barrier.h / 2;

    // Captured where they *arrive*, not where they have walked to. Reading
    // positions at the end of the hold measures pathfinding: a siege body that
    // emerged from the door and closed on the player is behind them by then, and
    // that is the mechanic working, not the placement failing.
    w.enemies.length = 0;
    const arrivals: { x: number; y: number; px: number; py: number }[] = [];
    const seen = new WeakSet<object>();
    for (let i = 0; i < 60 * 12 && w.stats.gatesOpened === 0; i++) {
      w.player.integrity = w.player.maxIntegrity;
      w.player.x = gate.x;
      w.player.y = gate.y;
      w.advance({ moveX: 0, moveY: 0, dash: false, interact: true });
      for (const e of w.enemies) {
        if (!e.alive || !e.hardened || seen.has(e)) continue;
        seen.add(e);
        arrivals.push({ x: e.x, y: e.y, px: w.player.x, py: w.player.y });
      }
    }

    // Hardened bodies only. The ambient director keeps running during a hold, at
    // a third of its floor, and those come from the usual off-screen origins a
    // thousand units out — counting them measures the flow, not the siege.
    expect(arrivals.length, 'the siege should have delivered something').toBeGreaterThan(0);

    // **Nothing behind the player.** This is the whole test.
    //
    // Reported as a death trap, and it was one: the mouth sat 60 units in front
    // of the door, a player on the gate stands 120 off its face, and the safe
    // radius is 260 — so the radial push resolved the only way it could, which
    // was straight past them and out the back. Then the seal test refused the
    // doorway as unopened ground and the mirror retry reflected the rest through
    // the player as well. Two separate mechanisms, both putting the siege behind
    // somebody who had nowhere to go.
    const behind = arrivals.filter((a) => (a.px < doorX ? a.x < a.px : a.x > a.px));
    expect(behind.length, 'a siege arrival cut the player off from their escape').toBe(0);

    // They come *out of* the doorway, not near it. Measured: x 3961-4020 inside
    // a barrier spanning 3800-4140.
    const outside = arrivals.filter((a) => a.x < barrier.x || a.x > barrier.x + barrier.w);
    expect(outside.length, 'a siege arrival did not come through the door').toBe(0);

    // ...and §12.2 still holds. Satisfied by construction rather than corrected.
    const tooClose = arrivals.filter(
      (a) => hypot(a.x - a.px, a.y - a.py) < TUNABLE.spawnSafeRadius,
    );
    expect(tooClose.length, 'nothing may arrive in the player lap').toBe(0);

    // Spread across the opening rather than stacked on one point — the first
    // attempt at this satisfied every constraint above by pinning all 34 to two
    // coordinates, which is a column of enemies inside each other.
    const ys = arrivals.map((a) => a.y);
    expect(Math.max(...ys) - Math.min(...ys), 'the door should emit a front').toBeGreaterThan(
      barrier.h / 2,
    );
    void doorY;
  });

  it('§21b — the tutorial room fields no Suppressor at all', () => {
    // A Suppressor switches the Engine off, and the first room is where somebody
    // is still learning they have one. "My weapons stopped working" is the worst
    // available first lesson: it reads as the game being broken, not as a
    // mechanic. So The Heap declares no events, and every Suppressor a template
    // asks for is remapped into an ordinary body.
    //
    // They are not gone, they are *introduced properly*: the gate siege carries
    // the destination room's roster, so the first one arrives through the door
    // as part of what The Sink is — which is the same moment the player finds
    // out what is next.
    const w = new World({ seed: 'no-supp', axiomId: 'ignition' });
    const heap = w.currentLevel!;
    expect(heap.roster.events ?? [], 'the tutorial room has no punctuation').toHaveLength(0);

    const via = (w as unknown as { rosterVia(l: unknown): unknown[] }).rosterVia(heap);
    const apply = (id: string): string =>
      (w as unknown as { applyVia(e: string, v: unknown[]): { enemy: string } }).applyVia(id, via)
        .enemy;
    for (let i = 0; i < 50; i++) {
      expect(['mote', 'drifter']).toContain(apply('suppressor'));
    }

    // ...and the siege, which speaks for the room on the other side, still may.
    const sink = (w.arena.levels ?? []).find((l) => l.id !== heap.id)!;
    const siegeVia = (w as unknown as { rosterVia(l: unknown): unknown[] }).rosterVia(sink);
    const applySiege = (id: string): string =>
      (w as unknown as { applyVia(e: string, v: unknown[]): { enemy: string } }).applyVia(
        id,
        siegeVia,
      ).enemy;
    expect(applySiege('suppressor'), 'the gate siege introduces them').toBe('suppressor');
  });

  it('§21b — an uncapped room is untouched by any of that', () => {
    // The cap is opt-in data. A room that does not declare one behaves exactly
    // as it always has, or this is not a room ceiling, it is a global nerf.
    const w = new World({ seed: 'room-uncapped', axiomId: 'ignition' });
    const level = w.currentLevel!;
    const original = level.roster.threatCap;
    (level.roster as { threatCap?: number }).threatCap = undefined;
    try {
      w.threat = 40;
      expect(w.roomThreat).toBe(40);
      expect(w.roomThreatGap).toBe(0);
    } finally {
      (level.roster as { threatCap?: number }).threatCap = original;
    }
  });

  it('§11.2 — the suppression ceiling counts fields, not Suppressors', () => {
    // The other half, still worth holding: where suppression *is* allowed — a
    // gate siege is the room defending itself — the ceiling has to count fields
    // rather than definitions carrying `zoneRadius`. Measured before that fix:
    // 108 simultaneous fields during a gate hold, against a cap of two, with
    // zero actual Suppressors alive.
    const w = new World({ seed: 'fields', axiomId: 'ignition' });
    w.threat = 8;
    w.enemies.length = 0;
    let peak = 0;
    for (let i = 0; i < 60 * 40; i++) {
      w.player.integrity = w.player.maxIntegrity;
      w.advance(NO_INPUT);
      peak = Math.max(peak, suppressionFields(w));
    }
    expect(peak, 'nothing may blanket the arena in Engine-off auras').toBeLessThanOrEqual(
      TUNABLE.suppressorsAlive,
    );
  });

  it('a room caps its own punctuation (GDD §21b)', () => {
    // `events[].maxAlive` was documented as a per-room cap and read by nothing
    // for as long as levels have existed. The Sink says three. Ask for twelve.
    //
    // The Sink, because The Heap has no punctuation at all now — see the test
    // below. Standing the player in the room whose cap is under test, because
    // `currentLevel` is positional and the cap is read off it.
    const w = new World({ seed: 'eventcap', axiomId: 'ignition' });
    w.enemies.length = 0;
    const level = (w.arena.levels ?? []).find((l) => l.roster.events?.length)!;
    // Unsealed first: nothing arrives in ground the player has not opened, so a
    // locked room refuses every spawn and the cap under test is never reached.
    w.openBiomes.add(level.id);
    w.player.x = level.x + level.w / 2;
    w.player.y = level.y + level.h / 2;
    const cap = level.roster.events!.find((e) => e.id === 'suppressor')!.maxAlive;
    const queue = (
      w as unknown as {
        queueSpawn(e: string, x: number, y: number, s: number, d: number, via: unknown[]): void;
      }
    ).queueSpawn.bind(w);
    for (let i = 0; i < 12; i++) {
      queue('suppressor', w.player.x + 800, w.player.y + 800, 40, i * 0.05, []);
      w.advance(NO_INPUT);
    }
    for (let i = 0; i < 120; i++) w.advance(NO_INPUT);
    const live = w.enemies.filter((e) => e.alive && e.defId === 'suppressor').length;
    expect(live).toBeGreaterThan(0);
    expect(live).toBeLessThanOrEqual(cap);
  });

  it('every affix the roller can pick has an implementation', () => {
    // Replaces two hand-synced literal arrays. If an affix is added to the table
    // without traits, or a trait is named that no runner implements, this fails
    // rather than the affix quietly doing nothing.
    for (const id of TRAITS.AFFIX_IDS) {
      const entry = TRAITS.AFFIX_TRAITS[id]!;
      expect(entry.traits.length, `affix "${id}" grants nothing`).toBeGreaterThan(0);
      for (const spec of entry.traits) {
        expect(TRAITS.TRAIT_RUNNERS[spec.t], `affix "${id}" needs trait "${spec.t}"`).toBeDefined();
      }
    }
  });
});
