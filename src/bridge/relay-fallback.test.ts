import { describe, it, expect, afterEach } from "vitest";

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
