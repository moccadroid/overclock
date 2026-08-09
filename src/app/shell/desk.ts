/**
 * The desk. The between-run surface, as a place rather than a menu.
 *
 * A run ends and you are back at your workstation: the shift clock has moved and
 * a file has arrived in `OPERATOR/`.
 *
 * **Not yet: the windows are not where you left them.** A desktop that reopens in
 * its authored positions every time is a screenshot of a desktop, and persisting
 * the layout is most of what makes it *yours* — but it is not built, and this
 * comment described it for a while as though it were.
 *
 * Four windows, and no more, because a window manager is a project and this is a
 * game with a window manager in it:
 *
 *   `OC-1147-F`  **FILES** — the explorer. The document ladder, filed.
 *   `OC-1147-R`  **READER** — one document. Several may be open at once, which is
 *                the entire argument for a desktop over a menu.
 *   `OC-1147-A`  **SHIFT** — the operations order. The commitment point.
 *   `OC-0301-S`  **CONFIG** — the control panel.
 *
 * The content is not new. `panes.ts` already generates every one of these as
 * `Line[]`, which is why this file is layout and routing and nothing else: the
 * documents were always decoupled from the surface that displayed them, and this
 * is the surface changing.
 */
import { Container, Graphics, Rectangle, Text } from 'pixi.js';
import type { AxiomDef } from '../../sim/types';
import type { Audio } from '../../audio/audio';
import type { Library } from '../../meta/profile';
import type { StoryStore } from '../../story/store';
import { AXIOMS } from '../../content/index';
import {
  Button,
  C,
  Desktop,
  LINE,
  Rows,
  Win,
  charW,
  horizontal,
  style,
  vertical,
  type DesktopState,
  type Line,
} from '../ui';
import {
  CONFIG_ROW,
  CONFIG_SHEET,
  MUSIC_ROW,
  MUSIC_SHEET,
  musicLines,
  type MusicEntry,
  configFields,
  configLines,
  fileBody,
  filesFor,
  type ConfigField,
} from './panes';
import { classificationOf, filename, tree, type Entry } from './filetree';
import { Explorer } from './explorer';
import { rungOf } from '../../story/arc';
import { SCORES } from '../../audio/score';
import { BEGIN_LABEL, ORDER_SHEET, orderCols, orderLines, orderRows } from './order';
import { adjustSetting } from './settings';

export interface DeskResult {
  seed: string;
  axiomId: string;
}

/**
 * The three things on the desk, as icons.
 *
 * Rectangles and one triangle, at 30 pixels. Anything more becomes an
 * illustration, and this dialect does not have illustrations in it — the ruins
 * are drawn out of axis-aligned blocks and so is the furniture.
 *
 * `shift` is a **door**, not a play triangle. The play triangle was the obvious
 * choice and it is wrong twice: it says "media" on a machine that predates
 * media, and it describes the button rather than the thing. A shift is where the
 * operator physically goes — through a doorway, into the site — and a doorway
 * with something moving into it is the one picture that says both "begin" and
 * "leave the desk". The arrow inside it is what keeps it legible as an action.
 */
type Glyph = 'folder' | 'shift' | 'cog' | 'speaker';

function drawGlyph(g: Graphics, kind: Glyph, x: number, y: number): void {
  const ink = C.paper;
  if (kind === 'folder') {
    g.rect(x, y + 6, 30, 22).fill({ color: 0x080b12, alpha: 1 });
    g.rect(x, y + 6, 30, 1).fill(ink);
    g.rect(x, y + 27, 30, 1).fill(ink);
    g.rect(x, y + 6, 1, 22).fill(ink);
    g.rect(x + 29, y + 6, 1, 22).fill(ink);
    g.rect(x + 4, y + 2, 12, 4).fill(ink);
    return;
  }

  if (kind === 'speaker') {
    // A cabinet and a cone, in three rectangles and a triangle. The obvious
    // glyph is a quaver, and it is wrong for the same reason the play triangle
    // was wrong for SHIFT: this machine predates the icon. A speaker is a piece
    // of furniture, which is what everything else on this desk is.
    g.rect(x + 4, y + 3, 13, 24).fill({ color: 0x080b12, alpha: 1 });
    g.rect(x + 4, y + 3, 13, 1).fill(ink);
    g.rect(x + 4, y + 26, 13, 1).fill(ink);
    g.rect(x + 4, y + 3, 1, 24).fill(ink);
    g.rect(x + 16, y + 3, 1, 24).fill(ink);
    g.circle(x + 10, y + 11, 3).stroke({ color: ink, width: 1 });
    g.circle(x + 10, y + 20, 1.5).stroke({ color: ink, width: 1 });
    // Two arcs of output, as stepped blocks — no curves in this dialect.
    g.rect(x + 21, y + 12, 1, 6).fill(ink);
    g.rect(x + 24, y + 9, 1, 12).fill(ink);
    return;
  }

  if (kind === 'shift') {
    // The jambs and the lintel — three sides, open at the bottom, because a
    // doorway you walk out of has no threshold drawn across it.
    g.rect(x + 3, y + 2, 1, 26).fill(ink);
    g.rect(x + 23, y + 2, 1, 26).fill(ink);
    g.rect(x + 3, y + 2, 21, 1).fill(ink);
    // Into it.
    g.moveTo(x + 10, y + 11).lineTo(x + 18, y + 16).lineTo(x + 10, y + 21).fill(ink);
    return;
  }

  // The cog: a ring with four teeth on the axes. Eight teeth at this size is
  // mud, and a circle with a hole in it already reads as a setting.
  const cx = x + 14;
  const cy = y + 15;
  g.circle(cx, cy, 10).stroke({ color: ink, width: 1 });
  g.circle(cx, cy, 3.5).stroke({ color: ink, width: 1 });
  for (const [dx, dy] of [
    [0, -1],
    [0, 1],
    [-1, 0],
    [1, 0],
  ] as const) {
    g.rect(cx + dx * 11 - (dx ? 1.5 : 3), cy + dy * 11 - (dy ? 1.5 : 3), dx ? 4 : 6, dy ? 4 : 6).fill(
      ink,
    );
  }
}

