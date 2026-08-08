/**
 * The shell. GDD §16.5, §21b.
 *
 * Everything the player stands on and everything they cannot walk through.
 *
 * **A wall is not a shape to be shaded. It is a region that black blocks want
 * to occupy.**
 *
 * That sentence is the whole file, and the first version of it got the opposite
 * answer — machined metal with bevels, panel joints, bolts, wear noise and a
 * lit rim, which is what surface detail always produces. Detail density *is*
 * realism. The dialect here is abstract, minimal, brutalist: mass, not material.
 *
 * So the mass is read three ways, none of which is a lit surface:
 *
 *   **By value.** Blocks are near-black and *neutral*, against a blue floor,
 *   and darker than it in every channel. Structure is absence, not an object
 *   catching light.
 *
 *   **By silhouette.** Nothing is ever a rectangle. The collider is; the picture
 *   is a field of axis-aligned blocks. Three scales layered back to front give
 *   size variety and depth — big slabs behind, smaller ones in front, each
 *   offset a little further from the eye and casting a hard shadow on what it
 *   covers.
 *
 *   **By motion.** Every block is permanently extending, sliding, contracting
 *   and sliding back, on a four-beat cycle. Nothing about the room is ever
 *   still, and what it is doing instead is keeping time.
 *
 * ---
 *
 * **The randomness lives in the extent, never in the membership.** This is the
 * load-bearing rule, and the first version of this file learned it the hard way.
 *
 * That version asked each cell a yes/no question — *is my centre inside the
 * collider, dilated by my roll?* — and re-rolled on the beat. Blending the roll
 * smoothly did nothing, because a cell still *crosses* the threshold at one
 * instant and a full-size block springs into existence. Smoothing the input to a
 * binary decision does not make the output continuous. The mass popped.
 *
 * Now membership is static geometry: a cell is solid if its centre is inside the
 * collider, and that is the end of it. Nothing ever appears or disappears. What
 * animates is each block's half-extents and centre — it elongates on one axis,
 * drags its centre along the other a quarter-cycle behind, contracts, and comes
 * back. The per-cell amplitude re-rolls freely, because changing an extent is a
 * shape change and shape changes are continuous by construction. It cannot pop.
 *
 * Interior blocks animate too. It costs nothing and is invisible — black
 * overlapping black — so the motion only ever reads where the mass meets the
 * floor, which is the only place it should.
 *
 * ---
 *
 * Two rules make it safe to lie about the outline:
 *
 *   **Dilate, never erode.** A cell whose centre is inside the collider is
 *   always solid. The mass may only grow outward, so a block can overhang floor
 *   you can walk under — which reads correctly from above — and there is never
 *   open-looking ground that you bump into.
 *
 *   **Excursion is per wall.** A 90-unit barrier cannot churn by 200 units and
 *   still describe where the collision is. Each wall carries its own reach: the
 *   outer shell gets deep raggedness because there is nothing behind it to lie
 *   about, and small ruins get almost none.
 *
 * Everything is anchored in **world** space and mapped through the camera here,
 * so the mass does not swim when the view moves and a block you walked past is
 * in the same place when you walk back.
 */
import { BufferImageSource, Filter, GlProgram, Texture } from 'pixi.js';

/**
 * How many walls the mass shader can draw in one frame. Keep in step with the
 * `#define`s in the fragment shader.
 *
 * This is a **drawing** limit and nothing else. It is not a level budget, not a
 * collider count, and not a cap on anything the simulation knows about — the
 * arena can hold as many ruins as it likes and they all collide, block shots
 * and path exactly as they always did. This number only says how many of them
 * can have a churning outline *at the same time*, because a GLSL uniform array
 * has to have a compile-time size and every pixel walks it.
 *
 * The renderer culls to the view before filling it, so what actually gets paid
 * for is `uWallCount` — the walls on screen — not this bound. Raising it costs
 * nothing until a screen genuinely contains that many, which is why it went
 * from 14 to 24 to 48 as the arenas grew: a gate frame is eighteen rectangles
 * on its own, and at 24 a screen with a gate on it had six slots left for the
 * entire rest of the room. The per-pixel cost of the array stopped mattering
 * when the tile broadphase landed (see uTiles in the shader): a pixel now
 * loops over the handful of walls that can reach it, and this bound is only
 * how many the *frame* can carry.
 */
const MAX_WALLS = 48;
const MAX_WARP = 6;
/**
 * The broadphase grid: 16x16 tiles over the view, up to 12 wall indices per
 * tile. Keep TILE_CAP in step with the `#define` in the fragment shader. Three
 * RGBA8 texels per tile — 3 KiB re-uploaded only on frames whose culled wall
 * set actually changed, which is camera movement across a room boundary, not
 * every frame.
 */
const TILES = 16;
const TILE_CAP = 12;
/**
 * How far past the view sample points can land: seal warps displace `p` by a
 * couple of dozen units, shadows and layer parallax by less than a hundred.
 */
const VIEW_PAD = 160;
/** End-of-list and overflowed-tile markers, matching the shader. */
const TILE_END = 255;
const TILE_OVERFLOW = 254;
/**
 * How many rooms can declare their own material at once. Keep in step with the
 * `#define` in the fragment shader.
 *
 * One per room in the arena, and arenas have five. Eight is headroom.
 */
const MAX_ZONES = 8;

/** A room's material, as a world-space region the shader resolves per pixel. */
export interface MaterialZone {
  x: number;
  y: number;
  w: number;
  h: number;
  oil: number;
  fray: number;
  /** The room's standing decomposition. LEVELS §3.2b. */
  dissolve: number;
}

export interface ShellWall {
  x: number;
  y: number;
  w: number;
  h: number;
  /** 0 solid, 1 fully open. Gate barriers animate through this. */
  open: number;
  /** How hot the freshly cut surface burns, 0..1. Scored per step. */
  glow: number;
  /** How far outward this wall's blocks may reach, in world units. */
  reach: number;
}

/**
 * §21b.5 — a point of burning light embedded in the mass, in world units.
 *
 * `radius` is the *reach*, not the size of the source: the core is a small
 * fraction of it. That ratio is what makes a seal read as dangerous instead of
 * decorative — a big soft disc looks like paint, a tiny white point throwing
 * light three hundred units is a thing you do not want to stand near.
 */
export interface ShellSeal {
  x: number;
  y: number;
  radius: number;
  intensity: number;
  /** Half-extents of the doorway it sits in — where the jamb effects hang. */
  halfW: number;
  halfH: number;
  /** Brightness of the ember bar down each jamb face. */
  jambGlow: number;
  /** Density of the motes the doorway draws in. */
  motes: number;
}

export interface ShellWarp {
  x: number;
  y: number;
  radius: number;
  pull: number;
  swirl: number;
}

/** Every tunable the shader takes, mirrored from `SHELL` in visual.ts. */
export interface ShellStyle {
  sizes: readonly [number, number, number];
  shades: readonly [number, number, number];
  depth: readonly [number, number, number];
  cycleBeats: number;
  swell: number;
  extend: number;
  layerExtend: readonly [number, number, number];
  biases: readonly [number, number, number];
  gridOffset: readonly [number, number, number];
  ampFloor: number;
  maxStretch: number;
  veil: number;
  veilRadius: number;
  inset: number;
  insetPulse: number;
  jitter: number;
  edge: number;
  oil: number;
  fray: number;
  decay: number;
  shred: number;
  dissolve: number;
  shadow: number;
  shadowOffset: readonly [number, number];
  backing: number;
  massLit: number;
  shellReach: number;
}

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
/*
 * The version marker below is load-bearing. Pixi compiles a GlProgram as GLSL
 * ES 1.00 with a compatibility shim unless the fragment source contains
 * exactly that string — and the broadphase cannot survive 1.00: texelFetch
 * does not exist there, and an array indexed through a function parameter is
 * illegal. Pixi strips the marker and re-inserts it as the true first line of
 * the compiled source, which is why a comment may legally precede it here.
 */
#version 300 es
precision highp float;

in vec2 vTextureCoord;
out vec4 finalColor;

uniform sampler2D uTexture;
/**
 * The light field, so the mass can catch some of it.
 *
 * The mass is drawn above the post pass — which is correct, because light must
 * not pass through a solid thing — but the first version of that took the mass
 * to *zero* light, and a slab that never brightens when a detonation goes off
 * beside it reads as the lighting being switched off. It is not a hole in the
 * lighting, it is a surface that was never given any.
 *
 * So the mass samples the field itself and takes a small share. Small because
 * this cannot tell "beside" from "above": the same term that lights a wall next
 * to a Nova would light the slab you are standing under. At this strength the
 * first reads and the second does not.
 */
uniform sampler2D uLight;
uniform float uMassLit;
/**
 * §21b.5 — what the cut burns like.
 *
 * The light coming through an opening is light from the *other side*, so it is
 * the colour of the room you are about to walk into rather than the one you are
 * leaving. Set from the destination level, which means the gate tells you where
 * you are going before you can see any of it.
 */
uniform vec3 uCutColor;

/**
 * §21b.5 — the thing holding a sealed gate shut, as light rather than geometry.
 *
 * (world x, world y, radius, intensity) per seal. It lives in this pass and not
 * in the world layer for one reason: the world layer is drawn *under* the mass,
 * and the seal is embedded in a door. Drawn there it was a dull red bar behind a
 * slab, and no amount of brightness would have fixed that — it was occluded.
 *
 * Here it is above the door and emissive, so it can blow out properly, warp the
 * blocks around it, and throw rays across them.
 */
#define MAX_SEALS 4
uniform vec4 uSeals[MAX_SEALS];
/**
 * The doorway the seal sits in: (halfWidth, halfHeight, jambGlow, motes).
 *
 * The gate used to have fourteen extra rectangles bolted to it — pylons, caps,
 * lintel returns — to make it read as architecture rather than a slab. They did
 * read, and they also formed concave pockets that enemies walked into and could
 * not walk out of, which is a worse problem than a plain doorway. So the frame
 * is four rectangles now and everything that made it interesting is light: the
 * jambs are where the flare and the motes come from, and light cannot trap
 * anything.
 */
