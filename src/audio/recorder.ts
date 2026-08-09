/**
 * The schedule recorder. Test-only — nothing in the game imports this.
 *
 * `audio.test.ts` covers the two *pure* layers thoroughly: `arrange()` chooses
 * cells from a build, `derivePart()` turns a Program into a pattern, and both are
 * functions over ids. What it has never covered is everything downstream of
 * them — the sequencer that decides which sixteenth a hat lands on and how loud,
 * the bus graph, and 1962 lines of voices. Those had no test that had ever
 * listened to them.
 *
 * That was survivable while every number lived exactly where it was used. It
 * stops being survivable the moment those numbers are hoisted into a Score,
 * because the whole promise of that refactor is "the default sound is unchanged"
 * — and a promise about a thing nobody measures is not a promise.
 *
 * **So this records the schedule rather than rendering it.** Real audio was the
 * obvious first instinct and it is the wrong tool here:
 *
 *   - It needs either a native dependency in a repo with one runtime dep, or a
 *     browser, which means it cannot run in `pnpm check`.
 *   - Its diffs are unreadable. "band 4 RMS moved 0.3%" does not tell you which
 *     number you typed wrong.
 *   - It is not deterministic. Float noise and `DynamicsCompressorNode` differing
 *     between engines both have to be absorbed by a tolerance, and a tolerance
 *     wide enough to be stable is wide enough to hide a real change.
 *
 * A schedule snapshot has none of those problems and catches strictly more of
 * what this refactor can break: a mistyped constant shows up *as itself*, at the
 * bar and step it happened, in a text file git can diff.
 *
 * What it deliberately does not do is tell you whether anything sounds good.
 * Nothing can — that is the user's ears, and the same rule the visuals are held
 * to. This exists to prove nothing changed, not to judge what changed.
 *
 * ---
 *
 * **Two tiers, and the split matters.**
 *
 * *Voice calls* are the readable tier. Every number the sequencer decides —
 * gains, registers, filter brightness, which layers are in — reaches a voice as
 * an *argument*, so logging `(name, at, args)` captures the entire `mix` and
 * `feel` surface in a form that reads like music.
 *
 * *Named-graph automation* is the second tier, and it is confined to nodes built
 * by `start()`. Voices build and throw away thousands of nodes a minute; logging
 * those would bury the signal and churn on every unrelated edit. What `start()`
 * builds is the room, it is named, it is stable, and the automation written onto
 * it by hand (the phrase filter, the sidechain, the echo send, the siege
 * crossfade) is exactly the part no voice argument would ever reveal.
 */
import type { Hue } from '../sim/types';
import type { AudioCue } from '../sim/world';

// ----------------------------------------------------------------- the stubs

type Phase = 'graph' | 'run';

type Op =
  | 'set'
  | 'setValueAtTime'
  | 'linearRampToValueAtTime'
  | 'exponentialRampToValueAtTime'
  | 'setTargetAtTime'
  | 'cancelScheduledValues';

export interface ParamEvent {
  seq: number;
  node: StubNode;
  param: string;
  op: Op;
  /** Null for `cancelScheduledValues`, which carries no value. */
  value: number | null;
  time: number;
  /** `setTargetAtTime`'s time constant. */
  tc?: number;
  /**
   * True for writes made while the graph was being built.
   *
   * Those belong in the graph snapshot as initial configuration; everything after
   * is automation, and mixing the two would put `start()`'s wiring in the middle
   * of a 36-bar timeline where nobody would find it.
   */
  build: boolean;
}

export interface VoiceEvent {
  seq: number;
  name: string;
  at: number;
  /**
   * Which bus the voice was played into.
   *
   * Load-bearing, not decoration: the sequencer plays the same note twice on
   * purpose — once to `musicBus` and once to `echoSend` — and without the
   * destination those two are indistinguishable lines in the log. Bus choice is
   * also a mix decision in its own right (the kick goes to `punchBus`, which is
   * never ducked), so it belongs in the record.
   */
  bus: string | null;
  args: readonly unknown[];
}

/** A sixteenth the clock actually emitted, so events can be placed on the grid. */
export interface StepMark {
  time: number;
  index: number;
  count: number;
}

class StubParam {
  private current: number;

  constructor(
    private readonly node: StubNode,
    readonly name: string,
    initial: number,
  ) {
    this.current = initial;
  }

  get value(): number {
    return this.current;
  }