/** Window ids. Stable, so a saved layout could key on them — see PARTIAL.md;
 *  the layout is not persisted yet, and this comment used to claim it was. */
const W_FILES = 'files';
const W_SHIFT = 'shift';
const W_CONFIG = 'config';
const W_MUSIC = 'music';
const readerId = (ref: string): string => `read:${ref}`;

/** Every reader shares one size, under this key. */
const W_READER = 'reader';

/**
 * The sizes and homes the desk *wants*, in characters and lines.
 *
 * Ceilings, not values — `fitToViewport` takes the smaller of these and what the
 * viewport can hold. FILES is 70 wide because that is the longest title in the
 * ladder plus its reference and the unread mark; at 60 it was cut off by the
 * window's own mask.
 */
const WANT: Record<string, { cols: number; rows: number }> = {
  [W_FILES]: { cols: 70, rows: 24 },
  [W_SHIFT]: { cols: 62, rows: 22 },
  [W_CONFIG]: { cols: 52, rows: 18 },
  [W_MUSIC]: { cols: 78, rows: 28 },
  [W_READER]: { cols: 72, rows: 26 },
};

export class Desk {
  readonly view = new Container();
  private readonly desktop: Desktop;
  private readonly icons = new Container();

  /** Which files have ever been opened. Drives the unread mark. */
  private readonly seen = new Set<string>();
  private entries: Entry[] = [];
  private fileCursor = 0;
  private explorer: Explorer | null = null;
  /** The reference of the last locked file somebody tried to open. */
  private withheld: string | null = null;

  /** Per-reader scroll offsets, keyed by window id. */
  private readonly scroll = new Map<string, number>();
  /** What `fitToViewport` decided. Seeded with the ceilings. */
  private readonly sizes = new Map<string, { cols: number; rows: number }>(
    Object.entries(WANT).map(([k, v]) => [k, { ...v }]),
  );
  private readonly homes = new Map<string, { x: number; y: number }>([
    [W_FILES, { x: 96, y: 96 }],
    [W_SHIFT, { x: 700, y: 128 }],
    [W_CONFIG, { x: 340, y: 240 }],
    [W_MUSIC, { x: 280, y: 120 }],
  ]);

  private axioms: AxiomDef[] = [];
  private beginButton: Button | null = null;

  private fields: ConfigField[] = [];
  private configCursor = 0;
  private configRows: Rows | null = null;

  private songs: MusicEntry[] = [];
  private musicCursor = 0;
  private musicRows: Rows | null = null;
  private transport: Button | null = null;

  /**
   * A file being dragged out of the explorer, and the label following the
   * cursor.
   *
   * The one drop this desk accepts: pull a reference off the index and let go
   * anywhere on the desk, and the document opens where you dropped it. Drop it on
   * a reader that is already open and that reader turns to the file instead.
   *
   * Deliberately the *only* drop. Every target a desktop does not handle is a
   * promise it broke — the player tries it once, nothing happens, and from then
   * on they assume none of it works.
   */
  private dragging: { entry: Entry; ghost: Container } | null = null;

  /** Raised when the operator accepts the shift. */
  onBegin: ((r: DeskResult) => void) | null = null;
  /** Raised by the calibration row. The host owns that screen. */
  onCalibrate: (() => void) | null = null;

  /** Raised when a glass setting moved, so the host can re-read its filters. */
  onGlassChange: (() => void) | null = null;

