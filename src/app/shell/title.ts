/**
 * The shell. NARRATIVE §5 — the start screen, the terminal, and everything the
 * player can read before a run.
 *
 * Replaces the DOM title screen. Same contract (`present()` resolves with the
 * seed and Axiom), rendered instead of laid out: it is a game, so it gets the
 * renderer, and the same components serve the documents that will open during a
 * run — the draft, the results, the pause sheet.
 *
 * Three surfaces, in order of permanence:
 *
 *   **the start screen** — brand layer. Four words and a way in.
 *   **the terminal** — the constant. Everything returns here.
 *   **documents** — sheets opened in the terminal's body.
 *
 * `EXIT` is deliberately absent: this is the browser build (§16.4).
 */
import { Application, Container, Graphics, Rectangle, Text } from 'pixi.js';
import { AXIOMS, AXIOM_BY_ID } from '../../content/index';
import type { Audio } from '../../audio/audio';
import type { Library } from '../../meta/profile';
import type { AxiomDef } from '../../sim/types';
import { BRANDING } from '../../branding';
import { Backdrop } from './backdrop';
import {
  Button,
  C,
  ENTRIES,
  Glass,
  PHOSPHOR,
  List,
  Rows,
  Sheet,
  Terminal,
  Transmission,
  LINE,
  horizontal,
  style,
  vertical,
} from '../ui';
import { VIEW_EFFECTS, VIEW_PRESETS, applyEffects } from '../visual';
import type { StoryStore } from '../../story/store';
import { BEAT_BY_ID } from '../../story/script';
import { DocumentSheet } from './document';
import { drawEnemy } from '../gfx/enemy';
import { HUE_COLOR } from '../visual';

/** The plate: how much room the biggest asset in the file gets, and its strip. */
const PLATE_R = 34;
const ICON_R = 13;
const ICON_STEP = 32;
/** Drawn facing up. The arena rotates a Charger to its aim; this is a still. */
const FACING = -Math.PI / 2;

import {
  AXIOM_ROW,
  BODY_ROW,
  CONFIG_ROW,
  assetRows,
  variantsOf,
  LARGEST_ASSET,
  PLATE_COL,
  NODE_KINDS,
  type NodeKind,
  CONFIG_SHEET,
  FILES,
  type FileDef,
  filesFor,
  FILES_SHEET,
  RUN_SHEET,
  type ConfigField,
  configFields,
  configLines,
  directoryLines,
  fileBody,
  fileScrollCount,
  runLines,
} from './panes';

export interface SetupResult {
  seed: string;
  axiomId: string;
}

type Mode = 'start' | 'terminal' | 'doc';

/**
 * Columns the body list occupies, so its hit boxes stop where the detail column
 * starts. Wider and the mouse would select rows by hovering the record it is
 * already reading.
 */
const LIST_COLS = 38;

function randomSeed(): string {
  return `run-${Math.floor(Math.random() * 1e9).toString(36)}`;
}

export class TitleScreen {
  private readonly app = new Application();
  private readonly backdrop = new Backdrop();
  private readonly glass = new Glass({ scan: 0.3, vignette: 0.5 });
  /**
   * Everything the intrusion happens *to*.
   *
   * §8 — "a clean file corrupts mid-render, then raw monospace where the body
   * copy was." The tear has to hit the terminal and not the window doing the
   * tearing, so the two are separate layers and only this one takes the filter.
   */
  private readonly behind = new Container();
  private readonly startLayer = new Container();
  private readonly termLayer = new Container();
  /** Above the tear, so the window sits still while the site comes apart. */
  private readonly intrusionLayer = new Container();
  /** The same shader the shell lab used: quantised bands that jump and hold. */
  private readonly tear = new Glass({ tear: 1, split: 1.8, noise: 0.07, scan: 0.34 });
  private readonly terminal: Terminal;

  private readonly title = new Text({ text: BRANDING.title, style: style(34, 0xffffff, 19) });
  private readonly tagline = new Text({ text: BRANDING.tagline, style: style(11, 0x3f5570, 4) });
  private readonly login = new Text({ text: 'LOGIN', style: style(17, C.ink, 6) });

