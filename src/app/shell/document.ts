/**
 * A document, filed on top of whatever was happening. LEVELS §6, NARRATIVE §5.
 *
 * One component for every Bureau paper that interrupts play: the notice that
 * greets a first shift, the onboarding sheets read at stations, the files
 * recovered from fragments. It is the same `Sheet` stationery the episode
 * report and the terminal's files use — a department does not redesign its
 * paper per memo, and the player must recognise the shape before the words.
 *
 * Documents are **typeset and arrive whole**. Typing belongs to the channel
 * (ui/transmission.ts) and to nobody else; the shape of the page is the
 * firewall between the voices (§13.5).
 *
 * Drawn into the caller's stage rather than a second Application, for the same
 * reason EpisodeReport is: one WebGL context.
 */
import { Container, Graphics, Rectangle } from 'pixi.js';
import { C, LINE, Sheet, charW, type Line } from '../ui';
import { beatLines } from '../../story/layout';
import type { Beat } from '../../story/script';

/** Body width, in characters. Bureau paragraphs read best short. */
const COLS = 58;

export interface DocumentSpec {
  beat: Beat;
  /** Body block indices to show. Omitted means the whole document. */
  blocks?: readonly number[];
  /** A dim line under the body — 'RECOVERED — FILED TO TERMINAL', etc. */
  note?: string;
  /** The dismissal hint, dim, last. */
  hint?: string;
}

export class DocumentSheet {
  readonly view = new Container();

  private sheet: Sheet | null = null;
  private readonly veil = new Graphics();
  private lines: Line[] = [];
  private offset = 0;
  private rows = 0;
  private onClose: (() => void) | null = null;

  private readonly onWheel = (e: WheelEvent): void => {
    if (!this.open) return;
    e.preventDefault();
    this.scrollBy(e.deltaY > 0 ? 3 : -3);
  };

  constructor(stage: Container) {
    this.view.visible = false;
    this.view.addChild(this.veil);
    stage.addChild(this.view);
    window.addEventListener('resize', () => this.layout());
    window.addEventListener('wheel', this.onWheel, { passive: false });
  }

  get open(): boolean {
    return this.view.visible;
  }

  show(spec: DocumentSpec, onClose: () => void): void {
    const body = spec.blocks
      ? spec.blocks.map((i) => spec.beat.body[i]).filter((b) => b !== undefined)
      : spec.beat.body;
    const lines = beatLines(body, COLS);
    if (spec.blocks && spec.blocks.length < spec.beat.body.length) {
      // The same two lines the terminal prints under a partial file, so the two
      // surfaces describe one filing system.
      lines.push(
        [],
        [['This document is incomplete. Sections are recovered', C.faint]],
        [['separately and filed as they arrive.', C.faint]],
      );
    }
    if (spec.note) lines.push([], [[spec.note, C.faint]]);
    const furniture = spec.beat.sheet ?? { head: 'DOCUMENT', ref: '████' };
    this.showLines(furniture, lines, onClose, spec.hint);
  }

  /**
   * Any lines on any stationery — the primer rides this, and anything else
   * that is a reference rather than a story beat.
   */
  showLines(
    furniture: { head: string; ref: string; stamp?: string },
    lines: Line[],
    onClose: () => void,
    hint?: string,
  ): void {
    this.close();
    this.onClose = onClose;
    this.lines = lines;
    if (hint) this.lines.push([], [[hint, C.dim]]);
    this.offset = 0;

    this.sheet = new Sheet({
      head: furniture.head,
      ref: furniture.ref,
      ...(furniture.stamp ? { stamp: furniture.stamp } : {}),
    });
    this.view.addChild(this.sheet.view);

    // Anywhere on the paper (or off it) files the document. Documents have no
    // controls: the only thing you can do with one is finish reading it.
    this.view.eventMode = 'static';
    this.view.hitArea = new Rectangle(-8000, -8000, 16000, 16000);
    this.view.removeAllListeners('pointertap');
    this.view.on('pointertap', () => this.onClose?.());

    this.view.visible = true;
    this.layout();
  }

  close(): void {
    this.sheet?.destroy();
    this.sheet = null;
    this.view.visible = false;
    this.onClose = null;
  }

  private scrollBy(d: number): void {
    const max = Math.max(0, this.lines.length - this.rows);
    const next = Math.max(0, Math.min(max, this.offset + d));
    if (next === this.offset) return;
    this.offset = next;
    this.paint();
  }

  layout(): void {
    if (!this.sheet) return;
    const W = window.innerWidth;
    const H = window.innerHeight;
    this.veil.clear().rect(0, 0, W, H).fill({ color: 0x000000, alpha: 0.72 });

    const w = Math.min(Math.round(COLS * charW()) + 112, W - 48);
    // As tall as what is typed on it, and no taller than the glass.
    const wanted = this.sheet.heightFor(this.lines.length);
    const h = Math.min(wanted, H - 48);
    this.rows = Math.floor((h - this.sheet.originY - 54 - 3 * LINE) / LINE);
    this.sheet.layout(w, h);
    this.sheet.view.position.set(Math.round((W - w) / 2), Math.round((H - h) / 2));
    this.paint();
  }

  private paint(): void {
    this.sheet?.setLines(this.lines.slice(this.offset, this.offset + Math.max(1, this.rows)));
  }
}
