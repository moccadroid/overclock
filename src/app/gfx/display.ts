/**
 * The display transform. GDD §16.2, §20.1.
 *
 * One uniform and one line of maths, applied to the finished frame and nothing
 * else: `c = pow(c, 1/gamma)`.
 *
 * **This is the monitor, not the tube.** `ui/fx.ts` is the glass the operator is
 * reading the Bureau through — a thing in the fiction, with scanlines and a
 * phosphor and opinions. This is the panel that glass is being shown on, which
 * is a fact about the room the player is sitting in and has no fiction at all.
 * They are separate because the run needs the second without the first: an arena
 * has no scanlines but is still being read on somebody's laptop.
 *
 * ---
 *
 * **Why a curve and not a multiply.**
 *
 * "Brightness" in the ordinary sense is a gain, and a gain would destroy §16.2.
 * The bands are 1.0 / 0.95 / 0.88 / 0.74 / 0.26 and the top three are within a
 * tenth of each other on purpose — multiply by 1.5 and all three clip to white
 * together, so the player, a telegraph and an ordinary enemy become the same
 * value and "you can find yourself in a full-chaos screenshot in under a second"
 * stops being true. The one law the renderer calls a law would be the first
 * casualty of the setting meant to make it visible.
 *
 * A gamma curve is monotonic and pins both ends: 0 stays 0, 1 stays 1, and every
 * band keeps its order and its separation. What it expands is the bottom, which
 * is exactly where this game lives — `background` is 7% blue, `mass` is 3.5%,
 * and the whole difference between the floor and a thing you cannot walk through
 * is three and a half points. On a panel that is not the one it was authored on
 * that is black on black, and no amount of gain fixes it without wrecking the
 * top.
 *
 * ---
 *
 * **Where it goes: last, and only last.**
 *
 * The bloom threshold reads authored values, and the light field meters its
 * exposure against them (`gfx/lights.ts`). Lifting the palette instead would
 * move both, and then a preference about somebody's monitor would be changing
 * what the game *is* — a brighter screen would bloom differently. So this is a
 * display transform in the strict sense: applied to the composited frame, after
 * post, after the mass, after the HUD and the sheets, altering nothing upstream.
 * Two stages install it — the shell's and the run's — and both put it at the end
 * of their filter chain.
 *
 * A gamma of 1 is the identity, and the identity is not installed at all: the
 * same discipline `post.ts` and `fx.ts` hold themselves to, and here it means a
 * player whose screen is already right pays nothing for the setting existing.
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
/** 1/gamma, folded on the CPU. The shader never divides by the setting. */
uniform float uInvGamma;

/** Where the lift is total, and where it has handed the picture back. */
#define LIFT_LOW 0.04
#define LIFT_HIGH 0.32

void main(void) {
  vec4 c = texture(uTexture, vTextureCoord);

  // Straight onto the premultiplied value, deliberately.
  //
  // The obvious version unpremultiplies first, curves the source colour, and
  // puts the alpha back — and it is wrong here, because half of this game's dim
  // values are dim by *alpha*, not by colour. A stroke drawn white at alpha 0.05
  // has a source colour of 1.0, and pow(1.0, anything) is 1.0, so the correction
  // would sail straight past every faded thing on the screen and lift only the
  // things that were already the brightest.
  //
  // The frame is presented over black — the page is black, both stages clear to
  // black — so the premultiplied value *is* what reaches the eye.
  vec3 lifted = pow(c.rgb, vec3(uInvGamma));

  // And then handed back above the knee.
  //
  // A plain gamma over the whole range was the first version and it failed for
  // the mirror image of the reason a multiply fails. A multiply clips the top of
  // §16.2 — the player, the telegraph and an ordinary enemy all clamp to white
  // together. A gamma inflates the *middle* of it: at 1.9 the grid went from 26%
  // to 49%, so the arena's structure stopped being structure and the picture
  // washed out. Both are the same crime against the same law, at opposite ends.
  //
  // What actually needs help is the bottom eight percent, where the floor and
  // the mass live. Above that the picture was already legible on any panel, so
  // the correction fades out by a third and everything from BAND.inFlight up is
  // untouched at every setting.
  finalColor = vec4(mix(lifted, c.rgb, smoothstep(LIFT_LOW, LIFT_HIGH, c.rgb)), c.a);
}
`;

/**
 * The range, and it only goes **up**.
 *
 * 1.00 is the floor and the floor is the identity, so the darkest this control
 * can make the game is exactly the game as authored. The first version ran down
 * to 0.7 for symmetry's sake and that was the whole bug: on a bright panel the
 * calibration target was satisfied at the bottom of the travel, so the screen
 * talked the player into darkening a game that is already at the bottom of the
 * range, and the arena went black.
 *
 * Nobody's complaint about this game is that it is too bright. There is no
 * failure mode below 1.00 worth having a control for, and having one cost a
 * playtester an evening.
 */
export const GAMMA_MIN = 1;
export const GAMMA_MAX = 2.4;
export const GAMMA_DEFAULT = 1;
export const GAMMA_STEP = 0.05;

/** The live display setting. Mutated by `setGamma`; read by every `DisplayPass`. */
export const DISPLAY = { gamma: GAMMA_DEFAULT };

/** Clamp and store. Returns what was actually stored, which is what to persist. */
export function setGamma(g: number): number {
  const v = Number.isFinite(g) ? g : GAMMA_DEFAULT;
  DISPLAY.gamma = Math.max(GAMMA_MIN, Math.min(GAMMA_MAX, Math.round(v * 100) / 100));
  return DISPLAY.gamma;
}

/** Whether the transform would change the picture at all. */
export function displayActive(): boolean {
  return Math.abs(DISPLAY.gamma - GAMMA_DEFAULT) > 0.001;
}

/** Keep in step with LIFT_LOW / LIFT_HIGH in the fragment shader. */
const LIFT_LOW = 0.04;
const LIFT_HIGH = 0.32;

/**
 * What a value authored at `v` actually leaves the pipe at, 0..1.
 *
 * The same arithmetic the shader does, for anything that has to reason about
 * the finished picture on the CPU — and it is duplicated here rather than only
 * living in GLSL so a test can assert that §16.2's ordering survives the curve
 * without needing a GPU. The two going out of step is the failure this mirrors
 * against; `display.test.ts` is what notices.
 */
export function throughDisplay(v: number): number {
  const c = Math.max(0, Math.min(1, v));
  const lifted = Math.pow(c, 1 / DISPLAY.gamma);
  const t = Math.max(0, Math.min(1, (c - LIFT_LOW) / (LIFT_HIGH - LIFT_LOW)));
  const k = t * t * (3 - 2 * t);
  return lifted + (c - lifted) * k;
}

export class DisplayPass {
  readonly filter: Filter;

  constructor() {
    this.filter = new Filter({
      glProgram: new GlProgram({ vertex, fragment, name: 'overclock-display' }),
      resources: {
        displayUniforms: {
          uInvGamma: { value: 1, type: 'f32' },
        },
      },
    });
  }

  /**
   * Push the current setting at the shader.
   *
   * Returns whether the pass is worth running, so a caller can leave it off the
   * stage entirely at gamma 1 rather than paying for a fullscreen copy that
   * changes nothing.
   */
  sync(): boolean {
    const u = this.filter.resources.displayUniforms.uniforms as Record<string, number>;
    u.uInvGamma = 1 / DISPLAY.gamma;
    return displayActive();
  }
}
