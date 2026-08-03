# OVERCLOCK — Game Design Document

**Version 1.0 — Design lock for v1 build**
**Working title:** OVERCLOCK (subject to change; do not hardcode)
**Platform:** Desktop browser, WebGL, 2D
**Genre:** Bullet-heaven / build-crafting roguelite ("survivors-like" structurally, autobattler-engine in spirit)

---

## 0. How to read this document

This is a design specification, not a technical specification. It defines **what** the game is and **how it must behave and feel**. Implementation architecture, data formats, rendering pipeline, and code structure are the development team's domain — with one constraint: all game content (nodes, enemies, waves, axioms) must be expressible as declarative, validated data artifacts executed by a deterministic runtime. Content is data; the engine is dumb.

Numbers marked **[T]** are tunable starting values, not sacred. Numbers without the tag are design-load-bearing and require a design conversation before changing.

Sections map to buildable systems. Section 25 lists deliberately open decisions — do not resolve them silently.

---

## 1. Vision

### 1.1 One-liner

You are an engineer inside a hostile runtime, wiring an exponential damage engine out of composable effect nodes — while the runtime itself escalates to contain you. The game ends when your engine's output melts the world.

### 1.2 The player fantasy

**Engineer, not survivor.** Vampire Survivors sells "I survived the horde." OVERCLOCK sells "I built a doomsday machine and the system tried to stop me." Every mechanic serves that fantasy: the build is a visible, orderable program; power is discovered through combination, not unlocked from a table; the endgame is deliberately pushing your own engine past containment.

### 1.3 Design pillars

Every feature decision is tested against these four, in priority order:

1. **Breaks are found, not authored.** Power combos emerge from a composable grammar. We never ship a "correct" build. If players find a degenerate exponential engine, that is the product working. We only intervene against *tension breaks* (see 23.1).
2. **Legibility at maximum chaos.** At 3,000 entities, the player must still instantly locate themselves, read threats, and understand why their build is doing what it's doing. Visual grammar (16) and the visible pipeline (5) exist for this.
3. **A decision every ~30 seconds.** The draft cadence never stalls. No screen interrupts the run for longer than a draft pick. Depth lives in the pipeline editor, which is optional and player-initiated.
4. **The frame is diegetic.** UI, arena, and effects share one visual language. Overload degrades the render itself. Nothing is decoration; everything on screen is game state.

### 1.4 Reference map — what we take, what we reject

| Game | Take | Reject |
|---|---|---|
| Vampire Survivors | Decision cadence, gem consolidation, auto-fire movement-only combat, "unbalance is fun" | Authored evolution lookup table, invisible damage math, DLC-treadmill content model |
| Balatro | Legible score equation, left-to-right ordering as build axis, retriggers, narrowing (deletion) as power | Turn-based structure |
| Risk of Rain | Time-as-difficulty with player-controlled pacing | Loot opacity |
| Noita | Composable effect grammar, emergent physics of builds | Simulation-first scope |
| Incremental games (prestige) | Mid-run collapse-and-rebuild rhythm | Idle non-decisions |
| Megabonk / genre clones | Proof the market wants more | Load-bearing meta stat grind |

---

## 2. Game structure

### 2.1 Run flow

```
Main Menu
  └─ Run Setup (pick Axiom, Arena, optional Challenge toggles)
       └─ RUN (real-time, single continuous arena)
            ├─ minute 0–20: Build phase. Waves escalate with Threat.
            │    ├─ Level-ups → Draft (every ~30–45s)
            │    ├─ Wave Beacons (optional: call waves early)
            │    ├─ Recompile terminals (from min 8) — prestige
            │    └─ Extract terminal (from min 15) — bank score, end run safely
            └─ minute 20: MELTDOWN begins automatically
                 └─ Containment escalates without limit. Score multiplier climbs.
                    Death is inevitable and is the intended ending.
       └─ Results screen (run trace, score, discoveries)
            └─ Library updates (new nodes/axioms/codex entries persist)
```

A run has three endings: **death before min 20** (failure — reduced score), **extraction** (banked, safe, capped score), **death in Meltdown** (the real ending — uncapped score). There is no "you win" screen. Surviving is not the goal; peak output is.

### 2.2 Session targets

- Full run to Meltdown death: **22–28 minutes** [T]
- Failed early run: 5–12 minutes
- First-time player reaches first Recompile: within run 3
- First-time player reaches Meltdown: within run 5

---

## 3. Core loop

**Second-to-second:** move (dodge, route, herd enemies), collect fuel + XP, watch the engine fire. The player never aims and never presses an attack button. Movement and one dash are the entire physical verb set.

**Half-minute-to-half-minute:** level up → draft a node → engine changes behavior *visibly and immediately*. Occasionally: open pipeline editor to reorder/scrap, activate a beacon, make a fuel-conversion call.

**Run-to-run arc:** draft toward a loop → loop goes critical → Recompile into a steeper loop → push output past containment → die gloriously → bank discoveries into the Library → start with more grammar next run.

The emotional beat we are engineering: the moment a build "goes critical" — when a cascade becomes self-sustaining and the screen visibly changes character. Every run should have at least one; a great run has three (one per Recompile).

---

## 4. Player avatar & controls

### 4.1 The avatar

A pure-white geometric figure (see 16.4) — the only full-brightness object in the game. Stats:

- **Integrity (HP):** 100 base [T]. Contact damage from enemies. No regeneration by default (nodes can add it).
- **Move speed:** tuned so crossing the screen takes ~2.5s [T].
- **Dash:** 150ms, ~3× move speed, 150ms i-frames, 3s cooldown [T]. Dash is also a trigger source (On Dash), making mobility a build axis.
- **Collect radius:** base pickup magnet ~1.5× avatar diameter [T], upgradeable.

Death: Integrity hits 0 → the avatar is garbage-collected (decomposes, see 17.2) → Results.

### 4.2 Controls (desktop)

| Input | Action |
|---|---|
| WASD / arrows / left stick | Move |
| Space / RB | Dash |
| Tab / Y | Open pipeline editor (freezes time) |
| E / A | Interact (beacons, terminals) — hold-to-channel |
| Esc / Start | Pause |
| Mouse | Menus, editor, draft only. Never used in combat. |

Full rebinding required (20.5). No manual aim exists anywhere; do not add one.

---

## 5. The Engine — effect grammar

This is the game. Everything else supports this section.

### 5.1 Programs

The player's build ("the Engine") is an **ordered list of Programs**. A Program is:

```
[ TRIGGER ] → [ MODIFIER slot ] → [ MODIFIER slot ] → [ MODIFIER slot ] → [ ACTION ]
```

- Start with **4 Program slots**, expandable to **8** [T] via drafts.
- A Program needs a Trigger and an Action to be live; Modifier slots may be empty.
- Modifiers apply **in order, left to right**. Order changes outcomes (e.g., Split→Amplify ≠ Amplify→Split; see 5.5).
- Programs evaluate **top to bottom** within a tick. Program order matters for nodes that reference adjacency (5.6).

