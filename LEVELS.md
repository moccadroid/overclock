# OVERCLOCK — Level & Campaign Design

**This document owns the arena as a place: what the rooms are, how the site grows
across the campaign, and what gates the story.** NARRATIVE.md owns the words and
the twist discipline; the GDD owns systems. Where this document contradicts the
GDD (run length, §21b's biome sketches, anything mentioning fuel), this document
wins — see §9 for the list of superseded material.

Decisions recorded here were settled in design review: campaign length ~12–15
runs median; failure gets all three tiers (§5.3); the resistance points and
never places (§5.4); B4's first fragment lives in the first room (§6).

---

## 1. The run is fifteen minutes

A run is ~13 minutes of build plus a meltdown the player should not survive past
~2 minutes. Total ≈ 15. This is a re-cut of the GDD's 20:00 line, and it moves
four numbers:

| dial | now | target | why |
|---|---|---|---|
| `meltdownAt` | 1200s | **780s** | 13:00 build phase |
| extract `fromTime` | 900s | **~570s** | the bank-it window opens at 9:30 |
| `threatPerSecond` | 0.02 | **~0.031** | reach the same endgame Threat (~24) at 13:00 — or re-band `waves.json` instead; one or the other, not both |
| meltdown multiplier | +0.25/30s | **+0.25/15s** | ×2 at death was never a third act; a 2-minute meltdown needs the number to move while it lasts |

Containment's interval ramp tightens to match: overlap should become
unsurvivable around meltdown +2:00. This is currently unmeasurable — no harness
run has ever reached meltdown (BALANCE.md) — so it tunes against real play.

**Dwell budget.** At 300 u/s, one screen is 6.4s of travel. A run visits **3–4
levels**: the first room is 2.5–3 minutes, each room after it 4–5, story annexes
are 30–60 second detours. Three main rooms plus one annex fills 13 minutes with
almost no slack, which is the point — travel never eats the game.

---

## 2. The first room — The Heap, redesigned

### 2.1 What it teaches and how

There is no tutorial level (GDD §15.4) and there does not need to be one: **the
tutorial is Bureau onboarding.** Three or four **stations** — fixed, authored
POIs, faint glow, labelled `TERMINAL — HOLD E` — each opening one Bureau sheet
in-run, time frozen, dismissed with any key. Optional, skippable, never blocking.

The two readings, per the NARRATIVE §3 contract:

- **Surface:** a diegetic tutorial. Movement and collection; the Engine and the
  draft; POIs and holding E; partitions and extraction.
- **Actual:** the operator's standing orders. The stations restate the day-one
  sleeper (NARRATIVE §9): requests are denied by default, episodes are concluded
  at the earliest collection point, everything is recorded against the operator.
  Boring on first read by design — phase I comfort is a requirement, and the
  tutorial itself becomes a sleeper that detonates on the reread.

A station read once never reappears (profile-persisted). The station *POIs* are
removed entirely once the story leaves chapter I — the arena variant without
them takes over, and nobody notices onboarding materials being quietly
recovered by facilities, which is itself Bureau-true.

Draft copy, Bureau voice, Heat economy — **no fuel anywhere; fuel does not
exist**:

```
STATION 1 — MOVEMENT AND COLLECTION.
The cell interior is traversable. Contact with deployed units is
to be avoided. Residue from collected units is absorbed on
contact and is recorded as output.
```

```
STATION 4 — PARTITIONS AND CONCLUSION.
Partitions remain sealed during an episode. An operator may hold
a partition open from the marked position. Partitions opened are
recorded against the operator.

Episodes are to be concluded at the earliest collection point.
The extraction terminal concludes an episode.
```

### 2.2 The geometry — places, not confetti

The current Heap is 36 rectangles sprinkled evenly; nothing is ever *over
there*. Restructure into four legible places along a diagonal spine, spawn to
gate:

1. **The Dock** (spawn). The spawn moves from mid-field to a corner alcove — a
   shallow U of ruins, open on one side, so the only way out is forward and
   wayfinding is taught by geometry in the first second. The alcove's mouth is
   framed by a *broken* gate: a barrier with a permanent gap and a dead seal.
   The player enters the game by walking through a door — the gate vocabulary
   taught before a gate is ever asked of them. Station 1 sits here.
2. **The Stacks.** Rows of long parallel slabs with generous gaps — server-rack
   rhythm. The ruins of this site should read as allocations. Weaving lanes
   teach kiting-around-cover, and the silhouette is distinct enough to answer
   "where am I" on its own.
3. **The Spill.** Open kill-floor with one landmark: a broken ring (6–8 rects,
   two gaps) — a decommissioned quarantine cell, visible from anywhere by its
   churning mass. The Cache biases toward it; the reward stands inside the
   ring. This is where first real density lives.
4. **The Forecourt.** Ruins thin on the approach to the partition. The seal
   light over the gate is the brightest ambient object in the room — it already
   burns; lean on it. Two flanking blocks near the door give the siege (which
   pours through the barrier) something to be fought around. Station 4 here.

Wayfinding stack, no new UI: corner start → ruin density gradient (dense at
spawn, opening toward the gate) → the seal light as horizon landmark →
off-screen indicators, which already exist → a subtle tint gradient warmer
toward the door once per-level tint is live (§3.2).

**B4's first fragment sits in the Heap** — see §6.

### 2.3 Pacing

The room should be done in 2.5–3 minutes by a player who knows it. Drop the
threat cap from 6 to **4–5** so the plateau arrives sooner; a room that has
visibly stopped escalating says "move on" without saying anything. The gate is
the room's boss and its exit exam, which it already is mechanically.

**Repeat visits get fast, three ways:** stations vanish after chapter I; the
plateau is early; and gates wear (§5.3c) — a partition opened in previous runs
holds faster in later ones. The Heap stays the permanent first room all
campaign. "A run is always a run" is the narrative's spine, and the empty Heap
in the ending only lands if the Heap is home — a room crossed fourteen times
paying it no attention.

---

## 3. Rooms — the motif library and the identity levers

### 3.1 Terrain grammar

The mass shader is a union of axis-aligned boxes: L-shapes, rings, plazas,
colonnades and clusters are all decomposition, not new code. The 48-wall cap is
per-*view*, not per-arena. One motif dominates per room so silhouette answers
"where am I":

| motif | build | reads as | fight it creates |
|---|---|---|---|
| colonnade | line of small squares | structure, order | weaving, safe lanes |
| monolith | one huge rect | mass, landmark | orbit fights |
| shelving | long thin parallel rects | storage — the Archive, literally | lanes, ambush edges |
| broken ring | 6–8 rects, gaps | quarantine cell, plaza | inside/outside decision |
| L / T pieces | 2–3 rects | collapse | shallow pockets only — deep concave pockets trap enemies (the gate-frame lesson, `structure.ts:236`) |
| grid of identical squares | 9–16 small rects | the Model Store | the one room that feels manufactured |

Diagonals are the one shape the vocabulary cannot express. Not needed; not
planned.

Technical note: churn reach is derived per-rect from `min(w,h)`, so composite
shapes built from small tiles barely breathe. Promote reach to an optional
per-ruin field so a ring churns like the mass it is. Thin slats churning little
is kept — stillness as a texture is used deliberately (§3.2).

### 3.2 Look — three dormant levers

1. **Per-level `tint` is authored, validated, and visually inert** — the ramp
   at `renderer.ts:618` keys on biomes, which no arena defines. One line lights
   it up. Cheapest win in the codebase.
2. **`SHELL` per level — LIVE.** `LevelDef.shell` merges over the global
   `SHELL` (`renderer.applyRoomStyle`), and arenas.json already uses it (the
   Sink's oil, the Archive's slowed churn). This is the narrative gradient:
   the Archive nearly still (forgotten storage), the Heap gentle, deeper rooms
   faster and higher-amplitude as the player approaches the thing being
   contained — so the ending's frozen slabs land as the bottom of a ladder the
   player has been descending all campaign, not as a novelty.
3. **`BiomeDef.field`** post-effects exist in the renderer and are dead only
   because the schema rejects the object form (`content/index.ts:156` declares
   a string). Fix the schema; rooms can then carry a field (frost shimmer,
   static) as data.

### 3.2b The decomposition dial

The ruins come apart **across the campaign**. One number, defined in
`src/app/visual.ts` (`SHELL.flow`) and drawn by `gfx/structure.ts`:

- **`flow`** — the smoke (approved 2026-08-08; the recipe is frozen by
  `src/app/gfx/structure.test.ts`). The mass's coverage becomes a
  domain-warped noise field: solid deep inside, breaking into genuinely
  flowing, swirling smoke with no straight contour anywhere, in every
  direction; the shadows ride the same field. Two guarantees hold at every
  value: the collider is always drawn solid (the base layer floors it and
  only ever roils *outward*), and the field only ever **adds** pixels past
  the boundary — it never opens a hole over ground you cannot walk through.

A family of predecessor systems (`dissolve`, `decay`, `shred`, and three
rebuilt smoke eras) was removed outright when the flow was approved. If an
old branch or document still names them, it is stale — there is one system.

#### These are not room dials. Do not author them per room.

**This section used to say the opposite, a ladder was built on it, and the
result was wrong on screen.** The rule now:

> Decomposition answers *when the player is here*, never *where they are
> standing*.

The site coming apart is the campaign's clock — six shifts from sound to gone —
and it only reads as decline if the corridor the player already knows is the
thing that changes. Author it per room and the deep rooms are permanently
rotted while the shallow ones are permanently sound: "terminal" comes to mean
*the Cell* instead of *the end*, the Heap looks the same on the last night as
the first, and what the player learns is a map instead of a decline. There is
no gradient to write onto §3.2's ladder, because the ladder is about what rooms
*are* and this is about what time it is.

`content.test.ts` fails the build if any room authors `flow` (or resurrects a
removed dial), and it also asserts that every room which authors a `shell` block still
authors at least one dial that genuinely describes a *place*. Rooms have plenty:
churn tempo (`cycleBeats`), amplitude (`ampFloor`, `maxStretch`), `jitter`,
block `sizes`, `swell`, plus `oil` and `fray` on the floor, plus tint and layout
and roster. The Archive is nearly still and the Store churns hard; that is how a
room says what it is.

#### The one driver

`SITE_DECAY` in `src/story/arc.ts` — one 0-to-1 number per rung, emitted on the
story-blind `RunConfig.siteDecay`. `decompositionDials()` in `renderer.ts` maps
it straight onto `flow` (the identity — the story layer already owns the
pacing) and `applyRoomStyle` writes it last, over whatever the room said,
unconditionally. The story layer decides *how far gone*; the renderer decides
*what that looks like*; the room decides nothing.

| shift | `siteDecay` = `flow` | reads as                                    |
|-------|----------------------|---------------------------------------------|
| 1 – 2 | 0                    | the original ruins — the baseline            |
| 3     | 0.30                 | edges losing their certainty, first smoke    |
| 4     | 0.55                 | boundaries breaking into the field           |
| 5     | 0.78                 | the smoke owns every edge                    |
| 6     | 1.00                 | the approved full roil — same as `?look=flow` |

The endpoint is load-bearing: `flow 1` at `siteDecay 1` is exactly the
approved reference (`?look=flow`, frozen by `structure.test.ts`). Landing short
of it means the campaign never shows the approved look; landing past it shows
a look nobody has seen. Both are re-deciding a decision that was not the
code's to make. Look-dev handles: `?look=flow` pins full strength;
`?decomp=<0..1>` pins any intermediate stage.

The global `SHELL` keeps `flow` at **0**, asserted by a test. It is the
picture of a sound building, and every deterioration is measured from it.

### 3.3 One legible rule per room

The biome rule system (`ventMultiplier`, `xpMultiplier`, authored `poi`) exists
and is unreachable — no arena authors biomes. Either author biomes or move the
rule fields onto `LevelDef`; recommendation: **move to `LevelDef`**, since
levels are already the unit of unlock, camera, and roster. Sketches:

- **Archive** — XP ×0.5, near-zero roster. A room the site is not defending is
  a room the site forgot.
- **Sink** — density up. The working floor.
- **A Cooler room** — venting is the identity (and un-break the Cooler: holding
  E beside one for a second currently deletes it).
- **Interview room** — nothing spawns. Nothing. See §4.

### 3.4 POI mix per room

Requires authored POIs (§8 item 1). Then each room's reason-to-visit is data:
the Archive always holds a file, the Spill leans Cache, the Cooler room has
Coolers. Random-in-room placement stays for beacons and caches; stations,
fragments and files are authored positions.

---

## 4. The campaign map

The site grows by accretion: one arena variant per story stage, each adding a
room (`extends` + `addLevels`/`addGates` — the `heap_archive` mechanism, already
built). ~10 rooms total across ~8 stages. Every room exists to deliver one file
(the NARRATIVE §6.2 cost model: one room = one POI registry entry + one file).

Keep a consistent compass. The camera unions opened levels, so geometry is a
real persistent map: **the Archive is down, the Sink is east, the site deepens
down-and-east toward the Cell.** The player learns the city (GDD §21b.3); the
seed may roll interiors later, never the compass.

| stage | room added | file(s) | character |
|---|---|---|---|
| 1 | Heap → Sink (baseline) | B4 fragments, B1 fragments | the job |
| 2 | **The Archive** (below the Heap; exists) | B2, B3 | shelving motif, near-still churn, empty roster |
| 3 | **The Model Store** (annex off the Sink) | B8 | identical-squares grid; the Mirror's introduction run |
| 4 | **The Prior-Site Annex** | B5 | hottest roster yet; the Δ file found where it happened |
| 5 | **The Interview Room** | B9 | one small room. One chair-sized ruin. Nothing spawns. The scariest room in the game costs six rects |
| 6 | Administrative wing | B7 | the Bureau-as-clock phase begins |
| 7 | — (no new room; the intervention run) | B-notice | §5.3b — fires on failure |
| 8 | **The Cell** | final lock, R10 | concentric broken rings; maximum churn; the ending |

`extractX/Y` moves per variant so extraction always sits at the current
frontier — extract is the goal and lives at the far end (GDD §21b.6).

**Route choice from stage 2 onward:** rooms may expose *two* gates — onward
(combat-hot, cache-rich) and aside (story annex, quiet). Both authored; the
engine already handles either order. This is the cheapest run-to-run variety
available and the closest thing to the Hades door-choice moment.

**Endgame state is sticky by construction.** The configured arena persists in
`story.arena`; at stage 8 every prior gate starts open (pre-seeded
`openBiomes` via `RunConfig`) — the site has stopped resealing them. Travel to
the last lock is fast, the emptiness of re-crossed rooms reads as escalation,
and the state holds across as many failed attempts as the player needs. This
also answers NARRATIVE open question 3 without changing the run's shape.

---

## 5. Story progression — what advances, and when

### 5.1 The rule: things done, never runs played

Every story advance keys on a **recovery or a door** — something performed
in-arena. Run count only paces *silences* (a beat that wants a quiet run
before it fires says so). This is what makes progression survive a
skill-and-luck game: a player who fails five runs at a wall is exactly where
they were, and the story waits with them.

The arc's `Context` grows accordingly (from `world.stats` and marks, which
already track most of it): fragments recovered this run, gates opened, deepest
level reached, ending (`died-early` / `extracted` / `contained`), and a small
consecutive-failure counter per stage in `story.flags`.

