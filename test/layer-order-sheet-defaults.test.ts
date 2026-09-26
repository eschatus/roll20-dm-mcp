// ─────────────────────────────────────────────────────────────────────────────
// Two pieces of documented Mod API surface this repo had never wired (#209):
//
//   toAbove(obj, target) / toBelow(obj, target)  — sandbox v1.5 ONLY. Relative z-order, which
//     toFront/toBack cannot express (they only go all-the-way-front / all-the-way-back).
//   getSheetDefaultValue(name, valtype?)         — the SHEET's default for a field, as opposed to
//     a character's live value, which is the comparison getCharacterAttributes cannot make.
//
// Both are absent on a sandbox that doesn't have them, so the interesting half of each is the
// refusal: a bare `toAbove is not defined` ReferenceError tells a DM nothing, and the actual fix
// is a per-campaign sandbox setting. The emulator therefore installs the v1.5 globals only when
// asked, so the v1.0 path here runs against genuinely undeclared identifiers.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect, afterEach } from "vitest";
import { z } from "zod";
import { Roll20Emulator } from "./roll20-emulator.js";
import * as roll20 from "../src/bridge/roll20.js";
import { registerMapTools } from "../src/tools/maps.js";
import { registerCombatTools } from "../src/tools/combat.js";
import { FakeMcpServer } from "./harness.js";

/** Attach the direct Campaign() properties a v1.5 sandbox exposes (same shim as sandbox-handshake). */
function asSandbox(e: Roll20Emulator, props: Record<string, unknown>): void {
  Object.assign(e.campaignModel as unknown as Record<string, unknown>, props);
}

function twoTokens(e: Roll20Emulator, layerB = "objects") {
  const pageId = e.createPage();
  const a = e.createToken({ pageid: pageId, name: "Bloodstain", layer: "objects" });
  const b = e.createToken({ pageid: pageId, name: "Ogre", layer: layerB });
  return { a, b };
}

describe("toAbove / toBelow — relative z-order (sandbox v1.5)", () => {
  it("hands the resolved (object, target) pair to the v1.5 global and reports the layer", () => {
    const emu = new Roll20Emulator({ seed: 3, sandbox15: true });
    emu.load();
    asSandbox(emu, { sandboxVersion: "1.5" });
    const { a, b } = twoTokens(emu);

    const above = emu.relay<{ ok: boolean; objectId: string; targetId: string; layer: string | null }>({
      action: "toAbove", objectId: a.id, targetId: b.id,
    });
    expect(above).toEqual({ ok: true, objectId: a.id, targetId: b.id, layer: "objects" });

    const below = emu.relay<{ ok: boolean }>({ action: "toBelow", objectId: a.id, targetId: b.id });
    expect(below.ok).toBe(true);

    expect(emu.zOrderCalls).toEqual([
      { fn: "toAbove", objectId: a.id, targetId: b.id },
      { fn: "toBelow", objectId: a.id, targetId: b.id },
    ]);
  });

  it("refuses on a v1.0 sandbox, naming the version and the fallback — not a ReferenceError", () => {
    const emu = new Roll20Emulator({ seed: 3 }); // no sandbox15 → toAbove/toBelow undeclared
    emu.load();
    asSandbox(emu, { sandboxVersion: "1.0" });
    const { a, b } = twoTokens(emu);

    expect(() => emu.relay({ action: "toAbove", objectId: a.id, targetId: b.id }))
      .toThrow(/toAbove is not available on Mod Script Sandbox 1\.0.*v1\.5 only.*use toFront/s);
    expect(() => emu.relay({ action: "toBelow", objectId: a.id, targetId: b.id }))
      .toThrow(/toBelow is not available on Mod Script Sandbox 1\.0.*use toBack/s);
    expect(emu.zOrderCalls).toEqual([]);
  });

  it("reports sandbox 1.0 by default when the campaign predates sandboxVersion", () => {
    const emu = new Roll20Emulator({ seed: 3 });
    emu.load();
    const { a, b } = twoTokens(emu);
    expect(() => emu.relay({ action: "toAbove", objectId: a.id, targetId: b.id }))
      .toThrow(/Mod Script Sandbox 1\.0/);
  });

  it("refuses a cross-layer pair rather than reporting ok:true for a no-op", () => {
    const emu = new Roll20Emulator({ seed: 3, sandbox15: true });
    emu.load();
    const { a, b } = twoTokens(emu, "map");

    expect(() => emu.relay({ action: "toAbove", objectId: a.id, targetId: b.id }))
      .toThrow(/same layer.*'objects'.*'map'/s);
    expect(emu.zOrderCalls).toEqual([]);
  });

  it("refuses a same-layer pair on DIFFERENT pages — z-order is page-local, so it would be a no-op", () => {
    const emu = new Roll20Emulator({ seed: 3, sandbox15: true });
    emu.load();
    const p1 = emu.createPage();
    const p2 = emu.createPage();
    const a = emu.createToken({ pageid: p1, name: "Bloodstain", layer: "objects" });
    const b = emu.createToken({ pageid: p2, name: "Ogre", layer: "objects" });

    expect(() => emu.relay({ action: "toAbove", objectId: a.id, targetId: b.id }))
      .toThrow(new RegExp(`same page.*'${p1}'.*'${p2}'`, "s"));
    expect(() => emu.relay({ action: "toBelow", objectId: a.id, targetId: b.id }))
      .toThrow(/same page/);
    expect(emu.zOrderCalls).toEqual([]);
  });

  it("refuses a missing object, a missing target, and an object relative to itself", () => {
    const emu = new Roll20Emulator({ seed: 3, sandbox15: true });
    emu.load();
    const { a, b } = twoTokens(emu);

    expect(() => emu.relay({ action: "toAbove", objectId: "-Nnope", targetId: b.id }))
      .toThrow(/Object not found: -Nnope/);
    expect(() => emu.relay({ action: "toAbove", objectId: a.id, targetId: "-Nnope" }))
      .toThrow(/Target object not found: -Nnope/);
    expect(() => emu.relay({ action: "toBelow", objectId: a.id, targetId: a.id }))
      .toThrow(/relative to itself/);
    expect(emu.zOrderCalls).toEqual([]);
  });

  it("resolves non-graphic types, so a path can be ordered against a token", () => {
    const emu = new Roll20Emulator({ seed: 3, sandbox15: true });
    emu.load();
    const pageId = emu.createPage();
    const zone = emu.relay<{ id: string }>({
      action: "createZone", pageId, name: "Web", centerX: 350, centerY: 350, radiusFeet: 20, shape: "circle",
    });
    const token = emu.createToken({ pageid: pageId, name: "Ogre", layer: "map" });

    const res = emu.relay<{ ok: boolean }>({
      action: "toBelow", objectId: zone.id, objectType: "path", targetId: token.id, targetType: "graphic",
    });
    expect(res.ok).toBe(true);
    expect(emu.zOrderCalls).toEqual([{ fn: "toBelow", objectId: zone.id, targetId: token.id }]);
  });
});

