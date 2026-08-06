/**
 * The document UI — the glass.
 *
 * One filter, two jobs, and they are deliberately the same filter because they
 * are the same piece of hardware: the terminal the operator is sitting at.
 *
 *   **Scanlines, mask and monochrome** — the surface everything is displayed on.
 *   **Tear, split and noise** — what happens to that surface when something that
 *   is not the Bureau is driving it.
 *
 * The second is the point. A resistance message is not styled differently
 * because it is prettier; it is styled differently because *the terminal is
 * being interfered with*, and interference is a property of the glass, not of
 * the text. Giving the intrusion its own font would be a design choice. Making
 * the display misbehave is the fiction.
 *
 * Everything defaults to zero, and zero is exactly the picture with no filter
 * at all — the same discipline `post.ts` holds itself to.
 */
import { Filter, GlProgram } from 'pixi.js';

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
uniform vec4 uInputSize;

uniform float uTime;
/** Scanline depth, and the pitch in *device pixels* per light/dark pair. */
uniform float uScan;
uniform float uLines;
/** 1 collapses to luminance and tints with uTint. */
uniform float uMono;
uniform vec3 uTint;
/** Horizontal band displacement — the channel being interfered with. */
uniform float uTear;
/** Per-channel offset, in pixels. */
uniform float uSplit;
uniform float uNoise;
uniform float uVignette;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}

void main(void) {
  vec2 uv = vTextureCoord;
  vec2 px = uInputSize.zw;

  // ---- tear -------------------------------------------------------------
  //
  // Bands, not a wobble. A sine displacement is a CRT with a bad flyback; a
  // *band* that jumps sideways and holds is a signal with something else on it.
  // The band height is quantised so the edges are hard.
  if (uTear > 0.0) {
    float band = floor(uv.y * 28.0);
    float roll = hash(vec2(band, floor(uTime * 11.0)));
    float hit = step(0.82, roll);
    float dir = hash(vec2(band, floor(uTime * 11.0) + 7.0)) - 0.5;
    uv.x += hit * dir * 0.055 * uTear;
  }

  // ---- per-channel split ------------------------------------------------
  float s = uSplit * px.x;
  vec4 c;
  if (s > 0.0) {
    c.r = texture(uTexture, uv + vec2(s, 0.0)).r;
    c.g = texture(uTexture, uv).g;
    c.b = texture(uTexture, uv - vec2(s, 0.0)).b;
    c.a = texture(uTexture, uv).a;
  } else {
    c = texture(uTexture, uv);
  }

  // ---- monochrome -------------------------------------------------------
  //
  // Luminance, then a single phosphor. Weighted properly rather than averaged,
  // because the palette leans blue and a flat average turns the whole document
  // one flat value.
  if (uMono > 0.0) {
    float lum = dot(c.rgb, vec3(0.299, 0.587, 0.114));
    c.rgb = mix(c.rgb, uTint * lum, uMono);
  }

  // ---- scanlines --------------------------------------------------------
  //
  // Multiplied, never added. A scanline is the beam *missing* a row, so it can
  // only ever take light away — added highlights would raise the black floor,
  // and the black floor is the whole look.
  if (uScan > 0.0) {
    // Pitch in device pixels, not in UV. Expressed against the height in UV the
    // frequency changes with the window and lands wherever it lands — at 900px
    // it was a three-pixel period, at 1800 a six, and on a high-DPI buffer it
    // aliased into flat grey. A scanline is a property of the tube.
    float phase = uv.y * uInputSize.y / max(2.0, uLines);
    float line = 0.5 + 0.5 * sin(phase * 6.2831853);
    c.rgb *= 1.0 - uScan * (1.0 - line);
  }

  if (uNoise > 0.0) {
    float n = hash(uv * 512.0 + uTime) - 0.5;
    c.rgb += n * uNoise;
  }

  if (uVignette > 0.0) {
    vec2 d = uv - 0.5;
    c.rgb *= 1.0 - uVignette * dot(d, d) * 2.2;
  }

  finalColor = c;
}
`;

export interface GlassStyle {
  scan?: number;
  lines?: number;
  mono?: number;
  tint?: [number, number, number];
  tear?: number;
  split?: number;
  noise?: number;
  vignette?: number;
}

export class Glass {
  readonly filter: Filter;
  private time = 0;

  constructor(style: GlassStyle = {}) {
    this.filter = new Filter({
      glProgram: new GlProgram({ vertex, fragment, name: 'overclock-glass' }),
      resources: {
        glassUniforms: {
          uTime: { value: 0, type: 'f32' },
          uScan: { value: 0, type: 'f32' },
          uLines: { value: 3, type: 'f32' },
          uMono: { value: 0, type: 'f32' },
          uTint: { value: new Float32Array([1, 1, 1]), type: 'vec3<f32>' },
          uTear: { value: 0, type: 'f32' },
          uSplit: { value: 0, type: 'f32' },
          uNoise: { value: 0, type: 'f32' },
          uVignette: { value: 0, type: 'f32' },
        },
      },
    });
    this.set(style);
  }

  private get u(): Record<string, number> {
    return this.filter.resources.glassUniforms.uniforms as Record<string, number>;
  }

  set(s: GlassStyle): void {
    const u = this.u;
    if (s.scan !== undefined) u.uScan = s.scan;
    if (s.lines !== undefined) u.uLines = s.lines;
    if (s.mono !== undefined) u.uMono = s.mono;
    if (s.tear !== undefined) u.uTear = s.tear;
    if (s.split !== undefined) u.uSplit = s.split;
    if (s.noise !== undefined) u.uNoise = s.noise;
    if (s.vignette !== undefined) u.uVignette = s.vignette;
    if (s.tint) {
      const t = this.filter.resources.glassUniforms.uniforms.uTint as Float32Array;
      t[0] = s.tint[0];
      t[1] = s.tint[1];
      t[2] = s.tint[2];
    }
  }

  update(dt: number): void {
    this.time = (this.time + dt) % 10000;
    this.u.uTime = this.time;
  }
}

/**
 * The phosphors on offer, for deciding whether this thing is monochrome.
 *
 * `colour` is the palette as authored — the fuel hues still mean elements, the
 * kind colours still sit outside them. Every other entry throws all of that away
 * for one tube, which is a real trade and not a filter: on amber there is no
 * difference between thermal and signal red, and a chain stops being readable by
 * hue at all.
 */
export const PHOSPHOR: { id: string; label: string; mono: number; tint: [number, number, number] }[] =
  [
    { id: 'colour', label: 'COLOUR', mono: 0, tint: [1, 1, 1] },
    { id: 'amber', label: 'AMBER', mono: 1, tint: [1.5, 0.86, 0.32] },
    { id: 'green', label: 'GREEN', mono: 1, tint: [0.5, 1.5, 0.72] },
    { id: 'ice', label: 'ICE', mono: 1, tint: [0.82, 1.06, 1.5] },
  ];
