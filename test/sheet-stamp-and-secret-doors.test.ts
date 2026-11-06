// Two false successes found live on cos-test (2026-11-06): createCharacter's sheet stamp never
// reached Roll20, and decorate_openings' secret doors were only purple. Both fixes write RTDB, which
// the emulator has no model of, so rtUpdate and rtGet are backed by a map here. That proves the
// writes are made and read back, not what Roll20 does with them.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const rt = vi.hoisted(() => ({
  store: new Map<string, unknown>(),
  dropWrites: false,
  failWrites: false,
}));
vi.mock("../src/bridge/roll20-rt.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/bridge/roll20-rt.js")>()),
  rtUpdate: async (path: string, props: Record<string, unknown>) => {
    if (rt.failWrites) throw new Error("injected rtUpdate failure");
    if (rt.dropWrites) return;
    for (const [k, v] of Object.entries(props)) rt.store.set(`${path}/${k}`, v);
  },
  rtGet: async (path: string) => rt.store.get(path) ?? null,
}));

import { setupHarness, type Harness } from "./harness.js";
import { registerJournalTools } from "../src/tools/journal.js";
import { registerVisionTools } from "../src/tools/vision.js";

let h: Harness;
let page: string;

beforeEach(() => {
  h = setupHarness({ seed: 3 });
  registerJournalTools(h.server as never);
  registerVisionTools(h.server as never);
  page = h.emu.createPage("Crypt");
  rt.store.clear();
  rt.dropWrites = false;
  rt.failWrites = false;
  h.clearRelayLog();
});
afterEach(() => h.teardown());

const held = () => [...rt.store.entries()];
const created = () => h.emu.findObjs({ _type: "character" })[0];

describe("create_character_stub stamps the sheet name", () => {
  it("writes Campaign().sheetName straight to the character node", async () => {
    h.emu.installSheetCarriers({ sheetName: "ogl5e" });
    const { isError } = await h.callTool("create_character_stub", { name: "Vex" });
    expect(isError).toBeFalsy();
    expect(held()).toEqual([[`characters/${created().id}/charactersheetname`, "ogl5e"]]);
  });

  it("does not trust the Mod's write", async () => {
    h.emu.installSheetCarriers({ sheetName: "ogl5e" });
    await h.callTool("create_character_stub", { name: "Vex" });
    expect(created().get("charactersheetname")).toBeFalsy();
  });

  it("writes nothing on a sandbox with no sheet name, and the character is still made", async () => {
    const { isError } = await h.callTool("create_character_stub", { name: "Vex" });
    expect(isError).toBeFalsy();
    expect(held()).toEqual([]);
    expect(created().get("name")).toBe("Vex");
  });

  it("still returns the id when the stamp does not land, so a retry can't make a duplicate", async () => {
    h.emu.installSheetCarriers({ sheetName: "ogl5e" });
    rt.dropWrites = true;
    const { isError, text } = await h.callTool("create_character_stub", { name: "Vex" });
    expect(isError).toBeFalsy();
    expect(text).toContain(created().id);
    expect(text).toMatch(/did not land/);
    expect(text).toMatch(/Do not create it again/);
  });

  it("still returns the id when the sheet name can't be read", async () => {
    h.failRelayAction("ping");
    const { isError, text } = await h.callTool("create_character_stub", { name: "Vex" });
    expect(isError).toBeFalsy();
    expect(text).toContain(created().id);
    expect(text).toMatch(/WARNING/);
  });
});

describe("decorate_openings secret doors", () => {
  const OPENING = { center: [350, 350], widthPx: 70, angleDeg: 0 };

  it("marks a secret door secret, and only that one", async () => {
    await h.callTool("decorate_openings", {
      pageId: page, doors: [{ ...OPENING, center: [140, 140] }], windows: [], secretDoors: [OPENING],
    });
    const doors = h.emu.findObjs({ _type: "door", _pageid: page });
    const purple = doors.find((d) => d.get("color") === "#9932CC")!;
    expect(doors).toHaveLength(2);
    expect(held()).toEqual([[`doors/page/${page}/${purple.id}/isSecret`, true]]);
  });

  it("creates doors and windows through the Mod, which is what gives them an id", async () => {
    await h.callTool("decorate_openings", { pageId: page, doors: [OPENING], windows: [OPENING], secretDoors: [] });
    expect(h.relayLog).toEqual(expect.arrayContaining(["createDLDoors", "createDLWindows"]));
    expect(held()).toEqual([]);
  });

  it("touches nothing when the Mod isn't answering, so an empty game keeps its doors", async () => {
    h.failRelayAction("ping");
    await expect(h.callTool("decorate_openings", { pageId: page, doors: [OPENING], windows: [], secretDoors: [] })).rejects.toThrow();
    expect(h.relayLog).not.toContain("clearDLOpenings");
  });

  it("says so when a secret door cannot be marked, rather than reporting it placed", async () => {
    rt.failWrites = true;
    await expect(h.callTool("decorate_openings", { pageId: page, doors: [], windows: [], secretDoors: [OPENING] }))
      .rejects.toThrow(/players can see it/);
  });
});
