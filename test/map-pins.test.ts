// ─────────────────────────────────────────────────────────────────────────────
// Roll20 map pins (issue #203) — direct RTDB CRUD + maps tools.
//
// Pins are plain RTDB nodes at `pins/page/<pageId>/<pinId>` (verified live on #203), so there is no
// relay action and no emulator dispatch to test — the four `roll20-rt.js` primitives are mocked
// with an in-memory tree and the tests assert what ends up at which path.
//
// Two hazards these tests pin beyond the happy path:
//   - GM notes: Roll20 documents `gmNotesVisibleTo` as defaulting to "all", so create_map_pin must
//     write "" (GM only) unless the caller says otherwise — a leak is silent in the UI.
//   - camelCase: `gmnotes` is the natural typo for a codebase where every other object spells it
//     that way. The MCP SDK STRIPS unknown keys during validation, so a typo is dropped, not
//     rejected — the test below asserts the drop honestly and that the echoed key list reveals it.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect, beforeEach, vi } from "vitest";
import { z } from "zod";
import { registerMapTools } from "../src/tools/maps.js";
import { FakeMcpServer } from "./harness.js";

// vi.mock factories are hoisted above imports — define the store via vi.hoisted so it exists first.
const rt = vi.hoisted(() => {
  const store = new Map<string, Record<string, unknown>>(); // "<pageId>/<pinId>" → pin
  let seq = 0;
  const parse = (relPath: string) => {
    const parts = relPath.replace(/^\/+|\/+$/g, "").split("/");
    if (parts[0] !== "pins" || parts[1] !== "page") throw new Error(`unexpected path ${relPath}`);
    return { pageId: parts[2], pinId: parts[3] };
  };
  return {
    store,
    reset() { store.clear(); seq = 0; },
    async rtGet(relPath: string) {
      const { pageId, pinId } = parse(relPath);
      if (pinId) return store.get(`${pageId}/${pinId}`) ?? null;
      const tree: Record<string, Record<string, Record<string, unknown>>> = {};
      for (const [k, v] of store) {
        const [p, id] = k.split("/");
        (tree[p] ??= {})[id] = v;
      }
      if (pageId) return tree[pageId] ?? null;
      return Object.keys(tree).length ? tree : null;
    },
    async rtPushObject(relPath: string, value: Record<string, unknown>) {
      const { pageId } = parse(relPath);
      const id = `-Pin${String(++seq).padStart(3, "0")}`;
      store.set(`${pageId}/${id}`, { ...value, id });
      return id;
    },
    async rtUpdate(relPath: string, partial: Record<string, unknown>) {
      const { pageId, pinId } = parse(relPath);
      const key = `${pageId}/${pinId}`;
      const cur = store.get(key);
      if (!cur) throw new Error(`update on missing ${key}`);
      for (const [k, v] of Object.entries(partial)) {
        if (v === undefined) throw new Error(`undefined written to ${key}.${k}`);
        cur[k] = v;
      }
    },
    async rtRemove(relPath: string) {
      const { pageId, pinId } = parse(relPath);
      store.delete(`${pageId}/${pinId}`);
    },
  };
});

vi.mock("../src/bridge/roll20-rt.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/bridge/roll20-rt.js")>();
  return { ...actual, rtGet: rt.rtGet, rtPushObject: rt.rtPushObject, rtUpdate: rt.rtUpdate, rtRemove: rt.rtRemove };
});

let server: FakeMcpServer;
const PAGE = "-PageKeyed";
const OTHER = "-PageOther";

async function callTool(name: string, args: Record<string, unknown> = {}) {
  const entry = server.handlers.get(name);
  if (!entry) throw new Error(`No such tool registered: ${name}`);
  // z.object(shape).parse mirrors the MCP SDK: unknown keys are stripped, not rejected.
  const parsed = entry.schema ? (z.object(entry.schema).parse(args) as Record<string, unknown>) : args;
  const res = await entry.handler(parsed);
  const text = res?.content?.[0]?.text ?? "";
  let json: unknown;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { text, json };
}

type Created = { pinId: string; pageId: string; x: number; y: number; wrote: string[] };
type PinRead = Record<string, unknown> & { id: string; pageId: string };

beforeEach(() => {
  rt.reset();
  server = new FakeMcpServer();
  registerMapTools(server as never);
});

