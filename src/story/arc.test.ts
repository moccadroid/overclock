/**
 * The first act, as a sequence of shifts.
 *
 * The reason the state is a plain value and the rules are pure functions: this
 * file plays four shifts of the campaign with no renderer, no run, and no
 * storage, and it can reach states no sequence of play produces.
 */
import { describe, expect, it } from 'vitest';
import { advance, configure, delivered, type Context } from './arc';
import { START, nextCycle, type Story } from './state';
import { filesFor } from '../app/shell/panes';

const atRunStart = (runsCompleted: number): Context => ({ runsCompleted, levelsOpened: [] });
const atRunEnd = (runsCompleted: number, levelsOpened: string[]): Context => ({
  runsCompleted,
  levelsOpened,
});
const base = { seed: 'run-test', axiomId: 'ignition' };

describe('the first act', () => {
  it('plays the four shifts in order', () => {
    let story: Story = START;

    // Shift 1 — she introduces herself before anything has happened.
    story = advance(story, 'run-start', atRunStart(0));
    expect(story.queue).toEqual(['R1']);

    // …the operator reads it, and it leaves the channel.
    story = { ...story, queue: [] };
    story = advance(story, 'run-end', atRunEnd(0, ['heap']));

    // Shift 2 — nothing. Silence is the default.
    story = advance(story, 'run-start', atRunStart(1));
    expect(story.queue).toEqual([]);

    // Shift 3 — the second message.
    story = advance(story, 'run-start', atRunStart(2));
    expect(story.queue).toEqual(['R2']);
    expect(story.chapter).toBe('II');
    story = { ...story, queue: [] };

    // Shift 4 — the run is built from a different arena, and says nothing.
    story = advance(story, 'run-start', atRunStart(3));
    expect(configure(story, base).arenaId).toBe('heap_archive');
    expect(story.queue).toEqual([]);

    // …the operator opens the door.
    story = advance(story, 'run-end', atRunEnd(3, ['heap', 'archive']));
    expect(story.held).toEqual({ B2: [0] });
    expect(story.chapter).toBe('III');
  });

  it('leaves the arena alone until the story asks for it', () => {
    expect(configure(START, base).arenaId).toBeUndefined();
  });

  it('holds a document without making it readable', () => {
    // §5.4 — recovering a file and being cleared to read it are different
    // things, and the bars are the difference.
    let story = advance(START, 'run-start', atRunStart(0));
    story = advance(story, 'run-start', atRunStart(2));
    story = advance(story, 'run-end', atRunEnd(3, ['archive']));
    expect(story.held.B2).toEqual([0]);
    expect(story.clearance).toBe(0);
  });

  it('does not repeat a beat that has already fired', () => {
    let story = advance(START, 'run-start', atRunStart(0));
    story = { ...story, queue: [] };
    story = advance(story, 'run-start', atRunStart(0));
    expect(story.queue).toEqual([]);
  });

  it('never grants the archive document to a run that did not open it', () => {
    let story = advance(START, 'run-start', atRunStart(0));
    story = advance(story, 'run-start', atRunStart(2));
    story = advance(story, 'run-start', atRunStart(3));
    story = advance(story, 'run-end', atRunEnd(3, ['heap', 'sink']));
    expect(story.held).toEqual({});
  });
});

describe('the index grows', () => {
  it('adds the recovered document to files, and nothing before that', () => {
    const before = filesFor({}).map((f) => f.ref);
    const after = filesFor({ B2: [0] }).map((f) => f.ref);
    expect(before).not.toContain('OC-002');
    expect(after).toContain('OC-002');
    // The standing files keep their order; the recovered one is appended.
    expect(after.slice(0, before.length)).toEqual(before);
  });
});

describe('§12 — the cycle', () => {
  it('wipes the arc, keeps the scars, and increments the revision', () => {
    const ended: Story = {
      ...START,
      chapter: 'V',
      clearance: 3,
      held: { B2: [0], B1: [0, 1] },
      fired: ['R1', 'R2'],
      scars: ['origin.glimpsed'],
      revision: '04',
    };
    const next = nextCycle(ended);
    expect(next.held).toEqual({});
    expect(next.fired).toEqual([]);
    expect(next.clearance).toBe(0);
    expect(next.chapter).toBe('I');
    expect(next.scars).toEqual(['origin.glimpsed']);
    expect(next.revision).toBe('05');
  });
});

describe('states off the golden path', () => {
  it('can be set directly, which is the whole point', () => {
    // Holding a document at clearance 3, having never seen R1. No sequence of
    // play produces this, and it is exactly the shape worth testing against.
    const odd: Story = { ...START, clearance: 3, held: { B2: [0] }, chapter: 'IV' };
    expect(filesFor(odd.held).some((f) => f.ref === 'OC-002')).toBe(true);
    // One, not two. R2 waits for R1 to be read, however many shifts are on file.
    expect(advance(odd, 'run-start', atRunStart(9)).queue).toEqual(['R1']);
  });
});

describe('a thread cannot collapse into one pass', () => {
  it('an operator with shifts already on file gets one message, not two', () => {
    // The bug this exists to prevent: R1's gate is `once` and R2's is
    // `runsCompleted >= 2`, so somebody arriving at the arc on shift 12 met both
    // at the same instant. Ordering on `fired` let R2 through a microsecond
    // after R1; ordering on delivery does not.
    const veteran = advance(START, 'run-start', atRunStart(12));
    expect(veteran.queue).toEqual(['R1']);
  });

  it('and gets the next one only after reading the first', () => {
    let story = advance(START, 'run-start', atRunStart(12));
    // Still queued — nothing moves.
    story = advance(story, 'run-start', atRunStart(13));
    expect(story.queue).toEqual(['R1']);

    // Read it, and the thread continues on the next run.
    story = delivered(story, 'R1');
    story = advance(story, 'run-start', atRunStart(13));
    expect(story.queue).toEqual(['R2']);
  });
});
