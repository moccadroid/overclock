# Implementation decisions log

Every place where the build had to resolve something the GDD left implicit, plus
every deviation from a documented number. Section references are to
`overclock-gdd.md`.

Status key: **BLOCKING** needs a design answer before the next milestone ·
**SIGN-OFF** implemented one way, reversible, wants confirmation ·
**SETTLED** a technical choice with no design content.

---

## D-1 · BLOCKING · The Feedback Axiom cannot start

§8.4 specifies Feedback as `On Hit → Echo → Bolt` with capacity −20. On Hit fires
when one of your effects damages an enemy (§5.3) — but with no Clock and no other
Action in the Engine, nothing ever produces the first hit. The Axiom is not hard
mode; it is a Program that can never fire.

Measured: 4/4 headless runs ended with **0 kills, 0 events, level 1**, dead at
~112s. Ignition and Circuit over the same window reach level 12–14 and peak EPS
43–62.

I have implemented the Axiom exactly as written rather than invent a fix. Options,
none of which I want to pick for you:

1. Give Feedback a second starter Program (e.g. a slow `Clock → Bolt` seed). Costs
   the Axiom its purity but keeps the fiction of a build that feeds on itself.
2. Let On Hit also listen to contact damage the player deals, or make Dash emit a
   hit. Changes the trigger's meaning globally.
3. Change the starter to `Clock → Echo → Bolt`, keeping the Echo bias and the −20
   capacity as the hard-mode identity. Smallest change; loses the On Hit flavour.
4. Ship a bootstrap rule: any Engine with no fireable Trigger gets a free 3s
   internal clock. Systemic, invisible, and slightly dishonest.

My preference is (3). One line of `axioms.json` either way.

---

## D-2 · SIGN-OFF · Echo doubles the execution schedule

§5.5 says Echo "repeats the Action once, 0.2s later, at 70% output", and §5.5's
commentary says Echo is "deliberately the strongest modifier in the game" and
"the intended discovery path to exponential output". A literal single repeat is
linear, not exponential, so I implemented the reading that produces the stated
behaviour: **each Echo repeats everything before it**, doubling the schedule.

- 1 Echo → 2 executions at output 1, 0.7 (total 1.7) for ×1.8 Cycles on the Action
- 2 Echoes → 4 executions totalling 2.89 output for ×3.24 Cycles
- N Echoes → 2^N executions, 2^N events

Because the cost multiplier applies only to the Action term of the cost formula
(D-4), the *cost* ratio grows more slowly than the event count. Echo is therefore
strongly positive on EPS — which is the score metric — and priced rather than
nerfed, per §23.1. `engine.test.ts` asserts this relationship so a future tuning
pass cannot invert it silently.

If you want the literal single-repeat reading instead, it is a two-line change in
`expandExecutions`.

---

## D-3 · SIGN-OFF · Amplify is additive, Split is multiplicative

§5.5 requires `Split → Amplify` ≠ `Amplify → Split` and describes "Split's
per-copy damage penalty applies after Amplify's flat bonus". Two multiplicative
modifiers would commute and the ordering axis would collapse, so:

- Amplify: `output += 0.5`
- Split: `count *= 3`, `output *= 0.65`

Giving `Split → Amplify` = 1.15 and `Amplify → Split` = 0.975 per copy. The
lesson this teaches players is "take your penalties before your bonuses", which is
a real, discoverable ordering rule.

Note this makes the GDD's illustrative "3 bolts × 1.5 dmg" approximate rather than
exact. Modifier arithmetic is data (`modifiers.json` `ops`), so the split between
additive and multiplicative is per-node and retunable without code.

---

## D-4 · SIGN-OFF · Cycle cost formula

§5.3 gives triggers a cost per event, §5.4 gives actions a cost per fire, §5.5
gives modifiers a multiplier, and §6.1 says a Program reserves "the sum of its
node costs". Implemented as:

```
cost = trigger.cycleCost + action.cycleCost × Π(modifier.cycleMult)
```

Charged once per Program fire, and reserved as static load while the Program is
live. The multiplier prices the copies: a Split that triples the bolts is paid for
by its ×2.0, not by charging three times. This keeps "price it, don't nerf it"
(§23.1) a single-number lever.

---

## D-5 · SIGN-OFF · Director population throttle (not in the GDD)

The starting Engine cannot out-kill the starting spawn rate, so population grew
monotonically and every early run died at ~3.5 minutes with a five-node Engine.
Added a soft cap: the director stops adding while
`alive ≥ 70 + Threat × 16`.

This does not inflate HP (§11 bans that) and does not reduce Threat — composition
and elite weighting still escalate freely. It also keeps entity counts inside the
§16.1 legibility budget. Both constants are in `TUNABLE`.

---

## D-6 · SETTLED · "No spawn-on-top-of-player, ever"

§12.2's guarantee was being violated: wave templates place enemies with a spread
around an edge origin, and a player hugging that edge landed inside the cluster
(measured 107 units). Rather than reroll — unbounded, and it would make spawn
positions seed-sensitive in a way replays dislike — the spawn point is pushed
radially away from the player to `spawnSafeRadius` (260) in a single pass. This
preserves the template's shape and is asserted in `world.test.ts`.

---

## D-7 · SIGN-OFF · [T] values changed from the GDD's starting numbers

Measured with the headless harness (`pnpm sim`). Current baseline across Ignition
and Circuit: draft cadence 37s median, first level at 22–33s, peak EPS 116–140,
deepest cascade 7–9.