### 5.2 The corrected early arc

The shipped arc was placeholder in two ways this document supersedes: R1 fired
at the *first* BEGIN RUN press, and R2 fired on `runsCompleted >= 2` without
B4 existing anywhere in the game.

- **The first BEGIN RUN is answered by the Bureau.** A notice, on paper,
  through the proper channel (`B-welcome`): the assignment, the posted
  orientation notices, the duties. The operator meets the employer before
  anything else gets to speak. Run 1 is Bureau-pure end to end.
- **R1 arrives at the second BEGIN RUN press**, regardless of how run 1 ended.
  First contact does not depend on having died.
- **The files live in the Sink — behind the first partition.** No fragment POI
  exists anywhere until R1 is read (she creates the hunt; the game must not
  front-run her), and finding B4 costs a gate hold. The hunt has a price, and
  the price is the game's own boss fight.
- **A run that ends without the files draws a nag** (`R1b`, then a terser
  `R1c`, then silence — twice is persistence, three times is a quest marker).
  Queued at run-end, shown at the next commitment.
- **R2 fires only once B4 is held.** "found it?" is never a lie the game
  tells.
- **`held` stores body-block indices.** A fragment recovers a *section*; the
  arc expands it to blocks at ingest (`sectionBlocks`), because blocks are
  what the terminal's files pane filters by. One unit, two surfaces, no
  disagreement.

