// ─────────────────────────────────────────────────────────────────────────────
// Beacon sheet carriers — the v1.5 read/write path (issue #205).
//
// Roll20's Mod Script Sandbox v1.5 keeps Beacon ("advanced") character data in COMPUTED
// PROPERTIES, which `findObjs({_type:"attribute"})` cannot see and `createObj("attribute")`
// cannot reach. relay 2.6.0 stopped the acute bleeding (setCharacterAttributes refuses a write
// it cannot land — test/sandbox-handshake.test.ts); these tests cover the actual carriers:
//
//   getSheetItem / setSheetItem   — positional, BOTH sandboxes, the version-agnostic pair
//   getComputed / setComputed     — one object argument, v1.5 only
//   performAction                 — one object argument, v1.5 only
//   getSheetSummary               — what this campaign's sheet even offers
//
// Every one of them returns a PROMISE, and the relay's ACTIONS handlers are synchronous, so the
// interesting half of this file is the deferred-writeResult plumbing: marshalling, per-item
// failure isolation, and the timeout that keeps a carrier which never settles from turning into
// an opaque transport timeout 8-30s later.
//
// What these tests do NOT do is guess at Beacon's internals — the emulator's carriers record what
// they were called with and resolve or reject on command. The half we own is the marshalling and
// the reporting, and that is what is pinned here.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Roll20Emulator, type SheetCall } from "./roll20-emulator.js";
import { setupHarness, type Harness } from "./harness.js";

let emu: Roll20Emulator;
let charId: string;

function callsTo(fn: string): SheetCall[] {
  return emu.sheetCalls.filter((c) => c.fn === fn);
}

beforeEach(() => {
  emu = new Roll20Emulator({ seed: 205 });
  emu.load();
  charId = emu.createCharacter("Brie Mossfrond", { strength: 14 }, "player-1");
});

describe("getSheetSummary — what this sheet offers", () => {
  it("reports a pre-v1.5 sandbox honestly: no carriers, no summaries", async () => {
    const r = await emu.relayAsync<{
      sandbox: string | null; beacon: boolean; computed: string[]; actions: string[];
      carriers: Record<string, boolean>;
    }>({ action: "getSheetSummary" });

    expect(r.sandbox).toBeNull();
    expect(r.beacon).toBe(false);
    expect(r.computed).toEqual([]);
    expect(r.actions).toEqual([]);
    expect(r.carriers).toEqual({
      getSheetItem: false, setSheetItem: false,
      getComputed: false, setComputed: false, performAction: false,
    });
  });

  it("enumerates computedSummary and actionSummary on v1.5", async () => {
    emu.installSheetCarriers({
      sheetName: "D&D 5E 2024",
      computed: { hp: { current: 31, max: 44 }, ac: 17 },
      actions: ["attack.claw", "save.dex"],
    });
    const r = await emu.relayAsync<{
      sandbox: string; sheetName: string; beacon: boolean;
      computed: string[]; actions: string[]; carriers: Record<string, boolean>;
    }>({ action: "getSheetSummary" });

    expect(r.sandbox).toBe("1.5");
    expect(r.sheetName).toBe("D&D 5E 2024");
    expect(r.beacon).toBe(true);
    expect(r.computed).toEqual(["hp", "ac"]);
    expect(r.actions).toEqual(["attack.claw", "save.dex"]);
    expect(r.carriers.performAction).toBe(true);
  });
});