  /**
   * Recorded, not just stored. Half the graph is configured by assignment
   * (`filter.frequency.value = 110`) and half by automation, and a snapshot that
   * only saw one of them would miss whichever half a refactor happened to touch.
   */
  set value(v: number) {
    this.current = v;
    this.write('set', v, this.node.ctx.currentTime);
  }

  setValueAtTime(v: number, t: number): StubParam {
    this.current = v;
    return this.write('setValueAtTime', v, t);
  }

  linearRampToValueAtTime(v: number, t: number): StubParam {
    this.current = v;
    return this.write('linearRampToValueAtTime', v, t);
  }

  exponentialRampToValueAtTime(v: number, t: number): StubParam {
    this.current = v;
    return this.write('exponentialRampToValueAtTime', v, t);
  }

  setTargetAtTime(v: number, t: number, tc: number): StubParam {
    this.current = v;
    return this.write('setTargetAtTime', v, t, tc);
  }

  cancelScheduledValues(t: number): StubParam {
    return this.write('cancelScheduledValues', null, t);
  }

  private write(op: Op, value: number | null, time: number, tc?: number): StubParam {
    // Only the named graph is logged. See the header: voice-internal nodes are
    // covered by their call arguments, and logging them here would bury the
    // signal under thousands of per-note envelopes.
    if (this.node.phase === 'graph') {
      this.node.rec.params.push({
        seq: this.node.rec.next(),
        node: this.node,
        param: this.name,
        op,
        value,
        time,
        ...(tc === undefined ? {} : { tc }),
        build: this.node.rec.phase === 'graph',
      });
    }
    return this;
  }
}

export class StubNode {
  name: string | null = null;
  /** Oscillator/filter waveform or response type. */
  type?: string;
  buffer?: unknown;
  curve?: unknown;
  startedAt: number | null = null;
  readonly outputs: (StubNode | StubParam)[] = [];

  constructor(
    readonly rec: Recorder,
    readonly ctx: StubContext,
    readonly kind: string,
    readonly phase: Phase,
    params: Record<string, number> = {},
  ) {
    for (const [key, initial] of Object.entries(params)) {
      const param = new StubParam(this, key, initial);
      Object.defineProperty(this, key, { value: param, enumerable: true });
      this.params.set(key, param);
    }
  }

  readonly params = new Map<string, StubParam>();

  /** Returns the destination so `a.connect(b).connect(c)` chains as it does live. */
  connect<T extends StubNode | StubParam>(to: T): T {
    this.outputs.push(to);
    return to;
  }

  disconnect(): void {
    this.outputs.length = 0;
  }

  start(at = 0): void {
    this.startedAt = at;
  }

  stop(_at = 0): void {
    /* Nodes are discarded per note; nothing to record. */
  }
}

class StubBuffer {
  private readonly data: Float32Array[];

  constructor(
    readonly numberOfChannels: number,
    readonly length: number,
    readonly sampleRate: number,
  ) {
    this.data = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
  }

  getChannelData(channel: number): Float32Array {
    return this.data[channel]!;
  }
}

export class StubContext {
  currentTime = 0;
  readonly sampleRate = 48000;
  state: AudioContextState = 'running';
  readonly destination: StubNode;

  constructor(readonly rec: Recorder) {
    this.destination = new StubNode(rec, this, 'AudioDestinationNode', 'graph');
    this.destination.name = 'destination';
    rec.nodes.push(this.destination);
  }

  advance(seconds: number): void {
    this.currentTime += seconds;
  }

  resume(): Promise<void> {
    this.state = 'running';
    return Promise.resolve();
  }

  private make(kind: string, params: Record<string, number> = {}): StubNode {
    const node = new StubNode(this.rec, this, kind, this.rec.phase, params);
    if (node.phase === 'graph') this.rec.nodes.push(node);
    return node;
  }

  createGain(): StubNode {
    return this.make('GainNode', { gain: 1 });
  }

  createBiquadFilter(): StubNode {
    const node = this.make('BiquadFilterNode', { frequency: 350, Q: 1, gain: 0, detune: 0 });
    node.type = 'lowpass';
    return node;
  }

  createOscillator(): StubNode {
    const node = this.make('OscillatorNode', { frequency: 440, detune: 0 });
    node.type = 'sine';
    return node;
  }

  createBufferSource(): StubNode {
    return this.make('AudioBufferSourceNode', { playbackRate: 1, detune: 0 });
  }

  createDelay(_max = 1): StubNode {
    return this.make('DelayNode', { delayTime: 0 });
  }

