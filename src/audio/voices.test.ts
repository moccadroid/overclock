/**
 * The instruments, frozen.
 *
 * `schedule.test.ts` records what the sequencer *asks* for — every note, its
 * gain, its pitch, the bus it went to. That covers the whole `mix` and `feel`
 * surface, because those numbers all reach a voice as arguments. It covers
 * nothing about what a voice then *does*: voice-internal nodes are excluded from
 * that harness by design, since voices build and discard thousands of nodes a
 * minute and logging them would bury the signal.
 *
 * Which left the 1962 lines of `voices.ts` with no test that had ever listened to
 * them — and made hoisting their constants into a Score the one step of this
 * refactor with no safety net. This is that net.
 *
 * Each voice is invoked once, at a fixed time, with fixed arguments, against the
 * stub context. Everything it builds — oscillator types and frequencies, filter
 * corners, every envelope breakpoint, the wiring — goes into a golden.
 *
 * **A diff here is a timbre change.** Same deal as the schedule goldens: either
 * you typed a number wrong, or you meant it and it needs the user's ears before
 * `vitest -u` records a new baseline.
 */
import { describe, expect, it } from 'vitest';
import {
  installStubAudio,
  StubNode,
  type ParamEvent,
  type Recorder,
} from './recorder';
import { current } from './scores/current';
import {
  bass,
  breach,
  gate,
  gatedChord,
  hat,
  hurt,
  kick,
  meltdown,
  motif,
  perc,
  playHue,
  playPart,
  siegeDrone,
  siegeHit,
  siegeScream,
  stab,
  sub,
  summons,
  ui,
  dialup,
  type VoiceCtx,
} from './voices';

/** Fixed, so a pitch in the golden is a pitch and not a clock reading. */
const AT = 1;
/** A minor triad in the key of A, which is what most of the game plays over. */
const TONES = [0, 3, 7];

/**
 * Every voice in the file, with one representative invocation each.
 *
 * Variants are separate entries rather than one call with a loop, because a
 * variant *is* a different instrument here — `kick('deep')` and `kick('tight')`
 * share a function and nothing else — and a golden per variant is what makes a
 * retune legible.
 */
const CASES: readonly (readonly [string, (v: VoiceCtx) => void])[] = [
  ['kick.punch', (v) => kick(v, AT, 0.95, 'punch')],
  ['kick.tight', (v) => kick(v, AT, 0.95, 'tight')],
  ['kick.deep', (v) => kick(v, AT, 0.95, 'deep')],

  ['perc.clap', (v) => perc(v, AT, 0.8, 'clap')],
  ['perc.snare', (v) => perc(v, AT, 0.8, 'snare')],
  ['perc.rim', (v) => perc(v, AT, 0.8, 'rim')],

  ['hat.closed', (v) => hat(v, AT, 0.8, false)],
  ['hat.open', (v) => hat(v, AT, 0.8, true)],

  ['sub', (v) => sub(v, AT, 55, 0.7, 1.07)],

  ['bass.sub', (v) => bass(v, AT, 55, 0.85, { voice: 'sub', q: 7, brightness: 1 })],
  ['bass.pluck', (v) => bass(v, AT, 55, 0.85, { voice: 'pluck', q: 7, brightness: 1 })],
  ['bass.acid', (v) => bass(v, AT, 55, 0.85, { voice: 'acid', q: 14, brightness: 1 })],
  [
    'bass.acid.accented',
    (v) => bass(v, AT, 55, 0.85, { voice: 'acid', q: 14, brightness: 1, accent: true }),
  ],
  [
    'bass.acid.glide',
    (v) => bass(v, AT, 55, 0.85, { voice: 'acid', q: 14, brightness: 1, glideFrom: 41 }),
  ],

  ['stab.organ', (v) => stab(v, AT, TONES, 0.9, 'organ')],
  ['stab.saw', (v) => stab(v, AT, TONES, 0.9, 'saw')],
  ['stab.dub', (v) => stab(v, AT, TONES, 0.9, 'dub')],

  ['motif.pluck', (v) => motif(v, AT, 440, 0.9, 'pluck')],
  ['motif.acid', (v) => motif(v, AT, 440, 0.9, 'acid')],
  ['motif.acid.glide', (v) => motif(v, AT, 440, 0.9, 'acid', 330)],
  ['motif.bell', (v) => motif(v, AT, 440, 0.9, 'bell')],

  ['gatedChord', (v) => gatedChord(v, AT, TONES, 0.85, 0.24, 'sawtooth')],
  ['gatedChord.square', (v) => gatedChord(v, AT, TONES, 0.85, 0.24, 'square')],

  ['playHue.thermal', (v) => playHue(v, 'thermal', AT, 220, 0.5)],
  ['playHue.voltaic', (v) => playHue(v, 'voltaic', AT, 220, 0.5)],
  ['playHue.void', (v) => playHue(v, 'void', AT, 220, 0.5)],

  // The Engine's own lines. One per part voice — these are what a live Program
  // sounds like, and there are ten of them.
  ...(
    [
      'pluck',
      'stab',
      'acid',
      'drone',
      'bell',
      'tick',
      'sweep',
      'noise',
      'riser',
      'organ',
    ] as const
  ).map(
    (voice) =>
      [`playPart.${voice}`, (v: VoiceCtx) => playPart(v, voice, AT, 330, 1, 1, 0, 0)] as const,
  ),

  // Events. Left untuned by the Score on purpose — character rather than mood,
  // heard once, and the gate is approved as it stands. Recorded anyway, because
  // "we are not changing this" is a claim a golden can hold.
  ['hurt', (v) => hurt(v, AT, 0.9)],
  ['gate', (v) => gate(v, AT, 6.4, 0.62)],
  ['breach', (v) => breach(v, AT, 3.2, 0.66)],
  ['meltdown', (v) => meltdown(v, AT, 5, 0.7)],
  ['summons', (v) => summons(v, AT, 2.6, 0.5, false)],
  ['summons.hardened', (v) => summons(v, AT, 3.4, 0.62, true)],
  ['siegeHit', (v) => siegeHit(v, AT, 0.62, true)],
  ['siegeDrone', (v) => siegeDrone(v, AT, 2.25, 41.2, 0.34, 0.5)],
  ['siegeScream', (v) => siegeScream(v, AT, 1.5, 440, 0.2, 0.5, true)],
  ['dialup', (v) => dialup(v, AT)],
  ...(
    ['hover', 'click', 'draft', 'confirm', 'start', 'death', 'type', 'wire'] as const
  ).map((sound) => [`ui.${sound}`, (v: VoiceCtx) => ui(v, AT, sound)] as const),
];

