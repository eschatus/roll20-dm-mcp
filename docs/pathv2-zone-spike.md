# Spike: `pathv2` as the zone drawing primitive (issue #208)

**Status: run live on cos-test, 2026-11-03 (relay 2.10.0). Q1 and Q2 landed; see Results.** The
follow-up that moves `createZone` onto `pathv2` is not done. The probe stays until it is.

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
**stored**. The row **wraps** onto a new row before a shape would cross the page's right
edge (page `width` is in 70px units; an unreadable size is treated as Roll20's 25-unit
default), and any shape that still cannot fit is flagged `offPage` in the report:

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
- It does not score from the Mod's read-back. The Mod's `obj.get()` can echo a property the
  persisted record never got, so the script scores Q1/Q3 from the **direct RTDB record** and
  prints `MISMATCH` wherever the echo and the record disagree (no record → `UNKNOWN`).
- It does not treat a non-empty read-back as proof. A sandbox that drops a write can hand
  back `""` instead of `undefined`, so the probe echoes the exact strings it wrote
  (`wrote.atCreate` / `wrote.afterSet`) and the caller compares.

Offline coverage: `test/pathv2-zone-probe.test.ts` pins variant coverage, row layout and
wrap, anchor geometry, colour derivation and the id stash against the emulator;
`test/pathv2-zone-probe-script.test.ts` drives the recon script itself through
`roll20.__setBridgeTestTransport` with a mocked `rtGet`, pinning RTDB-based verdicts,
`MISMATCH`/`UNKNOWN` reporting and cleanup exit codes. It deliberately asserts
*nothing* about Q1–Q3 — the emulator is permissive exactly where the real sandbox silently
drops writes, which is how #162 and #164 shipped in the first place.

## Running it

1. **Use a scratch CAMPAIGN, not a scratch page in a live one.** The probe creates shapes
   Roll20 has never been sent from this relay (`eli`/`rec`, 8-digit fills, `fill_opacity`,
   `name`/`gmnotes` on a `pathv2`). If one of them trips a deferred `_doSave` crash, it
   fires asynchronously after the action returns — uncatchable — and **disables the whole
   campaign's Mod sandbox**, not just that page. Don't find that out mid-session.
2. Paste `mod-scripts/ai-relay.js` into that campaign's API console and confirm the banner
   reads `[GM_AI_Bridge] Relay script loaded (v2.9.0)`. (Mod deploys are human-attended and
   per-campaign — see CLAUDE.md.)
3. Pick a page with visible map art underneath, so translucency is obvious.

```bash
tsx src/recon/pathv2-zone-probe.ts <pageId> [--campaign slug] [--x N --y N] [--radius PX]
```

The script prints, per variant: what was sent, what the Mod read back, and — via a direct
RTDB read of `paths/page/<pageId>/<id>` (pathv2 objects live in the `paths` node) — what Roll20 actually persisted with no Mod
accessor in the way. It then scores Q1 and Q3 **from that RTDB record**, and tells you where
on the page to look for Q2.

4. **Open the page and look at the row(s).** Record what you see under "Results" below.
5. Clean up:

```bash
tsx src/recon/pathv2-zone-probe.ts --rm-last [--campaign slug]
```

`--rm-last` needs no ids. The relay stashes every id it creates in
`state.GM_AI_Bridge.pathv2Probe` (`{ pageId, ids, at }`) before it replies, so the shapes stay
recoverable even if the result was lost or the terminal closed; the stash accumulates across
runs until cleared. `--rm-last` removes every stashed id (ids already deleted by hand are
reported as "already gone") and clears the stash; any id it fails to remove stays stashed for
a retry. By hand, `--rm <id,id,...>` removes specific ids. Both exit non-zero if any removal
failed.

## Results

Live pass on cos-test, 2026-11-03: sandbox 1.5, relay 2.10.0, over a battlemap. Data verdicts come
from the RTDB record; render verdicts from a screenshot of the open page.

| # | Verdict | Evidence |
|---|---------|----------|
| Q1 `fill` accepts `#RRGGBBAA` | **Yes** | Stored as `#aa00ff40`, and the map shows through it. |
| Q1 `fill_opacity` works on `pathv2` | **No** | Absent from the record, and `eli-fillopacity` renders as opaque as `eli-fill6`. |
| Q2 `eli` renders as a circle on the object layer | **Yes** | A clean circle. `eli-transparent` shows an outline only. |
| Q2 `rec` renders as a rectangle | **Yes** | A translucent square. |
| Q2 renders on the `map` layer too | **Yes** | `eli-map-layer` renders, translucent. |
| Q3 carries `name`/`gmnotes` | **No** | Neither key is in the record, at create or after `set()`. |

The `pol` control rendered, but offset down and right of its slot, which is the known pathv2
re-anchoring (see CLAUDE.md). `eli` and `rec` landed where expected, which is a further reason to
prefer them.

## Decision

**Once the Results table is filled, delete `ACTIONS["pathv2ZoneProbe"]`** (and its recon
script and tests). It is a spike instrument, not a feature: it must not ship in relays
indefinitely.

**Q1 and Q2 landed, so the first branch below applies:** use `shape: "eli"` or `"rec"` with an
8-digit `fill`, and drop any idea of `fill_opacity`. The original options, for the record:

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
