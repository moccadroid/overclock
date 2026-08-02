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
import { slotAccepts, type NodeSlot } from '../sim/engine';
import { renderResults } from './results';
import { renderPrimer } from './primer';

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
      // Same colour language as the editor chips, so a card's kind is legible
      // before you read a word of it.
      el.className = `card kind-${info.tag.toLowerCase()}`;
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
  if (card.kind === 'stat') return 'Applies immediately';
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
  private pendingScrap: { program: number; slot: NodeSlot } | null = null;
  private dragging: { program: number; slot: NodeSlot } | null = null;
  /** Transient explanation when a move is refused. */
  private notice: string | null = null;

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
      `<span>PIPELINE <span class="helphint">H for what these numbers mean</span></span>` +
      `<span>` +
      `<span title="Cycles permanently held by your live rows, out of the Cycles you generate each second">` +
      `RESERVED ${world.engine.staticLoad.toFixed(1)} of ${world.budget.capacity} CYCLES/s</span>` +
      `   <span title="Overdrawing your Cycles turns the shortfall into Heat">HEAT ${world.budget.heat.toFixed(0)}</span>` +
      `   <span title="Permanent output bonus earned by scrapping nodes">SCRAP +${(world.engine.scrapStacks * 4).toFixed(0)}%</span>` +
      `   KERNEL ×${world.engine.kernel.toFixed(2)}</span>`;
    panel.appendChild(head);

    // Column legend, so the row numbers are labelled where they are read.
    const legend = document.createElement('div');
    legend.className = 'legend';
    legend.innerHTML =
      `<span class="idx"></span><span class="chains">TRIGGER · MODIFIERS (left to right) · ACTION</span>` +
      `<span class="stats">share of output · cycles · damage · copies</span>` +
      `<span class="ops"></span>`;
    panel.appendChild(legend);

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
        // No flow arrows between slots: they were chevrons sitting next to the
        // move buttons' chevrons, two symbols with different meanings in the
        // same row. Adjacency already reads as sequence.
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
      chips.appendChild(chip(program.actionId, 'action', i, 'action', this));

      const stats = document.createElement('div');
      stats.className = 'stats';
      const share = totalEps > 0 ? (program.recentEvents / totalEps) * 100 : 0;
      if (compiled.live) {
        // One line, not four. The share bar carries the comparison between rows,
        // which is the thing you actually scan for; the numbers are detail.
        const shots = Math.round(compiled.ctx.count) * compiled.executions.length;
        const filled = Math.max(0, Math.min(8, Math.round(share / 12.5)));
        stats.innerHTML =
          `<span class="share"><span class="on">${'▮'.repeat(filled)}</span>` +
          `<span class="off">${'▮'.repeat(8 - filled)}</span></span>` +
          `<span class="pct">${share.toFixed(0)}%</span>` +
          `<span class="detail">${compiled.staticCost.toFixed(0)}c · ×${compiled.ctx.output.toFixed(2)} · ${shots}×</span>`;
        stats.title =
          `${compiled.staticCost.toFixed(1)} Cycles reserved while this row is live\n` +
          `×${compiled.ctx.output.toFixed(2)} damage multiplier from this modifier chain\n` +
          `${shots} instances of the Action per trigger\n` +
          `${share.toFixed(0)}% of your engine's total events per second`;
      } else {
        stats.innerHTML = `<span class="needs">needs a ${
          !program.triggerId && !program.actionId
            ? 'trigger + action'
            : program.triggerId
              ? 'action'
              : 'trigger'
        }</span>`;
      }

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

    if (this.notice) {
      const notice = document.createElement('div');
      notice.className = 'notice';
      notice.textContent = this.notice;
      panel.appendChild(notice);
    }

    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent =
      'Drag any node to any matching slot, in this row or another. Modifiers apply left to right — ' +
      'moving one changes the damage multiplier. Rows evaluate top to bottom. ' +
      'Scrapping is permanent and there is no undo. TAB to close.';
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
  requestScrap(program: number, slot: NodeSlot): void {
    this.pendingScrap = { program, slot };
    this.render();
  }

  // ---- drag to move a node anywhere it fits (§19.6) ----

  beginDrag(program: number, slot: NodeSlot): void {
    this.dragging = { program, slot };
    this.notice = null;
  }

  endDrag(): void {
    this.dragging = null;
  }

  /** Slots are typed, so only compatible targets should light up. */
  canDropOn(program: number, slot: NodeSlot): boolean {
    const world = this.world;
    const from = this.dragging;
    if (!world || !from) return false;
    if (from.program === program && from.slot === slot) return false;
    const moving = world.engine.read(from.program, from.slot);
    if (!moving || !slotAccepts(slot, moving)) return false;
    const displaced = world.engine.read(program, slot);
    return !displaced || slotAccepts(from.slot, displaced);
  }

  completeDrag(program: number, slot: NodeSlot): void {
    const world = this.world;
    const from = this.dragging;
    this.dragging = null;
    if (!world || !from) return;

    const result = world.engine.moveNode(
      from.program,
      from.slot,
      program,
      slot,
      world.budget.capacity,
    );
    if (result === 'over-capacity') {
      this.notice =
        'That move would reserve more Cycles than your capacity. ' +
        'Draft capacity, or scrap something first.';
    } else if (result === 'wrong-slot') {
      this.notice = 'Triggers, modifiers and actions each have their own slots.';
    }
    this.afterChange();
  }

  private afterChange(): void {
    this.world?.syncBudget();
    this.render();
  }

}