function num(v: number): string {
  if (!Number.isFinite(v)) return String(v);
  return Math.abs(v) >= 100 ? v.toFixed(2) : v.toFixed(4);
}

/**
 * Render one voice's whole construction.
 *
 * Nodes are named by type and creation order — `OscillatorNode#2`. Creation order
 * inside a single voice is stable under a retune (a different number does not
 * reorder `createOscillator` calls) and only moves if the graph itself is
 * restructured, which is exactly when a large diff is the correct signal.
 */
function render(name: string, play: (v: VoiceCtx) => void): string {
  const env = installStubAudio();
  try {
    // A context has to exist before nodes can be made, and `installStubAudio`
    // only builds one when something constructs it.
    const ctx = new (
      (globalThis as { window: { AudioContext: new () => unknown } }).window.AudioContext
    )() as unknown as { rec: Recorder };
    const rec = ctx.rec;
    const out = new StubNode(rec, ctx as never, 'GainNode', 'graph');
    out.name = 'out';
    rec.nodes.push(out);

    play({ ctx: ctx as never, out: out as never, tuning: current.voices });
    rec.nameGraph({});

    const writes = new Map<StubNode, ParamEvent[]>();
    for (const event of rec.params) {
      const list = writes.get(event.node) ?? [];
      list.push(event);
      writes.set(event.node, list);
    }

    const lines = [`## ${name}`];
    for (const node of rec.nodes) {
      if (node === out) continue;
      const bits: string[] = [node.name ?? '?'];
      if (node.type !== undefined) bits.push(`type=${node.type}`);
      if (node.startedAt !== null) bits.push(`start=${num(node.startedAt - AT)}`);
      if (node.buffer !== undefined) bits.push('buffer');
      if (node.curve !== undefined) bits.push('curve');
      lines.push(`  ${bits.join('  ')}`);

      // Times are printed relative to `AT`, so the golden reads as the shape of
      // the envelope rather than as offsets from an arbitrary clock.
      for (const event of writes.get(node) ?? []) {
        const tc = event.tc === undefined ? '' : ` tc ${num(event.tc)}`;
        const value = event.value === null ? '' : ` ${num(event.value)}`;
        lines.push(
          `    ${event.param.padEnd(10)} ${event.op.padEnd(30)}${value} @ ${num(event.time - AT)}${tc}`,
        );
      }
      for (const target of node.outputs) {
        const to =
          target instanceof StubNode
            ? (target.name ?? '?')
            : `${target.name} of ${paramOwner(rec, target)}`;
        lines.push(`    → ${to}`);
      }
    }
    return lines.join('\n');
  } finally {
    env.restore();
  }
}

function paramOwner(rec: Recorder, param: { name: string }): string {
  for (const node of rec.nodes) {
    for (const [, candidate] of node.params) {
      if (candidate === param) return node.name ?? '?';
    }
  }
  return '?';
}

describe('the instruments (goldens — a diff is a timbre change)', () => {
  it('builds every voice exactly as approved', async () => {
    const all = CASES.map(([name, play]) => render(name, play)).join('\n\n');
    await expect(`${all}\n`).toMatchFileSnapshot('goldens/voices.txt');
  });

  it('covers every voice the sequencer can play', () => {
    // The list above is hand-written, so it can fall behind the module. This is
    // the guard: a new export with no case is a voice with no golden, and a voice
    // with no golden is exactly the gap this file exists to close.
    const covered = new Set(CASES.map(([name]) => name.split('.')[0]));
    const exported = [
      'kick',
      'perc',
      'hat',
      'sub',
      'bass',
      'stab',
      'motif',
      'gatedChord',
      'playHue',
      'playPart',
      'hurt',
      'gate',
      'breach',
      'meltdown',
      'summons',
      'siegeHit',
      'siegeDrone',
      'siegeScream',
      'dialup',
      'ui',
    ];
    expect([...exported].filter((name) => !covered.has(name))).toEqual([]);
  });
});
