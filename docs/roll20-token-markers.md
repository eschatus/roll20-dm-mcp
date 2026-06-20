# Roll20 Token Markers — Definitive List

Empirically determined 2026-06-01 by applying every marker to a live token (Dacorath
Applebough, in the Fabulous Faerun Firebirds campaign) and confirming render via
screenshot. The custom marker set (IDs 4444311–4444352) is shared across campaigns —
Curse of Strahd uses the same uploaded set. Source of truth for any given campaign's
custom set: `Campaign().get("token_markers")` (via the `get_token_markers` tool /
`getTokenMarkers` relay action).

## How markers render

- Set via the token's `statusmarkers` field: a comma-separated list of **tags**.
  - Custom markers use the tag form `Name::id` (e.g. `Poisoned::4444329`).
  - Built-in markers use a bare tag (e.g. `skull`, `red`).
- Multiple markers **stack** as a row of small icons across the token's top edge.
- `dead` is special: it renders as a **large red X over the whole token** (not a row icon).
- Color markers (`red`, `blue`, …) render as **solid colored dots**.
- **An unregistered tag is stored in `statusmarkers` but renders NOTHING.** This is the
  `bloodied` trap (see below). Persistence in the field ≠ rendering.
- To set arbitrary markers programmatically: `batch_exec` → `setTokenProps` with
  `props.statusmarkers = "tag1,tag2,…"`. `set_token_marker` resolves **any** state name
  through the three-tier system below (`resolveMarkerForState`: `CONDITION_MARKERS` →
  `PSEUDO_MARKERS` → hashed ad-hoc pool), so it always renders something — you rarely
  need raw tags.

## ⚠ `bloodied` does NOT render

`bloodied` is **not** a registered marker in this campaign. Several Mages were carrying
`statusmarkers:"bloodied"` and displaying **no icon at all**. Verified: applying only
`bloodied` shows nothing; applying `bloodied,Wounded::4444333` shows just the one Wounded
icon. **Use `Wounded::4444333` for "bloodied"** (red blood-drip icon). A `bloodied`→Wounded
alias lives in the relay's `PSEUDO_MARKERS` (not `CONDITION_MARKERS` — so a DDB condition-sync
won't sweep it), and `set_token_marker condition:"bloodied"` resolves it automatically.

---

## Tiered state system (implemented)

`set_token_marker` accepts **any** state name and the relay picks the icon + tracking by
tier — the agent (any model size) just speaks plain English; it never handles tags.

- **Tier 1a — true 5e conditions** (`CONDITION_MARKERS`): canonical icon **and** synced to the
  character's `active_conditions`. These are the only markers swept by a DDB condition-sync /
  "clear all conditions". (poisoned, prone, frightened, blinded, charmed, deafened, grappled,
  incapacitated, invisible, paralyzed, petrified, restrained, stunned, unconscious, exhaustion,
  dead.)
- **Tier 1b — pseudo-conditions** (`PSEUDO_MARKERS`): fixed well-known icon, DM-managed,
  **not** swept by sync. (bloodied→Wounded, concentrating, blessed, bane, hasted, raging,
  marked, hidden, dodging, enlarged, flying, sleeping, burning, surprised, cursed→Afflicted,
  disguised, featherfall, mirrorimage, magicweapon, buffed, drowning, illusion, disarmed,
  mute/silenced, dismembered — plus aliases.)
- **Tier 2 — ad-hoc DM states** (`AD_HOC_POOL` + `hashToPool`): any other name (e.g.
  `hunters-mark`, `lich-curse`, `charging-up`) deterministically hashes to an icon from the
  abstract built-in pool, and the binding + which tokens hold it are persisted in campaign
  state (`B().customStates`). `list_custom_states` / the `getCustomStates` relay action reports
  them. Determinism means no storage needed for the icon; distinct names can collide on an icon
  (visible in the listing). The pool is kept distinct from the meaningful condition/pseudo
  icons so iconography stays legible.

> Net for small models: the 7B says `set_token_marker condition:"<anything>"` and it always
> renders something sensible + is tracked — no tags, no list-reasoning, no silent no-ops.

