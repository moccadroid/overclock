import { describe, expect, it, beforeEach } from 'vitest';
import {
  DISPLAY,
  GAMMA_DEFAULT,
  GAMMA_MAX,
  GAMMA_MIN,
  displayActive,
  setGamma,
  throughDisplay,
} from './display';
import { BAND, PALETTE } from '../visual';

/**
 * The display transform exists to make §16.2 *visible* on a panel it was not
 * authored on. Everything below is that sentence with the word "visible" pinned
 * down: the curve may expand the bottom of the range as far as it likes, and may
 * not disturb the ordering the brightness hierarchy is made of.
 *
 * This is where the argument for a curve over a gain is actually held. The one
 * about §16.2 in `display.ts` is prose; these are the assertions that fail if
 * somebody swaps the `pow` for a multiply because it seemed simpler.
 */
const blue = (hex: number): number => (hex & 0xff) / 255;

describe('the display transform (GDD §16.2, §20.1)', () => {
  beforeEach(() => {
    setGamma(GAMMA_DEFAULT);
  });

  it('is the identity at 1, and says so', () => {
    expect(displayActive()).toBe(false);
    for (const v of [0, 0.03, 0.26, 0.74, 1]) expect(throughDisplay(v)).toBeCloseTo(v, 6);
  });

  it('pins both ends at every setting', () => {
    // The half of the argument a gain fails. Black must stay black — a lifted
    // floor is grain, fog and every "the black is never quite black" effect
    // becoming permanent — and 1.0 must stay 1.0, because §16.2 reserves it for
    // the player and nothing else may ever arrive there.
    for (const g of [GAMMA_MIN, 0.9, 1.4, 2.0, GAMMA_MAX]) {
      setGamma(g);
      expect(throughDisplay(0)).toBe(0);
      expect(throughDisplay(1)).toBe(1);
    }
  });

  it('§16.2 — every band keeps its order and its separation', () => {
    const bands = [BAND.structure, BAND.inFlight, BAND.entity, BAND.telegraph, BAND.player];
    for (const g of [GAMMA_MIN, 1, 1.6, 2.2, GAMMA_MAX]) {
      setGamma(g);
      const lit = bands.map(throughDisplay);
      for (let i = 1; i < lit.length; i++) {
        expect(lit[i]!).toBeGreaterThan(lit[i - 1]!);
        // Strictly greater is not enough: a gain of 1.5 would clip the top three
        // bands to 1.0 together and still pass a `>=`. They have to stay *apart*
        // by something an eye could find in a full-chaos screenshot.
        expect(lit[i]! - lit[i - 1]!).toBeGreaterThan(0.01);
      }
      expect(lit.at(-1)).toBe(BAND.player);
    }
  });

  it('never darkens, at any setting the control can reach', () => {
    // The bug this range exists to make impossible. A calibration target that
    // could be satisfied at the bottom of the travel talked a player into
    // turning the game *down*, and at 0.7 the floor-to-mass separation halved.
    // There is no legitimate use for below 1.00 here, so there is no below 1.00.
    expect(GAMMA_MIN).toBe(1);
    for (const g of [GAMMA_MIN, 1.5, GAMMA_MAX]) {
      setGamma(g);
      for (const v of [0.012, 0.035, 0.071, 0.26, 0.74, 1]) {
        expect(throughDisplay(v)).toBeGreaterThanOrEqual(v - 1e-9);
      }
    }
  });

  it('lifts the shadows without inflating the midrange', () => {
    // The other half of the same law, and the half a plain gamma broke. At 1.9
    // the ungated curve took the grid from 26% to 49% — structure arriving in
    // the band above it, which is a washed-out picture and §16.2 violated from
    // the top instead of from the bottom.
    setGamma(GAMMA_MAX);
    // Everything from in-flight up is untouched at every setting, full stop.
    for (const v of [BAND.inFlight, BAND.entity, BAND.telegraph, BAND.player]) {
      expect(throughDisplay(v)).toBeCloseTo(v, 6);
    }
    // And the arena's structure barely moves even at the top of the travel.
    expect(throughDisplay(BAND.structure) - BAND.structure).toBeLessThan(0.06);
    // While the values that actually needed it move a great deal.
    expect(throughDisplay(0.035)).toBeGreaterThan(0.035 * 3);
  });

  it('opens up the gap the game actually loses on a dim panel', () => {
    // The failure this whole feature is for: `mass` is authored darker than
    // `background` in every channel so a block reads as absence rather than as a
    // grey box, and the whole difference is three and a half points of blue.
    const floor = blue(PALETTE.background);
    const mass = blue(PALETTE.mass);
    expect(floor - mass).toBeLessThan(0.04);

    setGamma(1.6);
    const lifted = throughDisplay(floor) - throughDisplay(mass);
    expect(lifted).toBeGreaterThan((floor - mass) * 1.7);
    // And the ordering survives it, which is what stops the correction from
    // turning the mass into the brighter of the two.
    expect(throughDisplay(mass)).toBeLessThan(throughDisplay(floor));
  });

  it('clamps anything handed to it, including nonsense', () => {
    expect(setGamma(99)).toBe(GAMMA_MAX);
    expect(setGamma(-4)).toBe(GAMMA_MIN);
    expect(setGamma(Number.NaN)).toBe(GAMMA_DEFAULT);
    // A hand-edited Library is the realistic source of a bad value, and the
    // clamp lives here rather than at the storage layer precisely so every route
    // to the uniform passes through it.
    expect(setGamma(1.333333)).toBe(1.33);
    expect(DISPLAY.gamma).toBe(1.33);
  });
});
