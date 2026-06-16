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

// Allow the tactics module's module-level `new Anthropic()` to construct. The CI
// suites inject a mock client; only the live-eval suite uses a real key, which a
// developer supplies explicitly (we never overwrite it here).
process.env.ANTHROPIC_API_KEY ??= "test-key-not-used-by-mock";
