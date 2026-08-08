/**
 * The file explorer. An actual one.
 *
 * This was a list of text rows with an invisible control laid over it, and it was
 * the wrong shape twice: it did not look like a place where files live, and the
 * text on it competed with the control underneath for every click.
 *
 * So it is icons, and they work exactly the way the desktop's icons work — a
 * filled tile that draws itself, carries its own hit area, lights on hover, and
 * opens on one click. That is not a coincidence or a copy: a file on a desk and a
 * file in a drawer are the same object, and the thing that made the desktop icons
 * reliable is the thing this needed.
 *
 * ---
 *
 * **Folders are tabs, not headings.** Four drawers along the top and the contents
 * of one below. A heading in a scrolling list means the count of things you cannot
 * read is a number you have to go and find; a tab means `RESTRICTED/ 3` is visible
 * from the moment the window opens, and stays visible as it shrinks.
 *
 * The restricted drawer is the plot: references in the clear, titles under bars of
 * honest width, and nothing in it opens. See `filetree.ts` for why the width is
 * public and the words are not.
 */
import { Container, Graphics, Rectangle, Text } from 'pixi.js';
import { C, charW, style } from '../ui';
import { FOLDERS, filename, type Entry, type Folder } from './filetree';

/** Tile metrics, in pixels. A document icon is smaller than a desktop one. */
const TILE_W = 132;
const TILE_H = 74;
const GAP_X = 6;
const GAP_Y = 4;
/** The tab strip's height, and the first row of tiles under it. */
const TABS_H = 30;
const BODY_TOP = TABS_H + 14;

export class Explorer {
  readonly view = new Container();

  private readonly tabs = new Container();
  private readonly tiles = new Container();

  private folder: Folder = 'OPERATOR';
  private entries: readonly Entry[] = [];
  private w = 0;

  /** One click on a file that can be opened. */
  onOpen: ((entry: Entry) => void) | null = null;
  /** One click on a file that cannot. */
  onRefused: ((entry: Entry) => void) | null = null;
  /** The pointer left a tile with the button down — the desk may pick it up. */
  onDragOut: ((entry: Entry) => void) | null = null;

  constructor() {
    this.view.addChild(this.tabs, this.tiles);
  }

  get current(): Folder {
    return this.folder;
  }

  setEntries(entries: readonly Entry[]): void {
    this.entries = entries;
    this.paint();
  }

  /** The area the explorer has, inside the window's content box. */
  resize(w: number, _h: number): void {
    this.w = w;
    this.paint();
  }

  /** How many columns of tiles fit, and therefore how the grid wraps. */
  private get columns(): number {
    return Math.max(1, Math.floor((this.w + GAP_X) / (TILE_W + GAP_X)));
  }

  /** Rows the current drawer needs, so the window can be sized to hold them. */
  rowsNeeded(): number {
    const n = this.entries.filter((e) => e.folder === this.folder).length;
    return Math.max(1, Math.ceil(n / this.columns));
  }

  private paint(): void {
    this.paintTabs();
    this.paintTiles();
  }

  private paintTabs(): void {
    for (const c of this.tabs.removeChildren()) c.destroy();
    let x = 0;
    for (const folder of FOLDERS) {
      const n = this.entries.filter((e) => e.folder === folder).length;
      const on = folder === this.folder;
      const label = new Text({
        text: `${folder}  ${n}`,
        style: style(10, on ? C.bright : C.dim, 3),
      });
      label.eventMode = 'none';
      const tw = Math.round(label.width) + 22;

      const g = new Graphics();
      g.rect(x, 0, tw, TABS_H - 6).fill({ color: on ? C.paper : C.void, alpha: on ? 0.13 : 0.6 });
      g.rect(x, 0, tw, 1).fill(on ? C.paper : C.rule);
      g.rect(x, 0, 1, TABS_H - 6).fill(on ? C.paper : C.rule);
      g.rect(x + tw - 1, 0, 1, TABS_H - 6).fill(on ? C.paper : C.rule);
      // Open at the bottom when selected: the tab and its contents are one thing.
      if (!on) g.rect(x, TABS_H - 7, tw, 1).fill(C.rule);
      g.eventMode = 'static';
      g.cursor = 'pointer';
      g.hitArea = new Rectangle(x, 0, tw, TABS_H - 6);
      g.on('pointertap', () => {
        this.folder = folder;
        this.paint();
      });
      label.position.set(x + 11, Math.round((TABS_H - 6 - 12) / 2));
      this.tabs.addChild(g, label);
      x += tw + 4;
    }
    // The rule the selected tab sits on, running the width of the window.
    const line = new Graphics();
    line.rect(0, TABS_H - 7, this.w, 1).fill(C.rule);
    this.tabs.addChildAt(line, 0);
  }

