import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { World } from '../sim/world';
import { botInput } from '../harness/bot';
import { hashWorld } from '../sim/hash';
import { SIM_DT } from '../sim/tunables';
import { noteHz } from './voices';
import { derivePart } from './parts';
import { CELLS, GROUPS, parseMelodic, parsePerc, validate } from './cells';
import { arrange as arrangeWith, openingArrangement, type ArrangeInput } from './arrange';
import { current } from './scores/current';

/**
 * `arrange` bound to the current Score.
 *
 * Every test below is about how *this* Score selects — which cell a cascade build
 * gets, which register a five-row Engine leaves for the bass — so the Score is
 * bound once here rather than threaded through seventeen call sites. A test that
 * wants to compare two Scores calls `arrangeWith` directly.
 */
const arrange = (input: ArrangeInput) => arrangeWith(input, current);
import { explain } from './explain';
import { emptyLibrary, setUserCells } from './cells';
import { countCells, parseLibrary } from '../meta/cellstore';

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

  it('src/sim uses no implementation-approximated Math function', () => {
    // Not an audio concern, but the same shape of rule and the same file guards
    // it: a constraint that only holds while somebody remembers is not a
    // constraint.
    //
    // ECMA-262 lets an engine return whatever it likes from these, within a
    // tolerance, and engines use that freedom. Two recordings caught it in this
    // project: `Math.hypot` (Chrome vs Node, diverged at 0:30) and then
    // `Math.sin`/`Math.cos` (diverged at tick 3120 of an 11:41 run). `pow` and
    // `atan2` agreed between the two runtimes measured, which is luck rather
    // than a guarantee, so they are banned on the same grounds.
    //
    // What is left in here is the exact set: + - * /, sqrt, and the operations
    // that are integer arithmetic in disguise. See sim/num.ts.
    const banned = [
      'Math.hypot',
      'Math.sin',
      'Math.cos',
      'Math.tan',
      'Math.atan',
      'Math.asin',
      'Math.acos',
      'Math.pow',
      'Math.exp',
      'Math.log',
      'Math.cbrt',
      'Math.sinh',
      'Math.cosh',
      'Math.tanh',
      'Math.SQRT2',
      'Math.SQRT1_2',
      'Math.LN2',
      'Math.LN10',
      'Math.LOG2E',
      'Math.LOG10E',
      'Math.E',
      '**',
    ];
    for (const [file, src] of sourcesIn('src/sim')) {
      // num.ts is the implementation; num.test.ts is what proves it agrees with
      // the platform, which it cannot do without calling the platform.
      if (file === 'num.ts' || file === 'num.test.ts') continue;
      // Comments are allowed to name them — that is how the rule explains
      // itself. Only code counts.
      const code = src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');
      for (const name of banned) {
        expect(code.includes(name), `${file} uses ${name} — see sim/num.ts`).toBe(false);
      }
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

describe('the Music Lab (GDD §18, §19.2)', () => {
  it('the reason column stays true to the arrangement it describes', () => {
    // explain.ts restates what arrange.ts knows, which is the price of keeping a
    // debug concern out of the thing being debugged. This is what stops that
    // price becoming a lie: every slot it names must exist, and the value it
    // prints must be the value that is playing.
    const input = {
      axiomId: 'circuit',
      rows: [
        { triggerId: 'on_hit', primitive: 'chain', hue: 'voltaic' as const, modifiers: ['echo'] },
        { triggerId: 'clock', primitive: 'burst', hue: 'thermal' as const, modifiers: ['ground'] },
      ],
      intensity: 0.6,
    };
    const plan = arrange(input);
    const reasons = explain(input, plan);

    const byslot = new Map(reasons.map((r) => [r.slot, r]));
    expect(byslot.get('kick')!.value).toContain(plan.kick.id);
    expect(byslot.get('bass')!.value).toContain(plan.bass.id);
    expect(byslot.get('harmony')!.value).toContain(plan.harmony.id);
    expect(byslot.get('echo')!.value).toBe(plan.echo.toFixed(2));
    // Echo is drafted, so the reason has to say so — a mapping nobody can hear
    // named is a mapping that may as well be a constant.
    expect(byslot.get('echo')!.why).toMatch(/Echo/);
    expect(byslot.get('bass tone')!.why).toMatch(/Ground/);
    for (const reason of reasons) expect(reason.why.length).toBeGreaterThan(0);
  });

  it('a cell nobody wrote changes nothing', () => {
    // The pool seam is the only way a player can touch the soundtrack, and it
    // must be inert until used. An empty user library has to leave every
    // arrangement in the game bit-identical.
    const input = {
      axiomId: 'ignition',
      rows: [{ triggerId: 'clock', primitive: 'projectile', hue: 'thermal' as const, modifiers: [] }],
      intensity: 0.5,
    };
    const before = arrange(input);
    setUserCells(emptyLibrary());
    const during = arrange(input);
    setUserCells(null);
    const after = arrange(input);

    expect(during.kick.id).toBe(before.kick.id);
    expect(during.bass.id).toBe(before.bass.id);
    expect(after.signature).toBe(before.signature);
  });

  it('a written cell joins the pool and can be chosen', () => {
    // And the other half: a cell that *is* written has to be reachable. A
    // library the arranger never picks from is a text editor, not a feature.
    const mine = emptyLibrary();
    // Deliberately extreme, so scoring cannot prefer an authored cell over it.
    mine.kicks.push({
      id: 'test-relentless',
      pattern: 'XXXXXXXXXXXXXXXX',
      energy: 5,
      feel: 'rolling',
      space: 'sparse',
    });
    setUserCells(mine);
    const plan = arrange({
      axiomId: 'ignition',
      rows: Array.from({ length: 5 }, () => ({
        triggerId: 'clock',
        primitive: 'projectile',
        hue: 'thermal' as const,
        modifiers: ['accelerate'],
      })),
      intensity: 1,
    });
    setUserCells(null);
    expect(plan.kick.id).toBe('test-relentless');
  });

  it('a library is rejected whole, with a reason a person can act on', () => {
    // Half-loading is how you spend an evening chasing a bar that drifts a
    // sixteenth. Each of these is a mistake somebody will actually make.
    const bad = [
      ['{"kicks":[{"id":"a","pattern":"x...x...x...x..","energy":1,"feel":"straight","space":"mid"}]}', /15 steps/],
      ['{"kicks":[{"id":"a","pattern":"x...x...q...x...","energy":1,"feel":"straight","space":"mid"}]}', /percussion/],
      ['{"basslines":[{"id":"b","steps":"3...............","energy":1,"register":"low","space":"mid"}]}', /needsSeventh/],
      ['{"kicks":[{"pattern":"x...x...x...x..."}]}', /needs an id/],
      ['not json at all', /not JSON/],
    ] as const;

    for (const [text, pattern] of bad) {
      const result = parseLibrary(text);
      expect('error' in result, `expected "${text.slice(0, 30)}" to fail`).toBe(true);
      if ('error' in result) expect(result.error).toMatch(pattern);
    }

    const good = parseLibrary(
      '{"hats":[{"id":"mine","pattern":"..x...x...x...x.","energy":2,"feel":"straight","space":"mid"}]}',
    );
    expect('library' in good).toBe(true);
    if ('library' in good) expect(countCells(good.library)).toBe(1);
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

describe('the cell library (GDD §18)', () => {
  it('validates — every pattern is whole bars of legal characters', () => {
    // Also run at import time, but asserted here so a failure is a red test
    // rather than a blank screen. A malformed pattern does not throw on its own:
    // a 15-step bar slips a sixteenth every bar and takes twenty minutes of
    // listening to notice.
    expect(() => validate(CELLS)).not.toThrow();
  });

  it('rejects a cell reaching for a seventh it has not declared', () => {
    // The bug this codebase already shipped once: an index past the end of the
    // chord wraps silently back to the root, which sounds almost right.
    expect(() =>
      validate({
        ...CELLS,
        basslines: [
          { id: 'bad', steps: '3...............', energy: 1, register: 'low', space: 'mid' },
        ],
      }),
    ).toThrow(/needsSeventh/);
  });

  /**
   * The rule moved, deliberately, and this is the record of it.
   *
   * It used to be "one or two chords, held at least two bars, opening on the
   * tonic", justified as *techno is modal*. Techno is; this engine is not only
   * for techno, and the rule was quietly deciding that nothing it ever played
   * could contain a progression — the fastest harmony could move was one change
   * every two bars, which is a large part of why eight Scores sounded like one.
   *
   * Now one to four chords, a bar minimum, starting wherever it likes. Still
   * bounded: four is a loop you can learn, and the bound is what keeps the
   * arranger choosing between phrases rather than replaying a song somebody
   * wrote.
   */
  it('allows a real progression, and still bounds it', () => {
    const progression = (chords: { root: number; quality: string }[], barsPerChord: number) =>
      validate({
        ...CELLS,
        harmonies: [{ id: 'p', chords, barsPerChord, mood: 'lifting' }],
      });

    // Four chords, one bar each, not opening on the tonic: all legal now.
    expect(() =>
      progression(
        [
          { root: 8, quality: 'maj' },
          { root: 10, quality: 'maj' },
          { root: 0, quality: 'min' },
          { root: 5, quality: 'min' },
        ],
        1,
      ),
    ).not.toThrow();

    // Five is a song rather than a vocabulary.
    expect(() =>
      progression(
        [
          { root: 0, quality: 'min' },
          { root: 3, quality: 'maj' },
          { root: 5, quality: 'min' },
          { root: 7, quality: 'min' },
          { root: 10, quality: 'maj' },
        ],
        1,
      ),
    ).toThrow(/one to four/);

    // And a chord that changes inside a bar is a chord nobody hears.
    expect(() => progression([{ root: 0, quality: 'min' }], 0)).toThrow(/at least a bar/);
  });

  /**
   * Scale cells widen the alphabet; chord cells must not get it by accident.
   *
   * A `5` in a chord-relative cell is not a scale degree, it is a typo that would
   * wrap silently back into the triad — the same failure mode `needsSeventh`
   * exists to catch.
   */
  it('keeps the two melodic alphabets apart', () => {
    const melodic = (cell: Record<string, unknown>) =>
      validate({ ...CELLS, motifs: [{ register: 'mid', space: 'mid', energy: 2, ...cell } as never] });

    expect(() => melodic({ id: 'scaley', steps: '0246a.c.........', scale: true })).not.toThrow();
    expect(() => melodic({ id: 'chordy', steps: '0246a.c.........' })).toThrow(/chord cell/);
  });

  it('parses percussion weights and melodic octaves', () => {
    const perc = parsePerc('X.xo------------');
    expect(perc[0]!.gain).toBeGreaterThan(perc[2]!.gain);
    expect(perc[3]!.gain).toBeLessThan(perc[2]!.gain);
    expect(perc[1]).toBeNull();
    expect(perc[4]!.open).toBe(true);

    const mel = parseMelodic({
      id: 't',
      steps: '0a~.............',
      accent: 'x...............',
      slide: '.~..............',
      energy: 1,
      register: 'low',
      space: 'mid',
    });
    expect(mel[0]).toMatchObject({ tone: 0, octave: 0, accent: true });
    expect(mel[1]).toMatchObject({ tone: 0, octave: 1, slide: true });
    expect(mel[2]!.hold).toBe(true);
    expect(mel[3]).toBeNull();
  });
});

describe('the arranger (GDD §18.1)', () => {
  const row = (
    triggerId: string,
    primitive: string,
    hue: 'thermal' | 'voltaic' | 'void',
    modifiers: string[] = [],
  ) => ({ triggerId, primitive, hue, modifiers });

  it('is deterministic — the same Engine always sounds the same', () => {
    // A build is a thing you return to. A track that reshuffled on identical
    // input would make that untrue, and would make every assertion below
    // meaningless as well.
    const input = {
      axiomId: 'circuit',
      rows: [row('clock', 'projectile', 'thermal'), row('on_hit', 'chain', 'voltaic', ['echo'])],
      intensity: 0.5,
    };
    const a = arrange(input);
    const b = arrange(input);
    expect(a.signature).toBe(b.signature);
    for (const key of ['kick', 'backbeat', 'hats', 'bass', 'motif', 'stab', 'harmony'] as const) {
      expect(a[key].id).toBe(b[key].id);
    }
  });

  it('different builds sound different', () => {
    const cascade = arrange({
      axiomId: 'ignition',
      rows: [row('on_hit', 'chain', 'voltaic', ['overdrive'])],
      intensity: 0.6,
    });
    const metronome = arrange({
      axiomId: 'ignition',
      rows: [row('clock', 'zone', 'void')],
      intensity: 0.6,
    });
    // Different hue, so a different kit; different trigger, so a different mood.
    expect(cascade.kickVoice).not.toBe(metronome.kickVoice);
    expect(cascade.harmony.mood).not.toBe(metronome.harmony.mood);
  });

  it('the modifiers you own are audible', () => {
    const of = (modifiers: string[]) =>
      arrange({
        axiomId: 'ignition',
        rows: [row('clock', 'projectile', 'thermal', modifiers)],
        intensity: 0.5,
      });
    const plain = of([]);

    // Draft Echo and the room opens up; draft Ground and the bass goes dark.
    // Every one of these is a modifier a player can point at, which is the bar
    // every mapping in the arranger has to clear.
    expect(of(['echo']).echo).toBeGreaterThan(plain.echo);
    expect(of(['ground']).bassBrightness).toBeLessThan(plain.bassBrightness);
    expect(of(['overdrive']).bassBrightness).toBeGreaterThan(plain.bassBrightness);
  });

  it('a fuller Engine gets a sparser bass', () => {
    // The most important rule in the arranger. Without it a five-row build and a
    // busy bassline compete for the same bar and neither wins.
    const one = arrange({
      axiomId: 'ignition',
      rows: [row('clock', 'projectile', 'thermal')],
      intensity: 0.8,
    });
    const five = arrange({
      axiomId: 'ignition',
      rows: [
        row('clock', 'projectile', 'thermal'),
        row('on_hit', 'burst', 'thermal'),
        row('on_kill', 'chain', 'voltaic'),
        row('on_pickup', 'zone', 'void'),
        row('on_crit', 'beam', 'voltaic'),
      ],
      intensity: 0.8,
    });
    const rank = { sparse: 0, mid: 1, busy: 2 } as const;
    expect(rank[five.bass.space]).toBeLessThanOrEqual(rank[one.bass.space]);
  });

  it('never selects a cell the chord cannot play', () => {
    const triggers = ['clock', 'on_hit', 'on_kill', 'on_convert', 'on_crit'];
    const primitives = ['projectile', 'burst', 'chain', 'zone', 'convert'];
    const hues = ['thermal', 'voltaic', 'void'] as const;

    for (const axiomId of ['ignition', 'circuit', 'feedback']) {
      for (let n = 0; n <= 5; n++) {
        for (const intensity of [0, 0.3, 0.6, 1]) {
          const plan = arrange({
            axiomId,
            rows: Array.from({ length: n }, (_, i) =>
              row(triggers[i % 5]!, primitives[i % 5]!, hues[i % 3]!),
            ),
            intensity,
          });
          const hasSeventh = plan.harmony.chords.some((c) => c.quality === 'min7');
          for (const cell of [plan.bass, plan.motif]) {
            if (cell.needsSeventh) {
              expect(hasSeventh, `${axiomId}/${n}: "${cell.id}" over ${plan.harmony.id}`).toBe(true);
            }
          }
        }
      }
    }
  });

  it('an Engine with nothing in it still has a floor', () => {
    // Run one, before the first Draft. A kick and a chord at minimum, or the
    // opening seconds are silence.
    const opening = openingArrangement('ignition', current);
    expect(opening.kick.pattern).toMatch(/[xX]/);
    expect(opening.harmony.chords.length).toBeGreaterThan(0);
  });

  it('every cell in the library can actually be selected', () => {
    // The failure this catches is invisible from every other angle: a cell that
    // is written, tagged, validated, listed in the Desk's dropdown — and never
    // once chosen, because nothing the arranger asks for can reach it. Four of
    // them were, and the only reason anyone noticed is that a spread was
    // measured by hand.
    //
    // Three ways it happened, all worth naming:
    //   · an energy of 5, when the request is `1 + intensity * 3` and intensity
    //     is capped at 1, so nothing ever asked above 4;
    //   · a `space` of busy, when the request only ever said sparse or mid;
    //   · a `feel` of broken, when no Axiom bias is broken and no modifier asked
    //     for it, so every cross-rhythm in the pool was decorative.
    //
    // Scoring makes all three silent. A filter that matched nothing would fall
    // back loudly; a score that matches nothing just always loses.
    // Strided rather than consecutive, and with enough quiet Triggers to build
    // an Engine that never loops. Walking the list in order meant every
    // three-row Engine contained a cascade Trigger or a Convert, so the whole
    // `lifting` mood was missing from the sweep and not from the game.
    const triggers = [
      'clock',
      'on_hit',
      'on_kill',
      'on_pickup',
      'on_crit',
      'on_convert',
      'on_wave',
      'on_dash',
    ];
    const primitives = ['projectile', 'burst', 'chain', 'zone', 'orbital', 'beam', 'convert'];
    const hues = ['thermal', 'voltaic', 'void'] as const;
    const mods = [[], ['echo'], ['accelerate'], ['overdrive'], ['ground'], ['ricochet']];

    const seen: Record<string, Set<string>> = {
      kicks: new Set(),
      backbeats: new Set(),
      hats: new Set(),
      basslines: new Set(),
      motifs: new Set(),
      stabs: new Set(),
      harmonies: new Set(),
    };

    for (const axiomId of ['ignition', 'circuit', 'feedback']) {
      // Size 0 is run one, and it is the only request that ever asks for the
      // quietest cell in a pool.
      for (let size = 0; size <= 5; size++) {
        for (let variant = 0; variant < 14; variant++) {
          // Finely enough to hit every integer energy the requests can round to.
          // Intensity is continuous in a real run, so a coarse sample here would
          // invent unreachable cells that are reachable in play — which is a
          // worse failure than the one this test exists to catch, because it
          // would send someone editing a cell that was never broken.
          for (const intensity of [0, 0.2, 0.35, 0.5, 0.65, 0.8, 1]) {
            const plan = arrange({
              axiomId,
              rows: Array.from({ length: size }, (_, i) => ({
                triggerId: triggers[(i * 3 + variant) % triggers.length]!,
                primitive: primitives[(i * 2 + variant) % primitives.length]!,
                hue: hues[(i + variant) % 3]!,
                modifiers: mods[(i + variant) % mods.length]!,
              })),
              intensity,
            });
            seen.kicks!.add(plan.kick.id);
            seen.backbeats!.add(plan.backbeat.id);
            seen.hats!.add(plan.hats.id);
            seen.basslines!.add(plan.bass.id);
            seen.motifs!.add(plan.motif.id);
            seen.stabs!.add(plan.stab.id);
            seen.harmonies!.add(plan.harmony.id);
          }
        }
      }
    }

    for (const group of GROUPS) {
      for (const cell of CELLS[group]) {
        expect(
          seen[group]!.has(cell.id),
          `"${cell.id}" is in ${group} but no Engine can reach it`,
        ).toBe(true);
      }
    }
  });
});

describe('the source tree stays loadable', () => {
  /**
   * Every source file must be valid UTF-8.
   *
   * This is here because it broke a build and nothing caught it. A tool wrote
   * `src/app/wavelab.ts` as cp1252, so the section signs and em-dashes in its
   * comments became bytes no UTF-8 decoder accepts. `tsc --noEmit` passed, the
   * whole test suite passed, and the dev server served it happily — Vite's
   * transform is lenient. Only `vite build` refused it, with
   * "stream did not contain valid UTF-8", which on a branch that auto-deploys
   * means the failure surfaces after the push rather than before it.
   *
   * A linter does not check this either: Biome read all 71 files and reported
   * nothing. So it lives here, next to the other invariant this codebase
   * enforces by test rather than by hope.
   */
  it('is valid UTF-8 from end to end', async () => {
    const { readdirSync, readFileSync } = await import('node:fs');
    const { join } = await import('node:path');

    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(ts|tsx|json|css|html)$/.test(entry.name)) files.push(full);
      }
    };
    walk('src');
    expect(files.length).toBeGreaterThan(20);

    const decoder = new TextDecoder('utf-8', { fatal: true });
    const bad: string[] = [];
    for (const file of files) {
      try {
        decoder.decode(readFileSync(file));
      } catch {
        bad.push(file);
      }
    }
    expect(bad, `not valid UTF-8: ${bad.join(', ')}`).toEqual([]);
  });
});
