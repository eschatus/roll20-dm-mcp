// ─────────────────────────────────────────────────────────────────────────────
// Layer 1 — relay action tests (the spine).
//
// Drives `!ai-relay` commands straight into the real ai-relay.js running in the
// emulator and asserts on game state + emitted whispers. No bridge, no tools —
// this is the fastest, most direct coverage of the 1,800-line relay, including
// the security/robustness fixes (GM gate, nonce replay, atomic turn-order merge).
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect, beforeEach } from "vitest";
import { Roll20Emulator } from "./roll20-emulator.js";

let emu: Roll20Emulator;

beforeEach(() => {
  emu = new Roll20Emulator({ seed: 42 });
  emu.load();
});

describe("GM-only sender gate", () => {
  it("rejects !ai-relay from a non-GM player (no result produced)", () => {
    const pageId = emu.createPage();
    emu.createToken({ pageid: pageId, name: "Goblin", bar1_value: 7, bar1_max: 7 });
    // A non-GM sender must be ignored — the handler returns before writeResult,
    // so relay() sees no result and throws.
    expect(() =>
      emu.relay({ action: "getTokens", pageId }, { playerid: "player-evil" })
    ).toThrow(/no result/i);
  });

  it("allows a GM sender", () => {
    const pageId = emu.createPage();
    emu.createToken({ pageid: pageId, name: "Goblin", bar1_value: 7, bar1_max: 7 });
    const tokens = emu.relay<unknown[]>({ action: "getTokens", pageId });
    expect(tokens.length).toBe(1);
  });
});

describe("atomic mergeTurnOrder", () => {
  it("preserves a player entry added out-of-band and sorts pr-descending", () => {
    // Simulate a player having set their own initiative in the Roll20 UI.
    emu.campaignModel.set("turnorder", JSON.stringify([{ id: "pc-1", pr: "17", custom: "" }]));

    const res = emu.relay<{ ok: boolean; turnorder: Array<{ id: string; pr: string }> }>({
      action: "mergeTurnOrder",
      entries: [
        { id: "gob-1", pr: "9", custom: "" },
        { id: "gob-2", pr: "21", custom: "" },
      ],
    });

    expect(res.ok).toBe(true);
    const ids = res.turnorder.map((e) => e.id);
    // Player entry survived the merge (the documented player-wipe race is closed).
    expect(ids).toContain("pc-1");
    // pr-descending, numeric (21 > 17 > 9).
    expect(res.turnorder.map((e) => e.pr)).toEqual(["21", "17", "9"]);
    expect(ids).toEqual(["gob-2", "pc-1", "gob-1"]);
  });

  it("upserts an existing id in place rather than duplicating it", () => {
    emu.campaignModel.set("turnorder", JSON.stringify([{ id: "gob-1", pr: "9", custom: "" }]));
    const res = emu.relay<{ turnorder: Array<{ id: string; pr: string }> }>({
      action: "mergeTurnOrder",
      entries: [{ id: "gob-1", pr: "25", custom: "" }],
    });
    expect(res.turnorder.filter((e) => e.id === "gob-1")).toHaveLength(1);
    expect(res.turnorder[0].pr).toBe("25");
  });
});

describe("same-nonce replay idempotency", () => {
  it("a resent nonce echoes the prior result and does NOT re-run advanceTurn", () => {
    emu.campaignModel.set(
      "turnorder",
      JSON.stringify([
        { id: "a", pr: "20", custom: "" },
        { id: "b", pr: "15", custom: "" },
        { id: "c", pr: "10", custom: "" },
      ])
    );

    const NONCE = 999001;
    const first = emu.relayWithNonce({ action: "advanceTurn" }, NONCE);
    const orderAfterFirst = emu.turnOrder().map((e) => e.id);
    expect(orderAfterFirst).toEqual(["b", "c", "a"]); // rotated once

    // Resend the SAME nonce — must be a no-op echo, order unchanged.
    const second = emu.relayWithNonce({ action: "advanceTurn" }, NONCE);
    const orderAfterSecond = emu.turnOrder().map((e) => e.id);
    expect(orderAfterSecond).toEqual(["b", "c", "a"]); // NOT rotated again
    expect(second).toEqual(first); // identical echoed result
  });
});

