# Spike: `pathv2` as the zone drawing primitive (issue #208)

**Status: instrument built, live run PENDING.** Nothing below the "Results" heading is
answered yet — the questions can only be settled against a real Roll20 sandbox, and this
repo has no browser and no live campaign in CI. The probe is here so the run takes about
five minutes once someone has a campaign open.

## Why

Zones are drawn today as legacy `path` objects (`ACTIONS["createZone"]` in
`mod-scripts/ai-relay.js`), which carries two long-standing costs:

- **No working `fill_opacity`.** Roll20 silently drops the property on a `path`, so zone
  tint is baked into the fill colour instead — `withZoneAlpha()` appends
  `ZONE_FILL_ALPHA_HEX` to make `#aa00ff` into `#aa00ff40` (issue #162).
- **No `name`/`gmnotes`.** Both writes are silent no-ops on a `path`, so zone metadata
  lives in `state.GM_AI_Bridge.zones` (issue #164).
- **No circles.** A "circle" zone is a 36-point polygon (`makeCirclePath`).

The live Objects doc gives `pathv2` a **`fill`** property ("transparent" or a hex string)
and the shapes **`eli`** (ellipse) and **`rec`** (rectangle), where the first two points set
a bounding box. A spell area *is* an ellipse or a rectangle.

**Out of scope:** zone *metadata* stays in relay state regardless of the outcome. That is a
durable-semantics decision (#134/#135 — duration, concentration owner, terrain), not a
question about which object draws the shape. Only the drawing primitive is in question.

## The questions

| # | Question | Answerable from data? |
|---|----------|----------------------|
| Q1 | Does `pathv2` `fill` accept **`#RRGGBBAA`**? (The `pin` object's `bgColor` documents `#RRGGBBAA`, so alpha exists somewhere in the object model.) And does `pathv2` have a real `fill_opacity`, unlike `path`? | Storage yes, **rendering no** |
| Q2 | Does `shape: "eli"` render a proper circle for a Fireball / Spirit Guardians footprint, on the **object** layer rather than the walls layer? | **No — needs eyes** |
| Q3 | Does `pathv2` carry `name`/`gmnotes`? (The doc doesn't list them, so assume no.) | Yes |

## The instrument

`ACTIONS["pathv2ZoneProbe"]` (relay ≥ **2.9.0**) draws one `pathv2` per variant in a
left-to-right row on a page and reports, per variant, what it **sent** and what Roll20
**stored**:

| variant | shape | layer | fill | asks |
|---|---|---|---|---|
| `eli-fill8` | `eli` | objects | `#RRGGBBAA` | Q1 + Q2 — the candidate primitive |
| `eli-fill6` | `eli` | objects | `#RRGGBB` | Q1 control: opaque |
| `eli-fillopacity` | `eli` | objects | `#RRGGBB` + `fill_opacity: 0.25` | Q1 alternative |
| `eli-transparent` | `eli` | objects | `transparent` | Q2 control: outline only |
| `rec-fill8` | `rec` | objects | `#RRGGBBAA` | Q2 rectangle |
| `pol-fill8` | `pol` | objects | `#RRGGBBAA` | Q2 control: today's 36-gon |
| `eli-map-layer` | `eli` | **map** | `#RRGGBBAA` | Q2 layer check |
| `eli-meta` | `eli` | objects | `#RRGGBBAA` | Q3 — `name`/`gmnotes` at create *and* via a later `set()` |

Geometry follows the wall rule: **`pathv2` re-anchors to its first point regardless of the
`x`/`y` passed**, so `eli`/`rec` are built anchor-at-bounding-box-top-left with points
`[[0,0],[2r,2r]]`, and the `pol` control is anchored at its first point on the circle.

Two things the probe deliberately does NOT do:

- It does not clean up after itself. The objects are the evidence — you have to look at them.
- It does not treat a non-empty read-back as proof. A sandbox that drops a write can hand
  back `""` instead of `undefined`, so the probe echoes the exact strings it wrote
  (`wrote.atCreate` / `wrote.afterSet`) and the caller compares.

Offline coverage: `test/pathv2-zone-probe.test.ts` pins variant coverage, row layout,
anchor geometry and colour derivation against the emulator. It deliberately asserts
*nothing* about Q1–Q3 — the emulator is permissive exactly where the real sandbox silently
drops writes, which is how #162 and #164 shipped in the first place.

## Running it

1. Paste `mod-scripts/ai-relay.js` into the campaign's API console and confirm the banner
   reads `[GM_AI_Bridge] Relay script loaded (v2.9.0)`. (Mod deploys are human-attended and
   per-campaign — see CLAUDE.md.)
2. Pick a scratch page with visible map art underneath, so translucency is obvious.

```bash
tsx src/recon/pathv2-zone-probe.ts <pageId> [--campaign slug] [--x N --y N] [--radius PX]
```

The script prints, per variant: what was sent, what the Mod read back, and — via a direct
RTDB read of `pathv2/page/<pageId>/<id>` — what Roll20 actually persisted with no Mod
accessor in the way. It then scores Q1 and Q3, and tells you where on the page to look for
Q2.

3. **Open the page and look at the row.** Record what you see under "Results" below.
4. Clean up with the command the script prints:

```bash
tsx src/recon/pathv2-zone-probe.ts --rm <id,id,...> [--campaign slug]
```

## Results

_Not yet run. Fill in each row from a live pass, then decide._

| # | Verdict | Evidence |
|---|---------|----------|
| Q1 `fill` accepts `#RRGGBBAA` | TBD | |
| Q1 `fill_opacity` works on `pathv2` | TBD | |
| Q2 `eli` renders as a circle on the object layer | TBD | |
| Q2 `rec` renders as a rectangle | TBD | |
| Q2 renders on the `map` layer too | TBD | |
| Q3 carries `name`/`gmnotes` | TBD | |

## Decision

_Pending results._ The shape of the call:

- **If Q1 and Q2 both land** — `createZone` switches to `createObj("pathv2", { shape: "eli" | "rec" })`
  and `withZoneAlpha()`'s "UNVERIFIED against the live renderer" caveat is replaced by a real
  `fill`/`fill_opacity` answer. `makeCirclePath` stops being the circle approximation.
  `clearZone`/`listZones`/`findTokensInZone` all resolve zones through the id → state
  registry, not by object type, but `clearZone` calls `getObj("path", id)` directly and would
  need the `pathv2` type; existing zones drawn as `path` must keep working, so that becomes a
  try-`path`-then-`pathv2` lookup, not a swap.
- **If Q2 fails** (`eli` only renders on the walls layer, or not at all) — keep `path`, and
  record the negative here so nobody re-opens it.
- **Q3 changes nothing either way.** Metadata stays in `state.GM_AI_Bridge.zones`.