| Tunable | GDD / initial | Now | Why |
|---|---|---|---|
| XP curve | base 6, ×1.19 | base 11, ×1.30 | Cadence started at 6.8s against a 30–45s target. Retuned twice, once for the arena change. |
| Threat rate | 0.055/s | 0.02/s | Puts Threat ≈ 24 at the 20:00 Meltdown line, so wave bands spread across the build phase. |
| Wave interval | 4.5s base | 7.0s base, −0.2/Threat, min 2.0s | Early waves outpaced the starting Engine. |
| Enemy speeds | 52–74 | 122–168 | Sized for a boxed arena. With a camera the player simply outran everything; see D-11. |
| Player speed | 260 | 300 | ~3s to cross the visible field, per §4.1. |
| Collect radius | 46 (§4.1's 1.5× diameter) | 95 | In an open world the player outruns their own drops; the opening starved for 97s before this. |
| Wave templates | — | Rebanded; early counts reduced | Starting Engine could not out-kill the starting spawn rate. |

Everything else marked [T] is at its documented value. All of it lives in
`src/sim/tunables.ts`, separated from `LOADBEARING` (unmarked GDD numbers, which
I have not touched) and `SAFETY` (runtime valves, never balance levers).

---

## D-8 · SETTLED · Score is literally the integral of EPS

§13.1 defines score as ∫EPS. Since EPS is a smoothed event count, the integral is
the run's total event count. Implemented as the actual integral so the Meltdown
multiplier (§13.2) can scale it later without changing the definition.

---

## D-9 · SETTLED · Fuel is consumed per Action instance

§7.2 says a fuelled fire consumes 1 fuel of its hue for +50% output. With Split
producing three instances, each instance checks and consumes independently, so a
wide Engine drains gauges faster. This makes hue starvation (§12.2) bite on the
builds that most deserve it.

---

## D-10 · SETTLED · Scrapping a row grants one stack per node

§5.7 grants +4% per scrap. Scrapping a whole Program removes several nodes at
once; it grants one stack per node removed, so row-scrapping and node-scrapping
pay the same for the same demolition.

---

## D-11 · SETTLED · The arena is a world with a camera — correcting an M1 error

Milestone 1 built The Heap as a fixed 1600×900 field with no camera. That was my
misreading, and the GDD contradicts it in several places:

- §19.4 puts *off-screen indicators* for Beacons, terminals, the Mirror and
  Wardens on the screen edges. If the arena fits on screen, nothing is ever
  off-screen and the entire HUD element is dead.
- §12.3 has Beacons spawning "somewhere on the arena", §12.4 has the Extract
  terminal "at a fixed arena landmark", §9.1 has Recompile terminals
  "edge-indicator marked" — all of which assume travel.
- §22 describes The Stack as "broad concentric corridors".

The Heap is now 4200×2400 (about 6 view-fields) with 21 authored ruin blocks as
soft cover, and the camera follows the player with lookahead, smoothed, clamped
to the arena. Ruins block movement for player and enemies and absorb
projectiles — rounding a corner bunches a crowd, which is the herding §22 asks
for.

Done before the visual milestone deliberately: culling, trail buffers and the
degradation ladder all get built against a viewport, and retrofitting a camera
after the phosphor pipeline exists is the expensive ordering.

Two consequences that needed new rules, neither in the GDD:

- **Spawn ring.** §12.2 says spawns arrive off-screen, but the simulation must
  not know the viewport — two players on different monitors would get different
  runs from the same seed. Waves therefore arrive on a fixed 1050–1350 unit ring
  around the player, sized to sit outside a nominal view.
- **Despawn.** Enemies more than 2600 units from the player are silently removed
  with no drops. Without this, stragglers the player outran accumulate forever
  and eat the population budget that should be producing pressure nearby.

---

## D-12 · SIGN-OFF · Always-on Engine strip

§19.4 specifies a deliberately minimal HUD and puts the pipeline in the Tab
editor (§19.6). In play that made the build invisible — the question "where are
my Programs?" is the one piece of feedback that says pillar 2 is failing.

There is now a low-brightness strip on the right edge: one line per Program
showing the chain as written and its live share of EPS. It is a real deviation
from §19.4 and easy to make a setting later.

The editor also gained ‹ › controls to walk a modifier along its chain. §19.6
specifies drag-to-reorder; the buttons are the placeholder. This matters more
than it sounds: reordering within a row is the single interaction that teaches
§5.5, and until now the build did not have it at all.

---

## D-13 · SETTLED · Viewport policy and a fairness note

The visible field is fixed at 900 world units tall; width follows the window's
aspect ratio, clamped to 1200–1900, then letterboxed. So an ultrawide monitor
sees a wider field but not an unbounded one.

Flagging it because this is a scoring game: seeing more of the arena is a real
advantage, and the clamp bounds it rather than eliminating it. If leaderboards
(§25.5) become competitive, the honest fix is a fixed view with letterboxing on
every aspect. Not a decision worth making now.

---

## D-14 · SIGN-OFF · Heat accrues from overdraw *rate*, not raw deficit

Originally each unmet Cycle became a Heat point. A single big cascade tick could
overdraw by 100+ Cycles and cross the entire 0–100 band at once, so the engine
bounced off Overheat every few seconds — measured at 75–82 Overheats per 12
minutes, roughly a third of the run spent stalled. That is a wall, not §6.3's
"dial, not a line", and it made Instability I and II doorways rather than places
to live.

Heat now accrues at a bounded rate proportional to how far over budget the tick
ran, measured as a multiple of what regen supplies. Running at 2× budget is
somewhere you can sit; 10× is not. `world.test.ts` locks in the property that no
single spike, however large, can cross the band.

Worth knowing for tuning: the harness now reports Cycle demand against supply and
time spent in each Heat tier. Circuit currently runs at 188% of budget with 11%
of the run in Instability. Whether that is the right amount of heat is a feel
question for first-playable, not something I should fit to a bot.

---

## D-15 · SIGN-OFF · Wave Beacons and Field brought forward

Neither was in the agreed M1 scope; both became necessary consequences of the
arena change.

- **Beacons (§12.3)** — a world map with nothing in it is just a bigger empty
  box, and §19.4's edge indicators had nothing to point at. Beacons give
  traversal a purpose and put the greed line in the build phase.
- **Field (§5.4)** — there was no Void action in the slice at all, so the violet
  gauge filled up and did nothing. Field adds a `zone` primitive (persistent
  damage area) and makes the third hue mean something.

Hue is still thin: adaptive resistance (§11.1), the director's hue starvation
bias (§12.2), Convert (§7.4) and Attune are all unbuilt, so choosing a hue is
mostly a +50% coin flip. That is the next thing that would make the fuel economy
a real decision.

---

## D-16 · SETTLED · Navigation is a shared flow field, not per-enemy A*

Enemies pressed against the ruins instead of going around them. A* per enemy is
the wrong tool at this scale — several hundred seekers all heading for the same
target — so navigation is one Dijkstra outward from the player over a 60-unit
grid, rebuilt only when the player changes cell, giving every enemy a direction
to sample. Bilinear interpolation between cells keeps movement smooth rather than
grid-snapped, and enemies within one cell of the player fall back to a direct
seek so contact-range motion stays natural.

Deterministic: a pure function of player position and the static ruins. Diagonal
moves cannot cut between two blocked cells. Tested both ways — an enemy walled
off by a ruin now closes to under 60 units (it used to stall at ~280), and an
enemy with a clear approach still travels in a straight line.

---

## D-17 · SETTLED · Wave spawns were materialising in view

Two bugs. The ring was 1050–1350 units, but the largest view's half-diagonal is
~1051 — so corner-ward spawns were landing right at the screen edge. Worse,
positions were clamped into the arena, which *collapses them toward the player*
whenever they hug an edge: standing in a corner, waves appeared in your lap.

Now: the ring is 1180–1480, and the director evaluates 12 candidate directions
and keeps whichever lands furthest outside a nominal view rectangle, rather than
clamping one blind guess. Template spread is re-pushed outside the view before
the hard no-spawn-on-player guarantee. Verified with the player jammed into the
arena corner — the worst case — 48 spawns, none on-screen, closest still 734
units beyond the edge.

Enemies also now draw themselves in over ~0.28s (§17.1) instead of appearing at
full size, which matters for Splitter children, who legitimately arrive nearby.

---

## D-18 · SETTLED · Scrap needed a confirmation, and §19.6 always said so

The first editor scrapped a node on a bare chip click: no confirmation, on the
same target you click to inspect a node, for an action that is permanent and has
no undo (§24). §19.6 specifies "drag a node/Program to the scrap margin →
confirmation showing refund + the permanent +4%" — I had implemented the effect
and skipped the safeguard.

Now the chip body is inert, a small × appears on hover, and that stages a
confirmation bar naming the node, the Cycles freed, the permanent output gain,
and that it cannot be undone. Drag-to-margin remains the shipping interaction for
the real editor.

---

## D-19 · SETTLED · Pixi arcs need an explicit moveTo

A stray line ran from the arena's top-left corner to the player at all times.
Cause: Pixi v8 follows canvas path semantics, so `arc()` connects from the path's
current point to the arc's start — and on a fresh path that point is (0, 0), the
world origin. The Cycle Ring draws arcs on the avatar every frame, so it trailed
a line back to the corner of the world forever.

All arcs now go through an `arcSegment()` helper that seeds the subpath with a
moveTo. Worth remembering for the M2 renderer, which will be mostly arcs and
dashes — it also silently welded the Field's dashed ring into a solid one.

---

## D-20 · OPEN · Draft cadence is now bimodal, not slow or fast

§8.1 asks for a level-up every 30–45s. With Beacons in, that is no longer a
single number: channelling one delivers an enriched wave and a cluster of
level-ups, with longer gaps between. Current Ignition baseline is 26s median
against a 46s mean — the distribution straddles the band rather than sitting in
it.

This is arguably the greed mechanic working exactly as §12.3 intends, and I do
not think it should be tuned flat against a bot that takes every beacon it sees.
Worth a look once a person has played it: is a burst of three drafts after a
beacon a reward, or an interruption?

---

## D-21 · SETTLED · The horde is continuous, not clumped

Wave templates dumped their whole composition at one point at one instant. In
play that read as: a clump appears, one Nova deletes it, nothing happens for
several seconds. Pressure that arrives in bursts isn't pressure.

Three changes:
- **Ambient stream.** Small `stream: true` templates draw continuously between
  waves, on an interval that shortens with Threat. The arena is never empty.
- **Staggered arrival.** A wave's members are queued with random delays across
  ~1.6s rather than spawning together.
- **Multiple compass slots.** Each template picks 3 origins, so a wave surrounds
  rather than piles.

The queue re-asserts the off-screen and safe-radius guarantees at arrival, not
just when queued — the player can cross most of a screen in 1.6s. Tested: with a
deliberately overpowered engine clearing everything it touches, dead air stays
under 2% and never exceeds 2.5 continuous seconds.

Kills per run went 2130 → 3441 with no change to enemy stats, which is the point:
§11 bans HP inflation as a difficulty lever, so pressure has to come from density
and composition.

---

## D-22 · SETTLED · Drag moves a node anywhere it fits

The editor could reorder within a row (‹ ›) and move whole rows (^ v), but
nothing moved a node *between* rows — the first thing anyone tries. §19.6
specifies drag, and the buttons were only ever a placeholder.

Any node can now be dragged to any matching slot in any row, swapping with
whatever is there. Slots are typed, so a Modifier cannot land in the Action slot
and only legal targets highlight. A move that would push static load past
capacity is refused and rolled back (§6.1) with an explanation rather than a
silent no-op. The ‹ › buttons stay for click-only use.

---

## D-23 · SETTLED · The per-row readout says words

It read `4.6 cyc  x1.00 out  1x2 / 1.3 ev/s  30% of EPS` — four unexplained
numbers and two invented units. Now:

```
costs   4.6 cycles
damage  ×1.00
fires   2 per trigger
output  30% of your engine
```

Dead rows say what they are missing ("needs an action") instead of "not live".
Rows no longer wrap mid-Program: a Program is one left-to-right sentence and has
to read as one.

---

## D-24 · SETTLED · The first level-up has its own cost

`xpFirstLevel` (5) is separate from the curve. §3 wants a decision every ~30
seconds, and the opening is the one moment a starting Engine cannot keep pace;
bending `xpBase`/`xpGrowth` to fix the first 40 seconds distorted everything
after it. First level is now ~42s, mean cadence ~31s.

---

## D-25 · SETTLED · The renderer is two layers, because §16.1 says so

"Emissives bloom, structure doesn't." So the grid and ruins draw straight to the
screen, and everything that emits light renders into a texture that is composited
twice — once flat, once blurred and additive. The emissive container is
deliberately *not* a child of the stage; it is rendered manually into the target
each frame, or everything would draw twice.

Chromatic aberration (ladder step 2) is two more additive copies of that texture,
tinted and offset. The Overheat tear (step 4) is currently a whole-scene
horizontal displacement rather than true per-band tearing — that wants a shader
and can come with the Meltdown ladder.

`src/app/visual.ts` holds every visual constant, including
`degradationIntensity`, which scales the entire §16.7 ladder at once. That is the
hook for §20.4's photosensitivity master toggle: §21 calls photosensitivity a
first-class constraint, not a switch bolted on afterwards, so the scaling exists
from the first version of the ladder.

---

## D-26 · SETTLED · Draw calls are batched by colour, not by entity

The naive phosphor trail issued one `stroke()` per trail segment per projectile —
five draw calls each, four thousand a frame at chaos. Trails are now batched by
(hue × trail band) and decomposition debris by (colour × fade bucket), quantising
the fade into four steps, which is invisible in motion.

Measured on a synthetic worst case of **2817 entities** (1417 enemies, 1400
projectiles with trails, plus debris): **4.73ms/frame, ~211fps**. Before
batching, half that entity count cost 9ms. §17.3 calls 60fps a design feature and
§16.1 wants legibility at 3000 entities, so this is the budget that has to hold.

Enemy outlines are still one stroke each, since the draw-in trace and kill flash
differ per entity. That is the next batching target if the roster grows.

---

## D-27 · OPEN · Balance is deliberately untouched

Reported from play: deleting everything on screen by level 11. Not addressed —
this milestone was the look, and §11 forbids the cheap fix. HP inflation is
banned as a difficulty lever, so the answer is Interceptors punishing projectile
spam, adaptive resistance taxing mono-hue, Suppressors switching triggers off,
and the Mirror. All of that is M4. Expect the game to be trivially easy until
then.

---

## D-28 · OPEN · Recompile does not currently earn its place

§9 is the mid-run prestige: delete your Engine, forge a Kernel, rebuild steeper.
§9.2 requires that "Recompiling at your peak clearly beats hoarding" and that
hoarding is "the noob trap". Measured across 12 seeds per arm, at 28 minutes:

| pilot | survived | score | reached Meltdown |
|---|---|---|---|
| never Recompiles | 1033s | 32,040 | 8/12 |
| Recompiles eagerly | 592s | 8,726 | 0/12 |

Hoarding wins by roughly 3.7×. The design's central claim about this mechanic is
false as built.

**Why, mechanically.** The player has no innate attack — every point of damage
comes from a Program (§3, §24: no manual aiming, no basic attack). As originally
specified, Recompile deletes every Program, so output goes to zero, so no XP is
earned, so no drafts arrive, so the Engine can never be rebuilt. The 2× XP
rebuild surge multiplies zero. Instrumented over five seeds, four of five
Recompiles never restored a single firing Program within the following three
minutes.

**What I tried, in order.** Each of these was measured, not reasoned about:

1. A much larger Kernel (up to ×2.9 global output). No effect on the outcome.
2. Rebooting to the Axiom's starter Program instead of to nothing, so the loop
   can feed itself. Fixed the dead end; did not fix the economics.
3. A far faster rebuild (6× XP for 180s instead of 2× for 120s). No effect.

The binding constraint is not the size of the reward and not the speed of the
rebuild. It is that **the cost of Recompile is progression time, and in this game
progression time is also survival**. You do not merely lose output while
rebuilding; you lose the ability to hold the arena, and the horde does not pause.
A multiplier cannot compensate, because it multiplies an Engine that is no longer
big enough to keep you alive.

Three separate measurement arms in this investigation were distorted by the
reference pilot rather than the game (a draft heuristic blind to an empty Engine,
and a policy that recompiled every 70 seconds). Worth remembering: when the
harness says a mechanic is bad, check the pilot before believing it.

**Current state.** Recompile is implemented and functional: terminals appear from
minute 8, the ceremony runs, the Kernel is forged, the Axiom starter is restored.
It is simply not worth taking. Options, none of which I want to choose alone:

1. **Cut it.** Meltdown alone carries the third act. Loses §9.2's answer to
   "a solved build stops generating decisions" — which is a real problem the
   player has already hit by level 11.
2. **Make it partial.** Sacrifice *chosen* Programs rather than all of them;
   bigger sacrifice, bigger Kernel. Becomes a dial rather than a cliff, and the
   cost stops being total. Furthest from §9 as written, closest to working.
3. **Pay the Kernel forward in nodes, not multipliers.** Recompile returns the
   deleted nodes as a guaranteed draft sequence, so rebuilding is near-instant
   and the Kernel is pure profit. Keeps the ritual, removes the vulnerability
   window.

**Resolved: option (2), partial sacrifice.** Channelling a Recompile terminal now
opens a selection: each live Program shows its share of your output, and you
choose which to burn. The Kernel, the capacity gain and the rebuild surge all
scale with the share sacrificed. Burning everything is still available and still
pays the most; it is simply no longer the only option.

This is a deliberate departure from §9.1's "delete the entire Engine — all
Programs, all nodes", taken because that version was measured to be strictly
worse than not using the mechanic at all, across four attempts to rescue it.

**The gradient, measured.** With the Kernel scaling linearly in sacrificed share,
12 seeds per arm at 28 minutes:

| what the pilot burns | score | vs hoarding |
|---|---|---|
| nothing | 32,040 | — |
| weakest row | 32,958 | **+2.9%** |
| strongest row | 26,773 | −16% |
| everything | 10,222 | −68% |

Partial fixed the trap — Recompiling finally beats hoarding — but it pointed the
incentive the wrong way. Nibbling at a dead row was the only profitable use, and
committing was still punished, which is §9.2 inverted rather than satisfied.

The cause is a curve mismatch: the Kernel was linear in sacrificed share, while
the *cost* of sacrificing is worse than linear, because losing your main producer
collapses survival and everything downstream of it. Four 25% burns therefore paid
the same as one 100% burn while risking almost nothing.

The Kernel now scales with `share ^ 1.9`, so a large sacrifice pays
disproportionately more than the sum of small ones. That is the knob that decides
whether this mechanic rewards courage or timidity, and it belongs next to the
Kernel formula on §23.2's sensitive-tuning list.

**That did not fix it either**, and the numbers showed why. Re-measured with the
exponent in place: burning the weakest row scored 35,780 against hoarding's
32,040 — while earning a Kernel of ×1.00, i.e. nothing at all. The Kernel was
never what made nibbling profitable. The **rebuild surge** was: `6× XP for 180s`
had been left in from the earlier "is rebuild speed the constraint?" experiment,
so sacrificing a near-dead row bought 34 seconds of sextupled XP for no
meaningful loss. Reverted to §9.1's documented 2×/120s.

**The clean numbers.** Re-measured with the surge back at its documented 2×/120s
and the `share^1.9` Kernel curve in place, 12 seeds per arm at 28 minutes:

| what the pilot burns | score | vs hoarding | reached Meltdown |
|---|---|---|---|
| nothing | 32,040 | — | 8/12 |
| weakest row | 24,835 | −22% | 3/12 |
| everything | 7,909 | −75% | 0/12 |

So Recompile is a net loss at **every** level of commitment. The earlier results
showing nibbling ahead by 3–12% were entirely the inflated 6×/180s surge; with
that removed, no version of this mechanic pays.

**The standing conclusion.** Across every variant tried — larger Kernel, Axiom
reboot, faster rebuild, partial sacrifice, super-linear scaling — Recompile costs
more than it returns, and the shortfall grows with how much you commit. The cost
is not output; it is the loss of survival that follows losing output, and a
multiplier cannot repay that because it multiplies an Engine no longer large
enough to keep you alive.

Left in place as a partial dial by explicit decision, with this understood: it is
currently a trap for the player at any setting, and its economics are unresolved
rather than fixed. The remaining lever is protective rather than economic — a
Recompile that clears the arena and grants brief invulnerability, so the rebuild
window is survivable. That is a mechanic change and wants a decision.

If we want commitment to be viable, the remaining lever is not economic but
protective: a Recompile that clears the arena and grants a few seconds of
invulnerability — the runtime rebooting around you. That is a mechanic change and
wants a decision, not another tuning pass.

Note the deliberate deviation already made: Recompile restores the Axiom starter
rather than leaving the Engine empty. Even if the mechanic is cut or reshaped,
that change stands — an Engine that cannot generate the XP needed to rebuild
itself is a dead end regardless of the surrounding economy.

---

## D-29 · SETTLED · The phosphor pass was too dim, and the pickups too small

Reported from play: "everything got smaller, the loot reads as noise, the
phosphor mostly made everything more dull." Correct on all three.

The §16.2 brightness bands were set conservatively — emissives at 0.5–0.7 — so
the bloom had nothing bright to work with and the whole field sat grey. Bands
now run 0.74–0.95 with bloom at 1.05, which also leaves Meltdown somewhere to
escalate *to*, since the ladder multiplies on top of the base.

Pickups were 1px dashed micro-shapes per §16.4. At the density this game
produces, a hundred of them read as static rather than as loot. They are now
solid glowing marks — a bright core with a hue halo, and white diamonds for XP —
batched per hue so the change costs nothing.

The brightness *hierarchy* is unchanged and still enforced: the player remains
the only object at 1.0, which is the part of §16.2 that is load-bearing.

---

## D-30 · SETTLED · Editor density

Reported as "overloaded and really hard to read", and bad on small screens. The
four-line stat block per row was the bulk of it. Now one line, led by a share bar
— the comparison between rows is what you actually scan for, and the exact
numbers are detail that belongs in a tooltip. The ‹ › reorder arrows fade in on
row hover instead of occupying the row permanently (drag is the primary
interaction anyway), and a media query stacks the stats under the chain below
900px wide or 620px tall.

---

## D-31 · SETTLED · M4, pressure that attacks the build

Reported from play: waves "never really feel threatening — still mostly blobs
that chase". Correct, and structural: every enemy built until now walked at the
player. §11 forbids HP inflation as a difficulty lever, so the answer is enemies
that pose different *kinds* of problem.

Built: **Bulwark** (front shield arc blocks projectiles — flank it, or use
something that is not a projectile), **Interceptor** (hunts your projectiles,
eats them, grows 10% per meal), **Suppressor** (never attacks; projects a zone
where your Triggers do not fire), **Leech** (steals fuel on contact, deals no
damage), **Lancer** (keeps standoff, fires a telegraphed beam across the arena),
**Warden** (mini-elite) with all four §10.3 affixes — Adaptive, Volatile,
Phasing, Anchored.

Plus the two systemic pressures:

- **§11.1 adaptive resistance.** The population resists each hue in proportion to
  that hue's share of your recent damage, capped at 60%, with a floor so nothing
  is taxed until one hue genuinely dominates. Always visible on the fuel gauges;
  enemies desaturate as they harden.
- **§11.3 reactive spawning.** Interceptor wave weight scales with the player's
  live projectile count, so spam summons its own counter — §23.1's "respond by
  pressure, never by deleting the interaction".

**Measured.** Against the pre-M4 baseline (hoard pilot, same seeds): mean survival
fell from 1033s to 457s, and Meltdown reach from 8/12 to 0/10. Then, teaching the
reference pilot to *diversify its hues* — the intended counter to resistance —
lifted score from 7,846 to 13,115 and kills from 1,671 to 2,599 with no balance
change at all. The counters demonstrably pay, which is the property that matters.

After softening the newest sources (Warden interval 55→90s and 320→220 HP, Lancer
beam 18→12, Bulwark contact 14→10), a 24-minute sweep lands at 3/10 reaching
Meltdown with mean draft cadence 36.2s. Meaningfully harder than before, not
brutal.

Worth knowing: a Suppressor parked on a stationary player shuts the Engine off
completely. That is §11.2 as written and the counter is real (22 HP, or walk out
of the ring), but it is the sharpest edge in this milestone and the first thing to
watch in play.

Not yet built from §10: **The Mirror** (§10.4), the elite that runs a snapshot of
the player's own Programs against them.

---

## D-32 · SETTLED · A wave is a composition, not a quantity

Reported from play: "waves seem to be a set number of units, and if I clear them,
nobody comes until the next... my programs just deleted everything on screen and
then I sat around for seconds collecting with no enemies."

That was a design error on my part, not a tuning miss. I had built waves as
*quantities* — spawn N of a template, then wait — so any engine that out-killed
the spawn budget bought itself silence. §7 calls the horde a supply chain; a
supply chain does not stop.

The director now holds a **composition** and feeds it continuously. It picks a
template, announces it with an arrival burst, and then spawns from that
composition at whatever rate is needed to sustain a target density, until the
composition rotates ~26s later. The entry counts in a template are now *ratios*,
not amounts.

Density is maintained, not capped, and this is deliberately **not** rubber-
banding: the target is a pure function of Threat, which only ever rises. Killing
faster earns more fuel, more XP and more EPS — it does not earn quiet. Resupply
rate has to exceed a strong engine's kill rate or the arena empties anyway, so
the ceiling on pressure is the density target rather than the rate of refill.

**What this changed.** Against the previous director, same seeds: kills per run
went from 3,889 to 25,817 and peak EPS from 187 to 2,054. More importantly the
*economy* finally engaged — Cycle demand went from 141% of budget to 1,384%, and
time spent in Heat instability from 3% to 35%. Capacity, Scrap and fuel now
matter, because they are finally scarce. The reported "zero incentive to scrap
anything or care about cycles" was a symptom of the arena being empty.

The XP curve was retuned for the new kill volume (a curve built for 3.9k kills
delivered a draft every ten seconds at 26k).

**The harness bot is no longer a valid balance proxy.** At 200+ converging
enemies, survival depends on kiting skill the reference pilot does not have — it
now dies around 6–7 minutes while a human reached level 17 comfortably. Tuning
density down until the bot survives would undo precisely what was asked for, so
density is set by judgement here and wants human play to confirm. The harness
remains authoritative for cadence, economy and throughput, which are pilot-
independent.

---

## D-33 · SETTLED · Loot must not look like a creature

Reported: "the loot looks a LOT like the enemies right now, especially the
starter enemies look very much alike."

Fuel motes were a stroked circle with a halo — which is a small Drifter. The
distinction is now categorical rather than a matter of size: **enemies are
outlined polygons that hold still; pickups are filled marks that bob and spark.**
Fuel is a filled core with a rotating four-point spark, XP a filled white
diamond, and neither carries an outline ring.

Mote and Drifter share a behaviour and therefore share a silhouette by §10.1, so
they could only be told apart by size. The Drifter now carries a concentric core.

---

## D-34 · SETTLED · The rest of the grammar, and the Convert layer

All 16 modifiers, all 10 triggers, crits, and §7.4's five Convert cards.

Three needed real engine work rather than data:

- **Ground** (§5.6) is the first node whose effect reaches *outside its own row*:
  it discounts the row above. That has to be applied after every row has
  compiled, and it is what finally makes row order a mechanical axis rather than
  a display order.
- **Resonate** (§5.6) fires the row below whenever this row fires. Chains form an
  exponential ladder; the cascade depth cap is what keeps it finite.
- **Quantize** (§5.5) needed a beat grid. There is now a deterministic 110 BPM
  clock in the simulation, which audio will lock to later rather than inventing
  its own.

**Convert** (§7.4) exchanges resources instead of dealing damage: Bleed trades
Integrity for fuel, Coolant trades fuel for Heat relief, Cash Out for XP, Stim
for speed, Rectify rebalances gauges. A Convert only fires when it can pay, never
spends your last Integrity, and emits On Convert when it resolves — so the
economy-engine archetype (§5.3) has something to listen to. The GDD calls these
exchange rates "the most sensitive tuning surface in the game" and welcomes
degenerate loops like Bleed + Leech as long as they cost Cycles; that is now
possible to build.

**Rectify deviates**: §7.4 has the hue pair "chosen at draft". Rather than ship
six variants or add a draft-time sub-choice, it moves fuel from your fullest
gauge to your emptiest, which is self-balancing and needs no extra UI.

### Pool weighting, which the expansion forced

Adding five Convert cards put them at half of all Actions, and the measured
result was an Engine full of cards that deal no damage: kills collapsed from
~12,000 to 101 and Cycle demand to 3% of budget. §8.2 always said the pool is
"weighted by what the player owns and their Axiom", but there was no way for
content to express rarity. Nodes now carry an optional `poolWeight`; Converts sit
at 0.34. Kills recovered to 2,048 and cadence returned to band at 31.4s median.

Worth remembering as a general lesson: adding content to a uniform pool silently
rebalances everything already in it.

---

## D-35 · SIGN-OFF · Rare triggers pay a bigger payload

Reported: "I'm wondering what triggers like On Crit are for... many of them are
cute, but useless. You say On Wound pairs with Leech, but it doesn't, because it
will never fire."

That is correct and it was a real design hole. Triggers differ by more than an
order of magnitude in how often they fire — On Hit can fire fifty times a second,
On Wave once every twenty-six — and until now every fire produced identical
output. A rarer trigger was therefore *strictly worse at everything*, and the
GDD's own flavour text ("On Wave: burst archetype") had nothing behind it.

Triggers now carry a `payload` multiplier, folded into output at compile time so
the editor's damage figure tells the truth:

| trigger | payload | why |
|---|---|---|
| Clock, On Hit | ×1 | the reliable baseline everything is measured against |
| On Kill, On Pickup | ×1.1–1.2 | frequent, mildly conditional |
| On Convert | ×2.5 | needs an economy built first |
| On Crit | ×3 | 5% of hits, unless you build crit |
| On Dash | ×3.5 | gated by a 3s cooldown |
| On Wound | ×5 | rare *and* unwanted — you must choose to get hit |
| On Wave | ×7 | roughly every 26s |
| On Overheat | ×8 | only if you deliberately run hot |

The deliberate consequence: a rare trigger is a *burst*. On Overheat → Split →
Nova is now a real archetype rather than a curiosity, and it weaponises the
penalty system exactly as §5.3 says it should.

**The alternative I rejected** was restricting which triggers can pair with which
modifiers or actions. It would work, but it fights pillar 1 — "power combos
emerge from a composable grammar; we never ship a correct build." Making every
combination *legal but differently shaped* keeps the grammar open. Some pairings
should still be bad; none should be pointless.

On Crit also needed two supports to mean anything: crit had to be buildable and
visible. §8.2's stat cards were specified and never built, so there was no way to
raise crit chance at all; they exist now (Precision, Collector, Servo, Plating),
and a crit draws a white starburst rather than relying on damage numbers that are
off by default.

---

## D-36 · SETTLED · Enemies were one organism

Three problems with one root cause: a shared flow field hands every enemy the
identical vector, so they converged onto one path, stacked on the same point, and
trailed the player in a single queue.

Per-enemy corrections, none of which lose the pathing: a slow weave with a
per-enemy phase, separation from neighbours, and a personal speed so a group does
not arrive as one rank. Measured with forty enemies released from a single point:
mean distance from their own centroid went from near zero to 40+ units.

**Density was also global rather than local**, which is why nothing spawned ahead
while a queue trailed behind — the tail consumed the entire budget and you could
outrun the game. Pressure is now measured within 1500 units of the player.
Verified by running in a straight line for a minute: 17 enemies ahead, 17 behind,
235 units of lateral spread, density holding at 34 of a 35 target.

---

## D-37 · SETTLED · Field was working and invisible

Reported as broken. It was firing thirty times a minute — the nerf had taken it
to 115 radius and 2.2s life, and the zone rendering was faint enough to miss
entirely. Restored to 140/3.2s, and zones now carry a fill tint, a heavier dashed
ring, and a pulse on every damage tick so you can see them working.

A lesson worth keeping: "it doesn't work" and "I can't see it working" are
indistinguishable from the player's seat, and the second is the more likely.

---

## D-38 · SETTLED · The draft was starving you of weapons

Reported: a whole run yielding one weapon. Measured across 60 seeds, Actions were
**under a fifth** of everything offered.

The cause is that the v1 roster is lopsided by design — §22 ships 14 modifiers
against 14 actions, but half of those actions are Converts, and a flat per-kind
base weight mirrors the roster rather than correcting for it. Weights now
compensate (actions 24, triggers 13, modifiers 10), and an empty slot pulls its
own kind toward you: a row with a trigger and no action doubles the odds of being
offered an action. Actions are now 28% of offers.

Worth recording so it is not misread later: measuring runs afterwards showed
weapons-held tracks *survival*, not offers — level 3 ends with one weapon, level
15 with five. A short run looks identical to a starved pool from the inside.

---

## D-39 · SETTLED · Node kinds are told apart by form, not colour

The first attempt coloured triggers blue, modifiers violet and actions amber —
which is almost exactly voltaic, void and thermal. Every chip looked like it had
a hue. §16.3 is explicit that the seven colours are the entire vocabulary and
that there is no decorative colour, so kind-colouring was never available.

Kinds are carried by **form** instead: a thick left border for triggers, a thick
right border for actions, a dashed border for modifiers — plus the grammar words
`WHEN` and `DO` on the chips themselves. The words do double duty, naming the
kind and teaching the sentence each row spells out.

---

## D-40 · SETTLED · Fuel had no visible economy

Reported: "the bolt shoots thermal, my thermal is always 0, the others are up.
What's the point?"

Both halves of that were invisible rather than broken. A gauge pinned at zero
means the engine is spending that hue exactly as fast as it arrives — the bonus
working. A gauge sitting full means nothing you own can spend it. Neither was
stated anywhere.

The gauges now show the flow: `−4.2/s spent` when a hue is being burned for the
bonus, `nothing spends this` when it is accumulating uselessly, alongside the
existing resistance tax. The primer's fuel section explains all three readings.

---

## D-41 · SETTLED · Fleeing was free

Local density stopped a trailing queue from starving the front, but running still
worked: what you left behind stayed inside the pressure radius while the road
ahead stayed clear. 60% of spawns are now placed ahead of the player's travel
while they are moving. Measured fleeing in a straight line for 90s: 9 enemies
ahead against 2 behind, where it used to be the reverse.

---

## D-42 · SETTLED · The action roster is complete — 14 of 14

Nine new Actions, and seven of them needed new engine primitives rather than
data. Before this the game had exactly four ways to deal damage — one projectile,
one burst, one chain, one zone — which is why every build converged.

| Action | primitive | what it adds |
|---|---|---|
| Mine | `mine` | a proximity charge left where you stood; arms, then detonates |
| Rupture | `delayed` | marks a target, explodes at that spot after 0.7s |
| Beam | `beam` | instant line to the *farthest* enemy, hitting everything on the way |
| Orbital | `orbital` | persistent bodies circling the avatar; they stack |
| Surge | `buff` | +40% engine rate for 2s — speeds up every Clock you own |
| Pull | `vortex` | continuous inward force; sets up bursts |
| Shove | `knockback` | radial displacement, budgeted (below) |
| Fragment | projectile + `seek` | steers toward a target instead of flying true |
| Siphon | projectile + `siphon` | steals fuel of the *target's* hue on hit |

Fragment and Siphon reuse the projectile primitive rather than adding two more:
one is a steering term, the other a hit side-effect.

**§23.1's guard on Shove is implemented, not deferred.** "Permanent knockback
walls" is named in the design as a *tension break* — a bug to fix rather than a
power break to protect — so each enemy carries a displacement budget per second.
Four Shove rows firing together cannot out-push it, and the horde still closes.
Tested directly.

Two supporting caps, both because these Actions persist rather than resolving:
orbitals are capped and carry a per-enemy hit cooldown (otherwise contact shreds),
and mines share the zone cap.

Measured with Mine, Orbital, Beam and Shove all live: 0.51ms/frame. The
persistent-entity primitives are cheap; it is per-entity draw calls that cost,
and those are already batched.

---

## D-43 · SETTLED · Cascades travel, and are priced for it

`On Hit -> Nova` detonates on each enemy struck, so a cascade walks across the
arena rather than staying on the avatar. Reported as possibly-a-bug, and my first
fix was to anchor every Action to the player, which does match §5.4's "radial
burst around avatar".

That was the wrong call and the design says so. §23.1: a power break that still
costs Cycles and still requires the player to move is **protected content**, to
be answered "by *pricing*, or by *pressure* — never by deleting the interaction."
Anchoring to the player deleted it. Measured, it also cost 84% of the game's
kills, because `On Hit -> Bolt` had been spawning its projectile at the enemy.

Restored, with the cascade priced by depth instead:

- **Output falls off geometrically** — `0.85^depth`. At depth 5 a fire pays 44%.
- **Cycle cost climbs linearly** — `×(1 + 0.25 × depth)`. At depth 5 it costs
  2.25×, which turns a deep cascade into Heat.

So a cascade runs wild near its source and runs out of steam as it travels. The
reported build now reaches depth 12, draws 119% of capacity, and leaves 47
enemies alive after two minutes where it used to clear the screen.

Actions that are meaningless anywhere but on the avatar — Mine, Orbital, Surge —
anchor there regardless, via an explicit `origin` field.

---

## D-44 · SETTLED · Silent no-ops are now labelled

Reported: "ricochet on orbital? ricochet + pierce? it's hard to know if these
combos actually make sense."

They often don't: a modifier writing a field its Action ignores costs Cycles and
achieves nothing. Restricting the pairings would fight pillar 1 — combinations
stay legal — so the editor names them instead. Each Action primitive declares
which fire-context fields it reads, and a modifier whose every effect is ignored
is drawn amber with **no effect**, with a tooltip saying what is being ignored
and that it still costs Cycles.

Universal modifiers (Amplify, Accelerate, Overdrive, Quantize, Attune, and the
topology pair) are never flagged, since they act on the row rather than the
Action's shape.

---

## D-45 · SETTLED · Three readability fixes from the same session

- **Orbitals looked like enemies.** An outlined circle *is* a Drifter under the
  §10.1 shape grammar. They are now filled four-point stars — a silhouette no
  enemy owns — on a visible orbit track, which also reads as "yours".
- **Loot appeared to vanish on big kills.** §7.3 consolidation was merging drops
  correctly, but a merged pickup drew at the same size as a single one, so value
  was preserved while the *evidence* of it was not. Pickups now scale
  sub-linearly with value.
- **The beat grid was invisible**, which made Quantize refer to something the
  player could not perceive. Until audio exists the Ring carries the pulse, and
  only when a row actually uses Quantize.

---

## D-46 · SETTLED · Heat was a punishment nobody watched arrive

Heat only moves when you are over or under budget, so the gauge sat at zero for
minutes and then leapt to a stall. The player experienced a penalty, never a
mechanism. Three changes, all legibility, none touching the model:

- `CycleBudget.heatRate` is now published, and the HUD says `▲ +N/s` or
  `▼ venting`. Venting is the half that matters: it is the proof that easing off
  works.
- The Heat bar wears its own tier boundaries. The track is drawn green to 40,
  amber to 70, red to 100, at low brightness where unlit — §16.2's brightness
  hierarchy rather than a colour that changes under you. You can see the zone
  you are in and the one you are heading into.
- The Cycle draw moved off screen-centre and onto the Engine strip, above the
  rows that cause it. Each row already reports its share; this is the total they
  add up to, against supply. A number in the middle of the screen with no
  referent is worse than no number.

## D-47 · SETTLED · Cascade depth is priced in Cycles, not in deleted damage

`On Hit → Nova` self-triggers, and at depth it deleted the screen. Blocking
self-triggering rows was rejected outright: §5.2 names `On Kill → Split → Bolt →
each bolt kills → more bolts` as the *intended* cascade, and §23.1 says price a
power break, never remove it.

The throttle moved onto the cost side. `cascadeOutputFalloff` 0.85 → 0.78 and
`cascadeCostGrowth` 0.25 → 0.5: at depth 5, roughly 29% output for 3.5× the
price. Measured across the harness sweep, Circuit's demand fell from 282% of
budget to 178% while time in Instability rose (89% nominal, peak Heat 53) and
kills went *up* (1,920 → 2,229). That is the shape wanted — the cascade still
runs, but you can watch the bill arrive on a gauge instead of quietly noticing
things die slower and blaming the game.

Nova's own numbers came down with it (damage 8 → 5, radius 130 → 112).

## D-48 · SETTLED · The draft pool inverted, and Gain replaces the missing ceiling

Reported ratio in play: "a TON of triggers and weapons but basically ZERO
modifiers or stats". The pool had been weighted action-heavy in an earlier
correction, when it was starving players of weapons, and overshot. You need
perhaps six triggers and six Actions across a whole run; modifiers you can
absorb forever, because they are what makes an existing row better.

Base weights are now modifier 26 / action 13 / trigger 7, with a wider filler
slice. Measured over 400 runs × 22 drafts: **modifier 43.1% · stat 16.3% ·
action 15.7% · trigger 11.0%** — the requested ordering.

Nerfing Nova removes a ceiling, so something has to give it back. **Gain**
(+8% damage on every Action, multiplicative with everything) is the new stat
card, weighted to appear about twice as often as the utility stats. It is
deliberately boring per card and deliberately unbounded in aggregate: act one is
tuned for base numbers, act three gets its ×3 from a stack of these.

## D-49 · SETTLED · Pull warps space instead of drawing a picture of warping

The vortex was ten sets of converging strokes laid over the arena — "very large
and ugly". The grid already had a distortion idiom (`warpedLine`, bending around
the avatar under load), so Pull now feeds that instead: `WarpSource` gained a
`swirl` term, and grid lines wind up tangentially around the vortex centre.
Subdivision became length-based, since a fixed 10 vertices per line cannot
resolve a 210-unit radius.

