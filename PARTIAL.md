# PARTIAL — what is not finished

State of the `story-arc` branch as of 2026-08-08. STORY-AND-TONE.md is the spec;
this file is only the delta between it and the code. Everything not listed here is
built, green (262 tests, typecheck, lint) and verified — though see §7 for what
"verified" currently means.

---

## 1. What works now

**The six-run campaign** of §7 runs end to end. Rungs are gated on documents held
and doors opened, never on run count; `rungOf()` derives the rung and nothing
stores it. The arena chain grows a room at a time, run 4 finds the store partition
and its relay dead, run 5 revives the partition from inside, and run 6 loads the
Cell with no extraction terminal so opening `partition_4` concludes the run.

**The desk is the between-run surface**, replacing the terminal. Overlapping
windows on the `Win` chassis, a file explorer, a taskbar, and the shift clock —
one night, 22:10 onward, derived from the campaign rung. It does everything the
terminal did: `story.advance('run-start')` at the commitment point, the run *held*
until the channel has finished speaking, Bureau beats as document sheets and hers
as the typed `Transmission` with the tear shader behind it, calibration over the
top, and the player's phosphor on every surface.

`?shell=terminal` still reaches the old surface. It is kept deliberately as the
control: when something on the desk reads wrong, "did it read wrong before?" has
to stay answerable.

**One definition of the chrome.** `CHROME` and `drawPanel` live in `ui/window.ts`
and `Sheet` uses both, so a sheet is a window that cannot be dragged. Everything
in-run inherits the desk's frame.

**Saved stories from before this branch are discarded, not migrated.** The key is
`overclock.story.v2`. If a fresh account ever appears to start at rung 2 with no
welcome notice, that key is the first thing to bump.

---

## 2. Open bug — a hit sometimes releases far too many bolts

**Reported:** hitting one of the pink (void-hue) enemies sometimes releases a great
many bolts instead of the two or three the build should produce. **Not reproduced,
not explained.** Ruled out by reading the code:

- *Shield-blocked hits looping.* `drifter_shielded` and `mote_shielded` kill the
  projectile on a blocked hit, so there is no re-hit every frame while overlapping.
- *Events dispatching more than once per hit.* `emit` queues, `drainEvents` drains
  once per tick, and `dispatch` fires each live row at most once per event.
- *An affix spawning projectiles.* There are three — `volatile`, `anchored`,
  `phasing` — and none of them emit anything.

Two live suspicions, in order:

1. **Ricochet clears the hit list while still overlapping.** On a bounce
   `proj.hits = []` and the projectile has not moved, so next tick it can hit the
   same enemy again, spend another bounce and emit another On Hit. Bounded by the
   bounce count, so probably not "a TON" — but it is a real double-hit and should
   be fixed either way: exclude the enemy just hit from the cleared list.
2. **The Brood Drifter is the pink guy in question.** `drifter_brood` is void hue,
   visually a Drifter, substitutes for 28% of them from Threat 5, and splits into
   four Motes on death. Killing one inside a live bolt cloud puts four fresh
   targets exactly where the projectiles are, each emitting its own On Hit. That
   would be emergent rather than broken, and would explain "sometimes".

**How to continue.** Wrap `world.emit` to tally `hit` events per `targetId` per
tick and wrap `world.advance` to record per-tick growth of `world.projectiles`,
then play a real Threat-8 wave. If the worst hits-on-one-enemy-in-a-tick stays at
1, suspicion 1 is dead and suspicion 2 is the answer — which makes it a *design*
question rather than a fix.

---

## 3. The ending is not built

The `finale` rule flags `campaign.done`, sets chapter V and queues `E1`/`E2`, so
the Engine's six words arrive as two ordinary transmissions. Missing:

- **R10's lock lines delivered live during the final hold.** The copy exists and is
  asserted by a test; nothing plays it against `partition_4`'s hold progress.
- **The deconstruction.** `Grid.slip` exists and does exactly the one thing the
  ending needs — slides a bar off the words that were always underneath it — and
  has no caller. It was built for this.
- **RESET → wishlist.** §7.3 replaces the real RESET with a wishlist screen. No
  copy, no screen: `grep -i wishlist src/` returns nothing. `nextCycle()` and the
  revision counter are built and tested; only the screen is absent.
- **The backdrop slabs must stop.** Held in reserve on purpose — they drift in all
  five rooms and stop for the first time in the ending. Nothing stops them.

---

## 4. The visual descent — one room of five

§8 was re-decided on screen and §8.4 carries the rule learned the hard way:
**nothing is ever painted onto a block face.** Blocks are flat value with hard
borders, so a film over them reads as a stain. The mass's share of the descent is
its *outline*; colour and shimmer go on the floor, coming up through the seams.

Built: `uFray` (blocky beat-synced perturbation of the block SDF) and `uOil`
(thin-film interference on the floor), both as **world-space material zones** read
off each level's `shell` block — which is why crossing a gate no longer repaints
the room behind the player. Ramp is 140 units of outward bleed, 420 to full.

Not built:

