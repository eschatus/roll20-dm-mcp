// Module-build gaps (#277): the page and character holes found building modules into a template
// game. rtCreatePage is the one RTDB write here, so it is mocked onto the emulator; everything else
// runs the real tool handlers against the real relay.
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";

// ASSET_BASE is resolved at import, so it has to point away from data/maps before maps.ts loads.
const ctx = await vi.hoisted(async () => {
  const { mkdtempSync } = await import("fs");
  const { tmpdir } = await import("os");
  const { join } = await import("path");
  const assets = mkdtempSync(join(tmpdir(), "module-build-gaps-"));
  process.env.ROLL20_ASSET_DIR = assets;
  return {
    assets,
    createPage: null as null | ((name: string, w: number, h: number) => string),
    created: [] as string[],
  };
});

vi.mock("../src/bridge/roll20-rt.js", async (original) => ({
  ...(await original<typeof import("../src/bridge/roll20-rt.js")>()),
  rtCreatePage: async (o: { name: string; widthSquares: number; heightSquares: number }) => {
    ctx.created.push(o.name);
    return ctx.createPage!(o.name, o.widthSquares, o.heightSquares);
  },
}));

// batch_import_maps reaches for Python, image decoding and an art upload before and after the
// page step these tests are about.
vi.mock("child_process", async (original) => ({
  ...(await original<typeof import("child_process")>()),
  execFile: (_f: string, _a: string[], _o: unknown, cb: (e: null, r: { stdout: string }) => void) =>
    cb(null, { stdout: JSON.stringify({ imageDimensions: "700×700px", candidates: [] }) }),
}));
vi.mock("../src/tools/vision.js", async (original) => ({
  ...(await original<typeof import("../src/tools/vision.js")>()),
  prepareImage: async () => ({ widthPx: 700, heightPx: 700, buffer: Buffer.alloc(0) }),
  detectGridByAutocorrelation: async () => ({ gridSizePx: 70, gridOffsetX: 0, gridOffsetY: 0 }),
}));
vi.mock("../src/bridge/roll20.js", async (original) => ({
  ...(await original<typeof import("../src/bridge/roll20.js")>()),
  uploadArt: async () => "https://example.invalid/art.webp",
}));

import { setupHarness, type Harness } from "./harness.js";
import { Roll20Emulator } from "./roll20-emulator.js";
import { registerMapTools } from "../src/tools/maps.js";
import { registerBatchTools } from "../src/tools/batch.js";
import { mapPageRow } from "../src/bridge/roll20-rt.js";

type SetupResult = {
  pageId: string; widthSquares: number; heightSquares: number; scale: string; created: boolean;
  dynamic_lighting_enabled: boolean | null;
};
type Refusal = { error: string; existing: { pageId: string; name: string; width: number; height: number }[] };

let h: Harness;
let templateDl: boolean;

beforeEach(() => {
  h = setupHarness();
  registerMapTools(h.server as never);
  registerBatchTools(h.server as never);
  templateDl = false;
  ctx.created.length = 0;
  ctx.createPage = (name, width, height) =>
    h.emu.createPage(name, { width, height, dynamic_lighting_enabled: templateDl });
  h.clearRelayLog();
});

afterEach(() => h.teardown());
afterAll(() => fs.rmSync(ctx.assets, { recursive: true, force: true }));

const page = (id: string, prop: string) => h.emu.objectProp("page", id, prop);

describe("setup_roll20_page refuses a name already taken", () => {
  it("names the existing page and changes nothing, matching case-insensitively", async () => {
    const id = h.emu.createPage("Warship", { width: 12, height: 9 });
    h.clearRelayLog();

    const r = await h.callTool("setup_roll20_page", { name: "WARSHIP", widthSquares: 40, heightSquares: 40 });

    expect(r.isError).toBe(true);
    const body = r.json as Refusal;
    expect(body.error).toContain('"Warship"');
    expect(body.error).toContain(id);
    expect(body.error).toContain("reuseExisting");
    expect(body.existing).toEqual([{ pageId: id, name: "Warship", width: 12, height: 9 }]);
    expect(h.relayLog).toEqual(["listPages"]);
    expect(ctx.created).toEqual([]);
    expect(page(id, "width")).toBe(12);
  });

  it("creates a page whose name is free, with the old defaults", async () => {
    const r = await h.callTool("setup_roll20_page", { name: "Crypt" });

    expect(r.isError).toBe(false);
    const body = r.json as SetupResult;
    expect(body).toMatchObject({ created: true, widthSquares: 30, heightSquares: 20, scale: "5ft" });
    expect(ctx.created).toEqual(["Crypt"]);
    expect(page(body.pageId, "scale_number")).toBe(5);
    expect(page(body.pageId, "scale_units")).toBe("ft");
    expect(page(body.pageId, "showgrid")).toBe(true);
  });
});

