// The server's own build version, announced to every MCP caller (the gem, Claude Code, any
// other client) via the McpServer `version` field in its serverInfo handshake.
//
// Compiled in rather than read from package.json at runtime: the server ships as a single
// esbuild bundle inside the packaged gem, where there is no package.json next to the code.
// test/build-version.test.ts locks this to package.json's "version" so the two cannot drift —
// same hand-synced-pair pattern as EXPECTED_RELAY_VERSION (src/bridge/relay-version.ts) and the
// condition→marker tables (test/marker-tables.test.ts).
//
// Why it matters: a caller that cannot see which server build it is talking to cannot tell a
// stale install from a current one. The gem shipped for weeks against a server bundle nine days
// older than its own build with nothing reporting the gap (roll20-dm-mcp, 2026-08-18).
export const BUILD_VERSION = "1.0.0";
