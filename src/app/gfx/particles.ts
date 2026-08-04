/**
 * Presentation-only particles: decomposition deaths (§17.1) and the player's
 * dash afterimage (§16.4).
 *
 * Renderer-side on purpose. These never feed back into the simulation, so they
 * use their own RNG and their own clock — a replay reproduces the run, not the
 * exact scatter of one enemy's debris.
 */
import type { Graphics } from 'pixi.js';
import { VISUAL } from '../visual';

interface Segment {
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Endpoint offsets, so a segment keeps the orientation it had in the shape. */
  dx: number;
  dy: number;
  spin: number;
  angle: number;
  life: number;
  maxLife: number;
  color: number;
}

interface Afterimage {
  x: number;
  y: number;
  angle: number;
  life: number;
  maxLife: number;
}

/** Vertices of the shape grammar (§10.1) — shape is behaviour, so it must survive death. */
function shapeVertices(shape: string, radius: number, rotation = 0): [number, number][] {
  const sides =
    shape === 'triangle' ? 3 : shape === 'square' ? 4 : shape === 'hexagon' ? 6 : shape === 'dot' ? 4 : 10;
  const points: [number, number][] = [];
  for (let i = 0; i < sides; i++) {
    const a = rotation + (i / sides) * Math.PI * 2;
    points.push([Math.cos(a) * radius, Math.sin(a) * radius]);
  }
  return points;
}

export class ParticleField {
  private readonly segments: Segment[] = [];
  private readonly afterimages: Afterimage[] = [];
  private seed = 0x9e3779b9;

  /** Cheap deterministic-enough noise; cosmetic only. */
  private rand(): number {
    this.seed = (Math.imul(this.seed, 1664525) + 1013904223) >>> 0;
    return this.seed / 4294967296;
  }

  /**
   * §17.1 — "decompose into constituent line segments, inheriting velocity +
   * outward impulse, fading over 300ms". The shape comes apart into the strokes
   * it was drawn with, so you can still read what died.
   */
  decompose(x: number, y: number, radius: number, shape: string, color: number, budget: number): void {
    if (this.segments.length > budget) return;
    const verts = shapeVertices(shape, radius, this.rand() * Math.PI * 2);
    for (let i = 0; i < verts.length; i++) {
      const [ax, ay] = verts[i]!;
      const [bx, by] = verts[(i + 1) % verts.length]!;
      const midX = (ax + bx) / 2;
      const midY = (ay + by) / 2;
      const len = Math.hypot(midX, midY) || 1;
      const speed = VISUAL.decomposeSpeed * (0.55 + this.rand() * 0.8);
      this.segments.push({
        x: x + midX,
        y: y + midY,
        vx: (midX / len) * speed,
        vy: (midY / len) * speed,
        dx: (bx - ax) / 2,
        dy: (by - ay) / 2,
        spin: (this.rand() - 0.5) * 5,
        angle: 0,
        life: VISUAL.decomposeTime * (0.7 + this.rand() * 0.6),
        maxLife: VISUAL.decomposeTime,
        color,
      });
    }
  }

  /** §16.4 — the dash leaves a short white afterimage. */
  pushAfterimage(x: number, y: number, angle: number): void {
    if (this.afterimages.length >= VISUAL.afterimageCount * 4) return;
    this.afterimages.push({ x, y, angle, life: VISUAL.afterimageTime, maxLife: VISUAL.afterimageTime });
  }

  update(dt: number): void {
    for (let i = this.segments.length - 1; i >= 0; i--) {
      const s = this.segments[i]!;
      s.life -= dt;
      if (s.life <= 0) {
        this.segments.splice(i, 1);
        continue;
      }
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      s.vx *= 1 - 2.2 * dt;
      s.vy *= 1 - 2.2 * dt;
      s.angle += s.spin * dt;
    }
    for (let i = this.afterimages.length - 1; i >= 0; i--) {
      const a = this.afterimages[i]!;
      a.life -= dt;
      if (a.life <= 0) this.afterimages.splice(i, 1);
    }
  }

  /**
   * Batched by (colour × fade bucket). One stroke() per segment is one draw call
   * per segment, and a cascade produces hundreds at once. Quantising the fade
   * into a few buckets is invisible in motion and turns that into a handful.
   */
  draw(g: Graphics, isVisible: (x: number, y: number, margin: number) => boolean): void {
    if (this.segments.length === 0) return;
    const buckets = 4;
    const colors = new Set<number>();
    for (const s of this.segments) colors.add(s.color);

    for (const color of colors) {
      for (let b = buckets; b >= 1; b--) {
        const hi = b / buckets;
        const lo = (b - 1) / buckets;
        let any = false;
        for (const s of this.segments) {
          if (s.color !== color) continue;
          const t = Math.max(0, s.life / s.maxLife);
          if (t > hi || t <= lo) continue;
          if (!isVisible(s.x, s.y, 40)) continue;
          const cos = Math.cos(s.angle);
          const sin = Math.sin(s.angle);
          const dx = s.dx * cos - s.dy * sin;
          const dy = s.dx * sin + s.dy * cos;
          g.moveTo(s.x - dx, s.y - dy).lineTo(s.x + dx, s.y + dy);
          any = true;
        }
        if (any) g.stroke({ width: 1.5, color, alpha: hi * 0.9 });
      }
    }
  }

  drawAfterimages(g: Graphics, radius: number, drawShape: (g: Graphics, x: number, y: number, r: number, angle: number) => void): void {
    for (const a of this.afterimages) {
      const t = Math.max(0, a.life / a.maxLife);
      drawShape(g, a.x, a.y, radius, a.angle);
      g.stroke({ width: 2, color: 0xffffff, alpha: t * 0.35 });
    }
  }

  get count(): number {
    return this.segments.length;
  }

  clear(): void {
    this.segments.length = 0;
    this.afterimages.length = 0;
  }
}
