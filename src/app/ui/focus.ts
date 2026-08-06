/**
 * The document UI — the focus stack.
 *
 * One owner of the keyboard at a time, and the most recently opened thing owns
 * it. A handler returns true when it has consumed the key; anything it does not
 * consume falls through to whatever was under it.
 *
 * This exists early on purpose. The alternative is a global `onKey` if-chain,
 * which survives exactly as long as there is one screen — the moment a sheet
 * contains a list, and the list contains a tab strip, "which of these three
 * things did the arrow key mean" becomes a question no if-chain answers twice
 * the same way.
 */
export type KeyHandler = (e: KeyboardEvent) => boolean;

export class Focus {
  private readonly stack: KeyHandler[] = [];

  push(handler: KeyHandler): void {
    this.stack.push(handler);
  }

  /** Remove a handler wherever it is, not just from the top — a sheet can close
   *  while something it opened is still on the stack. */
  remove(handler: KeyHandler): void {
    const i = this.stack.lastIndexOf(handler);
    if (i >= 0) this.stack.splice(i, 1);
  }

  clear(): void {
    this.stack.length = 0;
  }

  /** Offer a key from the top down. Returns true once something takes it. */
  handle(e: KeyboardEvent): boolean {
    for (let i = this.stack.length - 1; i >= 0; i--) {
      if (this.stack[i]!(e)) return true;
    }
    return false;
  }
}
