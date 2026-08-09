/**
 * The schedule, frozen.
 *
 * Three deterministic scripts are driven through the real `Audio`, the real
 * `Clock` and the real voices against a stub AudioContext, and everything that
 * would have made a sound is written to a text golden. See `recorder.ts` for why
 * this records the schedule instead of rendering audio.
 *
 * **What a failure here means.** These goldens are not a style guide and not an
 * approval — they are a record of what the game currently plays. A diff means one
 * of two things:
 *
 *   - You changed a number and did not mean to. Fix the number.
 *   - You changed a number and did mean to. **That is a sound change**, it needs
 *     the user's ears, and `vitest -u` is how you record the new baseline once
 *     they have signed it off. It is not a formality to clear on the way past.
 *
 * The same deal `structure.test.ts` strikes for the flow look, for the same
 * reason: the recipe lives in bare constants where no type checker will ever
 * notice a drift.
 */
import { describe, expect, it, vi } from 'vitest';

/**
 * Wrap every voice so a call is recorded before it is played.
 *
 * `vi.mock` rather than a hook in `audio.ts`, because step 0 of this refactor
 * must not touch production code — a safety net that changed the thing it is
 * meant to be measuring would be worthless. The factory is hoisted above every
 * import, which is why the recorder is reached through a module-level slot.
 *
 * Calls pass straight through to the real voice, so the DSP still runs and the
 * named-graph automation below is still exercised.
 */
vi.mock('./voices', async (importOriginal) => {
  const real = await importOriginal<typeof import('./voices')>();
  const { activeRecorder } = await import('./recorder');

  // Two voices take a leading discriminator, so their time argument is not
  // where every other voice keeps it.
  const AT_INDEX: Record<string, number> = { playHue: 2, playPart: 2 };
  // Pure maths, called constantly, carrying no schedule. Logging them would
  // bury the file in pitch conversions.
  const NOT_A_VOICE = new Set(['semiHz', 'noteHz']);

  const wrapped: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(real)) {
    if (typeof value !== 'function' || NOT_A_VOICE.has(name)) {
      wrapped[name] = value;
      continue;
    }
    const at = AT_INDEX[name] ?? 1;
    wrapped[name] = (...args: unknown[]) => {
      activeRecorder()?.voice(name, args[at] as number, args);
      return (value as (...a: unknown[]) => unknown)(...args);
    };
  }
  return wrapped;
});

import { Audio } from './audio';
import { arrange } from './arrange';
import { derivePart, type Part } from './parts';
import { current } from './scores/current';
import { deep } from './scores/deep';
import { vault } from './scores/vault';
import { SCORES, validateScores, type Score } from './score';
import { fromScoreData, parseScoreData, stringifyScoreData, toScoreData } from './scoredata';
import {
  installStubAudio,
  SCRIPTS,
  setActiveRecorder,
  StubNode,
  type ParamEvent,
  type Recorder,
  type Script,
  type StepMark,
  type VoiceEvent,
} from './recorder';

// ------------------------------------------------------------------- driving

/**
 * One simulated frame. The game's own smoothing (`intensity` moves 4% a frame)
 * is frame-rate dependent, so the harness has to commit to a rate or the
 * arrangement would arrive at different times on different machines.
 */
const FRAME_S = 1 / 60;

interface Recording {
  rec: Recorder;
  graph: string;
}

/** An arrangement's signature under a given Score, for the dedupe assertion. */
function arrangeFor(score: Score): string {
  const script = SCRIPTS.find((s) => s.name === 'run')!;
  return arrange({ axiomId: script.axiomId, rows: script.rows, intensity: 0.5 }, score).signature;
}

