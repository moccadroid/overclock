/**
 * The post-processing pass. GDD §16.7, §20.1.
 *
 * One fragment shader over the composited frame, doing the things a sprite-and-
 * blend-mode pipeline cannot: barrel distortion, per-channel displacement,
 * scanlines, grain and a vignette. All of it is free on the GPU and none of it
 * is possible with tinted copies, which is what the aberration and tear steps
 * were faking before.
 *
 * Every effect defaults to **zero**, and zero is exactly the look the game had
 * before this file existed. That is deliberate: §16's restrained schematic is
 * the design, and everything here is a player choosing excess on top of it, not
 * a correction to it. A preset that turns everything off must be indistinguishable
 * from not having the pass at all.
 *
 * **This pass runs under the shell's mass, not over it.** It is applied to the
 * world group rather than to the stage, and the mass sits above that group as a
 * sibling. That matters because `uLit` multiplies whatever is already there by
 * up to three times where light is strong — applied over the mass, a slab lit
 * from underneath by the player standing beneath it, which is the one thing a
 * slab must not do. Haze had the same problem and worse, being purely additive.
 * Neither can reach the mass from here.
 */
import { Filter, GlProgram, Texture } from 'pixi.js';
import { VISUAL } from '../visual';

/** Keep in step with MAX_GLITCH in the fragment shader. */
const MAX_GLITCH = 8;
/** Keep in step with BLOOM_MIPS in gfx/bloom.ts and the sampler list here. */
const MIPS = 5;

const vertex = `
in vec2 aPosition;
out vec2 vTextureCoord;

uniform vec4 uInputSize;
uniform vec4 uOutputFrame;
uniform vec4 uOutputTexture;

vec4 filterVertexPosition( void ) {
  vec2 position = aPosition * uOutputFrame.zw + uOutputFrame.xy;
  position.x = position.x * (2.0 / uOutputTexture.x) - 1.0;
  position.y = position.y * (2.0 * uOutputTexture.z / uOutputTexture.y) - uOutputTexture.z;
  return vec4(position, 0.0, 1.0);
}

vec2 filterTextureCoord( void ) {
  return aPosition * (uOutputFrame.zw * uInputSize.zw);
}

void main(void) {
  gl_Position = filterVertexPosition();
  vTextureCoord = filterTextureCoord();
}
`;

