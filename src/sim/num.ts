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

/**
 * ---
 *
 * `Math.sin` and `Math.cos` have exactly the same freedom, and they use it.
 *
 * Measured, after an 11:41 run replayed clean in Chrome and diverged in Node at
 * tick 3120: fingerprinting both runtimes over 200,000 arguments, `sin` and
 * `cos` disagree while `atan2`, `pow`, `sqrt` and `exp` are bit-identical. So
 * the sim computes its own, out of operations IEEE-754 *does* pin down —
 * addition, subtraction, multiplication and division are all correctly rounded,
 * so a polynomial in them returns the same bits everywhere.
 *
 * The method is fdlibm's, which is where most engines got theirs:
 *
 *   1. **Range reduction.** Find `n`, the nearest multiple of π/2, and subtract
 *      it in two pieces. One `double` cannot hold π/2 to enough digits for the
 *      subtraction to stay accurate once `n` is large, so `PIO2_HI` carries the
 *      top 33 bits (exactly representable, so `n * PIO2_HI` is exact) and
 *      `PIO2_LO` carries the rest. This is Cody-Waite reduction, and it holds to
 *      roughly |x| < 2e6 — several orders of magnitude past anything this sim
 *      asks for, since its angles are `time × rate` in the low thousands.
 *
 *   2. **Kernel.** A minimax polynomial on the reduced argument, |r| ≤ π/4,
 *      accurate to well under one ulp. Which kernel and which sign comes from
 *      `n mod 4` — the quadrant.
 *
 * Accuracy against the platform's own `Math.sin`/`Math.cos` is under 1e-15
 * absolute across the sim's range (asserted in `num.test.ts`). That is far finer
 * than the digest's 1e-4 quantisation, so switching to these changes no
 * observable behaviour — but it changes the last bits, which invalidates every
 * recording made before it.
 */

/** π/2, split so that `n * PIO2_HI` is exact for every `n` this reduction sees. */
const PIO2_HI = 1.5707963267341256e0;
const PIO2_LO = 6.077100506506192e-11;
const TWO_OVER_PI = 0.6366197723675814;

/** fdlibm's `__kernel_sin` coefficients. Minimax on [-π/4, π/4]. */
const S1 = -1.66666666666666324348e-1;
const S2 = 8.33333333332248946124e-3;
const S3 = -1.98412698298579493134e-4;
const S4 = 2.75573137070700676789e-6;
const S5 = -2.50507602534068634195e-8;
const S6 = 1.58969099521155010221e-10;

/** fdlibm's `__kernel_cos` coefficients. */
const C1 = 4.16666666666666019037e-2;
const C2 = -1.38888888888741095749e-3;
const C3 = 2.48015872894767294178e-5;
const C4 = -2.75573143513906633035e-7;
const C5 = 2.08757232129817482790e-9;
const C6 = -1.13596475577881948265e-11;

function kernelSin(x: number): number {
  const z = x * x;
  return x + x * z * (S1 + z * (S2 + z * (S3 + z * (S4 + z * (S5 + z * S6)))));
}

function kernelCos(x: number): number {
  const z = x * x;
  const r = z * (C1 + z * (C2 + z * (C3 + z * (C4 + z * (C5 + z * C6)))));
  // Written as `(1 - hz) + (z*r - ...)` rather than `1 - hz + z*r` so the two
  // small terms are summed before they meet the 1, which is where the accuracy
  // near ±π/4 comes from.
  const hz = 0.5 * z;
  const w = 1 - hz;
  return w + (1 - w - hz + z * r);
}

/** Sine. Exactly reproducible on every JS engine. */
export function sin(x: number): number {
  const n = Math.round(x * TWO_OVER_PI);
  const r = x - n * PIO2_HI - n * PIO2_LO;
  const q = ((n % 4) + 4) % 4;
  if (q === 0) return kernelSin(r);
  if (q === 1) return kernelCos(r);
  if (q === 2) return -kernelSin(r);
  return -kernelCos(r);
}