- **Strength is unjudged.** The Sink sits at `oil: 0.16, fray: 0.08`; both want an
  eye on them in motion at play zoom.
- **The Archive, Store and Cell declare no material.** Their rungs on the §8.3
  ladder — held breath, the flies, the Nothing — are unimplemented. Churn tempo
  overrides are already authored in `arenas.json`; only the effects are missing.
- **`uSwarm` does not exist** (the Store's flies, clustering the silhouettes off the
  same cap-distance field the blocks use).
- **Grid slip and contortion do not exist** — Store blotches that appear and heal,
  Cell rows misaligning a pixel and healing.
- **Cell decomposition and the EPS coupling** — blocks coming apart into drifting
  particles, cells flickering out of membership, fuzz scaling with the player's own
  output.
- **Weather does not exist at all.** The forbidden frost/ember/static programs were
  removed and nothing replaced them, so the one permitted screen-space category is
  empty. It wants one sparse fullscreen pass.
- **The ramp may be wrong for the small rooms.** 420 units to full on a 1300-unit
  room only just reaches full in the middle band. Check when the deep rooms get
  their materials; consider a per-axis ramp.

---

## 5. The desk — phase two is absent

- **Her window.** `Win` already has the `foreign` mode for it — no form number,
  warm off-palette chrome, uncloseable while she types — and **nothing uses it**.
  The Bureau's own notice ("your terminal has recorded unsolicited text") is meant
  to read as the system complaining about that window.
- **After-run messages.** The report is still presented as a screen. It should be
  *filed* — a shift report landing in `OPERATOR/` — with one reactive message
  greeting the operator instead, keyed on facts about the run and drawn from small
  per-condition pools so it is never the same twice. `R-quiet`, `R-missed`,
  `R-door` and `B-lapse` are already this shape. The Bureau must stay unwarm: its
  lines are commendations that fail to comfort, and hers are the ones that land.
- **Window layout is not persisted.** Ids are stable so it could be keyed on them,
  but nothing saves it — and this is most of what would make the desk feel like
  *yours*. Cheapest remaining win.
- **No boot sequence.** Memory count, asset number, letterhead, login as the
  operator's number, faster on later boots. Nothing exists; the desk appears
  immediately. (A task list in an earlier session marked this done in error.)

---

## 6. In-run chrome — what is left

The HUD is migrated: `readouts.ts` produces `Line[]`, `bezel.ts` draws them on
`Grid`s inside a frame, and all nine DOM elements and 23 CSS blocks are gone.
Remaining:

- **TAB should be a zoom, not a surface change.** The bezel's engine panel already
  uses the same `chain()` the pipeline does, which was the groundwork. Making TAB
  scale that panel into the editor would mean the player learns one object.
- **The bottom log.** Heat, threat and chain depth have homes; the *prose* does not
  — beacon captures, gate openings, "Service Point — power restored". A log in the
  bottom strip is what a workstation would have, and it is where in-run story
  beats could land.
- **A chip's `×2` is a cost and reads as a count.** Split renders `Split ×2` from
  its `cycleMult` while its card says "Fires 3 copies". Render the cost as `2c` —
  the unit the rest of the sheet uses — or drop it from the chip.

---

## 7. What "verified" currently means — read this first

**The last several sessions of UI work were not seen by a human or by me.** The
Browser pane stopped compositing, and `requestAnimationFrame` does not fire in a
hidden pane, so the game's frame loop was not running at all: `uiTimer` sat at 0
forever. Everything was verified by measuring geometry and by driving paints by
hand, which proves wiring and cannot prove appearance.

Specifically unjudged by eye: the bezel's panel offsets (`col(28)` and `col(46)`
in `bezel.ts` are guesses and are the most likely thing to need moving), the recut
engine editor, and monochrome in-run.

**And a test that should exist and does not.** Four separate bugs this branch —
dead hit areas, icons over windows, the BEGIN CONTAINMENT button across its own
border, the pipeline's numbers walking onto its chips — were all one class:
*layout computed once at construction inside a container that later moves or
resizes*. The invariant is "after any resize, every control is inside its parent's
box", and nothing asserts it. Write that before adding more controls, especially on
the pipeline, which has more of them than the rest of the game combined.

One more habit worth keeping: commit `9fbe66b` did not build, because `display.ts`
and `calibrate.ts` were created after its `git add -A` and nothing checked. Check
`git status` *after* committing, not only before.

---

## 8. Running it

```bash
pnpm check
```

Checkpoints are complete `Story` literals rather than replays:

```bash
# fresh · tutored · contact · archive · deadgate · store · final
open "http://localhost:5173/?story=deadgate"
```

`?story=wipe` starts a clean account, `?story=cycle` runs the §12 cycle,
`?shell=terminal` reaches the old surface, and `?crt=0` strips the tube off — which
is how layout gets judged, since every glass pass takes light away and a legibility
problem and a brightness problem look identical through them. `__oc.story` exposes
the same functions the query parameter drives, and `__oc.desk.geometry()` reports
every window's rect and whether it fits.
