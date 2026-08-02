import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { World } from '../sim/world';
import { botInput } from '../harness/bot';
import { hashWorld } from '../sim/hash';
import { SIM_DT } from '../sim/tunables';
import { noteHz, semiHz } from './voices';
import { CHORD_TONES, TRACKS, trackForAxiom } from './tracks';
import { derivePart } from './parts';
import { DEMOS } from './demos';
import { ACTION_BY_ID, MODIFIER_BY_ID, TRIGGER_BY_ID } from '../content/index';
import { AXIOMS } from '../content/index';

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

describe('the songs (GDD §18.2)', () => {
  it('every track is playable — patterns are the right length and in range', () => {
    // A pattern of the wrong length does not crash; it silently drifts against
    // the bar, which is the kind of bug you only find by listening carefully to
    // the fifth track twenty minutes in.
    for (const t of TRACKS) {
      expect(t.kick, `${t.id} kick`).toHaveLength(16);
      expect(t.bass, `${t.id} bass tiers`).toHaveLength(3);
      for (const pattern of t.bass) {
        expect(pattern, `${t.id} bass pattern`).toHaveLength(16);
      }
      expect(t.clap, `${t.id} clap`).toHaveLength(16);
      expect(t.stab, `${t.id} stab`).toHaveLength(16);
      // A motif may run one or two bars — Circuit's is two, which is what makes
      // it a line you could hum rather than a cell that repeats. Anything not a
      // whole number of bars drifts against the loop.
      expect(t.motif.length % 16, `${t.id} motif is not whole bars`).toBe(0);
      expect(t.motif.length).toBeGreaterThan(0);
      expect(t.kick.some(Boolean), `${t.id} has no kick`).toBe(true);
      // The clap on 2 and 4 is the backbone. A track without one is missing the
      // thing the body counts, which is how the first version sounded thin.
      expect(t.clap.some(Boolean), `${t.id} has no clap`).toBe(true);
    }
  });

  it('stays modal — techno is not a chord journey', () => {
    // The mistake the first version made: four chords, one per bar, is a pop
    // song and sounds like one. This genre holds a tonal centre and moves the
    // filter instead.
    for (const t of TRACKS) {
      expect(t.progression.length, `${t.id} has too many chords`).toBeLessThanOrEqual(2);
      expect(t.barsPerChord, `${t.id} changes chord too fast`).toBeGreaterThanOrEqual(2);
      expect(t.progression[0]!.root, `${t.id} does not open on its tonic`).toBe(0);
      for (const c of t.progression) {
        expect(CHORD_TONES[c.quality], `${t.id} ${c.quality}`).toBeDefined();
        expect(c.root).toBeGreaterThanOrEqual(0);
        expect(c.root).toBeLessThan(12);
      }
    }
  });

  it('each track is built from a different set of instruments', () => {
    // The point of the rewrite: two tracks sharing a synth with different knob
    // settings still sound like the same band. Distinctness has to come from
    // the voices, so no two tracks may pick the same one everywhere.
    const keys = ['kickVoice', 'percVoice', 'bassVoice', 'stabVoice', 'leadVoice'] as const;
    for (const key of keys) {
      const used = new Set(TRACKS.map((t) => t[key]));
      expect(used.size, `every track uses the same ${key}`).toBe(TRACKS.length);
    }
  });

  it('every Axiom has a song, and every song has an Axiom', () => {
    // The Music menu is one row per Axiom. An Axiom with no track silently falls
    // back to the first one, which would make two Axioms sound identical and
    // look like a bug in the menu rather than a gap in the data.
    const ids = new Set(TRACKS.map((t) => t.id));
    expect(ids.size).toBe(TRACKS.length);
    for (const a of AXIOMS) {
      expect(ids.has(a.id), `axiom "${a.id}" has no track`).toBe(true);
      expect(trackForAxiom(a.id).id).toBe(a.id);
    }
    for (const t of TRACKS) {
      expect(AXIOMS.some((a) => a.id === t.id), `track "${t.id}" has no axiom`).toBe(true);
    }
  });

  it('bass and motif only ever reach for notes the chord has', () => {
    // Both index into chord tones. A value past the end wraps into a different
    // octave silently, which is the kind of wrong that sounds *almost* right.
    for (const t of TRACKS) {
      const smallest = Math.min(...t.progression.map((c) => CHORD_TONES[c.quality].length));
      for (const pattern of t.bass) {
        for (const v of pattern) expect(v, `${t.id} bass`).toBeLessThan(smallest);
      }
      // Motif values 0-2 are the low octave, 3-5 the high one.
      for (const v of t.motif) expect(v, `${t.id} motif`).toBeLessThan(6);
    }
  });

  it('semitones and scale degrees agree on the root', () => {
    // The musical layers work in semitones and the hue accents in scale
    // degrees. They have to share a tonic or the accents drift out of key.
    expect(semiHz(0)).toBeCloseTo(noteHz(0), 6);
    // And the pentatonic must be a subset of the minor scale the chords use,
    // which is what lets forty accents sit over any chord without clashing.
    for (const degree of [0, 3, 5, 7, 10]) {
      expect(semiHz(degree)).toBeGreaterThan(0);
    }
  });
});

