/**
 * The campaign, as a sequence of shifts. STORY-AND-TONE §7.
 *
 * The state is a plain value and the rules are pure functions, so this file
 * plays all six runs with no renderer and no run — and it can reach states no
 * sequence of play produces.
 *
 * The law under test: the rungs are hard-gated on documents held and doors
 * opened, never on run count. A player who dies eight times is exactly where
 * they were; a player who rushes cannot skip a rung, because the next rung's
 * files are not on the floor until the story places them.
 */
import { describe, expect, it } from 'vitest';
import {
  CHECKPOINTS,
  advance,
  configure,
  delivered,
  rungOf,
  stationRead,
  type Context,
} from './arc';
import { START, nextCycle, type Story } from './state';
import { filesFor } from '../app/shell/panes';

const atRunStart = (runsCompleted: number): Context => ({ runsCompleted, levelsOpened: [] });
const atRunEnd = (
  runsCompleted: number,
  levelsOpened: string[] = [],
  extra: Partial<Context> = {},
): Context => ({ runsCompleted, levelsOpened, ending: 'died-early', ...extra });
const base = { seed: 'run-test', axiomId: 'ignition' };

/** Play a beat out of the queue, the way the terminal would. */
const read = (story: Story, beatId: string): Story => delivered(story, beatId);
const readAll = (story: Story): Story => story.queue.reduce(read, story);

const got = (doc: string, section = 0): Partial<Context> => ({
  ending: 'extracted',
  recovered: [{ doc, section }],
});

