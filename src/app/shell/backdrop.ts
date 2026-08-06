/**
 * The shell — the backdrop. NARRATIVE §5.1.
 *
 * Large boxes drifting past in the dark. Some bigger, some smaller, some faster,
 * some slower, overlapping, on a near-black field.
 *
 * ---
 *
 * **A box here is one rectangle.** Not a block field.
 *
 * The first attempt drove this with `StructurePass`, and that pass exists to do
 * the opposite of what is wanted here: it takes a rectangle and *shreds* it into
 * a mosaic of small cells at three scales. Every box came out as a ragged
 * cluster, and one large wall came out as a tiled slab covering half the screen.
 * It is the right tool for a wall you walk into and the wrong one for a shape
 * sliding past behind a menu.
 *
 * What the shell contributes here is its **value ladder and its lighting model**,
 * not its geometry:
 *
 *   - black ground, and each tier only just lighter than the one behind it
 *   - no rim light and no shadow: both need a surface, and there is none out
 *     here. A lit edge on a shape drifting through a void is a bevel, and a
 *     bevel stops a black rectangle reading as a hole.
 *
 * Because nothing is a block field, every box carries its own velocity and the
 * camera does not exist. Depth is speed and value, which is all it ever was.
 */
import { Container, Graphics } from 'pixi.js';

/** One drifting slab. */
interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
  vx: number;
  tier: number;
  /** How far its shadow falls, px. */
  drop: number;
  /** This box's own value, so a neighbour it overlaps is never the same. */
  level: number;
}

interface Mote {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  a: number;
  colour: number;
}

/**
 * Three depths. Far is big, slow and dark; near is small, quick and lighter.
 *
 * Neutral greys, deliberately — the shell's mass is neutral against a blue floor
 * and there is no floor here, so any blue in these reads as a colour choice
 * rather than as unlit material.
 */
const TIERS = [
  // Size bands, as fractions of the viewport. **Nothing reaches 1.0 on either
  // axis** — a panel that covers the frame turns the menu into a flat wall for
  // as long as it takes to cross, and there is no depth in a wall. The largest
  // still leaves a fifth of the width and a sixth of the height showing.
  //
  // Value runs opposite to size: the closest panels are the darkest, because
  // something that large passing between you and whatever light is out here is
  // a silhouette. The top-left highlight is what keeps them legible.
  { lo: 3, hi: 5, w: [0.14, 0.28], h: [0.2, 0.46] },
  { lo: 2, hi: 4, w: [0.24, 0.46], h: [0.3, 0.62] },
  { lo: 1, hi: 3, w: [0.4, 0.62], h: [0.46, 0.76] },
  { lo: 1, hi: 2, w: [0.55, 0.8], h: [0.6, 0.85] },
];

/** Few, and large. A field of small tiles is not a structure. */
const POPULATION = [3, 3, 2, 1];

/** Level to colour. A touch more blue than red keeps it in the game's family. */
function shade(level: number): number {
  return (level << 16) | (level << 8) | (level + 2);
}

function rand(a: number, b: number): number {
  return a + Math.random() * (b - a);
}

export class Backdrop {
  readonly root = new Container();

  private readonly layers = TIERS.map(() => new Graphics());
  private readonly gMotes = new Graphics();
  private readonly boxes: Box[][] = TIERS.map(() => []);
  private readonly motes: Mote[] = [];

  private w = 1;
  private h = 1;
  private moteTimer = 0.4;

  init(): void {
    // Back to front, with the motes buried between the layers so the nearer
    // boxes pass in front of them.
    this.root.addChild(this.layers[0]!, this.layers[1]!, this.gMotes);
    for (let i = 2; i < this.layers.length; i++) this.root.addChild(this.layers[i]!);
  }

  resize(w: number, h: number): void {
    this.w = w;
    this.h = h;
    // Seed a full screen so the first frame is not an empty field filling up.
    for (let t = 0; t < TIERS.length; t++) {
      while (this.boxes[t]!.length < POPULATION[t]!) this.boxes[t]!.push(this.spawn(t, true));
    }
  }