What is left drawn *at* the vortex is a bright core and two short boundary arcs.
The effect is not on top of the world; it is the world being wrong.

## D-50 · SETTLED · Results says how you died

`hurtPlayer` now takes a cause, and the world keeps both the final blow and a
per-source damage tally. Results shows both, because they are usually different
and the gap is the lesson: killed by a Lancer beam, but 60% of the run's damage
came from Drifter contact you never bothered to outrun. Self-inflicted damage
from Instability II corruption is named as such — "your own corrupted fire" — so
the cost of living over budget is attributable.

Convert's hue tag was also removed from its cards. §5.4 lists Convert's hue as
"—": it neither burns fuel of its own colour nor deals damage, so the tag was a
promise the card could not keep, and every other Action's tag has to stay true
or the tag means nothing anywhere.

---

## D-51 · SETTLED · The Feedback axiom can fire (closes D-1)

`On Hit -> Echo -> Bolt` needs a hit to make a hit. It was inert from the first
commit and the harness had been reporting `0 kills, 0 EPS, 8/8 died` for it all
along. `AxiomDef` gained an optional `seed` row for exactly this case, and
Feedback now opens `Clock -> Bolt` above its real row.

It immediately became the axiom the description always claimed it was:

| | survived | score | max depth | peak EPS | heat |
|---|---|---|---|---|---|
| Ignition | 246s | 9,585 | 2.4 | 311 | 100% nominal |
| Circuit | 278s | 11,070 | 5.0 | 191 | 89% nominal |
| Feedback | 167s | 15,387 | 12.0 | 618 | 55% nom / 32% I / 13% II |

