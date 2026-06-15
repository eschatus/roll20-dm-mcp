import { describe, it, expect, vi, afterEach } from "vitest";
import { shouldFallback } from "./roll20.js";
import { RtPreSendError } from "./roll20-rt.js";

const timeoutErr = new Error("rt relay timeout after 30000ms for action: apply_damage");
const preSendErr = new RtPreSendError("rt pre-send (getConn): auth failed");

describe("shouldFallback", () => {
  it("(a) read-only timeout: falls back", () => {
    expect(shouldFallback("getTokens", timeoutErr)).toBe(true);
  });

  it("(a) read-only pre-send: falls back", () => {
    expect(shouldFallback("getTurnOrder", preSendErr)).toBe(true);
  });

  it("(b) mutating post-send timeout: NOW falls back (same-nonce resend is idempotent via Mod LRU)", () => {
    // Previously this returned false to prevent double-apply. Now that the Mod's
    // PROCESSED_NONCES LRU deduplicates same-nonce resends, and relayCommand threads
    // the same nonce into the fallback transport, this is safe.
    expect(shouldFallback("apply_damage", timeoutErr)).toBe(true);
    expect(shouldFallback("update_token_hp", timeoutErr)).toBe(true);
    expect(shouldFallback("advance_turn", timeoutErr)).toBe(true);
  });

  it("(c) mutating pre-send failure: falls back", () => {
    expect(shouldFallback("apply_damage", preSendErr)).toBe(true);
    expect(shouldFallback("advance_turn", preSendErr)).toBe(true);
  });

  it("(d) any action with any error: always falls back", () => {
    // shouldFallback is now unconditionally true — the nonce thread-through in
    // relayCommand is the mechanism that prevents double-apply, not the fallback gate.
    const genericErr = new Error("connection reset");
    expect(shouldFallback("createObj", genericErr)).toBe(true);
    expect(shouldFallback("batchExec", timeoutErr)).toBe(true);
    expect(shouldFallback("send_narration", preSendErr)).toBe(true);
  });
});

describe("relayCommand nonce pass-through (via __setBridgeTestTransport)", () => {
  // These tests verify that relayCommand generates a nonce and uses the test transport.
  // We cannot observe the exact nonce value from outside, but we can verify that:
  //   1. The test transport receives the command (relay is called)
  //   2. Multiple calls get distinct commands handled correctly

  afterEach(async () => {
    // Reset the test transport after each test
    const { __setBridgeTestTransport } = await import("./roll20.js");
    __setBridgeTestTransport(null);
  });

  it("routes commands through the test transport when set", async () => {
    const { relayCommand, __setBridgeTestTransport } = await import("./roll20.js");
    const received: Record<string, unknown>[] = [];
    __setBridgeTestTransport({
      relay: async (cmd) => { received.push(cmd); return { ok: true } as unknown; },
      evaluate: async (fn, args) => fn(args),
    });
    await relayCommand({ action: "getTokens", pageId: "p1" });
    expect(received).toHaveLength(1);
    expect(received[0].action).toBe("getTokens");
  });

  it("sequential calls each reach the transport", async () => {
    const { relayCommand, __setBridgeTestTransport } = await import("./roll20.js");
    const actions: string[] = [];
    __setBridgeTestTransport({
      relay: async (cmd) => { actions.push(cmd.action as string); return null as unknown; },
      evaluate: async (fn, args) => fn(args),
    });
    await relayCommand({ action: "getTokens" });
    await relayCommand({ action: "getTurnOrder" });
    expect(actions).toEqual(["getTokens", "getTurnOrder"]);
  });
});
