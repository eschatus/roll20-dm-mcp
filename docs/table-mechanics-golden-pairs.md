# Table mechanics — golden pairs from the DM calibration exercise (2026-07-28)

Role-play calibration with Adam: Claude spoke PTT-keyed DM utterances over a concrete
board; Adam answered with what he actually does mechanically on Roll20. Each pair is
ground truth for the scenario generator / Board grader (`SFT_TRACE_PLAN.md`); the
conventions and gaps below override prior assumptions where they conflict.

## Board (scenario 1, round 2)

PCs: Glint Klinkinski (player: Errol), Salros Eventide — HP via Beyond20, tracked-only
for the gem. **Tua — SIDEKICK** (see conventions). NPCs: Water Elemental "the Surging"
90 max, Kraken Priests A & B 33 max. Zones: Grease (difficult terrain, green/yellow).
Tua has Spirit Guardians up (concentration, aura visual). Init: Salros → Surging → Tua →
Priests → Glint.

## The pairs

| # | utterance (PTT'd) | mechanical effect |
|---|---|---|
| 1 | "Salros carves into the Surging — that's 19 slashing, and it's looking ragged now." | Surging bar1 68→49. Bloodied check 49 > 45 → **no marker despite the flavor**. |
| 2 | "The Surging slams into Glint — he takes 14 bludgeoning and he's knocked prone in the grease." | Glint tracked HP −14, **no bar write** (Beyond20 owns it); `prone` marker (markers are DM-side); no zone action ("in the grease" is positional flavor). |
| 3 | "Tua wades forward… drags Priest A into the ring — fails the wisdom save, takes 11 radiant, and the spirits slow him to a crawl." | Priest A bar1 33→22; bloodied check no. **The slow clause → no per-token action** — the aura IS the difficult-terrain region. The 11 is a chat-derived, post-resistance number (DM already checked; when unstated, read recent chat for the caster's roll this round — and whether they rolled yet). |
| 4 | "Glint lets a fireball rip — 28 fire. Both priests blow the save, the Surging makes it. And the grease catches." | Priest A 22−28→0: **dead marker + map layer**. Priest B 33−28→5: 5<16.5 → **bloodied marker**. Surging save→14 (post-resistance, DM's call): 49−14→35: 35<45 → **bloodied marker**. Grease: **delete + create** as fire zone, damaging, red, duration rounds(1). |
| 5 | "Priest B hurls thunder at Tua — she takes 12, and she loses the spell. The spirits gutter out." | Tua **bar1 −12 (sidekick!)** + usual bloodied check; concentration save was already resolved at the table (declarative); remove `concentrating` marker; **aura radius → 0**; emanation effect gone (no zone object to delete). |

## Conventions learned (generator + grader requirements)

1. **Bloodied is threshold automation, not narration.** After every NPC/sidekick HP hit:
   check < max/2 and conditionally apply the wounded sticker. Flavor words ("ragged")
   never drive it; the math does — in pair 1 flavor said ragged and the answer was NO
   marker; in pair 4 the marker arrived two rounds later off pure arithmetic.
2. **Stated numbers are final** (DM already applied resistances). Unstated recurring
   damage (auras) → read chat for the roll this round; note if not rolled yet.
3. **Token classes are THREE-way:** PC (Beyond20 bar, gem tracks shadow HP), NPC (bar1),
   **sidekick (player-controlled but bar1-managed)** — `controlledby` alone misroutes
   sidekicks; needs a per-token override flag.
4. **Enemy-on-PC utterances get PTT'd mainly when a condition rides along**; bare PC
   damage often stays DM↔player. Sometimes the DM is "faster than the machine" → the gem
   must tolerate **already-applied state** (idempotent marking, drift-aware HP).
5. **Zones carry semantics:** `{terrain: difficult|damaging, color: green-yellow|red,
   duration: instant|rounds(n)|concentration(caster)}`. Difficult = green/yellow,
   damaging = red.
6. **Zone transitions are per-material delete+create with a new duration:** web+fire →
   instant fire zone (damage occupants, gone); grease+fire → rounds(1) damaging red
   zone. A substance × trigger transition table, kept as data.
7. **Concentration = a `concentrating` marker + linked effects.** Break (declaratively
   stated; the save already happened at the table) = remove marker → aura radius 0 →
   linked zones/effects torn down. rounds(n) zones expire via round-end countdown
   processing (existing narration convention).
8. **Not every clause maps to a tool** (pair 3's slow) — the generator needs
   negative-space cases or the model learns to invent a marker per clause.

## Gaps found in the current system

- **Sidekick routing:** `isPcToken` (controlledby-based, `src/tools/aoe.ts`) has no
  sidekick concept → would shunt Tua's damage to tracked state and let bar1 drift.
  Needs a per-token override (registry or token flag).
- **Zone model:** zones today have no terrain/duration/concentration fields and no
  round-end expiry; transitions are expressible only as clear+create by convention.
- **No modify_zone tool needed** — Adam prefers delete+create semantics.

## Session 2 pairs (same fight, rounds 3+)

**Roster errata:** Salros Eventide is an NPC (see logs: `roll_initiative npcOnly:true`).
**Sidekicks at this table: Tua, Salros, Amri.**

| # | utterance | mechanical effect |
|---|---|---|
| 6 | "That's the round. Top of the order." | advance to top (explicit — never auto); round marker auto-increments via `formula:"+1"`; **rounds(1) fire zone deleted at the boundary** (created mid-round → burns rest of that round → removed at rollover), enumerated in round-end countdown narration. |
| 7 | "Back up — that thunder was 7, not 12." | Retcon = **compensating delta** (`bar1 +5`), not rollback. Bloodied is **symmetric** (threshold check both directions on every HP change). Retcons can **cascade**: if the corrected number would have changed a concentration outcome, "possibly" the aura comes back — the gem should SURFACE the dependency and ask, never auto-revert. |
| 8 | "Two more kraken priests through the east door — they act right after the Surging." | Reinforcements are **found, not created** (token layer at distance, or GM layer patrols; even summons grabbed from journal first — "tools only help if faster than me"). Same-name tokens get **epithets** (rename). Init insert at the stated slot; **current-turn pointer must not move**; no other entry shifts. |
| 9 | "That's 23, and he drops." (Salros — NPC) | bar1 down; **NPCs/sidekicks just die** (or unconscious if subdued): X + map layer immediately; init entry preserved for retcon; **bodies are difficult terrain** (the corpse token, no zone). **Stated outcome OVERRIDES arithmetic** — the DM may have fudged ("within a few hp") to end a dragging fight; the gem never argues with the table; tracked numbers reconcile TO declarations. |
| 10 | "The bolt takes Glint — he's down!" (true PC) | `prone` + `unconscious` markers, **stays on token layer**; death saves are player-owned (3 fails = dead, only then X + map layer). **Going down auto-fires the concentration/spell-effect teardown cascade** (implicit break, same as pair 5). |
| 11 | "Potion's in — he's back on 6, conscious, still flat on his back." | tracked HP **SET to 6 (absolute-set semantics** — "on N" vs delta "takes N"); remove `unconscious`; **`prone` persists** until he stands on his own turn (revival ≠ standing). |

## Additional conventions (session 2)

9. **Drop behavior column in the routing table:** true PCs get the dying state
   (prone+unconscious, death saves); NPCs AND sidekicks just die. The flag that matters
   is "real player character" and it governs both HP routing and death handling.
10. **HP numbers have two verb classes:** delta ("takes 12") and absolute-set ("on 6",
    "back to full"). The generator must produce both.
11. **Stated outcomes override arithmetic** (fudging is a feature) — the grader asserts
    declared outcomes, never re-derives them from tracked state.
12. **Retcon dependency-surfacing** is a question, not a tool call.

## Session 2 pairs, continued

| # | utterance | mechanical effect |
|---|---|---|
| 12 | "Everyone still standing gets 5 temporary hit points." | **"Everyone" in a buff = friendlies implied** (scope inferred from effect valence). Sidekick temp HP = **add to bar1** (acknowledged approximation — "isn't right, but close enough"; may interact with symmetric bloodied). PC temps live on DDB sheets — no gem action. |
| 13 | (damage lands on a concentrating token; DM says nothing about concentration) | Gem applies damage, then **prompts tersely** ("Glint — concentration on Bless?"); DM answers ONE WORD ("Passed"/"Failed"); Failed → full teardown cascade. Single-word context-dependent replies are a designed interaction shape. |
| 14 | "Priest B gets knocked prone." (DM had already dragged the token back by hand) | **Division of labor:** the DM owns the SPATIAL domain (dragging, knockback, position — the gem should not move tokens in combat); the gem owns BOOKKEEPING (HP, markers, zones, init). The utterance carries the bookkeeping half; the hands do the spatial half. Marker application must be **set-true, never toggle** (pending confirm) — re-applying an already-set marker must not remove it. |

13. **Tolerance bands, not just exact assertions:** some bookkeeping is deliberately
    approximate (sidekick temp HP); a model fussier than the DM is annoying, not helpful.
14. **Gem-initiated micro-questions** are part of the contract for unstated implications
    (concentration on damage); keep them one-line, answerable in one word.

## Candidate next scenarios (not yet run)

Healing routing spread (PC vs sidekick vs NPC in one utterance); legendary actions;
subdual ("strike to subdue" → unconscious not dead); death-save retcon (PC back from the
map layer); ambiguous-epithet targeting ("the big one", "the hurt priest"); multi-zone
interactions; readied actions / delayed triggers.
