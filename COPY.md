# COPY — every string in the game, graded

Read against `NARRATIVE.md` §13 (writing rules), §14 (surface → narrative load) and
§15 (canon). Nothing here is changed yet. This is the audit.

---

## The test

§13 is nine rules. Four of them are checkable line by line, so those are what I
graded against. A line fails if the answer to any of these is yes:

| # | Question | Rule |
|---|---|---|
| **T1** | Is this a **fourth voice**? Not Bureau, not resistance, not the Engine — a designer talking to a player. Tells: `you`/`your` as the subject, "watch the", "in this game", "hard mode". | §13.5 |
| **T2** | Is it an **aphorism** — a general truth stated for effect rather than a fact recorded? Tell: it would fit on a poster. Or an adjective doing mood work. | §13.9 |
| **T3** | Does it serve the **player's score** rather than the Bureau's purpose? The Bureau wants short episodes and denied requests. It does not coach you to maximise output. | §13.1, §15 |
| **T4** | Does it **wink** — a joke the writer knows is a joke? | §13.6 |

A fifth, not from §13 but found while reading: **T5 — is it true?** Three
achievements describe conditions that are not the conditions being checked, and
two describe systems that no longer exist.

---

## Scorecard

| Surface | Strings | Grade | One-line verdict |
|---|---|---|---|
| Enemy records (`enemies.json`) | 18 | **A−** | The best-written body in the game. Two imperatives to fix. |
| Shell documents (`panes.ts`) | ~60 lines | **A−** | Onboarding is correct Bureau. Two labels are still casual. |
| Node descriptions (`triggers/modifiers/actions`) | 58 | **B** | Clinical and factual, but second-person throughout and three lines coach. |
| Achievement conditions (`hint`) | 32 | **B−** | Clear and useful. Three are factually wrong. |
| Axiom descriptions | 3 | **C** | One says "Hard mode." |
| Results screen | ~20 | **C** | `GARBAGE COLLECTED` is a joke; §14 says this screen stamps the truth. |
| HUD / overlays | ~25 | **C+** | Functional labels, some coaching in the tooltips. |
| **Achievement lessons (`teaches`)** | 32 | **D** | Near-total aphorism. The single worst body of text here. |
| **In-run primer (`primer.ts`)** | ~40 | **F** | A second copy of onboarding, in a voice the document does not have. |

---

## 1. Enemy records — **A−**

18 of 18 pass T1, T2, T4. They record what a unit does and stop. `Charger`'s
"The pause before the run is deliberate and is not a fault" is the model: it
answers a question the player will have, in the register of a maintenance note.

Two fail **T3** — they instruct the operator on how to beat the site's own
containment machinery, which is not something a Bureau file would help with.
Note that `Bulwark` already states the identical fact *without* the imperative,
so the fix is to match the entry that got it right.

| Where | Now | Proposed |
|---|---|---|
| Plated Drifter | "Standard chassis with frontal plating fitted. **Flank it, or use effects that do not travel.**" | "…fitted. Ineffective against fire arriving from the flank, and against effects that do not travel." |
| Charged Mote | "Baseline unit carrying an unstable charge. Detonates on destruction. **Engage at distance.**" | "…Detonates on destruction, at a radius exceeding its contact range." |

---

## 2. Shell documents — **A−**

`OPERATOR ONBOARDING` is the strongest thing in the project. "Duties per shift:
observe the episode and record output" does §7 and §14 in nine words, and the
heat ladder is explained as a fact about the machine rather than as advice.

| Where | Now | Fails | Proposed |
|---|---|---|---|
| Files index intro | "Select a file to open it. Entries below scroll on the wheel." | T1 — instructions to a user, not to an operator | "Files held at this terminal. Contents are current to the revision shown." |
| Achievements list header | "still out there  N/32" (results) / list label | T1, T2 | "not yet recorded  N/32" |
| Assets intro | "Site machinery. Assets engage the Engine on contact and are expended doing so. Losses are expected and replaced." | passes | — |

---

## 3. Node descriptions — **B**

58 strings. Most are already right: *"Fires every 1.2s. x12 output."* is a fact,
stated. The systematic issue is **T1** — `you`/`your` appears in **13 of 58**
(On Hit, On Kill, On Pickup, On Crit, On Dash, On Wound, On Depth, On Sweep,
On Enter, Leech, Mine, Orbital, Surge), and §13.5 says the Bureau addresses the
operator only as a role.

**This one is a genuine trade-off and I am not going to decide it alone.** These
strings render on draft cards mid-run, read under two seconds of time pressure.
"You heal 3% of the damage this row deals" is 3 characters where "the operator
recovers" is 12, and §13.7 makes the surface reading a *design requirement*, not
a nicety. Three options:

