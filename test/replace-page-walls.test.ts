// ─────────────────────────────────────────────────────────────────────────────
// replace_page_walls (#280), driven through the real tool, bridge and ai-relay.js.
//
// The emulator's createObj never fails and it stores whatever it is given, so these tests can prove
// ordering, refusal and failure reporting, and that records round-trip. They cannot prove what
// Roll20 does with a record; docs/roll20-api-coverage.md lists what still needs a live run.
//
// Door state goes straight to RTDB, which the emulator has no model of, so rtUpdate is mocked to
// write the same fields onto the emulator's door object.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const rt = vi.hoisted(() => ({
  apply: (_path: string, _props: Record<string, unknown>): Promise<void> => Promise.resolve(),
  calls: [] as { path: string; props: Record<string, unknown> }[],
}));
vi.mock("../src/bridge/roll20-rt.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/bridge/roll20-rt.js")>()),
  rtUpdate: (path: string, props: Record<string, unknown>) => {
    rt.calls.push({ path, props });
    return rt.apply(path, props);
  },
}));

import { setupHarness, type Harness } from "./harness.js";
import { registerWallReplaceTools, classifyWall } from "../src/tools/wall-replace.js";
import type { Roll20Emulator } from "./roll20-emulator.js";

type Pair = [number, number];
interface Result {
  error?: string;
  stage?: string;
  placed: { walls: number; doors: number; windows: number; secretDoors: number };
  removed: { walls: number; oldWalls: number; doors: number; windows: number; openingsCleared: boolean };
  kept: { id: string; kind: string; reason: string }[];
  after: { walls: number; doors: number; windows: number; fingerprint: string; verified: boolean; matchesRestoredFingerprint?: boolean };
  leftOnPage: { walls: number; oldWalls: number; newWallIds: string[]; doors: number; windows: number; matchesPrior: boolean; unknown?: boolean };
  prior: { fingerprint: string; walls: { points: Pair[]; anchor: string }[]; doors: Record<string, unknown>[]; windows: Record<string, unknown>[] };
  fingerprint: string;
  wouldPlace: { walls: number };
  rolledBackNewWalls: number;
  liveFingerprint: string;
}

const emuCreate = (emu: Roll20Emulator) =>
  (emu as unknown as { createObj: (type: string, props: Record<string, unknown>) => { id: string } }).createObj;

const NEW_CONTENT = {
  walls: [{ from: [0, 0], to: [140, 0] }, { from: [700, 700], to: [700, 840] }],
  doors: [{ center: [350, 350], widthPx: 70, angleDeg: 0 }],
  windows: [{ center: [500, 350], widthPx: 70, angleDeg: 90 }],
};

let h: Harness;
let page: string;
let doorId: string;

const call = async (args: Record<string, unknown>) => {
  const res = await h.callTool("replace_page_walls", { pageId: page, ...args });
  return { ...res, r: res.json as Result };
};
const barriers = () => h.emu.findObjs({ _type: "pathv2", _pageid: page });
const doors = () => h.emu.findObjs({ _type: "door", _pageid: page });
const windows = () => h.emu.findObjs({ _type: "window", _pageid: page });
const writes = () => h.relayLog.filter((a) => !["getWalls", "getDoors"].includes(a));

// One of each record the page can hold: a centred createWalls wall, an uneven polyline anchored on
// its first vertex (the shape of a GM-drawn wall), and a locked door whose handles are not
// symmetric, which the {center, widthPx, angleDeg} form could not describe.
function seedPage() {
  h.emu.relay({ action: "createWalls", pageId: page, walls: [{ x1: 100, y1: 100, x2: 300, y2: 100 }] });
  h.emu.relay({ action: "createPolylines", pageId: page, polylines: [{ points: [[400, 400], [500, 400], [500, 650]] }] });
  const res = h.emu.relay<{ id: string }[]>({
    action: "createDLDoors", pageId: page, doors: [{ x: 210, y: -105, x0: -30, y0: 5, x1: 50, y1: -5, color: "#123456" }],
  });
  doorId = res[0].id;
  h.emu.getObj("door", doorId)!.set({ isLocked: true, isOpen: true });
  h.emu.relay({ action: "createDLWindows", pageId: page, windows: [{ x: 70, y: -70, x0: 0, y0: 35, x1: 0, y1: -35 }] });
}

