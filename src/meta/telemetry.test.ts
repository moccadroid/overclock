/**
 * Invariants, deliberately — not a snapshot of a document.
 *
 * A golden file over the emitted document would break every time a node id
 * changed or a new event kind appeared, which is friction on the exact axis this
 * module promised not to add. So nothing here asserts a *value*. It asserts the
 * shape holds, the caps hold, and — the two that matter more than the rest —
 * that watching a run cannot change it.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { NO_INPUT, World } from '../sim/world';
import { SIM_DT } from '../sim/tunables';
import { hashWorld } from '../sim/hash';
import { RunTelemetry, TELEMETRY_VERSION, type TelemetryDoc } from './telemetry';
import { clearOutbox, forgetRun, pendingRuns, queueRun, sealAbandoned } from './outbox';
import { playerId, resetPlayerId } from './player';

function fresh(seed = 'telemetry-test'): World {
  return new World({ seed, axiomId: 'ignition' });
}

function tel(world: World): RunTelemetry {
  return new RunTelemetry(world.config.seed, world.config.axiomId, {
    build: 'test',
    startedAt: 1_770_000_000_000,
    pid: 'player-under-test',
    fx: ['lighting', 'bloom'],
    exp: {
      runs: 3,
      discoveries: 2,
      unlocked: 5,
      codex: 4,
      bestScore: 900,
      bestDepth: 6,
      bestTime: 210,
    },
  });
}

/** Walk every number in the document. A NaN here is a poisoned corpus row. */
function numbers(value: unknown, path = '$', out: [string, number][] = []): [string, number][] {
  if (typeof value === 'number') out.push([path, value]);
  else if (Array.isArray(value)) value.forEach((v, i) => numbers(v, `${path}[${i}]`, out));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) numbers(v, `${path}.${k}`, out);
  }
  return out;
}

function run(world: World, telemetry: RunTelemetry, seconds: number): void {
  const ticks = Math.round(seconds / SIM_DT);
  for (let i = 0; i < ticks && world.player.alive; i++) {
    world.advance(NO_INPUT, SIM_DT);
    telemetry.sample(world);
  }
}

