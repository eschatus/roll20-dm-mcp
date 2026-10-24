// ─────────────────────────────────────────────────────────────────────────────
// Issue #246 — set_bar, the semantics-free token-bar primitive.
// Drives the REAL tool handler against the emulator running mod-scripts/ai-relay.js.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupHarness, type Harness } from "./harness.js";

let h: Harness;
let pageId: string;

const tok = (id: string) => h.emu.getObj("graphic", id)!;
const get = (id: string, p: string) => tok(id).get(p);

function token(name: string, props: Record<string, unknown> = {}): string {
  return h.emu.createToken({ pageid: pageId, name, ...props }).id;
}

beforeAll(() => {
  h = setupHarness({ seed: 246 });
  pageId = h.emu.createPage("Bar Tests");
  h.emu.setPlayerPage(pageId);
});
afterAll(() => h.teardown());

type R = { results: Array<{ before: { value: number | null; max: number | null }; after: { value: number | null; max: number | null }; clamped: boolean; linked: null | { attributeId: string; wroteAttribute: boolean; wroteToken: boolean } }> };

describe("set_bar — plain writes", () => {
  it("sets an absolute value on bar1 with NO 5e semantics (no dead marker at 0, no layer move)", async () => {
    const id = token("Adept", { bar1_value: 11, bar1_max: 11 });
    const { json } = await h.callTool("set_bar", { tokenId: id, bar: 1, value: 0 });
    expect(get(id, "bar1_value")).toBe(0);
    expect(get(id, "statusmarkers")).toBe("");
    expect(get(id, "layer")).toBe("objects");
    expect((json as R).results[0]).toMatchObject({ before: { value: 11, max: 11 }, after: { value: 0, max: 11 }, linked: null });
  });

  it("writes bar2 and bar3 and sets max", async () => {
    const id = token("Mage", { bar2_value: 10, bar2_max: 10, bar3_value: 3, bar3_max: 7 });
    await h.callTool("set_bar", { tokenId: id, bar: 2, value: 7 });
    await h.callTool("set_bar", { tokenId: id, bar: 3, max: 6 });
    expect(get(id, "bar2_value")).toBe(7);
    expect(get(id, "bar3_max")).toBe(6);
    expect(get(id, "bar3_value")).toBe(3);
  });

  it("resolves characterName", async () => {
    const id = token("Barghest Prime", { bar1_value: 20, bar1_max: 20 });
    await h.callTool("set_bar", { characterName: "Barghest Prime", bar: 1, delta: -5 });
    expect(get(id, "bar1_value")).toBe(15);
  });
});

describe("set_bar — delta and clamp", () => {
  it("applies a relative delta", async () => {
    const id = token("D1", { bar1_value: 10, bar1_max: 12 });
    const { json } = await h.callTool("set_bar", { tokenId: id, bar: 1, delta: -3 });
    expect(get(id, "bar1_value")).toBe(7);
    expect((json as R).results[0]).toMatchObject({ before: { value: 10 }, after: { value: 7 }, clamped: false });
  });

  it("clamps to [0, max] by default and reports it", async () => {
    const id = token("D2", { bar1_value: 3, bar1_max: 12 });
    let r = (await h.callTool("set_bar", { tokenId: id, bar: 1, delta: -9 })).json as R;
    expect(get(id, "bar1_value")).toBe(0);
    expect(r.results[0].clamped).toBe(true);
    r = (await h.callTool("set_bar", { tokenId: id, bar: 1, delta: 50 })).json as R;
    expect(get(id, "bar1_value")).toBe(12);
    expect(r.results[0].clamped).toBe(true);
  });

  it("clamp:false lets a delta run past the track", async () => {
    const id = token("D3", { bar1_value: 2, bar1_max: 12 });
    await h.callTool("set_bar", { tokenId: id, bar: 1, delta: -5, clamp: false });
    expect(get(id, "bar1_value")).toBe(-3);
  });

  it("max + delta: the delta clamps against the NEW max", async () => {
    const id = token("D4", { bar1_value: 5, bar1_max: 12 });
    await h.callTool("set_bar", { tokenId: id, bar: 1, max: 8, delta: 10 });
    expect(get(id, "bar1_max")).toBe(8);
    expect(get(id, "bar1_value")).toBe(8);
  });

  it("an absolute value is NOT clamped", async () => {
    const id = token("D5", { bar1_value: 5, bar1_max: 12 });
    await h.callTool("set_bar", { tokenId: id, bar: 1, value: 20 });
    expect(get(id, "bar1_value")).toBe(20);
  });
});

