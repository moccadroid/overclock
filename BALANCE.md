# Balance baseline

The state of the game as measured, so the next change has a *before*.

Every number in this repo's comments used to be a measurement taken once and
quoted forever, against a configuration nobody wrote down. This file is the
replacement: what was measured, under exactly which configuration, and the
command that reproduces it.

**Nothing here is a target.** The targets are in the GDD.

**And most of it is not about the game.** The harness pilot dies at minute four;
a competent player does not. So a bot number is only evidence when it survives
the question *"would a better player move this?"*:

| kind of finding | trustworthy? | why |
|---|---|---|
| pool composition, offer rates, exclusion reasons | **yes** | counting the data, not playing it |
| draft cadence | **one-sided** | a better player kills more and levels *faster*, so the target is missed worse, never less |
| capacity reserved, load share | **no** | a better player builds more rows and reserves more |
| survival, deaths, Meltdown reach, wave templates seen | **no** | all downstream of how well it plays |

The corpus (`pnpm analytics`) is the authority on everything in the bottom two
rows. The harness's real job is **regression detection** — proving a refactor
did not change the game — and it has done that three times: three rewrites of
`draft.ts` and `bot.ts`, each re-run against the same sweep, each byte-identical.

---

## How to reproduce

```bash
pnpm sim -- --runs 8 --minutes 12 --out analytics/baseline-shipped.ndjson
pnpm analytics -- --in analytics/baseline-shipped.ndjson --all
```

**Runs are grouped by `cfg.all`** — a digest over every balance surface, not
just `tunables.ts`. That distinction is load-bearing: the fix that stopped a
Cache fielding suppression is a `waveevents.json` edit, and under the old
tunables-only hash it did not move the fingerprint at all, so runs from before
and after would have pooled into one population. `cfg.parts` says which surface
moved; `cfg.profiles` says which draft-pool and progression profile was live,
which no hash can tell you. See `src/meta/fingerprint.ts`.

A run reports itself in the same document shape whether a pilot played it or a
person did, so `analytics.ts` reads a sweep and a corpus of real players with one
code path. A sweep's axes ride in `build` as `sim:<pilot>/<pool>/<progression>`,
which that tool can already filter on:

```bash
pnpm sim -- --pilot all --pool no_placeable_filter --progression default --out analytics/x.ndjson
pnpm analytics -- --in analytics/x.ndjson --all --build sim:wide/no_placeable_filter/default
```

Three axes, all data, none of them requiring a code change:

| axis | file | profiles |
|---|---|---|
| progression | `src/meta/data/progression.json` | `open` (active), `default` |
| draft policy | `src/content/data/draftpool.json` | `default` (active), `no_placeable_filter`, `flat` |
| pilot | `src/harness/data/pilots.json` | `builder` (active), `chaser`, `wide` |

---

## Shipped configuration

`progression: open` · `pool: default` · `pilot: builder`
24 runs (8 per axiom) × 12 min, seeds `harness-0..7`, tunables `1dbd3cae`.

### Design targets

> **Correction.** This table originally reported draft cadence as a bare median,
> and a median is the wrong statistic for it. Measured on real play, level-ups
> *cascade*: `22.2, 56.4, 57.9, 68.1, 68.7, 72.7, 78.8` — a 34-second wait, then
> five in twenty-two seconds, two of them 0.6s apart. The median alone sends you
> to slow the XP curve, which lengthens the wait and leaves the cascade
> untouched. `analytics.ts` now prints the spread and the share under 5s beside
> it; read those, not this number.

| target | measured | want | n |
|---|---|---|---|
| §8.1 draft cadence | **16.0s median — see correction above** | 30–45s median | 285 |
| §3 first decision | 19.2s | under 45s | 24 |
| §9.2 recompiles | **0.1** | 2–3 per run | 24 |
| §6.3 heat tier 2+ | 4.7% | under 30% | 24 |
| misfire rate | 2.5% | under 25% | 24 |
| §6.1 capacity reserved | **24–46%** | 70–85% | 24 |

Three of six are out of band, and the same three have been out of band for as
long as anyone has been measuring — the draft arrives at twice the intended rate,
Recompile effectively never happens, and the constraint the build is supposed to
be played against is not binding on anything.

### Per axiom