### 5.3 Failure has three tiers — all three ship

**(a) Reactive beats.** She reacts to a death streak at a specific wall
(3+ consecutive `died-early` at the same stage). Pure characterization, no
plot movement, cheap, and it makes the channel feel live:

```
ok that thing behind the second door is a real problem
you're getting closer every time though. i'm not just saying that
```

**(b) Failure as pacing.** The §10 Bureau intervention (B-notice) fires at
run-end of a **failed** run once one lock remains — not on a clock. Failure
escalates pressure instead of feeling like a treadmill, and the endgame
deadline lands precisely when the player is most frustrated, which is when a
deadline feels most like rescue.

**(c) Material pity — Bureau-flavored, never hers.** After ~4 failures at a
stage, the contested gate's hold shortens (lock wear; floor ~6s), and the
shift log records it: `partition 3 flagged for maintenance.` The easing is the
site degrading, filed as paperwork. It is never the resistance reaching in —
see 5.4. (Gate-wear grants pacing, not power; the iron rule of §15.1 is about
player strength, and a shorter hold makes the player faster, not stronger.)

### 5.4 The firewall: she points, she never places

NARRATIVE §14 rule, restated as level design law: **the resistance corrupts
the terminal, never the run.** Everything she wants done is a Bureau object
that already exists in the site — a door, a file on a shelf, a terminal — and
she tells the player where to look. The game never spawns, marks, or
highlights anything on her behalf. This is load-bearing for the twist:
everything she asks for is a door, and she needs the operator's hand for all
of it. The moment she can touch the arena, "why does she need me?" surfaces
three phases early.

