# Screenshots — capture guide

Visual assets for the README and wiki. Drop captured PNGs in [`assets/`](../assets) with the
filenames below; wire the image tags into the README / wiki page once the file exists.

`assets/*.png` is git-tracked (exempted from the repo-wide `*.png` ignore).

## Priority shots

### 1. The Voice HUD gem — ✅ CAPTURED
The scrying-gem overlay is the signature visual and **can't be captured headlessly**. Four shots
are committed and wired into the README + the **Voice HUD Gem** wiki page:
- `assets/gem-in-play.png` — the gem's tactic tray over a live Roll20 fight (hero).
- `assets/gem-tactics-tray.png` — the expanded tactic tray (current creature + other mobs).
- `assets/ledger-proper-nouns.png` — Scrying Ledger → Proper Nouns (STT vocab).
- `assets/ledger-nicknames.png` — Scrying Ledger → Nicknames.

Still nice-to-have: a shot of the **Inbox tab** with a classified `!dm` item (`assets/ledger-inbox.png`).

### 2. A provisioned lit map → `assets/roll20-map.png`
A battlemap with dynamic-lighting walls placed (blue `#0044FF`), doors, lit. Capture in Roll20, or
via the `screenshot_roll20` tool — `dlEditor:true` renders the walls as colored lines, which makes
the DL work legible.

⚠️ Use a **homemade / non-copyrighted map** for anything published publicly — module maps
(Phandelver, Curse of Strahd, …) are WotC's.

### 3. Custom token markers → `assets/token-markers.png`  *(optional)*
A token wearing the campaign's custom 5e-condition markers — makes
[`roll20-token-markers.md`](roll20-token-markers.md) concrete.

## Where each appears
| File | Used in |
|---|---|
| `assets/gem-hud.png` | top of the README; the **Voice HUD Gem** wiki page |
| `assets/roll20-map.png` | README maps section; `skills/dm-map-setup.md` |
| `assets/token-markers.png` | `docs/roll20-token-markers.md` |

## Adding one
Drop the PNG in `assets/`, then reference it, e.g. `![DM gem](assets/gem-hud.png)`.