  private mode: Mode = 'start';
  private sheet: Sheet | null = null;
  private rows: Rows | null = null;
  /** §5.3 — the entries inside an open file, as a mouse-navigable list. */
  private bodyRows: Rows | null = null;
  /** The selected asset, drawn rather than named. */
  private shape: Graphics | null = null;
  /** §5.3 — which slice of the node list is showing. Fifty-eight is not a list. */
  private nodeKind: NodeKind = 'trigger';
  private kindButtons: Button[] = [];
  /** Which variant of the selected chassis is being read. Null is the chassis. */
  private assetVariant: string | null = null;
  /** Click targets over the drawn variant strip. Rebuilt whenever it is drawn. */
  private variantHits: Container[] = [];
  private begin: Button | null = null;
  /** §8 — the resistance, typing over the terminal. Null when the channel is quiet. */
  private intrusion: Transmission | null = null;
  private intrusionId: string | null = null;
  /** The Bureau, on paper, at the same commitment point. Lazily mounted. */
  private noticeSheet: DocumentSheet | null = null;
  private noticeId: string | null = null;
  /** True while a run is waiting on the channel to finish. */
  private holdingRun = false;
  private docId = '';
  private cursor = 0;
  private axioms: AxiomDef[] = [];
  private fields: ConfigField[] = [];
  private readonly files = new List(FILES.length, FILES.length, 0);
  /** The index as it stands: standing files plus whatever has been recovered. */
  private get fileIndex(): readonly FileDef[] {
    return filesFor(this.story?.state.held ?? {});
  }
  private scroll = new List(0, 10);
  private inBody = false;

  private seed = randomSeed();
  private axiomId = 'ignition';
  private resolve: ((r: SetupResult) => void) | null = null;
  private raf = 0;
  private last = 0;
  private acc = 0;

  private readonly onKey = (e: KeyboardEvent): void => this.handleKey(e);
  private readonly onResize = (): void => this.layout();

  constructor(
    private readonly mount: HTMLElement,
    private readonly library: Library,
    private readonly audio: Audio,
    private readonly story?: StoryStore,
  ) {
    this.terminal = new Terminal({
      site: '██',
      operator: '████████',
      // §5.2 — the shift counter is the run counter and it does not start at 1.
      shift: 1147 + this.library.snapshot.runs,
      revision: '04',
    });
  }

  async present(defaults?: Partial<SetupResult> & { open?: 'run' }): Promise<SetupResult> {
    if (defaults?.seed) this.seed = defaults.seed;
    const available = this.library.availableAxioms;
    this.axioms = available.map((id) => AXIOM_BY_ID.get(id)).filter((a): a is AxiomDef => !!a);
    if (!this.axioms.length) this.axioms = [...AXIOMS].slice(0, 1);
    this.axiomId =
      defaults?.axiomId && available.includes(defaults.axiomId)
        ? defaults.axiomId
        : (this.axioms[0]?.id ?? 'ignition');
    this.fields = configFields(this.library);

    await this.app.init({
      background: 0x000000,
      resizeTo: window,
      antialias: true,
      autoDensity: true,
      resolution: Math.min(2, window.devicePixelRatio || 1),
      // Presented by hand so the shell can hold a flat 60 — a menu should never
      // be the most expensive thing the game draws.
      autoStart: false,
    });
    this.app.ticker.stop();
    this.app.canvas.style.position = 'absolute';
    this.app.canvas.style.inset = '0';
    this.mount.appendChild(this.app.canvas);

    this.backdrop.init();
    this.behind.addChild(this.backdrop.root, this.startLayer, this.termLayer);
    this.app.stage.addChild(this.behind, this.intrusionLayer);
    this.app.stage.filters = [this.glass.filter];
    this.applyGlass();

    for (const t of [this.title, this.tagline, this.login]) t.anchor.set(0.5, 0);
    this.login.eventMode = 'static';
    this.login.cursor = 'pointer';
    this.login.on('pointerover', () => {
      this.login.style = style(17, 0xffffff, 6);
      this.audio.chrome('hover');
    });
    this.login.on('pointerout', () => {
      this.login.style = style(17, C.ink, 6);
    });
    this.login.on('pointertap', () => this.enter());
    this.startLayer.addChild(this.title, this.tagline, this.login);

    this.terminal.onPick = (i) => this.open(ENTRIES[i]!.id);
    this.termLayer.addChild(this.terminal.view);
    this.termLayer.visible = false;

    window.addEventListener('resize', this.onResize);
    window.addEventListener('keydown', this.onKey);
    this.app.canvas.addEventListener('wheel', this.onWheel, { passive: false });
    this.layout();
    this.last = performance.now() / 1000;
    this.raf = requestAnimationFrame(() => this.frame());

    // LEVELS §2.3 — CONTINUE from a results screen lands on the operations
    // order, one keystroke from BEGIN RUN. The session is already logged in;
    // making somebody re-LOGIN between shifts would be the frame breaking
    // character to slow them down.
    if (defaults?.open === 'run') {
      this.enter();
      this.open('run');
    }

    return new Promise((resolve) => {
      this.resolve = resolve;
    });
  }