- **(a) Leave `you`.** The card is the Engine's request rendered on the operator's
  terminal; addressing the reader is defensible. Costs nothing. Weakest by §13.5.
- **(b) Cut the subject.** "Heals 3% of the damage this row deals." Shorter than
  the original, no pronoun, no rewrite of meaning. **My recommendation** — it
  passes T1 and *gains* clarity.
- **(c) Full third person.** "The operator recovers 3%…" Strictly correct, worst
  to read at speed.

Regardless of that choice, these fail on their own:

| Node | Now | Fails | Proposed |
|---|---|---|---|
| Echo | "Repeats everything to its LEFT once, 0.2s later, at 70% output. **Put it last for the strongest copy.**" | T3 — coaching for output | Delete the last sentence. The first states the fact; the placement follows from it. |
| Pull | "…Almost no damage — **it exists to group them.**" | T1 — authorial intent | "…Damage is negligible; the displacement is the effect." |
| On Idle | "…**A metronome that only runs when the rest of the row is idle.**" | T2 — metaphor as mood | "…Suppressed for as long as any other node in the row is firing." |
| Feedback (axiom) | "…capacity −20. **Hard mode.**" | T1, T4 — designer speaking, and winking | "…capacity −20. Issued to operators with prior episodes on file." |

---

## 4. Achievement lessons (`teaches`) — **D**

32 strings. **22 fail mechanically** — second person, a fourth-wall reference, or
the X-is-not-Y construction. Reading the other 10 by hand, **only 2 are actually
clean**: `Double or Nothing` and `Wide Load`. So the real figure is 30 of 32.

This is a body of text written to sound quotable. §13.9 bans exactly this:
*aphorisms, poetry, half-sentence fragments doing mood work.* Several also break
the fourth wall outright.

The shape of the failure is consistent — an X-is-not-Y construction, then a
sentence of philosophy:

| Achievement | Now | Fails | Proposed |
|---|---|---|---|
| Chain Reaction | "A Trigger that fires on your own output makes a loop. **That is the whole game.**" | T1, T2, T4 | "A trigger that fires on the Engine's own output forms a loop. Recorded as a cascade." |
| Contained | "**There is no winning. There is only how far you took it.**" | T2, T4 — villain monologue | "Episodes are concluded, not won. Divergence is recorded in seconds." |
| Beacon Runner | "Standing still is the price. **Everything good in this game costs position.**" | T1, T2 — "in this game" | "Channelling requires the operator to hold position for the duration." |
| Deep End | "…a build that runs deep and cold **has solved the game's central tension.**" | T1, T2, T4 | "Depth is the primary heat source. Depth without overheat is recorded separately." |
| Bloodletting | "Health is convertible. **The engine does not care whether you survive it.**" | T2 — characterises | "Integrity is a convertible resource. Conversion does not check the reserve." |
| Surfing | "**Instability is a place to live, not a doorway.** Running hot is a strategy." | T2 ×2 | "The Engine remains operable throughout tier I. No automatic correction occurs." |
| Reflection | "**A full Engine is a shape, not a list** — rows that feed each other beat rows that each do their own thing." | T2 | "Rows that satisfy each other's triggers produce more than the same rows in isolation." |
| Magnetised | "A Magnet is not loot, **it is a decision about where you are standing when you take it.**" | T1, T2 | "Collection requires the operator to move to the shard. Position is not chosen freely." |
| Untouchable | "Integrity is a resource you spend, not a bar you protect. **But you can refuse.**" | T1, T2 | "Integrity is expendable by design. Episodes completed without expenditure are noted." |
| Swarmed | "**The director never stops.** Clearing the screen is not the win condition." | T1 — names the spawn system | "Deployment continues regardless of asset count on the floor." |
| Prestige | "Burning a working Engine buys a permanent multiplier. **Timing is the skill.**" | T1, T2 | "Recompilation destroys the current build and returns a permanent multiplier." |

The rest fail the same way and need the same treatment. Some near-misses worth
naming, because they read as clean until you check them:

| Achievement | Now | Why it still fails |
|---|---|---|
| Flank It | "**The shield arc is drawn for a reason.** Positioning beats raw output." | "drawn" is about the *renderer*, not the unit — T1/T4. Second half is coaching — T3. |
| Swarmed | "**The director never stops.** Clearing the screen is not the win condition." | Names the spawn director, a designer term the fiction has no word for. |
| Controlled Burn | "**The penalty system** is a trigger. Weaponising it **is intended**." | "penalty system" and "is intended" are the designer stating design intent. |
| Overtuned | "A **carry row** is efficient and fragile. **Pressure systems** attack the build." | Player jargon and designer jargon in one line. |
| Prestige | "…a permanent multiplier. **Timing is the skill.**" | Aphorism. |