/** Cosine. Exactly reproducible on every JS engine. */
export function cos(x: number): number {
  const n = Math.round(x * TWO_OVER_PI);
  const r = x - n * PIO2_HI - n * PIO2_LO;
  const q = ((n % 4) + 4) % 4;
  if (q === 0) return kernelCos(r);
  if (q === 1) return -kernelSin(r);
  if (q === 2) return -kernelCos(r);
  return kernelSin(r);
}

/**
 * ---
 *
 * The same treatment for `atan2` and `pow`, and one point about all of it.
 *
 * These two happen to agree between this Node and this Chrome — measured, same
 * 200,000-argument fingerprint. That is not a guarantee of anything: the spec
 * gives them the same freedom it gives sine, and the next Safari or the next V8
 * is free to use it. Since a recording is meant to be readable anywhere, and a
 * leaderboard would be worthless if two browsers disagreed about where a
 * Charger was, they get replaced too.
 *
 * **The requirement is not to match the platform.** It is that every engine
 * running *this code* agrees with every other. That is a much weaker ask than
 * correct rounding, and it is why these can be plain polynomials: the platform's
 * own results stop mattering the moment nothing calls them.
 */

/** fdlibm's atan reduction table: the four hi/lo pairs, and its minimax poly. */
const ATAN_HI = [
  4.6364760900080609352e-1, 7.8539816339744827900e-1, 9.8279372324732905408e-1,
  1.5707963267948965580e0,
];
const ATAN_LO = [
  2.2698777452961687092e-17, 3.0616169978683830179e-17, 1.3903311031230998452e-17,
  6.1232339957367660359e-17,
];
const AT0 = 3.33333333333329318027e-1;
const AT1 = -1.99999999998764832476e-1;
const AT2 = 1.42857142725034663711e-1;
const AT3 = -1.11111104054623557880e-1;
const AT4 = 9.09088713343650656196e-2;
const AT5 = -7.69187620504482999495e-2;
const AT6 = 6.66107313738753120669e-2;
const AT7 = -5.83357013379057348645e-2;
const AT8 = 4.97687799461593236017e-2;
const AT9 = -3.65315727442169155270e-2;
const AT10 = 1.62858201153657823623e-2;

const PI = 3.141592653589793;
const PI_LO = 1.2246467991473532e-16;

function atanKernel(x: number): number {
  const ax = x < 0 ? -x : x;
  let id: number;
  let t = ax;
  if (ax < 0.4375) {
    id = -1;
  } else if (ax < 1.1875) {
    if (ax < 0.6875) {
      id = 0;
      t = (2 * ax - 1) / (2 + ax);
    } else {
      id = 1;
      t = (ax - 1) / (ax + 1);
    }
  } else if (ax < 2.4375) {
    id = 2;
    t = (ax - 1.5) / (1 + 1.5 * ax);
  } else {
    id = 3;
    t = -1 / ax;
  }

  const z = t * t;
  const w = z * z;
  const s1 = z * (AT0 + w * (AT2 + w * (AT4 + w * (AT6 + w * (AT8 + w * AT10)))));
  const s2 = w * (AT1 + w * (AT3 + w * (AT5 + w * (AT7 + w * AT9))));
  if (id < 0) {
    const r = t - t * (s1 + s2);
    return x < 0 ? -r : r;
  }
  const r = ATAN_HI[id]! - (t * (s1 + s2) - ATAN_LO[id]! - t);
  return x < 0 ? -r : r;
}

/**
 * Angle of the vector (x, y). Exactly reproducible on every JS engine.
 *
 * Argument order matches `Math.atan2`: y first. The quadrant logic is the
 * ordinary one; only the kernel is ours.
 */
export function atan2(y: number, x: number): number {
  if (x === 0 && y === 0) return 0;
  if (x === 0) return y > 0 ? PI / 2 : -PI / 2;
  const a = atanKernel(y / x);
  if (x > 0) return a;
  // Second and third quadrants. PI is added in two pieces for the same reason
  // the range reduction subtracts it in two: the low word is not noise, it is
  // the part that keeps the result accurate when `a` nearly cancels it.
  return y >= 0 ? a + PI + PI_LO : a - PI - PI_LO;
}