  private finish(): void {
    cancelAnimationFrame(this.raf);
    window.removeEventListener('resize', this.onResize);
    window.removeEventListener('keydown', this.onKey);
    this.app.canvas.removeEventListener('wheel', this.onWheel);
    this.closeDoc();
    const r = this.resolve;
    this.resolve = null;
    // Destroyed rather than hidden: the run brings up its own renderer, and two
    // live WebGL contexts on one page is a cost with no upside.
    this.app.canvas.remove();
    this.app.destroy(true, { children: true });
    r?.({ seed: this.seed, axiomId: this.axiomId });
  }

  // -------------------------------------------------------------------------
  // layout
  // -------------------------------------------------------------------------

  private layout(): void {
    const w = this.app.screen.width;
    const h = this.app.screen.height;
    const cx = Math.round(w / 2);
    const top = Math.round(h * 0.34);
    this.title.position.set(cx, top);
    this.tagline.position.set(cx, top + 52);
    this.login.position.set(cx, top + 128);
    this.backdrop.resize(w, h);
    this.terminal.layout(w, h);
    if (this.sheet) this.redraw();
    this.paintKeys();
  }

  private paintKeys(): void {
    if (this.mode === 'doc') {
      // The files pane has two cursors — the index and the entries inside the
      // open file — and the key line used to describe neither. `[←→] adjust` is
      // true of the config sheet and meaningless here, so nobody found the
      // second list at all and the long files read as truncated.
      if (this.docId === 'files') {
        this.terminal.setKeys(
          this.inBody
            ? '[ESC] back    [↑↓/WS] entry    [←/A] back to index'
            : '[ESC] back    [↑↓/WS] file    [→/D] read entries',
        );
      } else {
        const extra = this.docId === 'run' ? '[ENTER] begin' : '[←→/AD] adjust';
        this.terminal.setKeys(`[ESC] back    [↑↓/WS] select    ${extra}`);
      }
    } else if (this.mode === 'terminal') {
      this.terminal.setKeys('[ESC] log out    [↑↓/WS] select    [ENTER] open');
    } else this.terminal.setKeys('');
  }

  private enter(): void {
    this.mode = 'terminal';
    this.startLayer.visible = false;
    this.termLayer.visible = true;
    this.terminal.busy = false;
    this.terminal.paint();
    this.paintKeys();
    this.audio.chrome('click');
  }

  /**
   * Type the next queued transmission over the terminal.
   *
   * §8 — "a clean file corrupts mid-render, then raw monospace where the body
   * copy was." No frame, no reference, no stamp: Bureau documents are typeset
   * and this is typed, and that difference is the firewall the twist rides on.
   *
   * Only a message read to the end is acknowledged, so one interrupted by a
   * reload is still queued next session.
   */
  private showTransmission(): void {
    if (!this.story || this.intrusion || this.notice.open) return;
    const beatId = this.story.state.queue[0];
    if (!beatId) return;
    const beat = BEAT_BY_ID.get(beatId);
    if (!beat) return;

    // §13.5 — the shape of the page is the voice. A Bureau beat arrives as a
    // document: typeset, whole, on paper, through the proper channel. The
    // typed process window belongs to the channel and to nobody else.
    if (beat.voice === 'bureau') {
      this.noticeId = beatId;
      this.notice.show(
        { beat, hint: 'ANY KEY — ACKNOWLEDGE AND PROCEED' },
        () => this.closeNotice(),
      );
      this.audio.chrome('confirm');
      return;
    }

    this.intrusionId = beatId;
    this.intrusion = new Transmission(
      beat.body.filter((block): block is string => typeof block === 'string'),
      (isBanner) => this.audio.chrome(isBanner ? 'wire' : 'type'),
    );
    // The handshake once, at the top; the track shut away for the whole of it.
    this.audio.dialup();
    this.audio.interfere(true);
    // Any key or any click moves it on — for a player who never touches the
    // keyboard, and because the only thing you can do with one is finish it.
    this.intrusion.view.eventMode = 'static';
    this.intrusion.view.hitArea = new Rectangle(-4000, -4000, 8000, 8000);
    this.intrusion.view.on('pointertap', () => this.closeTransmission());
    this.intrusionLayer.addChild(this.intrusion.view);
    this.layoutTransmission();
    // The site starts coming apart the moment the window opens, and settles the
    // moment it closes. Nothing about the window itself is distorted.
    this.behind.filters = [this.tear.filter];
  }