describe("getSheetItem — the version-agnostic read", () => {
  it("reaches a Beacon computed property the attribute path cannot see", async () => {
    emu.installSheetCarriers({ computed: { ac: 17 } });
    const r = await emu.relayAsync<{ values: Record<string, unknown>; failed: string[] }>({
      action: "getSheetItem", charId, property: "ac",
    });
    expect(r.values).toEqual({ ac: 17 });
    expect(r.failed).toEqual([]);

    // The point of the carrier: the same name is invisible to getCharacterAttributes.
    const attrs = emu.relay<Record<string, unknown>>({ action: "getCharacterAttributes", charId });
    expect(attrs).not.toHaveProperty("ac");
  });

  it("wraps ordinary attributes on a v1.0 sandbox, where there are no computed properties", async () => {
    emu.installSheetCarriers({ sandboxVersion: "1.0" });
    const r = await emu.relayAsync<{ values: Record<string, unknown> }>({
      action: "getSheetItem", charId, names: ["strength"],
    });
    expect(r.values).toEqual({ strength: 14 });
  });

  it("marshals Roll20's POSITIONAL signature, not an object", async () => {
    emu.installSheetCarriers({ computed: { hp: { current: 31, max: 44 } } });
    await emu.relayAsync({ action: "getSheetItem", charId, property: "hp", valtype: "max" });
    expect(callsTo("getSheetItem")[0].args.slice(0, 3)).toEqual([charId, "hp", "max"]);
  });

  it("reads several names in one round trip and isolates the one that fails", async () => {
    emu.installSheetCarriers({ computed: { ac: 17, hp: 31, speed: 30 }, failItems: ["hp"] });
    const r = await emu.relayAsync<{
      values: Record<string, unknown>; failed: string[]; reasons: Record<string, string>;
    }>({ action: "getSheetItem", charId, names: ["ac", "hp", "speed"] });

    // One unreadable property must not cost the caller the other two.
    expect(r.values).toEqual({ ac: 17, speed: 30 });
    expect(r.failed).toEqual(["hp"]);
    expect(r.reasons.hp).toMatch(/cannot read hp/);
  });

  it("reports a missing property as null rather than dropping it", async () => {
    emu.installSheetCarriers({ computed: { ac: 17 } });
    const r = await emu.relayAsync<{ values: Record<string, unknown> }>({
      action: "getSheetItem", charId, names: ["nonesuch"],
    });
    expect(r.values).toEqual({ nonesuch: null });
  });

  it("refuses with a useful message when the sandbox has no carrier at all", async () => {
    await expect(emu.relayAsync({ action: "getSheetItem", charId, property: "ac" }))
      .rejects.toThrow(/does not exist in this Mod sandbox/);
  });
});

