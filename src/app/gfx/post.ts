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
 */
import { Filter, GlProgram, Texture } from 'pixi.js';

/** Keep in step with MAX_GLITCH in the fragment shader. */
const MAX_GLITCH = 8;

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
uniform vec4 uInputSize;
uniform vec4 uOutputFrame;
uniform vec2 uScreen;

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

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}

void main(void) {
  vec2 uv = vTextureCoord;
  vec2 centred = uv - 0.5;

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
      float active = step(0.55, hash(vec2(band * 1.7, jump * 0.9)));
      tear = vec2(slip * active * glitch * 0.055, 0.0);
      uv += tear;
    }
  }

  // Barrel: the frame bulges as if it were a tube. Applied first, so everything
  // after it inherits the curve rather than fighting it.
  if (uBarrel > 0.0) {
    float r2 = dot(centred, centred);
    uv = 0.5 + centred * (1.0 + uBarrel * r2 * 1.6);
  }

  // Per-channel displacement along the radius. Real aberration grows toward the
  // edge of the lens; the old two-tinted-sprites version was uniform, which is
  // why it read as a colour wash rather than as glass.
  //
  // A suppression field splits channels hard and horizontally, on top of
  // whatever the lens is already doing radially. Horizontal because that is what
  // a broken signal looks like — radial is glass, lateral is electronics.
  vec4 colour;
  vec2 dir = centred * uAberration * 0.02 + vec2(glitch * 0.009, 0.0);
  if (uAberration > 0.0 || glitch > 0.001) {
    colour.r = texture(uTexture, uv + dir).r;
    colour.g = texture(uTexture, uv).g;
    colour.b = texture(uTexture, uv - dir).b;
    colour.a = texture(uTexture, uv).a;
  } else {
    colour = texture(uTexture, uv);
  }

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
    vec2 screenUv = (uv * uInputSize.xy + uOutputFrame.xy) / uScreen;
    vec3 light = texture(uLight, screenUv).rgb;

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
      sum += texture(uTexture, 0.5 + centred * s).rgb;
    }
    colour.rgb += (sum / 6.0) * uBleed * 0.75;
  }

  // Scanlines. Tied to the real pixel height so they stay one line thick at any
  // resolution rather than moiring against the display.
  if (uScan > 0.0) {
    float line = sin(uv.y * uInputSize.y * 3.14159);
    colour.rgb *= 1.0 - uScan * 0.34 * (0.5 + 0.5 * line);
  }

  // Grain, animated. Additive rather than multiplicative, so it lifts the black
  // field into something that looks alive instead of dirtying the highlights.
  if (uGrain > 0.0) {
    float n = hash(uv * uInputSize.xy + uTime);
    colour.rgb += (n - 0.5) * uGrain * 0.25;
  }

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
    float drop = step(0.66, fract(uv.y * uInputSize.y * 0.5));
    colour.rgb *= 1.0 - drop * glitch * 0.45;
    // And a sparse white speckle, so the region reads as *live* interference
    // rather than as a dirty lens.
    float sparkle = step(0.997, hash(uv * uInputSize.xy + floor(uTime * 20.0)));
    colour.rgb += sparkle * glitch * 0.35;
  }

  // Anything the barrel pushed off the edge is outside the frame, not black
  // pixels to be sampled.
  if (uBarrel > 0.0 && (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0)) {
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
          uScreen: { value: new Float32Array([1, 1]), type: 'vec2<f32>' },
          uGlitchCount: { value: 0, type: 'i32' },
          uGlitch: { value: new Float32Array(MAX_GLITCH * 4), type: 'vec4<f32>', size: MAX_GLITCH },
        },
        uLight: Texture.WHITE.source,
      },
    });
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

  /** True when every effect is off — the pass can then be skipped entirely. */
  static isOff(s: PostSettings): boolean {
    return (
      s.barrel === 0 &&
      s.aberration === 0 &&
      s.scan === 0 &&
      s.grain === 0 &&
      s.vignette === 0 &&
      s.bleed === 0 &&
      s.lit === 0 &&
      s.haze === 0
    );
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
