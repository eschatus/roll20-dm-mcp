# Moved — installer packaging lives in `dm-whisper`

Tombstoned 2026-08-26. Packaging DM Whisper into a one-click installer (#48, epic #49 Phase 4) is
the gem's build, and the gem is at **https://github.com/eschatus/dm-whisper** —
`electron-builder.yml`, `scripts/bundle:server`, `npm run dist:dir` / `npm run dist`, the whisper
binary + model staging, icons, and signing/notarization all live there. `release.yml` (the installer
CI workflow) moved with it on 2026-08-11; it only ever lived here because `.github/` sat at the repo
root while the subtree split moved just `voice-hud/`.

This file was the plan-and-open-decisions doc while that work was scaffolded here. Its remaining
checklist is the gem's to close.

## What stays true of THIS repo

- **The server ships as a dependency of the gem, and `package.json` is set up for it.** The `files`
  array (`dist`, `src`, `skills`, `mod-scripts`, `LICENSE`, `NOTICE`) plus the `prepare` build script
  exist precisely so a git install produces a usable server: with no `files` field npm falls back to
  `.gitignore`, which lists `dist/`, so `prepare` would build and npm would then discard the output.
  The `//files` comment in `package.json` records that trap — don't "tidy" either field away.
- **The Playwright question is settled, not deferred.** The plan's gating item was "esbuild the
  server with `--external:playwright` and verify it boots with the browser absent". There is no
  Playwright to externalize any more (#179): it is not a dependency, there are no lazy-require
  guards to get right, and no ~150 MB Chromium decision to make. A packaged install being
  browserless is now a property of the source, not of the bundler flags.
- **What the installer must furnish instead:** this server reads credentials and never mints them —
  `roll20-rt-token.json` (campaign-scoped) and `roll20-upload-cache.json` (8h TTL), both harvested by
  the gem, plus `ROLL20_MCP_TOKEN` persisted in the per-user data dir. `ANTHROPIC_API_KEY` is needed
  only by the **maps** suite's `analyze_battlemap`; the combat server makes no model call.
- **The Mod is not part of any installer.** `mod-scripts/ai-relay.js` is packed so the gem can hand
  it to the DM, but deploying it is a manual paste into each campaign's API console (#175).