/** Bit-exact 2^n for integer n, by building the exponent field directly. */
function ldexp(x: number, n: number): number {
  // Two steps for large |n| so the scale factor itself never denormalises.
  if (n > 1023) return ldexp(x * 8.98846567431158e307, n - 1023);
  if (n < -1022) return ldexp(x * 2.2250738585072014e-308, n + 1022);
  const view = new DataView(new ArrayBuffer(8));
  view.setUint32(0, (1023 + n) << 20);
  view.setUint32(4, 0);
  return x * view.getFloat64(0);
}

/** Split a positive finite double into mantissa in [1, 2) and exponent. */
function frexp2(x: number): { m: number; e: number } {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, x);
  const hi = view.getUint32(0);
  let e = ((hi >>> 20) & 0x7ff) - 1023;
  if (e === -1023) {
    // Subnormal: scale it into the normal range and take the exponent back off.
    const scaled = frexp2(x * 4503599627370496);
    return { m: scaled.m, e: scaled.e - 52 };
  }
  view.setUint32(0, (hi & 0x800fffff) | (1023 << 20));
  let m = view.getFloat64(0);
  // Centre the mantissa on 1 rather than on 1.5: the log series below converges
  // fastest near 1, and this halves the worst-case term count.
  if (m > 1.4142135623730951) {
    m *= 0.5;
    e += 1;
  }
  return { m, e };
}

const LOG2E = 1.4426950408889634;
const LN2 = 0.6931471805599453;

/** log2, portable. `atanh` series on (m-1)/(m+1), which converges on [√½, √2). */
function log2(x: number): number {
  const { m, e } = frexp2(x);
  const t = (m - 1) / (m + 1);
  const z = t * t;
  // Nine odd terms. On |t| ≤ 0.1716 the next one is below 1e-18 relative.
  const s =
    t *
    (2 +
      z *
        (2 / 3 +
          z *
            (2 / 5 +
              z * (2 / 7 + z * (2 / 9 + z * (2 / 11 + z * (2 / 13 + z * (2 / 15 + z * (2 / 17)))))))));
  return e + s * LOG2E;
}

/** 2^x, portable. Integer part by exponent surgery, fraction by series. */
function exp2(x: number): number {
  const n = Math.round(x);
  const f = (x - n) * LN2;
  // e^f on |f| ≤ ln2/2 ≈ 0.347. Sixteen terms: the twelfth alone is worth 1e-14
  // of relative error, which showed up immediately as pow(2, 0.5) missing √2 in
  // the fourteenth digit.
  let term = 1;
  let sum = 1;
  for (let i = 1; i <= 16; i++) {
    term = (term * f) / i;
    sum += term;
  }
  return ldexp(sum, n);
}

/**
 * `base ** exponent`, portable, for the cases this sim actually has: a positive
 * base, or an integer exponent.
 *
 * Integer exponents go through repeated squaring, which is *exact* — no series,
 * no rounding beyond the multiplications themselves. Everything else is
 * `2^(e·log2 b)`. Negative bases with fractional exponents are not defined here
 * because nothing in the game asks for one; they return NaN, like the real
 * thing.
 */
export function pow(base: number, exponent: number): number {
  if (exponent === 0) return 1;
  if (base === 0) return exponent > 0 ? 0 : Infinity;
  if (Number.isInteger(exponent) && Math.abs(exponent) <= 1024) {
    let n = Math.abs(exponent);
    let acc = 1;
    let b = base;
    while (n > 0) {
      if (n & 1) acc *= b;
      b *= b;
      n >>= 1;
    }
    return exponent < 0 ? 1 / acc : acc;
  }
  if (base < 0) return NaN;
  return exp2(exponent * log2(base));
}

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