describe("getSheetDefaultValues — the sheet's default, not a character's value", () => {
  const DEFAULTS = { npc_ac: 10, npc_speed: "30 ft.", "hp:max": 0, hp: 0 };

  it("returns the sheet default for each requested name, with the sheet context", () => {
    const emu = new Roll20Emulator({ seed: 5, sheetDefaults: DEFAULTS });
    emu.load();
    asSandbox(emu, { sandboxVersion: "1.5", sheetName: "D&D 5E by Roll20" });

    const res = emu.relay<{
      defaults: Record<string, unknown>; missing: string[]; valtype: string | null;
      sheet: { sandbox: string | null; sheetName: string | null; beacon: boolean };
    }>({ action: "getSheetDefaultValues", names: ["npc_ac", "npc_speed"] });

    expect(res.defaults).toEqual({ npc_ac: 10, npc_speed: "30 ft." });
    expect(res.missing).toEqual([]);
    expect(res.valtype).toBeNull();
    expect(res.sheet).toEqual({ sandbox: "1.5", sheetName: "D&D 5E by Roll20", beacon: false });
  });

  it("passes valtype through and separates unknown names into `missing`", () => {
    const emu = new Roll20Emulator({ seed: 5, sheetDefaults: DEFAULTS });
    emu.load();

    const res = emu.relay<{ defaults: Record<string, unknown>; missing: string[]; valtype: string | null }>({
      action: "getSheetDefaultValues", names: ["hp", "not_a_field"], valtype: "max",
    });
    // "hp:max" is the emulator's stand-in for getSheetDefaultValue("hp", "max"); a name the sheet
    // has no default for must NOT come back as a default of null.
    expect(res.defaults).toEqual({ hp: 0 });
    expect(res.missing).toEqual(["not_a_field"]);
    expect(res.valtype).toBe("max");
  });

  it("resolves a Promise-returning getter instead of serialising the Promise as the default", async () => {
    // Roll20 documents getSheetItem/setSheetItem as async but says nothing either way about
    // getSheetDefaultValue, and a Promise JSON-serialises to {} — which would arrive looking
    // exactly like a real (empty-object) sheet default.
    const emu = new Roll20Emulator({
      seed: 5,
      sheetDefaults: { npc_ac: Promise.resolve(12), npc_speed: Promise.resolve("40 ft.") },
    });
    emu.load();

    const res = await emu.relayAsync<{ defaults: Record<string, unknown> }>({
      action: "getSheetDefaultValues", names: ["npc_ac", "npc_speed"],
    });
    expect(res.defaults).toEqual({ npc_ac: 12, npc_speed: "40 ft." });
  });

  it("surfaces a rejected async getter as a relay error", async () => {
    const emu = new Roll20Emulator({
      seed: 5,
      sheetDefaults: { npc_ac: Promise.reject(new Error("sheet not loaded")) },
    });
    emu.load();

    await expect(emu.relayAsync({ action: "getSheetDefaultValues", names: ["npc_ac"] }))
      .rejects.toThrow(/getSheetDefaultValue rejected: sheet not loaded/);
  });

  it("refuses when the sandbox/sheet does not expose the function at all", () => {
    const emu = new Roll20Emulator({ seed: 5 }); // no sheetDefaults → getter undeclared
    emu.load();
    asSandbox(emu, { sandboxVersion: "1.0" });

    expect(() => emu.relay({ action: "getSheetDefaultValues", names: ["npc_ac"] }))
      .toThrow(/getSheetDefaultValue is not available in this Mod sandbox \(sandbox 1\.0/);
  });

  it("requires a non-empty names array", () => {
    const emu = new Roll20Emulator({ seed: 5, sheetDefaults: DEFAULTS });
    emu.load();

    expect(() => emu.relay({ action: "getSheetDefaultValues" }))
      .toThrow(/requires names/);
    expect(() => emu.relay({ action: "getSheetDefaultValues", names: [] }))
      .toThrow(/requires names/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The TS tool layer: the relay tests above prove the Mod half; these prove the MCP tools map their
// arguments onto the relay command correctly (objectType defaulting to "graphic", targetType passed
// through untouched so the relay can default it to objectType) by running the real handlers.
// ─────────────────────────────────────────────────────────────────────────────
describe("to_above / to_below / get_sheet_default_values — tool handlers", () => {
  afterEach(() => { roll20.__setBridgeTestTransport(null as never); });

  function wire(emu: Roll20Emulator) {
    const sent: Array<Record<string, unknown>> = [];
    roll20.__setBridgeTestTransport({
      relay: <T>(cmd: Record<string, unknown>) => { sent.push(cmd); return Promise.resolve(emu.relay<T>(cmd)); },
      evaluate: <T>(fn: (args?: unknown) => T, args?: unknown) => Promise.resolve(fn(args)),
    });
    const server = new FakeMcpServer();
    registerMapTools(server as never);
    registerCombatTools(server as never);
    const call = async (name: string, args: Record<string, unknown>) => {
      const entry = server.handlers.get(name);
      if (!entry) throw new Error(`No such tool registered: ${name}`);
      const parsed = z.object(entry.schema).parse(args) as Record<string, unknown>;
      const res = await entry.handler(parsed);
      return JSON.parse(res?.content?.[0]?.text ?? "null");
    };
    return { sent, call, server };
  }

  it("to_above defaults objectType to graphic and leaves targetType unset for the relay to default", async () => {
    const emu = new Roll20Emulator({ seed: 3, sandbox15: true });
    emu.load();
    const { a, b } = twoTokens(emu);
    const { sent, call } = wire(emu);

    const out = await call("to_above", { objectId: a.id, targetId: b.id });
    expect(sent).toEqual([
      { action: "toAbove", objectId: a.id, targetId: b.id, objectType: "graphic", targetType: undefined },
    ]);
    expect(out).toMatchObject({ ok: true, objectId: a.id, targetId: b.id, layer: "objects" });
    expect(emu.zOrderCalls).toEqual([{ fn: "toAbove", objectId: a.id, targetId: b.id }]);
  });

  it("to_below passes an explicit targetType through, so a path orders against a token", async () => {
    const emu = new Roll20Emulator({ seed: 3, sandbox15: true });
    emu.load();
    const pageId = emu.createPage();
    const zone = emu.relay<{ id: string }>({
      action: "createZone", pageId, name: "Web", centerX: 350, centerY: 350, radiusFeet: 20, shape: "circle",
    });
    const token = emu.createToken({ pageid: pageId, name: "Ogre", layer: "map" });
    const { sent, call } = wire(emu);

    await call("to_below", { objectId: zone.id, objectType: "path", targetId: token.id, targetType: "graphic" });
    expect(sent).toEqual([
      { action: "toBelow", objectId: zone.id, targetId: token.id, objectType: "path", targetType: "graphic" },
    ]);
    expect(emu.zOrderCalls).toEqual([{ fn: "toBelow", objectId: zone.id, targetId: token.id }]);
  });

  it("get_sheet_default_values accepts only Roll20's documented valtypes", () => {
    const emu = new Roll20Emulator({ seed: 3 });
    emu.load();
    const { server } = wire(emu);
    const schema = z.object(server.handlers.get("get_sheet_default_values")!.schema);
    expect(schema.safeParse({ names: ["hp"], valtype: "max" }).success).toBe(true);
    expect(schema.safeParse({ names: ["hp"], valtype: "current" }).success).toBe(true);
    expect(schema.safeParse({ names: ["hp"] }).success).toBe(true);
    expect(schema.safeParse({ names: ["hp"], valtype: "maximum" }).success).toBe(false);
  });
});