describe('RunTelemetry', () => {
  it('cannot change the run it is watching', () => {
    // The whole contract in one assertion. record.ts documents the bug this
    // guards against: observing a draft offer by re-rolling it consumes a draw
    // from the run's Rng, and the observer silently becomes a participant.
    const world = fresh();
    const telemetry = tel(world);
    run(world, telemetry, 20);

    const before = hashWorld(world);
    const rngBefore = [...world.rng.save()];

    telemetry.emit(world, 'draft', { o: ['a', 'b', 'c'], k: 'a' });
    telemetry.sample(world);
    telemetry.snapshot(world);
    telemetry.snapshot(world, 'death');

    expect(hashWorld(world)).toBe(before);
    expect([...world.rng.save()]).toEqual(rngBefore);
  });

  it('produces a document that survives a JSON round trip with no NaN', () => {
    const world = fresh();
    const telemetry = tel(world);
    run(world, telemetry, 45);
    telemetry.emit(world, 'draft', { o: ['x'], k: 'x' });

    const doc = telemetry.snapshot(world, 'death');
    const round = JSON.parse(JSON.stringify(doc)) as TelemetryDoc;
    expect(round).toEqual(doc);

    for (const [path, n] of numbers(doc)) {
      expect(Number.isFinite(n), `${path} = ${n}`).toBe(true);
    }
  });

  it('samples the trajectory on its own cadence, not the caller\'s', () => {
    const world = fresh();
    const telemetry = tel(world);
    // Called every tick; must still land roughly every ten seconds of play.
    run(world, telemetry, 62);
    const doc = telemetry.snapshot(world);

    expect(doc.traj.length).toBeGreaterThan(3);
    expect(doc.traj.length).toBeLessThan(12);
    for (const row of doc.traj) expect(row).toHaveLength(9);

    const times = doc.traj.map((r) => r[0]!);
    for (let i = 1; i < times.length; i++) {
      expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(9);
    }
  });

  it('caps events and admits that it did', () => {
    const world = fresh();
    const telemetry = tel(world);
    run(world, telemetry, 5);

    expect(telemetry.snapshot(world).truncated).toBe(false);
    for (let i = 0; i < 2000; i++) telemetry.emit(world, 'edit', { c: 'move' });

    const doc = telemetry.snapshot(world);
    expect(doc.events.length).toBeLessThanOrEqual(512);
    // Without this flag a truncated run is indistinguishable from a quiet one,
    // and the corpus reports that nobody edits their Engine.
    expect(doc.truncated).toBe(true);
  });

  it('keeps every event addressable without knowing what it is', () => {
    const world = fresh();
    const telemetry = tel(world);
    run(world, telemetry, 12);
    telemetry.emit(world, 'draft', { o: ['a'], c: 'a' });
    telemetry.emit(world, 'some_future_mechanic', { whatever: 1 });

    for (const e of telemetry.snapshot(world).events) {
      expect(e.k).toMatch(/^[a-z_]+$/);
      expect(Number.isFinite(e.t)).toBe(true);
    }
  });

  it('never lets a payload field collide with the envelope', () => {
    // The bug this exists for shipped: the draft event carried the taken card as
    // `k`, the envelope's own `k` overwrote it with the word "draft", and every
    // choice in the corpus was destroyed by the line meant to label it. The old
    // test passed throughout, because `k` did look like an event kind.
    const world = fresh();
    const telemetry = tel(world);
    run(world, telemetry, 3);
    telemetry.emit(world, 'draft', { k: 'not-the-kind', t: -999, o: ['a', 'b'], c: 'a' });

    const e = telemetry.snapshot(world).events.at(-1)!;
    expect(e.k).toBe('draft');
    expect(e.t).toBeGreaterThanOrEqual(0);
    expect(e.p).toEqual({ k: 'not-the-kind', t: -999, o: ['a', 'b'], c: 'a' });
  });

  it('carries the chosen card, not just the offer', () => {
    const world = fresh();
    const telemetry = tel(world);
    run(world, telemetry, 3);
    telemetry.emit(world, 'draft', { o: ['alpha', 'beta', 'gamma'], c: 'beta' });

    const draft = telemetry.snapshot(world).events.find((e) => e.k === 'draft')!;
    // A refusal is only visible when both halves survive. Offer without choice
    // is a list of cards nobody can tell you anything about.
    expect(draft.p?.o).toEqual(['alpha', 'beta', 'gamma']);
    expect(draft.p?.c).toBe('beta');
  });

  it('stays far under the 1 MiB document limit for a long run', () => {
    const world = fresh();
    const telemetry = tel(world);
    run(world, telemetry, 600);
    for (let i = 0; i < 60; i++) {
      telemetry.emit(world, 'draft', { o: ['alpha', 'beta', 'gamma'], k: 'alpha' });
    }
    const size = JSON.stringify(telemetry.snapshot(world, 'death')).length;
    expect(size).toBeLessThan(60_000);
  });

  it('keeps the failure that ended it, above the death that followed', () => {
    const world = fresh();
    const telemetry = tel(world);
    run(world, telemetry, 8);
    telemetry.fail(world, new TypeError('cannot read properties of undefined'));

    const doc = telemetry.snapshot(world, 'error');
    expect(doc.end).toBe('error');
    expect(doc.cause).toContain('cannot read properties of undefined');
    const crash = doc.events.find((e) => e.k === 'error');
    expect(crash).toBeDefined();
    expect(crash!.p?.m).toContain('TypeError');
  });

  it('survives being handed something that is not an Error', () => {
    const world = fresh();
    const telemetry = tel(world);
    run(world, telemetry, 2);
    // `window.onerror` hands over a string; a rejected promise hands over
    // whatever it was rejected with, which is frequently neither.
    expect(() => telemetry.fail(world, 'script error')).not.toThrow();
    expect(() => telemetry.fail(world, undefined)).not.toThrow();
    expect(telemetry.snapshot(world, 'error').cause).toBeTruthy();
  });

  it('carries who played it and what they walked in with', () => {
    const world = fresh();
    const telemetry = tel(world);
    run(world, telemetry, 6);

    const doc = telemetry.snapshot(world, 'death');
    expect(doc.pid).toBe('player-under-test');
    expect(doc.exp?.runs).toBe(3);
    // Read at construction, so nothing that happens during the run can move it.
    // Sampled at the end instead, a Discovery banked on the killing tick would
    // make every run look more practised than the player was.
    expect(telemetry.snapshot(world, 'death').exp).toEqual(doc.exp);
  });

  it('accepts a player who cannot be identified', () => {
    const world = fresh();
    // Private browsing, full quota, storage switched off. The run still counts;
    // it just cannot be linked to any other run.
    const telemetry = new RunTelemetry(world.config.seed, world.config.axiomId, {
      build: 'test',
      startedAt: 1,
      pid: null,
      exp: null,
      fx: [],
    });
    run(world, telemetry, 3);
    const doc = telemetry.snapshot(world, 'quit');
    expect(doc.pid).toBeNull();
    expect(doc.exp).toBeNull();
    expect(() => JSON.stringify(doc)).not.toThrow();
  });

  it('bins frames without allocating a frame log', () => {
    const world = fresh();
    const telemetry = tel(world);
    run(world, telemetry, 3);
    // 16.6ms is a 60Hz frame, 8.3 a 120Hz one, 250 is the clamp ceiling.
    for (let i = 0; i < 100; i++) telemetry.frame(16.6, 1.2, 3);
    for (let i = 0; i < 10; i++) telemetry.frame(8.3);
    telemetry.frame(250, 40, 30);

    const p = telemetry.snapshot(world).perf;
    expect(p.frames).toBe(111);
    expect(p.hist.reduce((a, b) => a + b, 0)).toBe(111);
    expect(p.hist).toHaveLength(p.bucketsMs.length + 1);
    expect(p.worstMs).toBe(250);
    // The 250ms frame must land in the final open-ended bucket, not the last
    // closed one — a stall that reads as "just under 100ms" is a lie.
    expect(p.hist.at(-1)).toBe(1);
    expect(p.gpuSamples).toBe(101);
    expect(p.gpuWorstMs).toBe(40);
    // Busy time only counts frames that reported one — the first frame sends 0
    // because the cost arrives a frame late — so the mean is over 101, not 111.
    expect(p.cpuWorstMs).toBe(30);
    expect(p.cpuMeanMs).toBeCloseTo((100 * 3 + 30) / 101, 1);
  });

  it('counts deleted sim time separately from slow frames', () => {
    const world = fresh();
    const telemetry = tel(world);
    run(world, telemetry, 2);
    expect(telemetry.snapshot(world).perf.starved).toBe(0);
    telemetry.starve();
    telemetry.starve();
    // Not a frame-rate number. These runs had time removed from them and are
    // not comparable to others on duration.
    expect(telemetry.snapshot(world).perf.starved).toBe(2);
  });

  it('reports an unfinished run as unfinished', () => {
    const world = fresh();
    const telemetry = tel(world);
    run(world, telemetry, 10);
    // Null is the signal, not a placeholder — the outbox turns it into
    // `abandoned` at next boot, which is the only way that ending is observed.
    expect(telemetry.snapshot(world).end).toBeNull();
    expect(telemetry.snapshot(world, 'quit').end).toBe('quit');
    expect(telemetry.snapshot(world).v).toBe(TELEMETRY_VERSION);
  });
});

