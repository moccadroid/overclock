import { describe, expect, it } from 'vitest';
import { ACTIVE_PILOT, PILOTS, pilot, pilotDraftChoice } from './pilots';
import { World } from '../sim/world';
import { rollDraft, type DraftCard } from '../sim/draft';

/**
 * The pilot is an input to the balance, not harness plumbing — the draft reacts
 * to what you own and what you refuse, so how a run drafts changes the pool that
 * run sees. These check the thing that makes a pilot usable as a measuring
 * instrument: that it is total, and that it is deterministic.
 */
describe('pilot policies (GDD §23.2)', () => {
  it('every pilot scores every class of card', () => {
    // A missing class scores zero and is therefore never taken — a pilot that
    // silently cannot draft Triggers would look like a finding about the pool.
    const classes = ['trigger', 'action', 'modifier', 'capacity', 'program_slot', 'stat', 'tool'];
    for (const p of PILOTS) {
      for (const cls of classes) {
        const rules = p.scores[cls as keyof typeof p.scores];
        expect(rules?.length, `pilot "${p.id}" does not score "${cls}"`).toBeGreaterThan(0);
        // The last rung must be unconditional, or a card can fall through every
        // rule and score zero for reasons the profile never states.
        expect(
          rules![rules!.length - 1]!.when,
          `pilot "${p.id}" has no default rung for "${cls}"`,
        ).toBeUndefined();
      }
    }
  });

  it('every pilot picks a real card from a real offer', () => {
    for (const p of PILOTS) {
      const world = new World({ seed: `pilot-${p.id}`, axiomId: 'ignition' });
      const offer = rollDraft(world);
      const choice = pilotDraftChoice(world, offer.cards, p);
      expect(choice, `pilot "${p.id}" chose out of range`).toBeGreaterThanOrEqual(0);
      expect(choice).toBeLessThan(offer.cards.length);
    }
  });

  it('is a pure function of the world and the offer', () => {
    // Recompile policy used to be a module-level mutable global, so a sweep that
    // ran two pilots leaked the first one's setting into the second. That shows
    // up as an unreproducible ten-percent difference, which is the worst kind.
    for (const p of PILOTS) {
      const world = new World({ seed: 'pilot-pure', axiomId: 'ignition' });
      const offer = rollDraft(world);
      const first = pilotDraftChoice(world, offer.cards, p);
      // Interleave another pilot; the answer must not move.
      pilotDraftChoice(world, offer.cards, pilot(PILOTS[0]!.id === p.id ? PILOTS[1]!.id : PILOTS[0]!.id));
      expect(pilotDraftChoice(world, offer.cards, p)).toBe(first);
    }
  });

  it('breaks ties on the first card, as the hand-written scorer did', () => {
    const world = new World({ seed: 'pilot-ties', axiomId: 'ignition' });
    const same: DraftCard[] = [{ kind: 'tool', tool: 'reroll' }, { kind: 'tool', tool: 'purge' }];
    expect(pilotDraftChoice(world, same, ACTIVE_PILOT)).toBe(0);
  });

  it('the pilots differ from each other', () => {
    // Three profiles that all draft identically would measure one taste under
    // three names, which is worse than having one: it reads as corroboration.
    const choices = PILOTS.map((p) => {
      const world = new World({ seed: 'pilot-spread', axiomId: 'ignition' });
      const picks: string[] = [];
      for (let i = 0; i < 40; i++) {
        const offer = rollDraft(world);
        const card = offer.cards[pilotDraftChoice(world, offer.cards, p)]!;
        picks.push(card.kind === 'node' ? card.nodeId : card.kind);
      }
      return picks.join(',');
    });
    expect(new Set(choices).size, 'two pilots draft identically').toBe(PILOTS.length);
  });
});
