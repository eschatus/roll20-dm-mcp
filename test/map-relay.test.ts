// ─────────────────────────────────────────────────────────────────────────────
// Map/wall/vision relay actions — behavioral coverage (red-team #4).
//
// These ~dozen actions (createPath(s), createWalls, createGraphic, createDLDoors,
// setPageProps/Background, clearLayer, getPaths/Walls/Doors, listPages) ran the
// real ai-relay.js dispatch with NO automated coverage — the largest untested
// surface in the riskiest runtime (the sandbox, where a bad write kills everything).
// Each is driven through the emulator and round-tripped where possible (write via
// the relay, read it back via the relay).
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { Roll20Emulator } from "./roll20-emulator.js";

let emu: Roll20Emulator;
let pid: string;

beforeEach(() => {
  emu = new Roll20Emulator({ seed: 11 });
  emu.load();
  pid = emu.createPage("Dungeon");
});

describe("path / wall writes", () => {
  it("createPath places a path on the walls layer and getPaths reads it back", () => {
    const res = emu.relay<{ id?: string }>({
      action: "createPath", pageId: pid, layer: "walls",
      path: JSON.stringify([["M", 0, 0], ["L", 70, 0]]),
      left: 35, top: 0, width: 70, height: 1,
    });
    expect(res.id).toBeTruthy();
    expect(emu.getObj("path", res.id!)).toBeTruthy();

    const paths = emu.relay<unknown[]>({ action: "getPaths", pageId: pid, layer: "walls" });
    expect(Array.isArray(paths)).toBe(true);
    expect(paths.length).toBe(1);
  });

  it("createPaths places several at once", () => {
    const res = emu.relay<unknown[]>({
      action: "createPaths", pageId: pid, layer: "walls",
      paths: [
        { path: JSON.stringify([["M", 0, 0], ["L", 70, 0]]), left: 35, top: 0, width: 70, height: 1 },
        { path: JSON.stringify([["M", 0, 0], ["L", 0, 70]]), left: 0, top: 35, width: 1, height: 70 },
      ],
    });
    expect(Array.isArray(res)).toBe(true);
    expect(res.length).toBe(2);
    expect(emu.relay<unknown[]>({ action: "getPaths", pageId: pid, layer: "walls" }).length).toBe(2);
  });

  it("createWalls + getWalls round-trips DL barriers", () => {
    const res = emu.relay<unknown[]>({
      action: "createWalls", pageId: pid,
      walls: [{ points: [[0, 0], [140, 0]] }, { points: [[0, 0], [0, 140]] }],
      strokeColor: "#0044FF",
    });
    expect(Array.isArray(res)).toBe(true);
    const walls = emu.relay<unknown[]>({ action: "getWalls", pageId: pid });
    expect(walls.length).toBeGreaterThanOrEqual(2);
  });

  // #207: createWalls used to fall back to a legacy `path` object hardcoded to yellow
  // (#FFFF00) when createObj("pathv2") came back undefined. pathv2 is createObj-able on the
  // supported engine, so the fallback was dead code that would have broken the blue-wall
  // convention if it ever fired. Walls are pathv2, blue by default, and nothing lands on the
  // walls layer as a legacy path.
  it("createWalls makes blue pathv2 barriers with no legacy-path fallback", () => {
    const res = emu.relay<Array<{ id: string; kind: string }>>({
      action: "createWalls", pageId: pid,
      walls: [{ x1: 0, y1: 0, x2: 140, y2: 0 }, { x1: 0, y1: 0, x2: 0, y2: 140 }],
    });
    expect(res.map((r) => r.kind)).toEqual(["pathv2", "pathv2"]);
    for (const r of res) {
      const obj = emu.getObj("pathv2", r.id);
      expect(obj).toBeTruthy();
      expect(obj!.get("stroke")).toBe("#0044FF");
      expect(obj!.get("shape")).toBe("pol");
    }
    // No legacy path objects on the walls layer — getWalls reports those with kind "path".
    const walls = emu.relay<Array<{ kind: string }>>({ action: "getWalls", pageId: pid });
    expect(walls.filter((w) => w.kind === "path")).toEqual([]);
  });

  // The emulator's createObj never returns undefined, so the behavioral test above cannot reach
  // the removed branch. Pin it at the source level instead (same approach as
  // test/chat-trigger-safety.test.ts): no wall creator may create a legacy `path` on the walls
  // layer, and no yellow may be hardcoded there.
  it("no wall creator in ai-relay.js carries a legacy-path / yellow fallback", () => {
    const src = readFileSync("mod-scripts/ai-relay.js", "utf8");
    const handlerBody = (action: string) => {
      const start = src.indexOf(`ACTIONS["${action}"]`);
      expect(start, `${action} handler not found`).toBeGreaterThan(-1);
      const next = src.indexOf('ACTIONS["', start + 1);
      return src.slice(start, next === -1 ? undefined : next);
    };

    // createWalls only ever creates walls: nothing legacy, no yellow anywhere in it.
    const walls = handlerBody("createWalls");
    expect(walls).not.toContain("#FFFF00");
    expect(walls).not.toContain('createObj("path"');
    expect(walls).toContain("pathv2Failure");

    // createPolylines also draws on non-wall layers with legacy paths (yellow default is fine
    // there), so check only the walls branch — everything up to its pathv2 failure throw.
    const polylines = handlerBody("createPolylines");
    expect(polylines).toContain("pathv2Failure");
    expect(polylines.slice(0, polylines.indexOf("pathv2Failure"))).not.toContain("#FFFF00");
  });

  it("clearLayer removes everything on the walls layer", () => {
    emu.relay({ action: "createPath", pageId: pid, layer: "walls",
      path: JSON.stringify([["M", 0, 0], ["L", 70, 0]]), left: 35, top: 0, width: 70, height: 1 });
    expect(emu.relay<unknown[]>({ action: "getPaths", pageId: pid, layer: "walls" }).length).toBe(1);

    emu.relay({ action: "clearLayer", pageId: pid, layers: ["walls"] });
    expect(emu.relay<unknown[]>({ action: "getPaths", pageId: pid, layer: "walls" }).length).toBe(0);
  });
});

