# OVERCLOCK — Milestone 1: the grammar slice

> Codename only. The title is an open decision (GDD §25.1) and lives in exactly
> one place: [`src/branding.ts`](src/branding.ts).

The design document is [`overclock-gdd.md`](overclock-gdd.md). This milestone
builds the part of it that carries all the design risk — the effect grammar, the
Cycle economy, and the cascade physics — and deliberately does **not** build the
look. Implementation decisions and open questions are in
[`DECISIONS.md`](DECISIONS.md).

## Run it

```bash
pnpm install
```

```bash
pnpm dev
```

Then open the URL it prints. A run starts immediately — no menus yet.

| Key | Action |
|---|---|
| WASD / arrows | Move |
| Space | Dash |
| Tab | Pipeline editor (freezes time) |
| E (hold) | Channel a Wave Beacon |
| 1 / 2 / 3 | Pick a draft card |
| R | Reroll |
| Enter | Open a deferred draft |
| Esc | Pause, or defer the current draft |

The arena is larger than the screen — the camera follows you. Chevrons at the
screen edge point to Beacons you cannot see; channelling one calls the next wave
in early and enriched, and permanently raises Threat.

Seed and Axiom come from the query string, so any run is reproducible exactly:
`?seed=demo&axiom=circuit`. Axioms available: `ignition`, `circuit`, `feedback`
(see DECISIONS D-1 before trying that one).

## The other two commands

```bash
pnpm test
```

```bash
pnpm sim -- --runs 6 --minutes 12 --axiom ignition
```

`pnpm sim` is the headless balance harness. Because the simulation is fully
deterministic and renderer-free, tuning the [T] curves in GDD §23.2 is a
measurement rather than a guess — it reports draft cadence, EPS, cascade depth,
overheats and survival against the design targets. It found every balance problem
fixed so far.

## What works

- **The Engine** — ordered Programs of `Trigger → Modifier ×3 → Action`, evaluated
  left-to-right within a row and top-to-bottom across rows. Order changes outcomes:
  `Split → Amplify` and `Amplify → Split` produce different numbers, asserted in
  tests. Reorder a chain in the editor and watch the output multiplier move
  (×0.98 → ×1.15) at identical Cycle cost.
- **A world larger than the view** — The Heap is 4200×2400 with structure ruins
  for cover and herding, a following camera, and off-screen indicators.
- **Wave Beacons** — the greed line: call waves early and enriched, permanently
  raising Threat.
- **Cascades** — events carry depth, Actions emit events, loops form and are
  stopped by the Cycle economy rather than by the depth cap.
- **Cycles, Heat, Overclock** — static reserve, dynamic spend, deficit-to-Heat,
  instability tiers, misfires, corrupted projectiles, Overheat stall.
- **Fuel** — three hues, gauges, fuelled fires at +50% output.
- **Draft** — three cards, auto-slot, reroll, purge, deferral and queueing.
- **Pipeline editor** — live per-row Cycle cost, output multiplier, instance and
  execution counts, events/sec and share of total EPS; reorder and Scrap.
- **Enemies** — Mote, Drifter, Charger (telegraphed), Splitter (feeds On Kill).
- **Determinism** — same seed and inputs reproduce a run bit-for-bit.

Nodes so far: 4 Triggers (Clock, On Hit, On Kill, On Pickup), 4 Actions (Bolt,
Nova, Arc, Field), 3 Modifiers (Split, Amplify, Echo) — one per hue and one per
action primitive (projectile, burst, chain, zone). The remaining v1 roster in GDD
§22 is mostly data entry against those same primitives.

## What is deliberately missing

The visual language (§16) and game feel (§17), audio (§18), Recompile (§9),
Meltdown and Containment (§13.2, §11.4), the Mirror (§10.4), adaptive resistance
and suppression (§11.1–11.2), Convert (§7.4), Discoveries and the Library (§15),
menus (§19.1–19.3) and settings (§20). Full list at the end of `DECISIONS.md`.

**The renderer is a placeholder** — flat shapes, no bloom, no trails, no
decomposition. It exists to make the grammar legible, not to look like the game.

## Layout

```
src/
  sim/         deterministic core — no DOM, no renderer, no Math.random, no clock
    engine.ts    Programs, modifier chain composition, Echo expansion, Scrap
    world.ts     entities, collisions, director, the event loop
    cycles.ts    Cycles / Heat / Overclock
    draft.ts     deterministic draft rolls
    rng.ts       seeded, serialisable PRNG
    tunables.ts  every [T] number, separated from load-bearing ones
  content/     declarative data artifacts + schema and cross-reference validation
  app/         Pixi renderer, HUD, overlays, input, game loop  (placeholder layer)
  harness/     headless balance sweeps and the reference pilot
```

The dependency rule: `sim` imports `content` and nothing else. `app` and
`harness` both drive `sim`. Content is data; the engine is dumb.

## Invariants under test

- A seed reproduces a run exactly (`world.test.ts`).
- Modifier order changes output (`engine.test.ts`).
- Cascade depth never exceeds 12, and self-feeding loops are stopped by Cycles,
  not by the safety valve.
- No enemy ever spawns within 260 units of the player.
- No single Cycle spike, however large, can cross the whole Heat band — Overheat
  requires sustained greed (§6.3's "dial, not a line").
- A greedier engine always costs more Cycles and runs hotter than a lean one.
- Content with a dangling reference, duplicate id, or typo fails loudly at load.