Dies soonest, scores highest, lives in Instability. Hard mode, as advertised.

## D-52 · SETTLED · Meta-progression grants breadth, and the code cannot grant power

§15.1 is the iron rule, and the place it would get broken is the persistence
layer, so the constraint is structural rather than editorial. `LibraryData`
holds four id lists and four best-of records. There is no numeric field the sim
reads as a multiplier, and `profile.test.ts` asserts there is no numeric field
at all outside `runs` and `best*`. Adding one fails the suite, which means
adding one is an argument with §15.1 rather than with a reviewer.

Fresh accounts see 25 of 45 nodes. What is held back is not the strong half but
the half that references a system you have not met: On Overheat before your
first Overheat, the whole Convert layer before fuel is legible, Ground and
Overdrive before Cycles are a thing you feel. A test asserts run one still
reaches every hue, a self-feeding Trigger, and at least eight modifiers —
"thin enough to learn" must not become "too thin to express a direction".

The unlocked set is passed into `RunConfig`, never read from storage by the sim.
A run stays reproducible from seed + axiom + pool.

## D-53 · SETTLED · Discoveries are the tutorial

§15.4 says there is no tutorial level and callouts never repeat, which puts the
entire teaching load on §15.3. Twenty-five of them, each with a `teaches` line
that is load-bearing: a Discovery that only says "you did a thing" is a trophy,
and this system exists to replace a tutorial.

