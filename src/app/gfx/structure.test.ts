import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * THE FLOW LOOK — approved 2026-08-08 — is frozen here.
 *
 * This is the smoke. It took four rebuilt eras, one broken law and a lot of
 * shouting to arrive at, and the whole recipe lives in numeric constants
 * inside a GLSL template literal, where no type checker and no runtime error
 * will ever notice a drift. So the recipe is asserted against the source
 * text: every load-bearing constant below is part of the approved look, and
 * changing any of them is a *look change* that needs the user's eyes on
 * `?look=flow` — not a refactor.
 *
 * The look, in one paragraph: coverage IS a domain-warped FBM field. One
 * shared two-stage warp; per-layer final octaves whose warp vectors ORBIT in
 * time (rotation, not translation — rigid drift reads as static), layers
 * counter-rotating so their borders writhe. The bias ramp loses to the field
 * across a wide per-layer band so no iso-line can print. And the one law
 * above all of it: dilate, never erode — the base layer carries an
 * unconditional solid floor over the collider (roiling strictly OUTWARD),
 * and the backing joins the field via max, never mix. There is never
 * empty-looking space where the sim will stop you.
 */
const src = readFileSync(join(__dirname, 'structure.ts'), 'utf8');
const rendererSrc = readFileSync(join(__dirname, '..', 'renderer.ts'), 'utf8');

describe('the flow look (approved 2026-08-08)', () => {
  it('generates the field exactly as approved: scale, warp, orbit, contrast', () => {
    // Base frequency and the two warp stages, with their approved drifts.
    expect(src).toContain('vec2 fq = p * 0.011;');
    expect(src).toContain('fbm3(fq + vec2(ft * 0.051, -ft * 0.040))');
    expect(src).toContain('vec2(-ft * 0.033, ft * 0.057)');
    expect(src).toContain('fbm3(fq + 1.6 * fw1 + vec2(9.2, 8.3))');
    // Orbital swirl: per-layer angular speed with alternating direction.
    expect(src).toContain('float angL = ft * (0.63 + 0.45 * fj) * dir;');
    // Final octave stack per layer, and the contrast stretch that gives the
    // concentrated vnoise blend its intended bite.
    expect(src).toContain('float f = fbm3(fq * (1.0 + 0.3 * fj) + 1.9 * (wr + 0.5) + fj * 3.7);');
    expect(src).toContain('flowF[i] = clamp((f - 0.5) * 2.4 + 0.5, 0.0, 1.0);');
  });

  it('keeps the fbm3 octave recipe', () => {
    expect(src).toContain('float f = vnoise(q) * 0.5;');
    expect(src).toContain('q = q * 2.03 + 17.7;');
    expect(src).toContain('f += vnoise(q) * 0.27;');
    expect(src).toContain('q = q * 2.11 + 9.1;');
    expect(src).toContain('f += vnoise(q) * 0.23;');
  });

  it('shapes layer coverage with the approved bands, stagger and weights', () => {
    expect(src).toContain('float bandF = 38.0 + 34.0 * fi;');
    expect(src).toContain(
      'float stag = (vnoise(p * 0.006 + fi * 7.3 + vec2(uTime * 0.022, 0.0)) - 0.5) * 36.0;',
    );
    // Centred strata offsets — all-inward hollowed the mass once already.
    expect(src).toContain('float bdEff = bd0 + (1.0 - fi) * 12.0 + stag;');
    // The field outweighs the ramp: 0.46 bias vs 0.64 field.
    expect(src).toContain('float fCover = smoothstep(0.30, 0.74, bias * 0.46 + flowF[layer] * 0.64);');
  });

  it('never morphs: full flow replaces coverage, partial flow only adds smoke', () => {
    // Two staging attempts interpolated between the crisp look and the field
    // look — alpha blending, then geometry melting — and both produced
    // pictures nobody approved, because every point between two approved
    // pictures is an unapproved picture. The rule they earned: the approved
    // replacement runs ONLY at full strength; below it the crisp look renders
    // exactly and the field arrives as opaque smoke laid over it (the staged
    // block, extent scaled by the dial, opacity never).
    expect(src).toContain('if (uFlow >= 0.999) {');
    expect(src).toContain('cover = fCover;');
    expect(src).not.toContain('cover = mix(cover, fCover');
    expect(src).toContain('if (uFlow > 0.001 && uFlow < 0.999) {');
    // The staged smoke binds to the DRAWN blocks (per-layer bd, handed to
    // the continuous hull past the outermost cells), not to the collider
    // hull — a hull-anchored band sat offset from every visible edge. And
    // the stage scales reach and threshold, never opacity.
    expect(src).toContain('float dS = min(abs(bd), abs(bd0) + 14.0);');
    expect(src).toContain('float aS = smoothstep(thS, thS + 0.24, flowF[layer] + proxS) * 0.92;');
  });

  it('never erodes: the base layer floors the collider solid, roiling outward only', () => {
    // The floor breathes between the exact collider line and ~10u beyond.
    // flowF is clamped to [0,1], so the dilation is strictly positive — the
    // solid edge can never retreat inside the collider.
    expect(src).toContain('float roil = flowF[1] * 10.0;');
    expect(src).toContain('fCover = max(fCover, 1.0 - smoothstep(-14.0, 2.0, bd0 - roil));');
  });

  it('never erodes: the backing joins the field via max, not mix', () => {
    expect(src).toContain('float biasB = 1.0 - 2.0 * smoothstep(-34.0, 34.0, bd0);');
    expect(src).toContain('float bFlow = smoothstep(0.30, 0.72, biasB * 0.54 + flowF[0] * 0.58);');
    // max: the exact legacy backing is the floor; the field only ADDS billow.
    expect(src).toContain('bCover = max(bCover, bFlow * min(1.0, uFlow));');
  });

  it('draws shadows from the field, not the blocks', () => {
    // The shadow is the hull offset the usual way, shaped by the same field —
    // modulating block-shaped shadows left detached ghost slabs on the floor.
    expect(src).toContain('float bdSh = massAt(p - uShadowOffset * uSizes[0]).x;');
    expect(src).toContain('float shF = (1.0 - smoothstep(-30.0, 26.0, bdSh))');
    expect(src).toContain('* (0.35 + 0.65 * smoothstep(0.15, 0.85, flowF[2]));');
  });

  it('suppresses every boundary tell at full flow — and only at full flow', () => {
    // The lit hairline would draw the boundary back in at full strength, but
    // below it the crisp look keeps its hairline whole (dimming it was the
    // morphing mistake in miniature). And the tile guard must widen or the
    // wisps clip against an invisible rectangle.
    expect(src).toContain('* (1.0 - step(0.999, uFlow));');
    expect(src).toContain('uFlow * 60.0');
  });

  it('is reachable as the named look at full strength, and drives the campaign ramp', () => {
    // ?look=flow shows the approved state exactly; the campaign walks the same
    // dial via decompositionDials (siteDecay 0..1 → flow 0..1), so the look at
    // TERMINAL and the look at ?look=flow are one picture.
    expect(rendererSrc).toContain('flow: { flow: 1 },');
    expect(rendererSrc).toContain('return { flow: k };');
  });

  it('has no surviving predecessor systems — the flow is the only decomposition', () => {
    // The dissolve/decay/shred trio and the three rebuilt smoke eras were
    // removed outright on the user's word ("flow is everything... remove the
    // rest"). A uniform reappearing here means an old branch leaked back in.
    for (const dead of ['uDissolve', 'uDecay', 'uShred', 'uExhale', 'uShroud', 'uSmoke']) {
      expect(src).not.toContain(dead);
    }
  });
});