### 5.2 Events and cascades

Everything the engine does is an **event**. Triggers listen for events; Actions emit new ones (a Bolt hitting something emits On Hit; a kill emits On Kill — which other Programs may be listening for). This is how loops form, and loops are the point:

> On Kill → Split → Bolt … each bolt kills → emits On Kill → more bolts.

Rules of cascade physics:

- Every event carries **cascade depth**. Child events inherit depth+1.
- Processing any event costs **Cycles** (Section 6). Running out of Cycles doesn't stop the engine — it Overclocks it (heat, instability).
- Hard safety cap at depth **12** [T] — events beyond it are dropped silently. This cap should be high enough that players hit the Cycle economy long before the wall. The wall exists for the runtime's safety, not for balance.

### 5.3 Trigger nodes (v1: 10)

| Node | Fires when | Cycle cost/event [T] | Notes |
|---|---|---|---|
| Clock | Every N seconds (base 1.2s) | 1 | The bread-and-butter starter trigger |
| On Hit | Any of your effects damages an enemy | 1 | High-frequency; core loop fuel |
| On Kill | Any enemy dies to your effects | 1 | The classic cascade seed |
| On Crit | A hit crits (base crit 5% [T]) | 1 | Scales with crit investment |
| On Pickup | You collect fuel or XP | 1 | Turns movement into firepower |
| On Dash | You dash | 2 | Mobility builds |
| On Wound | You take damage | 2 | Masochist builds; pairs with Leech |
| On Wave | A wave spawns | 3 | Burst archetype |
| On Overheat | Heat crosses a threshold tier | 3 | Weaponizes the penalty system — intended |
| On Convert | A fuel conversion resolves | 2 | Economy-engine builds |

### 5.4 Action nodes (v1: 14)

Every Action has a **hue affinity** (Thermal / Voltaic / Void — Section 7) that determines its fuel consumption and its damage type for resistance purposes.

| Node | Hue | Effect | Cycle cost/fire [T] |
|---|---|---|---|
| Bolt | Thermal | Single projectile at nearest enemy | 2 |
| Nova | Thermal | Radial burst around avatar | 4 |
| Mine | Thermal | Proximity charge dropped at avatar position | 3 |
| Rupture | Thermal | Delayed explosion at target's position | 4 |
| Arc | Voltaic | Chain lightning, jumps up to 3 targets base | 3 |
| Beam | Voltaic | Instant line to farthest enemy in range | 4 |
| Orbital | Voltaic | Adds one orbiting body (persistent; stacks) | 5 |
| Surge | Voltaic | Short self-buff: +40% engine rate 2s | 4 |
| Field | Void | Persistent damage zone at random enemy cluster | 5 |
| Pull | Void | Vortex: drags enemies toward a point | 4 |
| Shove | Void | Radial knockback (see tension-break guard, 23.1) | 3 |
| Fragment | Void | Summons a short-lived autonomous mote that seeks and detonates | 4 |
| Convert | — | Exchanges resources per its configuration (7.4) | 2 |
| Siphon | — | Steals 1 fuel of target's hue on hit | 2 |

### 5.5 Modifier nodes (v1: 14)

Modifiers transform the Action (or the event stream reaching it). **Order matters** — the canonical example, required to work exactly this way:

- `Split → Amplify → Bolt`: split the fire event into 3, then amplify each → 3 bolts × 1.5 dmg.
- `Amplify → Split → Bolt`: amplify once, then split the amplified event → 3 bolts × 1.5 dmg **but** Split's per-copy damage penalty applies after Amplify's flat bonus, yielding a different number. Damage math must compose sequentially through the modifier chain, visible in the editor's live cost/output readout (19.6).

| Node | Effect | Cycle cost mult [T] |
|---|---|---|
| Split | ×3 copies, each −35% output | ×2.0 |
| Amplify | +50% output | ×1.3 |
| Accelerate | −30% trigger interval / +30% proc rate | ×1.4 |
| Enlarge | +60% area/size | ×1.3 |
| Pierce | Projectiles pass through +2 enemies | ×1.2 |
| Ricochet | Projectiles bounce once to a new target | ×1.3 |
| **Echo** | Repeats the Action once, 0.2s later, at 70% output | ×1.8 |
| Focus | Merge multi-hit into one: −count, +120% output | ×1.1 |
| Sustain | +80% duration (fields, orbitals, buffs) | ×1.3 |
| Leech | 3% of damage returns as Integrity | ×1.4 |
| Volatile | Effect detonates at end of life for 50% output | ×1.4 |
| Quantize | Snaps all fires to the audio grid (18.2); +25% output when on-beat | ×1.2 |
| Attune | Action's hue affinity shifts to your fullest fuel gauge | ×1.2 |
| Overdrive | +100% output; every fire adds Heat directly | ×1.0 |

**Echo is deliberately the strongest modifier in the game.** Echo stacking (multiple Echoes in one Program, or Echo interacting with On Hit loops) is the intended discovery path to exponential output. Do not nerf Echo; price it in Cycles.

### 5.6 Topology nodes and adjacency

Two v1 nodes make **program order** (not just modifier order) a build axis:

- **Resonate** (Modifier): this Program also fires whenever the Program *directly above it* fires. ×1.5 cycle mult.
- **Ground** (Modifier): the Program above it costs −30% Cycles, but this Program's output −20%.

These create Balatro-style topology puzzles: a Resonate column is an exponential ladder; reordering in the editor is a real decision.

### 5.7 Narrowing — Scrap

From the pipeline editor, any node or whole Program can be **Scrapped**:

- Refunds its reserved Cycles immediately.
- Grants **+4% [T] permanent global output** for the rest of the run, stacking additively per scrap.
- Scrapped nodes are gone (not returned to the draft pool).

Design intent: a lean 3-program engine that always fires must beat an 8-program pile that starves. Scrapping is the expert move and the game must whisper this (a Discovery fires the first time a player scraps, 15.3).

---

## 6. Cycles, Heat & Overclock

The budget system. This is what makes "breaking the game" a skill instead of a lookup.

> **AMENDED — see DECISIONS D-106.** The per-event Cycle budget described below is
> gone, and so is the overdraw path into Heat. Measured on a recorded run, the
> dynamic budget was inert for 89% of the game and then went from full headroom
> to nothing in ten seconds; that shape is structural, not a tuning problem, and
> no readout could fix it.
>
> What replaced it:
> - **Cycles are a static reservation only.** Every live node costs, capacity
>   limits what fits, and the number moves only when the *build* moves.
> - **Heat comes from cascade depth.** The first three links are free; past that
>   every event charges in proportion to how deep it is. Heat now has a cause you
>   can see on screen, and it rises and falls as you lean in and back off.
>
> §6.1's regen, §6.2's deficit-to-Heat and the misfire-on-overdraw rule are all
> superseded. Instability tiers, the Overheat stall and Overdrive are unchanged.