Detection is deterministic and lives in `src/sim/discoveries.ts`, so the same
seed and inputs earn the same Discoveries in the same order. Granting them
touches storage and therefore happens in the app, never in the sim.

The stinger does not pause. You earn most of these mid-cascade with the screen
full, and a modal would punish the exact behaviour being rewarded.

Two content-integrity checks are now tests rather than hopes: every Discovery in
the data has a condition behind it and vice versa, and every node locked at
start has some Discovery that grants it. The second one immediately caught a
chicken-and-egg — `Bloodletting` requires spending Integrity, which only
`Convert: Bleed` can do, and `Convert: Bleed` was locked behind nothing. It now
comes from `First Cut`, which is the same lesson twice: cut something off
yourself for a permanent gain.

## D-54 · SETTLED · Results looks forward, not only back

The post-mortem answers "how did I die". The Discovery panel answers "what is
the nearest thing I have not done", listing the next three unearned hints. A
Results screen that only looks backwards ends the session.

---

## D-55 · SETTLED · The Library is shown, locks and all

Progression that grants breadth rather than power has a presentation problem
that a stat tree does not: there is no number going up. If the player cannot
*see* the pool widening, the progression may as well not exist — which is
roughly what had happened, since the Library was persisting correctly and was
invisible.

So locked entries are shown rather than hidden, each with the exact thing to do
to open it. A lock you can read is an objective; a lock you cannot is a wall.