describe("set_bar — loud failures, nothing written", () => {
  it("delta on a bar with no numeric value fails and does not write NaN", async () => {
    const id = token("N1", { bar2_value: "", bar2_max: "" });
    await expect(h.callTool("set_bar", { tokenId: id, bar: 2, delta: -1 })).rejects.toThrow(/no numeric value/);
    expect(get(id, "bar2_value")).toBe("");
  });

  it("clamped delta with no numeric max fails; clamp:false succeeds", async () => {
    const id = token("N2", { bar2_value: 4, bar2_max: "" });
    await expect(h.callTool("set_bar", { tokenId: id, bar: 2, delta: -1 })).rejects.toThrow(/no numeric max/);
    expect(get(id, "bar2_value")).toBe(4);
    await h.callTool("set_bar", { tokenId: id, bar: 2, delta: -1, clamp: false });
    expect(get(id, "bar2_value")).toBe(3);
  });

  it("rejects value+delta, empty input, bad bar, clamp without delta, unknown token — before any relay call", async () => {
    const id = token("N3", { bar1_value: 5, bar1_max: 5 });
    h.clearRelayLog();
    await expect(h.callTool("set_bar", { tokenId: id, bar: 1, value: 1, delta: 1 })).rejects.toThrow(/value OR delta/);
    await expect(h.callTool("set_bar", { tokenId: id, bar: 1 })).rejects.toThrow(/at least one/);
    await expect(h.callTool("set_bar", { tokenId: id, bar: 4, value: 1 })).rejects.toThrow();
    await expect(h.callTool("set_bar", { tokenId: id, bar: 1, value: 1, clamp: true })).rejects.toThrow(/clamp only applies/);
    await expect(h.callTool("set_bar", { bar: 1, value: 1 })).rejects.toThrow(/tokenId or characterName/);
    await expect(h.callTool("set_bar", { tokenId: id, bar: 1, value: Number.NaN })).rejects.toThrow();
    expect(h.relayLog).not.toContain("setBar");
    expect(get(id, "bar1_value")).toBe(5);
  });

  it("an unknown tokenId fails in the relay", async () => {
    await expect(h.callTool("set_bar", { tokenId: "nope", bar: 1, value: 1 })).rejects.toThrow(/token not found/);
  });
});

describe("set_bar — bulk targets[]", () => {
  it("applies every target and returns before/after for each", async () => {
    const a = token("B1", { bar1_value: 10, bar1_max: 10 });
    const b = token("B2", { bar1_value: 8, bar1_max: 8 });
    const { json } = await h.callTool("set_bar", { targets: [{ tokenId: a, bar: 1, delta: -4 }, { tokenId: b, bar: 1, value: 1 }] });
    expect(get(a, "bar1_value")).toBe(6);
    expect(get(b, "bar1_value")).toBe(1);
    expect((json as R).results).toHaveLength(2);
  });

  it("is all-or-nothing: one invalid target means NO target is written", async () => {
    const a = token("B3", { bar1_value: 10, bar1_max: 10 });
    const b = token("B4", { bar1_value: "", bar1_max: "" });
    await expect(h.callTool("set_bar", { targets: [{ tokenId: a, bar: 1, delta: -4 }, { tokenId: b, bar: 1, delta: -1 }] })).rejects.toThrow(/no numeric value/);
    expect(get(a, "bar1_value")).toBe(10);
  });

  it("rejects mixing targets[] with top-level fields", async () => {
    const a = token("B5", { bar1_value: 10, bar1_max: 10 });
    await expect(h.callTool("set_bar", { tokenId: a, bar: 1, value: 1, targets: [{ tokenId: a, bar: 1, value: 2 }] })).rejects.toThrow(/not both/);
  });
});

describe("set_bar — linked bars (attribute is the source of truth)", () => {
  function linked(name: string, cur: number, max: number) {
    const charId = h.emu.createCharacter(name, {});
    const attr = h.emu.createObj("attribute", { characterid: charId, name: "physical", current: cur, max });
    const id = token(name, { represents: charId, bar1_value: cur, bar1_max: max, bar1_link: attr.id });
    return { id, attr };
  }

  it("reads BEFORE from the attribute, writes the attribute AND mirrors the token, and says so", async () => {
    const { id, attr } = linked("Linked A", 9, 11);
    // Drift: the token disagrees with the sheet. The sheet wins.
    tok(id).set({ bar1_value: 2 });
    const { json } = await h.callTool("set_bar", { tokenId: id, bar: 1, delta: -3 });
    expect(attr.get("current")).toBe(6);
    expect(get(id, "bar1_value")).toBe(6);
    expect((json as R).results[0]).toMatchObject({
      before: { value: 9, max: 11 }, after: { value: 6, max: 11 },
      linked: { attributeId: attr.id, wroteAttribute: true, wroteToken: true },
    });
  });

  it("writes max through the link too", async () => {
    const { id, attr } = linked("Linked B", 5, 5);
    await h.callTool("set_bar", { tokenId: id, bar: 1, max: 9, value: 9 });
    expect(attr.get("max")).toBe(9);
    expect(attr.get("current")).toBe(9);
    expect(get(id, "bar1_max")).toBe(9);
  });

  it("a dangling link fails loudly instead of silently writing only the token", async () => {
    const id = token("Linked C", { bar1_value: 5, bar1_max: 5, bar1_link: "-gone" });
    await expect(h.callTool("set_bar", { tokenId: id, bar: 1, value: 1 })).rejects.toThrow(/dangling link/);
    expect(get(id, "bar1_value")).toBe(5);
  });
});
