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
  /** Node awaiting scrap confirmation. Scrap is permanent and there is no undo. */
  private pendingScrap: { program: number; slot: 'trigger' | 'action' | number } | null = null;

  constructor(root: HTMLElement) {
    super(root, 'editor');
  }

  toggle(world: World): void {
    this.world = world;
    const next = !this.open;
    this.setOpen(next);
    this.pendingScrap = null;
    if (next) this.render();
  }

  close(): void {
    this.setOpen(false);
    this.pendingScrap = null;
  }

  /** Refund a scrap would return, for the confirmation copy (§19.6). */
  private refundFor(program: number, slot: 'trigger' | 'action' | number): number {
    const world = this.world;
    if (!world) return 0;
    const p = world.engine.programs[program];
    if (!p) return 0;
    const before = world.engine.compiled[program]?.staticCost ?? 0;

    const saved = { t: p.triggerId, a: p.actionId, m: [...p.modifierIds] };
    if (slot === 'trigger') p.triggerId = null;
    else if (slot === 'action') p.actionId = null;
    else p.modifierIds[slot] = null;
    world.engine.recompile();
    const after = world.engine.compiled[program]?.staticCost ?? 0;

    p.triggerId = saved.t;
    p.actionId = saved.a;
    p.modifierIds = saved.m;
    world.engine.recompile();
    return Math.max(0, before - after);
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
      chips.appendChild(chip(program.triggerId, 'trigger', i, 'trigger', this));
      for (let s = 0; s < LOADBEARING.modifierSlotsPerProgram; s++) {
        chips.appendChild(arrow());
        const id = program.modifierIds[s] ?? null;
        const group = document.createElement('span');
        group.className = 'slot-group';
        // Walk a modifier along the chain — §5.5's ordering axis, made operable.
        group.appendChild(
          slotButton('‹', s > 0 && id !== null, () => {
            world.engine.swapModifiers(i, s, s - 1);
            this.afterChange();
          }),
        );
        group.appendChild(chip(id, 'modifier', i, s, this));
        group.appendChild(
          slotButton('›', s < LOADBEARING.modifierSlotsPerProgram - 1 && id !== null, () => {
            world.engine.swapModifiers(i, s, s + 1);
            this.afterChange();
          }),
        );
        chips.appendChild(group);
      }
      chips.appendChild(arrow());
      chips.appendChild(chip(program.actionId, 'action', i, 'action', this));

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
          this.afterChange();
        }),
        button('v', i < world.engine.programs.length - 1, () => {
          world.engine.moveProgram(i, i + 1);
          this.afterChange();
        }),
        button(
          'SCRAP ROW',
          hasAnyNode(program),
          () => {
            this.pendingScrap = { program: i, slot: 'row' as unknown as number };
            this.render();
          },
          true,
        ),
      );

      row.append(idx, chips, stats, ops);
      panel.appendChild(row);

      if (this.pendingScrap?.program === i) panel.appendChild(this.confirmBar());
    });

    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent =
      'Modifiers apply left to right — use ‹ › to reorder them and watch the output multiplier change. ' +
      'Rows evaluate top to bottom. Scrapping is permanent and there is no undo. TAB to close.';
    panel.appendChild(hint);

    this.el.appendChild(panel);
  }

  /**
   * §19.6 requires a confirmation showing the refund and the permanent +4%
   * before a Scrap lands. The first pass scrapped on a bare chip click, with no
   * confirmation at all, on the same target you click to inspect a node — a
   * misclick destroyed part of your build irreversibly.
   */
  private confirmBar(): HTMLElement {
    const world = this.world!;
    const pending = this.pendingScrap!;
    const bar = document.createElement('div');
    bar.className = 'confirm';

    const isRow = (pending.slot as unknown as string) === 'row';
    const program = world.engine.programs[pending.program]!;

    let label: string;
    let nodes: number;
    if (isRow) {
      nodes =
        (program.triggerId ? 1 : 0) +
        (program.actionId ? 1 : 0) +
        program.modifierIds.filter(Boolean).length;
      label = `whole row (${nodes} node${nodes === 1 ? '' : 's'})`;
      } else {
      const id =
        pending.slot === 'trigger'
          ? program.triggerId
          : pending.slot === 'action'
            ? program.actionId
            : program.modifierIds[pending.slot as number];
      nodes = 1;
      label = NODE_BY_ID.get(id ?? '')?.name ?? String(id);
    }

    const refund = isRow
      ? (world.engine.compiled[pending.program]?.staticCost ?? 0)
      : this.refundFor(pending.program, pending.slot);

    const text = document.createElement('span');
    text.innerHTML =
      `SCRAP <b>${label}</b> from Program ${pending.program + 1}?` +
      `  <span class="gain">+${(nodes * 4).toFixed(0)}% permanent global output</span>` +
      `  ·  ${refund.toFixed(1)} Cycles freed  ·  <span class="warn">cannot be undone</span>`;

    const confirm = button('CONFIRM', true, () => {
      if (isRow) world.engine.scrapProgram(pending.program);
      else world.engine.scrapNode(pending.program, pending.slot);
      this.pendingScrap = null;
      this.afterChange();
    });
    confirm.className = 'danger';
    const cancel = button('CANCEL', true, () => {
      this.pendingScrap = null;
      this.render();
    });

    const ops = document.createElement('div');
    ops.className = 'ops';
    ops.append(confirm, cancel);
    bar.append(text, ops);
    return bar;
  }

  /** Called by chips: stage a scrap rather than performing one. */
  requestScrap(program: number, slot: 'trigger' | 'action' | number): void {
    this.pendingScrap = { program, slot };
    this.render();
  }

  private afterChange(): void {
    this.world?.syncBudget();
    this.render();
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

/**
 * A node chip. Clicking the chip itself does nothing destructive — it only
 * shows the node's description. Scrapping requires the small × and then an
 * explicit confirmation.
 */
function chip(
  nodeId: string | null,
  kind: 'trigger' | 'modifier' | 'action',
  programIndex: number,
  slot: 'trigger' | 'action' | number,
  editor: EditorOverlay,
): HTMLElement {
  const el = document.createElement('span');
  el.className = `chip ${kind}${nodeId ? '' : ' empty'}`;
  if (!nodeId) {
    el.textContent = kind === 'modifier' ? '—' : `no ${kind}`;
    return el;
  }
  const node = NODE_BY_ID.get(nodeId);
  const mult = MODIFIER_BY_ID.get(nodeId)?.cycleMult;

  const name = document.createElement('span');
  name.textContent = node ? `${node.name}${mult ? ` ×${mult}` : ''}` : nodeId;
  el.appendChild(name);
  el.title = node?.description ?? '';

  const kill = document.createElement('button');
  kill.className = 'chip-scrap';
  kill.textContent = '×';
  kill.title = 'Scrap this node (asks for confirmation)';
  kill.addEventListener('click', (ev) => {
    ev.stopPropagation();
    editor.requestScrap(programIndex, slot);
  });
  el.appendChild(kill);
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
