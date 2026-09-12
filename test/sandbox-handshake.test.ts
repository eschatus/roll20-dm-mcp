// ─────────────────────────────────────────────────────────────────────────────
// Mod Script Sandbox handshake + the Beacon-sheet write guard.
//
// Roll20 flipped the DEFAULT sandbox from v1.0 to v1.5 on 2026-09-02 for every game
// that had never explicitly picked one. The two are a behavioral fork, and the fork
// that matters here is the Beacon ("advanced") character sheet: it keeps character
// data in COMPUTED properties, not `attribute` objects, so the relay's attribute
// read/write path cannot see or reach any of it.
//
// The failure that guards against is specific and nasty: createObj("attribute")
// succeeds against a Beacon sheet, so setCharacterAttributes used to report the name
// under `created` while the sheet never read the object — a write that reported
// success and did nothing. These tests pin that it now fails loudly instead, and
// that the guard is narrow enough not to block ordinary attribute writes.
//
// The emulator's Campaign() is a prop bag behind .get(); sandboxVersion/nodeVersion/
// sheetName/computedSummary are DIRECT properties on the real object (Roll20 documents
// them as "read on the object returned by Campaign(), not via get"), so the tests
// attach them the same way.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect, beforeEach } from "vitest";
import { Roll20Emulator } from "./roll20-emulator.js";
import {
  reportRelaySandbox, getRelaySandboxInfo, resetRelayProbeForCampaignSwitch,
  _resetRelayVersionCheckForTest,
} from "../src/bridge/relay-version-check.js";

let emu: Roll20Emulator;
let charId: string;

/** Attach the direct Campaign() properties a v1.5 sandbox exposes. */
function asSandbox(
  e: Roll20Emulator,
  props: { sandboxVersion?: string; nodeVersion?: string; sheetName?: string; computedSummary?: unknown }
): void {
  Object.assign(e.campaignModel as unknown as Record<string, unknown>, props);
}

beforeEach(() => {
  emu = new Roll20Emulator({ seed: 11 });
  emu.load();
  charId = emu.createCharacter("Brie Mossfrond", { strength: 14 }, "player-1");
});