const fragment = `
precision highp float;

in vec2 vTextureCoord;
out vec4 finalColor;

uniform sampler2D uTexture;
uniform sampler2D uLight;
uniform sampler2D uMask;
uniform vec4 uInputSize;
uniform vec4 uOutputFrame;
uniform vec2 uScreen;
/** §10.4 — how much of the state field to apply. Zero skips the sample. */
uniform float uState;

/**
 * §21b.4 — the biome, as a property of the picture.
 *
 * The screen-space "biome field" programs (frost, ember, static) that used to
 * live here were removed per STORY-AND-TONE §8.1. Authored set-dressing does
 * not belong on the lens; the descent is drawn on the ruins by the structure
 * shader, and the one screen-space category still permitted — weather — is its
 * own small pass, not a branch in this one.
 */

/**
 * §11.2 — Suppressor fields, as a signal fault rather than a drawn ring.
 *
 * Up to eight, packed as (screen x, screen y, radius px, strength). A Suppressor
 * used to announce itself with a wide circle and a hatch — the only way to say
 * "your Triggers are off in here", because the effect is otherwise invisible
 * until you notice nothing is happening. Twenty of them on screen was twenty
 * overlapping circles and the arena whited out.
 *
 * This costs no picture at all. The image inside the field *breaks*: channels
 * separate, scanlines tear sideways in blocks, and the whole thing loses its
 * grip. It reads as "do not go in there" without drawing anything, and eight
 * overlapping ones cannot stack into a white wall because the worst any pixel
 * gets is the strongest single field over it.
 */
#define MAX_GLITCH 8
uniform vec4 uGlitch[MAX_GLITCH];
uniform int uGlitchCount;

uniform float uBarrel;
uniform float uAberration;
uniform float uScan;
uniform float uGrain;
uniform float uVignette;
uniform float uBleed;
uniform float uLit;
uniform float uHaze;
uniform float uTime;

/**
 * §16.1 — the emissive layer and its bloom, composited here.
 *
 * These used to be seven full-screen sprites over the world: a flat copy, a hot
 * additive copy, two tinted aberration fringes and three copies run through
 * independent Gaussian blur chains. Every one was a full-screen write, and the
 * blurs re-blurred the same texture at three radii every frame. The mips
 * arrive pre-downsampled (gfx/bloom.ts), so the whole stack is now a handful
 * of texture reads in the pass this shader was already paying for.
 *
 * uHot is the old hot copy: how far past 1 the glow burns, applied as extra
 * gain on the emissive rather than as a second draw. uTearPx shifts the
 * emissive sideways — Overheat tearing the frame. The fringes are per-channel
 * reads at uFringePx, which is also simply *better* aberration than two
 * additive tinted copies ever were.
 */
uniform sampler2D uBase;
uniform sampler2D uMip1;
uniform sampler2D uMip2;
uniform sampler2D uMip3;
uniform sampler2D uMip4;
uniform sampler2D uMip5;
uniform float uBloomW[5];
uniform float uHot;
uniform float uTearPx;
uniform float uFringePx;
uniform float uFringeA;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}

/** Screen coordinates, 0..1, from this filter's own input space. */
vec2 toScreen(vec2 uv) {
  return (uv * uInputSize.xy + uOutputFrame.xy) / uScreen;
}

vec2 toInput(vec2 screen) {
  return (screen * uScreen - uOutputFrame.xy) / uInputSize.xy;
}

/** The world with the emissive layer over it, at an input-space uv. */
vec3 sceneAt(vec2 inUv) {
  vec3 under = texture(uTexture, inUv).rgb;
  vec4 em = texture(uBase, toScreen(inUv) - vec2(uTearPx / uScreen.x, 0.0));
  return under * (1.0 - em.a) + em.rgb * (1.0 + uHot);
}

void main(void) {
  vec2 uv = vTextureCoord;

  // Everything radial is measured from the centre of the *screen*.
  //
  // vTextureCoord is in the filter's input space, which Pixi sizes to the
  // stage's bounding box — and the stage is much larger than the window,
  // because the world layer's bounds are the world. So uv minus 0.5 is the middle
  // of a rectangle that has nothing to do with the display, and the barrel
  // bulged around a point off-screen while the vignette darkened one corner and
  // not the opposite one. Nobody caught it because both effects are subtle and
  // asymmetry is exactly what a vignette is supposed to hide.
  vec2 centred = toScreen(uv) - 0.5;
  // This pixel, in screen pixels. Every noise and scanline pattern below is
  // anchored to it rather than to the input space, which drifts as the stage's
  // bounds change — grain that crawls when the camera moves is grain that
  // reads as a bug.
  vec2 spx = (centred + 0.5) * uScreen;

  // ---- suppression fields ---------------------------------------------
  //
  // Resolved before anything else reads the texture, because this is a
  // *sampling* fault: the pixel you get is not the pixel that was there. Taking
  // the strongest field rather than summing them is what keeps a crowd of
  // Suppressors legible — three overlapping fields are one broken region, not
  // three times as broken.
  float glitch = 0.0;
  vec2 tear = vec2(0.0);
  if (uGlitchCount > 0) {
    vec2 px = uv * uInputSize.xy + uOutputFrame.xy;
    for (int i = 0; i < MAX_GLITCH; i++) {
      if (i >= uGlitchCount) break;
      vec4 g = uGlitch[i];
      float d = distance(px, g.xy);
      if (d >= g.z) continue;
      // Flat across the interior, ramping only over the outer fifth.
      //
      // A radial falloff was the obvious first shape and the wrong one: it put
      // all the damage on the Suppressor itself and left the rest of the zone —
      // the part you actually have to stay out of — looking fine. The zone is a
      // *region with a border*, not a source, so it is lit like one.
      float t = smoothstep(0.0, 0.2, 1.0 - d / g.z) * g.w;
      glitch = max(glitch, t);
    }
    if (glitch > 0.001) {
      // Horizontal block tear. Bands are quantised in *screen* pixels so they
      // stay the same size wherever the field is, and reseeded on a coarse time
      // step so it stutters rather than flows — flowing reads as water.
      float band = floor(px.y / 9.0);
      float jump = floor(uTime * 14.0);
      float slip = hash(vec2(band, jump)) - 0.5;
      // Only some bands move. A field where every line slips is mush.
      // ("active" is reserved in GLSL ES 3.00 — hence the name.)
      float slipping = step(0.55, hash(vec2(band * 1.7, jump * 0.9)));
      tear = vec2(slip * slipping * glitch * 0.055, 0.0);
      uv += tear;
    }
  }

  // ---- the state field -------------------------------------------------
  //
  // §10.4 — what a variant *is*, rather than a glyph saying what it is.
  //
  // Sampled here because the first of the three effects is a sampling fault
  // too: charge displaces the picture before anything reads it, so the air over
  // a cooking enemy genuinely moves. The other two are applied to the finished
  // colour further down.
  vec3 state = vec3(0.0);
  if (uState > 0.0) {
    // Soft knee rather than a clamp.
    //
    // The buffer is additive, so eighty charged enemies in one place sum far
    // past 1 and a hard clamp turns the whole region into one flat saturated
    // slab — the same failure the light field's exposure exists to prevent, and
    // the same failure the Suppressor avoided by taking a max. An exponential
    // roll-off keeps a single mark at roughly its own strength and lets a crowd
    // approach full without ever getting there, so a dense region still has
    // structure in it.
    state = vec3(1.0) - exp(-texture(uMask, toScreen(uv)).rgb * uState * 1.6);

    // Heat shimmer. Two sine fields at different rates and angles, which is the
    // cheapest thing that does not read as a single scrolling ripple.
    if (state.r > 0.004) {
      float px = spx.x;
      float py = spx.y;
      vec2 wobble = vec2(
        sin(py * 0.09 + uTime * 7.0) + sin(py * 0.031 - uTime * 4.3),
        sin(px * 0.075 - uTime * 5.5)
      );
      uv += wobble * state.r * 0.0030;
    }
  }

  // Barrel: the frame bulges as if it were a tube. Applied first, so everything
  // after it inherits the curve rather than fighting it.
  if (uBarrel > 0.0) {
    float r2 = dot(centred, centred);
    uv = toInput(0.5 + centred * (1.0 + uBarrel * r2 * 1.6));
  }

  // Per-channel displacement along the radius. Real aberration grows toward the
  // edge of the lens; the old two-tinted-sprites version was uniform, which is
  // why it read as a colour wash rather than as glass.
  //
  // A suppression field splits channels hard and horizontally, on top of
  // whatever the lens is already doing radially. Horizontal because that is what
  // a broken signal looks like — radial is glass, lateral is electronics.
  //
  // Corruption splits channels too, but along a fixed diagonal rather than the
  // radius: the radius is a property of the lens, and this is a property of the
  // *thing*. Split radially and an elite standing in the middle of the screen
  // would have no fringe at all.
  vec4 colour;
  vec4 em;
  vec2 dir = centred * uAberration * 0.02
    + vec2(glitch * 0.009, 0.0)
    + vec2(state.g, -state.g) * 0.009;
  // The emissive layer is a screen-space buffer; every shift the world has
  // taken so far — glitch tear, shimmer, barrel — is already in uv, so
  // sampling it through toScreen(uv) keeps the two layers welded together
  // under any distortion. uTearPx is the Overheat tear, emissive-only, exactly
  // as the sprite version was.
  vec2 euv = toScreen(uv) - vec2(uTearPx / uScreen.x, 0.0);
  if (uAberration > 0.0 || glitch > 0.001 || state.g > 0.004) {
    // dir is an input-space displacement; the emissive wants it in screen
    // space or the split widens as the stage's bounds grow.
    vec2 sdir = dir * (uInputSize.xy / uScreen);
    colour.r = texture(uTexture, uv + dir).r;
    colour.g = texture(uTexture, uv).g;
    colour.b = texture(uTexture, uv - dir).b;
    colour.a = texture(uTexture, uv).a;
    em.r = texture(uBase, euv + sdir).r;
    em.b = texture(uBase, euv - sdir).b;
    vec2 ga = texture(uBase, euv).ga;
    em.g = ga.x;
    em.a = ga.y;
  } else {
    colour = texture(uTexture, uv);
    em = texture(uBase, euv);
  }

  // ---- the emissive layer, and its glow ---------------------------------
  //
  // Source-over for the flat copy — entities occlude the floor, they do not
  // add to it — then everything that spreads is additive: the hot copy, the
  // §16.7 fringes, and the bloom read off the mip chain.
  colour.rgb = colour.rgb * (1.0 - em.a) + em.rgb * (1.0 + uHot);
  if (uFringeA > 0.0) {
    vec2 f = vec2(uFringePx / uScreen.x, 0.0);
    colour.rgb += texture(uBase, euv + f).rgb * vec3(1.0, 0.25, 0.25) * uFringeA;
    colour.rgb += texture(uBase, euv - f).rgb * vec3(0.25, 0.5, 1.0) * uFringeA;
  }
  colour.rgb += texture(uMip1, euv).rgb * uBloomW[0]
              + texture(uMip2, euv).rgb * uBloomW[1]
              + texture(uMip3, euv).rgb * uBloomW[2]
              + texture(uMip4, euv).rgb * uBloomW[3]
              + texture(uMip5, euv).rgb * uBloomW[4];

  // ---- lighting -------------------------------------------------------
  //
  // The light buffer is the thing bloom cannot be. Bloom spreads what a pixel
  // already had; this is light that exists *in the air* and falls on surfaces
  // that never emitted anything. A bolt flying over the grid lights the grid.
  if (uLit > 0.0 || uHaze > 0.0) {
    // The light buffer is in screen space; vTextureCoord is in the filter's
    // own input space, which Pixi pads and offsets. Sampling one with the other
    // put the whole light map at the wrong scale and position, clamped at its
    // edge into a slab of white with visible seams where the texture ran out.
    //
    // uOutputFrame is where this filter's input sits on screen, so this converts
    // back before sampling.
    vec3 light = texture(uLight, toScreen(uv)).rgb;

    // Tone-map the light before using it.
    //
    // The buffer is additive and unbounded on purpose — forty overlapping
    // detonations *should* accumulate. But used raw, that accumulation clips
    // into a flat featureless disc: forty orange lights become one yellow
    // circle with a hard edge, which is less impressive than one light, not
    // more. Reinhard keeps the bright core bright and its colour intact while
    // letting the total roll off, so a screen full of light stays a screen full
    // of *lights*.
    // Plain Reinhard. The previous curve divided by 0.55, which *amplified*
    // dim light by nearly 2x — so the long soft tail of a big source got pushed
    // up to the same value as its core, and a Field or a Nova rendered as a flat
    // disc with a hard edge instead of as a glow. Dark values must pass through
    // untouched; only the bright end may roll off.
    light = light / (1.0 + light);

    // Surfaces catch it, scaled by their own brightness. A dim grid line near a
    // detonation lifts a little; a bright stroke near one blows out. Multiplying
    // by the existing colour is what makes this read as *illumination* rather
    // than as a coloured overlay — unlit geometry stays unlit.
    colour.rgb += colour.rgb * light * uLit * 5.0;

    // And the light is visible in the air itself, which is what sells neon.
    colour.rgb += light * light * uHaze;
  }

  // Radial bleed: light streaking outward from the centre.
  //
  // Additive, not a mix. Mixing replaces the drawing with a blurred copy of
  // itself, which is how the first version turned every enemy into an
  // unreadable smear — the picture got *softer* when the ask was for it to get
  // *brighter*. Adding a smeared copy on top keeps every stroke sharp and hangs
  // light off it, which is what §16.1's "chaos must resolve into light" means.
  if (uBleed > 0.0) {
    vec3 sum = vec3(0.0);
    for (int i = 1; i <= 6; i++) {
      float s = 1.0 + float(i) * 0.005 * uBleed;
      // Recomposited, not the underlay: the streaks are supposed to hang off
      // the bright strokes, and the bright strokes live in the emissive layer.
      sum += sceneAt(toInput(0.5 + centred * s));
    }
    colour.rgb += (sum / 6.0) * uBleed * 0.75;
  }

  // ---- the state field, on the finished colour -------------------------
  if (uState > 0.0) {
    // Charge: the air over it glows warm, and the glow breathes. This is the
    // half of "it is cooking" that shimmer alone cannot say, because a
    // displacement is invisible over a flat background.
    if (state.r > 0.004) {
      float breathe = 0.72 + 0.28 * sin(uTime * 9.0);
      colour.rgb += vec3(0.62, 0.24, 0.05) * state.r * state.r * breathe * 3.4;
    }
    // Corruption: the picture loses its grip. Contrast pushed up and the
    // shadows pulled violet, which is §16.2's void hue arriving as a property
    // of the region rather than as a stroke colour.
    if (state.g > 0.004) {
      float k = state.g;
      colour.rgb = mix(colour.rgb, colour.rgb * colour.rgb * 2.6, k * 0.6);
      colour.rgb += vec3(0.20, 0.0, 0.34) * k * k * 1.1;
    }
    // Phase: half here.
    //
    // Desaturating alone did nothing, and for a reason worth keeping: a thin
    // bright stroke on a black field has almost no saturation to take away. So
    // this doubles the picture instead — an offset copy at partial weight, cut
    // by interference bands — which is what "not entirely present" looks like
    // and is legible at any brightness.
    if (state.b > 0.004) {
      float k = state.b;
      // The echo has to carry the emissive layer — the phased enemy IS the
      // emissive — so it reads the recomposited scene, not the underlay.
      vec3 echo = sceneAt(uv + vec2(0.006, 0.0) * k);
      float bands = 0.55 + 0.45 * sin(spx.y * 0.55 + uTime * 3.0);
      colour.rgb = mix(colour.rgb, max(colour.rgb * 0.55, echo * 0.8), k * bands);
      float lum = dot(colour.rgb, vec3(0.299, 0.587, 0.114));
      colour.rgb = mix(colour.rgb, vec3(lum * 0.74, lum * 0.88, lum * 1.06), k * 0.7);
    }
  }

  // Scanlines. Tied to the real pixel height so they stay one line thick at any
  // resolution rather than moiring against the display.
  if (uScan > 0.0) {
    float line = sin(spx.y * 3.14159);
    colour.rgb *= 1.0 - uScan * 0.34 * (0.5 + 0.5 * line);
  }

  // Grain, animated. Additive rather than multiplicative, so it lifts the black
  // field into something that looks alive instead of dirtying the highlights.
  if (uGrain > 0.0) {
    float n = hash(spx + uTime);
    colour.rgb += (n - 0.5) * uGrain * 0.25;
  }

  // The biome-field programs that lived here are gone — STORY-AND-TONE §8.1.

  if (uVignette > 0.0) {
    float d = length(centred) * 1.414;
    colour.rgb *= 1.0 - uVignette * smoothstep(0.55, 1.15, d);
  }

  // The rest of the fault: dropped scanlines and a dead, desaturated cast. This
  // sits after everything else so it degrades the *finished* picture — a fault
  // in the signal, not a thing in the world casting light.
  if (glitch > 0.001) {
    float lum = dot(colour.rgb, vec3(0.299, 0.587, 0.114));
    colour.rgb = mix(colour.rgb, vec3(lum) * 0.82, glitch * 0.5);
    // Every third scanline drops out, hard.
    float drop = step(0.66, fract(spx.y * 0.5));
    colour.rgb *= 1.0 - drop * glitch * 0.45;
    // And a sparse white speckle, so the region reads as *live* interference
    // rather than as a dirty lens.
    float sparkle = step(0.997, hash(spx + floor(uTime * 20.0)));
    colour.rgb += sparkle * glitch * 0.35;
  }

  // Anything the barrel pushed off the edge is outside the frame, not black
  // pixels to be sampled.
  vec2 barrelled = toScreen(uv);
  if (uBarrel > 0.0 &&
      (barrelled.x < 0.0 || barrelled.x > 1.0 || barrelled.y < 0.0 || barrelled.y > 1.0)) {
    colour = vec4(0.0);
  }

  finalColor = colour;
}
`;