function drive(script: Script, score?: Score): Recording {
  const env = installStubAudio();
  setActiveRecorder(env.rec);
  try {
    const audio = new Audio();
    // Before `start()`, because the bus graph is built once from `score.graph`.
    if (score) audio.setScore(score);
    audio.start();

    // Named from the fields that hold it, then frozen before anything moves it.
    env.rec.nameGraph(audio);
    const graph = formatGraph(env.rec);
    env.rec.phase = 'run';

    // The grid, so events can be reported at the bar and step they land on.
    //
    // Reaching past `private` for the clock, which is worth doing deliberately
    // rather than quietly: `Clock.onStep` is public and additive, the listener
    // only reads, and the alternative is deriving step times from bpm — which
    // would silently drift the moment Meltdown moved the tempo, and be wrong in
    // exactly the script that tests Meltdown.
    const clock = (audio as unknown as { clock: { onStep(fn: (s: StepMark) => void): void } })
      .clock;
    clock.onStep((s) => env.rec.steps.push({ time: s.time, index: s.index, count: s.count }));

    audio.beginRun();
    audio.setEngine({
      axiomId: script.axiomId,
      rows: script.rows,
      intensity: script.frame(0).intensity,
    });
    audio.setParts(partsFor(script, score));

    const wanted = script.bars * 16;
    let frame = 0;
    // The frame cap is a hang guard, not a duration: at 60fps and 112bpm even the
    // 36-bar script needs about 4,600.
    while (env.rec.steps.length < wanted && frame < 40_000) {
      env.ctx.advance(FRAME_S);
      const bar = Math.floor(env.rec.steps.length / 16);
      audio.update(script.frame(bar), script.cues?.(frame) ?? []);
      env.pump();
      frame++;
    }
    if (env.rec.steps.length < wanted) {
      throw new Error(`${script.name}: clock stalled at ${env.rec.steps.length}/${wanted} steps`);
    }

    return { rec: env.rec, graph };
  } finally {
    setActiveRecorder(null);
    env.restore();
  }
}

function partsFor(script: Script, score?: Score): (Part | null)[] {
  return script.rows.map((row, i) =>
    derivePart(
      {
        triggerId: row.triggerId,
        modifierIds: row.modifiers,
        // The id is never read for anything but liveness; the primitive below is
        // what picks the instrument.
        actionId: row.primitive,
        live: true,
      },
      { primitive: row.primitive, hue: row.hue },
      i,
      // The Score's own tables. Without this the harness drove every Score
      // through the *default* parts, so a Score with its own could schedule a
      // NaN all day and every test here would pass.
      score?.feel.parts,
    ),
  );
}

// ---------------------------------------------------------------- formatting

function num(v: number): string {
  if (!Number.isFinite(v)) return String(v);
  // Two places above 100 keeps a frequency readable; three below it keeps a gain
  // honest. Both are far finer than any change worth making on purpose.
  return Math.abs(v) >= 100 ? v.toFixed(2) : v.toFixed(3);
}

function value(v: unknown): string {
  if (typeof v === 'number') return num(v);
  if (typeof v === 'string') return v;
  if (typeof v === 'boolean') return String(v);
  if (v === null || v === undefined) return '-';
  if (Array.isArray(v)) return `[${v.map(value).join(' ')}]`;
  if (typeof v === 'object') {
    return `{${Object.entries(v as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, x]) => `${k}=${value(x)}`)
      .join(' ')}}`;
  }
  return String(v);
}

/**
 * Argument labels, so the primary golden reads as music rather than as a tuple.
 *
 * Positions after the context and the time, in order. A voice with no entry falls
 * back to bare positional values — new voices still record, they just read less
 * well until somebody adds a line here.
 */
const ARG_NAMES: Record<string, readonly string[]> = {
  kick: ['gain', 'voice'],
  perc: ['gain', 'voice'],
  hat: ['gain', 'open'],
  sub: ['hz', 'gain', 'dur'],
  bass: ['hz', 'gain', 'opts'],
  stab: ['tones', 'gain', 'voice'],
  motif: ['hz', 'gain', 'voice', 'glideFrom'],
  gatedChord: ['tones', 'gain', 'dur', 'wave'],
  playPart: ['voice', 'hz', 'gain', 'length', 'bite', 'glideFrom'],
  playHue: ['hue', 'hz', 'gain'],
  hurt: ['gain'],
  gate: ['seconds', 'gain'],
  breach: ['seconds', 'gain'],
  meltdown: ['seconds', 'gain'],
  summons: ['seconds', 'gain', 'hardened'],
  siegeHit: ['gain', 'big'],
  siegeDrone: ['dur', 'hz', 'gain', 'siege'],
  siegeScream: ['dur', 'hz', 'gain', 'siege', 'up'],
};

