// Two false successes found live on cos-test (2026-11-06): createCharacter's sheet stamp never
// reached Roll20, and decorate_openings' secret doors were only purple. Both fixes write RTDB, which
// the emulator has no model of, so rtUpdate and rtGet are backed by a map here. That proves the
// writes are made and read back, not what Roll20 does with them.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const rt = vi.hoisted(() => ({
  store: new Map<string, unknown>(),
  dropWrites: false,
  failWrites: false,
  onWrite: (_path: string, _props: Record<string, unknown>): void => undefined,
}));
vi.mock("../src/bridge/roll20-rt.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/bridge/roll20-rt.js")>()),
  rtUpdate: async (path: string, props: Record<string, unknown>) => {
    if (rt.failWrites) throw new Error("injected rtUpdate failure");
    if (rt.dropWrites) return;
    for (const [k, v] of Object.entries(props)) rt.store.set(`${path}/${k}`, v);
    rt.onWrite(path, props);
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
  rt.onWrite = () => undefined;
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

  it("marks each batch of secret doors secret before creating the next batch", async () => {
    const secretAtEachCreate: number[] = [];
    const real = h.emu.relayAsync.bind(h.emu);
    vi.spyOn(h.emu, "relayAsync").mockImplementation((cmd) => {
      if ((cmd as { action?: string }).action === "createDLDoors") secretAtEachCreate.push(held().length);
      return real(cmd) as never;
    });
    const secretDoors = Array.from({ length: 25 }, (_, i) => ({ ...OPENING, center: [70 + i * 70, 350] }));
    const { isError } = await h.callTool("decorate_openings", { pageId: page, doors: [], windows: [], secretDoors });
    expect(isError).toBeFalsy();
    expect(secretAtEachCreate).toEqual([0, 20]);
    expect(held()).toHaveLength(25);
  });

  it("takes the door back off when it cannot be marked secret, so players never see it", async () => {
    rt.failWrites = true;
    const { isError, text } = await h.callTool("decorate_openings", { pageId: page, doors: [], windows: [], secretDoors: [OPENING] });
    expect(isError).toBe(true);
    expect(text).toMatch(/injected rtUpdate failure/);
    expect(h.emu.findObjs({ _type: "door", _pageid: page })).toHaveLength(0);
  });
});

describe("decorate_openings keeps the page's openings when a swap fails", () => {
  const NEW = { center: [350, 350], widthPx: 70, angleDeg: 0 };
  const decorate = async (args: Record<string, unknown>) => {
    const res = await h.callTool("decorate_openings", { pageId: page, ...args });
    return { ...res, r: res.json as { error: string; restored: boolean; restoreError?: string; prior: Record<string, unknown> } };
  };
  const live = () => h.emu.findObjs({ _type: "door", _pageid: page });
  const liveWindows = () => h.emu.findObjs({ _type: "window", _pageid: page });
  const coloured = (c: string) => live().find((d) => d.get("color") === c)!;
  const applyToEmulator = (path: string, props: Record<string, unknown>) => {
    const [node, , , id] = path.split("/");
    h.emu.getObj(node === "doors" ? "door" : "window", id)!.set(props);
  };

  beforeEach(() => {
    rt.onWrite = applyToEmulator;
    const [secret, locked] = h.emu.relay<{ id: string }[]>({
      action: "createDLDoors", pageId: page, doors: [
        { x: 210, y: -105, x0: -30, y0: 5, x1: 50, y1: -5, color: "#9932CC" },
        { x: 70, y: -70, x0: 0, y0: 35, x1: 0, y1: -35, color: "#123456" },
      ],
    });
    h.emu.getObj("door", secret.id)!.set({ isSecret: true, isOpen: true });
    h.emu.getObj("door", locked.id)!.set({ isLocked: true });
    h.emu.relay({ action: "createDLWindows", pageId: page, windows: [{ x: 140, y: -70, x0: 0, y0: 35, x1: 0, y1: -35 }] });
    h.clearRelayLog();
  });

  it("puts the prior openings back, state included, when a swap fails part-way", async () => {
    // Only the first state write fails: the new secret door's. The rollback's own writes go through.
    let failNext = true;
    rt.onWrite = (path, props) => {
      if (failNext) { failNext = false; throw new Error("injected state failure"); }
      applyToEmulator(path, props);
    };
    const { isError, r } = await decorate({ secretDoors: [NEW] });
    expect(isError).toBe(true);
    expect(r.restored).toBe(true);
    expect(r.error).toMatch(/2 doors and 1 windows are back in place/);
    expect(live()).toHaveLength(2);
    expect(liveWindows()).toHaveLength(1);
    expect(coloured("#9932CC").get("isSecret")).toBe(true);
    expect(coloured("#9932CC").get("isOpen")).toBe(true);
    expect(coloured("#123456").get("isLocked")).toBe(true);
  });

  it("leaves the records alone when the clear itself fails", async () => {
    const ids = live().map((d) => d.id);
    h.failRelayAction("clearDLOpenings");
    const { isError, r } = await decorate({ doors: [NEW] });
    expect(isError).toBe(true);
    expect(r.restored).toBe(true);
    expect(live().map((d) => d.id)).toEqual(ids);
  });

  it("hands back prior when it cannot restore, and restore rebuilds the page", async () => {
    h.failRelayAction("createDLDoors");
    const { isError, r } = await decorate({ doors: [NEW] });
    expect(isError).toBe(true);
    expect(r.restored).toBe(false);
    expect(r.restoreError).toMatch(/createDLDoors/);
    expect(r.error).toMatch(/restore: prior/);
    expect(live()).toHaveLength(0);

    h.clearRelayFailures();
    const again = await decorate({ restore: r.prior });
    expect(again.isError).toBe(false);
    expect(live()).toHaveLength(2);
    expect(liveWindows()).toHaveLength(1);
    expect(coloured("#9932CC").get("isSecret")).toBe(true);
  });

  it("refuses restore alongside new openings, with nothing changed", async () => {
    const { isError } = await decorate({ doors: [NEW], restore: { doors: [], windows: [] } });
    expect(isError).toBe(true);
    expect(h.relayLog).not.toContain("clearDLOpenings");
  });
});
