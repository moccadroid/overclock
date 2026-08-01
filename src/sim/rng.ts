/**
 * Deterministic PRNG (sfc32). Serializable state so a run can be replayed
 * bit-exactly from a seed — GDD §0 ("deterministic runtime"), §25.5 (replays).
 *
 * HARD RULE: no `Math.random()` and no wall-clock reads anywhere under src/sim.
 * Every stochastic decision in the simulation draws from an Rng instance.
 */
export type RngState = readonly [number, number, number, number];

export class Rng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;

  constructor(seed: string | number | RngState) {
    if (Array.isArray(seed)) {
      [this.a, this.b, this.c, this.d] = seed as unknown as [number, number, number, number];
      return;
    }
    // Expand a scalar/string seed into 128 bits via a simple mix.
    const str = String(seed);
    let h = 2166136261 >>> 0;
    const mix = (): number => {
      for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 16777619) >>> 0;
      }
      h ^= h >>> 15;
      h = Math.imul(h, 2246822507) >>> 0;
      h ^= h >>> 13;
      return h >>> 0;
    };
    this.a = mix();
    this.b = mix();
    this.c = mix();
    this.d = mix();
    // Discard early correlated output.
    for (let i = 0; i < 12; i++) this.next();
  }

  /** Uniform float in [0, 1). */
  next(): number {
    const t = (this.a + this.b) | 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) | 0;
    this.c = (this.c << 21) | (this.c >>> 11);
    this.d = (this.d + 1) | 0;
    const t2 = (t + this.d) | 0;
    this.c = (this.c + t2) | 0;
    return (t2 >>> 0) / 4294967296;
  }

  /** Integer in [0, n). */
  int(n: number): number {
    return Math.floor(this.next() * n);
  }

  /** Float in [min, max). */
  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** True with probability p. */
  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('Rng.pick on empty array');
    return items[this.int(items.length)]!;
  }

  /** Weighted pick. `weights` must align with `items` and sum > 0. */
  pickWeighted<T>(items: readonly T[], weights: readonly number[]): T {
    let total = 0;
    for (const w of weights) total += w;
    let roll = this.next() * total;
    for (let i = 0; i < items.length; i++) {
      roll -= weights[i] ?? 0;
      if (roll <= 0) return items[i]!;
    }
    return items[items.length - 1]!;
  }

  /** In-place deterministic Fisher-Yates. */
  shuffle<T>(items: T[]): T[] {
    for (let i = items.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      const tmp = items[i]!;
      items[i] = items[j]!;
      items[j] = tmp;
    }
    return items;
  }

  save(): RngState {
    return [this.a, this.b, this.c, this.d];
  }

  static restore(state: RngState): Rng {
    return new Rng(state);
  }
}