beforeEach(() => {
  h = setupHarness({ seed: 11 });
  registerWallReplaceTools(h.server as never);
  page = h.emu.createPage("Replace me");
  rt.calls.length = 0;
  rt.apply = (path, props) => {
    const [node, , , id] = path.split("/");
    h.emu.getObj(node === "doors" ? "door" : "window", id)!.set(props);
    return Promise.resolve();
  };
  seedPage();
  h.clearRelayLog();
});

afterEach(() => h.teardown());

describe("replacing", () => {
  it("swaps walls and openings, reports placed counts, and returns the prior state", async () => {
    const oldIds = barriers().map((w) => w.id);
    const { r, isError } = await call(NEW_CONTENT);
    expect(isError).toBe(false);
    expect(r.placed).toEqual({ walls: 2, doors: 1, windows: 1, secretDoors: 0 });
    expect(r.removed).toEqual({ walls: 2, doors: 1, windows: 1 });
    expect(r.after).toMatchObject({ walls: 2, doors: 1, windows: 1, verified: true });
    expect(barriers().some((w) => oldIds.includes(w.id))).toBe(false);
    expect(r.prior.walls).toHaveLength(2);
    expect(r.prior.doors).toHaveLength(1);
    expect(r.prior.windows).toHaveLength(1);
  });

  it("places new walls before touching the old ones, so the page is never wall-less", async () => {
    await call(NEW_CONTENT);
    expect(h.relayLog.indexOf("createWalls")).toBeLessThan(h.relayLog.indexOf("clearDLOpenings"));
    expect(h.relayLog.indexOf("createDLWindows")).toBeLessThan(h.relayLog.indexOf("removeObject"));
  });

  it("uses blue walls, cyan windows, purple secret doors, and short segments", async () => {
    const { r } = await call({
      walls: [{ from: [0, 0], to: [1000, 0] }], doors: [], windows: NEW_CONTENT.windows,
      secretDoors: [{ center: [350, 350], widthPx: 70, angleDeg: 0 }], maxSegmentPx: 200,
    });
    expect(r.placed.walls).toBeGreaterThanOrEqual(5);
    expect(barriers().every((w) => w.get("stroke") === "#0044FF")).toBe(true);
    expect(barriers().every((w) => (JSON.parse(String(w.get("points"))) as Pair[]).length === 2)).toBe(true);
    expect(windows()[0].get("color")).toBe("#00FFFF");
    expect(doors()[0].get("color")).toBe("#9932CC");
    expect(doors()[0].get("isSecret")).toBe(true);
    expect(r.placed.secretDoors).toBe(1);
  });

  // The direct branch of createDLDoors writes an id-less record that blocks nothing. The emulator
  // can't see that branch, so assert the flag that keeps the command off it.
  it("sends door and window creation to the Mod, not the direct RTDB branch", async () => {
    const spy = vi.spyOn(h.emu, "relayAsync");
    await call(NEW_CONTENT);
    const cmds = spy.mock.calls.map(([cmd]) => cmd as Record<string, unknown>)
      .filter((c) => c.action === "createDLDoors" || c.action === "createDLWindows");
    expect(cmds).toHaveLength(2);
    expect(cmds.every((c) => c.__forceMod === true)).toBe(true);
  });

  it("requires walls, doors and windows together, so a forgotten array cannot wipe the doors", async () => {
    const { isError, text } = await call({ walls: NEW_CONTENT.walls });
    expect(isError).toBe(true);
    expect(text).toMatch(/all required/);
    expect(h.relayLog).toEqual([]);
    expect(doors()).toHaveLength(1);
  });

  it("treats explicit empty arrays as none", async () => {
    const { r } = await call({ walls: [], doors: [], windows: [] });
    expect(r.after).toMatchObject({ walls: 0, doors: 0, windows: 0, verified: true });
  });

  it("refuses restore combined with new content", async () => {
    const { r } = await call({ dryRun: true });
    const res = await call({ ...NEW_CONTENT, restore: r.prior });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/not both/);
  });
});