function hasAnyNode(program: { triggerId: string | null; actionId: string | null; modifierIds: (string | null)[] }): boolean {
  return Boolean(program.triggerId || program.actionId || program.modifierIds.some(Boolean));
}

/**
 * A node chip, and also a drop target for its slot.
 *
 * Every slot accepts a drag — including empty ones and ones in other rows — so a
 * node can be moved anywhere it legally fits (§19.6). Clicking the chip does
 * nothing destructive; scrapping needs the × and then a confirmation.
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
  el.dataset['program'] = String(programIndex);
  el.dataset['slot'] = String(slot);

  if (nodeId) {
    const node = NODE_BY_ID.get(nodeId);
    const mult = MODIFIER_BY_ID.get(nodeId)?.cycleMult;
    const name = document.createElement('span');
    name.textContent = node ? `${node.name}${mult ? ` ×${mult}` : ''}` : nodeId;
    el.appendChild(name);
    el.title = `${node?.description ?? ''}\n\nDrag to move it anywhere it fits.`;

    el.draggable = true;
    el.addEventListener('dragstart', (ev) => {
      el.classList.add('dragging');
      editor.beginDrag(programIndex, slot);
      ev.dataTransfer?.setData('text/plain', nodeId);
      if (ev.dataTransfer) ev.dataTransfer.effectAllowed = 'move';
    });
    el.addEventListener('dragend', () => {
      el.classList.remove('dragging');
      editor.endDrag();
    });

    const kill = document.createElement('button');
    kill.className = 'chip-scrap';
    kill.textContent = '×';
    kill.title = 'Scrap this node (asks for confirmation)';
    kill.addEventListener('click', (ev) => {
      ev.stopPropagation();
      editor.requestScrap(programIndex, slot);
    });
    el.appendChild(kill);
  } else {
    el.textContent = kind === 'modifier' ? '—' : `no ${kind}`;
  }

  el.addEventListener('dragover', (ev) => {
    if (!editor.canDropOn(programIndex, slot)) return;
    ev.preventDefault();
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move';
    el.classList.add('drop-ok');
  });
  el.addEventListener('dragleave', () => el.classList.remove('drop-ok'));
  el.addEventListener('drop', (ev) => {
    ev.preventDefault();
    el.classList.remove('drop-ok');
    editor.completeDrag(programIndex, slot);
  });

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

  /** The primer — what the numbers mean. Opened with H at any time. */
  showPrimer(): void {
    this.el.replaceChildren();
    const panel = document.createElement('div');
    panel.className = 'panel primer-panel';
    panel.innerHTML = renderPrimer();
    this.el.appendChild(panel);
    this.setOpen(true);
  }

  /** §14 — the Results screen, with the run-trace chart as its hero element. */
  showResults(world: World): void {
    this.el.replaceChildren();
    const panel = document.createElement('div');
    panel.className = 'panel results-panel';
    panel.innerHTML = renderResults(world);
    this.el.appendChild(panel);
    this.setOpen(true);
  }

  hide(): void {
    this.setOpen(false);
  }
}

/**
 * §19.7 — the Recompile ceremony. "A full-screen 2s ceremony (skippable never —
 * this is a ritual): the schematic burns down row by row, Kernel forged, rebuild
 * surge begins." The one moment of grandeur in an otherwise dry UI.
 */
export class CeremonyOverlay extends Overlay {
  private timer = 0;
  private rows: string[] = [];
  private kernelPercent = 0;
  private kernelTotal = 1;

  constructor(root: HTMLElement) {
    super(root, 'ceremony');
  }

  /** Call with the Engine as it stood *before* the Recompile deleted it. */
  begin(rows: string[], kernelPercent: number, kernelTotal: number): void {
    this.rows = rows;
    this.kernelPercent = kernelPercent;
    this.kernelTotal = kernelTotal;
    this.timer = 0;
    this.setOpen(true);
    this.paint();
  }

  /** Returns true while the ceremony is still running. */
  update(dt: number): boolean {
    if (!this.open) return false;
    this.timer += dt;
    if (this.timer >= CEREMONY_SECONDS) {
      this.setOpen(false);
      return false;
    }
    this.paint();
    return true;
  }

  private paint(): void {
    const burn = Math.min(1, this.timer / (CEREMONY_SECONDS * 0.55));
    const burned = Math.floor(burn * this.rows.length);
    const forged = this.timer > CEREMONY_SECONDS * 0.6;

    const rows = this.rows
      .map((row, i) => `<div class="burn ${i < burned ? 'gone' : ''}">${row}</div>`)
      .join('');

    this.el.innerHTML =
      `<div class="ceremony-inner">` +
      `<div class="title">RECOMPILE</div>` +
      `<div class="rows">${rows}</div>` +
      (forged
        ? `<div class="kernel">KERNEL FORGED  +${this.kernelPercent.toFixed(0)}%` +
          `<span class="total">total ×${this.kernelTotal.toFixed(2)}</span></div>` +
          `<div class="surge">REBUILD SURGE — double XP, wider drafts</div>`
        : `<div class="kernel dim">measuring output…</div>`) +
      `</div>`;
  }
}

export const CEREMONY_SECONDS = 2;

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
