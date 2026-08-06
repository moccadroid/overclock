/**
 * The document UI — the terminal. NARRATIVE §5.2.
 *
 * **The one constant surface.** Everything in the game flows from here and
 * everything returns here: end a run, close a file, dismiss a message, and you
 * are back at this. That is why §11 destroys this specifically — you cannot take
 * away the safe surface if the player never had one.
 *
 * Three details in the header carry the whole plot and all three are present
 * from the first session:
 *
 *   **operator ████████** — the operator's own name is redacted *from them*.
 *   You are not cleared for yourself.
 *
 *   **shift 1147** — the run counter, and it does not start at 1. Nobody asks
 *   who did the first 1146.
 *
 *   **revision 04** — the site restoration index (§9, B10). The game was always
 *   cycle four, and nobody notices until RESET makes it 05.
 *
 * The footer carries the keys, and that is the right home for them: a terminal
 * tells you `[ESC] exit` because terminals do. A Bureau memo does not print
 * keyboard hints on itself, which is why the `Sheet` no longer carries any.
 */
import { Container, Graphics, Text } from 'pixi.js';
import { C, LINE, style } from './tokens';

export interface TerminalState {
  site: string;
  operator: string;
  shift: number;
  revision: string;
}

/** The menu is three words. NARRATIVE §5.3 — you do not play, you run. */
export interface Entry {
  id: string;
  word: string;
  gloss: string;
}

export const ENTRIES: Entry[] = [
  { id: 'run', word: 'run', gloss: 'execute the cycle' },
  { id: 'files', word: 'files', gloss: 'what you are cleared to read' },
  { id: 'config', word: 'config', gloss: '' },
];

const PAD = 40;
const HEAD = 92;
const FOOT = 40;

export class Terminal {
  readonly view = new Container();
  /** Documents and messages open in here. */
  readonly body = new Container();

  private readonly chrome = new Graphics();
  private readonly band = new Graphics();
  private readonly title: Text;
  private readonly ident: Text;
  private readonly keys: Text;
  private readonly words: Text[] = [];
  private readonly glosses: Text[] = [];

  private w = 0;
  private h = 0;
  index = 0;
  /** True while a document is open — the menu dims and hands over the arrows. */
  busy = false;
  /** Fired when a word is clicked. The keyboard path goes through the caller. */
  onPick: ((index: number) => void) | null = null;

  constructor(state: TerminalState) {
    this.title = new Text({ text: '', style: style(13, C.bright, 7) });
    this.ident = new Text({ text: '', style: style(11, C.dim, 3) });
    this.keys = new Text({ text: '', style: style(11, C.faint, 3) });

    for (let i = 0; i < ENTRIES.length; i++) {
      const e = ENTRIES[i]!;
      const word = new Text({ text: e.word, style: style(17, C.ink, 5) });
      const gloss = new Text({ text: e.gloss, style: style(11, C.faint, 3) });
      // Pointing at a word moves the cursor to it, so the mouse and the keyboard
      // are driving the same selection rather than two competing ones.
      word.eventMode = 'static';
      word.cursor = 'pointer';
      word.on('pointerover', () => {
        if (this.busy) return;
        this.index = i;
        this.paint();
      });
      // Picking works while a document is open, so the three words are a menu
      // rather than a menu that stops being one the moment it is used. Hovering
      // still does not move the cursor under a sheet — that would drag the
      // selection around behind whatever the reader is actually looking at.
      word.on('pointertap', () => this.onPick?.(i));
      this.words.push(word);
      this.glosses.push(gloss);
    }

    this.view.addChild(this.chrome, this.band, this.title, this.ident, this.keys);
    for (let i = 0; i < this.words.length; i++) this.view.addChild(this.words[i]!, this.glosses[i]!);
    this.view.addChild(this.body);
    this.setState(state);
  }

  setState(s: TerminalState): void {
    this.title.text = `BUREAU TERMINAL — SITE ${s.site}`;
    // Three tells, one line, from minute one.
    this.ident.text = `operator ${s.operator}          shift ${s.shift}          revision ${s.revision}`;
  }

  setKeys(text: string): void {
    this.keys.text = text;
  }

  /** Size and position, given the whole viewport. Big: it is the machine. */
  layout(vw: number, vh: number): void {
    const m = Math.round(Math.min(64, vw * 0.045));
    const w = vw - m * 2;
    const h = vh - m * 2;
    this.w = w;
    this.h = h;
    this.view.position.set(m, m);

    this.chrome.clear();
    this.chrome.rect(0, 0, w, h).fill({ color: C.void, alpha: 0.94 });
    this.chrome.rect(0, 0, w, 1).fill(C.paper);
    this.chrome.rect(0, h - 1, w, 1).fill(C.paper);
    this.chrome.rect(0, 0, 1, h).fill(C.paper);
    this.chrome.rect(w - 1, 0, 1, h).fill(C.paper);
    this.chrome.rect(PAD, HEAD - 22, w - PAD * 2, 1).fill(C.faint);
    this.chrome.rect(PAD, h - FOOT, w - PAD * 2, 1).fill(C.rule);

    this.title.position.set(PAD, 30);
    this.ident.position.set(PAD, 54);
    this.keys.position.set(PAD, h - FOOT + 16);

    for (let i = 0; i < this.words.length; i++) {
      const y = HEAD + 22 + i * (LINE + 14);
      this.words[i]!.position.set(PAD + 24, y);
      this.glosses[i]!.position.set(PAD + 160, y + 6);
    }
    this.body.position.set(PAD, HEAD + 22 + this.words.length * (LINE + 14) + 26);
    this.paint();
  }

  /** Where a document may draw, in pixels, inside the terminal. */
  get bodySize(): [number, number] {
    return [this.w - PAD * 2, this.h - FOOT - 16 - this.body.y];
  }

  paint(): void {
    this.band.clear();
    for (let i = 0; i < this.words.length; i++) {
      const on = i === this.index && !this.busy;
      this.words[i]!.style = style(17, this.busy ? C.dim : on ? 0xffffff : C.ink, 5);
      this.glosses[i]!.style = style(11, this.busy ? C.rule : C.faint, 3);
      if (on) {
        this.band
          .rect(PAD, this.words[i]!.y - 5, this.w - PAD * 2, LINE + 8)
          .fill({ color: C.ink, alpha: 0.07 });
      }
    }
  }

  move(d: number): void {
    const n = ENTRIES.length;
    this.index = (((this.index + d) % n) + n) % n;
    this.paint();
  }
}