describe("setSheetItem — the version-agnostic write", () => {
  it("writes a Beacon computed property", async () => {
    emu.installSheetCarriers({ computed: { hp: { current: 31, max: 44 } } });
    const r = await emu.relayAsync<{ written: string[]; failed: string[] }>({
      action: "setSheetItem", charId, attributes: { hp: 12 },
    });
    expect(r.written).toEqual(["hp"]);
    expect(r.failed).toEqual([]);
    expect(emu.sheetValues().hp.current).toBe(12);
  });

  it("splits {current,max} into the two valtype writes Roll20 needs", async () => {
    emu.installSheetCarriers({ computed: { hp: { current: 31, max: 44 } } });
    const r = await emu.relayAsync<{ written: string[] }>({
      action: "setSheetItem", charId, attributes: { hp: { current: 20, max: 50 } },
    });
    // Labelled by valtype so the two halves of one name stay distinguishable in the report.
    expect(r.written).toEqual(["hp", "hp:max"]);
    expect(emu.sheetValues().hp).toEqual({ current: 20, max: 50 });
    expect(callsTo("setSheetItem").map((c) => [c.args[1], c.args[2], c.args[3]]))
      .toEqual([["hp", 20, "current"], ["hp", 50, "max"]]);
  });

  it("reaches a user.* custom attribute", async () => {
    emu.installSheetCarriers({ computed: { ac: 17 } });
    await emu.relayAsync({ action: "setSheetItem", charId, attributes: { "user.mob_plan": "flank" } });
    expect(emu.sheetValues()["user.mob_plan"].current).toBe("flank");
  });

  it("defaults allowThrow ON, so a read-only property FAILS instead of reporting success", async () => {
    emu.installSheetCarriers({ computed: { ac: 17 }, readOnlyComputed: ["ac"] });
    const r = await emu.relayAsync<{
      written: string[]; failed: string[]; reasons: Record<string, string>; allowThrow: boolean;
    }>({ action: "setSheetItem", charId, attributes: { ac: 20 } });

    expect(r.allowThrow).toBe(true);
    expect(r.written).toEqual([]);
    expect(r.failed).toEqual(["ac"]);
    expect(r.reasons.ac).toMatch(/read-only/);
    expect(emu.sheetValues().ac.current).toBe(17);
    expect(callsTo("setSheetItem")[0].args[4]).toMatchObject({ allowThrow: true });
  });

  it("allowThrow:false is available but says out loud that success proves nothing", async () => {
    // Roll20's own default. It resolves whether or not the write landed, which is the exact
    // "reported success, did nothing" shape #205 exists to end — so the caller has to opt in
    // and the result carries the caveat.
    emu.installSheetCarriers({ computed: { ac: 17 }, readOnlyComputed: ["ac"] });
    const r = await emu.relayAsync<{ written: string[]; failed: string[]; note?: string }>({
      action: "setSheetItem", charId, attributes: { ac: 20 }, allowThrow: false,
    });
    expect(r.written).toEqual(["ac"]);
    expect(r.failed).toEqual([]);
    expect(r.note).toMatch(/NOT that the sheet took the value/);
    // …and it demonstrably did not: the value is untouched.
    expect(emu.sheetValues().ac.current).toBe(17);
  });

  it("forwards createAttr and withWorker only when the caller set them", async () => {
    emu.installSheetCarriers({ computed: { ac: 17 } });
    await emu.relayAsync({ action: "setSheetItem", charId, attributes: { ac: 20 } });
    expect(callsTo("setSheetItem")[0].args[4]).toEqual({ allowThrow: true });

    await emu.relayAsync({
      action: "setSheetItem", charId, attributes: { ac: 21 }, createAttr: false, withWorker: true,
    });
    expect(callsTo("setSheetItem")[1].args[4]).toEqual({ allowThrow: true, createAttr: false, withWorker: true });
  });

  it("keeps a failed write from hiding the ones that worked", async () => {
    emu.installSheetCarriers({ computed: { ac: 17, hp: 31 }, failItems: ["hp"] });
    const r = await emu.relayAsync<{ written: string[]; failed: string[] }>({
      action: "setSheetItem", charId, attributes: { ac: 20, hp: 5 },
    });
    expect(r.written).toEqual(["ac"]);
    expect(r.failed).toEqual(["hp"]);
  });
});

describe("getComputed / setComputed — v1.5 only, one object argument", () => {
  it("marshals Roll20's OBJECT signature and defaults playerId to the GM sender", async () => {
    emu.installSheetCarriers({ computed: { ac: 17 } });
    const r = await emu.relayAsync<{ value: unknown; known: boolean }>({
      action: "getComputed", charId, property: "ac",
    });
    expect(r.value).toBe(17);
    expect(r.known).toBe(true);
    expect(callsTo("getComputed")[0].args[0]).toEqual({
      characterId: charId, property: "ac", playerId: emu.gmPlayerId,
    });
  });

  it("flags a property that is not in computedSummary, rather than shrugging at the null", async () => {
    emu.installSheetCarriers({ computed: { ac: 17 } });
    const r = await emu.relayAsync<{ value: unknown; known: boolean }>({
      action: "getComputed", charId, property: "nonesuch",
    });
    expect(r.value).toBeNull();
    expect(r.known).toBe(false);
  });

  it("refuses on a v1.0 sandbox, where the name exists as a NO-OP STUB", async () => {
    // The nastiest version of this: the function is there and resolves, so `typeof` proves
    // nothing. Calling it would be a silent nothing — the same false success as the Beacon
    // attribute write setCharacterAttributes already refuses.
    emu.installSheetCarriers({ sandboxVersion: "1.0" });
    await expect(emu.relayAsync({ action: "getComputed", charId, property: "ac" }))
      .rejects.toThrow(/no-op stub on Mod Script Sandbox v1\.0/);
    expect(callsTo("getComputed")).toEqual([]);
  });

  it("will not guess where the new value sits in setComputed's payload", async () => {
    emu.installSheetCarriers({ computed: { ac: 17 } });
    await expect(emu.relayAsync({ action: "setComputed", charId, property: "ac" }))
      .rejects.toThrow(/pass args .*and\/or value/);
    expect(callsTo("setComputed")).toEqual([]);
  });

  it("forwards args and value verbatim and reads the property straight back", async () => {
    emu.installSheetCarriers({ computed: { ac: 17 } });
    const r = await emu.relayAsync<{ ok: boolean; readBack: unknown; note: string }>({
      action: "setComputed", charId, property: "ac", value: 20,
    });
    expect(r.ok).toBe(true);
    // setComputed resolves void, so the ONLY evidence is the read-back.
    expect(r.readBack).toBe(20);
    expect(r.note).toMatch(/readBack/);
    expect(callsTo("setComputed")[0].args[0]).toMatchObject({ property: "ac", value: 20 });
  });

  it("surfaces a rejected write as a relay error, not a cheerful ok", async () => {
    emu.installSheetCarriers({ computed: { ac: 17 }, readOnlyComputed: ["ac"] });
    await expect(emu.relayAsync({ action: "setComputed", charId, property: "ac", value: 20 }))
      .rejects.toThrow(/setComputed\(ac\): .*read-only/);
  });
});

