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

Measured with the headless harness (`pnpm sim`) against the §8.1 cadence target.

| Tunable | GDD / initial | Now | Why |
|---|---|---|---|
| XP curve | base 6, ×1.19 | base 26, ×1.20 | Cadence was 6.8s; target is 30–45s. Now 40.5s median. |
| Threat rate | 0.055/s | 0.02/s | Puts Threat ≈ 24 at the 20:00 Meltdown line, so wave bands have room to spread across the build phase. |
| Wave interval | 4.5s base | 7.0s base, −0.2/Threat, min 2.0s | Early waves outpaced the starting Engine. |
| Wave templates | — | Rebanded to the new Threat scale; early counts reduced | Same reason. |

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

## Not built in Milestone 1

Deliberately absent, per the agreed milestone scope: the §16/§17 visual language
(bloom, phosphor trails, stroke-in spawns, decomposition deaths, the degradation
ladder, the grid instrument), audio (§18), Recompile (§9), Meltdown and
Containment (§11.4, §13.2), the Mirror (§10.4), adaptive resistance and
suppression (§11.1–11.2), Convert and the fuel arbitrage layer (§7.4), Discoveries
and the Library (§15), menus and Run Setup (§19.1–19.3), the Results run-trace
chart (§14), and settings (§20).

Present-but-placeholder: the renderer, the HUD, and the editor's interaction model
(click-to-reorder rather than §19.6's drag).
