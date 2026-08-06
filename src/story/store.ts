/**
 * Where the story state is kept between sessions.
 *
 * Its own storage key rather than a corner of the Library, because §12 wipes the
 * arc on RESET while the Library's shift count reseeds to a *different* offset —
 * two lifetimes, and untangling them later out of one blob is worse than keeping
 * them apart now.
 *
 * The class is deliberately thin: it holds a `Story`, hands it to the pure
 * functions in `arc.ts`, and saves what comes back. All the behaviour is there,
 * where it can be tested without storage.
 */
import { STORY, type Context, type Moment, advance, delivered } from './arc';
import { START, type Story, nextCycle } from './state';

const STORAGE_KEY = 'overclock.story.v1';

export class StoryStore {
  private story: Story = START;

  constructor() {
    this.load();
  }

  get state(): Story {
    return this.story;
  }

  /** Evaluate the arc at a moment. Returns the state it left behind. */
  advance(at: Moment, context: Context): Story {
    this.story = advance(this.story, at, context);
    this.save();
    return this.story;
  }

  /** The operator read it to the end. Anything less and it stays queued. */
  delivered(beatId: string): void {
    this.story = delivered(this.story, beatId);
    this.save();
  }

  /** §12 — restore from backup, restaff, increment the revision index. */
  cycle(): void {
    this.story = nextCycle(this.story);
    this.save();
  }

  /**
   * Put the story anywhere.
   *
   * The reason the state is a plain value: testing the arc means reaching states
   * that no sequence of play produces — a document held at clearance 0, a beat
   * fired without its predecessor — and every one of those is a literal.
   */
  set(story: Partial<Story>): void {
    this.story = { ...this.story, ...story };
    this.save();
  }

  /** Back to shift one, cycle one. Not RESET: this keeps nothing. */
  wipe(): void {
    this.story = START;
    this.save();
  }

  /**
   * Every rule up to and including `id`, forced.
   *
   * For getting to a point by hand. It runs the effects without their
   * conditions, so it reaches the state the arc *would* have produced along the
   * golden path — which is the useful default, and not a substitute for `set`
   * when the state you want is off it.
   */
  forceTo(ruleId: string): void {
    let next = START;
    for (const rule of STORY) {
      next = { ...rule.does(next), fired: [...next.fired, rule.id] };
      if (rule.id === ruleId) break;
    }
    this.story = next;
    this.save();
  }

  private load(): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      // Field by field over a fresh START, so a story written by an older build
      // gains new fields at their defaults instead of arriving half-shaped.
      const parsed = JSON.parse(raw) as Partial<Story>;
      this.story = { ...START, ...parsed };
    } catch {
      // A corrupt story costs you the arc, not the ability to play.
      this.story = START;
    }
  }

  private save(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.story));
    } catch {
      // Private browsing. The run still works; the arc just will not persist.
    }
  }
}
