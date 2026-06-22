# Packaging DM Whisper into an installer (#48, epic #49 Phase 4)

Goal: a one-click installer a non-savvy DM runs — no terminal, no Python, no Node, no Claude
Code. The gem launches + supervises everything (Phase B, #53) on a per-user data dir (Phase 1).

**Status: scaffold.** The gem-side config + asset paths are wired; the **server bundle** is the
remaining work before `npm run dist` yields a *working* installer. This doc is the plan + the open
decisions.

## What's wired (this PR)
- **`voice-hud/electron-builder.yml`** — appId/product, asar `files`, `asarUnpack` for the native
  `uiohook-napi`, `extraResources` for `skills/`, the CPU whisper binary, the `base.en` model, and
  the server bundle; NSIS (win) + dmg (mac) targets.
- **Runtime asset paths are packaged-aware** (`bootstrap.ts` exports `DMW_ASSET_ROOT=resourcesPath`
  when `app.isPackaged`; `config.ts` whisper paths + `persona.ts` skills path read it). Dev unchanged.
- **Scripts:** `bundle:server` (esbuild), `dist:dir` (unpacked, for testing), `dist` (installer).

## The hard part: bundling the server
The MCP server (`src/`) is a full Node app with heavy deps. It can't ship as raw `dist/` (no
`node_modules`). Plan:

1. **esbuild it to one file.** `npm run bundle:server` → `dist-server/dist/index-http.js` (CJS),
   which `extraResources` ships to `<resources>/server/dist/index-http.js` — exactly what
   `serverSupervisor.buildServerSpawn(packaged)` spawns. esbuild inlines `firebase`,
   `@modelcontextprotocol/sdk`, `@anthropic-ai/sdk`, etc.
2. **Exclude Playwright** (`--external:playwright`). It's the browser *fallback* only; a packaged
   gem-primary user runs **browserless** (`ROLL20_TRANSPORT=rt` + `DDB_COBALT`), so Chromium
   (~150 MB + a browser download) isn't needed at runtime. The RT token + cobalt are harvested by
   the config wizard (#47). If a build ever needs the fallback, ship Playwright as an optional
   component. **Verify the esbuild bundle boots with playwright external** (lazy-require guards in
   `roll20.ts`/`browser.ts` so an absent Playwright doesn't crash import).

## Open decisions / TODO before a working installer
- [ ] **esbuild server bundle** boots under Electron-as-Node with Playwright external (lazy-require
      the browser path). This is the gating item.
- [ ] **Native rebuild:** confirm electron-builder runs `@electron/rebuild` for `uiohook-napi`
      against Electron 33's ABI (it should, on install in the build env).
- [ ] **Model bundling:** ship `base.en` (~150 MB) as the offline floor. `medium.en` (the chosen
      default, ~1.5 GB) + the cuBLAS/Metal **GPU** builds are too big/platform-specific to bundle —
      the **wizard (#47) downloads** the hardware-appropriate model + GPU binary on first run. (So
      the bundled default is `base.en`; the wizard upgrades to `medium.en` per the rig decision.)
- [ ] **whisper binary in `data/whisper/`** must be present at build time (CPU `whisper-cli.exe` +
      `whisper-server.exe`). On macOS, ship the Metal build (or `brew install whisper-cpp` path).
- [ ] **Icons:** `build/icon.ico` (win) + `build/icon.icns` (mac).
- [ ] **Signing/notarization:** win `CSC_LINK`/`CSC_KEY_PASSWORD`; mac hardenedRuntime + notarize
      (needed for Bill's M4 to run it without Gatekeeper friction).
- [ ] **First-run token bootstrap:** the server auto-generates `ROLL20_MCP_TOKEN` into `.env` today;
      packaged, that must persist in the per-user dir and be shared with the gem (wizard, #47).
- [ ] **`.env` / API key:** packaged has no repo `.env` — the wizard collects `ANTHROPIC_API_KEY`
      and writes it to the per-user dir.

## Build (once the above lands)
```sh
cd voice-hud
npm install                 # pulls electron-builder + esbuild; rebuilds uiohook-napi for Electron
npm run dist:dir            # unpacked build in release/ — smoke-test the packaged app first
npm run dist                # the installer (NSIS .exe / .dmg) in release/
```
`dist:dir` first — the packaged-only code paths (DMW_ASSET_ROOT, app.isPackaged supervision, the
server spawn) only execute in a real build, so that's where the remaining path bugs surface.
