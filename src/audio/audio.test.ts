import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { World } from '../sim/world';
import { botInput } from '../harness/bot';
import { hashWorld } from '../sim/hash';
import { SIM_DT } from '../sim/tunables';
import { noteHz } from './voices';

function sourcesIn(dir: string): [string, string][] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => [f, readFileSync(join(dir, f), 'utf8')] as [string, string]);
}

describe('audio never touches the simulation (GDD §0, §18)', () => {
  it('src/sim does not import src/audio', () => {
    // The load-bearing constraint. Audio is allowed to lag, drop voices, be
    // muted or fail to start entirely; none of that may change a run. The only
    // way to guarantee that is for the dependency to point one way, and the only
    // way to keep it pointing one way is to fail the build when it does not.
    for (const [file, src] of sourcesIn('src/sim')) {
      expect(src.includes("from '../audio"), `${file} imports audio`).toBe(false);
      expect(src.includes('AudioContext'), `${file} touches AudioContext`).toBe(false);
    }
  });

  it('draining cues leaves the run bit-identical', () => {
    // A world whose cues are consumed every tick and one whose cues pile up must
    // agree exactly — the cue list is derived data, like visualDeaths.
    const drained = new World({ seed: 'audio', axiomId: 'ignition' });
    const ignored = new World({ seed: 'audio', axiomId: 'ignition' });

    for (let i = 0; i < 60 * 45; i++) {
      drained.advance(botInput(drained));
      drained.audioCues.length = 0;
      ignored.advance(botInput(ignored));
    }

    expect(hashWorld(drained)).toBe(hashWorld(ignored));
    expect(drained.stats.kills).toBe(ignored.stats.kills);
  });

  it('a run actually produces cues, and they carry hue and depth', () => {
    const w = new World({ seed: 'cues', axiomId: 'ignition' });
    // Ignition alone is one Clock row and never cascades, so depth would stay 0
    // and the assertion below would pass vacuously. Give it a loop to climb.
    const p1 = w.engine.programs[1]!;
    p1.triggerId = 'on_kill';
    p1.actionId = 'bolt';
    w.engine.recompile();
    w.syncBudget();

    const kinds = new Set<string>();
    let sawDepth = false;

    for (let i = 0; i < 60 * 90; i++) {
      w.advance(botInput(w));
      for (const cue of w.audioCues) {
        kinds.add(cue.kind);
        if (cue.depth > 0) sawDepth = true;
        expect(cue.weight).toBeGreaterThanOrEqual(0);
        expect(cue.weight).toBeLessThanOrEqual(1);
      }
      w.audioCues.length = 0;
    }

    expect(kinds.has('fire')).toBe(true);
    expect(kinds.has('kill')).toBe(true);
    expect(kinds.has('pickup')).toBe(true);
    expect(sawDepth).toBe(true);
  });

  it('the cue list is bounded even under a cascade', () => {
    // A 600-EPS frame must not queue 600 allocations. The mixer caps voices
    // anyway; this caps the memory before it gets there.
    const w = new World({ seed: 'flood', axiomId: 'ignition' });
    const rows: [string, string, string | null][] = [
      ['clock', 'nova', 'split'],
      ['on_hit', 'arc', 'split'],
      ['on_kill', 'nova', 'amplify'],
    ];
    rows.forEach(([trigger, action, modifier], i) => {
      const p = w.engine.programs[i]!;
      p.triggerId = trigger;
      p.actionId = action;
      p.modifierIds[0] = modifier;
    });
    w.budget.capacity = 400;
    w.engine.recompile();
    w.syncBudget();

    let peak = 0;
    for (let i = 0; i < 60 * 60; i++) {
      w.player.alive = true;
      w.player.integrity = w.player.maxIntegrity;
      w.advance(botInput(w), SIM_DT);
      peak = Math.max(peak, w.audioCues.length);
      w.audioCues.length = 0;
    }
    expect(peak).toBeGreaterThan(0);
    expect(peak).toBeLessThanOrEqual(96);
  });
});

describe('the instrument (GDD §18.3)', () => {
  it('every note lands in one pentatonic scale', () => {
    // Simultaneity is the normal case here — a cascade fires forty notes on one
    // sixteenth. They can only ever sound intentional if the whole game is
    // playing from the same handful of pitches.
    const ratios = new Set<string>();
    for (let d = 0; d < 40; d++) {
      const hz = noteHz(d);
      expect(hz).toBeGreaterThan(0);
      // Fold into one octave and check it is one of the five degrees.
      let folded = hz;
      while (folded >= 110) folded /= 2;
      ratios.add((folded / 55).toFixed(4));
    }
    expect(ratios.size).toBe(5);
  });

  it('pitch climbs with cascade depth', () => {
    // The one thing a depth counter cannot convey: a deep cascade should be
    // audibly *going somewhere*.
    for (let d = 0; d < 12; d++) expect(noteHz(d + 1)).toBeGreaterThan(noteHz(d));
  });
});
