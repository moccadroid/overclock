/**
 * Draft overlay (§19.5), pipeline editor (§19.6), pause (§19.8) and a minimal
 * results panel (§14). Placeholder presentation, real information architecture:
 * the per-row Cycle cost / fire rate / share-of-EPS readout is the thing the
 * milestone exists to test, so it is complete even though it is unstyled.
 *
 * Reordering here is click-based (move up/down). Drag-to-reorder is §19.6's
 * shipping interaction and lands with the real editor in M2.
 */
import {
  applyDraft,
  describeCard,
  purgeCard,
  rollDraft,
  useReroll,
  type DraftCard,
  type DraftOffer,
} from '../sim/draft';
import { MODIFIER_BY_ID, NODE_BY_ID } from '../content/index';
import type { World } from '../sim/world';
import { LOADBEARING } from '../sim/tunables';

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

// ------------------------------------------------------------------- draft

export class DraftOverlay extends Overlay {
  private offer: DraftOffer | null = null;
  private onDone: (() => void) | null = null;
  private world: World | null = null;

  constructor(root: HTMLElement) {
    super(root, 'draft');
  }

  present(world: World, onDone: () => void): void {
    this.world = world;
    this.onDone = onDone;
    this.offer = rollDraft(world);
    this.setOpen(true);
    this.render();
  }

  /** Keyboard 1/2/3 pick, R rerolls (§19.5 bottom rail). */
  handleKey(index: number): void {
    if (!this.offer) return;
    const card = this.offer.cards[index];
    if (card) this.choose(card);
  }

  reroll(): void {
    if (!this.world || !this.offer) return;
    if (!useReroll(this.world)) return;
    this.offer = rollDraft(this.world);
    this.render();
  }

  private choose(card: DraftCard): void {
    if (!this.world) return;
    applyDraft(this.world, card);
    this.setOpen(false);
    this.offer = null;
    this.onDone?.();
  }

  private render(): void {
    const world = this.world;
    const offer = this.offer;
    if (!world || !offer) return;

    this.el.replaceChildren();

    const title = document.createElement('h2');
    title.textContent = 'DRAFT';
    this.el.appendChild(title);

    const cards = document.createElement('div');
    cards.className = 'cards';

    offer.cards.forEach((card, i) => {
      const info = describeCard(card);
      const el = document.createElement('div');
      el.className = 'card';
      el.tabIndex = 0;

      const tag = document.createElement('div');
      tag.className = 'tag';
      tag.textContent = info.tag;

      const name = document.createElement('div');
      name.className = 'title';
      name.textContent = info.title;

      const body = document.createElement('div');
      body.className = 'body';
      body.textContent = info.body;

      // §19.5 — hover/focus shows where it lands before you commit.
      const slot = document.createElement('div');
      slot.className = 'slot';
      slot.textContent = previewSlot(world, card);

      const foot = document.createElement('div');
      foot.className = 'key';
      foot.textContent = `[${i + 1}]`;

      const purge = document.createElement('button');
      purge.className = 'purge';
      purge.textContent = `PURGE (${world.purges})`;
      purge.disabled = card.kind !== 'node' || world.purges <= 0;
      purge.addEventListener('click', (ev) => {
        ev.stopPropagation();
        if (purgeCard(world, card)) {
          this.offer = rollDraft(world);
          this.render();
        }
      });

      el.append(tag, name, body, slot, foot, purge);
      el.addEventListener('click', () => this.choose(card));
      cards.appendChild(el);
    });

    const rail = document.createElement('div');
    rail.className = 'rail';
    rail.textContent =
      `REROLL [R] x${world.rerolls}     PURGE x${world.purges}     ` +
      `PICK [1] [2] [3]     queued: ${world.pendingDrafts}`;

    this.el.append(cards, rail);
  }
}

function previewSlot(world: World, card: DraftCard): string {
  if (card.kind === 'capacity') return `Cycles ${world.budget.capacity} -> ${world.budget.capacity + card.amount}`;
  if (card.kind === 'program_slot') {
    return `Programs ${world.engine.programs.length} -> ${world.engine.programs.length + 1}`;
  }
  const node = NODE_BY_ID.get(card.nodeId);
  if (!node) return '';
  const programs = world.engine.programs;
  let index = -1;
  if (node.kind === 'trigger') index = programs.findIndex((p) => p.triggerId === null);
  else if (node.kind === 'action') index = programs.findIndex((p) => p.actionId === null);
  else index = programs.findIndex((p) => p.modifierIds.some((m) => m === null));
  return index >= 0 ? `Slots into: Program ${index + 1}` : 'No compatible slot';
}

// ------------------------------------------------------------------ editor

export class EditorOverlay extends Overlay {
  private world: World | null = null;

  constructor(root: HTMLElement) {
    super(root, 'editor');
  }

  toggle(world: World): void {
    this.world = world;
    const next = !this.open;
    this.setOpen(next);
    if (next) this.render();
  }

  close(): void {
    this.setOpen(false);
  }