// ---------------------------------------------------------------- the outbox

/** vitest runs in `node`, which has no localStorage. The queue needs one. */
class MemoryStorage {
  private map = new Map<string, string>();
  getItem(k: string): string | null {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.map.set(k, v);
  }
  removeItem(k: string): void {
    this.map.delete(k);
  }
}

describe('playerId', () => {
  beforeEach(() => {
    (globalThis as { localStorage?: unknown }).localStorage = new MemoryStorage();
  });

  it('mints once and then keeps returning the same id', () => {
    const first = playerId();
    expect(first).toBeTruthy();
    expect(playerId()).toBe(first);
    expect(playerId()).toBe(first);
  });

  it('mints a different id for a different browser', () => {
    const a = playerId();
    (globalThis as { localStorage?: unknown }).localStorage = new MemoryStorage();
    expect(playerId()).not.toBe(a);
  });

  it('forgets on reset', () => {
    const first = playerId();
    resetPlayerId();
    expect(playerId()).not.toBe(first);
  });

  it('survives storage being unavailable, without inventing a session id', () => {
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem() {
        throw new Error('disabled');
      },
      setItem() {
        throw new Error('disabled');
      },
      removeItem() {
        throw new Error('disabled');
      },
    };
    // Null, not a fresh id per call. A per-session fallback would fill the
    // corpus with ghosts who each played exactly once and inflate the count of
    // distinct players with people who do not exist.
    expect(playerId()).toBeNull();
    expect(playerId()).toBeNull();
  });

  it('keeps identity out of the Library', () => {
    playerId();
    // §15.1's guard scans LibraryData; identity is not progression, and clearing
    // one must not clear the other.
    expect(localStorage.getItem('overclock.library.v1')).toBeNull();
    expect(localStorage.getItem('overclock.player.v1')).toBeTruthy();
  });
});