describe("performAction — triggering a Beacon sheet action", () => {
  it("marshals the object argument and reports an action it recognizes", async () => {
    // The action NAME travels as `actionName`: the dispatcher eats the command's `action` field
    // as the relay action to run, so `action: "Bite"` would just be an unknown relay action.
    emu.installSheetCarriers({ computed: { ac: 17 }, actions: ["attack.claw"] });
    const r = await emu.relayAsync<{ ok: boolean; known: boolean }>({
      action: "performAction", charId, actionName: "attack.claw", args: { advantage: true },
    });
    expect(r.ok).toBe(true);
    expect(r.known).toBe(true);
    expect(callsTo("performAction")[0].args[0]).toEqual({
      characterId: charId, action: "attack.claw", args: { advantage: true }, playerId: emu.gmPlayerId,
    });
  });

  it("says when a name is not a Beacon action, because Roll20 then falls back to an ability", async () => {
    // The fallback is ROLL20'S, not ours — firing our own sendChat here would double-trigger the
    // ability. All the relay can honestly do is flag which path the call took.
    emu.installSheetCarriers({ computed: { ac: 17 }, actions: ["attack.claw"] });
    const r = await emu.relayAsync<{ known: boolean; note: string }>({
      action: "performAction", charId, actionName: "Bite",
    });
    expect(r.known).toBe(false);
    expect(r.note).toMatch(/falls back to a character ability/);
    expect(callsTo("performAction")).toHaveLength(1);
  });

  it("reports a rejected action instead of swallowing it", async () => {
    emu.installSheetCarriers({ computed: { ac: 17 }, actions: ["boom"], failActions: ["boom"] });
    await expect(emu.relayAsync({ action: "performAction", charId, actionName: "boom" }))
      .rejects.toThrow(/performAction\(boom\): action boom blew up/);
  });
});

describe("a carrier that never settles", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("is reported by name instead of hanging until the transport times out", async () => {
    // The relay's own 6s timeout is deliberately under the TS side's 8s read / 30s write relay
    // timeouts, so the error the DM sees names the stuck carrier.
    vi.useFakeTimers();
    const e = new Roll20Emulator({ seed: 205 });
    e.load();                       // captures the FAKE setTimeout into the sandbox
    const id = e.createCharacter("Stalled", {}, "");
    e.installSheetCarriers({ computed: { ac: 17 }, stall: ["ac"] });

    const nonce = 424242;
    e.relayWithNonce({ action: "getSheetItem", charId: id, property: "ac" }, nonce);
    await Promise.resolve();
    expect(e.resultFor(nonce)).toBeUndefined();

    await vi.advanceTimersByTimeAsync(6000);
    expect(e.resultFor(nonce)?.error).toMatch(/getSheetItem: no result after 6000ms/);
  });
});

