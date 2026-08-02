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

**The standing conclusion.** Across every variant tried, burning the *whole*
Engine lands at roughly −68% versus hoarding, and no reward curve has moved it,
because the cost is not output — it is the loss of survival that follows losing
output. Partial Recompile works as a low-stakes dial. Total commitment, which is
the feeling §9.2 is actually chasing, does not, and probably cannot while the
player's only defence is the Engine they just deleted.

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