  private layoutTransmission(): void {
    if (!this.intrusion) return;
    // Centred, a little above the middle — a window that opened where it liked.
    this.intrusion.view.position.set(
      Math.round((window.innerWidth - this.intrusion.width) / 2),
      Math.round(window.innerHeight * 0.42 - this.intrusion.height / 2),
    );
  }


  /** The notice surface, mounted the first time the Bureau has one to serve. */
  private get notice(): DocumentSheet {
    if (!this.noticeSheet) this.noticeSheet = new DocumentSheet(this.intrusionLayer);
    return this.noticeSheet;
  }

  /** Acknowledge the Bureau's notice. Documents arrive whole; one key files it. */
  private closeNotice(): void {
    if (!this.notice.open) return;
    if (this.story && this.noticeId) this.story.delivered(this.noticeId);
    this.notice.close();
    this.noticeId = null;
    this.audio.chrome('click');
    // One per run, and then the run — same contract as the channel below.
    if (!this.holdingRun) return;
    this.holdingRun = false;
    this.finish();
  }

  /** Dismiss the intrusion. Acknowledged only if it finished typing. */
  private closeTransmission(): void {
    if (!this.intrusion) return;
    if (!this.intrusion.done) {
      this.intrusion.finish();
      return;
    }
    if (this.story && this.intrusionId) this.story.delivered(this.intrusionId);
    this.intrusion.destroy();
    this.intrusion = null;
    this.intrusionId = null;
    this.behind.filters = [];
    this.audio.interfere(false);

    // One per run, and then the run.
    //
    // This used to open the next queued message instead, which is wrong twice
    // over. It reads as the same message playing again — the player dismissed
    // something and got another window where the run should have been — and it
    // happens most to anyone with shifts already on file, because several rules
    // can come true in a single pass: an operator on shift 12 fires R1 and R2
    // together the first time the arc runs, and would have been handed both
    // back to back before their next episode.
    //
    // Whatever else is queued waits for the next BEGIN RUN. §8's cadence is one
    // arrival per episode, and the queue is what makes that safe to promise.
    if (!this.holdingRun) return;
    this.holdingRun = false;
    this.finish();
  }

  // -------------------------------------------------------------------------
  // documents
  // -------------------------------------------------------------------------

  private redraw(): void {
    const s = this.sheet;
    if (!s) return;
    let lines =
      this.docId === 'run'
        ? runLines(
            this.axioms,
            this.cursor,
            this.seed,
            1147 + this.library.snapshot.runs,
          )
        : this.docId === 'files'
          ? [
              ...directoryLines(this.files.index, this.library, this.fileIndex),
              ...fileBody(
                this.files.index,
                this.library,
                this.scroll.offset,
                this.scroll.rows,
                this.scroll.index,
                this.nodeKind,
                this.assetVariant,
                this.fileIndex,
                this.story?.state.held ?? {},
              ),
            ]
          : configLines(this.fields, this.cursor, this.library);

    this.paintAsset();
    this.paintKinds();

    const [bw, bh] = this.terminal.bodySize;
    const want = s.heightFor(lines.length);
    if (want > bh) {
      // The slice is the last resort, not the layout. `rescroll` sizes the entry
      // window to the room available, so a list file should already fit; this
      // only ever trims prose that overflows on a short viewport. It used to be
      // the *only* thing limiting height, which meant it was cutting the list —
      // scrolling worked and the rows it reached were removed before drawing.
      lines = lines.slice(0, Math.max(4, Math.floor((bh - s.heightFor(0)) / LINE)));
    }
    s.layout(Math.min(1000, bw), Math.min(want, bh));
    s.setLines(lines);
  }

