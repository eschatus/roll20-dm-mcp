// Vitest global setup — runs before each test file's imports.
// Isolates the file-based registries to a throwaway dir and provides the env the
// modules read at import time, WITHOUT clobbering a real key the user supplied
// for the live-eval suite.
import * as fs from "fs";
import * as path from "path";

// Vitest runs test files across parallel worker processes. If they all share one
// data dir, concurrent register()/save() churn on the same JSON file races and a
// reader can catch a truncated write ("Unexpected end of JSON input"). Give each
// worker process its own dir (keyed by pid) so the file-based registries never
// collide across workers. An explicitly-provided ROLL20_DATA_DIR (live-eval, a
// single file) is respected as-is.
const dataDir = process.env.ROLL20_DATA_DIR
  ? path.resolve(process.env.ROLL20_DATA_DIR)
  : path.resolve(".tmp-test-data", `w${process.pid}`);
process.env.ROLL20_DATA_DIR = dataDir;
fs.mkdirSync(dataDir, { recursive: true });

// Single-campaign env fallback so getActiveCampaign() resolves without disk.
process.env.ROLL20_CAMPAIGN_ID ??= "test-roll20";
process.env.DDB_CAMPAIGN_ID ??= "test-ddb";

// Allows the maps suite's vision module (`src/tools/vision.ts`) to construct its
// module-level `new Anthropic()` when a test imports it — analyze_battlemap is the
// only model call left in this repo and no test invokes it, so the value is never
// used. The combat server reaches no Anthropic code at all since #171 Phase 2.
process.env.ANTHROPIC_API_KEY ??= "test-key-never-used";