### 6.1 Cycles

- **Capacity:** base 100 [T], raised by draft upgrades and Recompile bonuses. Displayed as a ring around the avatar (19.5).
- **Static load:** each live Program reserves Cycles equal to the sum of its node costs. Static load can never exceed capacity — the editor blocks it.
- **Dynamic load:** every event processed costs Cycles from the *remaining* headroom, regenerating at **capacity/sec** [T]. This is what cascades consume.

### 6.2 Heat

When dynamic demand exceeds available headroom, the deficit converts to **Heat** (0–100). Heat decays at 8/sec [T] while under budget. Heat tiers:

| Heat | Tier | Effect |
|---|---|---|
| 0–39 | Nominal | — |
| 40–69 | Instability I | 5% misfire chance (event silently dropped); visual jitter begins (16.7) |
| 70–99 | Instability II | 15% misfire; 10% of your projectiles spawn **corrupted** (damage enemies *and* you); chromatic aberration |
| 100 | **OVERHEAT** | All Programs stall for 3s [T]; screen tears; Heat resets to 50. Emits the On Overheat event — builds that catch it turn the stall into a detonation. |

### 6.3 Design intent

Overclock is a **dial, not a line**. Running at Instability I permanently is a legitimate high-skill strategy (more throughput, occasional misfires). Overdrive + On Overheat builds that surf the 100 boundary are an intended archetype. The punishment for greed is instability the player *authored*, not a designer's cap. All Heat effects must be readable on screen (the world tells you; no number-checking required).

---

## 7. Fuel economy

The horde is a supply chain, not an obstacle course.

> **REMOVED — see DECISIONS D-106.** Fuel is gone: the drops, the three gauges,
> the fuelled-fire bonus, Attune and Rectify. It was ungameable by construction —
> you cannot choose what drops, so it was a tax to watch rather than a decision to
> make — and the only thing anyone did with it was draft pickup radius. Removing
> it also removes the worst legibility problem in the game: a fuel mote and a
> Mote enemy were the same colour, nearly the same size, and separated by a shape
> nobody can resolve at five pixels. Only white XP falls now.
>
> **§7.4 Convert survives**, re-based onto Heat and Integrity. That is a better
> arbitrage layer than the one it replaces: Heat is what a deep cascade
> *produces*, so Cash Out and Stim turn the game's central pressure back into
> progress. Running hot is a position to trade out of rather than only a penalty.
>
> **§7.1's hues survive too, with a different job** — see the §11.1 note. Hue is
> enemy *threat class* now, and Actions keep colour as identity only.

### 7.1 The three hues

Every enemy, action, and fuel mote belongs to one of three hues (colors specced in 16.3):

- **THERMAL** (amber) — projectiles, explosions. Direct damage archetype.
- **VOLTAIC** (cyan) — chains, beams, orbitals, rate. Throughput archetype.
- **VOID** (violet) — fields, control, summons, conversion. Space archetype.

### 7.2 Fuel motes

- Enemies drop fuel motes **of their own hue** on death (1 base; elites 5) [T].
- Motes fill three gauges, cap 100 each [T], auto-collected within magnet radius.
- **Fueled fire:** when an Action fires, it consumes 1 fuel of its hue if available → **+50% output** [T] for that fire. Unfueled fires work at base. Fuel is throughput, not permission.

Consequence: the player *wants* specific enemies. A Voltaic build starving in a Thermal wave is a real strategic problem, solved by movement (herding), Convert nodes, Attune, or drafting a second hue. Spawn composition becomes something the player reads and plays around (12.2).

### 7.3 XP

- Enemies also drop XP shards (white, distinct dashed visual). Fill the XP bar → level → Draft.
- **Consolidation:** when ground shards exceed ~200 [T], the oldest merge into fewer, richer shards (VS-style). Invisible when it works; mandatory.

### 7.4 Conversion (the arbitrage layer)

The **Convert** action node is drafted in specific configurations (each is a separate draft card):

| Card | Exchange [T] |
|---|---|
| Convert: Bleed | 5 Integrity → 10 fuel (fullest gauge) |
| Convert: Rectify | 15 fuel of one hue → 10 of another (chosen at draft) |
| Convert: Cash Out | 20 fuel → 1 XP level's worth of shards |
| Convert: Coolant | 10 fuel → −25 Heat |
| Convert: Stim | 10 fuel → +30% move speed, 3s |

Conversion exchange rates are the most sensitive tuning surface in the game — degenerate arbitrage loops (e.g., Bleed + Leech infinite engines) are **expected and welcome** as long as they cost Cycles. Patch rates only if a loop removes decisions (23.1).

---

## 8. Leveling & the Draft

### 8.1 Cadence

XP curve tuned so level-ups arrive every **30–45s** [T] throughout the build phase (accelerating enemy density offsets the growing XP requirement). During Meltdown, drafting continues but the pool shifts (13.3).

### 8.2 The draft screen (overlay, time frozen)

Three cards. Each card is one of:

- A **node** (Trigger / Action / Modifier — pool weighted by what the player owns and their Axiom)
- A **capacity upgrade** (+15 Cycles [T])
- A **stat card** (rare; only: magnet radius, move speed, Integrity, crit — small pool, deliberately boring, exists as a floor for dead drafts)

Rarity tiers (Common / Refined / Prototype) scale node numbers, never change behavior. Behavior differences are always separate nodes — legibility rule.

### 8.3 Draft economy

- **Reroll:** start with 2 per run [T]; +1 from certain drafts.
- **Purge:** start with 1 [T]. Permanently removes a card from this run's pool. Narrowing tool — purging thins the pool toward your engine.
- **Auto-slot:** picking a node places it in the first compatible empty slot. A "place manually" option opens the editor. Default flow must be two clicks total: pick → back in the fight in <2s.

### 8.4 Axioms (starting programs)

Chosen at Run Setup; each is a complete starter Program plus a pool bias. v1 ships 6:

| Axiom | Starter program | Pool bias |
|---|---|---|
| Ignition | Clock → Bolt | Thermal +20% |
| Circuit | Clock → Arc | Voltaic +20% |
| Null | Clock → Field | Void +20% |
| Reflex | On Dash → Nova | Mobility/stat cards +15% |
| Scavenger | On Pickup → Fragment | Convert cards +25% |
| Feedback | On Hit → Echo → Bolt | Echo/Resonate +15%; capacity −20 (hard mode) |

---

## 9. Recompile (mid-run prestige)

### 9.1 The mechanic

From minute 8 [T], **Recompile terminals** spawn periodically (edge-indicator marked). Channel 3s while stationary (interruptible by damage) to:

