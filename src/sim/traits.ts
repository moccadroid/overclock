/**
 * §10.2 — what an enemy *does*, as data.
 *
 * The wave refactor split "a called wave" into a pool, a transform chain and a
 * schedule, because those three vary independently and fusing them meant every
 * combination was a new hardcoded loop. Behaviour had the same disease in a
 * worse form.
 *
 * `EnemyDef` had grown one optional field per behaviour — `windup`, `dashSpeed`,
 * `dashDuration`, `shieldArc`, `growthPerMeal`, `zoneRadius`, `standoff`,
 * `beamDamage` — each meaningless for every other enemy, and dispatch mixed
 * `def.behavior === 'lance'` with `if (def.windup !== undefined)`, so the
 * Charger was selected by the *presence of a field* rather than by declaring
 * itself. Worse, each branch `continue`d: an enemy could be `suppress` or
 * `lance`, never both, and never either plus something new.
 *
 * A trait is one named, parameterised thing an enemy does. An enemy is an
 * ordered list of them. Adding a behaviour is a vocabulary entry, a runner and a
 * JSON row — the same cost as adding a POI, which is the one system in here that
 * already got this right.
 *
 * ---
 *
 * **Ordering is semantic and load-bearing.** Traits run in the order listed, and
 * the first one that returns `handled` stops the rest *and* the shared tail
 * (movement integration, contact, despawn). That is not an implementation
 * detail, it is how the old code behaved: Interceptor, Suppressor and Lancer
 * each `continue`d past everything, while the Charger's windup ran *before* the
 * seek block and deliberately fell through to it.
 *
 * So `charger` is `[dash, seek]` and reads in the order it happens: decide
 * whether to commit, then steer if you did not. Any reordering is a real change
 * and the pinned hashes in world.test.ts will say so.
 */

import { clamp, hypot, atan2 as patan2, cos as pcos, sin as psin } from './num';
import { TUNABLE } from './tunables';
import type { DamageSource, Enemy, Fx, Projectile } from './world';
import type { AudioCueKind, EnemyDef, Hue } from './types';

/** One thing an enemy does, with its own parameters. */
export interface TraitSpec {
  /** Trait name, resolved against the runner table in world.ts. */
  t: string;
  /** Everything else is the trait's own; nothing outside it may read these. */
  [param: string]: number | string | boolean | undefined;
}

/**
 * §10.2 — the shim, while `EnemyDef` still carries the old per-behaviour fields.
 *
 * Stage 1 of the refactor changes the *structure* without touching a single
 * number, so behaviour is derived from the existing fields rather than authored
 * in JSON. Once the data files carry `traits` directly this collapses into a
 * read, and the optional fields come off `EnemyDef` with it.
 *
 * The derivation is deliberately literal — it reproduces the old dispatch
 * exactly, including the duck-typed `windup !== undefined` test, because a
 * cleverer mapping here would be an unprovable behaviour change wearing a
 * refactor's clothes.
 */
export function deriveTraits(def: {
  behavior: string;
  windup?: number;
  dashSpeed?: number;
  dashDuration?: number;
  phaseInterval?: number;
  phaseDuration?: number;
}): TraitSpec[] {
  // A def's own phase comes first so it outranks an affix's, which is what
  // `def.phaseInterval ?? (affix ? … : 0)` used to say — a Ghost that also rolls
  // Phasing keeps the Ghost's timing.
  //
  // `zone` and `deathBlast` are deliberately *not* derived from the def here,
  // and the asymmetry is not an oversight. Their old code paths were separate
  // `if`s that could both fire, so a Charged variant wearing Volatile detonated
  // twice; deriving them would silently merge that into one. The def's versions
  // are still read directly at their use sites. Unifying them is a balance
  // change and belongs in a commit that says so.
  const passive: TraitSpec[] = [];
  if (def.phaseInterval !== undefined) {
    passive.push({ t: 'phase', interval: def.phaseInterval, hold: def.phaseDuration ?? 1 });
  }
  // The three that owned the whole tick. Exclusive, and nothing composes with
  // them yet — that is a property of the old code, not of traits, and the first
  // enemy that wants `lance` plus `dash` now only needs a JSON edit.
  if (def.behavior === 'intercept') return [...passive, { t: 'intercept' }];
  if (def.behavior === 'suppress') return [...passive, { t: 'suppress' }];
  if (def.behavior === 'lance') return [...passive, { t: 'lance' }];

  const traits: TraitSpec[] = [...passive];
  // The Charger, identified the way the old code identified it. Its numbers
  // travel with it now instead of living as `?? 500` and `?? 0.4` at the use
  // site, which is the first time they have been tunable per enemy.
  if (def.windup !== undefined) {
    traits.push({
      t: 'dash',
      windup: def.windup,
      speed: def.dashSpeed ?? 500,
      duration: def.dashDuration ?? 0.4,
      range: 320,
      cooldown: 1.2,
    });
  }
  traits.push({ t: 'seek' });
  return traits;
}