const AT_INDEX: Record<string, number> = { playHue: 2, playPart: 2 };

function args(event: VoiceEvent): string {
  const at = AT_INDEX[event.name] ?? 1;
  const rest = event.args.filter((_, i) => i !== 0 && i !== at);
  // Trailing optionals that were never passed carry no information.
  while (rest.length > 0 && rest[rest.length - 1] === undefined) rest.pop();
  const names = ARG_NAMES[event.name];
  return rest
    .map((v, i) => (names?.[i] ? `${names[i]} ${value(v)}` : value(v)))
    .join('  ');
}

const EPS = 1e-9;

/** The last sixteenth at or before `at`, and how far past it this landed. */
function place(steps: readonly StepMark[], at: number): string {
  let lo = 0;
  let hi = steps.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (steps[mid]!.time <= at + EPS) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (best < 0) return '  pre       ';
  const mark = steps[best]!;
  const bar = Math.floor(mark.count / 16);
  const offset = (at - mark.time) * 1000;
  // Swing and scheduled tails land between steps, and that offset is itself a
  // tuned value — `feel.swing` is only visible here.
  const tail = offset >= 0.5 ? `+${offset.toFixed(0)}ms` : '';
  return `${String(bar).padStart(3)}:${String(mark.index).padStart(2, '0')} ${tail.padEnd(6)}`;
}

function formatVoices(rec: Recorder): string {
  const lines = [
    '# voice calls — every note the sequencer asked for',
    '# bar:step (+offset into the step)   bus   voice   arguments',
    '',
  ];
  for (const event of rec.voices) {
    lines.push(
      `${place(rec.steps, event.at)}  ${(event.bus ?? '-').padEnd(10)} ${event.name.padEnd(12)} ${args(event)}`.trimEnd(),
    );
  }
  lines.push('', `# ${rec.voices.length} calls over ${rec.steps.length} steps`);
  return `${lines.join('\n')}\n`;
}

function formatGraph(rec: Recorder): string {
  const built = new Map<StubNode, ParamEvent[]>();
  for (const event of rec.params) {
    if (!event.build) continue;
    const list = built.get(event.node) ?? [];
    list.push(event);
    built.set(event.node, list);
  }

  const lines = [
    '# the bus graph, as built by start() — nodes, their configuration, their wiring',
    '',
  ];
  for (const node of rec.nodes) {
    const config: string[] = [];
    if (node.type !== undefined) config.push(`type=${node.type}`);
    const seen = new Set<string>();
    for (const event of built.get(node) ?? []) {
      if (seen.has(event.param)) continue;
      seen.add(event.param);
      config.push(`${event.param}=${num(node.params.get(event.param)!.value)}`);
    }
    lines.push(`${(node.name ?? '?').padEnd(18)} ${node.kind.padEnd(24)} ${config.join(' ')}`.trimEnd());
    for (const out of node.outputs) {
      const target =
        out instanceof StubNode ? (out.name ?? '?') : `${out.name} (param of ${nameOfParam(rec, out)})`;
      lines.push(`${''.padEnd(18)}   → ${target}`);
    }
    if (node.startedAt !== null) lines.push(`${''.padEnd(18)}   started`);
  }
  return `${lines.join('\n')}\n`;
}

function nameOfParam(rec: Recorder, param: { name: string }): string {
  for (const node of rec.nodes) {
    for (const [, candidate] of node.params) {
      if (candidate === param) return node.name ?? '?';
    }
  }
  return '?';
}