1. **Delete the entire Engine** — all Programs, all nodes. Scrap bonuses (5.7) are kept.
2. Gain a permanent **Kernel multiplier** for the rest of the run: `+K% global output` where K scales with the deleted engine's recent average output (measured in EPS, 13.1) — bigger engines forge bigger kernels. Also +20 Cycle capacity [T].
3. Enter **rebuild surge**: double XP gain for 120s [T], and the next 3 drafts offer 4 cards.

### 9.2 Design intent

The rhythm of a full run is **break → collapse → break harder**, up to 2–3 Recompiles. It solves mid-run staleness (a solved build stops generating decisions), gives the divergence arc a pulse, and creates the genre's rarest feeling: voluntarily deleting a working exponential engine because you believe you can build a steeper one. The Kernel formula must make Recompiling at your peak clearly better than hoarding — hoarding a solved build to Meltdown should be the noob trap, visible in Results ("Kernel potential wasted: 34%").

---

## 10. Enemies — the shape grammar

### 10.1 The rule

**Shape = behavior. Hue = fuel type + damage type. Sides ≈ tier.** A player who has never seen an enemy must correctly predict its behavior from silhouette alone. Every enemy exists in all three hues (hue changes drops and resistance interactions, never behavior). No exceptions in v1.

### 10.2 Roster (v1: 10 + swarm)

| Shape | Name | Behavior | Role |
|---|---|---|---|
| Small dot | Mote swarm | Drifts toward player in loose flocks; dies to anything | Mass, fuel rain, cascade kindling |
| Circle | Drifter | Steady seek | Baseline pressure |
| Triangle | Charger | Stops, aims, telegraphed dash (0.6s windup) | Punishes standing still |
| Square | Bulwark | Slow, heavy HP, front shield arc that blocks projectiles | Forces flanking/fields |
| Hexagon | Splitter | On death splits into 2 Chargers + bonus fuel | Cascade amplifier — feeds On Kill builds *deliberately* |
| Diamond | Interceptor | Fast; targets your *projectiles*, eats them, grows +10% per meal | **Anti-spam pressure.** The counter to mindless bolt-spray |
| Ring | Suppressor | Never attacks; projects a zone where your Triggers don't fire (11.2) | Attacks the build, not the HP bar |
| Crescent | Leech | Contact steals 5 fuel of your fullest gauge (no damage) | Attacks the economy |
| Line segment | Lancer | Keeps distance, fires a telegraphed beam across the arena | The reason to keep moving at range |
| Pentagon | Warden | Mini-elite: any base behavior + one affix (10.3), 10× HP | Wave punctuation |

### 10.3 Elite affixes

Wardens and Meltdown-tier enemies roll 1–2:

- **Adaptive** — gains resistance to the hue that damages it, fast (personal version of 11.1)
- **Volatile** — death explosion (telegraphed ring)
- **Phasing** — periodically untargetable for 1s (breaks lock-on cadence)
- **Anchored** — projects a small suppression zone (mobile Suppressor)

### 10.4 THE MIRROR

The signature elite. From minute 10 [T], spawns every ~90s [T]:

- Takes a live snapshot of **1–2 of the player's Programs** (the highest-output ones) and runs them — against the player. Your On Kill cascades now trigger off *your* deaths… meaning its kills of swarm enemies feed its engine exactly like yours feeds you.
- Rendered as a **wireframe, phase-inverted copy** of the avatar (16.6). Its effects use your effects' visuals, hue-shifted to its inverted palette — instantly readable as "that is my build, reflected."
- HP scales with your EPS at spawn time. It can never be out-scaled, only out-designed: the counter to your own build is the puzzle.
- Reward: a **free draft of choice** (pick any node in the pool) + 10 fuel of every hue.

The Mirror is the only anti-screensaver mechanic that gets *more* interesting as the player gets more broken. It is also the fiction made literal: the runtime forks your process to fight you.

---

## 11. Pressure systems

HP inflation is banned as a difficulty lever. Pressure attacks the **build**, the **economy**, or the **space** — never just the health bar.

### 11.1 Hue is threat class

> **REPLACED — see DECISIONS D-106.** Adaptive resistance is retired. It was
> never displayed despite this section promising it always would be, so it was a
> tax nobody could see — and it punished exactly the focused single-hue builds
> the new class stats exist to reward. Its named counters are gone with Fuel.

Hue is now a property of the **enemy**, and it predicts behaviour:

| hue | class | reads as |
|---|---|---|
| thermal | **rushers** | mote, charger, splitter — come straight at you |
| voltaic | **harassers** | lancer, interceptor, suppressor — hit or interfere from range |
| void | **anchors** | drifter, bulwark, leech, warden — soak, hold ground, disable |

The point is that colour is now something you read *while dodging*. An
Interceptor is a diamond that hides inside your own projectile cloud and did the
most damage of anything in a measured run; making its colour mean "this one
harasses you" is the only warning that survives a busy screen.

Actions keep their colour as identity — you have to tell a Bolt from an Arc — but
it is no longer a system, because a colour that pretends to interact and does not
is just more noise in an arena that has plenty.

**What replaces it as a build axis: behaviour tags (§5.5).** Every Action is some
combination of *travels* ▸, *area* ◍ and *lingers* ⧗, derived from the fire-context
fields its primitive actually reads. Pierce and Ricochet need ▸; Enlarge needs ◍;
Sustain needs ⧗. That rule always existed and was enforced silently; the glyphs
put it on the card, and three class stats pay you for committing to one.

### 11.2 Suppression zones

Inside a Suppressor's ring (or Anchored affix), the player's **Triggers do not fire**. Actions already in flight resolve; nothing new starts. Zones render as local desaturation to grayscale — the world literally loses its color where your engine can't reach. Killing the Suppressor (it's fragile) or leaving the zone restores everything. Design note: zones must be dodgeable spaces, not screen-wide; their job is to make positioning matter again at high power.

### 11.3 Interceptors

See 10.2. As projectile count grows, Interceptor spawn weight grows (12.2). The intended pressure curve: pure projectile spam feeds Interceptors into monsters; the answer is beams, fields, novas — build diversity through threat, not through nerfs.

### 11.4 Containment (Meltdown-only antagonists)

The runtime's immune response; these only appear after minute 20 (13.2):

- **Sweeper** — a slow arena-crossing beam wall with one gap. Positional test that ignores DPS entirely.
- **Quarantine cell** — expanding geometric cage segments that must be dodged through as they close; being caught deals %-max damage.
- **Null front** — a screen-edge wave that advances and shrinks the playable arena for 10s, forcing motion.

Containment scales in frequency and overlap, never in "HP." By minute 26+ the player is threading simultaneous Sweepers, cells, and fronts while their engine deletes everything else — death comes from geometry, not attrition.

---

## 12. Waves, the director & the player clock

### 12.1 Threat

A single scalar, **Threat**, drives enemy density, tier weights, and elite frequency. Threat rises with time (base curve) and accelerates from player greed (beacons, 12.3). It never decreases.

