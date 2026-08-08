/**
 * The bezel. The run, inside the machine.
 *
 * The HUD was six corners of free-floating text over the arena — the last thing
 * in the game that was not the Bureau's. This is the frame it goes back into: the
 * arena is what a window *contains*, and the instrumentation is recessed into the
 * chrome around it.
 *
 * ---
 *
 * The readouts are here too, on `Grid`s — the same object every document in the
 * game is drawn with, so they are in the same palette, at the same density, under
 * the same tube. They were six absolutely-positioned HTML divs, which could never
 * take the player's phosphor and kept their own opinions about colour in a
 * stylesheet a long way from `tokens.ts`. `readouts.ts` decides what they say.
 *
 * **A bezel, not four windows.**
 *
 * Windows are things you open. The HUD is always there and never closes, so
 * making it draggable panels would invite the player to spend a run rearranging
 * their own dashboard. One frame, fixed, in the same chrome the desk uses — so
 * the run and the workstation are visibly the same machine without the run
 * acquiring furniture it does not need.
 *
 * **Wide top and bottom, hairline sides.** A bezel costs field of view, and
 * bullets come from the sides, so it is spent on the axis where it is cheapest —
 * and it matches the desk, where the strip runs along the bottom. The thickness is
 * mirrored into `ui.css` as `--bezel-top`/`--bezel-bottom`; the readouts are
 * positioned against those, so the two cannot drift apart.
 *
 * Drawn on the run's `chromeLayer`, so it wears the player's phosphor. The old
 * DOM HUD never could: that is half the reason this exists.
 */
import { Container, Graphics, Text } from 'pixi.js';
import type { World } from '../../sim/world';
import { C, Grid, LINE, charW, clockLabel, style } from '../ui';
import {
  alertLine,
  diagnosticLines,
  engineLines,
  operatorLines,
  pressureLines,
} from './readouts';

/** Frame thickness, in pixels. */
export const BEZEL = { top: 30, bottom: 26, side: 6 } as const;

export interface BezelState {
  /** Site designation and the room the operator is standing in. */
  site: string;
  room: string;
  shift: number;
  /** The shift clock, in minutes since midnight — the desk's own clock, running. */
  clock: number;
  /** A transient line with nowhere else to live. Mute, mostly. */
  notice: string;
  /** The frame-cost line, already formatted. */
  fps: string;
  /** True while the engine is over its Heat line. The frame answers, not the arena. */
  hot: boolean;
}

const KEYS = 'H help · TAB engine · SPACE dash · E channel · M mute';

export class Bezel {
  readonly view = new Container();

  private readonly frame = new Graphics();
  private readonly title: Text;
  private readonly ref: Text;
  private readonly clock: Text;
  private readonly keys: Text;

  /**
   * The four readout panels, as grids.
   *
   * Left-aligned inside their own columns rather than right-aligned against the
   * edge: a `Grid` lays out by column from its origin, and a panel that starts at a
   * known column is stabler to read than one whose text slides as its longest line
   * changes.
   */
  private readonly operator = new Grid();
  private readonly pressure = new Grid();
  private readonly engine = new Grid();
  private readonly diagnostics = new Grid();
  private readonly alert = new Grid();

  private w = 0;
  private h = 0;
  private hot = false;

  constructor() {
    this.title = new Text({ text: '', style: style(12, C.bright, 6) });
    // The form number, where every other window in the game keeps it. `R` for the
    // run: the episode is a filed document like everything else.
    this.ref = new Text({ text: 'OC-1147-R', style: style(10, C.dim, 3) });
    this.ref.anchor.set(1, 0);
    this.clock = new Text({ text: '', style: style(12, C.ink, 5) });
    this.clock.anchor.set(1, 0);
    this.keys = new Text({ text: KEYS, style: style(10, C.rule, 3) });

    for (const t of [this.title, this.ref, this.clock, this.keys]) t.eventMode = 'none';
    this.view.addChild(
      this.frame,
      this.title,
      this.ref,
      this.clock,
      this.keys,
      this.operator.view,
      this.pressure.view,
      this.engine.view,
      this.diagnostics.view,
      this.alert.view,
    );
  }

  layout(w: number, h: number): void {
    this.w = w;
    this.h = h;
    this.paint();

    this.title.position.set(BEZEL.side + 12, Math.round((BEZEL.top - 12) / 2));
    this.ref.position.set(w - BEZEL.side - 12, Math.round((BEZEL.top - 10) / 2) + 1);
    this.clock.position.set(w - BEZEL.side - 110, Math.round((BEZEL.top - 12) / 2));
    this.keys.position.set(BEZEL.side + 12, h - BEZEL.bottom + Math.round((BEZEL.bottom - 12) / 2));
    // The panels, inside the frame. Widths are in characters, so a column that
    // fits at 1280 fits at every size above it.
    const col = (n: number): number => Math.round(n * charW());
    const inset = BEZEL.side + 14;
    this.operator.view.position.set(inset, BEZEL.top + 10);
    this.pressure.view.position.set(Math.round(w / 2) - col(28), BEZEL.top + 10);
    this.engine.view.position.set(w - inset - col(46), BEZEL.top + 10);
    this.diagnostics.view.position.set(inset, h - BEZEL.bottom - LINE - 6);
    this.alert.view.position.set(Math.round(w / 2) - col(16), h - BEZEL.bottom - LINE * 2 - 6);
  }

  update(world: World, s: BezelState): void {
    this.title.text = `SITE ${s.site}   ${s.room.toUpperCase()}   SHIFT ${s.shift}`;
    this.clock.text = clockLabel(s.clock);
    this.operator.set(operatorLines(world));
    this.pressure.set(pressureLines(world));
    this.engine.set(engineLines(world));
    this.diagnostics.set(diagnosticLines(world, s.fps));
    this.alert.set([alertLine(world, s.notice)]);
    if (s.hot !== this.hot) {
      this.hot = s.hot;
      this.paint();
    }
  }

  /**
   * The frame.
   *
   * Four strips and two rules. The rules are the only thing that ever changes
   * colour: over the Heat line the bottom rule goes to signal, so **the machine
   * reacts and the arena does not** — the one surface that must never be restyled
   * mid-fight is the one you are aiming at.
   */
  private paint(): void {
    const { top, bottom, side } = BEZEL;
    const w = this.w;
    const h = this.h;
    const panel = 0x05070c;

    this.frame.clear();
    this.frame.rect(0, 0, w, top).fill({ color: panel, alpha: 1 });
    this.frame.rect(0, h - bottom, w, bottom).fill({ color: panel, alpha: 1 });
    this.frame.rect(0, top, side, h - top - bottom).fill({ color: panel, alpha: 1 });
    this.frame.rect(w - side, top, side, h - top - bottom).fill({ color: panel, alpha: 1 });

    // The inner edge, which is where a bezel meets its screen.
    this.frame.rect(side, top - 1, w - side * 2, 1).fill(C.faint);
    this.frame.rect(side, h - bottom, w - side * 2, 1).fill(this.hot ? C.signal : C.rule);
    // And the outer, so the machine has an edge of its own.
    this.frame.rect(0, 0, w, 1).fill(C.rule);
    this.frame.rect(0, h - 1, w, 1).fill(C.rule);
  }

  destroy(): void {
    this.view.destroy({ children: true });
  }
}
