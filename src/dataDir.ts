import * as path from "path";

// Single source of truth for the directory holding live server state + credentials:
// the campaign registry, RT/DDB tokens, relay state, upload/monster caches, the
// browser session, campaign-context, etc.
//
// Override with ROLL20_DATA_DIR — the installer / supervising gem points this at a
// per-user dir (e.g. %APPDATA%/dm-whisper) so a packaged install never writes inside
// the app bundle. Defaults to ./data (cwd-relative) so dev behavior is byte-identical
// to before. Resolved lazily (per call) so a test or the launcher can set the env
// after import and still be honored.
export const dataDir = (): string => path.resolve(process.env.ROLL20_DATA_DIR ?? "./data");

// Join one or more segments onto the data dir. Use this instead of hardcoding
// `path.resolve("./data/...")` so every path tracks ROLL20_DATA_DIR.
export const dataPath = (...segments: string[]): string => path.join(dataDir(), ...segments);