  createDynamicsCompressor(): StubNode {
    return this.make('DynamicsCompressorNode', {
      threshold: -24,
      knee: 30,
      ratio: 12,
      attack: 0.003,
      release: 0.25,
    });
  }

  createWaveShaper(): StubNode {
    return this.make('WaveShaperNode');
  }

  createConvolver(): StubNode {
    return this.make('ConvolverNode');
  }

  createBuffer(channels: number, length: number, rate: number): StubBuffer {
    return new StubBuffer(channels, length, rate);
  }
}

// -------------------------------------------------------------- the recorder

export class Recorder {
  readonly voices: VoiceEvent[] = [];
  readonly params: ParamEvent[] = [];
  readonly nodes: StubNode[] = [];
  readonly steps: StepMark[] = [];
  /**
   * Nodes built while this is `'graph'` are the room and are recorded; nodes
   * built while it is `'run'` are per-note and are not. Flipped by the driver the
   * moment `start()` returns.
   */
  phase: Phase = 'graph';
  private seq = 0;

  next(): number {
    return this.seq++;
  }

  voice(name: string, at: number, args: readonly unknown[]): void {
    const out = (args[0] as { out?: unknown } | undefined)?.out;
    const bus = out instanceof StubNode ? (out.name ?? '?') : null;
    this.voices.push({ seq: this.next(), name, at, bus, args });
  }

  /**
   * Name the graph from the field names that hold it.
   *
   * Reflection rather than a hand-written list, because a hand-written list is a
   * second place to remember: add a bus, forget the list, and the golden quietly
   * stops covering it. Every node `Audio` keeps is an own enumerable property at
   * runtime — `private` is a compile-time fiction — so the field name *is* the
   * name, and it stays correct without anyone maintaining it.
   *
   * Locals inside `start()` (the delay damper, the ring modulator) are not held
   * anywhere, so they get `kind#n` by creation order within their type. Stable
   * unless a node of the same type is inserted ahead of them, which is a graph
   * change and expected to move the golden.
   */
  nameGraph(owner: object): void {
    for (const [key, value] of Object.entries(owner)) {
      if (value instanceof StubNode) value.name = key;
    }
    const counts = new Map<string, number>();
    for (const node of this.nodes) {
      const n = (counts.get(node.kind) ?? 0) + 1;
      counts.set(node.kind, n);
      if (node.name === null) node.name = `${node.kind}#${n}`;
    }
  }
}

/**
 * Which recorder the voice wrapper reports to.
 *
 * A module-level holder rather than a parameter, because the wrapper is installed
 * by `vi.mock` — which is hoisted above every import and cannot close over
 * anything a test creates later. One script runs at a time, so one slot is
 * enough, and a null slot means "not recording", which is what every other
 * consumer of `voices.ts` sees.
 */
let active: Recorder | null = null;

export function setActiveRecorder(recorder: Recorder | null): void {
  active = recorder;
}

export function activeRecorder(): Recorder | null {
  return active;
}

// ------------------------------------------------------------------ install

interface Installed {
  rec: Recorder;
  ctx: StubContext;
  /** Runs one Clock tick — the callback Clock handed to `setInterval`. */
  pump(): void;
  restore(): void;
}

/**
 * Put a fake browser in place of the real one.
 *
 * Three things get faked and each has to be, because `Audio` and `Clock` reach
 * for all three: `window.AudioContext`, `window.setInterval` (the clock's pump)
 * and `Math.random` (noise buffers). The interval is captured rather than run —
 * a test that waited on real timers would be slow *and* non-deterministic, and
 * the whole value here is that the same script produces the same text.
 */
export function installStubAudio(): Installed {
  const rec = new Recorder();
  let ctx: StubContext | null = null;
  let pump: (() => void) | null = null;

  class Ctor extends StubContext {
    constructor() {
      super(rec);
      ctx = this;
    }
  }

  const priorWindow = (globalThis as { window?: unknown }).window;
  const priorRandom = Math.random;

  // Seeded, so a noise buffer's contents cannot make a run differ from itself.
  // Nothing snapshots buffer *data*, but determinism you rely on and do not
  // enforce is determinism you lose later.
  let seed = 0x9e3779b9;
  Math.random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0x100000000;
  };

  (globalThis as { window?: unknown }).window = {
    AudioContext: Ctor,
    setInterval: (fn: () => void) => {
      pump = fn;
      return 1;
    },
    clearInterval: () => {
      pump = null;
    },
  };

  return {
    rec,
    get ctx(): StubContext {
      if (!ctx) throw new Error('AudioContext not created — call audio.start() first');
      return ctx;
    },
    pump: () => pump?.(),
    restore: () => {
      (globalThis as { window?: unknown }).window = priorWindow;
      Math.random = priorRandom;
    },
  } as Installed;
}