Leave alone: **Double or Nothing** ("Every 30s of divergence is worth more than
the minute before it") and **Wide Load** ("Every live row reserves Cycles forever,
whether it fires or not"). Both state a mechanic and stop, which is the target.

---

## 5. In-run primer — **F**

`src/app/primer.ts` is ~40 strings of tutorial prose reachable from `H` in a run
and from a **HOW IT WORKS** tab in the menu. It is the only text in the game with
no voice assignment at all, and it fails T1 in almost every sentence:

> "Your build is a program… drag them and watch the numbers change"
> "Build a machine that does more things."
> "Nothing stops you firing — the engine just gets unstable."

The problem is worse than register. **It is a second copy of `OPERATOR
ONBOARDING`** — the same rows/cycles/heat/cascade material, written twice, in two
voices, that can now drift apart. The onboarding file already says this correctly:

> "Heat does not stop it firing. Past 40 the Engine misfires at intervals; past 70
> some of its output turns on the floor; at 100 it stalls for three seconds and vents."

**Recommendation: delete `primer.ts` and point `H` and the menu tab at OC-0001.**
One source, already in voice, already tested. The sections the primer has that
onboarding lacks (fuel colours, the row readout, EPS) get added to OC-0001 as
further numbered notes.

---

## 6. Results screen — **C**

§14 assigns this surface a specific job: *"Stamps CONTAINED after every meltdown
death, from run 1. The truth, filed where nobody reads it."*

| Where | Now | Fails | Proposed |
|---|---|---|---|
| Death headline | `GARBAGE COLLECTED` | T1, T4 — a programmer joke, and the one surface §14 says must be plain | `EPISODE CONCLUDED — output recorded` |
| Discoveries header | "still out there" | T1 | "not yet recorded" |
| Post-mortem labels | "killed by", "damage taken, by source" | pass | — |
| `CONTAINED — after Ns of divergence` | pass — this is exactly §14 | | — |

---

## 7. Structural findings — not voice, but found while reading

These are bugs, not style. They fail **T5**.

### 7.1 Two pairs of achievements are the same achievement

```
full_tanks  (Cold Depths)  →  maxDepth >= 8 && overheats === 0
deep_end    (Deep End)     →  maxDepth >= 8 && overheats === 0     ← identical

wide_load   (Wide Load)    →  live programs >= 5
reflection  (Reflection)   →  live programs >= 5                    ← identical
```

Both pairs unlock at the same instant, every time, forever. Their hints are the
same sentence written twice ("Reach cascade depth 8 without a single Overheat" /
"…without overheating"; "Run 5 live Programs at once" / "Run five live Programs
at once"). Four entries should be two.

### 7.2 Three hints describe the wrong condition

| Entry | Hint says | Code actually checks |
|---|---|---|
| **Blackout** | "Kill a Suppressor while standing inside its zone" | `suppressedKills > 0` — kill *anything* while suppressed |
| **Cold Depths** | "Reach cascade depth 8 without a single Overheat" | correct, but see 7.1 — it is `deep_end` twice |
| **Red Line** | "Sit above 60 Heat while running a chain 6 deep" | correct |

Blackout's hint is Trespass's condition. §13.1 — the Bureau never lies — and more
practically, a player chases a condition that is not the one being tested.

### 7.3 Two lessons describe systems that no longer exist

`src/sim/discoveries.ts:61` says it plainly: *"Fuel is gone; these two now measure
the thing that replaced it."* The copy was never updated.

- **Cold Depths** teaches "A full gauge is **fuel** nothing you own can spend.
  Diversify or convert." — fuel is removed.
- **Red Line** teaches "Overusing one hue taxes it. **The world adapts to your
  build.**" — adaptive resistance is retired (`renderer.ts:1807` records this).

### 7.4 Achievement ids and names have diverged

`Bottomless` has id `deep_six`; `Depth Six` has id `depth_six`; `Cold Depths` has
id `full_tanks`; `Red Line` has id `siphoned`. Not player-facing, but the next
person to read a save file or a telemetry doc will match the wrong pair.

---

## 8. What I would do first

1. **7.1–7.3 before any prose.** Four achievements that are two, one hint that is
   false, two lessons about deleted systems. These are wrong, not just off-voice.
2. **Delete `primer.ts`** and route `H` to OC-0001. Removes ~40 strings in the
   wrong voice and one duplicate source of truth in a single change.
3. **Rewrite 30 of the 32 `teaches` lines.** Biggest single quality win,
   self-contained, no code changes.
4. **The `you` decision on node cards** — (b), cut the subject, unless you want
   otherwise. Mechanical, 13 strings.
5. **The four one-line fixes**: Echo, Pull, On Idle, Feedback's "Hard mode."