/** Memoised per enemy id — the derivation is pure and runs on every tick. */
const cache = new Map<string, readonly TraitSpec[]>();

export function traitsOf(
  id: string,
  def: {
    behavior: string;
    windup?: number;
    dashSpeed?: number;
    dashDuration?: number;
    phaseInterval?: number;
    phaseDuration?: number;
  },
): readonly TraitSpec[] {
  let found = cache.get(id);
  if (!found) {
    found = deriveTraits(def);
    cache.set(id, found);
  }
  return found;
}

/** Read a trait parameter that must be present. */
export function num(spec: TraitSpec, key: string, fallback: number): number {
  const v = spec[key];
  return typeof v === 'number' ? v : fallback;
}

/**
 * §10.2 — everything a trait is allowed to touch.
 *
 * The point of writing this down is the *bound*, not the convenience. Before
 * this the behaviours were private methods on a four-thousand-line class and
 * could reach anything on it; the reason nobody could add a behaviour safely was
 * not that the dispatch was an if-chain, it was that there was no answer to
 * "what is a behaviour allowed to do".
 *
 * Now there is one, it is ten members long, and it is the whole contract. A
 * trait that needs something not on here is a trait asking for a new capability,
 * which is a conversation rather than a reach into `this`.
 *
 * One object is built per world and mutated per enemy per tick — behaviours run
 * for every enemy every frame and allocating a context each time would be a
 * garbage-collection pause dressed as an abstraction.
 */
export interface TraitCtx {
  dt: number;
  time: number;
  enemy: Enemy;
  def: EnemyDef;
  spec: TraitSpec;
  readonly player: { x: number; y: number };
  readonly arena: { width: number; height: number };
  readonly projectiles: readonly Projectile[];
  /** Push a body out of any ruin it is inside. True if it hit one. */
  collide(body: { x: number; y: number }, radius: number): boolean;
  /** Navigation field, for steering around ruins rather than into them. */
  sampleFlow(x: number, y: number, out: { x: number; y: number }): void;
  flowCellSize: number;
  /** Other enemies within a radius, for separation. */
  neighbours(x: number, y: number, radius: number, fn: (other: Enemy) => void): void;
  fx(kind: Fx['kind'], hue: Hue, x: number, y: number, radius: number, life: number): void;
  cue(kind: AudioCueKind, hue: Hue, depth: number, weight: number): void;
  /** §23.1 — an Interceptor swallowed something. */
  feed(e: Enemy, share: number): void;
  /** Draw the Lancer's beam. Geometry the sim owns, picture the renderer reads. */
  beam(e: Enemy, ux: number, uy: number): void;
  /** Contact damage, Leech heat, and everything else touching costs. */
  touch(e: Enemy, def: EnemyDef): void;
  /** Damage the player from something that is not contact. */
  hurt(amount: number, cause: DamageSource): void;
  /**
   * §23.1 — how many Lancers are mid-telegraph, recounted each tick.
   *
   * Shared mutable state between enemies, which is exactly why it is on the
   * contract rather than in a trait's own closure: Lancers arriving in numbers
   * turned a dodgeable telegraph into an unavoidable crossfire, and the cap only
   * works if every Lancer can see the same count.
   */
  lancers: { charging: number };
}

/**
 * A trait implementation.
 *
 * Returning `true` means it owned the tick: the remaining traits and the shared
 * movement/contact/despawn tail are skipped. Returning nothing means "carry on",
 * which is what lets `dash` hand over to `seek`.
 */
export type TraitRunner = (c: TraitCtx) => boolean | undefined;

