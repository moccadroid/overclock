/**
 * The draft. GDD §19.5, NARRATIVE §14.
 *
 * **Three cards, side by side — it is a draw, and it has to read as one.** The
 * layout is the DOM overlay's, which play already proved: tag, name, body,
 * where-it-lands, the key that takes it, the tools that price it, a reroll
 * rail underneath. What changed is the dialect: paper frames, the column grid,
 * the kind inks — the same vocabulary as every sheet in the game, drawn into
 * the run's own renderer.
 *
 * The quiet second reading survives the layout: the header line says whose
 * requests these are. Approving one is the job the player was told to refuse.
 *
 * Same public surface as the overlay it replaces, because the recorder, the
 * corpus and the tests all watch a decision through it: `present` keeps a
 * deferred offer, `currentOffer` is read-only and already rolled, `onCommand`
 * fires before `applyDraft`.
 */
import { Container, Graphics, Rectangle, Text } from 'pixi.js';
import {
  applyDraft,
  canReroll,
  describeCard,
  lockCard,
  purgeCard,
  rerollCost,
  rollDraft,
  useReroll,
  type DraftCard,
  type DraftOffer,
} from '../../sim/draft';
import type { Command } from '../../sim/record';
import type { World } from '../../sim/world';
import { NODE_BY_ID } from '../../content/index';
import { TAG_GLYPH } from '../../sim/engine';
import { TUNABLE } from '../../sim/tunables';
import { C, Grid, LINE, SIZE, blank, charW, style, wrap, type Line } from '../ui';

/** One card's text, in columns; the draw is three of these plus gaps. */
const CARD_COLS = 30;
const CARD_GAP = 24;
const PAD = 14;
/** Text rows a card holds: tag, name, rule, body ×5, rule, slot ×2. */
const CARD_TEXT_ROWS = 11;

const KIND_INK: Record<string, number> = {
  TRIGGER: C.trigger,
  MODIFIER: C.modifier,
  ACTION: C.action,
};