  constructor(
    private readonly library: Library,
    private readonly audio: Audio,
    private readonly story: StoryStore | undefined,
    private readonly seed: string,
  ) {
    this.axioms = AXIOMS.filter((a) => library.availableAxioms.includes(a.id));
    this.desktop = new Desktop(this.deskState());
    this.view.addChild(this.desktop.view);
    // On the desk surface, under the windows — see `Desktop.wallpaper`.
    this.desktop.wallpaper.addChild(this.icons);
    this.rebuildTree();
  }

  private deskState(): DesktopState {
    const s = this.library.snapshot;
    return {
      site: '1147',
      operator: '████████',
      shift: s.runs + 1147,
      revision: this.story?.state.revision ?? '04',
      clock: this.shiftClock(),
    };
  }

  /**
   * The night, as a clock. STORY-AND-TONE §7 — six runs across one shift.
   *
   * 22:10 at the start and roughly forty minutes a run, so a campaign played
   * clean lands near 02:40. Her *finish tonight* is then a thing the player can
   * read off the strip rather than a line they have to take on trust.
   */
  private shiftClock(): number {
    // Counted from the *campaign*, not from the account. A veteran profile has
    // 73 runs on it, and lifetime runs put the clock at 01:16 on a fresh
    // campaign's first shift — which is a number with no meaning attached. The
    // rung is how far into tonight the operator is.
    const rung = this.story ? rungOf(this.story.state) : 1;
    return 22 * 60 + 10 + (rung - 1) * 42;
  }

  // -------------------------------------------------------------------- mount

  mount(): void {
    this.openFiles();
    this.openShift();
  }

  private rebuildTree(): void {
    this.entries = tree(this.story?.state.held ?? {}, this.seen);
    if (this.fileCursor >= this.entries.length) this.fileCursor = 0;
  }

  // -------------------------------------------------------------------- files

  private openFiles(): void {
    if (this.desktop.has(W_FILES)) {
      this.desktop.focus(W_FILES);
      return;
    }
    const win = new Win({
      id: W_FILES,
      title: 'FILES',
      ref: 'OC-1147-F',
      ...this.sizes.get(W_FILES)!,
      ...this.homes.get(W_FILES)!,
    });
    this.desktop.add(win);

    this.explorer = new Explorer();
    this.explorer.onOpen = (e) => this.reveal(e);
    this.explorer.onRefused = (e) => this.flashLocked(e);
    this.explorer.onDragOut = (e) => this.beginFileDrag(e);
    // Two rows of header live in the grid above it, so the explorer starts below.
    this.explorer.view.position.set(0, LINE * 2);
    win.controls.addChild(this.explorer.view);
    this.paintFiles();
  }

  private paintFiles(): void {
    const win = this.desktop.get(W_FILES);
    if (!win) return;

    const locked = this.entries.filter((e) => e.locked).length;
    win.setLines([
      [
        ['FILE INDEX', C.bright],
        [`     ${this.entries.length - locked} readable`, C.dim],
        [`     ${locked} restricted`, locked ? C.faint : C.rule],
      ],
      this.withheld ? [[`${this.withheld} withheld per OC-0061 clause 3`, C.signal]] : [],
    ]);

    this.explorer?.setEntries(this.entries);
    this.explorer?.resize(
      Math.round(win.spec.cols * charW()),
      win.spec.rows * LINE - LINE * 2,
    );
  }

  /** Open a file: mark it read, put it in a reader, refresh the drawer. */
  private reveal(e: Entry): void {
    this.withheld = null;
    this.openReader(e);
    this.seen.add(e.ref);
    this.rebuildTree();
    this.paintFiles();
  }
  /**
   * The refusal, on the sheet rather than in the titlebar.
   *
   * `setTitle` was doing this and a clause reference is far too long for a
   * titlebar — it ran out of the frame and over whatever was beside it.
   */
  private flashLocked(e: Entry): void {
    this.withheld = e.ref;
    this.paintFiles();
  }

  // ------------------------------------------------------------------- reader

  private openReader(e: Entry): void {
    // Cascade, so a second document does not land exactly on the first.
    const n = this.desktop.count;
    this.openReaderAt(e, 150 + n * 26, 120 + n * 22);
  }

  private openReaderAt(e: Entry, x: number, y: number): void {
    const id = readerId(e.ref);
    if (this.desktop.has(id)) {
      this.desktop.focus(id);
      return;
    }
    const win = new Win({
      id,
      title: filename(e),
      ref: e.ref,
      ...this.sizes.get(W_READER)!,
      x: Math.round(x),
      y: Math.round(y),
    });
    this.desktop.add(win);
    // Struck across the page, in red, under the words. Every file in the game
    // carries it; that is the joke, and a marking makes it while a titlebar
    // caption only mentions it.
    win.setStamp(classificationOf(e));
    this.scroll.set(id, 0);
    this.paintReader(id, e);
  }

