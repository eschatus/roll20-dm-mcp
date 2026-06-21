# Wiki staging (`wiki/`)

Publish-ready GitHub **wiki** pages for the user-facing guides. The wiki is a *separate* git
repo — it doesn't show in PRs and doesn't version with the code — so we stage the pages here
and publish them deliberately.

**Why these three:** `Setup`, `Voice-HUD-Gem`, and `Player-Commands` have a broad audience
(DMs and **players**) who won't clone the repo — they need a URL. Code-coupled docs
(protocols, decisions, API coverage, security) stay in `docs/` so they track the code.

**Files:** `Home.md`, `Setup.md`, `Voice-HUD-Gem.md`, `Player-Commands.md`, `_Sidebar.md`.
They mirror `docs/setup-guide.md`, `docs/gem-guide.md`, `docs/player-commands.md` verbatim
(plus a nav header).

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

## Keeping in sync

The `docs/` copies stay canonical-in-repo; treat these as generated. When a source doc changes,
re-stage:

```sh
for p in "setup-guide:Setup" "gem-guide:Voice-HUD-Gem" "player-commands:Player-Commands"; do
  src="docs/${p%%:*}.md"; dst="wiki/${p##*:}.md"
  { printf '> 📖 **roll20-dm-mcp wiki** · [Home](Home) · [Setup](Setup) · [Voice HUD Gem](Voice-HUD-Gem) · [Player Commands](Player-Commands)\n\n'; cat "$src"; } > "$dst"
done
```

(Once the wiki is live, consider slimming the `docs/` user-facing trio to a one-line pointer at
the wiki page to kill the duplication.)