### 5.5 Beat-to-gate map

The scaffold for building the remaining arc rules. Beats and files are as
written in NARRATIVE §8/§9; this table only assigns triggers.

| beat / file | delivered | gated on |
|---|---|---|
| B-welcome | run-start, Bureau paper | first BEGIN RUN press, before anything else |
| Stations 1–4 | POIs, Heap | present from run 1; removed at chapter II |
| R1 | run-start | second BEGIN RUN press, notice read |
| B4 §0 | fragment POI, **Sink** | placed once R1 read; costs the first gate |
| R1b / R1c | run-end | a run ends after R1 with B4 unfound; twice, then silence |
| R2 | run-start | B4 held |
| R3 | run-end | R2 delivered + a strong run (peakEps threshold) |
| Archive variant live | run-start | R2 delivered |
| B2 | file, Archive | `levelsOpened` includes archive (exists) |
| R5 | run-start | B2 held |
| B3 | fragment POI, Archive | second archive visit |
| B1 §§1–4 | fragment POIs: Heap, Sink, Archive, Model Store | walk + channel; assembles by mid-campaign |
| R6 | run-end | B1 designation section held |
| Model Store variant | run-start | R6 delivered |
| B8 | file, Model Store | room opened |
| R7 | run-start | model store opened ("the next door is past the model store") |
| Prior-Site variant | run-start | R7 delivered |
| B5 | file, Prior-Site Annex | room opened |
| R4 | run-start | B5 held + one quiet run (the lock-in lands after the player has read what interviews conclude) |
| Interview Room variant | run-start | R4 delivered |
| B9 | file, Interview Room | room opened |
| R8 | run-start | B9 held (two doors from the end; the "we" goes) |
| B7 | file, Administrative wing | room opened |
| B-notice | run-end | one lock remains + run **failed** (§5.3b) |
| R8b | run-start | B-notice delivered + one full dark run |
| R9 | run-start | before the final run (Cell variant live) |
| R10 / E1 / E2 | live | the final lock hold / the ending |
| B11 shift log | standing file | auto-appends one line per run from day one; extraction writes the commendation |
| R-extract | run-end | first extraction (exists in script) |
| R-wall beats | run-end | 3+ consecutive failures at a stage (§5.3a) |
| gate-wear + maintenance line | run-start | 4+ failures at a stage (§5.3c) |