  /**
   * The whole document, every line of it.
   *
   * `fileBody` takes an offset and a row count and slices for you, which is fine
   * for a fixed pane and useless for a scrollbar: the caller can never know how
   * much more there is, so `fileScrollCount` existed to answer that for the three
   * generated files and returned zero for everything else — which is why a
   * recovered document could not be scrolled at all. Asking for the whole thing
   * and slicing here means the bound is just `length`, for every file.
   */
  private readerLines(e: Entry): Line[] {
    return fileBody(
      e.index,
      this.library,
      0,
      9999,
      0,
      'trigger',
      null,
      filesFor(this.story?.state.held ?? {}),
      this.story?.state.held ?? {},
    );
  }

  private paintReader(id: string, e: Entry): void {
    const win = this.desktop.get(id);
    if (!win) return;
    const rows = win.spec.rows;
    const all = this.readerLines(e);
    const max = Math.max(0, all.length - rows);
    const offset = Math.max(0, Math.min(max, this.scroll.get(id) ?? 0));
    this.scroll.set(id, offset);
    win.setLines(all.slice(offset, offset + rows));
    win.setScroll(offset, all.length, rows);
  }

  /** The reader under the cursor, if the frontmost window is one. */
  private focusedReader(): { id: string; entry: Entry } | null {
    const win = this.desktop.focused;
    if (!win?.id.startsWith('read:')) return null;
    const entry = this.entries.find((x) => x.ref === win.id.slice(5));
    return entry ? { id: win.id, entry } : null;
  }

  private scrollBy(delta: number): boolean {
    const target = this.focusedReader();
    if (!target) return false;
    this.scroll.set(target.id, (this.scroll.get(target.id) ?? 0) + delta);
    this.paintReader(target.id, target.entry);
    return true;
  }

  /** The wheel, from the host. Three lines a notch, like everything else. */
  wheel(deltaY: number): void {
    this.scrollBy(deltaY > 0 ? 3 : -3);
  }

  // -------------------------------------------------------------------- shift

  private openShift(): void {
    if (this.desktop.has(W_SHIFT)) {
      this.desktop.focus(W_SHIFT);
      return;
    }
    const win = new Win({
      id: W_SHIFT,
      title: 'SHIFT',
      ref: ORDER_SHEET.ref,
      ...this.sizes.get(W_SHIFT)!,
      ...this.homes.get(W_SHIFT)!,
    });
    this.desktop.add(win);

    // No Axiom list. §7.3 makes the campaign Ignition-only, so the control that
    // used to be the middle of this form is a choice the operator does not have —
    // and a list of one is worse than no list.
    this.beginButton = new Button(win.grid, BEGIN_LABEL, {
      col: 2,
      row: this.sizes.get(W_SHIFT)!.rows - 2,
      onPress: () => this.begin(),
    });
    win.controls.addChild(this.beginButton.view);
    this.paintShift();
  }

  private paintShift(): void {
    const win = this.desktop.get(W_SHIFT);
    if (!win) return;
    win.setLines(orderLines(this.library, this.story?.state, this.seed));
    // Re-placed every paint, because the window's row count is decided by the
    // viewport and changes under it.
    this.beginButton?.place(2, win.spec.rows - 2);
  }

  /**
   * The campaign is Ignition-only (§7.3), so the Axiom is not a decision and is
   * not presented as one. Falls back to whatever the account has if Ignition were
   * ever withdrawn, which is the only way this can be empty.
   */
  private begin(): void {
    const axiomId = this.axioms.some((a) => a.id === 'ignition')
      ? 'ignition'
      : this.axioms[0]?.id;
    if (!axiomId) return;
    this.onBegin?.({ seed: this.seed, axiomId });
  }

  // ------------------------------------------------------------------- config

  private openConfig(): void {
    if (this.desktop.has(W_CONFIG)) {
      this.desktop.focus(W_CONFIG);
      return;
    }
    const win = new Win({
      id: W_CONFIG,
      title: 'CONFIG',
      ref: CONFIG_SHEET.ref,
      ...this.sizes.get(W_CONFIG)!,
      ...this.homes.get(W_CONFIG)!,
    });
    this.desktop.add(win);

    this.fields = configFields(this.library);
    this.configRows = new Rows(win.grid, {
      row: CONFIG_ROW,
      count: this.fields.length,
      col: 0,
      cols: this.sizes.get(W_CONFIG)!.cols,
      onMove: (i) => {
        this.configCursor = i;
        this.paintConfig();
      },
      // Clicking a value moves it. It did nothing at all before, which makes the
      // whole sheet a picture of a settings screen: the rows highlighted, the
      // cursor moved, and not one of them was wired to anything.
      onCommit: (i) => this.adjust(i, 1),
      commitOnClick: true,
    });
    win.controls.addChild(this.configRows.view);
    this.paintConfig();
  }