---

## Reserved vs. Available (what an agent needs to know)

`get_token_markers` now returns the palette split into two buckets so the agent knows
which markers carry mechanical meaning:

- **RESERVED (16)** — tied to a 5e condition. Apply/clear via `set_token_marker` (by
  condition name), which *also* writes tracked condition state (`active_conditions`), and a
  DDB condition-sync may add/remove them. Don't repurpose these for decoration. Tags:
  `Unconscious::4444317` (unconscious/dead), `Wounded::4444333` (wounded/bloodied),
  `Poisoned::4444329`, `Blinded::4444318`, `Charmed::4444320`, `Deafened::4444321`,
  `Feared::4444323` (frightened), `Grappled::4444314`, `Incapacitated::4444325`,
  `Invisible::4444344`, `Paralyzed::4444327`, `Petrified::4444328`, `Prone::4444315`,
  `Restrained::4444316`, `Stunned::4444331`, `Exhausted::4444322`.
- **AVAILABLE (everything else)** — free for ad-hoc visual use (buffs, concentration, GM
  annotations). Apply by tag via `set_token_props`/`batch_exec` `statusmarkers`. Includes
  the non-condition customs (Concentrating, Blessed, Buffed, Hastened, Rage, Flying,
  Bane, Marked, …), all 47 built-in named icons, the 7 color dots, and `dead` (red-X).

---

## Custom markers (42) — tag = `Name::id`

These are the campaign's uploaded set (IDs 4444311–4444352). All render.

| Name | Tag |
|---|---|
| Illusion | `Illusion::4444311` |
| Dismembered | `Dismembered::4444312` |
| Concentrating | `Concentrating::4444313` |
| Grappled | `Grappled::4444314` |
| Prone | `Prone::4444315` |
| Restrained | `Restrained::4444316` |
| Unconscious | `Unconscious::4444317` |
| Blinded | `Blinded::4444318` |
| Burning | `Burning::4444319` |
| Charmed | `Charmed::4444320` |
| Deafened | `Deafened::4444321` |
| Exhausted | `Exhausted::4444322` |
| Feared | `Feared::4444323` |
| Disarmed | `Disarmed::4444324` |
| Incapacitated | `Incapacitated::4444325` |
| Mute | `Mute::4444326` |
| Paralyzed | `Paralyzed::4444327` |
| Petrified | `Petrified::4444328` |
| Poisoned | `Poisoned::4444329` |
| Sleeping | `Sleeping::4444330` |
| Stunned | `Stunned::4444331` |
| Suprised | `Suprised::4444332` *(note: misspelled in the set)* |
| Wounded | `Wounded::4444333` *(use for "bloodied")* |
| Dodging | `Dodging::4444334` |
| Hidden | `Hidden::4444335` |
| Buffed | `Buffed::4444336` |
| Buffed2 | `Buffed2::4444337` |
| Blessed | `Blessed::4444338` |
| Disguised | `Disguised::4444339` |
| Enlarged | `Enlarged::4444340` |
| Featherfall | `Featherfall::4444341` |
| Flying | `Flying::4444342` |
| Hastened | `Hastened::4444343` |
| Invisible | `Invisible::4444344` |
| MagicWeapon | `MagicWeapon::4444345` |
| MirrorImage | `MirrorImage::4444346` |
| Rage | `Rage::4444347` |
| Afflicted | `Afflicted::4444348` |
| Bane | `Bane::4444349` |
| Marked | `Marked::4444350` |
| Marked2 | `Marked2::4444351` |
| Drowning | `Drowning::4444352` |

## Built-in named markers (47) — tag = name

Roll20's default icon set (IDs 1–47). All render.

`skull`, `sleepy`, `half-heart`, `half-haze`, `interdiction`, `snail`, `lightning-helix`,
`spanner`, `chained-heart`, `chemical-bolt`, `death-zone`, `drink-me`, `edge-crack`,
`ninja-mask`, `stopwatch`, `fishing-net`, `overdrive`, `strong`, `fist`, `padlock`,
`three-leaves`, `fluffy-wing`, `pummeled`, `tread`, `arrowed`, `aura`, `back-pain`,
`black-flag`, `bleeding-eye`, `bolt-shield`, `broken-heart`, `cobweb`, `broken-shield`,
`flying-flag`, `radioactive`, `trophy`, `broken-skull`, `frozen-orb`, `rolling-bomb`,
`white-tower`, `grab`, `screaming`, `grenade`, `sentry-gun`, `all-for-one`,
`angel-outfit`, `archery-target`