describe('the six runs, played clean', () => {
  it('walks the whole ladder in order', () => {
    let story: Story = START;

    // Run 1 — the assignment notice, then orientation concluded on the gate.
    story = advance(story, 'run-start', atRunStart(0));
    expect(story.queue).toEqual(['B-welcome']);
    story = read(story, 'B-welcome');
    let config = configure(story, base);
    expect(config.arenaId).toBe('heap');
    expect(config.concludeOnOpen).toBe('sink');
    expect(config.pressure).toBeLessThan(1);
    story = advance(story, 'run-end', atRunEnd(0, ['heap', 'sink'], { ending: 'extracted' }));
    expect(story.queue).toEqual(['B-onboard']);
    story = read(story, 'B-onboard');
    expect(rungOf(story)).toBe(2);

    // Run 2 — first contact; the schedule and the criteria are in the Sink.
    story = advance(story, 'run-start', atRunStart(1));
    expect(story.queue).toEqual(['R1']);
    story = read(story, 'R1');
    config = configure(story, base);
    expect(config.arenaId).toBe('heap');
    expect(config.openLevels).toContain('sink');
    expect(config.concludeOnOpen).toBeUndefined();
    expect(config.recoveredPois ?? []).not.toContain('sink.oc0044');
    // The archive's file is not on any floor yet — its room does not exist.
    story = advance(story, 'run-end', {
      ...atRunEnd(1, ['heap', 'sink']),
      ending: 'extracted',
      recovered: [
        { doc: 'OC0044', section: 0 },
        { doc: 'OC0051', section: 0 },
      ],
    });
    expect(rungOf(story)).toBe(3);

    // Run 3 — the proof at the commitment point; the archive is in the arena.
    story = advance(story, 'run-start', atRunStart(2));
    expect(story.queue).toEqual(['R2']);
    expect(story.chapter).toBe('II');
    story = read(story, 'R2');
    config = configure(story, base);
    expect(config.arenaId).toBe('heap_archive');
    // The deep-bay files are not placed at rung 3: the dead-gate run owns them.
    expect(config.recoveredPois).toContain('archive.oc0046x');
    expect(config.recoveredPois).toContain('archive.oc0031');
    expect(config.recoveredPois).not.toContain('archive.oc0052');
    story = advance(story, 'run-end', {
      ...atRunEnd(2, ['heap', 'archive'], got('OC0052')),
    });
    expect(rungOf(story)).toBe(4);
    // N/1 lands on the way out, plus her reaction to the first new door.
    expect(story.queue).toContain('N1');
    expect(story.queue).toContain('R-door');
    story = readAll(story);

    // Run 4 — clause 4.1 at the commitment point; the store gate is dead.
    story = advance(story, 'run-start', atRunStart(3));
    expect(story.queue).toEqual(['R3']);
    story = read(story, 'R3');
    config = configure(story, base);
    expect(config.arenaId).toBe('heap_store');
    expect(config.deadGates).toContain('partition_3');
    expect(config.deadGates).toContain('relay_1');
    expect(config.recoveredPois).not.toContain('archive.oc0046x');
    story = advance(story, 'run-end', {
      ...atRunEnd(3, ['heap', 'archive'], {
        ending: 'extracted',
        recovered: [
          { doc: 'OC0046X', section: 0 },
          { doc: 'OC0031', section: 0 },
        ],
      }),
    });
    expect(rungOf(story)).toBe(5);
    expect(story.queue).toEqual(['N2']);
    expect(story.chapter).toBe('III');
    story = read(story, 'N2');

    // Run 5 — the predecessor and the relay; the store opens from inside.
    story = advance(story, 'run-start', atRunStart(4));
    expect(story.queue).toEqual(['R4']);
    story = read(story, 'R4');
    config = configure(story, base);
    expect(config.arenaId).toBe('heap_store');
    expect(config.deadGates).toEqual(['partition_3']);
    expect(config.recoveredPois ?? []).not.toContain('store.oc0061');
    story = advance(story, 'run-end', {
      ...atRunEnd(4, ['heap', 'archive', 'store'], {
        ending: 'extracted',
        recovered: [
          { doc: 'OC0061', section: 0 },
          { doc: 'OC001D', section: 0 },
        ],
      }),
    });
    expect(rungOf(story)).toBe(6);
    expect(story.queue).toEqual(['N3']);
    expect(story.chapter).toBe('IV');
    story = read(story, 'N3');

    // Run 6 — the gift, the deadline, the cell, the end.
    story = advance(story, 'run-start', atRunStart(5));
    expect(story.queue).toEqual(['R5']);
    story = read(story, 'R5');
    config = configure(story, base);
    expect(config.arenaId).toBe('heap_cell');
    expect(config.noExtract).toBe(true);
    expect(config.concludeOnOpen).toBe('cell');
    expect(config.openLevels).toEqual(['sink', 'archive', 'store']);
    expect((config.bonusRows ?? []).length).toBeGreaterThanOrEqual(3);
    expect(config.bonusCapacity).toBeGreaterThan(0);
    story = advance(story, 'run-end', atRunEnd(5, ['heap', 'cell'], { ending: 'extracted' }));
    expect(story.chapter).toBe('V');
    expect(story.flags['campaign.done']).toBe(1);
    expect(story.queue).toEqual(['E1', 'E2']);
  });

  it('grows the starter every run — the build remembers', () => {
    const caps = [1, 2, 3, 4, 5, 6].map((rung) => {
      const c = CHECKPOINTS[['fresh', 'tutored', 'archive', 'deadgate', 'store', 'final'][rung - 1]!]!;
      return configure(c, base).bonusCapacity ?? 0;
    });
    for (let i = 1; i < caps.length; i++) expect(caps[i]!).toBeGreaterThanOrEqual(caps[i - 1]!);
    expect(caps[5]).toBeGreaterThan(caps[1]!);
  });
});