  /**
   * Move the setting on row `i`. Left/right and a click all land here.
   *
   * `calibrate` is the one row that is not a value — it opens the calibration
   * screen, which the desk does not host yet, so it is reported and ignored
   * rather than silently doing nothing under the player's cursor.
   */
  private adjust(i: number, d: number): void {
    const f = this.fields[i];
    if (!f) return;
    this.configCursor = i;
    if (f.id === 'calibrate') {
      this.onCalibrate?.();
      return;
    }
    const changed = adjustSetting(f.id, d, {
      library: this.library,
      audio: this.audio,
      applyGlass: () => this.onGlassChange?.(),
      openCalibration: () => {},
    });
    if (!changed) return;
    // Re-read: a field's displayed value is a closure over the Library, but the
    // list itself changes shape when calibration is answered.
    this.fields = configFields(this.library);
    this.paintConfig();
  }

  /** The settings changed underneath us — rebuild the sheet from the Library. */
  refreshSettings(): void {
    this.fields = configFields(this.library);
    this.paintConfig();
  }

  /**
   * MUSIC — the playlist.
   *
   * Songs and nothing else. It had a second column of rhythms beside it, and
   * side by side the two read as one list of twelve rather than as two dials.
   * Rhythm is still a real axis and still switchable; it does not belong in the
   * window somebody opens to pick a song.
   */
  private openMusic(): void {
    if (this.desktop.has(W_MUSIC)) {
      this.desktop.focus(W_MUSIC);
      return;
    }
    const win = new Win({
      id: W_MUSIC,
      title: 'MUSIC',
      ref: MUSIC_SHEET.ref,
      ...this.sizes.get(W_MUSIC)!,
      ...this.homes.get(W_MUSIC)!,
    });
    this.desktop.add(win);

    /**
     * Audition with an Engine running under it.
     *
     * Chained rather than replaced: `Desktop.add` installs its own `onClose` to
     * take the window off the desk, and overwriting that would leave a window
     * that stops the music and then refuses to shut.
     */
    const dismiss = win.onClose;
    win.onClose = () => {
      this.audio.demo(false);
      dismiss?.();
    };
    this.audio.demo(true);

    // The playlist, not the registry. See `Score.listed`.
    this.songs = Object.values(SCORES)
      .filter((s) => s.listed === true)
      .map((s) => ({ id: s.id, name: s.name, blurb: s.blurb }));
    this.musicCursor = Math.max(0, this.songs.findIndex((s) => s.id === this.audio.activeScore.id));

    this.musicRows = new Rows(win.grid, {
      row: MUSIC_ROW,
      count: this.songs.length,
      col: 0,
      cols: this.sizes.get(W_MUSIC)!.cols,
      onMove: (i) => {
        this.musicCursor = i;
        // Deferred: a repaint rebuilds the hit areas, and rebuilding them inside
        // the event that moved the cursor is what made one click commit five rows.
        requestAnimationFrame(() => this.paintMusic());
      },
      onCommit: (i) => this.playSong(i),
      commitOnClick: true,
    });
    win.controls.addChild(this.musicRows.view);
    this.buildTransport();
    this.paintMusic();
  }

  /**
   * STOP and PLAY.
   *
   * Rebuilt rather than relabelled because `Button` measures its own box from
   * the label at construction — a four-character word in a five-character box
   * would sit off-centre, which is the exact bug its own comment describes.
   */
  private buildTransport(): void {
    const win = this.desktop.get(W_MUSIC);
    if (!win) return;
    if (this.transport) {
      this.transport.view.destroy();
      this.transport = null;
    }
    const stopped = !this.audio.playing;
    this.transport = new Button(win.grid, stopped ? 'PLAY' : 'STOP', {
      col: 2,
      row: this.sizes.get(W_MUSIC)!.rows - 2,
      onPress: () => {
        if (this.audio.playing) {
          // Both halves: `silence` parks the clock and zeroes the busses, and
          // without stopping the audition as well its frame loop would go on
          // driving an engine nobody can hear.
          this.audio.demo(false);
          this.audio.silence();
        } else {
          this.audio.demo(true);
        }
        this.buildTransport();
        this.paintMusic();
      },
    });
    win.controls.addChild(this.transport.view);
  }