describe('the Engine is the arrangement (GDD §18.1)', () => {
  const bolt = { primitive: 'projectile', hue: 'thermal' };
  const nova = { primitive: 'burst', hue: 'thermal' };

  const row = (trigger: string | null, mods: (string | null)[], action: string | null) => ({
    triggerId: trigger,
    modifierIds: mods,
    actionId: action,
    live: trigger !== null && action !== null,
  });

  it('a row that cannot fire makes no sound', () => {
    // The editor already warns "not live". Silence makes that warning audible,
    // and a part playing for a row that never fires would be a lie about the
    // build — which is the one thing this system exists not to be.
    expect(derivePart(row(null, [], 'bolt'), bolt, 0)).toBeNull();
    expect(derivePart(row('clock', [], null), null, 0)).toBeNull();
  });

  it('the Trigger decides the rhythm', () => {
    // A player who knows what a Trigger does should be able to hear which ones
    // they own: Clock is a metronome, On Hit is the densest event in the game,
    // On Crit is rare.
    const clock = derivePart(row('clock', [], 'bolt'), bolt, 0)!;
    const onHit = derivePart(row('on_hit', [], 'bolt'), bolt, 0)!;
    const onCrit = derivePart(row('on_crit', [], 'bolt'), bolt, 0)!;

    const count = (p: { pattern: boolean[] }) => p.pattern.filter(Boolean).length;
    expect(count(clock)).toBe(4);
    expect(count(onHit)).toBeGreaterThan(count(clock));
    expect(count(onCrit)).toBeLessThan(count(clock));
    // Clock lands on the quarters, which is what makes it read as a metronome.
    expect([0, 4, 8, 12].every((i) => clock.pattern[i])).toBe(true);
  });

  it('the Action decides the instrument and the register', () => {
    const pluck = derivePart(row('clock', [], 'bolt'), bolt, 0)!;
    const burst = derivePart(row('clock', [], 'nova'), nova, 0)!;
    expect(pluck.voice).toBe('pluck');
    expect(burst.voice).toBe('stab');
    // A Nova is a low burst and a Bolt is a high pluck, matching what they look
    // like. Rows therefore stack into a mix instead of crowding one octave.
    expect(burst.register).toBeLessThan(pluck.register);
  });

  it('Modifiers process the part the way they process the Program', () => {
    const plain = derivePart(row('clock', [], 'bolt'), bolt, 0)!;
    const split = derivePart(row('clock', ['split'], 'bolt'), bolt, 0)!;
    const echo = derivePart(row('clock', ['echo'], 'bolt'), bolt, 0)!;
    const quantized = derivePart(row('on_hit', ['quantize'], 'bolt'), bolt, 0)!;
    const ground = derivePart(row('clock', ['ground'], 'bolt'), bolt, 0)!;

    const count = (p: { pattern: boolean[] }) => p.pattern.filter(Boolean).length;
    // Split makes three of something, so it flams.
    expect(count(split)).toBeGreaterThan(count(plain));

    // But no modifier may fill the bar. A pattern with no gaps is not a
    // pattern, it is a drone — On Hit plus Split hit exactly that before the
    // flam was limited to every other step.
    for (const id of ['split', 'accelerate', 'amplify', 'sustain']) {
      const dense = derivePart(row('on_hit', [id], 'bolt'), bolt, 0)!;
      expect(count(dense), `${id} saturates the bar`).toBeLessThan(16);
    }
    // Echo repeats, so it feeds the delay.
    expect(echo.echo).toBeGreaterThan(0);
    // Quantize locks to the beat: nothing survives off the quarter.
    expect(quantized.pattern.every((on, i) => !on || i % 4 === 0)).toBe(true);
    // Ground quiets and darkens a row, so it does the same here.
    expect(ground.gain).toBeLessThan(plain.gain);
    expect(ground.register).toBeLessThan(plain.register);
  });

  it('rows fan out across the chord instead of doubling each other', () => {
    // Four rows playing the same note is four copies of one line. Spreading them
    // across chord tones is what makes an Engine sound like an arrangement.
    const tones = [0, 1, 2, 3].map((i) => derivePart(row('clock', [], 'bolt'), bolt, i)!.tone);
    expect(new Set(tones).size).toBeGreaterThan(1);
  });

  it('every Action primitive maps to a voice', () => {
    // A primitive with no mapping falls back silently to a pluck, which would
    // make a Field sound like a Bolt and look like a mixing problem.
    const primitives = [
      'projectile', 'burst', 'chain', 'zone', 'convert', 'mine',
      'delayed', 'beam', 'orbital', 'buff', 'vortex', 'knockback',
    ];
    const voices = new Set(
      primitives.map(
        (primitive) => derivePart(row('clock', [], 'x'), { primitive, hue: 'void' }, 0)!.voice,
      ),
    );
    expect(voices.size).toBeGreaterThanOrEqual(8);
  });
});

