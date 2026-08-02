import { describe, expect, it } from 'vitest';
import {
  ECHO_FALLOFF,
  Engine,
  compileProgram,
  emptyProgram,
  expandExecutions,
  resolveChain,
} from './engine';
import { LOADBEARING, TUNABLE } from './tunables';

describe('modifier chain — order matters (GDD §5.5)', () => {
  it('Split -> Amplify differs from Amplify -> Split', () => {
    const splitFirst = resolveChain(['split', 'amplify']);
    const amplifyFirst = resolveChain(['amplify', 'split']);

    // Both produce three copies.
    expect(splitFirst.count).toBe(3);
    expect(amplifyFirst.count).toBe(3);

    // Split -> Amplify: (1 * 0.65) + 0.5 = 1.15
    expect(splitFirst.output).toBeCloseTo(1.15, 10);
    // Amplify -> Split: (1 + 0.5) * 0.65 = 0.975
    expect(amplifyFirst.output).toBeCloseTo(0.975, 10);

    // The load-bearing property: reordering is a real decision.
    expect(splitFirst.output).not.toBeCloseTo(amplifyFirst.output, 6);
  });

  it('composes sequentially through longer chains', () => {
    // Amplify -> Amplify -> Split: ((1 + 0.5) + 0.5) * 0.65
    expect(resolveChain(['amplify', 'amplify', 'split']).output).toBeCloseTo(1.3, 10);
    // Split -> Amplify -> Amplify: (1 * 0.65) + 0.5 + 0.5
    expect(resolveChain(['split', 'amplify', 'amplify']).output).toBeCloseTo(1.65, 10);
  });

  it('ignores empty slots', () => {
    expect(resolveChain([null, 'amplify', null]).output).toBeCloseTo(1.5, 10);
    expect(resolveChain([null, null, null]).output).toBe(1);
  });
});

describe('Echo expansion (GDD §5.5)', () => {
  it('doubles the execution schedule per level', () => {
    expect(expandExecutions(0)).toHaveLength(1);
    expect(expandExecutions(1)).toHaveLength(2);
    expect(expandExecutions(2)).toHaveLength(4);
    expect(expandExecutions(3)).toHaveLength(8);
  });

  it('applies geometric falloff and staggered delays', () => {
    const one = expandExecutions(1);
    expect(one[0]).toEqual({ delay: 0, outputMul: 1 });
    expect(one[1]!.outputMul).toBeCloseTo(ECHO_FALLOFF, 10);
    expect(one[1]!.delay).toBeCloseTo(0.2, 10);

    const two = expandExecutions(2);
    const total = two.reduce((s, e) => s + e.outputMul, 0);
    // 1 + 0.7 + 0.7 + 0.49
    expect(total).toBeCloseTo(2.89, 10);
  });

  it('cannot exceed the runtime safety cap', () => {
    expect(expandExecutions(64).length).toBeLessThanOrEqual(256);
  });
});

describe('cost model (GDD §5.3–5.5, §6.1)', () => {
  it('charges trigger cost plus action cost scaled by modifier multipliers', () => {
    const p = emptyProgram(0);
    p.triggerId = 'clock';
    p.actionId = 'bolt';
    expect(compileProgram(p).cycleCost).toBeCloseTo(1 + 2, 10);

    p.modifierIds[0] = 'split'; // x2.0
    expect(compileProgram(p).cycleCost).toBeCloseTo(1 + 2 * 2, 10);

    p.modifierIds[1] = 'echo'; // x1.8
    expect(compileProgram(p).cycleCost).toBeCloseTo(1 + 2 * 2 * 1.8, 10);
  });

  it('a Program without both a Trigger and an Action is not live', () => {
    const p = emptyProgram(0);
    expect(compileProgram(p).live).toBe(false);
    p.triggerId = 'clock';
    expect(compileProgram(p).live).toBe(false);
    p.actionId = 'bolt';
    expect(compileProgram(p).live).toBe(true);
  });

  it('Echo buys more output and far more events than it costs in Cycles', () => {
    // The design doc calls Echo deliberately the strongest modifier and says to
    // price it, not nerf it. This test documents that the price is currently
    // favourable — if a tuning pass inverts it, Echo has been nerfed by accident.
    const plain = emptyProgram(0);
    plain.triggerId = 'clock';
    plain.actionId = 'bolt';
    const echoed = emptyProgram(1);
    echoed.triggerId = 'clock';
    echoed.actionId = 'bolt';
    echoed.modifierIds[0] = 'echo';

    const a = compileProgram(plain);
    const b = compileProgram(echoed);
    const outputRatio =
      b.executions.reduce((s, e) => s + e.outputMul, 0) /
      a.executions.reduce((s, e) => s + e.outputMul, 0);
    const costRatio = b.cycleCost / a.cycleCost;

    expect(b.executions.length).toBeGreaterThan(a.executions.length);
    expect(outputRatio).toBeGreaterThan(costRatio);
  });
});