One iteration inside that: locked node chips were first labelled with the name
of the Discovery that grants them, which put "Beacon Runner" in the triggers
row where it read as a trigger. They now carry the node's own name with a lock
mark, and the Discovery moves to the tooltip. Hiding the name entirely was the
other option and it is worse — the pool becomes a row of identical boxes you
cannot want anything from, and wanting is the whole mechanism.

## D-56 · SETTLED · Run Setup exists, and deep links skip it

§19.1–19.3. Three panes: Run Setup, Library, Codex. An Axiom is a Program, so
Run Setup draws it as one — the same chain grammar the editor and the Engine
strip use, rather than a paragraph about it.

`?seed=abc&axiom=circuit` still goes straight into that run without the menu.
Reproducing a reported run must never require clicking through a screen, and a
half-specified link (seed only, axiom only) falls back to Run Setup with what
was given as the default.

Results gained `[ENTER]` for a fresh seed and `[L]` for Run Setup. Both reload
the page. There is no path that unwinds a run in place, and inventing one to
save a page load would be a lot of surface area for a guarantee the browser
already gives for free — the Library lives in storage, so nothing crosses it.

---

## D-57 · SETTLED · The Lancer was doing 88% of a run's damage

Reported as "when LANCERS enter the game I'm mostly insta dead", and the
post-mortem agreed exactly: one Lancer entry, 88% of all damage taken. That is
not a player missing a trick. Two bugs, both structural:

- **The beam had no length.** It ran 2,400 units — the whole arena — so a Lancer
  you could not see could kill you along a line you were never shown. §17.1 says
  every avoidable hit is preceded by a *drawn* line, and a line drawn off screen
  is not drawn. Range is now 900, barely past its 520 standoff: if it can hit
  you, it is close enough to be on screen.
- **Nothing capped how many charged at once.** Six Lancers meant six
  simultaneous telegraphs, which is not a dodge puzzle, it is a crossfire. The
  §23.1 pattern already used for Shove applies: `maxChargingLancers: 2`, and the
  rest hold their shot rather than being deleted from the fight.

The telegraph was also redrawn. It used to be a hairline that only thickened at
the end, which tells you where the beam is going a moment too late to matter.
It now draws the danger corridor at its true hit width from the first frame,
with the charge running up the middle as a fill.

## D-58 · SETTLED · Living things rotate; objects hold still

"It's still difficult at times to see what's loot and what is enemies." Loot and
enemies share the three hues and always will — §16.3 spends colour on
Thermal/Voltaic/Void and has none left over — so the tell cannot be colour.
Fill-versus-stroke was the previous answer and it was not enough at small sizes
under bloom.

The tell is now behaviour, and it is a rule rather than a tweak:

> Living things rotate, and each keeps its own phase.
> Objects hold their orientation and breathe on a shared clock.

Fuel motes stopped spinning — they are fixed upright crosses, an axis-aligned
form no §10.1 silhouette owns — and every pickup on screen pulses off one global
phase. A field of marks blinking in unison is not something the eye reads as a
swarm, and it separates at a glance even when the screen is full.

## D-59 · SETTLED · No browser tooltips

`title=` renders a white box in a system font, after a delay, somewhere near the
pointer. Every one of those properties is wrong: it punches a hole in §16's
document, it is slow enough that you stop asking, and it moves so reading is a
hunt rather than a glance.

Replaced everywhere with an `inspector` line pinned to the foot of each panel —
instant, in-world, always in the same place. One delegated listener per panel
rather than a handler per element, since the editor rebuilds its whole DOM on
every change.

The scrollbars went the same way: a thin phosphor rail instead of the platform's
light-grey slab.

## D-60 · SETTLED · Rows report damage, not a multiplier

"×1.24 output" is a number you cannot act on without knowing what it multiplies.
The question being asked is what one hit lands, so rows now answer it: base ×
chain × every global multiplier, as `13 dmg ×3`, with the per-fire total in the
inspector.

## D-61 · SETTLED · One Axiom at the start

§15.2 says three. Three on run one is three ways to be confused at once: an
Axiom is a *starting Program*, and you cannot evaluate one before you know what
a Program is. Ignition — the plainest possible `Clock -> Bolt` — is the only
honest first choice.

Circuit now comes from Chain Reaction (depth 4) and Feedback from Bottomless
(depth 10), which is the right shape: Circuit for building a loop, and Feedback,
which is nothing *but* a loop, for taking one deep.

## D-62 · SETTLED · The way out is not below the fold

The Results screen scrolled as one block, so restarting meant scrolling past the
post-mortem to find the key. The headline and the exits are now outside the
scroll region, and ESC works alongside L. A way out of a run should never be
something you have to look for.

---

## D-63 · BUG · Deferring a draft was a free infinite reroll

`present()` called `rollDraft()` every time, so ESC out of a draft and back in
produced three new cards. The strongest play in the game was therefore to escape
out of any offer you disliked, which made the entire §8.3 Reroll economy — and
the Reroll cards added the same day — decoration.

A deferred draft is now the *same* draft when you come back to it. `defer()`
closes without clearing the offer; `present()` only rolls when there isn't one.

## D-64 · SETTLED · ESC always lands somewhere with a way out

ESC meant four different things depending on mode, and none of them was a menu:
it closed the primer, closed the editor, silently deferred a draft (see D-63),
or produced a bare stat dump whose only exit was ESC again. That last one is the
worst kind of menu — it interrupts you and offers nothing for the interruption.

Pause is now a real screen, and it is the right place for it: a pause is the one
moment the player has time to read. It carries the whole run — the Engine with
per-row damage, the chassis, Heat and draw, the draft economy, what has been
discovered this run — plus the only deliberate way to leave a run.

ESC out of a draft opens it too, and resuming returns to that same draft rather
than dumping you back into the fight.

Quitting is two clicks: the button relabels to "QUIT — CLICK AGAIN TO CONFIRM".
A misclick there throws away twenty minutes. It also does not score the run —
banking a score by quitting would make §12.4's Extraction terminal pointless,
since walking to it would buy you exactly nothing.

---

## D-65 · SETTLED · Damage numbers, but only for damage taken

A number over every kill is eight thousand numbers a run and not one of them
gets read. A number over every blow *you* take is at most two a second — i-frames
see to that — and it was the one piece of combat information the game never
gave you. Until now the only way to learn what a Lancer hits for was to die and
read the post-mortem.