export interface PostSettings {
  barrel: number;
  aberration: number;
  scan: number;
  grain: number;
  vignette: number;
  bleed: number;
  /** How much light surfaces catch. The illumination half. */
  lit: number;
  /** How much light is visible in the air. The neon half. */
  haze: number;
}

export const POST_OFF: PostSettings = {
  barrel: 0,
  aberration: 0,
  scan: 0,
  grain: 0,
  vignette: 0,
  bleed: 0,
  lit: 0,
  haze: 0,
};

export class PostPass {
  readonly filter: Filter;
  private time = 0;

  constructor() {
    this.filter = new Filter({
      glProgram: new GlProgram({ vertex, fragment, name: 'overclock-post' }),
      resources: {
        postUniforms: {
          uBarrel: { value: 0, type: 'f32' },
          uAberration: { value: 0, type: 'f32' },
          uScan: { value: 0, type: 'f32' },
          uGrain: { value: 0, type: 'f32' },
          uVignette: { value: 0, type: 'f32' },
          uBleed: { value: 0, type: 'f32' },
          uLit: { value: 0, type: 'f32' },
          uHaze: { value: 0, type: 'f32' },
          uTime: { value: 0, type: 'f32' },
          uState: { value: 0, type: 'f32' },
          uScreen: { value: new Float32Array([1, 1]), type: 'vec2<f32>' },
          uGlitchCount: { value: 0, type: 'i32' },
          uGlitch: { value: new Float32Array(MAX_GLITCH * 4), type: 'vec4<f32>', size: MAX_GLITCH },
          uBloomW: { value: new Float32Array(MIPS), type: 'f32', size: MIPS },
          uHot: { value: 0, type: 'f32' },
          uTearPx: { value: 0, type: 'f32' },
          uFringePx: { value: 0, type: 'f32' },
          uFringeA: { value: 0, type: 'f32' },
        },
        uLight: Texture.WHITE.source,
        uMask: Texture.EMPTY.source,
        uBase: Texture.EMPTY.source,
        uMip1: Texture.EMPTY.source,
        uMip2: Texture.EMPTY.source,
        uMip3: Texture.EMPTY.source,
        uMip4: Texture.EMPTY.source,
        uMip5: Texture.EMPTY.source,
      },
    });
  }

