/**
 * Keyboard input. GDD §4.2 — movement and one dash are the entire physical verb
 * set. There is no aim axis here and there must never be one (§24).
 */
import type { InputState } from '../sim/world';

export type Command = 'editor' | 'pause' | 'draft1' | 'draft2' | 'draft3' | 'reroll' | 'confirm';

const MOVE_KEYS: Record<string, [number, number]> = {
  KeyW: [0, -1],
  ArrowUp: [0, -1],
  KeyS: [0, 1],
  ArrowDown: [0, 1],
  KeyA: [-1, 0],
  ArrowLeft: [-1, 0],
  KeyD: [1, 0],
  ArrowRight: [1, 0],
};

const COMMAND_KEYS: Record<string, Command> = {
  Tab: 'editor',
  Escape: 'pause',
  Digit1: 'draft1',
  Digit2: 'draft2',
  Digit3: 'draft3',
  KeyR: 'reroll',
  // E is held to channel beacons (§4.2), so it cannot double as a confirm key.
  Enter: 'confirm',
};

export class Input {
  private readonly held = new Set<string>();
  private readonly listeners = new Set<(cmd: Command) => void>();
  private dashQueued = false;

  constructor(target: Window = window) {
    target.addEventListener('keydown', (ev) => {
      // Tab would move focus out of the canvas; the editor owns that key (§4.2).
      if (ev.code === 'Tab' || ev.code === 'Space') ev.preventDefault();
      if (ev.repeat) return;
      this.held.add(ev.code);
      if (ev.code === 'Space') this.dashQueued = true;
      const cmd = COMMAND_KEYS[ev.code];
      if (cmd) for (const fn of this.listeners) fn(cmd);
    });
    target.addEventListener('keyup', (ev) => this.held.delete(ev.code));
    target.addEventListener('blur', () => this.held.clear());
  }

  onCommand(fn: (cmd: Command) => void): void {
    this.listeners.add(fn);
  }

  /** Read and clear the per-tick input. Dash is edge-triggered, not held. */
  consume(): InputState {
    let x = 0;
    let y = 0;
    for (const code of this.held) {
      const dir = MOVE_KEYS[code];
      if (dir) {
        x += dir[0];
        y += dir[1];
      }
    }
    const dash = this.dashQueued;
    this.dashQueued = false;
    const len = Math.hypot(x, y);
    if (len > 1) {
      x /= len;
      y /= len;
    }
    return { moveX: x, moveY: y, dash, interact: this.held.has('KeyE') };
  }

  clear(): void {
    this.held.clear();
    this.dashQueued = false;
  }
}