describe('topology nodes — row order as a build axis (GDD §5.6)', () => {
  it('Ground discounts the row above it, and only the row above', () => {
    const e = new Engine();
    e.programs[0]!.triggerId = 'clock';
    e.programs[0]!.actionId = 'nova';
    e.programs[1]!.triggerId = 'clock';
    e.programs[1]!.actionId = 'bolt';
    e.programs[2]!.triggerId = 'clock';
    e.programs[2]!.actionId = 'nova';
    e.recompile();

    const undiscounted = e.compiled[0]!.cycleCost;
    const untouched = e.compiled[2]!.cycleCost;

    e.programs[1]!.modifierIds[0] = 'ground';
    e.recompile();

    expect(e.compiled[0]!.cycleCost).toBeCloseTo(undiscounted * 0.7, 8);
    // The row below the Ground row is unaffected.
    expect(e.compiled[2]!.cycleCost).toBeCloseTo(untouched, 8);
    // And the Ground row pays for it in output.
    expect(e.compiled[1]!.ctx.output).toBeCloseTo(0.8, 8);
  });

  it('Ground on the first row discounts nothing', () => {
    const e = new Engine();
    e.programs[0]!.triggerId = 'clock';
    e.programs[0]!.actionId = 'bolt';
    e.programs[0]!.modifierIds[0] = 'ground';
    e.recompile();
    expect(e.compiled[0]!.cycleCost).toBeGreaterThan(0);
    expect(Number.isFinite(e.compiled[0]!.cycleCost)).toBe(true);
  });

  it('moving a Ground row changes which row is discounted', () => {
    const e = new Engine();
    for (let i = 0; i < 3; i++) {
      e.programs[i]!.triggerId = 'clock';
      e.programs[i]!.actionId = 'nova';
    }
    e.programs[2]!.modifierIds[0] = 'ground';
    e.recompile();
    // Row 1 is discounted, row 0 is not.
    const row0Before = e.compiled[0]!.cycleCost;
    expect(e.compiled[1]!.cycleCost).toBeLessThan(row0Before);

    // Move Ground up one: now row 0 is the one being discounted, and row 1 pays
    // full price again.
    e.moveProgram(2, 1);
    expect(e.compiled[0]!.cycleCost).toBeLessThan(row0Before);
    expect(e.compiled[2]!.cycleCost).toBeCloseTo(row0Before, 8);
  });
});