uniform vec4 uSealBox[MAX_SEALS];
uniform int uSealCount;
uniform vec2 uScreenPx;
uniform vec4 uInputSize;
uniform vec4 uOutputFrame;

#define MAX_WALLS 48
#define MAX_WARP 6
#define MAX_ZONES 8
#define TAU 6.2831853

/** Screen pixel of world origin, and pixels per world unit. */
uniform vec2 uOrigin;
uniform float uScale;
/** Arena centre and half-extent, world units. The mass is its complement. */
uniform vec2 uArenaC;
uniform vec2 uArenaH;
/** How far the outer shell's blocks may hang inward over the floor. */
uniform float uShellReach;
/** How far inside the true arena rect the visual wall stands. */
/** (centre x, centre y, half w, half h) per wall, world units. */
uniform vec4 uWalls[MAX_WALLS];
/** (openness, reach, cut glow, 0) per wall. */
uniform vec4 uWallState[MAX_WALLS];
uniform int uWallCount;
/** (x, y, radius, pull) and a matching swirl. Bends the floor, never the mass. */
uniform vec4 uWarp[MAX_WARP];
uniform float uSwirl[MAX_WARP];
uniform int uWarpCount;

/**
 * The broadphase. MAX_WALLS made every mass query walk every wall on screen —
 * per pixel, seven times a pixel — and the comment on the constant already knew
 * where that ends: "beyond a few hundred the per-pixel loop starts to matter
 * and the answer is a broadphase". This is that broadphase, arrived at well
 * before a few hundred, because a slower GPU multiplies the loop the same way
 * more walls do.
 *
 * A 16x16 grid over the view, one tile = three RGBA8 texels = up to twelve
 * wall indices whose influence can reach that tile. Most of any screen is open
 * floor, so most lookups read one texel triple and loop over nothing. 255 is
 * the end marker; 254 in the first slot means the tile overflowed — more walls
 * reach it than the list holds, gates being the honest case (a gate frame is
 * eighteen rectangles) — and the query falls back to the full loop it would
 * have run anyway. Correctness never depends on the grid, only speed.
 */
#define TILE_CAP 12
uniform sampler2D uTiles;
/** World origin of tile (0,0), reciprocal of the tile size, and counts - 1. */
uniform vec2 uTileOrigin;
uniform vec2 uTileInv;
uniform vec2 uTileMax;

uniform vec3 uStructure;
uniform vec3 uBase;
uniform vec3 uMass;
uniform vec3 uTint;
uniform float uTintAmount;

/** Style, straight from SHELL in visual.ts. */
uniform vec3 uSizes;
uniform vec3 uShades;
uniform vec3 uDepth;
uniform float uCycle;
uniform float uExtend;
/** Per-layer multipliers on the extension, and per-layer membership depth. */
uniform vec3 uLayerExtend;
uniform vec3 uBiases;
/** Per-layer grid stagger, in cells, so layers do not share their seams. */
uniform vec3 uGridOffset;
/** The smallest amplitude any block gets, and the stretch ceiling. */
uniform float uAmpFloor;
uniform float uMaxStretch;
uniform float uInset;
uniform float uInsetPulse;
uniform float uJitter;
uniform float uEdge;
/**
 * §8.3 — the sheen, and it is on the **floor**, not on the mass.
 *
 * Painting a film across the block bodies was the first attempt and it was the
 * wrong surface: the blocks are hard-edged flat value, so anything laid over
 * them reads as a stain on a shape rather than as a property of a material —
 * and no amount of tuning the noise changes what it is sitting on. The floor is
 * the layer the mass has seams into, so an iridescence down there comes *up*
 * through the gaps between slabs and around every silhouette, which is the
 * shimmer that was wanted, and the blocks stay exactly as sharp as they were.
 */
uniform float uOil;
/**
 * §8.3 — the decay: continuous, organic decomposition of the drawn mass.
 *
 * Purely presentational, like everything in this pass — the colliders
 * underneath never dissolve, so this only ever eats and regrows the picture
 * within the same cap that bounds every block. Three parts, all driven by one
 * knob: a slow macro field that decides *where* the rot currently sits (so
 * regions decay, heal, and it moves on), a finer advected field that eats the
 * silhouettes there, and a faint exhalation rising off whatever is currently
 * going.
 */
uniform float uDecay;
/**
 * §8.3 — the shred: the decaying edges fragmenting instead of waving.
 *
 * uDecay perturbs the distance field, and a perturbed contour is still a
 * contour — wobblier, but connected, which is why edges kept reading as
 * boundaries. The shred replaces the smooth silhouette across a band around
 * the edge with a field of soft flecks that thin toward the fringe: coverage
 * breaking into crumbs and stray matter *outside* the line, which is what
 * dissolving actually looks like. Independent knob, same roaming rot field,
 * so the two effects can run alone or stack and still agree about where the
 * decay currently is.
 */
uniform float uShred;
/**
 * §8.3 — the dissolve: every block trades its boundary for wisps.
 *
 * Anchored per block, not to the ruin's hull — that distinction is the whole
 * lesson of two failed attempts. Smoke bound to the hull floats over the
 * cells as a separate weather system; flecks thresholded against the hull
 * reconstruct the outline they were meant to destroy. Bound to each block's
 * own distance, the cell pattern survives while every edge in it — blocks,
 * backing, shadows, the lit hairline — stops being a line and becomes a
 * billowing transition a few dozen units wide. The amount scales with the
 * layer: the black base barely breathes, the top grey is the most dissolved,
 * so the z-axis reads as progressive decomposition. Uniform across the arena
 * by design — this is the material's condition, not a passing event; the
 * roaming effects (uDecay, uShred) layer on top when a room is actively
 * dying.
 */
uniform float uDissolve;
/**
 * The largest dissolve anywhere on screen — the base or any room's.
 *
 * The two branch predicates below decide whether a pixel pays for the
 * decomposition path at all, and how far past the collider a wisp may be drawn.
 * Both have to be answered *before* the per-pixel material is resolved, and both
 * have to be answered for the worst case: a guard that used the local value would
 * clip a dissolving room's own wisps against an invisible rectangle wherever the
 * base happened to be lower, which is exactly the kind of edge that gives the
 * whole effect away.
 */
uniform float uDissolveMax;
/**
 * §8.3 — how far the block edges fray, as a fraction of a block's own size.
 *
 * The one thing that *should* touch the mass: not a texture on the face but a
 * perturbation of the outline, in blocky steps, so a slab's border crumbles
 * instead of ending. The steps re-roll on the beat, which is what makes it read
 * as coming apart rather than as a rough edge.
 *
 * Safe against the "dilate, never erode" rule for one reason: the backing pass
 * covers the collider whatever the layers do, so fraying can eat into a drawn
 * silhouette without ever opening a hole in cover.
 */
uniform float uFray;
/**
 * Which rooms wear which material, as world-space rectangles.
 *
 * uOil and uFray above are the arena's *base* — what a room that declares
 * nothing looks like — and these override it region by region. That is the whole
 * fix for a real problem: the two were room style, switched wholesale the
 * instant the player crossed a boundary, so stepping through a gate repainted
 * every floor on screen at once. The room you had just left went oily behind
 * you, which is both wrong and the most visible thing in the frame.
 *
 * A material is a property of a place. Resolved per pixel, the Sink's floor is
 * the only oily floor even while you stand in the doorway looking at both rooms,
 * and there is no transition to smooth because nothing ever transitions — you
 * walk into it, and it comes up around you over uZoneBlend.
 *
 * (centre x, centre y, half w, half h) and (oil, fray, spare, spare).
 */
uniform vec4 uZoneRect[MAX_ZONES];
uniform vec4 uZoneMat[MAX_ZONES];
uniform int uZoneCount;
/**
 * How far a zone's material bleeds *out* through its walls, and how far *in* it
 * takes to reach full strength. World units.
 *
 * The outward bleed is small and deliberate: a little of the room leaking
 * through its own doorway is what makes the door read as a way into somewhere
 * rather than a hole in a wall. The inward ramp has to stay under half the
 * shortest room's short side, or that room never reaches its own material.
 */
uniform vec2 uZoneBlend;
uniform float uShadow;
uniform vec2 uShadowOffset;
uniform float uBacking;

/** 1 on the quarter, falling to 0 by the next. The grid breathes on it. */
uniform float uPulse;
/** 1 on the downbeat, falling to 0 by the next bar. The mass swells on it. */
uniform float uBar;
/** Monotonic quarter-notes since the run began. Drives the whole animation. */
uniform float uQuarter;
uniform float uLoad;
uniform float uTime;
uniform vec2 uEye;
/** 0 draws the floor, opaque and under everything; 1 draws the mass, over it. */
uniform float uMode;
/** How much cover the mass gives up over the ship, and over what radius. */
uniform float uVeil;
uniform float uVeilRadius;

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float sdBox(vec2 p, vec2 b) {
  vec2 d = abs(p) - b;
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
}

/**
 * The material at a world point: (oil, fray).
 *
 * Rooms are disjoint, so the mix collapses to "the room's value inside, the
 * base outside" everywhere except the few hundred units either side of a wall,
 * which is exactly where a blend is wanted. Written as a fold rather than a
 * search so a nested or overlapping region — an arena that ever wants one — is
 * simply the last one to speak.
 */
vec3 materialAt(vec2 p) {
  vec3 m = vec3(uOil, uFray, uDissolve);
  for (int i = 0; i < MAX_ZONES; i++) {
    if (i >= uZoneCount) break;
    vec4 r = uZoneRect[i];
    // Positive inside the room, negative outside.
    float depth = -sdBox(p - r.xy, r.zw);
    float k = smoothstep(-uZoneBlend.x, uZoneBlend.y, depth);
    if (k <= 0.0) continue;
    m = mix(m, uZoneMat[i].xyz, k);
  }
  return m;
}

/**
 * The fray: a signed, blocky perturbation of a block's outline, −0.5..0.5.
 *
 * Quantised, not smooth. Smooth noise on an outline gives a wavy border, and a
 * wavy border in a vocabulary with no curves in it reads as a mistake — this
 * bins world space into crumbs a fifth of a block across, so the edge breaks
 * into square nibbles that belong to the same grammar as the blocks.
 *
 * Interpolated across the turn between two rolls, exactly like the amplitude:
 * a hash that changes on the beat is a popping edge, and the whole file's rule
 * is that shape changes are continuous.
 */
