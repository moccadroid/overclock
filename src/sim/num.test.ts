/**
 * The portable trig has to be two things: accurate enough that nothing in the
 * game notices, and built only from operations IEEE-754 pins down. The first is
 * testable here; the second is guaranteed by construction (+ - * / and
 * Math.round only) and guarded by the source scan in audio.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { atan2, cos, hypot, pow, sin } from './num';

describe('portable trig', () => {
  it('matches the platform to under 1e-15 across the range the sim uses', () => {
    // Angles in this game are `time × rate`: a twenty-minute run at eight
    // radians a second is under 1e4. An order of magnitude past that is a
    // comfortable margin, and the Cody-Waite reduction holds to ~2e6.
    let worstSin = 0;
    let worstCos = 0;
    let seed = 12345;
    for (let i = 0; i < 20000; i++) {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      const x = (seed / 2147483648 - 0.5) * 2e5;
      worstSin = Math.max(worstSin, Math.abs(sin(x) - Math.sin(x)));
      worstCos = Math.max(worstCos, Math.abs(cos(x) - Math.cos(x)));
    }
    expect(worstSin).toBeLessThan(1e-15);
    expect(worstCos).toBeLessThan(1e-15);
  });

  it('is exact where exactness is visible', () => {
    expect(sin(0)).toBe(0);
    expect(cos(0)).toBe(1);
    // Not zero — π/2 is not representable, so neither is its sine's argument.
    // What matters is that it lands within a rounding error of it.
    expect(Math.abs(cos(Math.PI / 2))).toBeLessThan(1e-15);
    expect(Math.abs(sin(Math.PI))).toBeLessThan(1e-15);
    expect(sin(Math.PI / 2)).toBeCloseTo(1, 15);
    expect(cos(Math.PI)).toBeCloseTo(-1, 15);
  });

  it('holds the identity that every circle in the game depends on', () => {
    for (let i = -400; i < 400; i++) {
      const a = i * 0.37;
      expect(sin(a) * sin(a) + cos(a) * cos(a)).toBeCloseTo(1, 14);
    }
  });

  it('hypot is sqrt, and sqrt is correctly rounded everywhere', () => {
    expect(hypot(3, 4)).toBe(5);
    expect(hypot(-3, -4)).toBe(5);
  });

  it('atan2 tracks the platform through every quadrant', () => {
    let worst = 0;
    let seed = 99;
    for (let i = 0; i < 20000; i++) {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      const y = (seed / 2147483648 - 0.5) * 4000;
      seed = (seed * 1103515245 + 12345) % 2147483648;
      const x = (seed / 2147483648 - 0.5) * 4000;
      worst = Math.max(worst, Math.abs(atan2(y, x) - Math.atan2(y, x)));
    }
    expect(worst).toBeLessThan(1e-14);
    // The axes, where the quadrant logic is easiest to get wrong.
    expect(atan2(0, 1)).toBe(0);
    expect(atan2(1, 0)).toBeCloseTo(Math.PI / 2, 15);
    expect(atan2(-1, 0)).toBeCloseTo(-Math.PI / 2, 15);
    expect(atan2(0, -1)).toBeCloseTo(Math.PI, 15);
    expect(atan2(0, 0)).toBe(0);
  });

  it('pow is exact for integer exponents and accurate for the rest', () => {
    // Exact: repeated squaring, no series involved.
    expect(pow(2, 10)).toBe(1024);
    expect(pow(1.5, 3)).toBe(3.375);
    expect(pow(2, -2)).toBe(0.25);
    expect(pow(7, 0)).toBe(1);

    // The shapes the sim asks for: geometric decay per tick, and the XP curve.
    let worst = 0;
    for (const [b, e] of [
      [0.5, 1 / 60 / 0.6],
      [0.5, 1 / 60 / 2],
      [0.62, 7],
      [1.28, 23],
      [0.83, 0.41],
      [12.5, 2.7],
    ] as const) {
      const rel = Math.abs(pow(b, e) - Math.pow(b, e)) / Math.abs(Math.pow(b, e));
      worst = Math.max(worst, rel);
    }
    expect(worst).toBeLessThan(1e-14);
  });

  it('pow survives the extremes without losing its footing', () => {
    expect(pow(2, 0.5)).toBeCloseTo(Math.SQRT2, 15);
    expect(pow(1e-300, 0.5) / Math.pow(1e-300, 0.5)).toBeCloseTo(1, 12);
    expect(pow(1e300, 0.5) / Math.pow(1e300, 0.5)).toBeCloseTo(1, 12);
    expect(pow(-2, 0.5)).toBeNaN();
    expect(pow(-2, 3)).toBe(-8);
  });
});