  private open(id: string): void {
    this.closeDoc();
    this.docId = id;
    this.cursor = 0;
    this.inBody = false;
    this.mode = 'doc';
    this.terminal.busy = true;
    this.terminal.paint();
    this.audio.chrome('click');

    this.sheet = new Sheet(
      id === 'run' ? RUN_SHEET : id === 'files' ? FILES_SHEET : CONFIG_SHEET,
    );
    this.terminal.body.addChild(this.sheet.view);

    if (id === 'run') {
      this.cursor = Math.max(0, this.axioms.findIndex((a) => a.id === this.axiomId));
      this.redraw();
      const commit = (): void => this.startRun();
      this.rows = new Rows(this.sheet.grid, {
        row: AXIOM_ROW,
        count: this.axioms.length,
        col: 0,
        cols: this.sheet.cols,
        onMove: (i) => {
          this.cursor = i;
          this.axiomId = this.axioms[i]?.id ?? this.axiomId;
          this.audio.chrome('hover');
          this.redraw();
        },
        onCommit: commit,
      });
      this.rows.moveTo(this.cursor);
      this.begin = new Button(this.sheet.grid, 'BEGIN RUN', {
        col: 3,
        row: AXIOM_ROW + this.axioms.length + 5,
        onPress: commit,
      });
      this.begin.focused = true;
      this.begin.paint();
      this.sheet.controls.addChild(this.rows.view, this.begin.view);
    } else if (id === 'files') {
      // Lay the sheet out *before* anything measures it.
      //
      // `rescroll` sizes the entry window from the sheet's height, and the sheet
      // gets its height in `redraw`. Called the other way round it measured a
      // sheet that had never been laid out, hit the floor of the clamp, and every
      // widget built from that number inherited it.
      // The index grows as documents are recovered, so its size is read here
      // rather than fixed when the List was constructed.
      this.files.setCount(this.fileIndex.length);
      this.files.rows = this.fileIndex.length;
      this.files.moveTo(0);
      this.redraw();
      this.rescroll();
      this.rows = new Rows(this.sheet.grid, {
        row: 2,
        count: this.fileIndex.length,
        col: 0,
        cols: this.sheet.cols,
        onMove: (i) => {
          this.files.moveTo(i);
          this.rescroll();
          this.audio.chrome('hover');
          this.redraw();
        },
      });
      // §5.3 — the entries inside an open file are a list too, and were
      // keyboard-only behind an undiscoverable right-arrow. Same widget as the
      // index above it, so hover, click and the selection band all come free.
      this.bodyRows = new Rows(this.sheet.grid, {
        row: BODY_ROW,
        count: Math.max(1, this.scroll.rows),
        col: 0,
        cols: LIST_COLS,
        onMove: (i) => {
          this.scroll.index = Math.min(this.scroll.length - 1, this.scroll.offset + i);
          // A new entry is a new page; a variant chosen on the last one has no
          // meaning here and would silently keep showing.
          this.assetVariant = null;
          this.audio.chrome('hover');
          this.redraw();
        },
      });
      // §5.3 — fifty-eight entries is not a list, it is a haystack. The node
      // file is three files: pick which one. Buttons rather than a keypress,
      // because the whole point of this pass is that everything is reachable
      // with the mouse.
      // Laid out from each label's own width plus the box padding, with a gap.
      // Fixed 13-column steps made "TRIGGER" (7 + 6 of padding = 13 wide) end
      // exactly where "MODIFIER" began, so the boxes touched and the hit areas
      // met on a shared edge — which is why the first one kept winning.
      let col = 3;
      this.kindButtons = NODE_KINDS.map((k) => {
        const at = col;
        col += k.length + 6 + 2;
        return new Button(this.sheet!.grid, k.toUpperCase(), {
            col: at,
            row: BODY_ROW - 2,
          onPress: () => {
            this.nodeKind = k;
            this.rescroll();
            this.audio.chrome('click');
            this.redraw();
          },
        });
      });
      this.shape = new Graphics();
      this.sheet.controls.addChild(
        this.rows.view,
        this.bodyRows.view,
        this.shape,
        ...this.kindButtons.map((b) => b.view),
      );
      this.rescroll();
      this.redraw();
    } else {
      this.redraw();
      this.rows = new Rows(this.sheet.grid, {
        row: CONFIG_ROW,
        count: this.fields.length,
        col: 0,
        cols: this.sheet.cols,
        onMove: (i) => {
          this.cursor = i;
          this.audio.chrome('hover');
          this.redraw();
        },
        // A setting is a thing you click to cycle, so here the click is the act.
        onCommit: () => this.adjust(1),
        commitOnClick: true,
      });
      this.sheet.controls.addChild(this.rows.view);
    }
    this.paintKeys();
  }

  /**
   * How many entry rows the open sheet actually has room for.
   *
   * The window used to be a flat twelve and `redraw` sliced whatever did not fit
   * off the bottom — which is the list. On a short viewport that left two or
   * three entries visible and no way to reach the rest: scrolling *worked*, the
   * rows it scrolled to were simply cut off before they were drawn. Sizing the
   * window to the space means the slice never has anything left to remove.
   */
  private bodyCapacity(): number {
    const [, bh] = this.terminal.bodySize;
    const chrome = this.sheet ? this.sheet.heightFor(0) : 0;
    const rows = Math.floor((bh - chrome) / LINE) - BODY_ROW - 1;
    return Math.max(3, Math.min(18, rows));
  }