float frayAt(vec2 p, float size, float t) {
  vec2 q = floor(p / max(1.0, size * 0.2));
  float turn = floor(t);
  float a = hash21(q + turn * 37.1);
  float b = hash21(q + (turn + 1.0) * 37.1);
  return mix(a, b, smoothstep(0.0, 1.0, fract(t))) - 0.5;
}


/** Smooth value noise. The floor's sheen and the decay field sample it; the
 *  block geometry itself never does — shape changes stay in the block grammar. */
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

/**
 * The fine decay field, 0..1: what the rot is eating right here, right now.
 *
 * Two octaves of smooth noise, advected — the erosion pattern travels, which
 * is the whole difference between "coming apart" and "has a rough edge". A
 * frozen perturbation is texture; a moving one is a process. (Sits below
 * vnoise because GLSL resolves nothing forward.)
 */
float decayAt(vec2 p) {
  vec2 drift = vec2(uTime * 0.05, uTime * -0.038);
  return (vnoise(p * 0.030 + drift) + 0.5 * vnoise(p * 0.085 - drift * 1.6)) / 1.5;
}

/**
 * Coverage after the shred, given the distance and the plain coverage.
 *
 * The band spans the edge and reaches two bands past it: well inside, the
 * mass is solid with the odd pinprick — a decaying interior pocks — around
 * the silhouette half the crumbs survive, and beyond it stray flecks thin
 * along a long tail with no outer wall, so there is no radius at which the
 * effect visibly stops. The crumb lattice is *advected*: the drift carries it
 * along the local outward direction of the field, so flecks pull free of the
 * silhouette and travel, rather than fizzing in place — which kept reading
 * as a boundary with a texture on it. The threshold cross-fades between
 * rolls; flecks condense and evaporate, they never pop.
 */
float shredCover(float d, float cover, vec2 p, float band, vec2 drift) {
  if (band < 0.5) return cover;
  // 0 well inside the block; 1 two bands out, at the far fringe.
  float t = clamp((d + band) / (band * 3.0), 0.0, 1.0);
  vec2 cell = floor((p + drift) / 9.0);
  float tick = uTime * 0.8;
  float turn = floor(tick);
  float fizz = mix(hash21(cell + turn * 17.3), hash21(cell + (turn + 1.0) * 17.3),
                   smoothstep(0.0, 1.0, fract(tick)));
  float alive = smoothstep(t * 0.92, t * 0.92 + 0.18, fizz);
  // The far fade: multiplied, not clamped, so the tail dissolves instead of
  // ending.
  alive *= 1.0 - smoothstep(0.8, 1.0, t);
  return max(cover * step(band, -d), alive);
}

/**
 * §8.3 — a dissolving edge: coverage across a soft band around a block's own
 * boundary, eaten into wisps by the billow density handed in.
 *
 * The whole point is what it is anchored to. Smoke bound to the ruin's hull
 * floats over the cells and reads as a separate weather system; this is bound
 * to one block's distance, so the block itself trades its boundary for wisps
 * while its body stays — the cell pattern survives its own decomposition.
 * Inside the band the body is solid; across it the billow decides what
 * remains; past it the wisps thin to nothing within a few dozen units. There
 * is no sharp transition anywhere in that sentence, which is the request.
 */
float dissolved(float d, float band, float den, float bite, float aa) {
  if (band < 0.5) return 1.0 - smoothstep(-aa, aa, d);
  float t = clamp((d + band) / (band * 1.7), 0.0, 1.0);
  float alive = smoothstep(0.32, 0.72, (1.0 - t) + (den - 0.5) * bite);
  // The tail killer, and it is load-bearing: t clamps to 1 far outside the
  // band — including the 1e5 a non-member cell returns — and once the noise
  // was contrast-stretched, a high den could clear the threshold there on its
  // own. Every surface using this function grew faint phantom blobs on open
  // floor anywhere the guard let the shader run. Whatever the noise says,
  // coverage must die with distance.
  return alive * (1.0 - smoothstep(0.82, 1.0, t));
}

/** Distance to the nearest line of a world-space grid, in world units. */
float gridDist(vec2 p, float spacing) {
  vec2 g = abs(fract(p / spacing - 0.5) - 0.5) * spacing;
  return min(g.x, g.y);
}

/** The tile's wall list, as floats: indices, then 255 as the end mark. */
void tileIds(vec2 c, out float ids[TILE_CAP]) {
  vec2 t = clamp(floor((c - uTileOrigin) * uTileInv), vec2(0.0), uTileMax);
  int tx = int(t.x) * 3;
  int ty = int(t.y);
  vec4 a = texelFetch(uTiles, ivec2(tx, ty), 0) * 255.0;
  vec4 b = texelFetch(uTiles, ivec2(tx + 1, ty), 0) * 255.0;
  vec4 e = texelFetch(uTiles, ivec2(tx + 2, ty), 0) * 255.0;
  ids[0] = a.x; ids[1] = a.y; ids[2] = a.z; ids[3] = a.w;
  ids[4] = b.x; ids[5] = b.y; ids[6] = b.z; ids[7] = b.w;
  ids[8] = e.x; ids[9] = e.y; ids[10] = e.z; ids[11] = e.w;
}

/** One wall's contribution to the mass distance — the body of massAt's loop. */
void wallMass(int i, vec2 c, inout float d, inout float r) {
  vec4 w = uWalls[i];
  float wd = sdBox(c - w.xy, w.zw);
  float open = uWallState[i].x;
  if (open > 0.0) {
    // §21b.5 — the gate. A slot growing along the wall's long axis, which the
    // block field turns into slabs withdrawing from the opening.
    vec2 slot = w.z > w.w
      ? vec2(w.z * open * 1.02, w.w * 4.0)
      : vec2(w.z * 4.0, w.w * open * 1.02);
    wd = max(wd, -sdBox(c - w.xy, slot));
  }
  if (wd < d) {
    d = wd;
    r = uWallState[i].y;
  }
}

/** §21b.5 — one gate's cut light, if it is open and burning. See main(). */
void gateCut(int i, vec2 p, inout vec4 acc) {
  float open = uWallState[i].x;
  if (open <= 0.0) return;
  // The heat of the cut is scored, not derived: a gate can flare before it
  // moves and cool while it finishes, which no function of openness alone can
  // express.
  float heat = uWallState[i].z;
  if (heat <= 0.0) return;
  vec4 w = uWalls[i];
  vec2 slot = w.z > w.w
    ? vec2(w.z * open * 1.02, w.w * 4.0)
    : vec2(w.z * 4.0, w.w * open * 1.02);
  float sd = sdBox(p - w.xy, slot);
  float within = 1.0 - smoothstep(-40.0, 90.0, sdBox(p - w.xy, w.zw));
  float sweep = 0.55 + 0.45 * sin(p.y * 0.05 - uTime * 6.0);
  acc.rgb += uCutColor * 0.62 * exp(-abs(sd) / 52.0) * within * 0.5 * heat;
  acc.rgb += mix(uCutColor, vec3(1.0), 0.45) * exp(-abs(sd) / 8.0) * within * (0.5 + sweep * 0.7) * heat;
}

/** One wall's contribution to the cap — the body of capAt's loop. */
void wallCap(int i, vec2 p, inout float d) {
  vec4 w = uWalls[i];
  float r = uWallState[i].y;
  float wd = sdBox(p - w.xy, w.zw + r);
  float open = uWallState[i].x;
  if (open > 0.0) {
    // The slot is widened by the same reach, or the cap would leave a rim of
    // mass across an opening that is supposed to be clear.
    vec2 slot = w.z > w.w
      ? vec2(w.z * open * 1.02 + r, w.w * 4.0)
      : vec2(w.z * 4.0, w.w * open * 1.02 + r);
    wd = max(wd, -sdBox(p - w.xy, slot));
  }
  d = min(d, wd);
}

/**
 * The mass, exactly: distance in .x (negative is solid), and the reach of
 * whichever wall is nearest in .y.
 *
 * No randomness anywhere in here — that is the point. Membership is geometry,
 * so a cell's in-or-out never changes unless the collider does.
 *
 * The reach comes back with it because a block needs to know how far *its own*
 * wall lets it stretch. A single global number would either flatten the outer
 * shell or make every ruin twice the size of its collider.
 */
vec2 massAt(vec2 c) {
  float d = -sdBox(c - uArenaC, uArenaH);
  float r = uShellReach;
  float ids[TILE_CAP];
  tileIds(c, ids);
  if (ids[0] > 253.5 && ids[0] < 254.5) {
    for (int i = 0; i < MAX_WALLS; i++) {
      if (i >= uWallCount) break;
      wallMass(i, c, d, r);
    }
    return vec2(d, r);
  }
  for (int j = 0; j < TILE_CAP; j++) {
    if (ids[j] > 254.5) break;
    wallMass(int(ids[j] + 0.5), c, d, r);
  }
  return vec2(d, r);
}

/**
 * The outer bound on how far the picture may disagree with the collision.
 *
 * Box dilation, not distance subtraction. Subtracting a constant from an SDF is
 * the textbook way to grow a shape and it rounds every corner by exactly that
 * constant — which put soft radiused corners on brutalist slabs. Growing the
 * half-extents instead keeps the corners square.
 */
float capAt(vec2 p) {
  float d = -sdBox(p - uArenaC, max(vec2(1.0), uArenaH - uShellReach));
  float ids[TILE_CAP];
  tileIds(p, ids);
  if (ids[0] > 253.5 && ids[0] < 254.5) {
    for (int i = 0; i < MAX_WALLS; i++) {
      if (i >= uWallCount) break;
      wallCap(i, p, d);
    }
    return d;
  }
  for (int j = 0; j < TILE_CAP; j++) {
    if (ids[j] > 254.5) break;
    wallCap(int(ids[j] + 0.5), p, d);
  }
  return d;
}

