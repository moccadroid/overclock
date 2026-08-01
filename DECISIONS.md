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