  /**
   * Put a song on.
   *
   * **Repainting is deferred a frame, and that is not a nicety.** `paintMusic`
   * re-lays the sheet, which rebuilds `Rows`' hit areas — and doing that from
   * inside a `pointertap` handler destroys the containers Pixi's event boundary
   * is still walking, so it carries on notifying the *new* ones and each of them
   * commits in turn. One click on DEEP was landing five commits and leaving
   * CHOIR playing. The click is the event; the redraw is a consequence, and a
   * consequence must not run inside the thing that caused it.
   *
   * The early return is the second half: `setScore` already ignores a Score that
   * is playing, so without this the repaint-and-rebuild would still fire for a
   * click that changed nothing.
   */
  private playSong(i: number): void {
    const song = this.songs[i];
    if (!song || song.id === this.audio.activeScore.id) return;
    this.musicCursor = i;
    this.audio.setScore(song.id);
    this.audio.chrome('confirm');
    requestAnimationFrame(() => this.paintMusic());
  }

  private paintMusic(): void {
    const win = this.desktop.get(W_MUSIC);
    if (!win) return;
    win.setLines(
      musicLines(this.songs, this.musicCursor, this.audio.activeScore.id, !this.audio.playing),
    );
  }

  private paintConfig(): void {
    const win = this.desktop.get(W_CONFIG);
    if (!win) return;
    win.setLines(configLines(this.fields, this.configCursor, this.library));
  }

  // ---------------------------------------------------------------- the icons

  /**
   * Desktop icons, along the left edge.
   *
   * Windows 1.0 had no desktop icons — the file manager was itself a window and
   * you launched everything from it. Authenticity loses to legibility here: a
   * player who closes every window needs a way back that is not a keyboard
   * shortcut they were never told about.
   */
  private paintIcons(): void {
    this.icons.removeChildren().forEach((c) => c.destroy());
    const items: { label: string; glyph: Glyph; open: () => void }[] = [
      { label: 'FILES', glyph: 'folder', open: () => this.openFiles() },
      { label: 'SHIFT', glyph: 'shift', open: () => this.openShift() },
      { label: 'CONFIG', glyph: 'cog', open: () => this.openConfig() },
      { label: 'MUSIC', glyph: 'speaker', open: () => this.openMusic() },
    ];

    for (let i = 0; i < items.length; i++) {
      const item = items[i]!;
      const x = 26;
      const y = 64 + i * 92;
      // The tile covers the glyph *and* its name, because the name is the part
      // people aim at. Sixty-eight by eighty, from four pixels above the glyph to
      // below the baseline of the label.
      const tile = new Rectangle(x - 8, y - 4, 76, 80);
      const label = new Text({ text: item.label, style: style(9, C.dim, 3) });
      label.position.set(x, y + 40);

      const g = new Graphics();
      const paint = (hover: boolean): void => {
        g.clear();
        // A visible hover state, because nothing else on the wallpaper says these
        // are objects you can open. Filled at 0.02 even when cold so the geometry
        // the pointer tests against exists at all.
        g.rect(tile.x, tile.y, tile.width, tile.height).fill({
          color: C.paper,
          alpha: hover ? 0.1 : 0.02,
        });
        if (hover) {
          g.rect(tile.x, tile.y, tile.width, 1).fill(C.faint);
          g.rect(tile.x, tile.y + tile.height - 1, tile.width, 1).fill(C.faint);
          g.rect(tile.x, tile.y, 1, tile.height).fill(C.faint);
          g.rect(tile.x + tile.width - 1, tile.y, 1, tile.height).fill(C.faint);
        }
        drawGlyph(g, item.glyph, x + 6, y + 6);
        label.style = style(9, hover ? C.bright : C.dim, 3);
      };
      paint(false);

      g.eventMode = 'static';
      g.cursor = 'pointer';
      g.hitArea = tile;
      g.on('pointerover', () => paint(true));
      g.on('pointerout', () => paint(false));
      g.on('pointertap', item.open);
      this.icons.addChild(g, label);
    }
  }

  // ------------------------------------------------------------------- events

  layout(vw: number, vh: number): void {
    this.desktop.layout(vw, vh);
    this.fitToViewport(vw);
    this.paintIcons();
  }