describe("create_map_pin", () => {
  it("pushes a pin under pins/page/<pageId>/<pinId> with the push key stamped as id", async () => {
    const { json } = await callTool("create_map_pin", {
      pageId: PAGE, x: 350, y: 210,
      title: "1. Gatehouse", notes: "<p>Two guards.</p>", gmNotes: "<p>They are cultists.</p>",
      icon: "base-castle", bgColor: "#8B0000", visibleTo: "all", desynced: true,
    });
    const r = json as Created;
    expect(r.pageId).toBe(PAGE);
    expect(r.x).toBe(350);
    const stored = rt.store.get(`${PAGE}/${r.pinId}`)!;
    expect(stored).toBeDefined();
    expect(stored.id).toBe(r.pinId);
    expect(stored).not.toHaveProperty("pageId"); // page is the path, not a payload field
    expect(stored).toMatchObject({ x: 350, y: 210, title: "1. Gatehouse", icon: "base-castle", bgColor: "#8B0000", visibleTo: "all" });
    expect(stored).toMatchObject({ imageDesynced: true, notesDesynced: true, gmNotesDesynced: true });
    expect(stored).not.toHaveProperty("desynced");
    expect(r.wrote).toContain("gmNotesDesynced");
  });

  it('defaults gmNotesVisibleTo to "" (GM only) — Roll20 would default it to "all"', async () => {
    const { json } = await callTool("create_map_pin", { pageId: PAGE, x: 0, y: 0, gmNotes: "secret" });
    const stored = rt.store.get(`${PAGE}/${(json as Created).pinId}`)!;
    expect(stored.gmNotesVisibleTo).toBe("");
    expect((json as Created).wrote).toContain("gmNotesVisibleTo");
  });

  it("honours an explicit gmNotesVisibleTo", async () => {
    const { json } = await callTool("create_map_pin", { pageId: PAGE, x: 0, y: 0, gmNotesVisibleTo: "all" });
    expect(rt.store.get(`${PAGE}/${(json as Created).pinId}`)!.gmNotesVisibleTo).toBe("all");
  });

  it("does not write other unset visibility/look fields (no zod defaults leak in)", async () => {
    const { json } = await callTool("create_map_pin", { pageId: PAGE, x: 70, y: 140 });
    const stored = rt.store.get(`${PAGE}/${(json as Created).pinId}`)!;
    expect(Object.keys(stored).sort()).toEqual(["gmNotesVisibleTo", "id", "x", "y"]);
  });

  it("silently DROPS a lowercase/typo'd field (SDK strips unknown keys) and the `wrote` list shows it", async () => {
    const { json } = await callTool("create_map_pin", { pageId: PAGE, x: 0, y: 0, gmnotes: "typo" });
    const r = json as Created;
    const stored = rt.store.get(`${PAGE}/${r.pinId}`)!;
    expect(stored).not.toHaveProperty("gmnotes");
    expect(stored).not.toHaveProperty("gmNotes");
    expect(r.wrote).not.toContain("gmnotes");
  });

  it("stores notes well beyond the Roll20 UI's 750-char cap intact", async () => {
    const notes = "<p>" + "Keyed area description. ".repeat(400) + "</p>";
    expect(notes.length).toBeGreaterThan(8000);
    const { json } = await callTool("create_map_pin", { pageId: PAGE, x: 0, y: 0, notes });
    expect(rt.store.get(`${PAGE}/${(json as Created).pinId}`)!.notes).toBe(notes);
  });

  it("rejects an autoNotesType outside the enum and a bad audience value", async () => {
    await expect(callTool("create_map_pin", { pageId: PAGE, x: 0, y: 0, autoNotesType: "fancy" })).rejects.toThrow();
    await expect(callTool("create_map_pin", { pageId: PAGE, x: 0, y: 0, visibleTo: "gm" })).rejects.toThrow();
    const { json } = await callTool("create_map_pin", { pageId: PAGE, x: 0, y: 0, autoNotesType: "blockquote" });
    expect(rt.store.get(`${PAGE}/${(json as Created).pinId}`)!.autoNotesType).toBe("blockquote");
  });
});

describe("list_map_pins", () => {
  it("lists only the requested page and returns id + pageId on each pin", async () => {
    await callTool("create_map_pin", { pageId: PAGE, x: 1, y: 1, title: "A" });
    await callTool("create_map_pin", { pageId: PAGE, x: 2, y: 2, title: "B" });
    await callTool("create_map_pin", { pageId: OTHER, x: 3, y: 3, title: "C" });
    const { json } = await callTool("list_map_pins", { pageId: PAGE });
    const pins = json as PinRead[];
    expect(pins.map((p) => p.title).sort()).toEqual(["A", "B"]);
    for (const p of pins) {
      expect(p.pageId).toBe(PAGE);
      expect(p.id).toMatch(/^-Pin/);
    }
  });

  it("lists every page when pageId is omitted", async () => {
    await callTool("create_map_pin", { pageId: PAGE, x: 1, y: 1, title: "A" });
    await callTool("create_map_pin", { pageId: OTHER, x: 3, y: 3, title: "C" });
    const { json } = await callTool("list_map_pins", {});
    expect((json as PinRead[]).map((p) => `${p.pageId}:${p.title}`).sort()).toEqual([`${PAGE}:A`, `${OTHER}:C`]);
  });

  it("returns [] for a page with no pins node (null read is not an error)", async () => {
    const { json } = await callTool("list_map_pins", { pageId: "-Nowhere" });
    expect(json).toEqual([]);
  });
});