/**
 * Distance to this layer's block at p, or a large positive number if the cell
 * this point falls in is not part of the mass.
 *
 * The animation, in four lines: one axis elongates, the perpendicular one drags
 * the centre a quarter-cycle behind it, then both come home. The phase offset is
 * what makes it read as travel rather than as breathing — the block reaches out,
 * *then* pulls its trailing edge after it.
 *
 * The amplitude re-rolls once per cycle and is interpolated across the whole of
 * it, so consecutive cycles hand off at exactly the value they finished on.
 * Nothing in here is ever discontinuous.
 */
float blockAt(vec2 p, float size, float seed, float bias, float layerExt, float grid, float cap, float fray, float decay) {
  // The grid is staggered per layer. Aligned, a column that misses on one layer
  // tends to miss on the next as well — and across a ruin only one or two cells
  // wide that reads as the grey bunching to one side and leaving the rest bare,
  // permanently, because placement never moves. Half a cell out of step means
  // one layer's seam sits over the other's centre.
  vec2 cell = floor(p / size - grid);
  vec2 c = (cell + 0.5 + grid) * size;

  vec2 m = massAt(c);
  // Depth proportional to the cell's own size, and per layer — **signed**.
  //
  // Positive is a requirement to be inside, and the base layer uses it: it is the
  // *black* mass, and black that hangs a long way past the collider stops
  // describing where the collider is. Where it does not qualify, the backing —
  // the same shade — covers for it.
  //
  // Negative is permission to be outside, and the greys use that. A rule saying
  // "grey may not go near the edge" is the exact opposite of what the grey is
  // for: it is the layer that overhangs, spills past the black and gets pulled
  // back. The cap still bounds every block, so letting membership out here costs
  // nothing in collider accuracy — it only decides which cells are allowed to
  // try.
  if (m.x > -size * bias) return 1e5;

  // Per-cell constants: where in the cycle it is, which way it stretches, and
  // where it sits. Constant forever — this is placement, not motion.
  //
  // Per *cell*, deliberately. There was an attempt to share the phase, the axis
  // and the amplitude across a coarse region so that a whole area would surge
  // together — the theory being that independent blocks read as a crowd rather
  // than as a mass. In practice it read far worse: a region moving as one unit
  // is a wobble, and a border made of wobbling regions looks like weed swaying,
  // not like architecture rearranging. The elegance is in the interference
  // between neighbours that disagree, and it does not survive being organised.
  float phase = hash21(cell + seed);
  float vertical = step(hash21(cell + seed + 3.1), 0.5);
  vec2 jit = vec2(hash21(cell + seed + 7.7), hash21(cell + seed + 13.9));
  jit = (jit - 0.5) * size * uJitter;

  float t = uQuarter / uCycle + phase;
  float turn = floor(t);
  float cp = fract(t);
  float a = hash21(cell + seed + turn * 19.3);
  float b = hash21(cell + seed + (turn + 1.0) * 19.3);
  // Squared: a flat amplitude puts as many blocks at the far end of the reach as
  // at the near end, and the boundary reads as an even fringe rather than as a
  // broken edge. Weighted toward stubs, with the occasional long finger.
  // Squared, then lifted off the floor. Squaring alone left most blocks barely
  // moving and a few reaching far, so the boundary was a row of nubs with the
  // occasional spike; the floor guarantees every block has some travel in it.
  float amp = mix(a, b, cp);
  amp = uAmpFloor + (1.0 - uAmpFloor) * amp * amp;

  float ang = cp * TAU;
  float reach = m.y * uExtend * layerExt * amp;
  // Capped against the block's *own* size. Without this a small block on a deep
  // reach elongates to five times its width and reads as a line rather than as
  // a slab — the one shape this vocabulary does not have.
  reach = min(reach, size * uMaxStretch);
  float ext = (0.5 - 0.5 * cos(ang)) * reach;
  float drag = sin(ang) * reach * 0.5;

  float inset = size * (uInset - uInsetPulse * uBar);
  // "half" is a reserved word in GLSL ES.
  vec2 halfExt = vec2(size * 0.5 - inset);
  vec2 off = jit;
  halfExt += vec2(1.0 - vertical, vertical) * ext;
  off += vec2(vertical, 1.0 - vertical) * drag;

  float d = sdBox(p - c - off, halfExt);

  // §8.3 — the edges fray. Perturbing the distance *is* perturbing the
  // silhouette, and it only shows where the distance is near zero, so no window
  // term is needed: the interior is covered by the layers over it and the
  // exterior is transparent.
  //
  // The amount arrives as an argument rather than being read from the zone table
  // here: this function runs six times a pixel and the material does not vary
  // between a pixel's own layers, so resolving it once in main is the same
  // picture for a sixth of the work.
  if (fray > 0.0) d += frayAt(p, size, uQuarter * 0.5) * fray * size;

  // §8.3 — the decay eats the silhouette the same way the fray does: by
  // perturbing the distance, which only ever shows where the distance is near
  // zero. decay arrives signed and already gated by the macro rot field —
  // resolved once per pixel in main, because the rot does not vary between a
  // pixel's own layers. Mostly it erodes; occasionally it billows, and the
  // cap below still clips whatever it grows.
  d += decay * size * 0.55;

  // Clipped to the mass at full dilation.
  //
  // Without this a block is only ever as accurate as its own size: a 340-unit
  // ruin under 230-unit cells becomes a cluster twice the collider, and cover
  // that looks like cover but is not is the one lie this system must never tell.
  return max(d, cap);
}

/**
 * Composite one layer onto a premultiplied accumulator, source-over.
 *
 * The mass pass has to be *transparent* where there is nothing, because it is
 * drawn on top of the entities — so it accumulates alpha instead of writing an
 * opaque colour.
 */
void put(inout vec4 acc, vec3 c, float a) {
  acc.rgb = c * a + acc.rgb * (1.0 - a);
  acc.a = a + acc.a * (1.0 - a);
}

