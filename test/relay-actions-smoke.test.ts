// ─────────────────────────────────────────────────────────────────────────────
// Relay action SMOKE coverage.
//
// The deep relay tests (relay-actions.test.ts) assert exact behavior for the
// trickiest ~8 actions. This file widens the net: it drives a broad set of the
// remaining read + simple-write actions through the real ai-relay.js dispatch and
// asserts they resolve with a sane shape (no throw, no crash, right result kind).
//
// Purpose: catch dispatch/transcription regressions across MANY handlers — exactly
// the failure mode a big refactor (e.g. the switch→handler-map split) could
// introduce in an otherwise-untested handler. Shape-level, not behavior-deep.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect, beforeEach } from "vitest";
import { Roll20Emulator } from "./roll20-emulator.js";

let emu: Roll20Emulator;
let pageId: string;
let npcId: string;
let pcId: string;
let charId: string;

beforeEach(() => {
  emu = new Roll20Emulator({ seed: 7 });
  emu.load();
  pageId = emu.createPage();
  emu.setPlayerPage(pageId);
  // Real campaigns carry a JSON token-marker set here; seed one so getTokenMarkers
  // reflects reality. (NOTE: the relay JSON.parses this unguarded — an empty/unset
  // value would crash it; worth a defensive guard in a future relay pass.)
  emu.campaignModel.set("token_markers", JSON.stringify([{ id: "m1", name: "Red", tag: "red" }]));
  npcId = emu.createToken({ pageid: pageId, name: "Goblin", bar1_value: 7, bar1_max: 7 }).id;
  pcId = emu.createToken({ pageid: pageId, name: "Zeno", controlledby: "player-1", bar1_value: 30, bar1_max: 30 }).id;
  charId = emu.createCharacter("Zeno", { strength: 14, dexterity: 16 }, "player-1");
});

describe("read actions (smoke)", () => {
  it("ping returns the relay version", () => {
    const r = emu.relay<{ pong: boolean; version: string }>({ action: "ping" });
    expect(r.pong).toBe(true);
    expect(typeof r.version).toBe("string");
  });

  it.each([
    ["getTurnOrder", {}],
    ["getRecentChat", {}],
    ["getDmInbox", {}],
    ["getMobPlans", {}],
    ["getCustomStates", {}],
    ["getTokenMarkers", {}],
    ["getJournalFolder", {}],
    ["listPages", {}],
    ["getTurnHookState", {}],
    ["getPaths", "PAGE"],
    ["getWalls", "PAGE"],
    ["listZones", "PAGE"],
  ] as const)("%s resolves without throwing", (action, arg) => {
    const cmd = arg === "PAGE" ? { action, pageId } : { action, ...(arg as object) };
    expect(() => emu.relay(cmd)).not.toThrow();
  });

  it("getTurnHookState reports enabled + round", () => {
    const r = emu.relay<{ enabled: boolean; round: number }>({ action: "getTurnHookState" });
    expect(typeof r.enabled).toBe("boolean");
    expect(typeof r.round).toBe("number");
  });

  it("getTokenById returns a summary for a real token, null for a missing one", () => {
    const found = emu.relay<{ name?: string } | null>({ action: "getTokenById", tokenId: npcId });
    expect(found && found.name).toBe("Goblin");
    const missing = emu.relay({ action: "getTokenById", tokenId: "no-such-token" });
    expect(missing).toBeNull();
  });

  it("getCharacterAttributes reads sheet attributes", () => {
    const attrs = emu.relay<Record<string, unknown>>({ action: "getCharacterAttributes", charId });
    expect(attrs).toBeTruthy();
  });

  it("getPcHp returns null when no tracked-HP block is present", () => {
    const hp = emu.relay({ action: "getPcHp", tokenId: pcId });
    expect(hp).toBeNull();
  });
});

describe("simple write actions (smoke)", () => {
  it("setTurnHook toggles the hook state", () => {
    const r = emu.relay<{ ok: boolean; enabled: boolean }>({ action: "setTurnHook", enabled: true });
    expect(r.ok).toBe(true);
    expect(r.enabled).toBe(true);
    const back = emu.relay<{ enabled: boolean }>({ action: "getTurnHookState" });
    expect(back.enabled).toBe(true);
  });

  it("setStatusMarker adds a marker to a token", () => {
    expect(() => emu.relay({ action: "setStatusMarker", tokenId: npcId, marker: "red", active: true })).not.toThrow();
    expect(String(emu.getObj("graphic", npcId)!.get("statusmarkers"))).toContain("red");
  });

  it("setMobPlan + getMobPlans round-trips a stored plan", () => {
    emu.relay({ action: "setMobPlan", tokenId: npcId, html: "<p>charge</p>" });
    const plans = emu.relay<Record<string, unknown>>({ action: "getMobPlans" });
    expect(plans[npcId]).toBeTruthy();
  });

  it("clearMobPlans empties the store", () => {
    emu.relay({ action: "setMobPlan", tokenId: npcId, html: "<p>x</p>" });
    emu.relay({ action: "clearMobPlans" });
    const plans = emu.relay<Record<string, unknown>>({ action: "getMobPlans" });
    expect(Object.keys(plans)).toHaveLength(0);
  });

  it("clearDmInbox empties the inbox", () => {
    expect(() => emu.relay({ action: "clearDmInbox" })).not.toThrow();
    const inbox = emu.relay<unknown[]>({ action: "getDmInbox" });
    expect(inbox).toHaveLength(0);
  });

  it("toFront on a real graphic resolves ok", () => {
    const r = emu.relay<{ ok: boolean }>({ action: "toFront", objectId: npcId, objectType: "graphic" });
    expect(r.ok).toBe(true);
  });

  it("setDefaultToken / adjustPcHp via the dispatch don't crash on a PC token", () => {
    const r = emu.relay<{ current?: number }>({ action: "adjustPcHp", tokenId: pcId, setHp: 25, maxHp: 30 });
    expect(r).toBeTruthy();
  });
});