Each blow floats `−14  WARDEN`, sized by its share of your Integrity, so a Mote
graze and a Warden slam are different events at a glance rather than the same
red flash. The name rides along because the number tells you how bad and the
label tells you what to do about it next time.

The Codex was rewritten to lead with the same thing. It used to open with hp and
speed — facts *about* the enemy — when what a Codex entry is for is deciding how
to treat the thing on sight. Damage now comes first, with its share of a
starting Integrity bar beside it, because "12" means nothing until you know you
have a hundred. Suppressor reads "harmless on contact", which is the entry
earning its place: it is the only enemy where the right instinct is to ignore it
and deal with the zone instead.

## D-66 · DROPPED · Blueprints (§15.2)

"A new run is a new run." §15.2 is explicit that Blueprints never pre-load nodes
— they are a recipe card you read, and a wishlist overlay during a draft. Which
means the feature is a note-to-self with a UI attached: it exists to satisfy the
word "persistence" rather than to do anything. Cut. The Library's Discovery
hints already do the "here is a thing to aim at" job, and they aim at something
you can actually get.

---

## D-67 · SETTLED · Audio, and the wall between it and the sim

§18.1 says "the soundtrack *is* the engine", which only works if the audio layer
sees the same events the simulation computes. That is also the fastest way to
destroy determinism, so the boundary is enforced rather than intended:

- The sim pushes `AudioCue`s onto a list. Nothing in `src/sim` ever reads them
  back, exactly like `visualDeaths`.
- `audio.test.ts` fails the build if `src/sim` imports from `src/audio` or
  mentions `AudioContext` at all.
- A second test runs two identical worlds — one draining cues every tick, one
  letting them pile up — and asserts the hashes match.

So audio may lag, drop voices, be muted, or fail to start, and the run is
bit-identical. That is not a nicety: audio is the first system in this codebase
that runs on wall-clock time, and wall-clock time is the thing determinism
cannot survive touching.

Scheduling is lookahead against `ctx.currentTime`, never `setTimeout` for the
note itself. JS timers jitter by tens of milliseconds under load — precisely
when the game is loudest — and jitter is the one thing a beat cannot survive.
The timer only decides when to *schedule*.

## D-68 · SETTLED · One scale, one grid, one exception

Every pitched sound in the game comes from a single minor pentatonic. This is
not a musical preference, it is a consequence of the design: a cascade fires
forty notes on one sixteenth, and forty simultaneous notes can only ever sound
intentional if they are drawn from a handful of pitches that agree.

Depth climbs that scale, so a deep cascade audibly *rises* — the one thing the
depth counter on the HUD cannot convey.

The exception is §18.3's, and it is load-bearing: **player-hurt is the only
non-musical sound in the game**. Unquantized, unpitched, bit-crushed, played the
instant it lands rather than on the next boundary. Everything else is on the
grid and in the scale, so a clip that is neither is unmistakable even at forty
voices. Waiting 34ms for a boundary would make the one sound that must feel like
an interruption feel like part of the song.

## D-69 · SETTLED · The beat is a readout

The backing is minimal techno, and every part of it reports something:

- **Tempo** is 110 BPM climbing to ~140 with EPS, so the track speeds up because
  you built something.
- **Layers** arrive with intensity — kick always, offbeat hats once anything is
  happening, sixteenths as the engine gets busy, open hats when it is roaring.
- **The sub's root** follows your fullest fuel gauge, so the key of the track is
  a readout of the fuel you are sitting on.
- **Master-bus drive** rises with Heat, and a stall drops the track to a hole.

Intensity maps EPS logarithmically. EPS spans two orders of magnitude across a
run; a linear map would leave the track on its opening layer for ten minutes and
then pin it at maximum forever.

Settings live in their own object inside the Library rather than beside the
progression fields, because §15.1's guard scans that shape for numbers that
could become multipliers. A volume slider next to `bestScore` would force the
guard to be loosened, and a loosened guard is how a damage multiplier gets in.

---

## D-70 · SETTLED · Tempo is not the intensity lever

Reported: "the music speeds up too much, it makes you lose the groove." Exactly
right, and the reason is structural rather than a tuning miss. A groove works
because your body locks to a pulse; moving the pulse continuously breaks the
lock, so a tempo that tracks EPS is a tempo that never lets anyone settle.

Real dance music does not build with BPM. It builds with arrangement.

Tempo now sits at 112 and EPS does not appear in the formula at all. Only
Meltdown moves it, to 124 — a once-per-run, permanent, announced event, which is
the only kind of tempo change a listener can follow. Verified: 112 at zero
intensity, 112 at full intensity, 124 only in Meltdown.

## D-71 · SETTLED · Past a density, events stop being notes and become the mix

Reported: "if too much happens, it stops being rhythm and starts becoming
noise", with the fix attached — "not ALL sounds need to generate the music."

One note per event works while events are rare and collapses when they are not:
at 600 EPS the first build played ten notes every sixteenth, which is not
information, it is a wall. So events now do two different jobs depending on how
many there are:

- **Sparse** — each is an accent, and the game feels wired to your hands.
- **Dense** — they stop being notes and drive the arrangement instead: which
  layers are in, how hard the bass pattern drives, whether the pad is there.

The engine layer ducks to a quarter of its quiet-game volume at full tilt, the
per-step accent budget dropped from ten to three, and cues below a weight
threshold are skipped entirely once the track is carrying itself.

**When your engine is small you hear yourself; when it is huge you hear the
machine you built.** The handover is the reward, and it is closer to §18.1's
"the soundtrack *is* the engine" than a note per event was — Rez arranges at
least as much as it quantizes.

## D-72 · SETTLED · More track, less sound effect

- **A real bassline.** Three 16-step patterns selected by intensity, rooted on
  your fullest fuel gauge, so the key of the track is a readout of the fuel you
  are sitting on.
- **Sidechain ducking.** The music bus dips on every kick and recovers over the
  beat. This is most of why a real track breathes, and it is one gain automation
  per beat.
- **Chords for occasions.** Detuned saw stack, slow attack, long tail — cheap,
  but it reads as *orchestral* against a track made of blips and kicks, which is
  all it has to do. Level, Discovery, Recompile, Overheat. Deliberately rare: a
  fanfare you hear every thirty seconds stops marking anything. Occasions jump
  the accent queue and are never dropped, because a level-up chord losing its
  slot to the 300th kill note is the system defeating its own purpose.
- **A pad** above 0.55 intensity, two bars long, so it reads as atmosphere
  rather than a part.

Kick rebuilt in three parts: a click transient so it cuts through a busy mix, a
fast pitch drop the ear reads as "hit", and a 35Hz body the chest reads as
"oomph" — the body outlasting the transient by an order of magnitude is the
whole difference between a kick you hear and one you feel. A low shelf before
the saturation stage gives the drive something to bite on down where the kick
and bass live.

Measured after: peak 0.70 (was 0.595), zero clipped samples, median 0.171. The
low end got heavier without eating the headroom.

---

## D-73 · BUG · The chords sounded random, for two separate reasons

Reported as "just random chords... at some points there's no progression". Both
causes were mine, and both were the same category of error: making something a
*readout* at the cost of making it music.

**The key followed your fullest fuel gauge.** `HUE_TINT` transposed the entire
track by up to four semitones whenever your dominant hue changed — mid-phrase,
with no cadence, at a moment decided by combat. That is not a modulation, it is
a glitch with a rationale. The hue is still a readout, but of *timbre* now: it
moves the filter brightness, which colours the track without moving it.

**The accents ignored the chord.** Engine events played a fixed A-minor
pentatonic no matter what was underneath. Over a G major that puts a C against a
B — a minor ninth, the most dissonant interval available — so any cascade during
that chord sounded like a mistake. Accents now snap to the *current chord's*
tones, and cascade depth climbs through them. A forty-hit cascade is the chord
being arpeggiated, and cannot clash by construction.

A test also caught a third, quieter one: Feedback's bass reached for a fourth
chord tone that its `sus` chord does not have, so on those bars it silently
wrapped back to the root.

## D-74 · SETTLED · This is techno, so build it like techno

The first version wrote pop songs — four chords, one per bar. That is why it
sounded like a loop of unrelated chords rather than a track. What the genre
actually does:

- **Modal, not harmonic.** One tonal centre that stays put. Two chords is a lot.
  Chords are now held two to eight bars, so a change *lands*.
- **Movement is the filter and the arrangement, over 16-bar phrases.** The loop
  opens up and closes down; layers enter and drop at phrase boundaries. That is
  the "progression" this music has, and it was entirely missing.
- **Clap on 2 and 4.** With the kick it is the thing the body counts, and there
  wasn't one. It drops for the last bar of a phrase, which is what makes the
  next downbeat land.
- **The stab** — a short chord hit on an offbeat — is Detroit's whole
  personality and is where most of what people hear as melody lives.
- **A motif that repeats unchanged.** The hook is repetition, not development,
  so the wandering arpeggio was replaced by a fixed 16-step phrase per track.

## D-75 · SETTLED · One song per Axiom

The Axiom you start with is now the sound you play in. It makes the Axiom a
choice about how a run *feels* as well as how it opens, gives the Music menu a
reason to exist beyond a settings list, and gives the track roster a natural
place to grow — §8.4 wants six Axioms in v1, which is six tracks.

Ignition is warm and straight, Circuit is acid and relentless, Feedback is dub
techno with a broken kick and chords that hang. A test asserts every Axiom has a
track and every track has an Axiom, because a missing one silently falls back to
the first and makes two Axioms sound identical.

Seed-derived track selection is gone with it — the Axiom is a better answer,
and it is one the player chose.

---

## D-76 · SETTLED · Distinctness comes from voices, not from knobs

Reported: "now all the songs have the same voices". Correct, and the reason is
that the first pass expressed character as *parameters on one synth* — same
kick, same clap, same bass topology, different filter Q. Two tracks sharing a
synth with different settings still sound like the same band.