  private render(): void {
    const world = this.world;
    if (!world) return;
    this.el.replaceChildren();

    const panel = document.createElement('div');
    panel.className = 'panel';

    const totalEps = world.engine.programs.reduce((s, p) => s + p.recentEvents, 0);

    const head = document.createElement('div');
    head.className = 'head';
    head.innerHTML =
      `<span>PIPELINE</span>` +
      `<span>STATIC ${world.engine.staticLoad.toFixed(1)} / ${world.budget.capacity} CYCLES` +
      `   HEAT ${world.budget.heat.toFixed(0)}` +
      `   SCRAP +${(world.engine.scrapStacks * 4).toFixed(0)}%` +
      `   KERNELS ${world.engine.kernel > 1 ? world.engine.kernel.toFixed(2) : 0}</span>`;
    panel.appendChild(head);

    world.engine.programs.forEach((program, i) => {
      const compiled = world.engine.compiled[i]!;
      const row = document.createElement('div');
      row.className = 'row';

      const idx = document.createElement('div');
      idx.className = 'idx';
      idx.textContent = String(i + 1);

      const chips = document.createElement('div');
      chips.className = 'chips';
      chips.appendChild(
        chip(program.triggerId, 'trigger', this.scrapAnd(() => world.engine.scrapNode(i, 'trigger'))),
      );
      for (let s = 0; s < LOADBEARING.modifierSlotsPerProgram; s++) {
        chips.appendChild(arrow());
        const id = program.modifierIds[s] ?? null;
        const group = document.createElement('span');
        group.className = 'slot-group';
        // Walk a modifier along the chain — §5.5's ordering axis, made operable.
        group.appendChild(
          slotButton('‹', s > 0 && id !== null, this.scrapAnd(() => world.engine.swapModifiers(i, s, s - 1))),
        );
        group.appendChild(chip(id, 'modifier', this.scrapAnd(() => world.engine.scrapNode(i, s))));
        group.appendChild(
          slotButton(
            '›',
            s < LOADBEARING.modifierSlotsPerProgram - 1 && id !== null,
            this.scrapAnd(() => world.engine.swapModifiers(i, s, s + 1)),
          ),
        );
        chips.appendChild(group);
      }
      chips.appendChild(arrow());
      chips.appendChild(
        chip(program.actionId, 'action', this.scrapAnd(() => world.engine.scrapNode(i, 'action'))),
      );

      const stats = document.createElement('div');
      stats.className = 'stats';
      const share = totalEps > 0 ? (program.recentEvents / totalEps) * 100 : 0;
      stats.textContent = compiled.live
        ? `${compiled.staticCost.toFixed(1)} cyc  ` +
          `x${compiled.ctx.output.toFixed(2)} out  ` +
          `${Math.round(compiled.ctx.count)}x${compiled.executions.length}\n` +
          `${program.recentEvents.toFixed(1)} ev/s  ${share.toFixed(0)}% of EPS`
        : 'not live';

      const ops = document.createElement('div');
      ops.className = 'ops';
      ops.append(
        button('^', i > 0, () => {
          world.engine.moveProgram(i, i - 1);
          world.syncBudget();
          this.render();
        }),
        button('v', i < world.engine.programs.length - 1, () => {
          world.engine.moveProgram(i, i + 1);
          world.syncBudget();
          this.render();
        }),
        button('SCRAP ROW', compiled.live || hasAnyNode(program), () => {
          world.engine.scrapProgram(i);
          world.syncBudget();
          this.render();
        }, true),
      );

      row.append(idx, chips, stats, ops);
      panel.appendChild(row);
    });

    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent =
      'Modifiers apply left to right — use ‹ › to reorder them and watch the output multiplier change. ' +
      'Click a node chip to scrap it: refunds its Cycles and grants +4% permanent global output (§5.7). ' +
      'Rows evaluate top to bottom. TAB to close.';
    panel.appendChild(hint);

    this.el.appendChild(panel);
  }

  /** Wrap a structural mutation so static load and the readout stay in sync. */
  private scrapAnd(fn: () => void): () => void {
    return () => {
      fn();
      this.world?.syncBudget();
      this.render();
    };
  }
}

function hasAnyNode(program: { triggerId: string | null; actionId: string | null; modifierIds: (string | null)[] }): boolean {
  return Boolean(program.triggerId || program.actionId || program.modifierIds.some(Boolean));
}

function arrow(): HTMLElement {
  const el = document.createElement('span');
  el.className = 'arrow';
  el.textContent = '→';
  return el;
}

function chip(
  nodeId: string | null,
  kind: 'trigger' | 'modifier' | 'action',
  onScrap: () => void,
): HTMLElement {
  const el = document.createElement('span');
  el.className = `chip ${kind}${nodeId ? '' : ' empty'}`;
  if (!nodeId) {
    el.textContent = kind === 'modifier' ? '—' : `no ${kind}`;
    return el;
  }
  const node = NODE_BY_ID.get(nodeId);
  const mult = MODIFIER_BY_ID.get(nodeId)?.cycleMult;
  el.textContent = node ? `${node.name}${mult ? ` x${mult}` : ''}` : nodeId;
  el.title = node?.description ?? '';
  el.style.cursor = 'pointer';
  el.addEventListener('click', onScrap);
  return el;
}

function slotButton(label: string, enabled: boolean, onClick: () => void): HTMLButtonElement {
  const el = document.createElement('button');
  el.className = 'slot-move';
  el.textContent = label;
  el.disabled = !enabled;
  el.title = 'Move this modifier along the chain — order changes the numbers';
  el.addEventListener('click', onClick);
  return el;
}

function button(
  label: string,
  enabled: boolean,
  onClick: () => void,
  danger = false,
): HTMLButtonElement {
  const el = document.createElement('button');
  el.textContent = label;
  el.disabled = !enabled;
  if (danger) el.className = 'danger';
  el.addEventListener('click', onClick);
  return el;
}

// ------------------------------------------------------- pause and results

export class MessageOverlay extends Overlay {
  show(headline: string, body: string): void {
    this.el.replaceChildren();
    const panel = document.createElement('div');
    panel.className = 'panel';
    const h = document.createElement('div');
    h.className = 'headline';
    h.textContent = headline;
    const b = document.createElement('div');
    b.textContent = body;
    panel.append(h, b);
    this.el.appendChild(panel);
    this.setOpen(true);
  }

  hide(): void {
    this.setOpen(false);
  }
}
