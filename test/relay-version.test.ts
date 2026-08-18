// ─────────────────────────────────────────────────────────────────────────────
// The relay's version is a hand-synced pair (the Mod can't import TS, CLAUDE.md
// "hand-synced copies"): mod-scripts/ai-relay.js's `AI_RELAY_VERSION` constant, and
// src/bridge/relay-version.ts's `EXPECTED_RELAY_VERSION`. This locks them together,
// same pattern as test/marker-tables.test.ts locking the condition→marker tables.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { EXPECTED_RELAY_VERSION } from "../src/bridge/relay-version.js";
import {
  reportRelayVersion,
  getRelayVersionMismatch,
  _resetRelayVersionCheckForTest,
} from "../src/bridge/relay-version-check.js";
import { Roll20Emulator } from "./roll20-emulator.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RELAY_PATH = path.join(__dirname, "..", "mod-scripts", "ai-relay.js");

function parseRelayVersion(): string {
  const src = readFileSync(RELAY_PATH, "utf8");
  const m = src.match(/var\s+AI_RELAY_VERSION\s*=\s*"([^"]+)"/);
  if (!m) throw new Error("AI_RELAY_VERSION constant not found in mod-scripts/ai-relay.js");
  return m[1];
}

describe("ai-relay.js AI_RELAY_VERSION ↔ relay-version.ts EXPECTED_RELAY_VERSION agree", () => {
  it("the parsed relay constant equals the compiled-in expected version", () => {
    expect(parseRelayVersion()).toBe(EXPECTED_RELAY_VERSION);
  });

  it("ACTIONS[\"ping\"] actually echoes AI_RELAY_VERSION (not a stale inline literal)", () => {
    // Exercises the real ai-relay.js (loaded into a vm by the emulator) rather than trusting the
    // source text alone — proves the constant is wired into ping's response, not just declared.
    const emu = new Roll20Emulator({ seed: 1 });
    emu.load();
    const res = emu.relay<{ pong: boolean; version: string }>({ action: "ping" });
    expect(res.version).toBe(parseRelayVersion());
    expect(res.version).toBe(EXPECTED_RELAY_VERSION);
  });
});

describe("reportRelayVersion — clash detection and reporting", () => {
  beforeEach(() => {
    _resetRelayVersionCheckForTest();
  });

  it("does nothing when the found version matches EXPECTED_RELAY_VERSION", () => {
    reportRelayVersion(EXPECTED_RELAY_VERSION);
    expect(getRelayVersionMismatch()).toBeNull();
  });

  it("does nothing when found is missing (older relay / no version field)", () => {
    reportRelayVersion(undefined);
    reportRelayVersion(null);
    expect(getRelayVersionMismatch()).toBeNull();
  });

  it("reports a clash and logs an actionable warning exactly once when found != expected", () => {
    const errors: unknown[][] = [];
    const spy = (...args: unknown[]) => { errors.push(args); };
    const original = console.error;
    console.error = spy;
    try {
      // Deliberately feed a version that does not match what this build expects — simulates a
      // stale/wrong-build deploy (the real incident this handshake exists for).
      reportRelayVersion("2.1.0");
      reportRelayVersion("2.1.0"); // second call must NOT double-report
    } finally {
      console.error = original;
    }

    expect(getRelayVersionMismatch()).toEqual({ expected: EXPECTED_RELAY_VERSION, found: "2.1.0" });
    expect(errors).toHaveLength(1);
    const text = String(errors[0][0]);
    // Actionable and free of internal plumbing (no "circuit breaker"/"transport" jargon) —
    // states found vs. expected and the exact fix command.
    expect(text).toContain("out of date");
    expect(text).toContain("found 2.1.0");
    expect(text).toContain(`expected ${EXPECTED_RELAY_VERSION}`);
    expect(text).toContain("npm run release:mod");
    expect(text).not.toMatch(/circuit.?breaker/i);
  });
});
