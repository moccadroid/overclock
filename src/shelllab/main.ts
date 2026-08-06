/**
 * Shell Lab — the shell, per NARRATIVE §5. **Nothing in the game imports this.**
 *
 * Start screen → LOGIN → the terminal, and the terminal is everything from then
 * on. `EXIT` is not here: this is the browser build (§16.4).
 *
 * ---
 *
 * **The intrusion fires after BEGIN RUN, not when `run` is opened.**
 *
 * That is the only placement that cannot be skipped. Opening a menu entry is a
 * browse; committing the run is a decision, and in the gap between authorising
 * the episode and the episode starting, the operator is looking at the screen
 * and waiting. Something else gets on the wire there, and the thing they just
 * asked for is on the far side of it.
 *
 * While it is up the *terminal misbehaves* — bands tear, channels split, noise
 * lifts. The interference belongs to the glass rather than to the message,
 * because the fiction is that something else is driving the display, not that
 * the message has a spooky font (§4.2).
 */
import { Application, Container, Text } from 'pixi.js';
import {
  Button,
  C,
  ENTRIES,
  Glass,
  PHOSPHOR,
  Rows,
  Sheet,
  Terminal,
  Transmission,
  horizontal,
  style,
  vertical,
} from '../app/ui';
import { Backdrop } from '../app/shell/backdrop';
import {
  AXIOM_ROW,
  AXIOMS,
  CONFIG_ROW,
  CONFIG_SHEET,
  DIRECTORY,
  FILES_SHEET,
  R1,
  RUN_SHEET,
  configLines,
  directoryLines,
  fileBody,
  runLines,
} from './docs';

type Mode = 'start' | 'terminal' | 'doc' | 'intrusion';

const app = new Application();
const backdrop = new Backdrop();
const glass = new Glass({ scan: 0.3, vignette: 0.5 });
const tearGlass = new Glass({ tear: 1, split: 1.8, noise: 0.07, scan: 0.34 });

const startLayer = new Container();
const termLayer = new Container();
const terminal = new Terminal({ site: '██', operator: '████████', shift: 1147, revision: '04' });

const title = new Text({ text: 'OVERCLOCK', style: style(34, 0xffffff, 19) });
const tagline = new Text({ text: 'the player is the exploit', style: style(11, 0x3f5570, 4) });
const login = new Text({ text: 'LOGIN', style: style(17, C.ink, 6) });

let mode: Mode = 'start';
let phosphor = 0;
let scan = true;
const values = { volume: 0.8, music: 0.65 };

let intrusion: Transmission | null = null;
let sheet: Sheet | null = null;
let rows: Rows | null = null;
let button: Button | null = null;
let docId = '';
let cursor = 0;

async function boot(): Promise<void> {
  await app.init({
    background: 0x000000,
    resizeTo: window,
    antialias: true,
    autoDensity: true,
    resolution: Math.min(2, window.devicePixelRatio || 1),
    autoStart: false,
  });
  app.ticker.stop();
  document.body.appendChild(app.canvas);

  backdrop.init();
  app.stage.addChild(backdrop.root, startLayer, termLayer);
  // The glass is the whole machine, so it goes over everything including the
  // backdrop — the slabs are behind the same tube the documents are on.
  app.stage.filters = [glass.filter];

  for (const t of [title, tagline, login]) t.anchor.set(0.5, 0);
  login.eventMode = 'static';
  login.cursor = 'pointer';
  login.on('pointerover', () => {
    login.style = style(17, 0xffffff, 6);
  });
  login.on('pointerout', () => {
    login.style = style(17, C.ink, 6);
  });
  login.on('pointertap', () => enterTerminal());
  startLayer.addChild(title, tagline, login);

  terminal.onPick = (i) => openDoc(ENTRIES[i]!.id);
  termLayer.addChild(terminal.view);
  termLayer.visible = false;

  window.addEventListener('resize', layout);
  window.addEventListener('keydown', onKey);

  layout();
  (window as unknown as Record<string, unknown>).__lab = {
    app,
    terminal,
    mode: () => mode,
    step: () => frame(true),
    key: (k: string) => onKey(new KeyboardEvent('keydown', { key: k })),
  };
  requestAnimationFrame(() => frame());
}