describe("conditions & status markers", () => {
  it("toggleCondition applies a true 5e condition marker and tracks it on the sheet", () => {
    const pageId = emu.createPage();
    const charId = emu.createCharacter("Goblin", {});
    const tok = emu.createToken({ pageid: pageId, name: "Goblin", represents: charId, bar1_value: 7, bar1_max: 7 });

    const res = emu.relay<{ ok: boolean; marker: string; tier: string }>({
      action: "toggleCondition",
      tokenId: tok.id,
      charId,
      condition: "poisoned",
      active: true,
    });
    expect(res.tier).toBe("condition");
    expect(emu.getObj("graphic", tok.id)!.get("statusmarkers")).toContain("Poisoned");

    // Clearing removes it.
    emu.relay({ action: "toggleCondition", tokenId: tok.id, charId, condition: "poisoned", active: false });
    expect(emu.getObj("graphic", tok.id)!.get("statusmarkers")).not.toContain("Poisoned");
  });

  it("an invented state becomes a tracked custom marker", () => {
    const pageId = emu.createPage();
    const tok = emu.createToken({ pageid: pageId, name: "Aldric", bar1_value: 30, bar1_max: 30 });
    const res = emu.relay<{ tier: string; marker: string }>({
      action: "toggleCondition",
      tokenId: tok.id,
      condition: "hunters-mark",
      active: true,
    });
    expect(res.tier).toBe("custom");
    expect(emu.getObj("graphic", tok.id)!.get("statusmarkers")).toContain(res.marker);
  });
});

describe("AoE / emanation geometry (findTokensInRange)", () => {
  it("returns only tokens within the radius, nearest-first", () => {
    const pageId = emu.createPage();
    // scale 5 → 70px = 5ft. Center at (700,700).
    const center = emu.createToken({ pageid: pageId, name: "Zeno", left: 700, top: 700, bar1_value: 45, bar1_max: 45 });
    const near = emu.createToken({ pageid: pageId, name: "Cleric", left: 700 + 70, top: 700, bar1_value: 24, bar1_max: 24 });   // 5ft
    const mid  = emu.createToken({ pageid: pageId, name: "Fighter", left: 700 + 140, top: 700, bar1_value: 30, bar1_max: 30 }); // 10ft
    const far  = emu.createToken({ pageid: pageId, name: "Archer", left: 700 + 70 * 6, top: 700, bar1_value: 18, bar1_max: 18 }); // 30ft

    const hits = emu.relay<Array<{ id: string; distanceFeet: number }>>({
      action: "findTokensInRange",
      centerTokenId: center.id,
      radiusFeet: 15, // Spirit Guardians emanation
      pageId,
      layerFilter: "objects",
    });
    const ids = hits.map((h) => h.id);
    expect(ids).toContain(near.id);
    expect(ids).toContain(mid.id);
    expect(ids).not.toContain(far.id); // 30ft is outside a 15ft emanation
    expect(ids).not.toContain(center.id); // the center never returns itself
    // Sorted nearest-first.
    expect(hits[0].id).toBe(near.id);
    expect(hits[0].distanceFeet).toBeCloseTo(5, 1);
  });
});

describe("getTurnOrder", () => {
  it("returns the parsed turn order array", () => {
    emu.campaignModel.set("turnorder", JSON.stringify([{ id: "a", pr: "20", custom: "" }]));
    const order = emu.relay<Array<{ id: string; pr: string }>>({ action: "getTurnOrder" });
    expect(order).toEqual([{ id: "a", pr: "20", custom: "" }]);
  });
  it("returns [] when empty", () => {
    expect(emu.relay({ action: "getTurnOrder" })).toEqual([]);
  });
});

describe("syncConditionsToToken", () => {
  it("replaces the token's condition markers with exactly the active set", () => {
    const pageId = emu.createPage();
    const charId = emu.createCharacter("Goblin", {});
    const tok = emu.createToken({ pageid: pageId, name: "Goblin", represents: charId, bar1_value: 7, bar1_max: 7 });
    // Seed a stale marker, then sync to a different set.
    emu.relay({ action: "toggleCondition", tokenId: tok.id, charId, condition: "poisoned", active: true });
    const res = emu.relay<{ ok: boolean; conditions: string[] }>({
      action: "syncConditionsToToken",
      tokenId: tok.id,
      charId,
      conditions: ["prone", "stunned"],
    });
    expect(res.conditions.sort()).toEqual(["prone", "stunned"]);
    const markers = emu.getObj("graphic", tok.id)!.get("statusmarkers") as string;
    expect(markers).not.toContain("Poisoned"); // stale one removed
    expect(markers).toContain("Prone");
    expect(markers).toContain("Stunned");
  });
});

describe("setTokenBar write", () => {
  it("sets absolute HP on the token", () => {
    const pageId = emu.createPage();
    const tok = emu.createToken({ pageid: pageId, name: "Goblin", bar1_value: 7, bar1_max: 7 });
    emu.relay({ action: "setTokenBar", tokenId: tok.id, value: 2, max: 7 });
    expect(Number(emu.getObj("graphic", tok.id)!.get("bar1_value"))).toBe(2);
  });
});