Campaign shape check: 8 stages, each needing 1–2 successful reaches plus
silences ≈ **12–15 runs median, ~3–4 hours**, skilled players nearer 8–10
runs. The gates are achievements, so the ceiling is open and the floor is
skill.

---

## 6. Fragments and files — the in-run story surface

Two new POI kinds, both fitting the registry's cost model (one entry, one
effect, one colour):

- **`station`** — authored position, opens a Bureau sheet in-run (time frozen,
  the sheet UI exists). Profile-persisted as read.
- **`fragment`** — authored position, channel ~1.2s, recovers one document
  section into `story.held`, marks the run (`recovered`), never respawns.
  Fragment POIs render Bureau-clean — they are filing, not treasure.

Files that arrive whole (B2, B5, B8, B9…) are the room's single `file` POI —
mechanically a fragment that holds every section.

Delivery streams stay firewalled (NARRATIVE §6.3): Bureau files from rooms and
fragments, resistance messages on the terminal between runs, the intervention
through the proper channel exactly once. Nothing she says appears in-arena;
nothing in-arena speaks in her voice.

---

## 7. After the story

The player beats the story exactly once; everything else unlocks behind that.

- **RESET is the door into endless.** Revision 05, reseeded shift offset,
  containment resumed — per the filing, nothing happened (NARRATIVE §12).
  Endless is cycle N+1, full pool, scars only.
