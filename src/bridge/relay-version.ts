// Expected version of the deployed Mod relay (mod-scripts/ai-relay.js), compiled in rather than
// read from disk — the server ships as a single esbuild bundle in the packaged gem and cannot
// read mod-scripts/ at runtime (see CLAUDE.md, "The Mod sandbox cannot import TS").
//
// This is the TS half of a hand-synced pair: mod-scripts/ai-relay.js's `AI_RELAY_VERSION` is the
// other half. test/relay-version.test.ts locks them together (same pattern as the condition→
// marker table lock in test/marker-tables.test.ts). Bump BOTH together when ai-relay.js changes
// in a way worth flagging to a DM running an older deploy — see src/bridge/relay-version-check.ts
// for how a mismatch gets reported.
export const EXPECTED_RELAY_VERSION = "2.10.0";

// The first relay version whose `mergeTurnOrder` honours `keepTurn` (issue #217). An older relay
// ignores the flag and runs the legacy pr-descending sort, which rotates the active turn back to
// the top and trips the turn hook, so a caller that needs keepTurn must refuse to write against
// anything older rather than let the flag be silently dropped.
export const KEEP_TURN_MIN_RELAY_VERSION = "2.9.0";

// true when `found` is a dotted numeric version >= `min`; false when it is older OR unparseable.
// Unparseable counts as "not new enough" on purpose: every caller uses this as a safety floor,
// and a version string it can't read is not evidence the floor is met.
export function relayVersionAtLeast(found: string | null | undefined, min: string): boolean {
  const parse = (s: string) => (/^\d+(\.\d+)*$/.test(s) ? s.split(".").map(Number) : null);
  const a = found ? parse(found.trim()) : null;
  const b = parse(min);
  if (!a || !b) return false;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return true;
}
