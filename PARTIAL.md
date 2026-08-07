# PARTIAL — what is not finished

State of the `story-arc` branch as of 2026-08-07. STORY-AND-TONE.md is the spec;
this file is only the delta between it and the code. Everything not listed here
is built, green (254 tests, typecheck, lint) and verified in the browser.

---

## 1. What the campaign can already do

The six-run ladder of §7 runs end to end. Verified by playing each rung through
`?story=<checkpoint>`:

- Rungs are hard-gated on documents held and doors opened, never on run count.
  `rungOf()` derives the rung; nothing stores it.
- Arena chain `heap → heap_archive → heap_store → heap_cell` resolves, one new
  room per active rung.
- Run 4 finds the store partition dead and the relay dead with it; run 5 has the
  relay live and reviving `partition_3` from inside works (confirmed: the marker
  reads "Service Point — power restored" and the dead flag clears).
- Run 6 loads `heap_cell` with no extraction terminal, the grown starter (4 rows,
  capacity 135), and opening `partition_4` concludes the run.
- Every document, notice and transmission in §9 is authored in `script.ts` and
  placed by `DOC_RUNG`.

**Saved stories from before this branch are discarded, not migrated.** The
storage key is `overclock.story.v2` — a v1 save names rules that no longer exist
and sets `tutorial.done` from a tutorial that worked differently, which read as
"rung 2 on a fresh account, no welcome notice". If that symptom ever reappears,
the key is the first thing to bump.

---

## 2. Open bug — a hit sometimes releases far too many bolts

**Reported:** hitting one of the pink (void-hue) enemies sometimes releases a
great many bolts instead of the two or three the build should produce.

**Not yet reproduced, and not yet explained.** What has been ruled out by reading
the code:

- *Shield-blocked hits looping.* `drifter_shielded` and `mote_shielded` kill the
  projectile on a blocked hit (`world.ts`, the `shieldArc` branch), so there is
  no re-hit every frame while overlapping.
- *Events dispatching more than once per hit.* `emit` queues and `drainEvents`
  drains once per tick, and `dispatch` fires each live row at most once per
  event. One hit is one On Hit.
- *An affix spawning projectiles.* There are exactly three affixes — `volatile`,
  `anchored`, `phasing` — and none of them emit anything.

Two live suspicions, in order:

1. **Ricochet clears the hit list while still overlapping.** On a bounce,
   `proj.hits = []` (`world.ts`, in the projectile/enemy collision) and the
   projectile has not moved, so the next tick it can hit the *same* enemy again,
   spend another bounce and emit another On Hit. Bounded by the bounce count, so
   this alone should not be "a TON" — but it is a real double-hit and worth
   fixing regardless: exclude the enemy just hit from the cleared list.
2. **The Brood Drifter is the pink guy in question.** `drifter_brood` is void
   hue, visually a Drifter, substitutes for 28% of Drifters from Threat 5, and
   splits into four Motes on death. Killing one inside a live bolt cloud puts
   four fresh targets exactly where the projectiles are, each hit emitting its
   own On Hit. That would be emergent rather than broken — but it would look
   *precisely* like the report, and it would explain "sometimes".

**How to continue.** An instrumentation harness was attached in the page and is
the right approach; it just needs a busier scene than the one it got. Wrap
`world.emit` to tally `hit` events per `targetId` per tick and wrap
`world.advance` to record the per-tick growth of `world.projectiles`, then
either play a real Threat-8 wave or spawn `drifter_brood` alongside `drifter`
and compare. If the worst hits-on-one-enemy-in-a-tick stays at 1, suspicion 1 is
dead and suspicion 2 is the answer — which makes it a *design* question (should
a brood death be that explosive) rather than a fix.

---

## 3. The ending is not built

`§11` of NARRATIVE and `§7.2` of STORY-AND-TONE describe the ending; the code
has a placeholder. The `finale` rule in `arc.ts` fires when the Cell opens,
flags `campaign.done`, sets chapter V and queues `E1`/`E2` — so the Engine's six
words arrive as two ordinary transmissions at the next terminal visit.

What is missing:

- **R10's lock lines delivered live during the final hold.** They exist in
  `script.ts` (ending on an em dash, cut off mid-word, asserted by a test) but
  nothing plays them against the gate hold. This needs the Cell's
  `partition_4` hold progress to drive beat delivery, which no surface does yet.