  /**
   * Point the composite at the emissive buffer and its mips. Called at init and
   * after any resize, because the buffers are recreated rather than resized.
   */
  setBloomTextures(base: Texture, mips: readonly Texture[]): void {
    this.filter.resources.uBase = base.source;
    for (let i = 0; i < MIPS; i++) {
      this.filter.resources[`uMip${i + 1}`] = (mips[i] ?? base).source;
    }
  }

  /**
   * The bloom escalation, mapped onto mip weights. `intensity` keeps the old
   * sprite-alpha contract: 1 is the tuned §16 baseline, past 1.2 the glow
   * spills wider, past 2.4 it floods — the Heat/Meltdown ladder. `mips` is the
   * quality knob: weights beyond the refreshed mips are forced to zero so a
   * stale buffer is never read, and the glow honestly tightens instead.
   */
  setBloom(intensity: number, mips: number): void {
    const w = (this.filter.resources.postUniforms.uniforms as Record<string, unknown>)
      .uBloomW as Float32Array;
    const tight = Math.min(1.4, intensity);
    const wide = Math.max(0, Math.min(1.1, intensity - 1.2)) * 0.75;
    const huge = Math.max(0, Math.min(1, intensity - 2.4)) * 0.6;
    // Energy sits in the far mips on purpose. The first mapping spread it
    // evenly from the half-res mip outward, and a halo that hugs a one-pixel
    // stroke does not read as glow — it reads as the stroke being out of
    // focus. The whole frame went smudgy. The old BlurFilter look was a wide
    // soft aura over strokes that stayed sharp, so the near mips carry almost
    // nothing and the spread lives at 1/16 and 1/32 — glow around things, not
    // blur on them.
    w[0] = 0;
    w[1] = tight * 0.08;
    w[2] = tight * 0.22;
    w[3] = tight * 0.45;
    w[4] = tight * 0.25 + wide + huge;
    // A lower quality tier folds the missing mips' energy inward rather than
    // deleting it — the glow tightens instead of disappearing, which is a
    // degrade someone might not notice rather than a light switching off. The
    // fold keeps most of the energy; a little is honestly lost, the same way
    // the radius is.
    for (let i = MIPS - 1; i >= Math.max(1, mips); i--) {
      w[i - 1] = w[i - 1]! + w[i]! * 0.85;
      w[i] = 0;
    }
    if (mips <= 0) for (let i = 0; i < MIPS; i++) w[i] = 0;
  }