// ----------------------------------------------------------------- scripts

export interface ScriptFrame {
  intensity: number;
  dominant: Hue;
  heat: number;
  stalled: boolean;
  meltdown: number;
  siege: number;
}

export interface Script {
  name: string;
  bars: number;
  rows: { triggerId: string; primitive: string; hue: Hue; modifiers: string[] }[];
  axiomId: string;
  frame(bar: number): ScriptFrame;
  /** Cues for this frame. Deterministic — indexed by frame, never random. */
  cues?(frame: number): AudioCue[];
}

const cue = (kind: AudioCue['kind'], hue: Hue, depth: number, weight: number): AudioCue => ({
  kind,
  hue,
  depth,
  weight,
});

/**
 * Three scripts, chosen to cover every branch the sequencer has.
 *
 * **menu** — no Engine at all. The bed alone, near-zero intensity, which is the
 * one arrangement every player hears first and the only one where `size === 0`
 * paths (the rim, the empty mix) run.
 *
 * **run** — three rows including a cascade trigger, intensity ramping. Long
 * enough to cross a phrase boundary at bar 16 *and* the variation timer at bar
 * 32, so the two things that reselect material both fire.
 *
 * **meltdown** — five rows and the phase turned, which is the branch that takes
 * layers away rather than adding them: no hats but the one in eight, no stab, no
 * lead, and the chord held instead of chopped.
 */
export const SCRIPTS: Script[] = [
  {
    name: 'menu',
    bars: 8,
    axiomId: 'ignition',
    rows: [],
    frame: () => ({
      intensity: 0,
      dominant: 'thermal',
      heat: 0,
      stalled: false,
      meltdown: 0,
      siege: 0,
    }),
  },
  {
    name: 'run',
    bars: 36,
    axiomId: 'circuit',
    rows: [
      { triggerId: 'clock', primitive: 'projectile', hue: 'thermal', modifiers: ['split'] },
      { triggerId: 'on_hit', primitive: 'chain', hue: 'voltaic', modifiers: ['echo', 'amplify'] },
      { triggerId: 'on_kill', primitive: 'burst', hue: 'void', modifiers: [] },
    ],
    frame: (bar) => ({
      // A ramp rather than a constant: every layer has an intensity threshold,
      // and a fixed level would only ever test the ones below it.
      intensity: Math.min(0.85, bar / 24),
      dominant: bar < 18 ? 'thermal' : 'voltaic',
      heat: Math.min(1, bar / 30),
      stalled: false,
      meltdown: 0,
      siege: 0,
    }),
    cues: (frame) => {
      const out: AudioCue[] = [];
      // A trickle of accents, so `flush()`'s density gate and its one-note-per-
      // key dedupe both run. Two on the same frame with the same key is the case
      // that dedupe exists for.
      if (frame % 7 === 0) out.push(cue('kill', 'thermal', frame % 5, 0.8));
      if (frame % 7 === 0) out.push(cue('kill', 'thermal', frame % 5, 0.6));
      if (frame % 11 === 0) out.push(cue('fire', 'voltaic', 0, 0.45));
      if (frame % 23 === 0) out.push(cue('pickup', 'void', 2, 0.7));
      // One occasion, which must never be dropped for an accent.
      if (frame === 400) out.push(cue('level', 'thermal', 0, 1));
      return out;
    },
  },
  {
    name: 'meltdown',
    bars: 8,
    axiomId: 'feedback',
    rows: [
      { triggerId: 'clock', primitive: 'beam', hue: 'void', modifiers: ['sustain'] },
      { triggerId: 'on_hit', primitive: 'projectile', hue: 'thermal', modifiers: ['overdrive'] },
      { triggerId: 'on_crit', primitive: 'orbital', hue: 'voltaic', modifiers: ['echo'] },
      { triggerId: 'on_kill', primitive: 'zone', hue: 'void', modifiers: ['ground'] },
      { triggerId: 'on_wave', primitive: 'buff', hue: 'thermal', modifiers: ['quantize'] },
    ],
    frame: () => ({
      intensity: 0.85,
      dominant: 'void',
      heat: 1,
      stalled: false,
      meltdown: 1,
      siege: 0,
    }),
  },
];