describe('Engine structure', () => {
  it('starts with the design-locked number of Program slots', () => {
    const e = new Engine();
    expect(e.programs).toHaveLength(LOADBEARING.programSlotsStart);
    expect(e.programs[0]!.modifierIds).toHaveLength(LOADBEARING.modifierSlotsPerProgram);
  });

  it('caps Program slots at the maximum', () => {
    const e = new Engine();
    while (e.addProgramSlot()) {
      /* fill */
    }
    expect(e.programs).toHaveLength(LOADBEARING.programSlotsMax);
    expect(e.addProgramSlot()).toBe(false);
  });

  it('auto-slots triggers, actions and modifiers into compatible slots', () => {
    const e = new Engine();
    expect(e.autoSlot('clock')).toBe(0);
    expect(e.autoSlot('bolt')).toBe(0);
    expect(e.programs[0]!.triggerId).toBe('clock');
    expect(e.programs[0]!.actionId).toBe('bolt');
    // A modifier prefers a live row so the player sees it fire (§17.3).
    expect(e.autoSlot('amplify')).toBe(0);
    expect(e.programs[0]!.modifierIds[0]).toBe('amplify');
  });

  it('scrapping refunds Cycles and grants permanent global output (§5.7)', () => {
    const e = new Engine();
    e.autoSlot('clock');
    e.autoSlot('bolt');
    e.autoSlot('split');
    const loadBefore = e.staticLoad;

    const refund = e.scrapNode(0, 0);
    expect(refund).toBeGreaterThan(0);
    expect(e.staticLoad).toBeLessThan(loadBefore);
    expect(e.globalOutput).toBeCloseTo(1 + TUNABLE.scrapOutputBonus, 10);

    e.scrapProgram(0);
    expect(e.staticLoad).toBe(0);
    // One stack for the scrapped modifier, two more for the trigger and action.
    expect(e.scrapStacks).toBe(3);
  });

  it('moves a node to another Program, swapping with whatever is there', () => {
    const e = new Engine();
    e.programs[0]!.triggerId = 'clock';
    e.programs[0]!.actionId = 'bolt';
    e.programs[0]!.modifierIds[0] = 'echo';
    e.programs[1]!.triggerId = 'on_kill';
    e.programs[1]!.actionId = 'nova';
    e.programs[1]!.modifierIds[0] = 'split';
    e.recompile();

    expect(e.moveNode(0, 0, 1, 0)).toBe('ok');
    expect(e.programs[1]!.modifierIds[0]).toBe('echo');
    expect(e.programs[0]!.modifierIds[0]).toBe('split');

    // Into an empty slot, no swap partner.
    expect(e.moveNode(1, 0, 1, 2)).toBe('ok');
    expect(e.programs[1]!.modifierIds[2]).toBe('echo');
    expect(e.programs[1]!.modifierIds[0]).toBe(null);
  });

  it('refuses to put a node in a slot of the wrong kind', () => {
    const e = new Engine();
    e.programs[0]!.triggerId = 'clock';
    e.programs[0]!.actionId = 'bolt';
    e.programs[0]!.modifierIds[0] = 'echo';
    e.recompile();

    expect(e.moveNode(0, 0, 0, 'action')).toBe('wrong-slot');
    expect(e.moveNode(0, 'trigger', 0, 1)).toBe('wrong-slot');
    expect(e.programs[0]!.actionId).toBe('bolt');
    expect(e.programs[0]!.modifierIds[0]).toBe('echo');
  });

  it('refuses a move that would reserve more Cycles than capacity (§6.1)', () => {
    const e = new Engine();
    // Row 0 live and cheap; row 1 parked with an expensive modifier on a dead
    // row, which costs nothing until it is attached to something live.
    e.programs[0]!.triggerId = 'clock';
    e.programs[0]!.actionId = 'nova';
    e.programs[1]!.modifierIds[0] = 'split';
    e.recompile();

    const before = e.staticLoad;
    expect(e.moveNode(1, 0, 0, 0, 5)).toBe('over-capacity');
    // Rolled back cleanly.
    expect(e.programs[0]!.modifierIds[0]).toBe(null);
    expect(e.programs[1]!.modifierIds[0]).toBe('split');
    expect(e.staticLoad).toBeCloseTo(before, 10);

    expect(e.moveNode(1, 0, 0, 0, 1000)).toBe('ok');
  });

  it('reordering Programs moves their clock accumulators with them', () => {
    const e = new Engine();
    e.autoSlot('clock');
    e.autoSlot('bolt');
    e.clocks[0] = 0.9;
    e.moveProgram(0, 2);
    expect(e.programs[2]!.actionId).toBe('bolt');
    expect(e.clocks[2]).toBeCloseTo(0.9, 10);
  });
});