describe('the rungs are things done, never runs played', () => {
  it('waits at rung 2 for as long as the schedule stays on the floor', () => {
    let story = CHECKPOINTS['contact']!;
    for (let run = 2; run < 12; run++) {
      story = advance(story, 'run-start', atRunStart(run));
      story = readAll(story);
      story = advance(story, 'run-end', atRunEnd(run, ['heap', 'sink']));
    }
    expect(rungOf(story)).toBe(2);
    expect(story.fired).not.toContain('R2');
    // She nags twice, then the channel goes quiet about it.
    expect(story.fired.filter((id) => id === 'R-nag1')).toHaveLength(1);
    expect(story.fired.filter((id) => id === 'R-nag2')).toHaveLength(1);
  });

  it('keeps orientation exactly as it was, however many deaths it takes', () => {
    let story = advance(START, 'run-start', atRunStart(0));
    story = read(story, 'B-welcome');
    for (let run = 0; run < 6; run++) {
      story = advance(story, 'run-end', atRunEnd(run, ['heap']));
      story = readAll(story);
    }
    expect(rungOf(story)).toBe(1);
    const config = configure(story, base);
    expect(config.concludeOnOpen).toBe('sink');
    expect(config.recoveredPois ?? []).not.toContain('heap.s1');
    // The site notices once; further failures are silence.
    expect(story.fired.filter((id) => id === 'B-lapse')).toHaveLength(1);
    expect(story.fired).not.toContain('R1');
  });

  it('keeps a read station on the floor during orientation', () => {
    let story = advance(START, 'run-start', atRunStart(0));
    story = read(story, 'B-welcome');
    story = stationRead(story, 'S1');
    expect(configure(story, base).recoveredPois ?? []).not.toContain('heap.s1');
    story = advance(story, 'run-end', atRunEnd(0, ['heap', 'sink'], { ending: 'extracted' }));
    expect(configure(story, base).recoveredPois).toContain('heap.s1');
  });

  it('points at a walked-past monitoring file, once', () => {
    let story = CHECKPOINTS['archive']!;
    story = advance(story, 'run-end', atRunEnd(2, ['heap', 'archive'], { ending: 'extracted' }));
    expect(story.queue).toContain('R-missed');
  });
});

describe('the thread cannot collapse into one pass', () => {
  it('a hand-set story still delivers one message per commitment', () => {
    // Everything held, nothing read: no sequence of play produces this, and
    // the thread still walks its beats one commitment at a time.
    const odd: Story = {
      ...START,
      flags: { 'tutorial.done': 1, 'doors.archive': 1, 'doors.store': 1 },
      held: CHECKPOINTS['final']!.held,
    };
    let story = advance(odd, 'run-start', atRunStart(9));
    expect(story.queue).toEqual(['B-welcome']);
    story = read(story, 'B-welcome');
    // B-onboard never fired for this account; R1 waits on it forever, which is
    // what a hand-set state deserves — jumpTo exists for the sane version.
    story = advance(story, 'run-start', atRunStart(9));
    expect(story.queue).toEqual([]);
  });

  it('reads the checkpoints as valid resumption points', () => {
    for (const [name, checkpoint] of Object.entries(CHECKPOINTS)) {
      // Every checkpoint must configure without throwing and land on a rung.
      const config = configure(checkpoint, base);
      expect(config.arenaId, name).toBeTruthy();
      expect(rungOf(checkpoint), name).toBeGreaterThanOrEqual(1);
    }
    expect(rungOf(CHECKPOINTS['fresh']!)).toBe(1);
    expect(rungOf(CHECKPOINTS['contact']!)).toBe(2);
    expect(rungOf(CHECKPOINTS['archive']!)).toBe(3);
    expect(rungOf(CHECKPOINTS['deadgate']!)).toBe(4);
    expect(rungOf(CHECKPOINTS['store']!)).toBe(5);
    expect(rungOf(CHECKPOINTS['final']!)).toBe(6);
  });
});

describe('the index grows', () => {
  it('adds a recovered document to files, and nothing before that', () => {
    const before = filesFor({}).map((f) => f.ref);
    const after = filesFor(CHECKPOINTS['archive']!.held).map((f) => f.ref);
    expect(before).not.toContain('OC-0044');
    expect(after).toContain('OC-0044');
    expect(after).toContain('OC-0051');
    // The standing files keep their order; recovered ones are appended.
    expect(after.slice(0, before.length)).toEqual(before);
  });
});

describe('the cycle', () => {
  it('wipes the arc, keeps the scars, and increments the revision', () => {
    const ended: Story = {
      ...CHECKPOINTS['final']!,
      scars: ['origin.glimpsed'],
      revision: '04',
    };
    const next = nextCycle(ended);
    expect(next.held).toEqual({});
    expect(next.fired).toEqual([]);
    expect(next.chapter).toBe('I');
    expect(next.scars).toEqual(['origin.glimpsed']);
    expect(next.revision).toBe('05');
  });
});
