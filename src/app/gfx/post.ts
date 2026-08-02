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

  // Barrel: the frame bulges as if it were a tube. Applied first, so everything
  // after it inherits the curve rather than fighting it.
  if (uBarrel > 0.0) {
    float r2 = dot(centred, centred);
    uv = 0.5 + centred * (1.0 + uBarrel * r2 * 1.6);
  }

  // Per-channel displacement along the radius. Real aberration grows toward the
  // edge of the lens; the old two-tinted-sprites version was uniform, which is
  // why it read as a colour wash rather than as glass.
  vec4 colour;
  if (uAberration > 0.0) {
    vec2 dir = centred * uAberration * 0.02;
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
    vec3 light = texture(uLight, uv).rgb;

    // Surfaces catch it, scaled by their own brightness. A dim grid line near a
    // detonation lifts a little; a bright stroke near one blows out. Multiplying
    // by the existing colour is what makes this read as *illumination* rather
    // than as a coloured overlay — unlit geometry stays unlit.
    colour.rgb += colour.rgb * light * uLit * 6.0;

    // And the light is visible in the air itself, which is what sells neon.
    colour.rgb += light * uHaze;
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
        },
        uLight: Texture.WHITE.source,
      },
    });
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
  update(settings: PostSettings, boost: number, dt: number): void {
    this.time = (this.time + dt) % 1000;
    const u = this.filter.resources.postUniforms.uniforms as Record<string, number>;
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
