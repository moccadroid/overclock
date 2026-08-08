/**
 * The instrumentation, as lines on the character grid.
 *
 * This is the HUD's content with its rendering taken away. It was HTML in six
 * absolutely-positioned corners, which meant three things that all had to go:
 * it could never take the player's phosphor, it had its own opinions about
 * colour in a stylesheet a long way from `tokens.ts`, and it read as text lying
 * on the game rather than as a machine the game is inside.
 *
 * Every function here returns `Line[]` — the same thing every document in the
 * game is made of — so the bezel renders them through the same `Grid` a sheet
 * uses, in the same palette, through the same tube.
 *
 * ---
 *
 * **Nothing here computes anything.** The numbers all exist on the world already;
 * this decides what is worth printing and in which ink. Keeping the two apart is
 * what stopped the old HUD's `update()` from being six hundred characters of
 * string concatenation with three colour decisions buried in each one.
 */
import type { World } from '../../sim/world';
import { TUNABLE } from '../../sim/tunables';
import { C, field, meter, type Line, type Seg } from '../ui';

/** m:ss, the run's own clock. */
function runClock(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** A proportion as a meter, with its own ink. */
function gauge(value: number, max: number, width: number, colour: number): Seg[] {
  return meter(max > 0 ? (value / max) * width : 0, width, colour);
}

/**
 * Left: the operator's own condition.
 *
 * Integrity first and brightest — §16.2's hierarchy says the thing that ends the
 * run outranks everything on the screen.
 */
export function operatorLines(world: World): Line[] {
  const p = world.player;
  const hurt = p.integrity <= p.maxIntegrity * 0.35;
  return [
    [
      ['INTEGRITY  ', C.faint],
      ...gauge(p.integrity, p.maxIntegrity, 16, hurt ? C.signal : C.trigger),
      [`  ${Math.ceil(p.integrity)}`, hurt ? C.signal : C.bright],
    ],
    [
      [`LEVEL ${world.level}    `, C.faint],
      ...gauge(world.xp, world.xpToNext, 16, C.voltaic),
      [`  ${Math.floor(world.xp)}/${world.xpToNext}`, C.dim],
    ],
    [
      ['DASH       ', C.faint],
      [
        p.dashCooldown > 0 ? `${p.dashCooldown.toFixed(1)}s` : 'READY',
        p.dashCooldown > 0 ? C.dim : C.trigger,
      ],
    ],
  ];
}

/**
 * Centre: the clock, the room's threat, and Heat with its cause beside it.
 *
 * §6.2 — Heat's cause is printed next to Heat, because the whole point of moving
 * Heat onto cascade depth was that depth is a thing you can see on the screen.
 */
export function pressureLines(world: World): Line[] {
  const heat = world.budget.heat;
  const tier = world.budget.tier;
  const tierName = ['NOMINAL', 'INSTABILITY I', 'INSTABILITY II', 'OVERHEAT'][tier]!;
  const tierInk = tier >= 2 ? C.signal : tier >= 1 ? C.thermal : C.trigger;

  // §12.1 — Threat as a step, and what this room can express of it. The second
  // half only appears in a capped room, and it is the whole of the "you are
  // behind" signal: the distance is what is waiting past the gate.
  const behind = world.threatStep - world.roomThreatStep;
  const top: Line = [
    [runClock(world.time), C.bright],
    ['   ', C.ink],
  ];
  if (world.phase === 'meltdown') {
    top.push(
      [`MELTDOWN ×${world.meltdownMultiplier.toFixed(2)}`, C.signal],
      [`  +${runClock(world.meltdownTime)}`, C.signal],
    );
  } else {
    top.push([`THREAT ${world.threatStep}`, C.ink]);
    if (behind > 0) top.push([`   ROOM ${world.roomThreatStep}`, behind >= 3 ? C.signal : C.dim]);
  }

  const rate = world.budget.heatRate;
  let flow: Seg;
  if (world.budget.stalled) flow = [`STALLED ${world.budget.stall.toFixed(1)}s`, C.signal];
  else if (rate > 0.05) flow = [`▲ +${rate.toFixed(0)}/s`, C.signal];
  else if (rate < -0.05) flow = [`▼ ${rate.toFixed(0)}/s venting`, C.trigger];
  else flow = ['stable', C.dim];

  const depth = world.depthAverage;
  const free = TUNABLE.heatFreeDepth;
  const chainRead: Seg =
    depth < 0.5
      ? ['chain 0', C.dim]
      : [
          `chain ${depth.toFixed(1)}${depth > free ? ` · ${(depth - free).toFixed(1)} over` : ' · free'}`,
          depth > free ? C.thermal : C.trigger,
        ];

  const lines: Line[] = [
    top,
    [
      ['HEAT ', C.faint],
      ...gauge(heat, 100, 14, tierInk),
      ['  ', C.ink],
      [tierName, tierInk],
      ['   ', C.ink],
      flow,
      ['   ', C.ink],
      chainRead,
    ],
  ];
  if (world.surgeTime > 0) {
    lines.push([[`REBUILD SURGE ${world.surgeTime.toFixed(0)}s · 2× XP`, C.voltaic]]);
  }
  return lines;
}

/**
 * Right: output, and what the engine is costing.
 *
 * **The program list is not here, and that is a trade.** It was four rows of
 * chains, which is more than a frame two lines deep can hold — it escaped the
 * band and floated in the play area, which is exactly what the bezel exists to
 * stop. The old DOM HUD carried it for a real reason ("a build you cannot see is
 * a build you cannot reason about"), and the answer is that the build now has a
 * home one keypress away: TAB opens the editor, where the same chains are drawn
 * larger and can be edited.
 *
 * If it has to come back, it needs a *column* rather than a band — a frame that is
 * wide on the right as well as the top — which costs horizontal field of view. It
 * is a design call, not an oversight.
 */
export function engineLines(world: World): Line[] {
  return [
    [
      ['EPS ', C.faint],
      [world.eps.toFixed(1), C.bright],
      ['    SCORE ', C.faint],
      [String(Math.floor(world.score)), C.ink],
      ...(world.kernels > 0
        ? ([['   KERNEL ×', C.faint], [world.engine.kernel.toFixed(2), C.ink]] as Seg[])
        : []),
    ],
    [
      ['CYCLES ', C.faint],
      [`${world.engine.staticLoad.toFixed(1)}/${world.budget.capacity}`, C.ink],
      ['  ', C.ink],
      ...gauge(world.engine.staticLoad, world.budget.capacity, 10, C.voltaic),
    ],
  ];
}

/** Bottom left: what the machine is doing, for anyone who goes looking. */
export function diagnosticLines(world: World, fps: string): Line[] {
  return [
    [
      [fps, C.rule],
      [
        `   enemies ${world.enemies.length}  proj ${world.projectiles.length}` +
          `  zones ${world.zones.length}  depth ${world.stats.maxDepth}` +
          `  scrap +${(world.engine.scrapStacks * 4).toFixed(0)}%`,
        C.rule,
      ],
    ],
  ];
}

/**
 * The one line that interrupts: suppression, a pending draft, or a flash.
 *
 * Suppression outranks everything — triggers being offline is the only state in
 * the game where the player's inputs stop meaning what they mean.
 */
export function alertLine(world: World, notice: string): Line {
  if (world.suppressedNow) return [['SUPPRESSED — TRIGGERS OFFLINE', C.signal]];
  if (notice) return [[notice, C.thermal]];
  const queued = world.pendingDrafts;
  if (queued > 0) {
    return [
      ['^'.repeat(queued), C.voltaic],
      [`  ${queued} DRAFT PENDING — E`, C.voltaic],
    ];
  }
  return [];
}

export { field };