describe("setup_roll20_page reuseExisting", () => {
  it("changes only what was passed: the defaults must not resize the page", async () => {
    const id = h.emu.createPage("Warship", { width: 12, height: 9, scale_number: 10, showgrid: false });

    const r = await h.callTool("setup_roll20_page", { name: "Warship", widthSquares: 14, reuseExisting: true });

    expect(r.isError).toBe(false);
    expect(r.json).toMatchObject({ pageId: id, created: false, widthSquares: 14, heightSquares: 9, scale: "unchanged" });
    expect(ctx.created).toEqual([]);
    expect(page(id, "width")).toBe(14);
    expect(page(id, "height")).toBe(9);
    expect(page(id, "scale_number")).toBe(10);
    expect(page(id, "showgrid")).toBe(false);
  });

  it("writes nothing at all when nothing was passed", async () => {
    const id = h.emu.createPage("Warship", { width: 12, height: 9 });
    h.clearRelayLog();

    const r = await h.callTool("setup_roll20_page", { name: "Warship", reuseExisting: true });

    expect(r.json).toMatchObject({ pageId: id, created: false, widthSquares: 12, heightSquares: 9 });
    expect(h.relayLog).toEqual(["listPages"]);
  });

  it("refuses when several pages share the name, rather than picking one", async () => {
    const a = h.emu.createPage("Warship", { width: 12, height: 9 });
    const b = h.emu.createPage("warship", { width: 30, height: 30 });
    h.clearRelayLog();

    const r = await h.callTool("setup_roll20_page", { name: "Warship", widthSquares: 40, reuseExisting: true });

    expect(r.isError).toBe(true);
    expect((r.json as Refusal).existing.map((p) => p.pageId)).toEqual([a, b]);
    expect(h.relayLog).toEqual(["listPages"]);
  });
});

describe("batch_import_maps on a page that already exists", () => {
  const importWarship = async (args: Record<string, unknown>) => {
    fs.writeFileSync(path.join(ctx.assets, "Warship.png"), "not really a png");
    const r = await h.callTool("batch_import_maps", { wallMode: "none", ...args });
    return (r.json as { results: { pageId?: string; status: string; error?: string }[] }).results[0]!;
  };

  it("skips it by default", async () => {
    h.emu.createPage("Warship", { width: 12, height: 9 });
    expect((await importWarship({})).status).toBe("skipped");
    expect(ctx.created).toEqual([]);
  });

  it("reuses it when asked, without also having to turn skipExisting off", async () => {
    const id = h.emu.createPage("Warship", { width: 12, height: 9 });

    const row = await importWarship({ reuseExisting: true });

    expect(row).toMatchObject({ status: "success", pageId: id });
    expect(ctx.created).toEqual([]);
    expect(page(id, "width")).toBe(10);
  }, 10_000); // batch waits 2.5s after the page step
});

describe("partial scale on reuse", () => {
  const reuse = async (args: Record<string, unknown>) => {
    h.emu.createPage("Scaled", { width: 10, height: 10 });
    return (await h.callTool("setup_roll20_page", { name: "Scaled", reuseExisting: true, ...args })).json as { scale: string };
  };

  it("says which half changed instead of reporting a bare number", async () => {
    expect((await reuse({ scaleNumber: 10 })).scale).toBe("number set to 10, units unchanged");
  });

  it("says so when only the units change", async () => {
    expect((await reuse({ scaleUnits: "m" })).scale).toBe("units set to m, number unchanged");
  });

  it("reports both when both change, and unchanged when neither does", async () => {
    expect((await reuse({ scaleNumber: 10, scaleUnits: "m" })).scale).toBe("10m");
    h.emu.findObjs({ _type: "page", name: "Scaled" }).forEach((p) => p.set({ name: "Gone" }));
    expect((await reuse({})).scale).toBe("unchanged");
  });
});

describe("dynamic_lighting_enabled reads", () => {
  it("list_pages reports a page without the field as null, not by omitting it", async () => {
    h.stubRelayAction("listPages", [{ id: "bare", name: "Bare", width: 10, height: 10 }]);
    const pages = (await h.callTool("list_pages")).json as { id: string; dynamic_lighting_enabled?: boolean | null }[];
    expect(pages.find((p) => p.id === "bare")).toHaveProperty("dynamic_lighting_enabled", null);
  });

  it("get_current_page reports the page's value, false as well as true", async () => {
    const dark = h.emu.createPage("Keep", { width: 10, height: 10, dynamic_lighting_enabled: false });
    h.emu.setPlayerPage(dark);
    expect((await h.callTool("get_current_page")).json).toMatchObject({ pageId: dark, dynamic_lighting_enabled: false });

    const lit = h.emu.createPage("Lit Keep", { dynamic_lighting_enabled: true });
    h.emu.setPlayerPage(lit);
    expect((await h.callTool("get_current_page")).json).toMatchObject({ pageId: lit, dynamic_lighting_enabled: true });
  });

  it("says null, not false, when the page does not carry it", async () => {
    const id = h.emu.createPage("Keep");
    h.emu.setPlayerPage(id);
    h.stubRelayAction("listPages", [{ id, name: "Keep", width: 10, height: 10 }]);
    expect((await h.callTool("get_current_page")).json).toMatchObject({ dynamic_lighting_enabled: null });
  });

  it("setup_roll20_page reports a reused page's value", async () => {
    h.emu.createPage("Keep", { dynamic_lighting_enabled: true });
    const r = await h.callTool("setup_roll20_page", { name: "Keep", reuseExisting: true });
    expect(r.json).toMatchObject({ dynamic_lighting_enabled: true });
  });

  it("setup_roll20_page reads a new page's value back, because the template decides it", async () => {
    templateDl = true;
    const r = await h.callTool("setup_roll20_page", { name: "Fresh" });
    expect(r.json).toMatchObject({ created: true, dynamic_lighting_enabled: true });
  });

  it("the RTDB page row passes the value through and leaves an absent one absent", () => {
    const base = { id: "p", name: "n", width: 1, height: 2, zorder: "dropped" };
    expect(mapPageRow({ ...base, dynamic_lighting_enabled: false })).toEqual({
      id: "p", name: "n", width: 1, height: 2, dynamic_lighting_enabled: false,
    });
    expect(mapPageRow(base).dynamic_lighting_enabled).toBeUndefined();
  });
});