Each layer is now a set of named instruments:

- **Kick** — `punch` (house: mid decay, present click), `tight` (909: short,
  hard, leaves room for sixteenths), `deep` (dub: long, soft, almost no click).
- **Backbeat** — `clap` (three bursts a few ms apart, like many hands not quite
  together), `snare` (noise over a tuned body), `rim` (a woody tick, almost
  nothing).
- **Bass** — `pluck` (round, stays out of the way), `acid` (a real 303: one saw,
  a steep resonant lowpass, and a *filter envelope per note*. The squelch is the
  envelope, not the resonance — that is the part everyone gets wrong. Accents
  open it further; glide slurs one note into the next), `sub` (almost a sine, no
  filter movement at all).
- **Stab** — `organ` (stacked sines at octave and fifth, drawbar registration,
  no filter movement), `saw`, `dub`.
- **Lead** — `pluck`, `acid` (the 303 an octave up, reedy and sliding), `bell`
  (two-operator FM at a non-integer ratio).

Measured across five seconds of each, average energy per band:

| track | onsets | sub | low-mid | mid | high |
|---|---|---|---|---|---|
| Ignition | 27 | 209 | 102 | 42 | 9.8 |
| Circuit | 24 | 189 | 117 | 84 | 43 |
| Feedback | 17 | 223 | 64 | 16 | 2.5 |

Previously all three sat between 9 and 17 in the highs. They now span 2.5 to 43.

A test asserts no two tracks share any voice slot — the failure mode this
guards is silent, since a duplicated voice sounds fine, just not different.

## D-77 · SETTLED · Dub techno does not break the kick

Reported: "the broken kick doesn't work as well". It does not, and the reason is
that a missing third beat reads as an error rather than as space — the body
counts four and one of them is absent, with no compensating accent to explain it.

The genre does not do that. It keeps four on the floor and creates space with a
*soft, long, low* kick and silence everywhere else. So the pattern went back to
whole and the character moved into the voice, where it belonged.

Feedback also gained the thing that actually defines the genre: **a dub delay**.
A dotted-eighth feedback loop with a lowpass inside it, so each repeat returns
darker than the last and the tail dissolves rather than stopping. Its stab and
lead are sent to it at 0.85, meaning most of what you hear from those layers is
echoes. Naming the Axiom "Feedback" made this too apt to pass up.

## D-78 · SETTLED · Circuit gets a tune

"Circuit has a melody, that's good — lean into this even more."

Its motif went from one bar to two, so it is a line rather than a cell that
repeats, and the motif sequencer now walks its own length instead of the bar's.
The lead is the 303 voice with glide, which is what makes a line sound *played*
rather than stepped, and the bass takes accents on five of its sixteen steps.

---

## D-79 · BUG · The chords were a pad, and a pad is not harmony

Reported: "they sound ethereal without any connection". Literally accurate. The
pad had a two-second attack on an eight-bar chord — it swelled in and out with
no relationship to the grid, so it was not playing *in time with* anything.

Harmony in this genre is never carried by a sustained wash. It is carried
rhythmically: by the stab, by the bassline, by a chord chopped into sixteenths.
The pad is gone. Chords now land on the grid with a hard attack and a gate, and
an occasion chord is three hits on the beat rather than one long swell — it
should land *in* the track, not float above it.

## D-80 · SETTLED · The Engine is the arrangement (closes §18.1 honestly)

§18.1 says "the soundtrack *is* the engine". It was not. It was a table keyed by
Axiom, with the Engine allowed to add decoration on top — the claim was a
comment, not a fact.

**Every Program is now a part**, derived from the row itself:

| Program element | Musical role |
|---|---|
| Action | the instrument — voice family and register |
| Trigger | the rhythm — a 16-step pattern |
| Modifiers | the processing |
| Hue | the band it occupies |

Each mapping is chosen so it lines up without needing to be taught. A Clock is a
metronome, so it lands on the quarters. On Hit is the densest event in the game,
so it is sixteenths. On Crit is rare, so it is two accents a bar. A Nova is a low
burst and a Bolt is a high pluck, matching what they look like — so rows stack
into a mix by themselves instead of crowding one octave. Split makes three of
something, so it flams. Echo repeats, so it feeds the delay. Ground quiets and
darkens a row, so it does the same to the part. A row that is not live is silent,
which makes the editor's "not live" warning audible.

Measured on a four-row build:

```
0: pluck  reg  0  X...X...X...X...            Clock > Bolt
1: acid   reg 12  X.X.X.X.XXX.X...            On Hit > Split > Arc
2: stab   reg-24  ..XX..X...XX..X.  echo .55  On Kill > Echo > Nova
3: drone  reg-12  ..X...X...X...X.  len 2.2   On Pickup > Sustain > Field
```

The load-bearing idea, and the reason this is music rather than sonification:

> **The pattern comes from your build. The accents come from your play.**

A build is stable for minutes, so the sequence is hypnotic and repeating, which
the genre needs. Play is second-to-second, so it lands on top as performance.
Rebuilding your Engine audibly rewrites the track.

Parts are rebuilt only when the build's signature changes, never per frame — a
pattern that changes sixty times a second is not a pattern.

## D-81 · SETTLED · A line needs air

On Hit plus Split, and On Hit plus Accelerate, both filled all sixteen steps. A
part with no gaps is not a part, it is a drone, and four of them is a wall.

Fixed with a density cap applied *after* all modifiers rather than inside each
one, because the rule is musical rather than a property of any particular
modifier — and doing it once at the end means a modifier added later cannot
reintroduce the bug. Offbeat sixteenths are dropped first, from the end of the
bar, which preserves the downbeat and the part's identity. A test asserts no
single modifier can saturate.

---

## D-82 · SETTLED · The Music screen lists Engines, not styles

Once a Program became a part (D-80), "pick a style" stopped being a coherent
offer: there is no style to choose, because the track is written by whatever
Engine you build. A screen offering five adjectives was describing a system that
no longer existed.

It now lists **Engines**, shown as the chains they actually are, and playing one
plays exactly what that build would sound like in a run. The first three are
generated from `axioms.json` rather than transcribed, so an edited Axiom cannot
leave a demo quietly lying about what run one sounds like. The rest are picked
to lean on *different Triggers*, since the Trigger is what decides a part's
rhythm — a list of builds that all used Clock would be one beat with different
timbres over it.

Measured across the list, average energy per band:

| engine | onsets | sub | mid | hi | air |
|---|---|---|---|---|---|
| Ignition | 21 | 206 | 104 | 34 | 7.1 |
| Cascade | 23 | 196 | 126 | 82 | 30 |
| Drift | 13 | 222 | 83 | 30 | 0.2 |
| Clockwork | 17 | 164 | 77 | 27 | 3.2 |
| Economy | 21 | 194 | 119 | 77 | 35 |

None of that difference is authored. It falls out of the Programs.

The one thing the screen can still meaningfully choose is the **bed** — drums,
key, chord — which comes from your Axiom and can be pinned. Tests assert every
demo names real nodes (a typo'd action id does not throw, it silently falls back
to a pluck and misrepresents the build), every Axiom is auditionable, and no two
demos are the same Engine.

The screen also turned out to be a decent build-inspiration list, which is a
better use of the space than a column of adjectives.

---

## D-83 · SETTLED · The pipeline and the pause screen were one screen

Reported: the run summary is "awkward to access only through ESC instead of TAB
which is already muscle memory". Correct, and the deeper problem is that they
were never two things. Both freeze the run, both are read rather than played,
and both answer "what is my situation". Having them behind different keys meant
half of what a player wants mid-run was behind the key they were not pressing.

They are tabs of one console now. TAB opens it on PIPELINE, ESC opens it on RUN,
and pressing the other key while open switches page rather than closing — ESC out
of the pipeline should show you the run, not dump you back into the fight. A
second press of the key you came in with closes. RESUME and QUIT live in the foot
of both pages.

That deletes a mode from the state machine rather than adding one, which is the
direction these things should go.

## D-84 · SETTLED · Chrome sounds, in key but off the grid

§18.4: "silence is banned: even the menu hums." Two rules that pull against each
other, and both matter:

- **In key.** Every UI pitch comes from the same pentatonic as everything else,
  so a click during a cascade is a note rather than an intrusion.
- **Off the grid.** Everything else waits up to 34ms for a sixteenth. A button
  that waited would feel broken. Immediacy is worth more than alignment for
  anything the player's hand caused directly — the same exemption §18.3 gives
  the hurt clip, for the same reason.

Hovers are rate-limited to 45ms and are the quietest sound in the game: they
fire hundreds of times a minute as a cursor crosses a list, and anything you
could describe individually becomes unbearable in aggregate.

Chrome goes to the punch bus rather than the music bus, because a click that
ducks under the kick reads as a click that did not register.

Death gets the one sound that is allowed to lose to the track: the hurt clip's
wrongness, pitched down over 1.4 seconds. §18.3 says the hurt clip is the only
non-musical sound in the game; this is its full stop.

---

## Not built in Milestone 1

Deliberately absent: the §16/§17 visual language (bloom, phosphor trails,
stroke-in spawns, decomposition deaths, the degradation ladder, the grid
instrument), audio (§18), Recompile (§9), Meltdown and Containment (§11.4,
§13.2), the Mirror (§10.4), adaptive resistance and suppression (§11.1–11.2),
Convert and the fuel arbitrage layer (§7.4), Discoveries and the Library (§15),
menus and Run Setup (§19.1–19.3), Extraction (§12.4), the Results run-trace chart
(§14), settings (§20), and The Stack (§25.3, blocked on The Heap playing well).

Present-but-placeholder: the renderer, the HUD, and the editor's interaction
model (button-reorder rather than §19.6's drag).