describe("what it leaves alone", () => {
  it("keeps a non-wall path and a graphic on the walls layer", async () => {
    const path = h.emu.relay<{ id: string }>({
      action: "createPath", pageId: page, layer: "walls",
      path: JSON.stringify([["M", 0, 0], ["L", 70, 0]]), left: 35, top: 0, width: 70, height: 1,
    });
    const graphic = h.emu.relay<{ id: string }>({
      action: "createGraphic", pageId: page, layer: "walls", imgsrc: "https://example.com/x.png",
      left: 350, top: 350, width: 70, height: 70,
    });
    const { r } = await call(NEW_CONTENT);
    expect(h.emu.getObj("path", path.id)).toBeTruthy();
    expect(h.emu.getObj("graphic", graphic.id)).toBeTruthy();
    expect(r.kept).toEqual([expect.objectContaining({ id: path.id, kind: "path" })]);
    expect(r.after.verified).toBe(true);
  });

  it("keeps barriers it could not recreate, and says why", async () => {
    const create = emuCreate(h.emu);
    const oneWay = create("pathv2", { pageid: page, layer: "walls", x: 10, y: 10, shape: "pol", barrierType: "oneWay", points: "[[0,0],[70,0]]" });
    const rec = create("pathv2", { pageid: page, layer: "walls", x: 348, y: 2023, shape: "rec", points: "[[0,0],[406,392]]" });
    const { r } = await call(NEW_CONTENT);
    expect(h.emu.getObj("pathv2", oneWay.id)).toBeTruthy();
    expect(h.emu.getObj("pathv2", rec.id)).toBeTruthy();
    expect(r.kept.map((k) => k.reason).join()).toMatch(/oneWay.*rec/);
    expect(r.prior.walls).toHaveLength(2);
  });

  it("does not touch another page", async () => {
    const other = h.emu.createPage("Other");
    h.emu.relay({ action: "createWalls", pageId: other, walls: [{ x1: 0, y1: 0, x2: 70, y2: 0 }] });
    await call(NEW_CONTENT);
    expect(h.emu.findObjs({ _type: "pathv2", _pageid: other })).toHaveLength(1);
  });
});

describe("classifying a wall", () => {
  const base = { id: "w", kind: "pathv2" };

  // Roll20 drops barrierType on store and the Mod reads a plain wall back as "wall". A filter
  // requiring the value would pass here on an emulator wall and miss every wall on a live page.
  it.each([["wall"], [""], [undefined]])("treats barrierType %j as a plain wall", (barrierType) => {
    const c = classifyWall({ ...base, barrierType, x: 200, y: 100, shape: "pol", points: [[100, 100], [300, 100]] });
    expect(c).toEqual({ wall: expect.objectContaining({ anchor: "center" }) });
  });

  it("anchors a GM-drawn record on its first vertex", () => {
    const c = classifyWall({ ...base, x: 400.4, y: 400, shape: "pol", points: [[400, 400], [500, 400], [500, 650]] });
    expect(c).toEqual({ wall: expect.objectContaining({ anchor: "first" }) });
  });

  it("keeps a record it cannot anchor rather than rebuild it somewhere else", () => {
    const c = classifyWall({ ...base, x: 450, y: 500, shape: "pol", points: [[400, 400], [500, 400], [500, 650]] });
    expect(c).toEqual({ kept: expect.objectContaining({ reason: expect.stringMatching(/anchored/) }) });
  });

  it("keeps a record whose points came back as null, as NaN does over JSON", () => {
    const c = classifyWall({ ...base, x: 0, y: 0, shape: "pol", points: [[null, null], [1, 1]] });
    expect(c).toEqual({ kept: expect.objectContaining({ reason: "points are unreadable" }) });
  });
});