  /**
   * Choose window sizes and homes from the viewport.
   *
   * 720p is the floor, and the authored sizes do not fit it: FILES at 24 lines
   * is 617 pixels of content before chrome, against a 720-pixel screen with a
   * bezel and a taskbar in it. Rather than scaling the whole desk — which
   * resamples every hairline and every glyph, and this dialect is built out of
   * one-pixel lines — the *layout* answers the viewport and the text stays
   * pixel-exact at every size.
   *
   * Windows already open are resized in place, so dragging the browser edge does
   * not throw away the desk the player arranged.
   */
  private fitToViewport(vw: number): void {
    const usable = this.desktop.contentBottom;
    // Chrome is 26 of titlebar, 2+2 of border and 9+9 of padding: 48 pixels a
    // window pays before it holds a single line.
    const rowsFor = (px: number): number => Math.max(8, Math.floor((px - 48) / LINE));
    const colsFor = (px: number): number => Math.max(30, Math.floor((px - 28) / charW()));

    const top = 96;
    // Measured from the *deepest* window, not the shallowest. SHIFT opens 32
    // pixels below FILES, so sizing everything against FILES' own top left it
    // hanging into the strip: the clamp bounds a window's top edge and has
    // nothing to say about its bottom. One height that fits the lowest one fits
    // all of them.
    const deepest = top + 40;
    const tall = rowsFor(usable - deepest - 16);
    const half = Math.floor((vw - 150) / 2);

    const files = { cols: Math.min(70, colsFor(half)), rows: Math.min(24, tall) };

    // SHIFT and CONFIG are sized from *their own content*, not from a guess.
    //
    // Both were fixed at numbers I picked by eye, and both were wrong: CONFIG has
    // more settings on it than 18 lines holds, so the last few — scanlines among
    // them — were simply cut off by the window's mask with nothing to say they
    // were there. A form should be as big as the form.
    const orderNeeds = { cols: orderCols(this.library, this.story?.state, this.seed) + 2,
                         rows: orderRows(this.library, this.story?.state, this.seed) };
    const shift = {
      cols: Math.min(Math.max(orderNeeds.cols, 48), colsFor(vw - 200)),
      rows: Math.min(orderNeeds.rows, tall),
    };

    // Sized from the lines the sheet actually renders, not from a formula over
    // its field count. `configLines` emits a header, the rows, *and* a legend of
    // the available presets and phosphors underneath — so counting fields left
    // the last two lines outside the window with nothing to say they were there.
    // Measuring the output means the next setting added needs no arithmetic here.
    const configNeeds =
      configLines(configFields(this.library), 0, this.library).length + 2;

    this.sizes.set(W_FILES, files);
    this.sizes.set(W_SHIFT, shift);
    this.sizes.set(W_CONFIG, {
      cols: Math.min(56, colsFor(half)),
      rows: Math.min(configNeeds, rowsFor(usable - 40)),
    });
    this.sizes.set(W_READER, {
      cols: Math.min(72, colsFor(vw - 200)),
      rows: Math.min(26, rowsFor(usable - 120)),
    });

    // Homes: FILES to the left of the icons' column, SHIFT to the right of it if
    // there is room for both, stacked underneath if there is not.
    const filesW = 28 + Math.round(files.cols * charW());
    this.homes.set(W_FILES, { x: 96, y: top });
    const sideBySide = 96 + filesW + 40 + 28 + Math.round(shift.cols * charW()) <= vw;
    this.homes.set(
      W_SHIFT,
      sideBySide ? { x: 96 + filesW + 40, y: top + 32 } : { x: 140, y: top + 40 },
    );
    this.homes.set(W_CONFIG, { x: Math.round(vw * 0.24), y: 28 });

    for (const [id, size] of this.sizes) {
      if (id === W_READER) continue;
      this.desktop.get(id)?.resize(size.cols, size.rows);
    }
    const reader = this.sizes.get(W_READER)!;
    for (const win of this.desktop.all) {
      if (win.id.startsWith('read:')) win.resize(reader.cols, reader.rows);
    }
    this.repaintAll();
  }

  /** Every open window, redrawn for whatever size it now is. */
  private repaintAll(): void {
    if (this.desktop.has(W_FILES)) this.paintFiles();
    if (this.desktop.has(W_SHIFT)) this.paintShift();
    if (this.desktop.has(W_CONFIG)) this.paintConfig();
    for (const win of this.desktop.all) {
      if (!win.id.startsWith('read:')) continue;
      const entry = this.entries.find((x) => x.ref === win.id.slice(5));
      if (entry) this.paintReader(win.id, entry);
    }
  }

  // -------------------------------------------------------------- drag a file

  private beginFileDrag(entry: Entry): void {
    if (this.dragging) return;
    // A locked file has nothing to open, so it has nothing to drag either.
    if (entry.locked) return;

    const ghost = new Container();
    const g = new Graphics();
    const label = new Text({ text: entry.ref, style: style(11, C.bright, 4) });
    const w = Math.round(label.width) + 20;
    g.rect(0, 0, w, 22).fill({ color: 0x0b1018, alpha: 0.92 });
    g.rect(0, 0, w, 1).fill(C.paper);
    g.rect(0, 21, w, 1).fill(C.paper);
    g.rect(0, 0, 1, 22).fill(C.paper);
    g.rect(w - 1, 0, 1, 22).fill(C.paper);
    label.position.set(10, 4);
    ghost.addChild(g, label);
    // Above every window, and it must never take a pointer of its own or it
    // would be the thing under the cursor at the moment of the drop.
    ghost.eventMode = 'none';
    this.view.addChild(ghost);
    this.dragging = { entry, ghost };
  }