/**
 * Automation, grouped by parameter, with consecutive identical writes collapsed.
 *
 * `update()` runs once a frame and rewrites six parameters every time, almost
 * always with the number they already hold — 27,700 of the first draft's 28,824
 * lines were that, which is a golden nobody would read and a diff nobody could
 * review. Collapsing a run of identical writes to one line plus a count loses
 * nothing: the values are what matter, and the moment one of them *changes* is
 * still its own line.
 *
 * Grouped per parameter rather than strictly time-ordered, because that is the
 * shape a reader wants here — one parameter's whole story at once. The global
 * timeline is what the voice golden already is.
 */
function formatAutomation(rec: Recorder): string {
  const streams = new Map<string, ParamEvent[]>();
  for (const event of rec.params) {
    if (event.build) continue;
    const key = `${event.node.name}.${event.param}`;
    const list = streams.get(key) ?? [];
    list.push(event);
    streams.set(key, list);
  }

  const lines = [
    '# scheduled automation, per parameter — the phrase filter, the sidechain, the crossfades',
    '# consecutive identical writes are collapsed to one line with a count',
    '',
  ];
  for (const [key, unsorted] of [...streams].sort(([a], [b]) => a.localeCompare(b))) {
    // By the time they land, not by the frame that wrote them.
    //
    // `update()` writes at `ctx.currentTime` while the sequencer writes a
    // lookahead window ahead of it, so frame order and timeline order genuinely
    // differ — which showed up as a run of writes stamped `pre` sitting after
    // events from bar 3. Sorting by time makes each parameter's story monotonic;
    // the seq tiebreak keeps a cancel/set/ramp triple written at one instant in
    // the order it was written.
    const events = [...unsorted].sort((a, b) => a.time - b.time || a.seq - b.seq);
    lines.push(key);
    let run: ParamEvent[] = [];
    const flush = (): void => {
      if (run.length === 0) return;
      const first = run[0]!;
      const tc = first.tc === undefined ? '' : `  tc ${num(first.tc)}`;
      const v = first.value === null ? '' : ` ${num(first.value)}`;
      const repeat =
        run.length === 1
          ? ''
          : `   ×${run.length} (through ${place(rec.steps, run[run.length - 1]!.time).trim()})`;
      lines.push(`  ${place(rec.steps, first.time)}  ${first.op}${v}${tc}${repeat}`);
      run = [];
    };
    for (const event of events) {
      const prev = run[run.length - 1];
      const same =
        prev !== undefined &&
        prev.op === event.op &&
        prev.value === event.value &&
        prev.tc === event.tc;
      if (!same) flush();
      run.push(event);
    }
    flush();
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

// -------------------------------------------------------------------- tests

describe('the schedule (goldens — a diff is a sound change)', () => {
  const recordings = new Map<string, Recording>();
  for (const script of SCRIPTS) recordings.set(script.name, drive(script));

  /**
   * SAVED SCORES — frozen, note for note.
   *
   * `current` was golden-locked from the start because it is a transcription and
   * had to be provable. Everything else was left unfrozen on the grounds that it
   * was a proposal, and that stopped being the right call the moment one of them
   * was worth keeping: `vault` shares its sequencer, its voices and its whole
   * inheritance chain with Scores that are still being edited, so an adjustment
   * to `deep` — which it spreads from — moves it with nothing to say so.
   *
   * **It takes both goldens to hold a Score, and they cover different halves.**
   * This one records what the sequencer *asks for* — every note, its time, its
   * pitch, its gain, its bus — so it catches anything that changes the
   * arrangement. It does not and cannot catch a retune *inside* a voice, because
   * voice internals never reach a call site; `voices.test.ts` is what freezes
   * those. Verified in both directions: dropping `boomBass`'s growl from 0.42 to
   * 0.40 fails the voice golden and passes this one, and dropping `vault`'s bass
   * gain from 1.05 to 1.02 fails this one.
   *
   * The whole form is covered, so the intro, both verses, the build, the drop and
   * *both* choruses are in the record — a hook that quietly stopped repeating
   * would otherwise be invisible.
   */
  const SAVED: readonly (readonly [string, Score])[] = [['vault', vault]];

  for (const [name, score] of SAVED) {
    it(`${name} is saved, note for note`, async () => {
      const base = SCRIPTS.find((s) => s.name === 'run')!;
      const rec = drive({ ...base, name, bars: 192 }, score).rec;
      await expect(formatVoices(rec)).toMatchFileSnapshot(`goldens/saved.${name}.voices.txt`);
    });

    /**
     * The document is the Score, and this is what makes that claim true rather
     * than hopeful.
     *
     * Serialising to JSON and back is only worth anything if the Score that comes
     * out plays *the same song* — a format that loses a filter corner or a
     * section boundary is a format that quietly changes the music every time
     * somebody saves. So the round-tripped Score is driven through the same 192
     * bars and held to the same golden as the original: not "equivalent", not
     * "close enough", the same notes.
     */
    it(`${name} survives a round trip through JSON`, () => {
      const authored = SCORES[name]!;
      const document = toScoreData(score, SCORES['deep']!, SCORES, 'deep');
      const text = stringifyScoreData(document);

      const parsed = parseScoreData(text);
      expect('data' in parsed, 'error' in parsed ? parsed.error : '').toBe(true);
      if (!('data' in parsed)) return;

      const reloaded = fromScoreData(parsed.data, (id) => SCORES[id]);
      expect(reloaded.id).toBe(authored.id);

      // Compared against the original directly rather than against the golden
      // file: two tests cannot share one `toMatchFileSnapshot` path, and note-for-
      // note equality with the Score it came from is the stronger claim anyway.
      const base = SCRIPTS.find((s) => s.name === 'run')!;
      const before = formatVoices(drive({ ...base, name, bars: 192 }, score).rec);
      const after = formatVoices(drive({ ...base, name, bars: 192 }, reloaded).rec);
      expect(after).toBe(before);
    });
  }

  // The graph is built once by `start()` and does not depend on the script, so
  // one golden covers it. Asserted from the first recording only; the others
  // would be byte-identical and three copies of one fact is three places to
  // update.
  it('builds the same bus graph', async () => {
    await expect(recordings.get('menu')!.graph).toMatchFileSnapshot('goldens/graph.txt');
  });

  for (const script of SCRIPTS) {
    describe(script.name, () => {
      it('plays the same notes', async () => {
        await expect(formatVoices(recordings.get(script.name)!.rec)).toMatchFileSnapshot(
          `goldens/${script.name}.voices.txt`,
        );
      });

      it('automates the same parameters', async () => {
        await expect(formatAutomation(recordings.get(script.name)!.rec)).toMatchFileSnapshot(
          `goldens/${script.name}.automation.txt`,
        );
      });
    });
  }

  /**
   * §18.4 — the one rule no Score may ever be allowed to break.
   *
   * `audio.ts` carries 24 lines on why the saturation stage was removed: a
   * soft-clip curve has a small-signal slope of `1 + k`, so it raises RMS — it
   * turns the game up, by a lot, at the most stressful moment in a run. The
   * comment is the only thing that has been guarding it. This is the guard.
   *
   * Scoped to the graph, deliberately. `dialup()` uses a shaper inside a
   * one-shot easter egg, which is fixed-gain and cannot accumulate; what must
   * never exist is a shaper in the path everything flows through.
   */
  it('has no saturation stage in the bus graph', () => {
    const shapers = recordings
      .get('menu')!
      .rec.nodes.filter((n) => n.kind === 'WaveShaperNode');
    expect(shapers, 'a WaveShaperNode was added to the music path — see audio.ts §18.4').toEqual(
      [],
    );
  });

  /**
   * The point of the whole exercise, asserted.
   *
   * Everything above proves the refactor changed *nothing*, which is necessary and
   * says nothing about whether it achieved anything. This is the other half: a
   * Score with three numbers moved produces an audibly different schedule, through
   * the seam, with no code edited.
   *
   * It also pins the two bugs that made the seam not work at first, both of which
   * present as "my new Score sounds exactly like the old one": the Score has to be
   * in the arrangement signature or `setEngine` dedupes the switch away, and it
   * must *not* be in the selection seed or it reshuffles which cells a build gets.
   */
  /**
   * The class of bug no golden can catch.
   *
   * A real `AudioParam` throws on NaN, and the sequencer runs from a
   * `setInterval`, so the throw is uncaught and takes the whole sixteenth with
   * it — the console reports it against the timer in `clock.ts`, which is the
   * one file that cannot be at fault. The stub stores NaN happily, so a
   * schedule the browser refuses to play still writes a perfectly clean golden.
   *
   * Every Score in the playlist, through every script.
   */
  /**
   * The check the game does at boot, done here instead.
   *
   * `validateScores()` throws on a malformed library and `main.ts` calls it
   * before anything else, so a bad cell is not a subtly wrong song — it is a
   * blank page. Nothing in this file called it, so every test could pass on a
   * playlist that could not start.
   */
  it('every registered Score has a valid cell library', () => {
    expect(() => validateScores()).not.toThrow();
  });

  it('never sends a non-finite value to an AudioParam', () => {
    // Every registered Score, not just the listed ones: the boot default and
    // the saved presets go through the same sequencer.
    const listed = Object.values(SCORES);
    expect(listed.length).toBeGreaterThan(0);
    const faults: string[] = [];
    for (const score of listed) {
      for (const script of SCRIPTS) {
        const { rec } = drive(script, score);
        for (const f of rec.nonFinite.slice(0, 3)) faults.push(`${score.id}/${script.name}: ${f}`);
      }
    }
    expect(faults).toEqual([]);
  });

  it('a different Score plays a different schedule', () => {
    const darker: Score = {
      ...current,
      id: 'test-darker',
      name: 'Darker (test)',
      mix: {
        ...current.mix,
        // Close the phrase filter and drop the lead an octave — two of the three
        // levers that actually make this genre sound nocturnal.
        filter: { ...current.mix.filter, span: 2600 },
        register: { ...current.mix.register, motif: 12, motifAnswer: 24 },
      },
    };

    const script = SCRIPTS.find((s) => s.name === 'run')!;
    const base = drive(script);
    const dark = drive(script, darker);

    // Same build, same script, same cells — so the same notes at the same times.
    const notes = (r: Recording) => r.rec.voices.map((e) => `${e.name}@${e.at.toFixed(4)}`);
    expect(notes(dark)).toEqual(notes(base));

    // The phrase filter sits lower everywhere it is written.
    const corners = (r: Recording) =>
      r.rec.params
        .filter((e) => !e.build && e.node.name === 'musicFilter' && e.value !== null)
        .map((e) => e.value!);
    const baseCorners = corners(base);
    const darkCorners = corners(dark);
    expect(darkCorners.length).toBe(baseCorners.length);
    expect(darkCorners.every((hz, i) => hz < baseCorners[i]!)).toBe(true);

    // And the lead is an octave down, which is a halving of every motif pitch.
    const leadHz = (r: Recording) =>
      r.rec.voices.filter((e) => e.name === 'motif').map((e) => e.args[2] as number);
    const baseLead = leadHz(base);
    const darkLead = leadHz(dark);
    expect(darkLead.length).toBeGreaterThan(0);
    expect(darkLead.every((hz, i) => Math.abs(hz * 2 - baseLead[i]!) < 1e-6)).toBe(true);

    // The signature carries the Score, so `setEngine` cannot dedupe a switch away.
    expect(base.rec.voices.length).toBeGreaterThan(0);
    expect(arrangeFor(darker)).not.toBe(arrangeFor(current));
  });

  /**
   * `deep` is not frozen — it is a proposal and no golden holds it. What is
   * asserted is that it is *wired*, because the failure mode is silent: the
   * reverb bus existed for a while with nothing feeding it, so raising
   * `graph.reverb.send` did nothing at all and the Score would have read as "the
   * same thing, slightly quieter" with no error anywhere.
   */
  it('deep is actually connected to the room', () => {
    const script = SCRIPTS.find((s) => s.name === 'run')!;
    const dark = drive(script, deep);

    const intoReverb = dark.rec.voices.filter((e) => e.bus === 'reverbSend');
    expect(intoReverb.length).toBeGreaterThan(0);
    // Only the melodic voices. A tail under the kick or the sub is mud.
    expect([...new Set(intoReverb.map((e) => e.name))].sort()).toEqual([
      'gatedChord',
      'motif',
      'stab',
    ]);

    // And the delay is fed on every build, not only when Echo was drafted.
    expect(dark.rec.voices.some((e) => e.bus === 'echoSend')).toBe(true);
  });

  /**
   * The chorus is the same chorus.
   *
   * Everything else in the arranger is built to *move* — `pick()` takes an
   * `avoid` argument precisely so a variation pass cannot reselect what is
   * already playing. That is why nothing was ever memorable, and a hook that
   * quietly drifted back into varying would be the whole feature failing
   * silently: it would still sound fine, and it would still not be a song.
   */
  it('deep plays the same hook every chorus', () => {
    // A full form and a bit, defined here rather than added to SCRIPTS: it is
    // 192 bars, and a golden that long would be noise nobody reads. The goldens
    // exist to catch drift in `current`; this test asks a structural question.
    const base = SCRIPTS.find((s) => s.name === 'run')!;
    const rec = drive({ ...base, name: 'long', bars: 200 }, deep).rec;

    // Which bar a scheduled time falls in, from the grid the clock emitted.
    const marks = rec.steps;
    const barOf = (at: number): number => {
      let lo = 0;
      let hi = marks.length - 1;
      let best = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (marks[mid]!.time <= at + 1e-9) {
          best = mid;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      return best < 0 ? -1 : Math.floor(marks[best]!.count / 16);
    };

    const form = deep.mix.form;
    const total = form.reduce((n, s) => n + s.bars, 0);
    const spanOf = (id: string): [number, number] => {
      let acc = 0;
      for (const s of form) {
        if (s.id === id) return [acc, acc + s.bars];
        acc += s.bars;
      }
      throw new Error(`no section ${id}`);
    };

    const pitchesIn = (id: string): string => {
      const [from, to] = spanOf(id);
      const hz = rec.voices
        .filter((e) => e.name === 'motif')
        .filter((e) => {
          const bar = barOf(e.at);
          return bar % total >= from && bar % total < to;
        })
        .map((e) => (e.args[2] as number).toFixed(2));
      return [...new Set(hz)].sort().join(' ');
    };

    const first = pitchesIn('chorus');
    const second = pitchesIn('chorus-2');
    expect(first.length).toBeGreaterThan(0);
    expect(second).toBe(first);

    // And the verses are *not* the hook, or the feature is a no-op.
    expect(pitchesIn('verse')).not.toBe(first);

    // The sections that declared themselves empty are empty.
    const namesIn = (id: string): string[] => {
      const [from, to] = spanOf(id);
      return [
        ...new Set(
          rec.voices
            .filter((e) => {
              const bar = barOf(e.at);
              return bar % total >= from && bar % total < to;
            })
            .map((e) => e.name),
        ),
      ].sort();
    };
    expect(namesIn('break')).toEqual(['gatedChord', 'kick', 'sub']);
    // A drop is rhythm and weight; a melody over it is a distraction.
    expect(namesIn('drop')).not.toContain('motif');
  });

  it('routes everything through the limiter', () => {
    const nodes = recordings.get('menu')!.rec.nodes;
    const limiter = nodes.find((n) => n.name === 'limiter');
    expect(limiter?.kind).toBe('DynamicsCompressorNode');
    // Chrome is the documented exception and the only one: it sits after the
    // limiter so a click cannot be ducked by a busy passage.
    const afterLimiter = nodes.filter((n) => n.outputs.some((o) => o === nodes.find((m) => m.name === 'master')));
    expect(afterLimiter.map((n) => n.name).sort()).toEqual(['limiterTrim', 'uiLevel']);
  });
});