  private rescroll(): void {
    const n = fileScrollCount(this.files.index, this.library, this.nodeKind, this.fileIndex);
    this.scroll = new List(n, Math.min(this.bodyCapacity(), Math.max(3, n)));
    // Only a file that *is* a list gets a list's hit boxes. They were live on
    // every sheet, so the attribution notice highlighted and clicked rows of
    // prose that were not entries in anything.
    const rows = this.bodyRows;
    if (rows) {
      rows.view.visible = n > 0;
      rows.view.interactiveChildren = n > 0;
    }
    this.kindButtons.forEach((b) => {
      b.view.visible = FILES[this.files.index]?.ref === 'OC-0100';
    });
    // One hit box per *visible* row, resized whenever the window is. This is the
    // line that was missing: the widget could not resize, so it kept whatever
    // count it was built with — three, because it was built before the sheet had
    // been laid out and there was nothing to measure.
    rows?.setCount(this.scroll.rows);
    rows?.moveTo(0);
  }

  /**
   * §5.3 — the wheel scrolls the open file.
   *
   * Not the index. The index is six entries and always fully on screen; the
   * thing that scrolls is the one that overflows, and a wheel that moved the
   * selection between *files* while the reader was halfway down a list of
   * fifty-eight would throw away where they were.
   */
  private readonly onWheel = (e: WheelEvent): void => {
    if (this.mode !== 'doc' || this.docId !== 'files') return;
    if (this.scroll.length <= this.scroll.rows) return;
    e.preventDefault();
    this.assetVariant = null;
    this.scroll.scrollBy(e.deltaY > 0 ? 2 : -2);
    this.bodyRows?.moveTo(this.scroll.cursorRow);
    this.redraw();
  };

  /**
   * The selected asset, drawn.
   *
   * The register used to print the unit's render shape as a *word* — "hexagon",
   * "diamond" — which is a fact about the sprite and no use to anybody. The
   * renderer is right here and already knows how to draw one, so it draws it: the
   * same outline the operator meets on the floor, at the size a file plate would
   * be, beside the numbers.
   */
  private paintKinds(): void {
    this.kindButtons.forEach((b, i) => {
      b.focused = NODE_KINDS[i] === this.nodeKind;
      b.paint();
    });
  }

  private paintAsset(): void {
    const g = this.shape;
    if (!g || !this.sheet) return;
    g.clear();
    const ref = FILES[this.files.index]?.ref;
    if (ref !== 'OC-0200') return;
    const chassis = assetRows()[this.scroll.index];
    if (!chassis || !this.library.snapshot.codex.includes(chassis.id)) return;
    // The picture follows the record: pick a variant and the big glyph is that
    // variant, with the strip still underneath to pick another. Same page.
    const e = this.assetVariant
      ? (variantsOf(chassis.id).find((v) => v.id === this.assetVariant) ?? chassis)
      : chassis;

    const grid = this.sheet.grid;
    const met = this.library.snapshot.codex;
    const strip = [chassis, ...variantsOf(chassis.id)];

    // Centred in the columns the record reserved for it, rather than measured
    // out from the left edge — the strip used to start at PLATE_COL while the
    // picture sat 34px further in, so the two were never over each other.
    const cx = (grid.x(PLATE_COL) + grid.x(this.sheet.cols)) / 2;
    const bigY = grid.y(BODY_ROW + 2) + PLATE_R;
    const iconY = bigY + PLATE_R + 28;

    // The arena's drawing, not a copy of it: outline, interior, core, and the
    // marks — a Bulwark's shield arc, a Suppressor's field boundary. Those marks
    // are what the record is describing, so a picture without them is the wrong
    // picture.
    const scale = PLATE_R / LARGEST_ASSET;
    drawEnemy(g, e, cx, bigY, e.radius * scale, FACING, {
      colour: HUE_COLOR[e.hue] ?? C.ink,
      // Clamped to the plate. At true scale a Suppressor's field is five times
      // the space there is, so the ring reports that the field exists and is
      // larger than the body, and the number in the record reports how much.
      zone: e.zoneRadius ? Math.min(PLATE_R + 12, e.zoneRadius * scale) : 0,
    });

    // The chassis first, then every form built on it. Clicking one swaps the
    // record above; the chassis is in the strip so there is always a way back.
    for (const hit of this.variantHits) hit.destroy();
    this.variantHits = [];

    const iconScale = ICON_R / LARGEST_ASSET;
    let vx = cx - ((strip.length - 1) * ICON_STEP) / 2;
    for (const v of strip) {
      const known = met.includes(v.id);
      const on = v.id === e.id;
      drawEnemy(g, v, vx, iconY, Math.max(3, v.radius * iconScale), FACING, {
        colour: on ? C.bright : known ? (HUE_COLOR[v.hue] ?? C.ink) : C.dim,
        zone: 0,
      });
      if (on) {
        // The one being read is underlined rather than merely brighter: at
        // fifteen pixels a hue change is not a selection state.
        g.moveTo(vx - ICON_R, iconY + ICON_R + 6).lineTo(vx + ICON_R, iconY + ICON_R + 6);
        g.stroke({ width: 2, color: C.bright, alpha: 0.9 });
      }

      const box = new Container();
      box.eventMode = 'static';
      box.cursor = 'pointer';
      box.hitArea = new Rectangle(vx - ICON_STEP / 2, iconY - ICON_R - 4, ICON_STEP, ICON_R * 2 + 14);
      const id = v.id === chassis.id ? null : v.id;
      box.on('pointertap', () => {
        this.assetVariant = id;
        this.audio.chrome('click');
        this.redraw();
      });
      this.sheet.controls.addChild(box);
      this.variantHits.push(box);
      vx += ICON_STEP;
    }
  }

