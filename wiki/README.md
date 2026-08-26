# Wiki staging (`wiki/`)

Publish-ready GitHub **wiki** pages for the user-facing guides. The wiki is a *separate* git
repo — it doesn't show in PRs and doesn't version with the code — so we stage the pages here
and publish them deliberately.

**Why these:** `Setup` and `Voice-HUD-Gem` have an audience that won't clone the repo — they need
a URL. Code-coupled docs (protocols, decisions, API coverage, security) stay in `docs/` so they
track the code.

**Files:** `Home.md`, `Setup.md`, `Voice-HUD-Gem.md`, `_Sidebar.md`.

- `Setup.md` mirrors `docs/setup-guide.md` verbatim, plus a nav header — regenerate it rather than
  editing it by hand (see [Keeping in sync](#keeping-in-sync)).
- `Home.md`, `Voice-HUD-Gem.md`, and `_Sidebar.md` have no source doc in `docs/` and are edited
  here directly.

> **Removed:** there is no `Player-Commands` page. Player `!`-commands are answered by the DM
> Whisper gem now, not by this server, so that page belongs in the
> [dm-whisper](https://github.com/eschatus/dm-whisper) repo. (The page had been linked from every
> nav header for a while without ever existing — every one of those links 404'd.) Likewise
> `Voice-HUD-Gem.md` no longer mirrors `docs/gem-guide.md`: the Gem is canonical in its own repo,
> and this page is a pointer plus the server side of the seam.

## Publish

The `…wiki.git` repo doesn't exist until the wiki has at least one page, so initialize it once
via the web UI, then push:

1. **Repo → Settings → Features → Wikis** (enable), then the **Wiki** tab → **Create the first page**
   (any content — it just bootstraps the repo).
2. Push the staged pages:
   ```sh
   git clone https://github.com/eschatus/roll20-dm-mcp.wiki.git
   cp wiki/*.md roll20-dm-mcp.wiki/
   cd roll20-dm-mcp.wiki && git add . && git commit -m "Publish user guides" && git push
   ```
   (`README.md` is this note — don't copy it to the wiki.)

## Keeping in sync

`docs/setup-guide.md` stays canonical in-repo; treat `wiki/Setup.md` as generated. When the source
doc changes, re-stage:

```sh
{ printf '> 📖 **roll20-dm-mcp wiki** · [Home](Home) · [Setup](Setup) · [Voice HUD Gem](Voice-HUD-Gem)\n\n'; \
  cat docs/setup-guide.md; } > wiki/Setup.md
```

(Once the wiki is live, consider slimming `docs/setup-guide.md` to a one-line pointer at the wiki
page to kill the duplication.)
