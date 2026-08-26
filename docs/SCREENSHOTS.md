# Screenshots — capture guide

Visual assets for the README and wiki. Drop captured PNGs in [`assets/`](../assets) with the
filenames below; wire the image tags into the README / wiki page once the file exists.

`assets/*.png` is git-tracked (exempted from the repo-wide `*.png` ignore).

## Priority shots

### 1. The Voice HUD gem — ✅ CAPTURED (now the gem repo's business)
The scrying-gem overlay is the signature visual and **can't be captured headlessly**. Four shots
are committed here and wired into the README + the **Voice HUD Gem** wiki page:
- `assets/gem-in-play.png` — the gem's tactic tray over a live Roll20 fight (hero).
- `assets/gem-tactics-tray.png` — the expanded tactic tray (current creature + other mobs).
- `assets/ledger-proper-nouns.png` — Scrying Ledger → Proper Nouns (STT vocab).
- `assets/ledger-nicknames.png` — Scrying Ledger → Nicknames.

> The gem itself moved to **dm-whisper** on 2026-08-11, so **new** gem shots belong there. These
> four stay because this repo's README and wiki still show them.

### 2. A provisioned lit map → `assets/roll20-map.png`
A battlemap with dynamic-lighting walls placed (blue `#0044FF`), doors, lit. **Capture it by hand in
Roll20** (turn on the DL editor so the walls render as colored lines — that's what makes the work
legible). The old `screenshot_roll20` tool is **gone** (#179): it needed Playwright, and this repo
has no browser at all, so there is no headless capture path here for anything Roll20 renders.

⚠️ Use a **homemade / non-copyrighted map** for anything published publicly — module maps
(Phandelver, Curse of Strahd, …) are WotC's.

### 3. Custom token markers → `assets/token-markers.png`  *(optional)*
A token wearing the campaign's custom 5e-condition markers — makes
[`roll20-token-markers.md`](roll20-token-markers.md) concrete.

## Where each appears
| File | Used in |
|---|---|
| `assets/gem-in-play.png` | top of the README; the **Voice HUD Gem** wiki page |
| `assets/roll20-map.png` | README maps section; `skills/dm-map-setup.md` |
| `assets/token-markers.png` | `docs/roll20-token-markers.md` |

## Adding one
Drop the PNG in `assets/`, then reference it, e.g. `![DM gem](assets/gem-in-play.png)`.