  /** How hot the emissive burns before any of it spreads. 1 is neutral. */
  setGlow(amount: number): void {
    (this.filter.resources.postUniforms.uniforms as Record<string, number>).uHot = Math.max(
      0,
      amount - 1,
    );
  }

  /** §16.7 step 2 — chromatic fringes on the emissive layer, 0..1. */
  setAberrationFringe(amount: number): void {
    const u = this.filter.resources.postUniforms.uniforms as Record<string, number>;
    const safe = amount * VISUAL.degradationIntensity;
    u.uFringeA = safe * 0.5;
    u.uFringePx = safe * VISUAL.aberrationInstability2;
  }

  /** §16.7 step 4 — Overheat tears the emissive sideways. Signed, 0 is none. */
  setTear(amount: number): void {
    const u = this.filter.resources.postUniforms.uniforms as Record<string, number>;
    u.uTearPx = amount * VISUAL.degradationIntensity * VISUAL.tearAmount;
  }

  /**
   * §11.2 — hand over this frame's suppression fields, in screen pixels.
   *
   * Screen space rather than world, because the shader has no camera. Anything
   * past the eighth is dropped: eight overlapping broken regions is already an
   * unreadable screen, and the ninth cannot make it worse in a way anyone would
   * thank us for.
   */
  setGlitchFields(fields: readonly { x: number; y: number; radius: number; strength: number }[]): void {
    const uniforms = this.filter.resources.postUniforms.uniforms as Record<string, unknown>;
    const data = uniforms.uGlitch as Float32Array;
    const n = Math.min(MAX_GLITCH, fields.length);
    for (let i = 0; i < n; i++) {
      const f = fields[i]!;
      data[i * 4] = f.x;
      data[i * 4 + 1] = f.y;
      data[i * 4 + 2] = f.radius;
      data[i * 4 + 3] = f.strength;
    }
    (uniforms as Record<string, number>).uGlitchCount = n;
  }

