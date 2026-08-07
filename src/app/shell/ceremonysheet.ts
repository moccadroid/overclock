/**
 * §19.7 — the Recompile ceremony, on paper. "A full-screen 2s ceremony
 * (skippable never — this is a ritual): the schematic burns down row by row,
 * Kernel forged, rebuild surge begins."
 *
 * On the Sheet, the ritual is a **RECOMPILE ORDER being executed**: the old
 * Engine's rows are struck through one by one — the way a clerk retires a
 * ledger — and then the Kernel line lands bright under them. The one moment of
 * grandeur in an otherwise dry UI, delivered in the driest possible dialect,
 * which is what makes it land.
 */
import { Container, Graphics } from 'pixi.js';
import { C, LINE, Sheet, blank, charW, head, type Line } from '../ui';

export const CEREMONY_SECONDS = 2;

const COLS = 56;

export class CeremonySheet {
  readonly view = new Container();

  private sheet: Sheet | null = null;
  private readonly veil = new Graphics();
  /**
   * Recreated per ceremony: it lives in the sheet's controls, and the sheet's
   * destroy takes its children with it. Reusing one instance crashed the
   * *second* Recompile of a run — clear() on a destroyed context.
   */
  private strikes: Graphics | null = null;
  private timer = 0;
  private rows: string[] = [];
  private kernelPercent = 0;
  private kernelTotal = 1;

  constructor(stage: Container) {
    this.view.visible = false;
    this.view.addChild(this.veil);
    stage.addChild(this.view);
    window.addEventListener('resize', () => this.layout());
  }

  get open(): boolean {
    return this.view.visible;
  }

  setOpen(open: boolean): void {
    if (!open) {
      this.sheet?.destroy();
      this.sheet = null;
      this.strikes = null;
    }
    this.view.visible = open;
  }

  /** Call with the Engine as it stood *before* the Recompile deleted it. */
  begin(rows: string[], kernelPercent: number, kernelTotal: number): void {
    this.setOpen(false);
    this.rows = rows;
    this.kernelPercent = kernelPercent;
    this.kernelTotal = kernelTotal;
    this.timer = 0;

    this.sheet = new Sheet({ head: 'RECOMPILE ORDER', ref: 'OC-001-K', stamp: 'EXECUTED' });
    this.strikes = new Graphics();
    this.sheet.controls.addChild(this.strikes);
    this.view.addChild(this.sheet.view);
    this.view.visible = true;
    this.paint();
    this.layout();
  }

  /** Returns true while the ceremony is still running. Never skippable. */
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
    if (!this.sheet) return;
    const burn = Math.min(1, this.timer / (CEREMONY_SECONDS * 0.55));
    const burned = Math.floor(burn * this.rows.length);
    const forged = this.timer > CEREMONY_SECONDS * 0.6;

    const lines: Line[] = [head('THE ENGINE, AS FILED'), blank()];
    const rowAt: number[] = [];
    this.rows.forEach((row, i) => {
      rowAt.push(lines.length);
      lines.push([[` ${row}`, i < burned ? C.faint : C.ink]]);
    });
    lines.push(blank());
    if (forged) {
      lines.push(
        [
          ['KERNEL FORGED ', C.bright],
          [` +${this.kernelPercent.toFixed(0)}%`, C.bright],
          [`   total ×${this.kernelTotal.toFixed(2)}`, C.faint],
        ],
        [['REBUILD SURGE — double XP, wider drafts.', C.dim]],
      );
    } else {
      lines.push([['measuring output…', C.dim]]);
    }
    this.sheet.setLines(lines);

    // The strike is drawn, not typed: a rule through a retired line, the way
    // paper actually gets corrected.
    if (!this.strikes) return;
    this.strikes.clear();
    for (let i = 0; i < burned; i++) {
      const y = this.sheet.grid.y(rowAt[i]!) + Math.round(LINE / 2) - 2;
      const width = Math.min(COLS - 2, this.rows[i]!.length + 2) * charW();
      this.strikes.rect(this.sheet.grid.x(1) - 2, y, width, 1).fill(C.dim);
    }
  }

  private layout(): void {
    if (!this.sheet) return;
    const W = window.innerWidth;
    const H = window.innerHeight;
    this.veil.clear().rect(0, 0, W, H).fill({ color: 0x000000, alpha: 0.82 });

    const rows = this.rows.length + 7;
    const w = Math.min(Math.round(COLS * charW()) + 112, W - 48);
    const h = Math.min(this.sheet.heightFor(rows), H - 40);
    this.sheet.layout(w, h);
    this.sheet.view.position.set(Math.round((W - w) / 2), Math.round((H - h) / 2));
  }
}