function layout(): void {
  const w = app.screen.width;
  const h = app.screen.height;
  backdrop.resize(w, h);

  const cx = Math.round(w / 2);
  const top = Math.round(h * 0.34);
  title.position.set(cx, top);
  tagline.position.set(cx, top + 52);
  login.position.set(cx, top + 128);

  terminal.layout(w, h);
  if (sheet) redraw();
  paintKeys();
}

function paintKeys(): void {
  if (mode === 'intrusion') terminal.setKeys('');
  else if (mode === 'doc') {
    terminal.setKeys('[ESC] back    [↑↓/WS] select    [←→/AD] adjust    [1..5] display');
  } else terminal.setKeys('[ESC] log out    [↑↓/WS] select    [ENTER] open    [1..5] display');
}

function enterTerminal(): void {
  mode = 'terminal';
  startLayer.visible = false;
  termLayer.visible = true;
  terminal.busy = false;
  terminal.paint();
  paintKeys();
}

// ---------------------------------------------------------------------------
// documents
// ---------------------------------------------------------------------------

/** Rebuild the open document and size the sheet to what is typed on it. */
function redraw(): void {
  if (!sheet) return;
  let lines =
    docId === 'run'
      ? runLines(rows?.index ?? 0)
      : docId === 'files'
        ? [...directoryLines(cursor), ...fileBody(cursor)]
        : configLines(cursor, {
            phosphor: PHOSPHOR[phosphor]!.label,
            scan,
            volume: values.volume,
            music: values.music,
          });

  const [bw, bh] = terminal.bodySize;
  const want = sheet.heightFor(lines.length);
  // A sheet is as long as what is typed on it, but never longer than the space
  // the terminal has: past that the body is trimmed rather than allowed to run
  // out through the frame, which is what the first pass did.
  if (want > bh) {
    const fit = Math.max(4, Math.floor((bh - sheet.heightFor(0)) / 23));
    lines = lines.slice(0, fit);
  }
  sheet.layout(Math.min(980, bw), Math.min(want, bh));
  sheet.setLines(lines);
}

function openDoc(id: string): void {
  closeDoc();
  docId = id;
  cursor = 0;
  mode = 'doc';
  terminal.busy = true;
  terminal.paint();

  sheet = new Sheet(id === 'run' ? RUN_SHEET : id === 'files' ? FILES_SHEET : CONFIG_SHEET);
  terminal.body.addChild(sheet.view);
  redraw();

  if (id === 'run') {
    // ENTER anywhere on this sheet commits: there is one action on an
    // operations order and making the player first travel to a button to reach
    // it is a form, not a console.
    const commit = () => openIntrusion(R1);
    rows = new Rows(sheet.grid, {
      row: AXIOM_ROW,
      count: AXIOMS.length,
      col: 0,
      cols: sheet.cols,
      onMove: redraw,
      onCommit: commit,
    });
    button = new Button(sheet.grid, 'BEGIN RUN', {
      col: 3,
      row: AXIOM_ROW + AXIOMS.length + 3,
      onPress: commit,
    });
    // Lit from the start, because it is the only thing on the page to do.
    button.focused = true;
    button.paint();
    sheet.controls.addChild(rows.view, button.view);
  } else {
    const count = id === 'files' ? DIRECTORY.length : 4;
    rows = new Rows(sheet.grid, {
      row: id === 'files' ? 2 : CONFIG_ROW,
      count,
      col: 0,
      cols: sheet.cols,
      onMove: (i) => {
        cursor = i;
        redraw();
      },
      onCommit: (i) => {
        if (id !== 'config') return;
        cursor = i;
        adjust(1);
      },
    });
    sheet.controls.addChild(rows.view);
  }
  paintKeys();
}

function closeDoc(): void {
  rows?.destroy();
  button?.destroy();
  rows = null;
  button = null;
  if (sheet) {
    terminal.body.removeChild(sheet.view);
    sheet.destroy();
    sheet = null;
  }
  docId = '';
}

// ---------------------------------------------------------------------------
// the intrusion
// ---------------------------------------------------------------------------