export const TRAIT_RUNNERS: Record<string, TraitRunner> = {
  /**
   * Passive traits: read by other systems rather than ticked.
   *
   * `zone` is sampled by the suppression pass, `phase` by the untargetable
   * check, `deathBlast` by killEnemy. They are listed here so that "every trait
   * in the data has an implementation" stays a checkable claim — a passive trait
   * missing from this table is a typo nobody would otherwise catch.
   */
  zone: () => {},
  phase: () => {},
  deathBlast: () => {},

  /**
   * §10.2 — walk at the player, around ruins, without forming a queue.
   *
   * Arms the shared steering block rather than steering itself, because the
   * block also serves the tail. An enemy whose list omits `seek` does not steer,
   * which is what a future "rooted" or "stunned" trait is with no new branch.
   */
  seek: (c) => {
    c.enemy.steers = true;
  },

  /** §10.2, §17.1 Charger — seek, telegraphed windup, committed dash. */
  dash: (c) => {
    const { enemy: e, spec, dt, player: p } = c;
    e.timer -= dt;
    if (e.state === 'seek') {
      const d = hypot(p.x - e.x, p.y - e.y);
      if (d < num(spec, 'range', 320) && e.timer <= 0) {
        e.state = 'windup';
        e.timer = num(spec, 'windup', 0.5);
        const len = d || 1;
        e.aimX = (p.x - e.x) / len;
        e.aimY = (p.y - e.y) / len;
      }
    } else if (e.state === 'windup') {
      e.vx = 0;
      e.vy = 0;
      // Re-aim at the moment of commitment so the drawn telegraph is honest.
      if (e.timer <= 0) {
        e.state = 'dash';
        e.timer = num(spec, 'duration', 0.4);
        e.vx = e.aimX * num(spec, 'speed', 500);
        e.vy = e.aimY * num(spec, 'speed', 500);
      }
    } else if (e.state === 'dash' && e.timer <= 0) {
      e.state = 'seek';
      e.timer = num(spec, 'cooldown', 1.2);
    }
  },

  /**
   * §10.2, §23.1 Interceptor — chases projectiles rather than the player, and
   * grows on what it swallows. The answer to spraying projectiles.
   */
  intercept: (c) => {
    const { enemy: e, def, dt, spec } = c;
    let target: Projectile | null = null;
    const sight = num(spec, 'sight', 700);
    let bestD2 = sight * sight;
    for (const proj of c.projectiles) {
      if (!proj.alive) continue;
      const dx = proj.x - e.x;
      const dy = proj.y - e.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestD2) {
        bestD2 = d2;
        target = proj;
      }
    }

    const goalX = target ? target.x : c.player.x;
    const goalY = target ? target.y : c.player.y;
    const dx = goalX - e.x;
    const dy = goalY - e.y;
    const len = hypot(dx, dy) || 1;
    e.facing = patan2(dy, dx);
    e.vx = (dx / len) * def.speed;
    e.vy = (dy / len) * def.speed;
    e.x += e.vx * dt;
    e.y += e.vy * dt;
    c.collide(e, e.radius);

    // The arena is the arena. A compounding radius used to walk its own centre
    // to the edge and hang most of its body outside the map, which reads as a
    // rendering fault rather than as a threat.
    e.x = clamp(e.x, e.radius, c.arena.width - e.radius);
    e.y = clamp(e.y, e.radius, c.arena.height - e.radius);

    const gorged = e.meals >= TUNABLE.interceptorMaxMeals;
    const eat = e.radius + num(spec, 'reach', 10);
    if (target && !gorged && bestD2 < eat * eat) {
      target.alive = false;
      c.feed(e, 1);
    }

    const pd = hypot(c.player.x - e.x, c.player.y - e.y);
    if (pd < e.radius + TUNABLE.playerRadius) c.touch(e, def);
    return true;
  },

  /**
   * §10.2 Suppressor — never attacks; projects a zone where your Triggers do not
   * fire. Fragile on purpose: the answer is to kill it or leave.
   */
  /**
   * §10.2, §17.1 Lancer — keeps its distance and fires a telegraphed beam. The
   * beam draws as a guide line first, then flashes to full width.
   */
  lance: (c) => {
    const { enemy: e, def, dt, spec } = c;
    const dx = c.player.x - e.x;
    const dy = c.player.y - e.y;
    const d = hypot(dx, dy) || 1;
    const standoff = def.standoff ?? 500;

    if (e.beamActive > 0) {
      e.beamActive -= dt;
      e.vx = 0;
      e.vy = 0;
    } else {
      const push = d > standoff * 1.15 ? 1 : d < standoff * 0.85 ? -1 : 0;
      e.vx = (dx / d) * def.speed * push;
      e.vy = (dy / d) * def.speed * push;
      e.x += e.vx * dt;
      e.y += e.vy * dt;
      c.collide(e, e.radius);

      // §23.1 — only so many may be charging at once. The rest simply hold
      // their shot rather than being removed from the fight.
      if (e.beamTimer <= 0 && c.lancers.charging < TUNABLE.maxChargingLancers) {
        e.beamTimer = (def.windup ?? 0.9) + num(spec, 'cooldown', 2.4);
        e.beamActive = def.windup ?? 0.9;
        e.facing = patan2(dy, dx);
        c.lancers.charging++;
      }
    }

    // Fires at the end of the telegraph, along the aim drawn at the start.
    if (e.beamActive > 0 && e.beamActive - dt <= 0) {
      const ux = pcos(e.facing);
      const uy = psin(e.facing);
      const px = c.player.x - e.x;
      const py = c.player.y - e.y;
      const along = px * ux + py * uy;
      const across = Math.abs(px * -uy + py * ux);
      // §17.1 — a finite beam. It used to run the length of the arena, so a
      // Lancer off screen could kill you along a line you were never shown.
      if (along > 0 && along < TUNABLE.lancerBeamRange && across < 16 + TUNABLE.playerRadius) {
        c.hurt(def.beamDamage ?? 16, {
          id: def.id,
          label: def.name,
          enemyId: def.id,
          shape: def.shape,
          mode: 'beam',
        });
      }
      c.beam(e, ux, uy);
    }
    return true;
  },

  suppress: (c) => {
    const { enemy: e, def, dt, spec } = c;
    // Drifts to a standoff just inside its own zone, so the zone covers the
    // player without the Suppressor walking into contact range.
    const dx = c.player.x - e.x;
    const dy = c.player.y - e.y;
    const d = hypot(dx, dy) || 1;
    const want = (def.zoneRadius ?? 200) * num(spec, 'standoffFraction', 0.6);
    const push = d > want ? 1 : num(spec, 'backoff', -0.6);
    e.vx = (dx / d) * def.speed * push;
    e.vy = (dy / d) * def.speed * push;
    e.x += e.vx * dt;
    e.y += e.vy * dt;
    c.collide(e, e.radius);
    return true;
  },
};