describe("DL openings", () => {
  it("createDLDoors + getDoors round-trips door objects", () => {
    const res = emu.relay<Array<{ id?: string }>>({
      action: "createDLDoors", pageId: pid,
      doors: [{ x: 135, y: 100, x0: 100, y0: 100, x1: 170, y1: 100 }],
    });
    expect(Array.isArray(res)).toBe(true);
    expect(res[0].id).toBeTruthy();
    const out = emu.relay<{ doors: unknown[]; windows: unknown[] }>({ action: "getDoors", pageId: pid });
    expect(out.doors.length).toBeGreaterThanOrEqual(1);
  });
});

describe("graphics + page props", () => {
  it("createGraphic places a graphic on the map layer", () => {
    const res = emu.relay<{ id?: string }>({
      action: "createGraphic", pageId: pid, layer: "map",
      imgsrc: "https://example.com/x.png", left: 350, top: 350, width: 700, height: 700,
    });
    expect(res.id).toBeTruthy();
    expect(emu.getObj("graphic", res.id!)).toBeTruthy();
  });

  it("setPageProps updates name + dimensions", () => {
    emu.relay({ action: "setPageProps", pageId: pid, name: "Renamed Hall", width: 30, height: 20 });
    const page = emu.getObj("page", pid)!;
    expect(page.get("name")).toBe("Renamed Hall");
    expect(Number(page.get("width"))).toBe(30);
  });

  it("setPageBackground sets the page color", () => {
    emu.relay({ action: "setPageBackground", pageId: pid, color: "#101010" });
    expect(emu.getObj("page", pid)!.get("background_color")).toBe("#101010");
  });

  it("setPageProps throws on a missing page (not a silent no-op)", () => {
    expect(() => emu.relay({ action: "setPageProps", pageId: "no-page", name: "X" })).toThrow(/page not found/i);
  });

  it("listPages includes the created page", () => {
    const pages = emu.relay<Array<{ id?: string; name?: string }>>({ action: "listPages" });
    expect(pages.some((p) => p.name === "Dungeon")).toBe(true);
  });
});