describe('outbox', () => {
  beforeEach(() => {
    (globalThis as { localStorage?: unknown }).localStorage = new MemoryStorage();
    clearOutbox();
  });

  function doc(id: string, end: TelemetryDoc['end'] = null): TelemetryDoc {
    const world = fresh();
    return { ...tel(world).snapshot(world, end), id };
  }

  it('upserts by run id rather than accumulating duplicates', () => {
    // The trap this exists for: one run that is tab-switched away from three
    // times would otherwise land as four runs and skew every rate in the corpus.
    queueRun(doc('run-a'));
    queueRun(doc('run-a'));
    queueRun(doc('run-a', 'death'));
    queueRun(doc('run-b'));

    const pending = pendingRuns();
    expect(pending).toHaveLength(2);
    expect(pending.find((d) => d.id === 'run-a')?.end).toBe('death');
  });

  it('seals only the runs nobody finished', () => {
    queueRun(doc('open'));
    queueRun(doc('closed', 'death'));

    expect(sealAbandoned()).toBe(1);
    const pending = pendingRuns();
    expect(pending.find((d) => d.id === 'open')?.end).toBe('abandoned');
    expect(pending.find((d) => d.id === 'closed')?.end).toBe('death');
    // Idempotent: a second boot must not re-seal or re-count anything.
    expect(sealAbandoned()).toBe(0);
  });

  it('a mid-run stash is eligible for sealing', () => {
    // The first link in the abandoned chain, and the one no test reached: the
    // path only works because `snapshot()` called *without* an end argument —
    // which is exactly how game.ts stashes every STASH_EVERY seconds — leaves
    // `end` null. Give it any default and abandoned runs stop existing, silently,
    // and a silently missing abandoned run looks identical to a player who never
    // showed up. Verified end-to-end in a browser against a real reload; this is
    // the half that can be held here.
    const world = new World({ seed: 'stash-eligible', axiomId: 'ignition' });
    const t = new RunTelemetry('stash-eligible', 'ignition', {
      build: 'test',
      startedAt: 0,
      pid: null,
      exp: null,
      fx: [],
    });
    for (let i = 0; i < 60; i++) world.advance(NO_INPUT);

    const stashed = t.snapshot(world);
    expect(stashed.end, 'a mid-run stash must not claim to know how the run ended').toBeNull();

    queueRun(stashed);
    expect(sealAbandoned()).toBe(1);
    expect(pendingRuns().find((d) => d.id === stashed.id)?.end).toBe('abandoned');
  });

  it('carries a document from another build without reinterpreting it', () => {
    // This used to assert the opposite — that a foreign document was dropped on
    // read — and dropping it was a delete, because every mutator here is a
    // read-modify-write. The first boot after a version bump therefore discarded
    // every run left pending by the build being replaced: the crashes, the
    // freezes, the closed tabs. Precisely the churn signal, and silently.
    //
    // So it is kept and shipped, and *not* stamped: `end` is only set where this
    // build knows what `end` means. Analysis segments on `v` and says how many
    // rows it set aside, which makes a foreign document a counted gap instead of
    // a confident lie.
    queueRun(doc('current'));
    const raw = JSON.parse(localStorage.getItem('overclock.telemetry.outbox.v1')!) as TelemetryDoc[];
    raw.push({ ...doc('ancient'), v: TELEMETRY_VERSION - 1 });
    localStorage.setItem('overclock.telemetry.outbox.v1', JSON.stringify(raw));

    expect(pendingRuns().map((d) => d.id).sort()).toEqual(['ancient', 'current']);

    // Sealing touches this build's runs and leaves the other alone.
    expect(sealAbandoned()).toBe(1);
    const after = pendingRuns();
    expect(after.find((d) => d.id === 'current')?.end).toBe('abandoned');
    expect(after.find((d) => d.id === 'ancient')?.end).toBeNull();

    // ...and queueing a new run must not quietly evict it either.
    queueRun(doc('later'));
    expect(pendingRuns().some((d) => d.id === 'ancient')).toBe(true);
  });

  it('a malformed entry is dropped, a foreign one is not', () => {
    // The structural check is the only thing `read` still refuses: something
    // with no id cannot be keyed, deduplicated or forgotten, so it cannot travel.
    queueRun(doc('good'));
    const raw = JSON.parse(localStorage.getItem('overclock.telemetry.outbox.v1')!) as unknown[];
    raw.push({ v: TELEMETRY_VERSION }, null, 'nonsense', { id: 'no-version' });
    localStorage.setItem('overclock.telemetry.outbox.v1', JSON.stringify(raw));

    expect(pendingRuns().map((d) => d.id)).toEqual(['good']);
  });

  it('forgets a run once it has been delivered', () => {
    queueRun(doc('sent'));
    queueRun(doc('kept'));
    forgetRun('sent');
    expect(pendingRuns().map((d) => d.id)).toEqual(['kept']);
  });

  it('survives storage being unavailable entirely', () => {
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem() {
        throw new Error('disabled');
      },
      setItem() {
        throw new Error('disabled');
      },
      removeItem() {
        throw new Error('disabled');
      },
    };
    // Private browsing, a full quota, storage switched off. None of it is
    // allowed to reach the run.
    expect(() => queueRun(doc('x'))).not.toThrow();
    expect(pendingRuns()).toEqual([]);
    expect(() => sealAbandoned()).not.toThrow();
  });
});