  pointerMove(x: number, y: number): void {
    if (this.dragging) {
      this.dragging.ghost.position.set(x + 12, y + 8);
      return;
    }
    this.desktop.pointerMove(x, y);
  }

  pointerUp(): void {
    const drag = this.dragging;
    if (drag) {
      this.dragging = null;
      const at = drag.ghost.position;
      drag.ghost.destroy({ children: true });
      this.dropFile(drag.entry, at.x - 12, at.y - 8);
      return;
    }
    this.desktop.pointerUp();
  }

  /**
   * Where the file landed decides what happens to it.
   *
   * Onto an open reader: that window turns to this document, which is what
   * dropping a piece of paper on top of another one means. Anywhere else on the
   * desk: a new reader, at the drop point, because the player has just told us
   * exactly where they want it.
   */
  private dropFile(entry: Entry, x: number, y: number): void {
    this.seen.add(entry.ref);

    for (const win of this.desktop.all) {
      if (!win.id.startsWith('read:')) continue;
      const p = win.view.position;
      if (x < p.x || y < p.y || x > p.x + win.width || y > p.y + win.height) continue;
      // Retarget by id, which means closing and reopening: a reader *is* its
      // document — the window id carries the reference and the strip button
      // shows it — so a window that keeps its id and changes its contents would
      // be lying about which file it holds.
      this.desktop.close(win.id);
      this.openReaderAt(entry, p.x, p.y);
      this.rebuildTree();
      this.paintFiles();
      return;
    }

    this.openReaderAt(entry, x, y);
    this.rebuildTree();
    this.paintFiles();
  }

  /**
   * Keys go to the frontmost window, and only the ones nothing else claimed
   * reach the desk itself.
   */
  key(e: KeyboardEvent): boolean {
    const win = this.desktop.focused;

    if (e.key === 'Tab') {
      this.desktop.cycle(e.shiftKey ? -1 : 1);
      return true;
    }
    if (e.key === 'Escape') {
      if (win && win.spec.closable !== false) {
        this.desktop.close(win.id);
        return true;
      }
      return false;
    }

    if (!win) return false;

    const dv = vertical(e);

    if (win.id === W_FILES) {
      // The keyboard walks the drawer the mouse is looking at, in the order the
      // tiles are laid out.
      const shown = this.entries.filter((x) => x.folder === this.explorer?.current);
      if (dv && shown.length) {
        this.fileCursor = (((this.fileCursor + dv) % shown.length) + shown.length) % shown.length;
        return true;
      }
      if (e.key === 'Enter') {
        const pick = shown[this.fileCursor];
        if (pick) {
          if (pick.locked) this.flashLocked(pick);
          else this.reveal(pick);
        }
        return true;
      }
      return false;
    }

    if (win.id === W_SHIFT) {
      // Nothing to move a cursor between any more — the order has one action on
      // it, so Enter is the whole keyboard contract.
      if (e.key === 'Enter') {
        this.begin();
        return true;
      }
      return false;
    }

    if (win.id === W_CONFIG) {
      if (dv) {
        this.configCursor =
          (((this.configCursor + dv) % this.fields.length) + this.fields.length) %
          this.fields.length;
        this.configRows!.index = this.configCursor;
        this.paintConfig();
        return true;
      }
      const dh = horizontal(e);
      if (dh) {
        this.adjust(this.configCursor, dh);
        return true;
      }
      if (e.key === 'Enter') {
        this.adjust(this.configCursor, 1);
        return true;
      }
      return false;
    }

    // A reader. Scrolling is the only thing it does.
    if (win.id.startsWith('read:')) {
      if (dv) return this.scrollBy(dv);
      if (e.key === 'PageDown') return this.scrollBy(win.spec.rows - 2);
      if (e.key === 'PageUp') return this.scrollBy(-(win.spec.rows - 2));
      if (e.key === 'Home') return this.scrollBy(-99999);
      if (e.key === 'End') return this.scrollBy(99999);
    }

    return false;
  }

  /**
   * Every window's rectangle, and whether it fits. A dev probe: the layout has
   * to hold at 1280x720 and that is checked by measuring, not by squinting.
   */
  geometry(): Record<string, unknown> {
    const bottom = this.desktop.contentBottom;
    return {
      bottom,
      windows: this.desktop.all.map((w) => ({
        id: w.id,
        x: w.view.position.x,
        y: w.view.position.y,
        w: w.width,
        h: w.height,
        cols: w.spec.cols,
        rows: w.spec.rows,
        fits: w.view.position.y + w.height <= bottom,
      })),
    };
  }

  /** A run has ended: the night moved on and a file may have arrived. */
  refresh(): void {
    this.rebuildTree();
    this.desktop.setState(this.deskState());
    this.paintFiles();
    this.paintShift();
  }

  destroy(): void {
    this.desktop.destroy();
    this.view.destroy({ children: true });
  }
}