- **The deconstruction.** `Grid.slip` already exists and does exactly the one
  thing the ending needs — slides the bars off what they were covering, so the
  words underneath are simply there — and nothing drives it. This was built for
  the ending on purpose; it is waiting for a caller.
- **RESET → wishlist.** §7.3 cuts the real RESET and replaces it with a wishlist
  screen. There is no wishlist copy and no screen: grep finds no occurrence
  anywhere in `src`. `nextCycle()` and the revision counter are built and
  tested, so the mechanism exists; only the ending's own screen does not.
- **The backdrop slabs must stop.** Held in reserve deliberately — they drift in
  all five rooms and stop for the first time in the ending. No room may spend
  that early, and nothing stops them yet.

---

## 4. The visual descent — one room of five

§8 was re-decided on screen on 2026-08-07 and §8.4 now carries the rule that was
learned the hard way: **nothing is ever painted onto a block face.** The blocks
are flat value with hard borders; a film laid over them reads as a stain on a
shape no matter how it is tuned. So the mass's share of the descent is its
*outline*, and colour/shimmer/light go on the **floor**, coming up through the
seams.

Built and wired:

- `uFray` — blocky, beat-synced perturbation of the block SDF. Silhouettes
  crumble in square nibbles. Safe against "dilate, never erode" because the
  backing pass covers the collider whatever the drawn layers do.
- `uOil` — animated thin-film interference on the floor: drifting thickness
  field, travelling swell, weighted cold (green is what a blue-black floor lifts
  most readily, and at equal weight the room goes swamp).
- **Material zones.** Both are world-space regions, not room style —
  `setMaterialZones` reads every level's `shell` block once per run and the
  shader resolves per pixel. This is why stepping through a gate no longer
  repaints the room behind the player. Ramp is 140 units of outward bleed and
  420 units to full strength.

Not built:

- **Strength is unjudged.** The Sink sits at `oil: 0.16, fray: 0.08` and both
  numbers want an eye on them, in motion, at play zoom.
- **The Archive, the Store and the Cell declare no material.** Their rungs on
  the §8.3 ladder — held breath, the flies, the Nothing — are unimplemented.
  Churn tempo overrides for the Archive and the deep rooms are already authored
  in `arenas.json`; only the new effects are missing.
- **`uSwarm` does not exist.** The Store's flies. It should sample the same
  cap-distance field the blocks use, so particles cluster the silhouettes for
  free, and stay *beside* the mass rather than on it.
- **Grid slip and contortion do not exist.** Floor-branch uniforms for the Store
  (blotches of contortion that appear and heal — a new distortion, not Pull's)
  and the Cell (rows misaligning a pixel or two and healing).
- **Cell decomposition and the EPS coupling.** Blocks coming apart into drifting
  particles, cells flickering out of membership and back, the fuzz scaling with
  proximity to the last lock and with the player's own EPS.
- **Weather does not exist at all.** The forbidden frost/ember/static field
  programs were removed and nothing replaced them, so the one permitted
  screen-space category is currently empty. It wants one sparse fullscreen pass:
  dust falling in the Sink, the same dust suspended in the Archive.
- **The ramp may be wrong for the small rooms.** 420 units to full strength on a
  1300-unit-tall room means it only just reaches full in the middle band. Fine
  for the Sink (3600 square); check it when the deep rooms get their materials,
  and consider a per-axis ramp.

---

## 5. Smaller open items

- **A chip's `×2` is a cost, and reads as a count.** On a pipeline chip, Split
  renders as `Split ×2` from its `cycleMult`, while the card for the same node
  says "Fires 3 copies". Two different numbers in the same shape. Render the
  cost as `2c` — the unit the rest of the sheet already uses — or drop it from
  the chip entirely.
- **The determinism pins move when behaviour does.** `calledWaves` is pinned at
  `ec8d59f3` with a dated note. Any deliberate change to spawning re-pins, and
  the note explaining why is not optional.
- **Recompile has no story on it.** The code stays and works; §7.3 cuts it from
  the campaign. Nothing is broken, but the report still mentions kernel
  potential, which is a mechanic the six runs never teach.

---

## 6. Running it

```bash
pnpm check
```

Checkpoints, which are complete `Story` literals rather than replays:

```bash
# fresh · tutored · contact · archive · deadgate · store · final
open "http://localhost:5173/?seed=x&axiom=ignition&start=1&sandbox&story=deadgate"
```

`?story=wipe` starts a clean account; `?story=cycle` runs the §12 cycle.
`__oc.story` exposes the same functions the query parameter drives.