/**
 * §10.3 — the elite affixes, as trait lists.
 *
 * This is stage 2 of the refactor and it closes a complaint the code was already
 * making about itself:
 *
 * > "…either by the elite affix or by the def itself (§10.4 Ghost variants),
 * > because a variant should not have to be an elite to have an idea."
 *
 * An affix and a variant's own idea were two mechanisms doing the same job, one
 * of them hardcoded as three string literals checked in seven files, with the
 * pool duplicated in two arrays four hundred lines apart that had to be kept in
 * sync by hand. They are the same thing now: a list of traits, merged onto the
 * enemy's own at spawn.
 *
 * Adding an affix is a row here. Nothing else changes.
 *
 * ---
 *
 * **`override` is load-bearing and the two existing affixes disagree about it,**
 * so it is explicit rather than a convention. `anchored` used to *replace* a
 * def's own `zoneRadius`, while `phasing` used to *defer* to a def's own
 * `phaseInterval` — a Ghost that also rolled Phasing kept the Ghost's timing.
 * Prepending overrides and appending the rest reproduces both, because lookup
 * takes the first match. Getting this wrong is a silent balance change, which is
 * exactly what the pinned hashes exist to catch.
 */
export const AFFIX_TRAITS: Record<string, { override?: boolean; traits: TraitSpec[] }> = {
  volatile: {
    traits: [
      { t: 'deathBlast', radius: TUNABLE.affixVolatileRadius, damage: TUNABLE.affixVolatileDamage },
    ],
  },
  anchored: {
    override: true,
    traits: [{ t: 'zone', radius: TUNABLE.affixAnchoredZone }],
  },
  phasing: {
    traits: [
      { t: 'phase', interval: TUNABLE.affixPhaseInterval, hold: TUNABLE.affixPhaseDuration },
    ],
  },
};

/** Every affix that exists. One list, replacing two hand-synced arrays. */
export const AFFIX_IDS = Object.keys(AFFIX_TRAITS) as readonly string[];

/**
 * The enemy's own traits plus whatever its affixes bring.
 *
 * Called once at spawn — the result is stored on the enemy, because affixes are
 * rolled per individual and two Motes of the same def can now genuinely differ.
 */
export function mergeAffixes(base: readonly TraitSpec[], affixes: readonly string[]): TraitSpec[] {
  if (affixes.length === 0) return [...base];
  const before: TraitSpec[] = [];
  const after: TraitSpec[] = [];
  for (const id of affixes) {
    const entry = AFFIX_TRAITS[id];
    if (!entry) continue;
    (entry.override ? before : after).push(...entry.traits);
  }
  return [...before, ...base, ...after];
}

/** The first trait of a kind an enemy carries, or undefined. */
export function traitOf(traits: readonly TraitSpec[], t: string): TraitSpec | undefined {
  for (const spec of traits) if (spec.t === t) return spec;
  return undefined;
}