describe("update_map_pin", () => {
  it("writes only the passed fields and leaves the rest untouched", async () => {
    const { json: c } = await callTool("create_map_pin", { pageId: PAGE, x: 10, y: 20, title: "Hidden Shrine", visibleTo: "", icon: "base-dot" });
    const id = (c as Created).pinId;
    const { json } = await callTool("update_map_pin", { pinId: id, pageId: PAGE, visibleTo: "all" });
    expect(json).toEqual({ pinId: id, pageId: PAGE, updated: ["visibleTo"] });
    expect(rt.store.get(`${PAGE}/${id}`)).toMatchObject({ x: 10, y: 20, title: "Hidden Shrine", visibleTo: "all", icon: "base-dot" });
  });

  it("finds the pin by scanning pages when pageId is omitted", async () => {
    await callTool("create_map_pin", { pageId: OTHER, x: 0, y: 0 });
    const { json: c } = await callTool("create_map_pin", { pageId: PAGE, x: 0, y: 0 });
    const id = (c as Created).pinId;
    const { json } = await callTool("update_map_pin", { pinId: id, title: "Found" });
    expect(json).toMatchObject({ pinId: id, pageId: PAGE });
    expect(rt.store.get(`${PAGE}/${id}`)!.title).toBe("Found");
  });

  it("expands desynced into the coupled triple", async () => {
    const { json: c } = await callTool("create_map_pin", { pageId: PAGE, x: 0, y: 0 });
    const id = (c as Created).pinId;
    await callTool("update_map_pin", { pinId: id, pageId: PAGE, desynced: false });
    expect(rt.store.get(`${PAGE}/${id}`)).toMatchObject({ imageDesynced: false, notesDesynced: false, gmNotesDesynced: false });
  });

  it("errors on a missing pin and on an update with nothing to write", async () => {
    await expect(callTool("update_map_pin", { pinId: "-Nope", pageId: PAGE, title: "x" })).rejects.toThrow(/not found/i);
    const { json: c } = await callTool("create_map_pin", { pageId: PAGE, x: 0, y: 0 });
    await expect(callTool("update_map_pin", { pinId: (c as Created).pinId, pageId: PAGE })).rejects.toThrow(/nothing to write/);
    await expect(callTool("update_map_pin", { pinId: (c as Created).pinId, pageId: PAGE, gmnotes: "typo" })).rejects.toThrow(/nothing to write/);
  });
});

describe("delete_map_pin", () => {
  it("removes the node and a subsequent list no longer shows it", async () => {
    const { json: c } = await callTool("create_map_pin", { pageId: PAGE, x: 0, y: 0 });
    const id = (c as Created).pinId;
    const { json } = await callTool("delete_map_pin", { pinId: id });
    expect(json).toEqual({ ok: true, pinId: id, pageId: PAGE });
    expect(rt.store.has(`${PAGE}/${id}`)).toBe(false);
    expect((await callTool("list_map_pins", { pageId: PAGE })).json).toEqual([]);
  });

  it("refuses an empty or path-shaped id instead of addressing the whole page (was: wiped every pin)", async () => {
    await callTool("create_map_pin", { pageId: PAGE, x: 70, y: 70, title: "keep me" });
    await callTool("create_map_pin", { pageId: PAGE, x: 140, y: 140, title: "and me" });
    const before = rt.store.size;
    for (const pinId of ["", "/", "a/b", ".."]) {
      await expect(callTool("delete_map_pin", { pageId: PAGE, pinId })).rejects.toThrow(/not a Roll20 id/);
      await expect(callTool("delete_map_pin", { pinId })).rejects.toThrow(/not a Roll20 id/);
      await expect(callTool("update_map_pin", { pageId: PAGE, pinId, title: "x" })).rejects.toThrow(/not a Roll20 id/);
    }
    await expect(callTool("create_map_pin", { pageId: "", x: 1, y: 1 })).rejects.toThrow(/not a Roll20 id/);
    expect(rt.store.size).toBe(before);
  });

  it("errors on a missing pin", async () => {
    await expect(callTool("delete_map_pin", { pinId: "-Nope" })).rejects.toThrow(/not found/i);
  });
});
