// ─────────────────────────────────────────────────────────────────────────────
// Roll20 map pins (issue #203) — relay actions + maps tools.
//
// A pin is the first object type in this codebase whose properties are camelCase
// (`gmNotes`, `bgColor`, `pinImage`, `visibleTo`), which makes the lowercase spelling
// used everywhere else in the Roll20 API exactly the mistake to expect — and Roll20
// drops an unsupported property write silently, no error (the `path` lesson from
// #162/#164). So these tests assert two things beyond the happy path:
//   - the emulator's `pin` whitelist is ARMED, so a lowercase/typo'd property fails a
//     test instead of looking like a successful write;
//   - the desync triple (imageDesynced/notesDesynced/gmNotesDesynced) is handled as the
//     ONE coupled flag Roll20 makes it, not three independent booleans.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { z } from "zod";
import { Roll20Emulator } from "./roll20-emulator.js";
import * as roll20 from "../src/bridge/roll20.js";
import { registerMapTools } from "../src/tools/maps.js";
import { FakeMcpServer } from "./harness.js";

let emu: Roll20Emulator;
let server: FakeMcpServer;
let pageId: string;

async function callTool(name: string, args: Record<string, unknown> = {}) {
  const entry = server.handlers.get(name);
  if (!entry) throw new Error(`No such tool registered: ${name}`);
  const parsed = entry.schema ? (z.object(entry.schema).parse(args) as Record<string, unknown>) : args;
  const res = await entry.handler(parsed);
  const text = res?.content?.[0]?.text ?? "";
  let json: unknown;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { text, json };
}

beforeEach(() => {
  emu = new Roll20Emulator({ seed: 203 });
  emu.load();
  roll20.__setBridgeTestTransport({
    relay: <T>(cmd: Record<string, unknown>) => Promise.resolve(emu.relay<T>(cmd)),
    evaluate: <T>(fn: (args?: unknown) => T, args?: unknown) => {
      (globalThis as unknown as { window: unknown }).window = { Campaign: emu.campaignModel };
      return Promise.resolve(fn(args));
    },
  });
  server = new FakeMcpServer();
  registerMapTools(server as never);
  pageId = emu.createPage("Keyed Locations");
  emu.setPlayerPage(pageId);
});

afterEach(() => {
  roll20.__setBridgeTestTransport(null as never);
});

type PinRead = Record<string, unknown> & { id: string; pageid: string };

describe("createPin / getPins relay round-trip", () => {
  it("creates a pin on the page and reads every property back", () => {
    const res = emu.relay<{ id: string; pageId: string; wrote: string[] }>({
      action: "createPin", pageId, x: 350, y: 700,
      title: "Shrine of the Drowned", notes: "<p>A cracked altar.</p>", gmNotes: "<p>Hag lairs here.</p>",
      shape: "teardrop", icon: "base-skullSimple", customizationType: "icon",
      bgColor: "#0044FF", scale: 1.5, visibleTo: "", gmNotesVisibleTo: "all",
    });
    expect(res.id).toBeTruthy();
    expect(res.pageId).toBe(pageId);
    expect(res.wrote).toContain("gmNotes");

    const pins = emu.relay<PinRead[]>({ action: "getPins", pageId });
    expect(pins).toHaveLength(1);
    expect(pins[0].id).toBe(res.id);
    expect(pins[0].title).toBe("Shrine of the Drowned");
    expect(pins[0].gmNotes).toBe("<p>Hag lairs here.</p>");
    expect(pins[0].icon).toBe("base-skullSimple");
    expect(pins[0].scale).toBe(1.5);
    expect(pins[0].x).toBe(350);
    expect(pins[0].y).toBe(700);
    // visibleTo "" is the hidden-until-found state — it must round-trip as "", not vanish.
    expect(pins[0].visibleTo).toBe("");
    expect(pins[0].gmNotesVisibleTo).toBe("all");
  });

  it("refuses a property that is not a real pin property instead of writing it", () => {
    // `gmnotes` (lowercase) is the spelling every other object type in this API uses, so it is the
    // typo to expect. A real sandbox would drop it silently and report success.
    const res = emu.relay<{ id: string; wrote: string[] }>({
      action: "createPin", pageId, x: 0, y: 0, title: "Probe", gmnotes: "<p>dropped</p>",
    });
    expect(res.wrote).toContain("title");
    expect(res.wrote).not.toContain("gmnotes");
    const pin = emu.getObj("pin", res.id)!;
    expect(pin.get("gmnotes")).toBe("");
    expect(pin.get("gmNotes")).toBe("");
  });

  it("the emulator's pin whitelist is armed — a lowercase write throws rather than silently passing", () => {
    const { id } = emu.relay<{ id: string }>({ action: "createPin", pageId, x: 0, y: 0, title: "Probe" });
    const pin = emu.getObj("pin", id)!;
    expect(() => pin.set("gmnotes", "<p>nope</p>")).toThrow(/not a real Roll20 "pin" property/);
    expect(() => pin.set("bgcolor", "#FF0000")).toThrow(/not a real Roll20 "pin" property/);
  });

  it("getPins filters by page, and lists every pin when pageId is omitted", () => {
    const other = emu.createPage("Elsewhere");
    emu.relay({ action: "createPin", pageId, x: 0, y: 0, title: "Here" });
    emu.relay({ action: "createPin", pageId: other, x: 0, y: 0, title: "There" });

    expect(emu.relay<PinRead[]>({ action: "getPins", pageId }).map((p) => p.title)).toEqual(["Here"]);
    expect(emu.relay<PinRead[]>({ action: "getPins", pageId: other }).map((p) => p.title)).toEqual(["There"]);
    expect(emu.relay<PinRead[]>({ action: "getPins" })).toHaveLength(2);
  });
});

