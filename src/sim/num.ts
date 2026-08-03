/**
 * Arithmetic the sim is allowed to use.
 *
 * `Math.hypot` is **implementation-approximated** — the spec lets every engine
 * return a different result, and they do. A run recorded in Chrome and replayed
 * in Node diverged after thirty seconds because of it: enemy positions differed
 * by about 1e-8 world units per step, which accumulated past the digest's 1e-4
 * quantisation and then, once one enemy crossed a contact radius a tick early,
 * became a different run entirely.
 *
 * `Math.sqrt` has no such freedom. IEEE-754 requires it to be correctly rounded,
 * so every engine returns the same bits. `hypot(x, y)` is therefore
 * `sqrt(x*x + y*y)` and nothing else.
 *
 * What that gives up is overflow safety. `Math.hypot` scales its inputs so that
 * `hypot(1e200, 1e200)` does not become Infinity on the way. This does not,
 * which is fine and deliberate: arena coordinates live in the low thousands, and
 * a value large enough to square into an overflow would already be a bug several
 * steps upstream. Determinism is worth more here than a range nothing uses.
 *
 * `audio.test.ts` fails the build if `Math.hypot` reappears anywhere in src/sim.
 */

/** Length of a 2D vector. Exactly reproducible on every JS engine. */
export function hypot(x: number, y: number): number {
  return Math.sqrt(x * x + y * y);
}

/** Distance between two points. */
export function dist(ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  return Math.sqrt(dx * dx + dy * dy);
}