| | survived | died | level | peak EPS | score | overheats | reserved |
|---|---|---|---|---|---|---|---|
| ignition | 288s | 7/8 | 11.3 | 597 | 7,977 | 0.0 | 24% mean, 41% peak |
| circuit | 382s | 6/8 | 15.8 | 1,203 | 62,655 | 7.8 | 31% mean, 52% peak |
| feedback | 221s | 8/8 | 13.8 | 1,074 | 21,339 | 10.0 | 46% mean, 67% peak |

**21 of 24 runs die**, median 235s, against a Meltdown line at 20:00. Nothing
reached Meltdown. Threat therefore tops out around 5–9, which is why the wave
table above `minThreat: 9` — ten of twenty-seven templates — has never been seen
in a measured run.

Ignition spends the entire run in nominal Heat with zero overheats: on the
default Axiom the whole §6 economy is weather that never arrives. Feedback is the
only Axiom where either build-tension axis does anything, and it dies 8/8.

### Deaths

Drifter 38%, Mote 13%. The two weakest enemies in the game account for half of
all deaths, which is a statement about density rather than about lethality.

---

## Cross-axis readings

These exist because a single-axis reading is how the numbers above got quoted
wrong for months. Each was taken on the curated library (`--progression default`)
with ignition, 6 runs × 10 min.

### Draft policy × pilot

survived / score:

| pilot | `default` | `no_placeable_filter` |
|---|---|---|
| builder | 213s / 4,489 | **316s / 8,751** |
| chaser | 269s / 18,707 | 260s / 18,783 |
| wide | 265s / 9,943 | **324s / 23,607** |

Offering cards you cannot immediately place is a large gain for two pilots and
**nothing at all** for `chaser` — a pilot that does not want Triggers is not
helped by being offered more of them. Measured with `builder` alone it reads as
"~50% survival, ~2× score", which is one taste's number quoted as the game's.

The more uncomfortable column: **`chaser` scores 4× `builder` on the shipped
pool** (18,707 vs 4,489) while dying just as often. The pilot that ignores
Triggers and stacks modifiers is currently the strongest way to play, which is
the opposite of what the hunger weighting exists to encourage.

`--pool flat` — no hunger curve, no empty-slot pull, no inert penalty, no Axiom
lean — also beat `default` (298s vs 206s on 4 runs × 8 min). The pool's
intelligence may currently be costing runs. Not yet measured across pilots.

### Progression

The gating graph is off (`open`) while tuning. Under `default` it removes
**more than half the Trigger class**: 7 of 16 Triggers available, 9 of 17
Actions, 15 of 25 Modifiers. Card shares over a run shift from
21.8% / 16.7% / 40.8% (trigger/action/modifier) to **12.9% / 8.8% / 46.4%**.

That is the configuration a real first-time player sees, and no harness, test or
lab had ever run it. Every tuning note in the codebase's comments was taken on
the full pool.

Two compounding effects on top, both measured:

- `placeable` removes Triggers from the pool entirely once all four rows have
  one — 40% of draft moments on the shipped pool, 60% on feedback. Past draft
  six the offer is modifiers and filler.
- `refusalsBeforeDrop: 3` is calibrated against 16 Triggers, not 7. A pilot that
  passes on Triggers burned **all seven out of its own pool permanently** and
  finished a 13-minute run on one live row.

Most of the Discoveries that reopen the Library are gated behind states these
runs never reach — Meltdown (0/24), depth 10, five live Programs (measured 1–4),
400 EPS. Thin pool → weak runs → no Discoveries → thin pool.

---

## Known-wrong, not yet fixed

Recorded here rather than fixed, because each is a balance decision:

- **Draft cadence 16s against a 30–45s target.** `xpBase` / `xpGrowth`.
- **Capacity reserved at 24–46% against a documented intent of 70–85%.**
  `cycleCapacityBase`, or Action `cycleCost`.
- **Recompile at 0.1 per run against a target of 2–3.** §9.2 says recompiling at
  your peak should clearly beat hoarding; no pilot currently agrees.
- **Ten wave templates never seen**, plus every elite variant they carry.
  Downstream of survival, probably not its own problem.
- **`tool:reroll` offered 20 times, taken 0.** The reference pilot has no read on
  the pool, so this is a statement about the pilot as much as the card — but
  `chaser` does not take it either.