// ── The MCP tool layer ────────────────────────────────────────────────────────
// The relay half is above; this is the half a DM (or the gem) actually calls. What matters here is
// #190's rule: a write that did not land must come back as isError, not as prose an LLM skims past.
describe("MCP tools over the carriers", () => {
  let h: Harness;
  let sheetId: string;

  beforeEach(() => {
    h = setupHarness({ seed: 205 });
    sheetId = h.emu.createCharacter("Beacon Brute", { strength: 14 }, "");
    h.emu.installSheetCarriers({
      sheetName: "D&D 5E 2024",
      computed: { hp: { current: 31, max: 44 }, ac: 17 },
      readOnlyComputed: ["ac"],
      actions: ["attack.claw"],
    });
  });
  afterEach(() => { h.teardown(); });

  it("get_sheet_summary tells the DM which sheet they are dealing with", async () => {
    const r = await h.callTool("get_sheet_summary");
    expect(r.isError).toBe(false);
    expect(r.json).toMatchObject({ sandbox: "1.5", beacon: true, sheetName: "D&D 5E 2024" });
    expect((r.json as { computed: string[] }).computed).toEqual(["hp", "ac"]);
  });

  it("set_sheet_item writes a computed property the attribute tool cannot touch", async () => {
    const r = await h.callTool("set_sheet_item", { charSheetId: sheetId, attributes: { hp: 12 } });
    expect(r.isError).toBe(false);
    expect(h.emu.sheetValues().hp.current).toBe(12);
  });

  it("set_sheet_item reports a read-only property as an ERROR, not as prose", async () => {
    const r = await h.callTool("set_sheet_item", { charSheetId: sheetId, attributes: { ac: 20 } });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/Nothing was written/);
    expect(r.text).toMatch(/read-only/);
    expect(h.emu.sheetValues().ac.current).toBe(17);
  });

  it("set_character_attribute still refuses a Beacon write, and now names the tool that works", async () => {
    // The end of the chain the guard was always pointing at: refusal → the carrier that lands.
    const r = await h.callTool("set_character_attribute", {
      charSheetId: sheetId, attributeName: "ac", value: 20,
    });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/set_sheet_item/);
  });

  it("get_sheet_item round-trips several names", async () => {
    const r = await h.callTool("get_sheet_item", { charSheetId: sheetId, names: ["hp", "ac"] });
    expect(r.isError).toBe(false);
    expect((r.json as { values: Record<string, unknown> }).values).toEqual({ hp: 31, ac: 17 });
  });

  it("perform_sheet_action flags a name the sheet does not know instead of implying a roll happened", async () => {
    const known = await h.callTool("perform_sheet_action", { charSheetId: sheetId, actionName: "attack.claw" });
    expect(known.isError).toBe(false);
    expect((known.json as { known: boolean }).known).toBe(true);

    const unknown = await h.callTool("perform_sheet_action", { charSheetId: sheetId, actionName: "Bite" });
    expect(unknown.text).toMatch(/NOT in Campaign\(\)\.actionSummary/);
  });

  it("set_computed_property carries the read-back that is its only evidence", async () => {
    const r = await h.callTool("set_computed_property", { charSheetId: sheetId, property: "hp", value: 9 });
    expect(r.isError).toBe(false);
    expect((r.json as { readBack: unknown }).readBack).toBe(9);
  });

  it("a v1.0 campaign gets told to switch sandboxes rather than a silent nothing", async () => {
    const h10 = setupHarness({ seed: 206 });
    try {
      const id = h10.emu.createCharacter("Legacy Lars", { strength: 12 }, "");
      h10.emu.installSheetCarriers({ sandboxVersion: "1.0" });
      // get_sheet_item still works on v1.0 — that is the point of the version-agnostic pair.
      const ok = await h10.callTool("get_sheet_item", { charSheetId: id, names: ["strength"] });
      expect((ok.json as { values: Record<string, unknown> }).values).toEqual({ strength: 12 });
      // get_computed_property cannot, and says so.
      await expect(h10.callTool("get_computed_property", { charSheetId: id, property: "ac" }))
        .rejects.toThrow(/no-op stub on Mod Script Sandbox v1\.0/);
    } finally { h10.teardown(); }
  });
});