describe("ping — sandbox handshake", () => {
  it("reports nulls (not a throw) on a sandbox that predates the fields", () => {
    const r = emu.relay<{ pong: boolean; version: string; sandbox: string | null; beacon: boolean }>({ action: "ping" });
    expect(r.pong).toBe(true);
    expect(typeof r.version).toBe("string");
    expect(r.sandbox).toBeNull();
    // No computedSummary means no Beacon sheet — the attribute path stays authoritative.
    expect(r.beacon).toBe(false);
  });

  it("echoes sandbox version, node version, sheet name and the Beacon flag", () => {
    asSandbox(emu, {
      sandboxVersion: "1.5",
      nodeVersion: "v20.11.1",
      sheetName: "D&D 5E by Roll20",
      computedSummary: ["hp", "ac", "initiative"],
    });
    const r = emu.relay<{
      version: string; sandbox: string; node: string; sheetName: string; beacon: boolean;
    }>({ action: "ping" });
    expect(r.sandbox).toBe("1.5");
    expect(r.node).toBe("v20.11.1");
    expect(r.sheetName).toBe("D&D 5E by Roll20");
    expect(r.beacon).toBe(true);
    // The two handshakes are independent: the relay's own version still rides along.
    expect(r.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("accepts computedSummary as an object as well as an array", () => {
    asSandbox(emu, { sandboxVersion: "1.5", computedSummary: { hp: {}, ac: {} } });
    const r = emu.relay<{ beacon: boolean }>({ action: "ping" });
    expect(r.beacon).toBe(true);
  });
});

describe("setCharacterAttributes — Beacon computed properties are not silently faked", () => {
  it("refuses to create an orphan attribute for a computed property, and says why", () => {
    asSandbox(emu, { sandboxVersion: "1.5", sheetName: "D&D 5E 2024", computedSummary: ["hp", "ac"] });
    const r = emu.relay<{
      updated: string[]; created: string[]; failed: string[];
      reasons: Record<string, string>;
      sheet: { sandbox: string; sheetName: string; beacon: boolean };
    }>({ action: "setCharacterAttributes", charId, attributes: { ac: 17 } });

    expect(r.created).toEqual([]);
    expect(r.updated).toEqual([]);
    expect(r.failed).toEqual(["ac"]);
    expect(r.reasons.ac).toMatch(/Beacon computed property/);
    expect(r.reasons.ac).toMatch(/setComputed|setSheetItem/);
    expect(r.sheet).toMatchObject({ sandbox: "1.5", sheetName: "D&D 5E 2024", beacon: true });

    // The point of the guard: nothing was written. A stray attribute object here is
    // exactly the silent false success the guard exists to prevent.
    const attrs = emu.relay<Record<string, unknown>>({ action: "getCharacterAttributes", charId });
    expect(attrs).not.toHaveProperty("ac");
  });

  it("still creates an ordinary attribute on a Beacon campaign when the name is not computed", () => {
    asSandbox(emu, { sandboxVersion: "1.5", sheetName: "D&D 5E 2024", computedSummary: ["hp", "ac"] });
    const r = emu.relay<{ created: string[]; failed: string[] }>({
      action: "setCharacterAttributes", charId, attributes: { npc_senses: "darkvision 60 ft." },
    });
    expect(r.created).toEqual(["npc_senses"]);
    expect(r.failed).toEqual([]);
  });

  it("refuses even when an attribute object with that name ALREADY EXISTS", () => {
    // The orphan-attribute case. A campaign that ran relay <= 2.5.0 against a Beacon sheet is
    // carrying attribute objects that the sheet never reads; taking the update branch for those
    // would report `updated` for a write that still lands nowhere, leaving the guard inert for
    // precisely the campaigns that hit the original bug.
    asSandbox(emu, { sandboxVersion: "1.5", computedSummary: ["strength"] });
    const r = emu.relay<{ updated: string[]; failed: string[]; reasons: Record<string, string> }>({
      action: "setCharacterAttributes", charId, attributes: { strength: 18 },
    });
    expect(r.updated).toEqual([]);
    expect(r.failed).toEqual(["strength"]);
    expect(r.reasons.strength).toMatch(/neither creating nor updating/);

    // And the stale value is left exactly as it was, not half-written.
    const attrs = emu.relay<Record<string, unknown>>({ action: "getCharacterAttributes", charId });
    expect(String(attrs.strength)).toBe("14");
  });

  it("extracts names from a computedSummary of descriptor objects", () => {
    // Roll20 documents computedSummary as "available Beacon computed property names" without
    // pinning the element shape, so the obvious object forms have to resolve to names too.
    asSandbox(emu, { sandboxVersion: "1.5", computedSummary: [{ name: "ac" }, { name: "hp" }] });
    const r = emu.relay<{ failed: string[] }>({
      action: "setCharacterAttributes", charId, attributes: { ac: 17 },
    });
    expect(r.failed).toEqual(["ac"]);
  });

  it("refuses every write when a Beacon summary is present but its names are unreadable", () => {
    // The dangerous middle state: we can tell it is a Beacon sheet but not which properties are
    // computed. Guessing would put the silent false success back while reporting beacon:true, so
    // the write fails and says exactly why.
    asSandbox(emu, { sandboxVersion: "1.5", computedSummary: [42, true] });
    const r = emu.relay<{ created: string[]; failed: string[]; reasons: Record<string, string> }>({
      action: "setCharacterAttributes", charId, attributes: { npc_senses: "darkvision 60 ft." },
    });
    expect(r.created).toEqual([]);
    expect(r.failed).toEqual(["npc_senses"]);
    expect(r.reasons.npc_senses).toMatch(/could not be read/);
  });

  it("is inert on a v1.0 sandbox — every write takes the attribute path", () => {
    const r = emu.relay<{ created: string[]; failed: string[]; sheet: { beacon: boolean } }>({
      action: "setCharacterAttributes", charId, attributes: { ac: 17 },
    });
    expect(r.created).toEqual(["ac"]);
    expect(r.failed).toEqual([]);
    expect(r.sheet.beacon).toBe(false);
  });
});

describe("sandbox info is per-campaign, not per-process", () => {
  beforeEach(() => { _resetRelayVersionCheckForTest(); });

  it("is dropped on a campaign switch so the next probe re-reads it", () => {
    reportRelaySandbox({ sandbox: "1.5", node: "v20.11.1", sheetName: "Beacon 5E", beacon: true });
    expect(getRelaySandboxInfo()).toMatchObject({ sandbox: "1.5", beacon: true });

    // Without this, transport_status keeps reporting the campaign we just left.
    resetRelayProbeForCampaignSwitch();
    expect(getRelaySandboxInfo()).toBeNull();
  });

  it("reports beacon as null — not false — when the relay is too old to say", () => {
    // A relay below 2.6.0 doesn't send the field. Reporting a confident "no Beacon sheet" for a
    // relay that was never asked would be a worse answer than admitting we don't know.
    reportRelaySandbox({ version: "2.5.0" } as never);
    expect(getRelaySandboxInfo()?.beacon).toBeNull();
    expect(getRelaySandboxInfo()?.sandbox).toBeNull();
  });
});

describe("aura shape survives a read", () => {
  it("the rich token profile reports aura*_options, not just radius and colour", () => {
    const pageId = emu.createPage();
    emu.setPlayerPage(pageId);
    const tokenId = emu.createToken({
      pageid: pageId, name: "Cleric",
      aura1_radius: 15, aura1_color: "#ffdd00", aura1_options: "hex",
    }).id;

    const t = emu.relay<Record<string, unknown>>({ action: "getTokenById", tokenId, profile: "rich" });
    expect(t.aura1_radius).toBe(15);
    expect(t.aura1_options).toBe("hex");
  });

  it("omits aura shape when the slot carries no aura at all", () => {
    const pageId = emu.createPage();
    emu.setPlayerPage(pageId);
    const tokenId = emu.createToken({ pageid: pageId, name: "Goblin", aura1_options: "square" }).id;

    const t = emu.relay<Record<string, unknown>>({ action: "getTokenById", tokenId, profile: "rich" });
    expect(t).not.toHaveProperty("aura1_options");
  });
});
