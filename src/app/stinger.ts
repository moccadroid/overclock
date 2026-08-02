/**
 * The Discovery stinger. GDD §15.3 — a Discovery "fires in-run with a stinger".
 *
 * This is the tutorial. §15.4 says there is no tutorial level and no repeated
 * callouts, which puts the whole teaching load here: the moment you accidentally
 * do something the game considers interesting, it names the thing, tells you why
 * it mattered in one line, and shows you what it opened up.
 *
 * It does not pause. A modal here would punish the exact behaviour it is trying
 * to reward — you earn most of these mid-cascade, with the screen full.
 */
import { discovery as getDiscovery, NODE_BY_ID, AXIOM_BY_ID } from '../content/index';

interface Queued {
  id: string;
  unlocked: readonly string[];
}

const SHOW_SECONDS = 5.5;

export class Stinger {
  private readonly el: HTMLElement;
  private readonly queue: Queued[] = [];
  private timer = 0;
  private showing: string | null = null;

  constructor(root: HTMLElement) {
    this.el = document.createElement('div');
    this.el.id = 'stinger';
    root.appendChild(this.el);
  }

  push(id: string, unlocked: readonly string[]): void {
    this.queue.push({ id, unlocked });
  }

  /** Driven from the frame loop, so it runs on wall-clock and never on sim time. */
  update(dt: number): void {
    if (this.showing) {
      this.timer -= dt;
      if (this.timer > 0) return;
      this.showing = null;
      this.el.classList.remove('open');
    }
    // One at a time. A cascade can earn three at once and stacking them turns
    // the teaching moment into a notification spam feed.
    if (this.el.classList.contains('open')) return;
    const next = this.queue.shift();
    if (!next) return;
    this.render(next);
  }

  private render(item: Queued): void {
    const def = getDiscovery(item.id);
    const names = item.unlocked
      .map((id) => NODE_BY_ID.get(id)?.name ?? AXIOM_BY_ID.get(id)?.name ?? id)
      .join(' · ');

    this.el.innerHTML =
      `<div class="k">DISCOVERY</div>` +
      `<div class="name">${def.name}</div>` +
      `<div class="teaches">${def.teaches}</div>` +
      (names ? `<div class="unlocked">UNLOCKED &nbsp;${names}</div>` : '');
    this.el.classList.add('open');
    this.showing = item.id;
    this.timer = SHOW_SECONDS;
  }
}