  private spawn(tier: number, seeded: boolean): Box {
    const cfg = TIERS[tier]!;
    const frac = rand(cfg.w[0]!, cfg.w[1]!);
    const w = frac * this.w;
    const h = rand(cfg.h[0]!, cfg.h[1]!) * this.h;
    // **Speed comes from the panel's own size, not from its tier.** How large a
    // thing looks is how close it is, and how close it is is how fast it
    // crosses — so tying the two together means every panel has its own rate by
    // construction, and no two ever travel in lockstep. Tier-wide speeds put
    // three panels on the same rail and read as bands sliding past.
    const speed = (4 + 92 * frac ** 1.4) * rand(0.86, 1.16);
    return {
      w,
      h,
      // Seeded boxes start anywhere on screen; later ones walk in from the right.
      x: seeded ? rand(-w, this.w) : this.w + rand(60, 900),
      // Free to hang off the top and bottom — a box cropped by the frame reads
      // as bigger than the frame, which is the whole point of "large".
      y: rand(-h * 0.6, this.h - h * 0.4),
      vx: -speed,
      tier,
      level: Math.round(rand(cfg.lo, cfg.hi)),
      // Nearer things sit further from what is behind them, so they throw the
      // longer shadow. Same source as the speed: the panel's own scale.
      drop: Math.round(2 + 13 * frac),
    };
  }

  update(dt: number, w: number, h: number): void {
    if (w !== this.w || h !== this.h) this.resize(w, h);

    for (let t = 0; t < TIERS.length; t++) {
      const g = this.layers[t]!;
      const list = this.boxes[t]!;
      g.clear();

      for (let i = list.length - 1; i >= 0; i--) {
        const b = list[i]!;
        b.x += b.vx * dt;
        if (b.x + b.w < -b.drop - 40) {
          list.splice(i, 1);
          continue;
        }
        const x = Math.round(b.x);
        const y = Math.round(b.y);

        // Light fixed up-left. Two things follow from that and they are not the
        // same thing, which is what the last two passes kept confusing:
        //
        //   the **highlight** is on the box — a hairline along its top and left
        //   the **shadow** is off the box — cast down-right onto whatever is behind
        //
        // A dark line on the box's own bottom edge is neither; it is a bevel.
        // The shadow is drawn first as a whole offset copy and then covered by
        // the box, so what survives is a clean L with no seam at the corner. It
        // is the background colour, so over open void it vanishes and only
        // appears where there is something behind to catch it.
        g.rect(x + Math.round(b.drop * 0.7), y + b.drop, b.w, b.h).fill(0x000000);
        g.rect(x, y, b.w, b.h).fill(shade(b.level));
        g.rect(x, y, b.w, 1).fill(shade(b.level + 5));
        g.rect(x, y, 1, b.h).fill(shade(b.level + 5));
      }

      while (list.length < POPULATION[t]!) list.push(this.spawn(t, false));
    }

    this.drawMotes(dt);
  }

  /** Rare on purpose. A parade of specks is a screensaver. */
  private drawMotes(dt: number): void {
    this.moteTimer -= dt;
    if (this.moteTimer <= 0) {
      this.moteTimer = rand(0.7, 2.6);
      this.motes.push({
        x: this.w + 20,
        y: rand(0, this.h),
        vx: -rand(16, 44),
        vy: rand(-6, 6),
        r: rand(0.9, 2),
        a: rand(0.14, 0.34),
        colour: Math.random() < 0.2 ? 0xffb000 : 0x9fd0ff,
      });
    }

    this.gMotes.clear();
    for (let i = this.motes.length - 1; i >= 0; i--) {
      const m = this.motes[i]!;
      m.x += m.vx * dt;
      m.y += m.vy * dt;
      if (m.x < -20) {
        this.motes.splice(i, 1);
        continue;
      }
      this.gMotes.circle(m.x, m.y, m.r).fill({ color: m.colour, alpha: m.a });
    }
  }
}