describe("restoring", () => {
  it("rebuilds every wall record verbatim and every door's geometry and state", async () => {
    const record = (o: { get(k: string): unknown }) => [o.get("x"), o.get("y"), o.get("points")].join("|");
    const wallsBefore = barriers().map(record).sort();

    const { r: first } = await call(NEW_CONTENT);
    const { r: back, isError } = await call({ restore: first.prior });

    expect(isError).toBe(false);
    expect(back.after).toMatchObject({ walls: 2, doors: 1, windows: 1, verified: true, matchesRestoredFingerprint: true });
    expect(back.after.fingerprint).toBe(first.prior.fingerprint);
    expect(barriers().map(record).sort()).toEqual(wallsBefore);

    expect(doors()).toHaveLength(1);
    const door = doors()[0];
    expect(door.get("x")).toBe(210);
    expect(door.get("y")).toBe(-105);
    expect(door.get("path")).toEqual({ handle0: { x: -30, y: 5 }, handle1: { x: 50, y: -5 } });
    expect(door.get("color")).toBe("#123456");
    expect(door.get("isLocked")).toBe(true);
    expect(door.get("isOpen")).toBe(true);
  });

  it("does not write state for an opening that has none", async () => {
    const { r: first } = await call(NEW_CONTENT);
    rt.calls.length = 0;
    await call({ restore: first.prior });
    expect(rt.calls).toHaveLength(1);
    expect(rt.calls[0].path).toMatch(/^doors\/page\//);
    expect(rt.calls[0].props).toEqual({ isOpen: true, isLocked: true });
  });

  it("puts walls with a custom stroke back in blue, as the tool description says", async () => {
    barriers()[0].set({ stroke: "#ABCDEF" });
    const { r: first } = await call(NEW_CONTENT);
    await call({ restore: first.prior });
    expect(barriers().every((w) => w.get("stroke") === "#0044FF")).toBe(true);
  });
});

describe("expected-prior check", () => {
  it("refuses with no writes when a wall was moved after the read", async () => {
    const { r: read } = await call({ dryRun: true });
    const wall = barriers()[0];
    wall.set({ points: JSON.stringify([[-100, 0], [100, 40]]) });
    h.clearRelayLog();

    const { r, isError } = await call({ ...NEW_CONTENT, expectedFingerprint: read.fingerprint });

    expect(isError).toBe(true);
    expect(r.error).toMatch(/Refused/);
    expect(r.liveFingerprint).not.toBe(read.fingerprint);
    expect(writes()).toEqual([]);
    expect(barriers()).toHaveLength(2);
  });

  it("refuses when a door was hand-moved or locked after the read", async () => {
    const { r: read } = await call({ dryRun: true });
    h.emu.getObj("door", doorId)!.set({ isLocked: false });
    expect((await call({ ...NEW_CONTENT, expectedFingerprint: read.fingerprint })).isError).toBe(true);
  });

  it("proceeds when nothing changed, and a door opened in play does not count as a change", async () => {
    const { r: read } = await call({ dryRun: true });
    h.emu.getObj("door", doorId)!.set({ isOpen: false });
    const { isError, r } = await call({ ...NEW_CONTENT, expectedFingerprint: read.fingerprint });
    expect(isError).toBe(false);
    expect(r.placed.walls).toBe(2);
  });

  it("chains: the after.fingerprint of one replace guards the next", async () => {
    const { r: one } = await call(NEW_CONTENT);
    const { isError } = await call({ ...NEW_CONTENT, expectedFingerprint: one.after.fingerprint });
    expect(isError).toBe(false);
  });
});

describe("dry run", () => {
  it("writes nothing and reports what would be placed", async () => {
    const { r } = await call({ ...NEW_CONTENT, dryRun: true });
    expect(writes()).toEqual([]);
    expect(r.wouldPlace).toMatchObject({ walls: 2, doors: 1, windows: 1 });
    expect(r.prior.walls).toHaveLength(2);
  });

  it("refuses a page with an opening it could not restore", async () => {
    h.emu.getObj("door", doorId)!.set({ path: {} });
    const { isError, text } = await call(NEW_CONTENT);
    expect(isError).toBe(true);
    expect(text).toMatch(/unreadable geometry/);
    expect(writes()).toEqual([]);
  });
});

describe("partial failure", () => {
  // Rejects the Nth call of a relay action, leaving the others to run for real.
  function failNth(action: string, n: number) {
    const real = h.emu.relayAsync.bind(h.emu);
    let seen = 0;
    vi.spyOn(h.emu, "relayAsync").mockImplementation((cmd) => {
      if ((cmd as { action?: string }).action === action && ++seen === n) return Promise.reject(new Error(`injected ${action} failure`));
      return real(cmd) as never;
    });
  }

  const LONG_WALLS = { ...NEW_CONTENT, walls: Array.from({ length: 30 }, (_, i) => ({ from: [i * 100, 0], to: [i * 100 + 50, 0] })) };

  it("wall placement fails first: page untouched, nothing to restore", async () => {
    h.failRelayAction("createWalls");
    const { r, isError } = await call(NEW_CONTENT);
    expect(isError).toBe(true);
    expect(r.stage).toBe("place-walls");
    expect(r.leftOnPage).toMatchObject({ walls: 2, oldWalls: 2, doors: 1, windows: 1, matchesPrior: true });
    expect(r.error).toMatch(/nothing needs restoring/);
    expect(h.relayLog).not.toContain("clearDLOpenings");
  });

  it("a later wall batch fails: earlier batches are removed and the originals survive", async () => {
    const oldIds = barriers().map((w) => w.id);
    failNth("createWalls", 2);
    const { r } = await call(LONG_WALLS);
    expect(r.stage).toBe("place-walls");
    expect(r.rolledBackNewWalls).toBe(20);
    expect(r.placed.walls).toBe(0);
    expect(r.leftOnPage.matchesPrior).toBe(true);
    expect(barriers().map((w) => w.id).sort()).toEqual(oldIds.sort());
  });

  it("a failed rollback is reported, with the walls it stranded", async () => {
    failNth("createWalls", 2);
    h.failRelayAction("removeObject", "Mod went quiet");
    const { r, isError } = await call(LONG_WALLS);
    expect(isError).toBe(true);
    expect(r).toMatchObject({ rollbackError: expect.stringContaining("Mod went quiet"), rolledBackNewWalls: 0 });
    expect(r.leftOnPage.newWallIds).toHaveLength(20);
    expect(r.leftOnPage.matchesPrior).toBe(false);
    expect(r.error).toMatch(/restore: prior/);
  });

  it("door creation fails after the clear: names what is left, and restore recovers it", async () => {
    h.failRelayAction("createDLDoors");
    const { r, isError } = await call(NEW_CONTENT);
    expect(isError).toBe(true);
    expect(r.stage).toBe("swap-openings");
    expect(r.removed).toEqual({ oldWalls: 0, openingsCleared: true });
    expect(r.leftOnPage).toMatchObject({ walls: 4, oldWalls: 2, doors: 0, windows: 0, matchesPrior: false });
    expect(r.error).toMatch(/4 walls \(2 of the 2 prior, 2 new, 0 kept\), 0 doors, 0 windows/);
    expect(r.error).toMatch(/restore: prior/);

    h.clearRelayFailures();
    const { r: back } = await call({ restore: r.prior });
    expect(back.after).toMatchObject({ walls: 2, doors: 1, windows: 1, matchesRestoredFingerprint: true });
  });

  it("the door state write fails: reported at its own stage", async () => {
    const { r: first } = await call(NEW_CONTENT);
    rt.apply = () => Promise.reject(new Error("permission denied"));
    const { r, isError } = await call({ restore: first.prior });
    expect(isError).toBe(true);
    expect(r.stage).toBe("set-opening-state");
    expect(r.error).toMatch(/permission denied/);
  });

  it("removing the old walls fails partway: names both sets, and restore recovers it", async () => {
    failNth("removeObject", 2);
    const { r, isError } = await call(NEW_CONTENT);
    expect(isError).toBe(true);
    expect(r.stage).toBe("remove-old-walls");
    expect(r.removed.oldWalls).toBe(1);
    expect(r.leftOnPage).toMatchObject({ walls: 3, oldWalls: 1, doors: 1, windows: 1 });
    expect(r.leftOnPage.newWallIds).toHaveLength(2);

    vi.restoreAllMocks();
    const { r: back } = await call({ restore: r.prior });
    expect(back.after).toMatchObject({ walls: 2, matchesRestoredFingerprint: true });
  });

  it("says the state is unknown when the re-read fails too, and still carries prior", async () => {
    h.failRelayAction("createDLDoors");
    const realRelay = h.emu.relayAsync.bind(h.emu);
    let wallReads = 0;
    vi.spyOn(h.emu, "relayAsync").mockImplementation((cmd) => {
      if ((cmd as { action?: string }).action === "getWalls" && ++wallReads === 2) return Promise.reject(new Error("Mod parked"));
      return realRelay(cmd) as never;
    });
    const { r } = await call(NEW_CONTENT);
    expect(r.leftOnPage).toMatchObject({ unknown: true });
    expect(r.error).toMatch(/unknown/);
    expect(r.prior.walls).toHaveLength(2);
  });

  it("nothing is written when the opening read fails", async () => {
    h.failRelayAction("getDoors", "transport down");
    await expect(call(NEW_CONTENT)).rejects.toThrow(/transport down/);
    expect(writes()).toEqual([]);
  });
});
