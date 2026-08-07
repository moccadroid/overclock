/**
 * The Recompile chooser (§9) — the last DOM overlay.
 *
 * Everything else in the run is on the Sheet framework in `shell/`: the draft,
 * the primer, the pause, the ceremony, the pipeline, the results, the in-run
 * files. This one is next, and migrates with its first real change.
 */
import { NODE_BY_ID } from '../content/index';
import type { World } from '../sim/world';

export class Overlay {
  readonly el: HTMLElement;

  constructor(root: HTMLElement, id: string) {
    this.el = document.createElement('div');
    this.el.id = id;
    this.el.className = 'overlay';
    root.appendChild(this.el);
  }

  get open(): boolean {
    return this.el.classList.contains('open');
  }

  setOpen(open: boolean): void {
    this.el.classList.toggle('open', open);
  }
}

/**
 * A reading line for whatever the cursor is over.
 *
 * The browser's own tooltip is a white box in a system font that appears after a
 * pause somewhere near the pointer. Every one of those properties is wrong here:
 * it breaks §16's document, it is slow enough that you stop asking, and it moves.
 * A fixed line at the foot of the panel is instant, in-world, and always in the
 * same place, so reading becomes a glance rather than a hunt.
 *
 * Only `menu.ts` uses this now — the DOM menu that `shell/title.ts` replaced —
 * and it leaves with that file. The Sheet framework's version of the same idea
 * is the reading line at the foot of `shell/pipesheet.ts`.
 */
export function inspector(scope: HTMLElement): HTMLElement {
  const el = document.createElement('div');
  el.className = 'inspector';
  el.textContent = '';

  const show = (ev: Event): void => {
    const hit = (ev.target as HTMLElement | null)?.closest<HTMLElement>('[data-detail]');
    if (hit?.dataset.detail) el.textContent = hit.dataset.detail;
  };
  scope.addEventListener('mouseover', show);
  scope.addEventListener('focusin', show);
  scope.addEventListener('mouseleave', () => {
    el.textContent = '';
  });
  return el;
}

/**
 * The console. §19.6 (pipeline) and §19.8 (pause), which turned out to be one
 * screen with two pages.
 *
 * TAB was already muscle memory for "show me my stuff", and the run summary was
 * only reachable through ESC — so half of what a player wants mid-run was behind
 * the key they were not pressing. Both freeze the game and both are read rather
 * than played, so they are tabs of the same overlay now: TAB opens it on the
 * pipeline, ESC opens it on the run, and either key closes it.
 */
/**
 * §9, as revised by DECISIONS D-28 — choose how much of the Engine to sacrifice.
 *
 * The Kernel scales with the share of your output you give up, so this is a
 * dial, not a cliff: burn one dead row for a small permanent multiplier, or burn
 * the lot and rebuild from your Axiom for a large one. Sacrificing everything is
 * still available; it is no longer the only option.
 */
export class RecompileOverlay extends Overlay {
  private world: World | null = null;
  private selected = new Set<number>();
  private onConfirm: ((indices: number[]) => void) | null = null;

  constructor(root: HTMLElement) {
    super(root, 'recompile');
  }

  present(world: World, onConfirm: (indices: number[]) => void): void {
    this.world = world;
    this.onConfirm = onConfirm;
    this.selected = new Set();
    this.setOpen(true);
    this.render();
  }

  private render(): void {
    const world = this.world;
    if (!world) return;

    const liveRows = world.engine.programs
      .map((p, i) => ({ p, i }))
      .filter(({ i }) => world.engine.compiled[i]?.live);

    const chosen = [...this.selected];
    const percent = world.kernelPreview(chosen);
    const share = world.outputShareOf(chosen);

    this.el.replaceChildren();
    const panel = document.createElement('div');
    panel.className = 'panel recompile-panel';

    const head = document.createElement('div');
    head.className = 'headline';
    head.textContent = 'RECOMPILE';
    const sub = document.createElement('div');
    sub.className = 'sub';
    sub.textContent =
      'Choose what to sacrifice. The Kernel is a permanent global output multiplier, ' +
      'and it scales with the share of your engine you give up.';
    panel.append(head, sub);

    for (const { p, i } of liveRows) {
      const compiled = world.engine.compiled[i]!;
      const rowShare = world.outputShareOf([i]) * 100;
      const row = document.createElement('button');
      row.className = `sacrifice ${this.selected.has(i) ? 'on' : ''}`;
      const parts = [nodeLabel(p.triggerId)];
      for (const m of p.modifierIds) if (m) parts.push(nodeLabel(m));
      parts.push(nodeLabel(p.actionId));
      row.innerHTML =
        `<span class="mark">${this.selected.has(i) ? '▣' : '▢'}</span>` +
        `<span class="chain">${i + 1}  ${parts.join(' › ')}</span>` +
        `<span class="rowshare">${rowShare.toFixed(0)}% of output · ${compiled.staticCost.toFixed(0)}c</span>`;
      row.addEventListener('click', () => {
        if (this.selected.has(i)) this.selected.delete(i);
        else this.selected.add(i);
        this.render();
      });
      panel.appendChild(row);
    }

    const preview = document.createElement('div');
    preview.className = 'preview';
    preview.innerHTML =
      chosen.length === 0
        ? `<span class="dim">Nothing selected.</span>`
        : `Sacrificing <b>${(share * 100).toFixed(0)}%</b> of your output ` +
          `→ Kernel <b class="gain">+${percent.toFixed(0)}%</b> ` +
          `(total ×${(world.engine.kernel * (1 + percent / 100)).toFixed(2)}) ` +
          `· +${Math.round(20 * share)} Cycles · rebuild surge ${(180 * share).toFixed(0)}s`;
    panel.appendChild(preview);

    const rail = document.createElement('div');
    rail.className = 'rail';
    const all = document.createElement('button');
    all.textContent = 'SELECT ALL';
    all.addEventListener('click', () => {
      this.selected = new Set(liveRows.map(({ i }) => i));
      this.render();
    });
    const go = document.createElement('button');
    go.className = 'danger';
    go.textContent = 'RECOMPILE';
    go.disabled = chosen.length === 0;
    go.addEventListener('click', () => {
      this.setOpen(false);
      this.onConfirm?.(chosen);
    });
    const cancel = document.createElement('button');
    cancel.textContent = 'WALK AWAY';
    cancel.addEventListener('click', () => {
      this.setOpen(false);
      this.onConfirm?.([]);
    });
    rail.append(all, go, cancel);
    panel.appendChild(rail);

    this.el.appendChild(panel);
  }
}

function nodeLabel(id: string | null): string {
  if (!id) return '·';
  return NODE_BY_ID.get(id)?.name ?? id;
}