  private closeDoc(): void {
    this.rows?.destroy();
    this.begin?.destroy();
    // Everything a document owns dies with it. These three were left behind, so
    // opening a second document painted controls whose sheet had been destroyed
    // — `paint()` on a dead Button throws, `redraw` aborts before it lays out
    // any lines, and what is left on screen is a header and a stray stamp. That
    // was only reachable once the menu became clickable from inside a document,
    // which is why it looked like the menu broke the layout. The menu was fine.
    this.bodyRows?.destroy();
    this.shape?.destroy();
    for (const b of this.kindButtons) b.destroy();
    this.kindButtons = [];
    this.bodyRows = null;
    this.shape = null;
    this.rows = null;
    this.begin = null;
    if (this.sheet) {
      this.terminal.body.removeChild(this.sheet.view);
      this.sheet.destroy();
      this.sheet = null;
    }
    this.docId = '';
  }

  /**
   * BEGIN RUN. The channel gets to speak first.
   *
   * The operator commits, and *then* something cuts in — the run is held until
   * they have read it and does not begin behind the window. That is the moment
   * the channel is worth anything: an interruption at the menu is a notification,
   * and an interruption at the point of commitment is somebody stopping you.
   */
  private startRun(): void {
    this.audio.chrome('click');
    if (this.story) {
      this.story.advance('run-start', {
        runsCompleted: this.library.snapshot.runs,
        levelsOpened: [],
      });
      if (this.story.state.queue.length > 0) {
        this.holdingRun = true;
        this.showTransmission();
        return;
      }
    }
    this.finish();
  }

  // -------------------------------------------------------------------------
  // config
  // -------------------------------------------------------------------------

  /**
   * Move whichever field the cursor is on. One entry point, so the keyboard and
   * the pointer cannot end up doing different things to the same control.
   */
  /**
   * Push the saved tube onto the live glass.
   *
   * The filter was constructed with a hardcoded `scan: 0.3` and never touched
   * again, and `PHOSPHOR` — amber, green, ice, and the monochrome flag that
   * makes them mean anything — was reachable only from `shelllab`. The shader
   * has supported all of it since it was written; nothing was ever wired to it.
   */
  private applyGlass(): void {
    const s = this.library.snapshot.settings;
    const p = PHOSPHOR.find((x) => x.id === s.phosphor) ?? PHOSPHOR[0]!;
    this.glass.set({ scan: s.scanlines, mono: p.mono, tint: p.tint });
    this.tear.set({ scan: s.scanlines, mono: p.mono, tint: p.tint });
  }