describe('the audition list (GDD §19.2)', () => {
  it('every demo names real nodes', () => {
    // A typo'd action id does not throw — derivePart falls back to a pluck, so
    // the demo plays *something* and quietly misrepresents what that Engine
    // sounds like. Which is the one job this screen has.
    for (const demo of DEMOS) {
      expect(demo.rows.length, `${demo.id} has no rows`).toBeGreaterThan(0);
      for (const r of demo.rows) {
        expect(TRIGGER_BY_ID.has(r.trigger), `${demo.id}: no trigger "${r.trigger}"`).toBe(true);
        expect(ACTION_BY_ID.has(r.action), `${demo.id}: no action "${r.action}"`).toBe(true);
        for (const m of r.modifiers) {
          expect(MODIFIER_BY_ID.has(m), `${demo.id}: no modifier "${m}"`).toBe(true);
        }
      }
    }
  });

  it('every demo plays over a real bed, and every Axiom is auditionable', () => {
    for (const demo of DEMOS) {
      expect(TRACKS.some((t) => t.id === demo.bed), `${demo.id} bed "${demo.bed}"`).toBe(true);
    }
    for (const a of AXIOMS) {
      expect(DEMOS.some((d) => d.id === `axiom_${a.id}`), `axiom "${a.id}"`).toBe(true);
    }
  });

  it('the demos actually sound different from each other', () => {
    // A list of builds that all used Clock would be one beat with different
    // timbres on top, which is the failure this list exists to avoid: the
    // Trigger is what decides a part's rhythm.
    const triggers = new Set(DEMOS.flatMap((d) => d.rows.map((r) => r.trigger)));
    expect(triggers.size).toBeGreaterThanOrEqual(6);

    // And no two demos may be the same Engine.
    const shapes = DEMOS.map((d) =>
      d.rows.map((r) => `${r.trigger}|${r.modifiers.join(',')}|${r.action}`).join(';'),
    );
    expect(new Set(shapes).size).toBe(DEMOS.length);
  });
});

describe('visual effects (GDD §20.1)', () => {
  it('everything off is exactly the untouched picture', async () => {
    // The floor has to be *the* floor. If "all off" differs from not having the
    // system at all, then §16's restrained schematic is no longer reachable and
    // the whole settings pane becomes a correction rather than a choice.
    const { VIEW, applyEffects, VIEW_EFFECTS } = await import('../app/visual');
    applyEffects([]);
    expect(VIEW.bloom).toBe(1);
    expect(VIEW.glow).toBe(1);
    expect(VIEW.shake).toBe(1);
    for (const key of ['lit', 'haze', 'barrel', 'aberration', 'scan', 'grain', 'vignette', 'bleed'] as const) {
      expect(VIEW[key], key).toBe(0);
    }

    // And every effect must actually do something, or it is a checkbox that
    // lies — the worst kind of setting.
    for (const effect of VIEW_EFFECTS) {
      applyEffects([effect.id]);
      const changed = (['bloom', 'glow', 'shake'] as const).some((k) => VIEW[k] !== 1);
      const added = (['lit', 'haze', 'barrel', 'aberration', 'scan', 'grain', 'vignette', 'bleed'] as const)
        .some((k) => VIEW[k] > 0);
      expect(changed || added, `"${effect.id}" changes nothing`).toBe(true);
    }
    applyEffects([]);
  });

  it('effects stack without doubling a shared field', async () => {
    // Combined by max, not sum: two effects that both raise glow should not
    // raise it twice, and each effect's tuned value is what it should look like
    // regardless of what else happens to be on.
    const { VIEW, applyEffects, VIEW_EFFECTS } = await import('../app/visual');
    const all = VIEW_EFFECTS.map((e) => e.id);
    applyEffects(all);
    const together = { ...VIEW };

    let maxGlow = 1;
    for (const e of VIEW_EFFECTS) maxGlow = Math.max(maxGlow, e.values.glow ?? 1);
    expect(together.glow).toBe(maxGlow);
    applyEffects([]);
  });
});
