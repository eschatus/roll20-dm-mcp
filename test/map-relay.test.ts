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