function openIntrusion(lines: string[]): void {
  closeDoc();
  mode = 'intrusion';
  terminal.busy = true;
  terminal.paint();
  intrusion = new Transmission(lines);
  intrusion.view.position.set(10, 8);
  intrusion.view.eventMode = 'static';
  intrusion.view.cursor = 'pointer';
  intrusion.view.on('pointertap', () => dismissIntrusion());
  terminal.view.filters = [tearGlass.filter];
  terminal.body.addChild(intrusion.view);
  paintKeys();
}

/**
 * One step out of the intrusion, whichever input asked for it.
 *
 * The first press finishes the typing and the second closes. `ESC` works here
 * like it works everywhere else — but it lands the message on screen first
 * rather than skipping it, which is the whole reason the beat is placed where it
 * is. Nothing is trapped; nothing is missed either.
 */
function dismissIntrusion(): void {
  if (!intrusion) return;
  if (!intrusion.done) intrusion.finish();
  else closeIntrusion();
}

function closeIntrusion(): void {
  if (!intrusion) return;
  intrusion.destroy();
  intrusion = null;
  terminal.view.filters = [];
  mode = 'terminal';
  terminal.busy = false;
  terminal.paint();
  paintKeys();
}

// ---------------------------------------------------------------------------
// keys
// ---------------------------------------------------------------------------

/** Move whichever config field the cursor is on. Shared by keys and clicks. */
function adjust(d: number): void {
  if (cursor === 0) values.volume = clamp01(values.volume + d * 0.05);
  else if (cursor === 1) values.music = clamp01(values.music + d * 0.05);
  else if (cursor === 2) phosphor = (phosphor + d + PHOSPHOR.length) % PHOSPHOR.length;
  else scan = !scan;
  applyGlass();
  redraw();
}

function applyGlass(): void {
  const p = PHOSPHOR[phosphor]!;
  glass.set({ mono: p.mono, tint: p.tint, scan: scan ? 0.3 : 0 });
  tearGlass.set({ mono: p.mono, tint: p.tint, scan: scan ? 0.34 : 0 });
  if (docId === 'config') redraw();
}

/** ESC always does something, from wherever you are. */
function back(): void {
  if (mode === 'intrusion') dismissIntrusion();
  else if (mode === 'doc') {
    closeDoc();
    mode = 'terminal';
    terminal.busy = false;
    terminal.paint();
    paintKeys();
  } else if (mode === 'terminal') {
    closeDoc();
    mode = 'start';
    startLayer.visible = true;
    termLayer.visible = false;
  }
}

function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    back();
    return;
  }
  if (mode === 'start') {
    if (e.key === 'Enter' || e.key === ' ') enterTerminal();
    return;
  }

  // Display experiments work everywhere except mid-intrusion — the point of
  // them is comparing tubes against real documents, which means they have to be
  // reachable while a document is open.
  if (mode !== 'intrusion' && e.key >= '1' && e.key <= '5') {
    if (e.key === '5') scan = !scan;
    else phosphor = Number(e.key) - 1;
    applyGlass();
    return;
  }

  if (mode === 'intrusion') {
    // The only thing you can do with a transmission is finish reading it.
    // NARRATIVE §10 — there is deliberately no report action here, ever.
    dismissIntrusion();
    return;
  }

  if (mode === 'doc') {
    const h = horizontal(e);
    if (docId === 'config' && h) {
      const d = h;
      adjust(d);
      return;
    }
    if (button?.keys(e)) return;
    rows?.keys(e);
    return;
  }

  const v = vertical(e);
  if (v) terminal.move(v);
  else if (e.key === 'Enter') openDoc(ENTRIES[terminal.index]!.id);
}

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

// ---------------------------------------------------------------------------
// the loop — a hard 60
// ---------------------------------------------------------------------------

const STEP = 1 / 60;
let last = performance.now() / 1000;
let acc = 0;

function frame(forced = false): void {
  if (!forced) requestAnimationFrame(() => frame());
  const now = performance.now() / 1000;
  let dt = now - last;
  last = now;
  if (dt > 0.25) dt = 0.25;
  acc += dt;
  if (acc < STEP && !forced) return;
  const step = acc;
  acc = 0;

  glass.update(step);
  tearGlass.update(step);
  intrusion?.update(step);
  backdrop.update(step, app.screen.width, app.screen.height);
  app.render();
}

void boot();