describe("setPinProps / deletePin", () => {
  it("writes only the properties passed and leaves the rest alone", () => {
    const { id } = emu.relay<{ id: string }>({
      action: "createPin", pageId, x: 70, y: 70, title: "Hidden Cache", notes: "<p>keep</p>", visibleTo: "",
    });
    const res = emu.relay<{ ok: boolean; updated: string[] }>({
      action: "setPinProps", pinId: id, visibleTo: "all",
    });
    expect(res.ok).toBe(true);
    expect(res.updated).toEqual(["visibleTo"]);

    const pin = emu.relay<PinRead[]>({ action: "getPins", pageId })[0];
    expect(pin.visibleTo).toBe("all");
    expect(pin.notes).toBe("<p>keep</p>");
    expect(pin.title).toBe("Hidden Cache");
  });

  it("errors on an unknown pin id rather than reporting a write that never happened", () => {
    expect(() => emu.relay({ action: "setPinProps", pinId: "-Nnope", visibleTo: "all" }))
      .toThrow(/Pin not found/);
    expect(() => emu.relay({ action: "deletePin", pinId: "-Nnope" })).toThrow(/Pin not found/);
  });

  it("errors when no writable property was passed", () => {
    const { id } = emu.relay<{ id: string }>({ action: "createPin", pageId, x: 0, y: 0 });
    expect(() => emu.relay({ action: "setPinProps", pinId: id, notAPinProp: 1 }))
      .toThrow(/no pin properties to write/);
  });

  it("deletePin removes the pin", () => {
    const { id } = emu.relay<{ id: string }>({ action: "createPin", pageId, x: 0, y: 0, title: "Doomed" });
    expect(emu.relay<PinRead[]>({ action: "getPins", pageId })).toHaveLength(1);
    expect(emu.relay<{ ok: boolean }>({ action: "deletePin", pinId: id }).ok).toBe(true);
    expect(emu.relay<PinRead[]>({ action: "getPins", pageId })).toHaveLength(0);
    expect(emu.getObj("pin", id)).toBeUndefined();
  });
});

describe("the desync triple is one coupled flag", () => {
  it("setting one desync flag sets all three", () => {
    const { id } = emu.relay<{ id: string }>({
      action: "createPin", pageId, x: 0, y: 0, link: "handout-1", linkType: "handout",
      title: "Own content", notesDesynced: true,
    });
    const pin = emu.relay<PinRead[]>({ action: "getPins", pageId })[0];
    expect(pin.id).toBe(id);
    expect(pin.notesDesynced).toBe(true);
    expect(pin.imageDesynced).toBe(true);
    expect(pin.gmNotesDesynced).toBe(true);
  });

  it("refuses two different desync values instead of letting last-write-wins decide", () => {
    expect(() => emu.relay({
      action: "createPin", pageId, x: 0, y: 0, notesDesynced: true, imageDesynced: false,
    })).toThrow(/ONE coupled flag/);
  });
});

describe("maps tools", () => {
  it("create_map_pin → list_map_pins → update_map_pin → delete_map_pin", async () => {
    const created = await callTool("create_map_pin", {
      pageId, x: 1050, y: 350, title: "Village of Barovia", notes: "<p>Ravens everywhere.</p>",
      gmNotes: "<p>Ismark waits in the tavern.</p>", icon: "base-village", customizationType: "icon",
      visibleTo: "", shape: "circle",
    });
    const { pinId } = created.json as { pinId: string; wrote: string[] };
    expect(pinId).toBeTruthy();

    const listed = (await callTool("list_map_pins", { pageId })).json as PinRead[];
    expect(listed).toHaveLength(1);
    expect(listed[0].title).toBe("Village of Barovia");
    expect(listed[0].icon).toBe("base-village");
    expect(listed[0].shape).toBe("circle");
    expect(listed[0].visibleTo).toBe("");

    // Reveal it — the "they found the shrine" move.
    const updated = (await callTool("update_map_pin", { pinId, visibleTo: "all" })).json as { updated: string[] };
    expect(updated.updated).toEqual(["visibleTo"]);
    expect(((await callTool("list_map_pins", { pageId })).json as PinRead[])[0].visibleTo).toBe("all");

    const deleted = (await callTool("delete_map_pin", { pinId })).json as { ok: boolean };
    expect(deleted.ok).toBe(true);
    expect((await callTool("list_map_pins", { pageId })).json).toEqual([]);
  });

  it("the tool's single `desynced` boolean expands to all three Roll20 flags", async () => {
    const { pinId } = (await callTool("create_map_pin", {
      pageId, x: 0, y: 0, title: "Overrides its handout", link: "handout-1", linkType: "handout", desynced: true,
    })).json as { pinId: string };
    const pin = ((await callTool("list_map_pins", { pageId })).json as PinRead[])[0];
    expect(pin.id).toBe(pinId);
    expect(pin.imageDesynced).toBe(true);
    expect(pin.notesDesynced).toBe(true);
    expect(pin.gmNotesDesynced).toBe(true);
  });

  it("update_map_pin writes only what it was passed — an unset field never resets a look", async () => {
    const { pinId } = (await callTool("create_map_pin", {
      pageId, x: 0, y: 0, title: "Keep", shape: "diamond", bgColor: "#0044FF", scale: 2,
    })).json as { pinId: string };
    await callTool("update_map_pin", { pinId, x: 700, y: 140 });
    const pin = ((await callTool("list_map_pins", { pageId })).json as PinRead[])[0];
    expect(pin.x).toBe(700);
    expect(pin.y).toBe(140);
    expect(pin.shape).toBe("diamond");
    expect(pin.bgColor).toBe("#0044FF");
    expect(pin.scale).toBe(2);
  });
});