### 12.2 The director

Spawning is composition-based, not random-soup:

- Waves are authored **composition templates** (data artifacts): e.g., "Splitter cluster N + Charger screen E/W," "Suppressor pair + swarm flood," "mono-Thermal fuel wave." The director selects templates by Threat band, weighted by two reactive inputs:
  - **Interceptor weight** rises with the player's live projectile count (11.3).
  - **Hue starvation:** the director slightly biases *against* the player's needed hue over time (about 60/40, never total starvation [T]) — fuel routing stays a real problem without feeling rigged.
- Spawns occur off-screen at the arena edge nearest their template's compass slots. No spawn-on-top-of-player, ever.

### 12.3 Wave Beacons

Every ~75s [T] a Beacon spawns somewhere on the arena (edge-indicator marked). Channel 1.5s to activate: the next wave template spawns **immediately and enriched** (+50% fuel and XP drops [T]), and Threat permanently ticks up one notch. Ignoring beacons is safe and slow; chaining them is the greed line. Speed is a choice — the timer is a resource, not a wall.

### 12.4 Extraction

From minute 15 [T], one **Extract terminal** exists at a fixed arena landmark. Channel 5s (interruptible) to end the run voluntarily: score banks at current value with a **safe-exit multiplier of ×1.0** — no Meltdown multiplier ever applies. Extraction exists so a great build can be banked by a player out of time or nerve; the results screen shows what the Meltdown multiplier *would have offered*, feeding next run's greed.

---

## 13. Divergence, Meltdown & scoring

### 13.1 EPS — the score metric

**EPS (events per second)**, smoothed over 5s, is the game's measure of engine output — displayed live in the HUD. Score accrues continuously as the integral of EPS over the run. Damage numbers are cosmetic; EPS is truth. This makes the score equation Balatro-legible: build fires more events → number goes up, visibly, now.

### 13.2 Meltdown (minute 20)

At 20:00 the build phase ends automatically — this is not a fail state, it is the third act:

- **Score multiplier** starts at ×1 and climbs +0.25 every 30s survived [T], uncapped.
- Containment (11.4) begins and escalates without limit; regular waves continue at max Threat with elite affixes standard.
- The world visually degrades on a fixed ladder tied to Meltdown time (16.7) — by minute 26 the arena itself is tearing. The renderer is the doom clock.
- Drafting continues; the pool shifts toward Prototype rarity and capacity cards.
- Death here is the intended ending. The run's final beat should feel like your engine and the runtime tearing the world apart together.

### 13.3 Final score

```
Score = ∫EPS  ×  Meltdown multiplier (peak)
      + Discovery bonuses (15.3)
      + Mirror kills × 500 [T]
      + Kernel count × 250 [T]
```

Leaderboard: **local only in v1** (per-Axiom best + overall). Online boards are v1.1 (25).

---

## 14. Death & Results screen

On death: 1.5s slow-motion decomposition of the avatar (no instant cut), then Results:

1. **Run trace** — a single horizontal timeline chart of EPS over the run, annotated with markers: level-ups, Recompiles (visible as cliffs-then-spikes — the prestige rhythm made visible), Mirror kills, Meltdown start, death. This chart is the run's story and the screen's hero element.
2. Score breakdown per 13.3.
3. Final engine snapshot (the pipeline as it stood, inspectable).
4. Discoveries made this run (15.3), Library unlocks earned.
5. Buttons: **Run it back** (same Axiom/arena, instant), New setup, Menu.

No "you died" shaming language anywhere. Meltdown death copy: "CONTAINED — after Xs of divergence." Early death copy: "Garbage collected."

---

## 15. Meta-progression

### 15.1 The iron rule

**Meta-progression grants breadth and knowledge, never power.** No permanent stat upgrades, no currency-grind multipliers, no "+8% damage" trees. A day-one account and a 100-hour account entering the same run with the same picks are identically strong. Megabonk's load-bearing grind is the named anti-goal.

### 15.2 The Library (what persists)

- **Node pool:** new Triggers/Actions/Modifiers unlock into the draft pool via Discoveries and milestones. Fresh accounts start with a curated ~60% of nodes [T] — enough for every archetype, thin enough to learn.
- **Axioms:** 3 at start, 6 total in v1, unlocked by play milestones (e.g., Feedback unlocks after your first depth-6 cascade).
- **Codex:** enemy/system entries fill in on first encounter.
- **Blueprints:** any engine snapshot from a Results screen can be saved as a Blueprint — a *recipe card*, viewable in the Library and pinnable during a run as a draft wishlist overlay. Blueprints never pre-load nodes; they are knowledge, not power.
- **Phosphor themes:** cosmetic palette variants (16.8) from score milestones.

### 15.3 Discoveries

~30 [T] named, achievement-like moments that fire in-run with a stinger and grant score + unlocks. Examples: *First Cut* (scrap a node), *Self-Sustaining* (a cascade loop survives 10s unassisted), *Depth 6*, *Surfing* (45s continuously in Instability I without Overheat), *Arbitrage* (profit loop through 2 Convert nodes), *Mirror Match* (kill the Mirror with the same Program it copied). Discoveries are the tutorialization system — the game teaches its own exploits by naming them.

### 15.4 Onboarding

No tutorial level. Run 1 hard-codes: Ignition Axiom, a 4-card curated first draft, and contextual one-line callouts (first beacon, first Suppressor, first Recompile terminal). All callouts are dismissable and never repeat. The Discovery system carries the rest.

---

## 16. Visual language

**Dialect: blueprint structure, phosphor behavior.** The world draws like a technical schematic — thin strokes, ticks, annotations — and behaves like a living instrument: beam glow, phosphor trails, decay. UI and arena share this one language; the pipeline editor is the same document zoomed in. No sprites, no textures, no exceptions: every visual is strokes, fills, glow, and type.

### 16.1 Rendering axioms (design-level)

- Dark field, additive glow. Maximum chaos must resolve into *light*, not soup — the peak-power screenshot is the marketing.
- Single bloom pass aesthetic: emissives bloom, structure doesn't.
- Everything animates by transform/opacity/stroke, never by frames (17).

### 16.2 Brightness hierarchy (the legibility law)

Reserved luminance bands, strictly enforced:

1. **100% — the player. Nothing else, ever.** The avatar is the brightest object in the universe; you find yourself in any chaos in <100ms.
2. 80–90% — active threats mid-telegraph (a charging Charger, a firing Lancer).
3. 60–80% — enemies, elites, the Mirror, player effects at fire-moment.
4. 35–60% — projectiles/effects in flight, fuel and XP pickups.
5. 15–30% — arena structure, grid, annotations, spent trails.

### 16.3 Palette