## Built-in color dots (7) + dead

Not listed in `token_markers` (Roll20 hard-coded), but all render:

`red`, `blue`, `green`, `brown`, `purple`, `pink`, `yellow` — solid colored dots.
`dead` — **large red X overlaid on the whole token.**

> **Total renderable: 97** (42 custom + 47 built-in named + 7 colors + dead).

---

## `set_token_marker` name resolution (`resolveMarkerForState`)

`set_token_marker` calls `toggleCondition`, which resolves a friendly state name → tag via
the relay's three-tier `resolveMarkerForState` (mirrored in `src/bridge/markers.ts` and
`mod-scripts/ai-relay.js` — the Mod keeps its own copy):

1. **`CONDITION_MARKERS`** — true 5e conditions. Also writes tracked condition state and is
   the only tier swept by a DDB condition-sync / "clear all conditions".
2. **`PSEUDO_MARKERS`** — well-known fixed icons (buffs, concentration, bloodied→Wounded,
   etc.) plus aliases. Renders a real icon, DM-managed, **not** swept by sync.
3. **Hashed ad-hoc pool** — any other name deterministically hashes to a built-in icon
   (`AD_HOC_POOL`) and is persisted in campaign state (`B().customStates`).

Net: there is **no "unmapped → renders nothing" footgun** anymore. Any name passed to
`set_token_marker` resolves to a rendering icon at one of the three tiers. (Raw
`statusmarkers` writes via `setTokenProps`/`batch_exec` still bypass resolution, so a
literal unregistered tag written that way still renders nothing — see the `bloodied` trap.)

**`CONDITION_MARKERS` (tier 1):** `dead`/`unconscious` (→Unconscious),
`poisoned`, `blinded`, `charmed`, `deafened`, `frightened` (→Feared), `grappled`,
`incapacitated`, `invisible`, `paralyzed`, `petrified`, `prone`, `restrained`, `stunned`,
`exhaustion` (→Exhausted). Note: the TS `CONDITION_MARKERS` in `markers.ts` does **not**
include `wounded` (it lives in `PSEUDO_MARKERS` there); the `combat.ts` table used by
`get_token_markers` lists `wounded` in the RESERVED palette — both resolve to `Wounded::4444333`.

**`PSEUDO_MARKERS` (tier 2):** `bloodied`/`wounded`, `concentrating`/`concentration`,
`blessed`/`bless`, `bane`/`baned`, `hasted`/`hastened`/`haste`, `raging`/`rage`, `marked`,
`hidden`/`hiding`, `dodging`/`dodge`, `enlarged`, `flying`/`fly`, `sleeping`/`asleep`,
`burning`, `surprised`, `disguised`, `featherfall`, `mirrorimage`, `magicweapon`, `buffed`,
`drowning`, `afflicted`/`cursed`, `illusion`, `disarmed`, `mute`/`silenced`, `dismembered`.

**Note on `dead`:** it maps to the **Unconscious** icon (`Unconscious::4444317`), *not* the
built-in red-X overlay. Death handling in combat uses this (marker + move to map layer). If
you want the red-X instead, set `statusmarkers:"dead"` directly.

### Sync safety (resolved)

Buffs (Blessed, Buffed, Hastened, Rage, Concentrating, …) are deliberately in
`PSEUDO_MARKERS`, not `CONDITION_MARKERS`, because `syncConditionsToToken` builds its "clear
everything known" set only from `CONDITION_MARKERS`. Keeping buffs in the pseudo tier means a
DDB condition-sync never strips a manually-set buff/concentration marker. This is the
"separate validated path" that earlier versions of this doc flagged as future work — it now
exists as the `resolveMarkerForState` tiering.