void main(void) {
  vec2 px = vTextureCoord * uInputSize.xy + uOutputFrame.xy;
  vec2 p = (px - uOrigin) / uScale;
  // One screen pixel, in world units. Edges are antialiased against this so the
  // mass stays crisp at any zoom without shimmering.
  float aa = 1.0 / uScale;

  // ---- the floor pass --------------------------------------------------
  //
  // The shell renders twice, and the split is the whole reason: the ground has
  // to be *under* the ship and the mass has to be *over* it, so that walking
  // beneath an overhanging slab puts you beneath it. One pass cannot sit on both
  // sides of the same sprite.
  //
  // This half is flat and opaque — a grid, a pulse, and nothing else. Every gram
  // of surface detail that used to be here was the pseudo-realism. It is sampled
  // at a warped position so the avatar under load, and any vortex, visibly bend
  // the ground.
  if (uMode < 0.5) {
    vec2 fp = p;
    for (int i = 0; i < MAX_WARP; i++) {
      if (i >= uWarpCount) break;
      vec4 s = uWarp[i];
      vec2 dv = p - s.xy;
      float dl = length(dv);
      if (dl >= s.z || dl < 0.001) continue;
      float falloff = (1.0 - dl / s.z) * (1.0 - dl / s.z);
      fp -= dv * (falloff * s.w / dl);
      float twist = falloff * uSwirl[i];
      float c = cos(twist);
      float sn = sin(twist);
      fp += vec2(dv.x * c - dv.y * sn - dv.x, dv.x * sn + dv.y * c - dv.y);
    }

    vec3 col = uBase;
    // The grid breathes on the quarter note, and the architecture breathes with
    // it. Structure is the one layer that can pulse without ever competing with
    // a threat.
    float pulse = 1.0 + uPulse * 0.85;
    float lines = 1.0 - smoothstep(0.0, 1.3 * aa, gridDist(fp, 120.0));
    col += uStructure * lines * 0.26 * (0.75 + uLoad * 0.9) * pulse;

    // §8.3 — the sheen, on the ground the mass stands on.
    //
    // Thin-film interference: a drifting thickness field, and a colour read off
    // its contours the way oil on water reads its own depth. Two scales so the
    // bands break up rather than reading as contour lines, both advected — the
    // sheet *moves*, which is the whole effect. A slow travelling swell decides
    // where it is thick, so the room glistens in passing rather than wearing a
    // permanent pattern.
    //
    // Red is damped: on this palette a red fringe reads as rust, and the film
    // wants to sit violet-teal-green, like oil over dark water.
    //
    // Sampled at the *unwarped* position, unlike the grid: a vortex should bend
    // the lines drawn on the floor, not drag which room the floor belongs to.
    float oil = materialAt(p).x;
    if (oil > 0.0) {
      float film = vnoise(fp * 0.0042 + vec2(uTime * 0.028, uTime * -0.020))
                 + 0.45 * vnoise(fp * 0.013 + vec2(uTime * -0.019, uTime * 0.014));
      vec3 irid = 0.5 + 0.5 * cos(TAU * film * 2.2 + vec3(0.0, 2.1, 4.2));
      // Weighted cold. Green is what a blue-black floor lifts most readily, and
      // at equal weight the room went swamp; the brightness hierarchy is not
      // negotiable, so the film stays violet-teal and leaves the greens to
      // whatever is actually alive on the floor.
      irid *= vec3(0.45, 0.62, 1.0);
      float swell = 0.45 + 0.55 * sin(fp.x * 0.0016 + fp.y * 0.0011 - uTime * 0.45);
      // Lifted along the grid lines as well as across the field: the lines are
      // already the floor's structure, and a film catching on them ties the
      // shimmer to the room instead of floating over it.
      col += irid * oil * swell * (0.55 + 0.9 * lines) * pulse;
    }

    // A tint over the ground, luminance-preserving, so a biome changes the
    // colour of the room without changing how bright anything in it is.
    if (uTintAmount > 0.0) {
      float lum = dot(col, vec3(0.299, 0.587, 0.114));
      col = mix(col, uTint * (0.35 + lum * 2.2), uTintAmount);
    }
    finalColor = vec4(col, 1.0);
    return;
  }

  // ---- the mass pass ---------------------------------------------------
  //
  // Transparent everywhere there is no block, and drawn after the entities.
  vec4 acc = vec4(0.0);

  // A seal bends the door around itself before a single block is sampled, so
  // the structure is *deformed* by it rather than lit by it. Radial ripple plus
  // a slow swirl: the first says pressure, the second says something is turning.
  for (int i = 0; i < MAX_SEALS; i++) {
    if (i >= uSealCount) break;
    vec4 seal = uSeals[i];
    vec2 d = p - seal.xy;
    float dist = length(d);
    float k = 1.0 - smoothstep(0.0, seal.z * 3.2, dist);
    if (k < 0.002 || dist < 0.001) continue;
    float pull = k * k * seal.w;
    p += (d / dist) * sin(dist * 0.045 - uTime * 2.1) * pull * 15.0;
    float turn = pull * 0.22;
    float c = cos(turn);
    float sn = sin(turn);
    d = p - seal.xy;
    p = seal.xy + vec2(d.x * c - d.y * sn, d.x * sn + d.y * c);

    // The jamb faces shimmer. abs(abs(d.y) - halfHeight) is the distance to
    // *either* edge of the opening in one expression, so both get it.
    vec2 hb = uSealBox[i].xy;
    float jw = exp(-abs(abs(d.y) - hb.y) / (seal.z * 0.45))
             * exp(-abs(d.x) / max(1.0, hb.x * 1.2));
    p.x += sin(p.y * 0.09 - uTime * 3.4) * jw * 7.0 * seal.w;
  }

  // One cheap test decides whether this pixel pays for any of it.
  //
  // Every block body is clipped to the cap, so a pixel with cap > 0 cannot be
  // covered by one however the animation moves — and a shadow reaches at most
  // one offset past that. Below the guard is seven wall loops; above it, most of
  // the screen is floor and runs one.
  float cap = capAt(p);

  // §8.3 — where the rot currently sits, and what it is eating right here.
  //
  // rot is the slow macro field: it drifts across the arena over tens of
  // seconds, so a region visibly decays, heals, and the rot moves somewhere
  // else — decay as a *process*, not a permanent texture. rotEdge is the
  // per-pixel bite, signed and centred below the mean so the mass mostly
  // erodes and only occasionally billows. Both resolved once per pixel and
  // handed down, because they do not vary between a pixel's own layers.
  float rot = 0.0;
  float rotEdge = 0.0;
  float shredB = 0.0;
  vec2 shredDrift = vec2(0.0);
  vec2 curl = vec2(0.0);
  if ((uDecay > 0.001 || uShred > 0.001 || uDissolveMax > 0.001) && cap < 260.0) {
    // Turbulence, shared by every decomposition effect: a curl field that
    // bends the wisps and the fleck paths alike. Without it the motion is a
    // straight-line escalator off the edge, which is movement but not weather.
    vec2 tp = p * 0.016;
    vec2 trise = vec2(uTime * 0.02, uTime * 0.13);
    curl = vec2(vnoise(tp * 2.1 + trise.yx), vnoise(tp * 2.1 - trise)) - 0.5;

    if (uDecay > 0.001 || uShred > 0.001) {
      // The roaming rot: where the wave and the debris currently are. The
      // dissolve deliberately does NOT use it — dissolving edges are the
      // material's permanent condition, not an event passing through it.
      float rotN = vnoise(p * 0.0055 + vec2(uTime * 0.017, uTime * -0.011));
      float fine = decayAt(p);
      float rotM = 0.30 + 0.70 * rotN;
      rot = uDecay * rotM;
      rotEdge = (fine - 0.42) * rot;
      float vent = smoothstep(0.52, 0.85, rotN + 0.22 * (fine - 0.5));
      shredB = 65.0 * uShred * mix(0.12, 1.0, vent);
      if (shredB > 0.5) {
        // The local outward direction, from the cap's own gradient — two
        // extra tile-local samples. Flecks are carried along it with a slight
        // lift; the curl bends each path so no two escape the same way. The
        // epsilon keeps the deep interior (where the gradient collapses on
        // the medial axis) drifting gently upward instead of dividing by zero.
        vec2 g = vec2(capAt(p + vec2(9.0, 0.0)) - cap, capAt(p + vec2(0.0, 9.0)) - cap);
        shredDrift = -normalize(g + vec2(0.001, -3.0)) * uTime * 22.0 + curl * 30.0;
      }
    }
  }

  // The guard widens with the shred band and the bleed — matter drifts well
  // past the cap's usual margin, and a wisp clipped by an invisible rectangle
  // gives the secret away.
  float bleedBand = uDissolveMax * 46.0;
  if (cap < 48.0 + shredB * 2.0 + bleedBand * 0.7) {
    vec2 eye = p - uEye;
    // Which room's material these blocks wear, resolved once for every layer and
    // every shadow below. Dissolve is a *standing condition* of a room — see
    // LEVELS 3.2b — so it is placed in the world like the oil and the fray, and
    // not switched globally when the player crosses a threshold. Switching it
    // globally repainted the room behind them as they stepped through the gate.
    vec3 mat = materialAt(p);
    float fray = mat.y;
    float dissolve = mat.z;

    // Shadows first, all three, and taken as a max rather than multiplied.
    //
    // Three layers each casting a shadow used to compound: a spot lying under
    // all of them came out at a ninth of the mass, which is a flat pit of black.
    // One light source cannot cast a darker shadow by shining through more
    // objects. Applying the deepest one, once, is both more correct and lets the
    // strength go back up to where a slab reads as a slab.
    //
    // Light is fixed up-left. A faint lit edge on that side and a hard shadow
    // cast down-right is the entire lighting model, and it is all this dialect
    // wants — hard, because a soft shadow is a photograph and a hard one is a
    // drawing.
    float shade = 0.0;
    // The shadows dissolve with their blocks, and this mattered more than it
    // sounds. The shadow is offset down-right, so along a mass's lower edge
    // the outermost dark thing on screen is usually the shadow itself — left
    // crisp, it redrew the perfect boundary the dissolve had just eaten, and
    // every ruin came out frayed on top and razor-clean below. One shared
    // field for all three layers; they merge by max anyway.
    float sden = 0.5;
    if (dissolve > 0.001) {
      // Coarser than the block wisps on purpose: the boundary's wander is the
      // noise amplitude times the band, and fine grain averages itself away —
      // a 5px ripple on a 200px shadow line still reads as a ruler.
      vec2 shp = p * 0.032 + curl * 0.9 + vec2(uTime * 0.02, uTime * 0.07);
      sden = vnoise(shp) * 0.6 + vnoise(shp * 2.5 + 4.1) * 0.4;
      // Contrast-stretched, like every den below. Value noise concentrates
      // around 0.5 — an octave blend rarely leaves ±0.17 — so a bite sized
      // for a ±0.5 field delivers a third of its intended wander and every
      // "ragged" edge comes out as a ruler with a 2px tremble.
      sden = clamp((sden - 0.5) * 2.2 + 0.5, 0.0, 1.0);
    }
    for (int layer = 0; layer < 3; layer++) {
      // Indexed here rather than inside blockAt: GLSL ES only allows a vector to
      // be indexed by a constant or a loop symbol, and a function parameter is
      // neither.
      float size = uSizes[layer];
      float seed = float(layer) * 21.0 + 11.0;
      vec2 lp = p + eye * uDepth[layer];
      // Deliberately not clipped: a shadow falls on the floor beyond the block,
      // which is exactly where the cap is not.
      float sd = blockAt(lp - uShadowOffset * size, size, seed, uBiases[layer], uLayerExtend[layer], uGridOffset[layer], -1e5, fray, rotEdge);
      // The band does NOT shrink for the base layer. The first version scaled
      // it up with the layer index, which handed the 260-unit base blocks —
      // whose shadows are the longest, most visible straight lines on screen
      // — a one-pixel band, and every ruin kept a crisp rectangle under its
      // fray. The base's shadow needs the most eating, not the least.
      float sBand = dissolve * (30.0 + 6.0 * float(layer));
      float s1;
      if (sBand > 0.5) {
        // Inward-shifted like nothing else: a shadow that billowed outward
        // would exceed its own membership cells and cut. Eaten raggedly from
        // the edge in, it reads as the shadow of a dissolving thing.
        s1 = dissolved(sd + sBand * 0.7, sBand, sden, 0.9, aa);
      } else {
        s1 = 1.0 - smoothstep(-aa, aa, sd);
      }
      shade = max(shade, s1);
    }
    put(acc, vec3(0.0), uShadow * shade);

    // A solid backing over the collider itself, under every layer. Blocks are
    // inset so they have seams, and deep inside the mass those seams were
    // showing the floor through — slabs floating on the ground rather than a
    // wall with a broken edge. Out past the collider the gaps are correct and
    // wanted; over it they are a hole in something solid.
    // Its edge dissolves and shreds with the layers, or the softening
    // silhouette would sit on a perfectly crisp black plate wherever the
    // blocks thin over the collider and the whole effect would read as the
    // greys misbehaving.
    float bd0 = massAt(p).x + rotEdge * 44.0;
    // Wider than the blocks' bands, because this is where the outward wisps
    // live — the backing's field is continuous, so its smoke can drift past
    // the silhouette without ever meeting a cell seam.
    float bBand = dissolve * 11.0;
    float bCover;
    if (bBand > 0.5) {
      float bden = vnoise(p * 0.05 + curl * 0.8 + vec2(uTime * 0.03, uTime * 0.16) * 0.5);
      bCover = dissolved(bd0, bBand, bden, 0.34, aa);
    } else {
      bCover = 1.0 - smoothstep(-aa, aa, bd0);
    }
    put(acc, uMass * uBacking, shredCover(bd0, bCover, p, shredB * 0.8, shredDrift));

    // Three scales, back to front. Each is offset a little further from the
    // player than the last, which from above reads as slabs stacked toward you.
    for (int layer = 0; layer < 3; layer++) {
      float size = uSizes[layer];
      float seed = float(layer) * 21.0 + 11.0;
      vec2 lp = p + eye * uDepth[layer];

      float bd = blockAt(lp, size, seed, uBiases[layer], uLayerExtend[layer], uGridOffset[layer], cap, fray, rotEdge);

      // §8.3 — the dissolve: the block keeps its body and loses its boundary.
      // Band, grain, pace and bite all scale with the layer — the black base
      // barely breathes, the top grey is the most gone — so the z-axis reads
      // as progressive decomposition. The billow is sampled per layer through
      // the shared curl, decorrelated by the seed, so the wisps of adjacent
      // strata never move as one sheet.
      float fi = float(layer);
      float band = dissolve * (5.0 + 9.0 * fi);
      float cover;
      if (band > 0.5) {
        float speed = 0.5 + 0.5 * fi;
        vec2 sp = lp * (0.05 + 0.02 * fi);
        // The vertical advection stays gentle. At the old rate the wisp
        // pattern streamed upward hard enough that top edges shed while
        // bottom edges swallowed their own fray — every ruin came out
        // lopsided. The bleed keeps the visible rise; the edges stay evenly
        // eaten on all sides.
        vec2 rise = vec2(uTime * 0.03, uTime * 0.085) * speed;
        float den = vnoise(sp + curl * (0.8 + 0.5 * fi) + rise + fi * 5.1) * 0.6
                  + vnoise(sp * 2.6 + curl * (1.6 + fi) + rise * 1.8 + fi * 2.3) * 0.4;
        den = clamp((den - 0.5) * 2.2 + 0.5, 0.0, 1.0);
        // Symmetric: the wisps exceed the block's boundary — dissolving means
        // getting BIGGER, ink into water, not a cloud evaporating. Membership
        // is quantised per cell, so past the mass's own silhouette those
        // outward wisps would end in razor cuts at empty-cell seams; the fade
        // on the next line hands them over, continuously, to the bleed below,
        // which owns everything beyond the boundary and cannot cut.
        cover = dissolved(bd, band, den, 0.30 + 0.30 * fi, aa);
        cover *= 1.0 - smoothstep(0.0, 10.0, bd) * smoothstep(2.0, 26.0, bd0);
      } else {
        cover = 1.0 - smoothstep(-aa, aa, bd);
      }
      // Offset by the layer seed so the three layers do not share one fleck
      // pattern — shared crumbs read as a screen effect, not a material one.
      cover = shredCover(bd, cover, lp + seed, shredB, shredDrift);
      if (cover > 0.001) {
        vec3 body = uMass * uShades[layer];
        // The lit edge: a hairline inside the top and left borders only. A
        // crisp lit hairline on a dissolving border is a contradiction, so it
        // fades out as the dissolve comes in.
        vec2 rel = lp - (floor(lp / size - uGridOffset[layer]) + 0.5 + uGridOffset[layer]) * size;
        float edge = smoothstep(-2.2 * aa, 0.0, bd);
        float side = max(step(rel.x, 0.0), step(rel.y, 0.0));
        body += uMass * edge * side * uEdge * max(0.0, 1.0 - dissolve);
        put(acc, body, cover);
      }
    }

    // ---- the bleed --------------------------------------------------------
    //
    // §8.3 — the drop of ink: the mass exceeding its boundary. Anchored to
    // the union field (continuous, cannot cut at cell seams), it spreads dark
    // tendrils past the silhouette — dense laps over the edge, ragged fingers
    // to about seventy units, rare tips beyond, thinning by dissolution
    // rather than at a radius. Masked off deep inside so it never repaints
    // the interior. It is the MASS's own near-black at high opacity, not a
    // lighter grey at a whisper: the first version tinted it a hair off the
    // floor colour at half alpha, which measured as present and read as
    // nothing. Ink has to be opaque to be ink.
    if (bleedBand > 0.5) {
      vec2 bp = p * 0.042 + curl * 1.1 + vec2(uTime * 0.025, uTime * 0.14);
      float bden = vnoise(bp) * 0.6 + vnoise(bp * 2.7 + vec2(2.2, uTime * 0.1)) * 0.4;
      bden = clamp((bden - 0.5) * 2.2 + 0.5, 0.0, 1.0);
      float bt = clamp((bd0 + bleedBand) / (bleedBand * 2.6), 0.0, 1.0);
      // Noise-thresholded, not noise-nudged: the threshold rises with the
      // distance and the ink is near-opaque wherever it passes. The previous
      // additive form made alpha fall smoothly with distance, which is a
      // gradient skirt with a straight rim — the boundary of THIS form is a
      // contour line of the noise itself, which is what fingers look like.
      float th = mix(0.30, 0.82, bt);
      float a = smoothstep(th, th + 0.10, bden) * 0.92;
      a *= smoothstep(-bleedBand, -bleedBand * 0.25, bd0);
      a *= 1.0 - smoothstep(0.90, 1.0, bt);
      if (a > 0.003) put(acc, uMass * 0.9, a);
    }
  }

  // ---- the ship is never lost under a slab -----------------------------
  //
  // Scaling a premultiplied colour scales its coverage, so this thins the mass
  // over the avatar rather than punching a hole in it: you read as being *under*
  // something instead of simply absent.
  //
  // It also fixes a smaller wrongness. The post pass lights the whole stage, the
  // mass included — so with full occlusion the ship vanished while its own glow
  // went on burning on the slab above it, which is a light with nothing making
  // it. Thin the slab and the glow belongs to something visible again.
  if (uVeil > 0.0) {
    float hole = 1.0 - smoothstep(uVeilRadius * 0.35, uVeilRadius, distance(p, uEye));
    acc *= 1.0 - uVeil * hole;
  }

  // ---- the gate, opening ----------------------------------------------
  //
  // The blocks withdraw on their own — that is what the field does when the slot
  // grows — so all this adds is the light coming through from the other side.
  // Two weights: a hot core on the new edge and a wide bleed off it. It is the
  // brightest structure ever gets, and it lasts two seconds.
  //
  // Added to the premultiplied colour without raising alpha, which under
  // source-over is exactly an emissive glow: it lights whatever is behind it
  // rather than covering it.
  {
    float ids[TILE_CAP];
    tileIds(p, ids);
    if (ids[0] > 253.5 && ids[0] < 254.5) {
      for (int i = 0; i < MAX_WALLS; i++) {
        if (i >= uWallCount) break;
        gateCut(i, p, acc);
      }
    } else {
      for (int j = 0; j < TILE_CAP; j++) {
        if (ids[j] > 254.5) break;
        gateCut(int(ids[j] + 0.5), p, acc);
      }
    }
  }

  // Surfaces catch light, mass included — see uMassLit for why it is small.
  if (uMassLit > 0.0 && acc.a > 0.001) {
    vec3 light = texture(uLight, px / uScreenPx).rgb;
    light = light / (1.0 + light);
    acc.rgb += acc.rgb * light * uMassLit * 5.0;
  }

  // ---- the seal, burning ------------------------------------------------
  //
  // Added to the premultiplied colour without touching alpha, which under
  // source-over is emission: it lights the door instead of covering it.
  //
  // The distribution is the whole point and it took two attempts to get right.
  // A graded disc reads as an object stuck on a wall. What reads as *dangerous*
  // is a source small enough to be almost white with a reach far larger than
  // itself — so the core is a sixth of the radius and the halo runs past it,
  // with rays turning slowly and a sparse spark field so it never sits still.
  for (int i = 0; i < MAX_SEALS; i++) {
    if (i >= uSealCount) break;
    vec4 seal = uSeals[i];
    vec2 d = p - seal.xy;
    float dist = length(d);
    if (dist > seal.z * 4.5) continue;
    float core = exp(-dist / (seal.z * 0.15));
    float halo = exp(-dist / (seal.z * 1.15));
    float ang = atan(d.y, d.x);

    // Filaments, not a pinwheel. A single sine on the angle gives evenly spaced
    // petals and the whole thing reads as a flower — three incommensurate
    // harmonics drifting at different speeds never line up, so the light breaks
    // into strands that wander. The radial term gives them ends.
    float fil = sin(ang * 7.0 + uTime * 0.50) * 0.50
              + sin(ang * 13.0 - uTime * 0.31 + 1.7) * 0.32
              + sin(ang * 23.0 + uTime * 0.19 + 4.2) * 0.18;
    float rays = (0.74 + 0.26 * fil) * (0.86 + 0.14 * sin(dist * 0.04 - uTime * 1.6 + ang * 3.0));

    // Embers, in polar cells. On a square grid they slide across the screen in a
    // straight line, which is drifting dust; binned by angle and radius with the
    // angle bin turning faster the closer it is, they orbit instead.
    float orbit = uTime * (0.55 + 0.75 * fract(dist * 0.013));
    vec2 cell = floor(vec2((ang + orbit) * 9.0, dist * 0.085));
    float seed = hash21(cell);
    float spark = step(0.982, seed) * (0.45 + 0.55 * sin(uTime * 5.0 + seed * 60.0));

    vec3 deep = vec3(1.0, 0.10, 0.07);
    acc.rgb += deep * (core * 2.4 + halo * 0.6 * rays) * seal.w;
    acc.rgb += vec3(1.0, 0.72, 0.66) * core * core * 1.8 * seal.w;
    acc.rgb += vec3(1.0, 0.35, 0.28) * max(spark, 0.0) * halo * 2.8 * seal.w;

    // The anamorphic streak. One horizontal blade, very thin and very long —
    // the artefact a real lens makes on a point source, and the cheapest thing
    // that tells the eye it is looking at a light rather than a painted dot.
    // It runs along the corridor, which is also the axis the door opens on.
    float streak = exp(-abs(d.y) / (seal.z * 0.085)) * exp(-abs(d.x) / (seal.z * 2.6));
    acc.rgb += vec3(1.0, 0.28, 0.20) * streak * 0.75 * seal.w;

    // One ghost ring, out where the halo has already fallen away. Discrete
    // ghosts down the axis need an array constructor this shader cannot rely on
    // in its WebGL1 fallback, and a single annulus reads as flare regardless.
    float ring = exp(-abs(dist - seal.z * 1.9) / (seal.z * 0.16));
    acc.rgb += vec3(0.85, 0.22, 0.30) * ring * 0.16 * seal.w;

    // ---- the jambs -----------------------------------------------------
    //
    // Motes drawn *inward*, not rising: embers going up would be a fire, and
    // this is a door breathing in. Each column drifts at its own speed so the
    // field never moves as a sheet.
    vec2 hb = uSealBox[i].xy;
    float jambGlow = uSealBox[i].z;
    float motes = uSealBox[i].w;
    for (int j = 0; j < 2; j++) {
      float sgn = float(j) * 2.0 - 1.0;
      vec2 jd = p - (seal.xy + vec2(0.0, sgn * hb.y));
      float near = exp(-abs(jd.y) / (seal.z * 0.55)) * exp(-abs(jd.x) / max(1.0, hb.x * 0.9));
      if (near < 0.004) continue;

      // A cold ember bar along the face. Dim on purpose — the seal is the only
      // thing here allowed to be bright.
      acc.rgb += vec3(1.0, 0.20, 0.14) * near * jambGlow * seal.w;

      float lane = fract(floor(jd.x / 11.0) * 0.37);
      vec2 mp = vec2(jd.x, jd.y - sgn * uTime * (13.0 + 27.0 * lane));
      vec2 mcell = floor(mp / 11.0);
      float mseed = hash21(mcell + float(j) * 5.3);
      float mote = step(0.945, mseed);
      vec2 mf = fract(mp / 11.0) - 0.5;
      mote *= smoothstep(0.34, 0.02, length(mf));
      acc.rgb += vec3(1.0, 0.42, 0.30) * mote * near * motes * seal.w;
    }
  }

  finalColor = acc;
}
`;

export class StructurePass {
  readonly filter: Filter;
  private time = 0;
  private swell = 1;
  /** The broadphase tile lists, and the source the shader samples them from. */
  private readonly tileData = new Uint8Array(TILES * 3 * TILES * 4);
  private readonly tileSource: BufferImageSource;
  /** Per-tile fill counts, reused across builds. */
  private readonly tileFill = new Int32Array(TILES * TILES);
  /**
   * How far a wall's influence can reach past its own box, from the style:
   * its blocks' membership slack plus shadow and parallax offsets. Everything
   * a tile must include to make the shader's tile-local answers exact.
   */
  private margin = 210;
  /** The culled wall set last binned, so an unchanged frame skips the upload. */
  private tileKey = '';

  constructor() {
    this.tileSource = new BufferImageSource({
      resource: this.tileData,
      width: TILES * 3,
      height: TILES,
      format: 'rgba8unorm',
      scaleMode: 'nearest',
      // This is data, not a picture. Pixi's default alpha mode premultiplies
      // RGB by alpha on upload — and the fourth wall index in a tile lives in
      // the alpha channel, so any tile listing four or more walls came back
      // with its first three indices scaled to garbage. Dense rooms lost
      // random cells; sparse rooms (and every unit probe) looked fine.
      alphaMode: 'no-premultiply-alpha',
    });
    this.filter = new Filter({
      glProgram: new GlProgram({ vertex, fragment, name: 'overclock-shell' }),
      resources: {
        shellUniforms: {
          uOrigin: { value: new Float32Array([0, 0]), type: 'vec2<f32>' },
          uScale: { value: 1, type: 'f32' },
          uArenaC: { value: new Float32Array([0, 0]), type: 'vec2<f32>' },
          uArenaH: { value: new Float32Array([1, 1]), type: 'vec2<f32>' },
          uShellReach: { value: 130, type: 'f32' },
          uWalls: { value: new Float32Array(MAX_WALLS * 4), type: 'vec4<f32>', size: MAX_WALLS },
          uWallState: { value: new Float32Array(MAX_WALLS * 4), type: 'vec4<f32>', size: MAX_WALLS },
          uWallCount: { value: 0, type: 'i32' },
          uWarp: { value: new Float32Array(MAX_WARP * 4), type: 'vec4<f32>', size: MAX_WARP },
          uSwirl: { value: new Float32Array(MAX_WARP), type: 'f32', size: MAX_WARP },
          uWarpCount: { value: 0, type: 'i32' },
          uStructure: { value: new Float32Array([0.16, 0.23, 0.32]), type: 'vec3<f32>' },
          uBase: { value: new Float32Array([0.02, 0.04, 0.07]), type: 'vec3<f32>' },
          uMass: { value: new Float32Array([0.02, 0.02, 0.03]), type: 'vec3<f32>' },
          uTint: { value: new Float32Array([1, 1, 1]), type: 'vec3<f32>' },
          uTintAmount: { value: 0, type: 'f32' },
          uSizes: { value: new Float32Array([260, 124, 78]), type: 'vec3<f32>' },
          uShades: { value: new Float32Array([0.5, 0.74, 1]), type: 'vec3<f32>' },
          uDepth: { value: new Float32Array([0, 0.01, 0.02]), type: 'vec3<f32>' },
          uCycle: { value: 4, type: 'f32' },
          uExtend: { value: 1.6, type: 'f32' },
          uInset: { value: 0.04, type: 'f32' },
          uLayerExtend: { value: new Float32Array([0.1, 1, 1.3]), type: 'vec3<f32>' },
          uBiases: { value: new Float32Array([0.4, -0.12, -0.2]), type: 'vec3<f32>' },
          uGridOffset: { value: new Float32Array([0, 0, 0.5]), type: 'vec3<f32>' },
          uAmpFloor: { value: 0.25, type: 'f32' },
          uMaxStretch: { value: 0.75, type: 'f32' },
          uInsetPulse: { value: 0.032, type: 'f32' },
          uJitter: { value: 0.12, type: 'f32' },
          uEdge: { value: 0.3, type: 'f32' },
          uOil: { value: 0, type: 'f32' },
          uFray: { value: 0, type: 'f32' },
          uDecay: { value: 0, type: 'f32' },
          uShred: { value: 0, type: 'f32' },
          uDissolve: { value: 0, type: 'f32' },
          uDissolveMax: { value: 0, type: 'f32' },
          uZoneRect: { value: new Float32Array(MAX_ZONES * 4), type: 'vec4<f32>', size: MAX_ZONES },
          uZoneMat: { value: new Float32Array(MAX_ZONES * 4), type: 'vec4<f32>', size: MAX_ZONES },
          uZoneCount: { value: 0, type: 'i32' },
          uZoneBlend: { value: new Float32Array([140, 420]), type: 'vec2<f32>' },
          uShadow: { value: 0.5, type: 'f32' },
          uShadowOffset: { value: new Float32Array([0.1, 0.14]), type: 'vec2<f32>' },
          uBacking: { value: 0.5, type: 'f32' },
          uPulse: { value: 0, type: 'f32' },
          uBar: { value: 0, type: 'f32' },
          uQuarter: { value: 0, type: 'f32' },
          uLoad: { value: 0, type: 'f32' },
          uTime: { value: 0, type: 'f32' },
          uEye: { value: new Float32Array([0, 0]), type: 'vec2<f32>' },
          uMode: { value: 0, type: 'f32' },
          uMassLit: { value: 0, type: 'f32' },
          uCutColor: { value: new Float32Array([0.62, 0.88, 1]), type: 'vec3<f32>' },
          uSeals: { value: new Float32Array(4 * 4), type: 'vec4<f32>', size: 4 },
          uSealBox: { value: new Float32Array(4 * 4), type: 'vec4<f32>', size: 4 },
          uSealCount: { value: 0, type: 'i32' },
          uScreenPx: { value: new Float32Array([1, 1]), type: 'vec2<f32>' },
          uVeil: { value: 0, type: 'f32' },
          uVeilRadius: { value: 110, type: 'f32' },
          uTileOrigin: { value: new Float32Array([0, 0]), type: 'vec2<f32>' },
          uTileInv: { value: new Float32Array([1, 1]), type: 'vec2<f32>' },
          uTileMax: { value: new Float32Array([TILES - 1, TILES - 1]), type: 'vec2<f32>' },
        },
        uLight: Texture.EMPTY.source,
        uTiles: this.tileSource,
      },
    });
  }

  private get u(): Record<string, unknown> {
    return this.filter.resources.shellUniforms.uniforms as Record<string, unknown>;
  }

  /**
   * Which half this instance draws. Two instances render the same field: the
   * floor beneath the entities and the mass above them, so an overhanging slab
   * occludes the ship walking under it.
   */
  setMode(mode: number): void {
    (this.u as Record<string, number>).uMode = mode;
  }

  /** Point the mass pass at the light field, and say how much of it it takes. */
  setLight(texture: Texture, amount: number, screenW: number, screenH: number): void {
    this.filter.resources.uLight = texture.source;
    const u = this.u;
    (u as Record<string, number>).uMassLit = amount;
    const px = u.uScreenPx as Float32Array;
    px[0] = screenW;
    px[1] = screenH;
  }

  /** Grid, floor and mass colours. Fixed by §16.2; set once. */
  setPalette(structure: number, base: number, mass: number): void {
    const u = this.u;
    writeColor(u.uStructure as Float32Array, structure);
    writeColor(u.uBase as Float32Array, base);
    writeColor(u.uMass as Float32Array, mass);
  }

  /** Everything tunable, in one call, from `SHELL`. */
  setStyle(s: ShellStyle): void {
    const u = this.u;
    write3(u.uSizes as Float32Array, s.sizes);
    write3(u.uShades as Float32Array, s.shades);
    write3(u.uDepth as Float32Array, s.depth);
    const drop = u.uShadowOffset as Float32Array;
    drop[0] = s.shadowOffset[0];
    drop[1] = s.shadowOffset[1];
    const n = u as Record<string, number>;
    n.uCycle = s.cycleBeats;
    this.swell = s.swell;
    n.uExtend = s.extend;
    n.uInset = s.inset;
    write3(u.uLayerExtend as Float32Array, s.layerExtend);
    write3(u.uBiases as Float32Array, s.biases);
    write3(u.uGridOffset as Float32Array, s.gridOffset);
    n.uAmpFloor = s.ampFloor;
    n.uMaxStretch = s.maxStretch;
    n.uVeil = s.veil;
    n.uVeilRadius = s.veilRadius;
    // A wall reaches a tile through its largest block: half a cell of snap, the
    // stretch, the jitter, the shadow offset. Sixty per cent of the big layer's
    // size covers all of it with slack; the flat pad is the seal warp; the
    // shred term is how far its flecks can drift past the silhouette — the
    // cap has to stay accurate out to the farthest fleck or the outer fringe
    // pops at tile seams.
    this.margin = s.sizes[0] * 0.6 + 80 + s.shred * 130;
    this.tileKey = '';
    n.uInsetPulse = s.insetPulse;
    n.uJitter = s.jitter;
    // `oil` and `fray` are deliberately NOT written here, and the omission is
    // load-bearing. Everything else in a style is geometry the whole arena
    // shares — block sizes, churn tempo — and switching it on a room change is
    // invisible because the picture off screen was never different. Those two
    // are *material*, they are dramatic, and switching them globally repainted
    // the room behind the player the moment they stepped through a gate. They
    // come from `setMaterialZones` instead, which places them.
    n.uEdge = s.edge;
    n.uShadow = s.shadow;
    n.uBacking = s.backing;
    n.uShellReach = s.shellReach;
    n.uDecay = s.decay;
    n.uShred = s.shred;
    // `dissolve` is deliberately NOT written here, for the same reason `oil` and
    // `fray` are not: it is a property of a *place*. `decay` and `shred` stay
    // global because they genuinely are events roaming the whole arena.
  }

  /**
   * The camera, as the shader needs it: where world (0,0) lands on screen, how
   * many pixels a world unit is worth, and where the eye is — the point every
   * layer's parallax is measured from.
   */
  setCamera(originX: number, originY: number, scale: number, eyeX: number, eyeY: number): void {
    const u = this.u;
    const o = u.uOrigin as Float32Array;
    o[0] = originX;
    o[1] = originY;
    (u as Record<string, number>).uScale = scale;
    const eye = u.uEye as Float32Array;
    eye[0] = eyeX;
    eye[1] = eyeY;
  }

  setArena(width: number, height: number): void {
    const u = this.u;
    const c = u.uArenaC as Float32Array;
    const h = u.uArenaH as Float32Array;
    c[0] = width / 2;
    c[1] = height / 2;
    h[0] = width / 2;
    h[1] = height / 2;
  }

  /**
   * This frame's walls, already culled to what is visible.
   *
   * The shader loops over these once per cell lookup — seven times a pixel — so
   * what is off camera must not be paid for. The cap is twenty-four because a
   * gate is eighteen rects on its own: articulation costs slots, and a screen
   * that drops half a doorway is worse than one that pays for the loop.
   */
  setWalls(
    walls: readonly ShellWall[],
    view: { x: number; y: number; width: number; height: number },
  ): void {
    const u = this.u;
    const geo = u.uWalls as Float32Array;
    const state = u.uWallState as Float32Array;
    const n = Math.min(MAX_WALLS, walls.length);
    for (let i = 0; i < n; i++) {
      const w = walls[i]!;
      geo[i * 4] = w.x + w.w / 2;
      geo[i * 4 + 1] = w.y + w.h / 2;
      geo[i * 4 + 2] = w.w / 2;
      geo[i * 4 + 3] = w.h / 2;
      state[i * 4] = w.open;
      state[i * 4 + 1] = w.reach;
      state[i * 4 + 2] = w.glow;
    }
    (u as Record<string, number>).uWallCount = n;

    // ---- the broadphase ---------------------------------------------------
    //
    // The grid is snapped to 64-unit steps so a drifting camera does not re-bin
    // every frame: the origin only moves when the view crosses a step, and the
    // extent carries one extra step so snapping never exposes an untiled strip.
    // Openness and glow are deliberately not in the key — a gate animating is a
    // state change on a wall the grid already lists.
    const snap = 64;
    const x0 = Math.floor((view.x - VIEW_PAD) / snap) * snap;
    const y0 = Math.floor((view.y - VIEW_PAD) / snap) * snap;
    const w = view.width + VIEW_PAD * 2 + snap;
    const h = view.height + VIEW_PAD * 2 + snap;

    let key = `${x0},${y0},${Math.ceil(w)}`;
    for (let i = 0; i < n; i++) {
      const wl = walls[i]!;
      key += `|${wl.x},${wl.y},${wl.w},${wl.h},${wl.reach}`;
    }
    if (key === this.tileKey) return;
    this.tileKey = key;

    const tw = w / TILES;
    const th = h / TILES;
    const data = this.tileData;
    const fill = this.tileFill;
    data.fill(TILE_END);
    fill.fill(0);
    for (let i = 0; i < n; i++) {
      const wl = walls[i]!;
      const reach = this.margin + wl.reach;
      const tx0 = Math.max(0, Math.floor((wl.x - reach - x0) / tw));
      const ty0 = Math.max(0, Math.floor((wl.y - reach - y0) / th));
      const tx1 = Math.min(TILES - 1, Math.floor((wl.x + wl.w + reach - x0) / tw));
      const ty1 = Math.min(TILES - 1, Math.floor((wl.y + wl.h + reach - y0) / th));
      for (let ty = ty0; ty <= ty1; ty++) {
        for (let tx = tx0; tx <= tx1; tx++) {
          const t = ty * TILES + tx;
          const count = fill[t]!;
          fill[t] = count + 1;
          const base = (ty * TILES * 3 + tx * 3) * 4;
          if (count >= TILE_CAP) {
            data[base] = TILE_OVERFLOW;
          } else {
            data[base + count] = i;
          }
        }
      }
    }

    const origin = u.uTileOrigin as Float32Array;
    origin[0] = x0;
    origin[1] = y0;
    const inv = u.uTileInv as Float32Array;
    inv[0] = 1 / tw;
    inv[1] = 1 / th;
    this.tileSource.update();
  }

  setWarp(sources: readonly ShellWarp[]): void {
    const u = this.u;
    const data = u.uWarp as Float32Array;
    const swirl = u.uSwirl as Float32Array;
    const n = Math.min(MAX_WARP, sources.length);
    for (let i = 0; i < n; i++) {
      const s = sources[i]!;
      data[i * 4] = s.x;
      data[i * 4 + 1] = s.y;
      data[i * 4 + 2] = s.radius;
      data[i * 4 + 3] = s.pull;
      swirl[i] = s.swirl;
    }
    (u as Record<string, number>).uWarpCount = n;
  }

  /** §21b.5 — the seals burning in this frame's sealed gates. */
  setSeals(seals: readonly ShellSeal[]): void {
    const u = this.u;
    const data = u.uSeals as Float32Array;
    const box = u.uSealBox as Float32Array;
    const n = Math.min(4, seals.length);
    for (let i = 0; i < n; i++) {
      const s = seals[i]!;
      data[i * 4] = s.x;
      data[i * 4 + 1] = s.y;
      data[i * 4 + 2] = s.radius;
      data[i * 4 + 3] = s.intensity;
      box[i * 4] = s.halfW;
      box[i * 4 + 1] = s.halfH;
      box[i * 4 + 2] = s.jambGlow;
      box[i * 4 + 3] = s.motes;
    }
    (u as Record<string, number>).uSealCount = n;
  }

  /** §21b.5 — the colour a gate's cut burns, taken from the level it opens. */
  setCutColor(color: number): void {
    writeColor(this.u.uCutColor as Float32Array, color);
  }

  /**
   * §8.3 — where the materials are, in world space.
   *
   * Set once per arena, not per room change: the whole point is that a room's
   * oil and fray belong to its floor and its blocks rather than to the camera,
   * so walking through a doorway resolves them per pixel instead of repainting
   * the screen. `base` is what a room that declares neither looks like.
   */
  setMaterialZones(
    base: { oil: number; fray: number; dissolve: number },
    zones: readonly MaterialZone[],
  ): void {
    const u = this.u;
    const n = u as Record<string, number>;
    n.uOil = base.oil;
    n.uFray = base.fray;
    n.uDissolve = base.dissolve;
    const rect = u.uZoneRect as Float32Array;
    const mat = u.uZoneMat as Float32Array;
    const count = Math.min(MAX_ZONES, zones.length);
    for (let i = 0; i < count; i++) {
      const z = zones[i]!;
      rect[i * 4] = z.x + z.w / 2;
      rect[i * 4 + 1] = z.y + z.h / 2;
      rect[i * 4 + 2] = z.w / 2;
      rect[i * 4 + 3] = z.h / 2;
      mat[i * 4] = z.oil;
      mat[i * 4 + 1] = z.fray;
      mat[i * 4 + 2] = z.dissolve;
    }
    n.uZoneCount = count;
    // The worst case on screen, for the guards. See `uDissolveMax`.
    let worst = base.dissolve;
    for (let i = 0; i < count; i++) worst = Math.max(worst, zones[i]!.dissolve);
    n.uDissolveMax = worst;
  }

  /** Biome colour and how much of it. Zero amount is the plain Core. */
  setTint(color: number, amount: number): void {
    const u = this.u;
    writeColor(u.uTint as Float32Array, color);
    (u as Record<string, number>).uTintAmount = amount;
  }

  /**
   * `quarter` is monotonic quarter-notes; `pulse` is 1 on the beat.
   *
   * The mass swells on the *bar*, not the quarter — four swells a measure reads
   * as a flutter, one reads as the room breathing. The grid keeps the quarter,
   * which is §18.2's original bargain and a much smaller motion.
   *
   * A raised cosine, not the audio clock's envelope. That envelope is a hard
   * jump to 1 on the beat followed by a decay, which is exactly right for a grid
   * line and exactly wrong for a wall: the step has no width, so the mass looked
   * like it was glitching rather than breathing. This peaks *at* the downbeat
   * and is smooth everywhere, so the swell arrives and leaves.
   */
  update(pulse: number, quarter: number, load: number, dt: number): void {
    this.time = (this.time + dt) % 10000;
    const u = this.u as Record<string, number>;
    u.uPulse = pulse;
    const phase = ((((quarter / 4) % 1) + 1) % 1) * Math.PI * 2;
    u.uBar = Math.pow(0.5 + 0.5 * Math.cos(phase), this.swell);
    u.uQuarter = quarter;
    u.uLoad = load;
    u.uTime = this.time;
  }
}

function writeColor(target: Float32Array, hex: number): void {
  target[0] = ((hex >> 16) & 0xff) / 255;
  target[1] = ((hex >> 8) & 0xff) / 255;
  target[2] = (hex & 0xff) / 255;
}

function write3(target: Float32Array, source: readonly [number, number, number]): void {
  target[0] = source[0];
  target[1] = source[1];
  target[2] = source[2];
}