  private paintTiles(): void {
    for (const c of this.tiles.removeChildren()) c.destroy();
    const shown = this.entries.filter((e) => e.folder === this.folder);
    const cols = this.columns;

    if (shown.length === 0) {
      const empty = new Text({ text: 'this drawer is empty', style: style(11, C.faint, 3) });
      empty.eventMode = 'none';
      empty.position.set(2, BODY_TOP);
      this.tiles.addChild(empty);
      return;
    }

    for (let i = 0; i < shown.length; i++) {
      const e = shown[i]!;
      const col = i % cols;
      const row = Math.floor(i / cols);
      const x = col * (TILE_W + GAP_X);
      const y = BODY_TOP + row * (TILE_H + GAP_Y);
      this.tiles.addChild(...this.tile(e, x, y));
    }
  }

  /** One file, as a tile. Icon, reference, and a bar where a title is withheld. */
  private tile(e: Entry, x: number, y: number): Container[] {
    const g = new Graphics();
    const area = new Rectangle(x, y, TILE_W, TILE_H);

    // The filename leads and the reference sits under it. The reference cannot
    // be dropped: the prose cites it ("withheld per OC-0061 clause 3"), so it has
    // to be findable in the drawer.
    const name = filename(e);
    const room = Math.max(8, Math.floor((TILE_W - 6) / charW()));
    const shown = name.length > room ? `${name.slice(0, room - 1)}…` : name;

    const label = e.locked ? null : new Text({ text: shown, style: style(10, C.ink, 0) });
    if (label) {
      label.eventMode = 'none';
      label.anchor.set(0.5, 0);
      label.position.set(x + TILE_W / 2, y + 40);
    }

    const ref = new Text({ text: e.ref, style: style(9, e.locked ? C.faint : C.dim, 2) });
    ref.eventMode = 'none';
    ref.anchor.set(0.5, 0);
    ref.position.set(x + TILE_W / 2, y + (e.locked ? 40 : 56));
    const paint = (hover: boolean): void => {
      g.clear();
      g.rect(x, y, TILE_W, TILE_H).fill({
        color: C.paper,
        alpha: hover && !e.locked ? 0.1 : 0.02,
      });
      if (hover && !e.locked) {
        g.rect(x, y, TILE_W, 1).fill(C.faint);
        g.rect(x, y + TILE_H - 1, TILE_W, 1).fill(C.faint);
        g.rect(x, y, 1, TILE_H).fill(C.faint);
        g.rect(x + TILE_W - 1, y, 1, TILE_H).fill(C.faint);
      }
      drawDocument(g, x + TILE_W / 2 - 11, y + 6, e.locked, e.unread);
      ref.style = style(9, e.locked ? C.faint : hover ? C.ink : C.dim, 2);
      if (label) label.style = style(10, hover ? C.bright : C.ink, 0);
      // The withheld title, as a bar of honest width, drawn to the tile.
      if (e.locked) {
        const barW = Math.min(TILE_W - 14, Math.round(e.title.length * charW() * 0.5));
        g.rect(x + (TILE_W - barW) / 2, y + 56, barW, 9).fill(C.bar);
      }
    };
    paint(false);

    g.eventMode = 'static';
    g.cursor = e.locked ? 'not-allowed' : 'pointer';
    g.hitArea = area;
    g.on('pointerover', () => paint(true));
    g.on('pointerout', () => {
      paint(false);
      if (this.pressed === e.ref) {
        this.pressed = null;
        if (!e.locked) this.onDragOut?.(e);
      }
    });
    g.on('pointerdown', () => {
      this.pressed = e.ref;
    });
    g.on('pointerupoutside', () => {
      this.pressed = null;
    });
    g.on('pointertap', () => {
      this.pressed = null;
      if (e.locked) this.onRefused?.(e);
      else this.onOpen?.(e);
    });

    return label ? [g, label, ref] : [g, ref];
  }

  private pressed: string | null = null;

  destroy(): void {
    this.view.destroy({ children: true });
  }
}

/**
 * A document: a page with its corner turned, in axis-aligned rectangles.
 *
 * The turned corner is the whole of "this is a piece of paper" and it is four
 * lines. A locked one is drawn in the furniture value and gets a bar across its
 * middle instead of ruled lines, so a drawer of withheld files reads as a block of
 * censorship at a glance rather than as a list you have to read.
 */
function drawDocument(g: Graphics, x: number, y: number, locked: boolean, unread: boolean): void {
  const ink = locked ? C.faint : C.paper;
  const w = 22;
  const h = 28;
  const fold = 7;

  g.rect(x, y, w - fold, 1).fill(ink);
  g.rect(x, y, 1, h).fill(ink);
  g.rect(x, y + h - 1, w, 1).fill(ink);
  g.rect(x + w - 1, y + fold, 1, h - fold).fill(ink);
  // The fold, stepped by hand: a stroked diagonal at this size is a smudge.
  for (let i = 0; i < fold; i++) g.rect(x + w - fold + i, y + i, 1, 1).fill(ink);

  if (locked) {
    g.rect(x + 4, y + 12, w - 8, 5).fill(C.bar);
    return;
  }
  // Ruled lines, so it reads as written on.
  for (let i = 0; i < 4; i++) g.rect(x + 4, y + 10 + i * 4, w - 9, 1).fill(C.rule);
  if (unread) g.rect(x + w - 4, y - 2, 4, 4).fill(C.thermal);
}