  private adjust(d: number): void {
    const f = this.fields[this.cursor];
    if (!f) return;
    const s = this.library.snapshot.settings;
    const step = (v: number): number => Math.max(0, Math.min(1, Math.round((v + d * 0.05) * 100) / 100));

    if (f.id === 'muted') {
      this.library.setAudio({ muted: !s.muted });
      this.audio.setMuted(!s.muted);
    } else if (f.id === 'volume') {
      const v = step(s.volume);
      this.library.setAudio({ volume: v });
      this.audio.setVolume(v);
    } else if (f.id === 'music') {
      const v = step(s.music);
      this.library.setAudio({ music: v });
      this.audio.setMusicVolume(v);
    } else if (f.id === 'effects') {
      const v = step(s.effects);
      this.library.setAudio({ effects: v });
      this.audio.setSfxVolume(v);
    } else if (f.id === 'preset') {
      const ids = VIEW_PRESETS.map((p) => p.id);
      const cur = Math.max(0, ids.indexOf(presetIdFor(s.fx)));
      const next = VIEW_PRESETS[(cur + d + ids.length) % ids.length]!;
      this.library.setEffects(next.effects);
      applyEffects(next.effects);
    } else if (f.id.startsWith('fx:')) {
      const id = f.id.slice(3);
      if (VIEW_EFFECTS.some((e) => e.id === id)) {
        this.library.toggleEffect(id);
        applyEffects(this.library.snapshot.settings.fx);
      }
    } else if (f.id === 'beatSync') {
      this.library.setBeatSync(!s.beatSync);
    } else if (f.id === 'phosphor') {
      const i = Math.max(0, PHOSPHOR.findIndex((p) => p.id === s.phosphor));
      const next = PHOSPHOR[(i + d + PHOSPHOR.length) % PHOSPHOR.length]!;
      this.library.setGlass({ phosphor: next.id });
      this.applyGlass();
    } else if (f.id === 'scanlines') {
      this.library.setGlass({ scanlines: step(s.scanlines) });
      this.applyGlass();
    }
    this.audio.chrome('click');
    this.redraw();
  }

  // -------------------------------------------------------------------------
  // keys
  // -------------------------------------------------------------------------

  private back(): void {
    if (this.mode === 'doc') {
      // Inside a long file, the first ESC leaves the file rather than the
      // screen: backing out of a list you scrolled into should not also close
      // the thing you were reading.
      if (this.inBody) {
        this.inBody = false;
        this.paintKeys();
        return;
      }
      this.closeDoc();
      this.mode = 'terminal';
      this.terminal.busy = false;
      this.terminal.paint();
      this.paintKeys();
    } else if (this.mode === 'terminal') {
      this.mode = 'start';
      this.startLayer.visible = true;
      this.termLayer.visible = false;
    }
  }

  private handleKey(e: KeyboardEvent): void {
    // §8 — while the channel is open it owns the keyboard. There is deliberately
    // no Report control and never will be (§10 turns on its absence): the only
    // thing you can do with a transmission is finish reading it.
    if (this.intrusion) {
      this.closeTransmission();
      e.preventDefault();
      return;
    }
    // And a served notice owns it the same way: one key acknowledges.
    if (this.noticeSheet?.open) {
      this.closeNotice();
      e.preventDefault();
      return;
    }
    if (e.key === 'Escape') {
      this.back();
      e.preventDefault();
      return;
    }
    if (this.mode === 'start') {
      if (e.key === 'Enter' || e.key === ' ') this.enter();
      return;
    }

    if (this.mode === 'doc') {
      const v = vertical(e);
      const h = horizontal(e);
      if (this.docId === 'config' && h) {
        this.adjust(h);
        e.preventDefault();
        return;
      }
      if (this.docId === 'files' && h) {
        // Left and right step *into* and out of a long document's body, so the
        // vertical keys always mean one thing at a time.
        this.inBody = h > 0 && this.scroll.length > this.scroll.rows;
        this.paintKeys();
        e.preventDefault();
        return;
      }
      if (this.docId === 'files' && this.inBody && v) {
        this.scroll.move(v);
        this.redraw();
        e.preventDefault();
        return;
      }
      if (e.key === 'Enter' && this.docId === 'run') {
        this.startRun();
        e.preventDefault();
        return;
      }
      if (this.rows?.keys(e)) e.preventDefault();
      return;
    }

    const v = vertical(e);
    if (v) {
      this.terminal.move(v);
      this.audio.chrome('hover');
      e.preventDefault();
    } else if (e.key === 'Enter') {
      this.open(ENTRIES[this.terminal.index]!.id);
      e.preventDefault();
    }
  }

  // -------------------------------------------------------------------------
  // the loop — a hard 60
  // -------------------------------------------------------------------------

  private frame(): void {
    this.raf = requestAnimationFrame(() => this.frame());
    const now = performance.now() / 1000;
    let dt = now - this.last;
    this.last = now;
    if (dt > 0.25) dt = 0.25;
    this.acc += dt;
    if (this.acc < 1 / 60) return;
    const step = this.acc;
    this.acc = 0;
    this.glass.update(step);
    this.tear.update(step);
    this.intrusion?.update(step);
    this.backdrop.update(step, this.app.screen.width, this.app.screen.height);
    this.app.render();
  }
}

function presetIdFor(fx: readonly string[]): string {
  const name = VIEW_PRESETS.find((p) => {
    const a = [...p.effects].sort().join(',');
    const b = [...fx].sort().join(',');
    return a === b;
  });
  return name?.id ?? 'custom';
}
