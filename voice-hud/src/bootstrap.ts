// MUST be imported before ./config and the rest of main — its side effects set the
// data-dir env BEFORE any module reads it.
//
// PACKAGED app: point everything at a per-user dir (Electron's userData, e.g.
// %APPDATA%/<app> on Windows, ~/Library/Application Support/<app> on macOS) so an
// installed build never writes inside its own bundle. We set BOTH:
//   - DMW_DATA_DIR    → the gem's own files (hud.log, aar/, settings, base-vocab) +
//                       the shared campaign-context / active-campaign reads
//   - ROLL20_DATA_DIR → inherited by the MCP server the gem will supervise (Phase B),
//                       so both runtimes share ONE per-user dir (campaign registry,
//                       tokens, RT creds). Until B, a standalone server still defaults
//                       to ./data — the packaged flow launches it as a child.
//
// DEV (unpackaged): does NOTHING. The env stays unset, every path keeps its
// repo-relative default — no migration, no behavior change.
import { app } from "electron";
import * as fs from "fs";
import * as path from "path";

if (app.isPackaged && !process.env.DMW_DATA_DIR) {
  const dir = app.getPath("userData");
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* best effort */ }

  // First-run migration (conservative: copy, never move/delete). Only when an explicit
  // legacy dir is pointed at AND this per-user dir has no registry yet — so a fresh
  // install starts clean (the config wizard fills it) and an upgrader can carry data over
  // with DMW_LEGACY_DATA_DIR=<old data path>.
  try {
    const legacy = process.env.DMW_LEGACY_DATA_DIR;
    if (legacy && fs.existsSync(legacy) && !fs.existsSync(path.join(dir, "campaigns.json"))) {
      for (const f of fs.readdirSync(legacy)) {
        const src = path.join(legacy, f);
        const dst = path.join(dir, f);
        try { if (fs.statSync(src).isFile() && !fs.existsSync(dst)) fs.copyFileSync(src, dst); } catch { /* skip */ }
      }
    }
  } catch { /* migration is best-effort — never block startup */ }

  process.env.DMW_DATA_DIR = dir;
  process.env.ROLL20_DATA_DIR = dir;
  // Where bundled read-only assets live (whisper binary/model, skills/dm-rules.md) in a
  // packaged build. process.resourcesPath is reliable HERE (we're already in the packaged
  // branch); config.ts/persona.ts read DMW_ASSET_ROOT so they stay electron-free.
  process.env.DMW_ASSET_ROOT = process.resourcesPath;
}