  /** Point the shader at this frame's light buffer. */
  setLightTexture(texture: Texture): void {
    this.filter.resources.uLight = texture.source;
  }

  /** §10.4 — this frame's state field. */
  setMaskTexture(texture: Texture): void {
    this.filter.resources.uMask = texture.source;
  }

  /** How much of the state field to apply. Zero skips the sample entirely. */
  setState(amount: number): void {
    (this.filter.resources.postUniforms.uniforms as Record<string, number>).uState = amount;
  }

  /**
   * `boost` is the in-run degradation ladder (§16.7): Heat and Meltdown push the
   * effects past whatever the player chose, so the same preset gets uglier as the
   * run gets worse. A preset with everything at zero still stays at zero — the
   * ladder scales what is there rather than introducing it, so "off" means off.
   */
  update(
    settings: PostSettings,
    boost: number,
    dt: number,
    screenWidth: number,
    screenHeight: number,
  ): void {
    this.time = (this.time + dt) % 1000;
    const uniforms = this.filter.resources.postUniforms.uniforms as Record<string, unknown>;
    const screen = uniforms.uScreen as Float32Array;
    screen[0] = screenWidth;
    screen[1] = screenHeight;

    const u = uniforms as Record<string, number>;
    const k = 1 + boost;
    u.uBarrel = settings.barrel;
    u.uAberration = settings.aberration * k;
    u.uScan = settings.scan;
    u.uGrain = settings.grain * k;
    u.uVignette = settings.vignette;
    u.uBleed = settings.bleed * k;
    // Heat and Meltdown push light *up*, not down: §16.7's ladder is the world
    // overexposing, and an engine coming apart should be the brightest thing
    // that ever happens in a run.
    u.uLit = settings.lit * k;
    u.uHaze = settings.haze * k;
    u.uTime = this.time;
  }
}