function previewSlot(world: World, card: DraftCard): string {
  if (card.kind === 'capacity') {
    return `Cycles ${world.budget.capacity} -> ${world.budget.capacity + card.amount}`;
  }
  if (card.kind === 'program_slot') {
    return `Programs ${world.engine.programs.length} -> ${world.engine.programs.length + 1}`;
  }
  if (card.kind === 'stat') return 'Applies immediately';
  if (card.kind === 'tool') {
    return card.tool === 'reroll'
      ? `Rerolls ${world.rerolls} -> ${world.rerolls + TUNABLE.rerollCardAmount}`
      : `Purges ${world.purges} -> ${world.purges + TUNABLE.purgeCardAmount}`;
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

/**
 * One card of the draw: a framed slip with its own grid and its own tools.
 * Chrome only — the DraftSheet owns what it says and what choosing it does.
 */
class CardPanel {
  readonly view = new Container();
  private readonly chrome = new Graphics();
  private readonly grid = new Grid();
  private hovered = false;

  readonly width: number;
  readonly height: number;

  constructor(
    lines: Line[],
    keyHint: string,
    private readonly accent: number,
    onPick: () => void,
    buttons: { label: string; onPress: () => void }[],
    /** The two things being read: the kind, small, and the name, large. */
    heading?: { tag: string; name: string; marks: string },
  ) {
    this.width = Math.round(CARD_COLS * charW()) + PAD * 2;
    // Constant, tools or not: a draw's cards are the same size or it stops
    // reading as a draw — and everything laid out under the row measures the
    // first card, so a short one would put the rail inside its neighbours.
    this.height = PAD + (heading ? LINE * 2 + 6 : 0) + CARD_TEXT_ROWS * LINE + LINE + 20 + PAD;

    this.view.addChild(this.chrome);

    // The heading is drawn, not gridded: the card's name is the thing being
    // read and wants to be *bigger* than body type, which a monospace line
    // grid cannot express. The kind is already carried by the spine and the
    // colour, so its word shrinks to a label — you do not need to be told
    // TRIGGER in the same size as the name of the trigger.
    if (heading) {
      const tag = new Text({ text: heading.tag, style: style(9, this.accent, 3) });
      tag.position.set(PAD, PAD);
      this.view.addChild(tag);
      if (heading.marks) {
        const marks = new Text({ text: heading.marks, style: style(9, C.dim, 2) });
        marks.position.set(PAD + tag.width + 8, PAD);
        this.view.addChild(marks);
      }
      const name = new Text({ text: heading.name, style: style(17, C.bright, 1) });
      name.position.set(PAD, PAD + LINE - 2);
      this.view.addChild(name);
    }

    this.grid.set(lines);
    this.grid.view.position.set(PAD, PAD + (heading ? LINE * 2 + 6 : 0));
    this.view.addChild(this.grid.view);

    // The key that takes it, bottom corner — the one glyph a draw needs.
    const key = new Text({ text: keyHint, style: style(SIZE, C.faint, 2) });
    key.position.set(PAD, this.height - PAD - LINE + 4);
    this.view.addChild(key);

    let bx = this.width - PAD;
    for (const b of [...buttons].reverse()) {
      const btn = new SmallButton(b.label, b.onPress);
      bx -= btn.width;
      btn.view.position.set(bx, this.height - PAD - btn.height + 2);
      this.view.addChild(btn.view);
      bx -= 8;
    }

    this.view.eventMode = 'static';
    this.view.cursor = 'pointer';
    this.view.hitArea = new Rectangle(0, 0, this.width, this.height);
    this.view.on('pointerover', () => {
      this.hovered = true;
      this.paint();
    });
    this.view.on('pointerout', () => {
      this.hovered = false;
      this.paint();
    });
    this.view.on('pointertap', onPick);
    this.paint();
  }

  private paint(): void {
    const edge = this.hovered ? this.accent : C.paper;
    const alpha = this.hovered ? 1 : 0.8;
    this.chrome
      .clear()
      .rect(0, 0, this.width, this.height)
      .fill({ color: 0x05070c, alpha: 0.97 })
      .rect(0, 0, this.width, 1)
      .fill({ color: edge, alpha })
      .rect(0, this.height - 1, this.width, 1)
      .fill({ color: edge, alpha })
      .rect(0, 0, 1, this.height)
      .fill({ color: edge, alpha })
      .rect(this.width - 1, 0, 1, this.height)
      .fill({ color: edge, alpha })
      // The kind, as a spine: a 2px accent down the left edge, the same ink as
      // the tag. Legible from across the room, like the editor's chips.
      .rect(0, 0, 2, this.height)
      .fill(this.accent);
  }

  destroy(): void {
    this.view.destroy({ children: true });
  }
}

/** A button sized to its label — the card tools are smaller than sheet buttons. */
class SmallButton {
  readonly view = new Container();
  readonly width: number;
  readonly height = LINE + 8;
  private readonly box = new Graphics();
  private readonly text: Text;
  private hovered = false;

  constructor(label: string, onPress: () => void) {
    this.text = new Text({ text: label, style: style(11, C.ink, 2) });
    this.width = Math.ceil(this.text.width) + 16;
    this.text.position.set(
      Math.round((this.width - this.text.width) / 2),
      Math.round((this.height - this.text.height) / 2),
    );
    this.view.addChild(this.box, this.text);
    this.view.eventMode = 'static';
    this.view.cursor = 'pointer';
    this.view.hitArea = new Rectangle(0, 0, this.width, this.height);
    this.view.on('pointerover', () => {
      this.hovered = true;
      this.paint();
    });
    this.view.on('pointerout', () => {
      this.hovered = false;
      this.paint();
    });
    this.view.on('pointertap', (ev) => {
      ev.stopPropagation();
      onPress();
    });
    this.paint();
  }

  private paint(): void {
    this.box.clear();
    if (this.hovered) {
      this.box.rect(0, 0, this.width, this.height).fill(C.bar);
    } else {
      this.box.rect(0, 0, this.width, 1).fill(C.rule);
      this.box.rect(0, this.height - 1, this.width, 1).fill(C.rule);
      this.box.rect(0, 0, 1, this.height).fill(C.rule);
      this.box.rect(this.width - 1, 0, 1, this.height).fill(C.rule);
    }
    this.text.style = style(11, this.hovered ? C.barInk : C.ink, 2);
  }
}

export class DraftSheet {
  readonly view = new Container();

  private offer: DraftOffer | null = null;
  private onDone: (() => void) | null = null;
  private world: World | null = null;

  private readonly veil = new Graphics();
  private readonly board = new Container();
  private cards: CardPanel[] = [];

  /** §14 — tell the recorder what was decided. Indices, never cards. */
  onCommand: ((c: Command) => void) | null = null;

  constructor(stage: Container) {
    this.view.visible = false;
    this.view.addChild(this.veil, this.board);
    stage.addChild(this.view);
    window.addEventListener('resize', () => this.layout());
  }

  get open(): boolean {
    return this.view.visible;
  }

  /** Kept for the death path, which slams every surface shut. */
  setOpen(open: boolean): void {
    if (!open) this.teardown();
    this.view.visible = open;
  }

  /**
   * A draft you deferred is the *same* draft when you come back to it. Rolling
   * fresh on every present() would make ESC a free infinite reroll — the §8.3
   * economy's oldest failure mode.
   */
  present(world: World, onDone: () => void): void {
    this.world = world;
    this.onDone = onDone;
    if (!this.offer) this.offer = rollDraft(world);
    this.render();
    this.view.visible = true;
  }

  /** Close without resolving. The offer is kept for when it reopens. */
  defer(): void {
    this.view.visible = false;
  }

  /**
   * The offer currently on the table, for anything watching a decision.
   * Read-only and already rolled — an observer that re-rolled to look would
   * consume an Rng draw and change the run.
   */
  get currentOffer(): DraftOffer | null {
    return this.offer;
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
    this.onCommand?.({ k: 'reroll' });
    this.offer = rollDraft(this.world);
    this.render();
  }

  private choose(card: DraftCard): void {
    if (!this.world) return;
    const index = this.offer?.cards.indexOf(card) ?? -1;
    if (index >= 0) this.onCommand?.({ k: 'draft', i: index });
    applyDraft(this.world, card);
    this.teardown();
    this.view.visible = false;
    this.offer = null;
    this.onDone?.();
  }

  private purge(card: DraftCard, index: number): void {
    if (!this.world) return;
    if (purgeCard(this.world, card)) {
      this.onCommand?.({ k: 'purge', i: index });
      this.offer = rollDraft(this.world);
      this.render();
    }
  }

  private lock(card: DraftCard, index: number): void {
    if (!this.world) return;
    if (lockCard(this.world, card)) {
      this.onCommand?.({ k: 'lock', i: index });
      this.render();
    }
  }

  private teardown(): void {
    for (const c of this.cards) c.destroy();
    this.cards = [];
    this.board.removeChildren().forEach((c) => c.destroy({ children: true }));
  }

  /** The body of a card. The tag and name are drawn by the panel, larger. */
  private cardLines(world: World, card: DraftCard): Line[] {
    const info = describeCard(card);
    const lines: Line[] = [blank()];
    for (const l of wrap(info.body, CARD_COLS).slice(0, 5)) lines.push([[l, C.ink]]);
    while (lines.length < CARD_TEXT_ROWS - 3) lines.push(blank());
    lines.push(blank());
    for (const l of wrap(previewSlot(world, card), CARD_COLS).slice(0, 1)) {
      lines.push([[l, C.faint]]);
    }
    return lines;
  }

  private render(): void {
    const world = this.world;
    const offer = this.offer;
    if (!world || !offer) return;
    this.teardown();

    // The header says whose requests these are. §14 — nothing else has to.
    const title = new Text({
      text: 'BUILD REQUEST — extensions requested by the process. approve at most one.',
      style: style(11, C.dim, 3),
    });
    this.board.addChild(title);

    const price = rerollCost(world);
    this.cards = offer.cards.map((card, i) => {
      const info = describeCard(card);
      const tools: { label: string; onPress: () => void }[] = [];
      if (card.kind === 'node' && world.purges > 0) {
        tools.push({
          label: `PURGE +${(4 * (1 + world.bonuses.salvage)).toFixed(0)}%`,
          onPress: () => this.purge(card, i),
        });
      }
      if (card.kind === 'node' && canReroll(world)) {
        tools.push({
          label: price > 0 ? `LOCK ${price}H` : 'LOCK',
          onPress: () => this.lock(card, i),
        });
      }
      const panel = new CardPanel(
        this.cardLines(world, card),
        `[${i + 1}]`,
        KIND_INK[info.tag] ?? C.paper,
        () => this.choose(card),
        tools,
        {
          tag: info.tag,
          name: info.title,
          marks: (info.tags ?? []).map((t) => TAG_GLYPH[t]).join(' '),
        },
      );
      this.board.addChild(panel.view);
      return panel;
    });

    // The rail: the reroll is a control, the rest is standing information.
    const rail = new SmallButton(
      price > 0 ? `REROLL [R] — ${price} HEAT` : `REROLL [R] ×${world.rerolls} free`,
      () => this.reroll(),
    );
    this.board.addChild(rail.view);
    const rest = new Text({
      text: `PICK [1] [2] [3]      queued ${world.pendingDrafts}      purges ×${world.purges}`,
      style: style(11, C.faint, 3),
    });
    this.board.addChild(rest);

    this.layout();
  }

  layout(): void {
    if (this.cards.length === 0) return;
    const W = window.innerWidth;
    const H = window.innerHeight;
    this.veil.clear().rect(0, 0, W, H).fill({ color: 0x000000, alpha: 0.72 });

    const card = this.cards[0]!;
    const total = this.cards.length * card.width + (this.cards.length - 1) * CARD_GAP;
    const left = Math.round((W - total) / 2);
    const top = Math.round((H - card.height) / 2);

    const children = this.board.children;
    // [title, ...cards, rail, rest] — positioned, not flowed; a draw is a hand
    // of cards on a table, not a paragraph.
    const title = children[0]!;
    title.position.set(left, top - LINE * 2);
    this.cards.forEach((c, i) => c.view.position.set(left + i * (c.width + CARD_GAP), top));
    const rail = children[children.length - 2]!;
    const rest = children[children.length - 1]!;
    rail.position.set(left, top + card.height + 18);
    rest.position.set(left + 220, top + card.height + 24);
  }
}