| Role | Spec (base theme) |
|---|---|
| Background field | Near-black, cold blue cast (≈ #060A12) |
| Structure / blueprint lines | Desaturated slate-blue (≈ #2A3A52), sub-30% brightness |
| Player | Pure white (#FFFFFF) + white bloom |
| THERMAL | Amber ≈ #FFB000 |
| VOLTAIC | Cyan ≈ #00E5FF |
| VOID | Violet ≈ #B44CFF |
| Damage-to-player / corruption | Signal red ≈ #FF2A3C — reserved exclusively for "you are being hurt / your engine is corrupted." Never decorative. |
| XP | White, dashed-stroke shards (reads as "small player-stuff") |

Hue discipline: these seven are the entire color vocabulary. No gradients across hues, no decorative color.

### 16.4 Entity construction

- **Player:** small white equilateral triangle-in-circle (compass-needle feel), 3px stroke @1080p base; dash leaves a 3-frame white afterimage.
- **Enemies:** 2–2.5px stroke outlines of their shape, hue-colored, subtle interior fill at 8% opacity. Tier shown by size + stroke weight, never by different shape.
- **Projectiles:** 1px strokes with phosphor trails; length of trail ∝ speed.
- **Fields/zones:** fill-less dashed outlines with slow-rotating dash pattern; interior faint scanline hatch.
- **Pickups:** 1px dashed micro-shapes, gentle sine bob.
- **Terminals/beacons:** blueprint-annotated structures — dimension ticks, a label in micro-type (`RECOMPILE_07`, `EXTRACT`), a slow radar sweep when active.

### 16.5 The grid

A faint structural grid across the arena (band-5 brightness) that doubles as an instrument: local grid-line distortion and brightening around the avatar proportional to **dynamic Cycle load** — your engine's draw is visible in the world's fabric. During Overheat the grid locally tears.

### 16.6 The Mirror's look

Exact copy of the avatar's geometry, rendered wireframe-only, phase-inverted palette (its "white" is the background blue; its effects use the player's effect visuals hue-rotated 180°). Slight constant vertex shimmer — it never sits still visually. Unmistakably "you, wrong."

### 16.7 The degradation ladder (diegetic overload)

One ordered ladder of screen-space corruption serves both Heat (temporary, local intensity) and Meltdown (permanent, escalating):

1. Vertex jitter on player effects (Instability I)
2. Chromatic aberration at screen edges (Instability II)
3. Corrupted projectiles render glitch-dashed in signal red
4. Scanline tears on Overheat (0.5s)
5. *Meltdown only:* hue bleeding, arena lines detaching and drifting, grid tearing permanently, background lightening toward white as final minutes approach — the world overexposing
   All ladder steps have reduced-intensity variants for the photosensitivity setting (21).

### 16.8 Phosphor themes (cosmetic)

Unlockable full-palette remaps preserving the brightness hierarchy exactly: *Amber Terminal* (mono-amber + intensity), *Green Phosphor*, *Blackprint* (white structure on blue), *Redline*. Hue-coding of fuel shifts to accent-marks in mono themes (shape carries type — already guaranteed by 10.1).

---

## 17. Motion & game feel

With no sprite art, juice carries all charm. These are requirements, not polish backlog:

### 17.1 Life cycle motion

- **Spawn:** entities draw themselves in — stroke traces the outline over 200ms (dash-offset style), then fill fades up.
- **Death:** decompose into constituent line segments, inheriting velocity + outward impulse, fading over 300ms. Big enemies shed segments progressively as HP drops (damage state without HP bars).
- **Telegraphs:** geometry completing itself — a Charger's dash line draws point-to-player before the dash; Lancer beams draw as 1px guide then flash to full width. Rule: every avoidable hit is preceded by a drawn line.

### 17.2 Impact grammar

- **Hitstop:** 20–30ms on significant kills, budgeted (max total stop per second [T]) so cascade chains read as a *stutter-roar*, not a freeze.
- **Kill flash:** victim's stroke flashes white 40ms before decomposition.
- **Player hurt:** 80ms signal-red vignette pulse + 150ms desaturation of everything *except* threats. Never full-screen flash (photosensitivity).
- **Screenshake:** tiny, frequent, capped; scales with event magnitude, hard ceiling regardless of chaos.
- **Pickup:** magnet ease-in (quadratic), soft tick sound per mote, pitch rising within a collection burst.

### 17.3 Feel targets

60fps is a design feature (the phosphor aesthetic dies at 30). All easing: cubic-out defaults. Every player-caused state change must be perceivable within 1 frame of cause: draft a node → the new Program visibly fires within 2s or telegraphs why not (starved, suppressed — shown on the avatar's ring).

---

## 18. Audio

### 18.1 Direction

Fully synthesized instrument, no sample-library "music." The soundtrack *is* the engine: kills, fires, and pickups are quantized notes; the run composes itself. References: Rez's synesthesia, Ape Out's reactivity — but schematic-cold, not jazzy.

### 18.2 The grid

- Global clock at 110 BPM base [T], rising with Threat to ~140 at Meltdown. All engine SFX quantize to 16th-note boundaries (≤40ms delay is imperceptible in this genre and makes chaos musical). The Quantize modifier (5.5) makes this mechanical.
- Layered backing: a low pulse (always), harmonic pads keyed to dominant fuel gauge hue, rhythmic intensity layers keyed to EPS bands. Meltdown adds detune and distortion per degradation step.

### 18.3 Hue voices

- THERMAL: saw-bass hits, kick-adjacent detonations
- VOLTAIC: square-wave arps, zaps, hi-hat-like ticks
- VOID: FM pads, reversed swells, sub drops
- Player hurt: the only *non-musical* sound in the game — a dry, arrhythmic clip. It must feel wrong on purpose.
- Overheat: master-bus distortion + brown-out dip; On Overheat detonations get the biggest sample in the game.

### 18.4 Mix rules

Kill-note polyphony capped with intelligent voice-stealing (highest-damage events win). Silence is banned: even the menu hums (phosphor idle tone).

---

## 19. Screens & UX

Complete screen inventory. All screens share the blueprint-phosphor language (16); menus are schematic documents, not floating panels.

### 19.1 Boot / Title

Logo draws itself in (stroke-trace), phosphor hum, "press any key." Background: an attract-mode autonomous engine firing slowly in the dark. <3s to menu, skippable instantly.

### 19.2 Main Menu

Vertical schematic list: **RUN** / **LIBRARY** / **STATS** / **SETTINGS** / (CREDITS). Selection = the line highlights and annotates. Local best score in micro-type in a corner. No news panels, no battle-pass real estate — this menu must look like the inside of an instrument, permanently.

### 19.3 Run Setup

Three columns: **Axiom** (card list; locked ones shown as dashed outlines with unlock condition), **Arena** (v1: two, see 22), **Toggles** (challenge modifiers, v1: Hardline — no stat cards in pool; Cold Boot — capacity 60; each toggle = +15% score [T]). Right panel: live summary + START. Remembers last configuration.

### 19.4 In-run HUD

Minimal, edge-mounted, all band-5 brightness except alerts:

| Position | Element |
|---|---|
| Screen top edge | XP bar: 1px full-width line filling left→right; blinks softly at level pending |
| Top-left | Integrity: segmented white bar. Below: three tiny hue glyphs + adaptive-resistance % (11.1), each desaturating as its resistance climbs |
| Top-center | Clock (M:SS) + Threat pips. At 20:00 it is replaced by the Meltdown multiplier, in Prototype styling |
| Top-right | Score + live EPS readout (the number the whole game is about — always visible) |
| Bottom-left | Three vertical fuel gauges (amber/cyan/violet), 100 units tall |
| Around avatar | **The Ring:** a thin circular arc showing Cycle load (static reserved + dynamic flicker). Heat renders as the ring reddening and jittering; suppression renders as the ring graying out. The player's most important instrument lives on the player. |
| Screen edges | Off-screen indicators (small directional glyphs): Beacons, terminals, Mirror, Wardens — never regular enemies |
| Draft pending | Small stacked chevrons bottom-center if the player defers a level-up (drafts can queue up to 3 [T]) |

Damage numbers: **off by default** (EPS + kill flashes carry feedback); can be enabled in settings.

### 19.5 Draft overlay

Time frozen, arena dimmed 60%, three cards center-screen. Each card: node glyph, name, type tag, hue affinity, Cycle cost, and a one-line *mechanical* description (no flavor text on cards — flavor lives in the Codex). Bottom rail: Reroll ×N, Purge ×N. Hover/focus shows an interaction preview: "Slots into: [Program 2, empty modifier]." Confirm → auto-slot (8.3) → instant unfreeze. Optional "PLACE →" opens the editor with the card in hand.

### 19.6 Pipeline editor

Tab at any time (freezes time; opening it is free — never punish inspection):

- The Engine rendered as a schematic: Programs as horizontal rows (Trigger → Modifiers → Action as connected node chips), evaluated top-to-bottom exactly as displayed.
- Drag to reorder Programs and modifiers. Reordering is free and unlimited.
- Per-Program live annotations: static Cycle cost, recent fire rate, share of total EPS (this row's % of your output — instantly shows dead weight).
- **Scrap:** drag a node/Program to the scrap margin → confirmation showing refund + the permanent +4% (5.7).
- Header: capacity bar (static load vs. total), Heat state, Kernel count.
- Blueprint pin (15.2) displays as a ghost-column wishlist on the right.
- No simulation/preview sandbox in v1 (25).

### 19.7 Recompile confirmation

On channel completion, a full-screen 2s ceremony (skippable never — this is a ritual): the schematic burns down row by row → Kernel forged (K% shown) → rebuild surge begins. The one moment of grandeur in an otherwise dry UI.

### 19.8 Pause

Freezes everything. Slim menu: Resume / Editor / Settings / Abandon run (double-confirm; abandon = death-tier results). Shows current run summary stats. The arena stays visible, dimmed, jitter-frozen mid-frame — a paused oscilloscope.

### 19.9 Results

Per Section 14. The EPS run-trace chart is the hero; everything else is secondary annotation around it.

### 19.10 Library

Tabs: **Nodes** (grid of all node cards; undiscovered = dashed silhouettes + hint text), **Axioms**, **Blueprints** (saved engines; pin/unpin, rename, delete), **Codex** (enemies, systems, Containment — entries written in dry runtime-log voice, the only place flavor text lives).

### 19.11 Stats

Lifetime numbers: runs, best score per Axiom, total Meltdown time, deepest cascade, highest EPS, Discoveries N/30, Mirror record. One page, dense, schematic table.

---

## 20. Settings

All settings apply instantly, no restart, persisted locally.

### 20.1 Video

- Resolution scale: 50–200%
- Frame cap: 60 / 120 / uncapped / vsync
- Bloom intensity: 0–100% (default 70)
- Trail length: 0–100%
- Screen shake: 0–100%
- Hitstop: on/off
- **Degradation FX intensity: 0–100%** (scales the 16.7 ladder; 0 replaces glitches with plain fades — see 21)
- Max particle density: Low/Med/High/Uncapped (Low collapses effects to aggregates earlier; never changes gameplay outcomes)
- Fullscreen / windowed

### 20.2 Audio

- Master / Music-layers / Engine SFX / UI buses, 0–100 each
- Quantization: on/off (off = SFX fire immediately, for players who feel the ≤40ms delay)
- Player-hurt sound: standard / extra-prominent

### 20.3 Gameplay

- Damage numbers: off / kills only / all
- Draft queueing: on (default) / auto-open on level
- Edge indicators: all / critical only
- Auto-pause on focus loss: on (default; it's a browser game)
- Cursor confinement: on/off

### 20.4 Accessibility (also see 21)

- Photosensitivity-safe mode (master toggle: forces Degradation 20%, shake ≤30%, no flashes → fades)
- Reduced motion (background grid static, trails minimal)
- Colorblind palettes: deuteranopia / protanopia / tritanopia remaps of the three fuel hues (+ shapes already encode type redundantly)
- UI scale: 80–150%
- High-contrast mode (structure brightness floor raised, fills removed)
- Game speed: 80 / 90 / 100% (single-player; accessibility, not cheat — flagged on leaderboard entries)

### 20.5 Controls

Full rebinding for keyboard and gamepad; two preset layouts each; stick deadzone slider.

---

## 21. Accessibility commitments

- **Photosensitivity is a first-class constraint**, not a toggle bolted on: every effect on the degradation ladder ships with a safe variant at design time. No full-screen flashes exist anywhere in any mode.
- Shape+hue double-coding means the game is fully playable in monochrome (the phosphor themes prove it publicly).
- All channel interactions (beacons, terminals) are hold-to-complete with visible progress and generous interrupt-resume.
- Nothing in the game requires reaction under 300ms except optional dash plays; all lethal hits are telegraphed by drawn lines (17.1).

---

## 22. Content scope — v1 ship list

| System | v1 quantity |
|---|---|
| Triggers | 10 (5.3) |
| Actions | 14 (5.4) |
| Modifiers | 14 incl. 2 topology (5.5–5.6) |
| Convert configurations | 5 (7.4) |
| Axioms | 6 (8.4) |
| Enemy shapes | 10 + swarm (10.2), × 3 hues each |
| Elite affixes | 4 (10.3) |
| Signature elite | The Mirror (10.4) |
| Containment units | 3 (11.4) |
| Wave templates | ~40 authored compositions across Threat bands |
| Arenas | 2 — **The Heap** (open field, structure ruins as soft cover for herding) and **The Stack** (broad concentric corridors; suppressors and lancers hit harder here) |
| Discoveries | ~30 (15.3) |
| Phosphor themes | 4 (16.8) |
| Challenge toggles | 2 (19.3) |

Estimated node-pool combinatorics: 10 × 14 × (14 choose ≤3 ordered) per Program × 8 Programs × topology — the space is large enough that the community metagame, not the design team, finds the ceiling. That is the success condition.

---

## 23. Balancing philosophy & tuning levers

### 23.1 The two kinds of broken

- **Power breaks** (exponential damage, infinite fuel arbitrage, screen-deleting cascades): **protected content.** Never patch a power break that still costs Cycles and still requires the player to move. If one dominates the metagame, respond by *pricing* (Cycle costs, exchange rates) or by *pressure* (Interceptor/Adaptive weights) — never by deleting the interaction.
- **Tension breaks** (the game stops asking for decisions): **bugs, fix immediately.** The canonical three: permanent knockback walls (Shove stacking must cap total displacement per enemy per second [T]), full CC uptime, and stand-still immortality (Leech + Bulwark-cheese). Detection heuristic for playtests: if the player's inputs flatline for 30s+ while Integrity holds, we have a tension break.

### 23.2 The tuning surface (ordered by sensitivity)

1. Convert exchange rates (7.4)
2. Cycle costs per node & regen rate (5, 6.1)
3. Echo/Resonate multipliers (5.5–5.6)
4. Adaptive resistance cap & window (11.1)
5. Kernel formula (9.1)
6. Fuel-fed output bonus (7.2)
7. Threat curve & Meltdown multiplier ramp (12.1, 13.2)
8. XP curve for the 30–45s draft cadence (8.1)

### 23.3 Testing invariants (must hold every build)

- Draft-to-combat round trip ≤ 2s.
- Player locatable in a full-chaos screenshot by naive viewers in <1s (test this literally, with screenshots and stopwatches).
- Every avoidable hit preceded by a drawn telegraph.
- A deliberately degenerate reference build (maintained by design) must still reach Meltdown — if a patch kills the reference exploit, the patch is wrong.

---

## 24. Non-goals for v1

Explicitly out of scope; do not build hooks for them:

- Multiplayer / co-op of any kind
- Mobile/touch support (desktop browser only; architecture may not preclude it, but zero design effort)
- Narrative campaign, dialogue, characters
- Sprite/texture art, ever — this is an identity commitment, not a budget one
- Online leaderboards, accounts, cloud saves (v1 is local persistence)
- In-run pause-menu build respec beyond Scrap/reorder (no "undo")
- Manual aiming
- Meta stat progression (permanent iron rule, 15.1 — listed again because someone will suggest it)

---

## 25. Open decisions log

Left open intentionally — resolve with design, not silently:

1. Final title (OVERCLOCK is a placeholder with trademark risk).
2. Exact numeric curves everywhere marked [T] — first-playable tuning pass owns these.
3. Arena 2 (The Stack) layout specifics — blocked until The Heap plays well.
4. Pipeline-editor simulation preview (19.6) — desirable, deferred; decide after watching testers reorder blind.
5. Online leaderboards + replay/ghost format (v1.1 candidate; EPS trace makes replays cheap to consider).
6. Audio-reactive spawning (waves quantized to bars) — prototype flag, could be magic or noise.
7. A seventh "wildcard" hue for Meltdown-only drops — parked.
8. **Rhythm as an input, not only as a readout.** Parked deliberately; the
   biggest open idea in the audio direction and the one that changes the game
   rather than dressing it.

   Built already, and one-way: the Engine writes the soundtrack (18.1) and the
   picture is entrained to it (grid pulse, snapped detonations). The player hears
   and sees the beat but cannot *use* it.

   The idea is to close the loop — reward acting on the grid. Candidates, roughly
   in order of how invasive they are:

   - Dash on a downbeat extends the i-frame window.
   - A Clock row that fires on the beat crits, so tempo becomes a build axis.
   - Fuel pickups on the beat are worth more.

   Why it is parked rather than scheduled: it makes rhythm a **skill**, and
   nothing else in this design asks for one. 17.1 promises every threat is
   readable and actable; a timing window the deaf or the arrhythmic cannot hit
   would break that, so any version of this needs a non-rhythmic path to the same
   power or it is an accessibility regression (21). It also fights 8.2 — the
   draft is where power comes from, and a second source of it dilutes the one
   decision the game is about.

   If it is ever built, build it as a *bonus* and never as a requirement, and
   test it with the music muted before anything else.

9. **Chassis — more than one character, combinable with Axioms.** The avatar is
   now a machine with parts rather than a triangle (16.4), which is the
   groundwork for this rather than the thing itself.

   The idea: pick a chassis at Run Setup alongside the Axiom. The Axiom decides
   what you are *building*; the chassis decides what you are *flying*. Sketched
   differences, all of them single numbers that already exist as tunables —
   faster, more Heat headroom, less headroom but a hotter opening, faster fire,
   one more Program row from the start.

   Two things to resolve before it is scheduled. First, it multiplies the run
   space by the number of chassis, and 15.1's iron rule says none of them may be
   a *permanent* upgrade — every chassis must be available from the first run or
   it is meta progression wearing a hat. Second, a chassis that grants a row is
   not a sidegrade, it is the strongest card in the game handed out for free at
   setup; that one probably has to pay elsewhere, hard.

   Visually the work is small and mostly done: hull silhouette, thruster shape
   and core geometry are already drawn from parameters in one function.

---

## 26. Glossary

| Term | Meaning |
|---|---|
| Engine | The player's full build: the ordered list of Programs |
| Program | Trigger → Modifiers (ordered) → Action; one row of the Engine |
| Node | Any draftable unit: Trigger, Action, or Modifier |
| Event | Any engine occurrence (fire, hit, kill…); the atom of the cascade system |
| Cascade | Chain of events spawning events; carries depth |
| Cycles | Static reservation: capacity vs. what your live nodes cost. Changes only when you change the Engine |
| Heat | Accrues from cascade depth past the free links; drives Instability tiers and Overheat |
| Overclock | Deliberately running chains deeper than you can cool |
| Fuel | **REMOVED (D-106).** Was a hue-typed drop; see the §7 note |
| Hue | One of Thermal/Voltaic/Void; types damage, fuel, enemies, and audio |
| EPS | Events per second; the score metric and the game's honesty about output |
| Recompile | Mid-run prestige: delete the Engine, forge a Kernel |
| Kernel | Permanent per-run global output multiplier earned by Recompiling |
| Threat | The director's difficulty scalar |
| Meltdown | Post-20:00 endless scoring act; Containment active |
| Containment | The runtime's geometric antagonists (Sweeper, Quarantine cell, Null front) |
| The Mirror | Elite that runs a snapshot of the player's own Programs |
| Scrap | Delete a node/Program for a Cycle refund + permanent output bonus |
| Discovery | Named in-run achievement; the tutorialization and unlock system |
| Axiom | Starting Program + draft-pool bias, chosen at Run Setup |

---

*End of document. Content is data; the engine is dumb; the player is the exploit.*
