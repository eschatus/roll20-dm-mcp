// Expected version of the deployed Mod relay (mod-scripts/ai-relay.js), compiled in rather than
// read from disk — the server ships as a single esbuild bundle in the packaged gem and cannot
// read mod-scripts/ at runtime (see CLAUDE.md, "The Mod sandbox cannot import TS").
//
// This is the TS half of a hand-synced pair: mod-scripts/ai-relay.js's `AI_RELAY_VERSION` is the
// other half. test/relay-version.test.ts locks them together (same pattern as the condition→
// marker table lock in test/marker-tables.test.ts). Bump BOTH together when ai-relay.js changes
// in a way worth flagging to a DM running an older deploy — see src/bridge/relay-version-check.ts
// for how a mismatch gets reported.
export const EXPECTED_RELAY_VERSION = "2.2.0";