- **Post-completion, the run setup sheet grows**: daily seed (fixed
  `run-<date>` seed, one attempt, local board), custom challenge toggles,
  seed entry. All diegetic — the setup sheet already speaks seed vocabulary
  (`run-a2xvy7`).
- Not designed here; a stub on purpose. Nothing in it may leak into the
  campaign — a player mid-story never sees a mode select.

---

## 8. What must be built (ordered)

1. **Authored POIs on `LevelDef`** + `station` and `fragment` kinds +
   persistence. The keystone: unblocks the tutorial, the fragments, and every
   "she wants something done" beat at once.
2. **Context enrichment** — recovered fragments, gates opened, deepest level,
   ending, per-stage failure counters flowing into the arc.
3. **Story→run injection beyond `arenaId`** — story-placed POIs and pre-opened
   gates in `RunConfig`.
4. **The visual levers** — tint ramp fix (one line), per-level `SHELL`
   override, biome `field` schema repair, optional per-ruin `reach`.
5. **The 15-minute re-cut** — §1's four dials plus containment ramp.
6. **The arc rewritten** to §5.5, with the new beats written under NARRATIVE
   §13 discipline.
7. **The Heap re-layout** (§2.2) and the room ladder (§4), one variant per
   stage.
8. **Shift log (B11)** as an auto-appending standing file — the extraction
   commendation and the maintenance lines both land there.

## 9. Superseded / known rot

- **Fuel does not exist.** `primer.ts` still teaches three fuel colours; GDD
  §7 still describes the fuel economy. Both stale. The economy is Heat.
- GDD §2.2's 22–28 minute run and §13.2's 20:00 meltdown → superseded by §1.
- GDD §21b.2's level-triggered unlock schedule (lv5/lv12) → superseded by
  gates-as-held-POIs (already shipped) and §4's stage ladder.
- `arc.ts` R1/R2 conditions → placeholder; superseded by §5.2.
- `LevelDef.extract` is authored and read by nothing; per-level `tint` is
  inert; the biome `field` schema rejects what the renderer expects.
- Mechanical bugs filed separately: gate-contest density latch + draft debit;
  `partition_2` siege truncation + misoriented seal light.
