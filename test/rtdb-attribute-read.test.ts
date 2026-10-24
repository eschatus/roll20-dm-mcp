import { describe, it, expect, vi, beforeEach } from "vitest";

const rt = vi.hoisted(() => ({ rtGet: vi.fn() }));
vi.mock("../src/bridge/roll20-rt.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/bridge/roll20-rt.js")>();
  return { ...actual, rtGet: rt.rtGet };
});

import { readCharacterAttributesRt, mapAttributeRecords, AttributeReadError } from "../src/bridge/attributes.js";

beforeEach(() => {
  rt.rtGet.mockReset();
});

describe("mapAttributeRecords", () => {
  it("maps name -> flat current, or {current,max} when max is present", () => {
    const out = mapAttributeRecords({
      "-A1": { id: "-A1", name: "strength", current: 11 },
      "-A2": { id: "-A2", name: "hp", current: "16", max: "22" },
    });
    expect(out).toEqual({ strength: 11, hp: { current: "16", max: "22" } });
  });
  it("reports an omitted current as empty string (relay parity); max-only keeps current empty", () => {
    const out = mapAttributeRecords({
      a: { id: "a", name: "unset" },
      b: { id: "b", name: "maxonly", max: 5 },
    });
    expect(out).toEqual({ unset: "", maxonly: { current: "", max: 5 } });
  });
  it("treats empty-string max as absent", () => {
    expect(mapAttributeRecords({ a: { id: "a", name: "x", current: 1, max: "" } })).toEqual({ x: 1 });
  });
  it("filters by names and keeps ids with _ and - intact", () => {
    const recs = {
      "-MSmlKZyB9tZyuD_a070": { id: "-MSmlKZyB9tZyuD_a070", name: "repeating_npcaction_-MSmlKP8_x_name", current: "Bite" },
      b: { id: "b", name: "dex", current: 9 },
    };
    expect(mapAttributeRecords(recs, ["repeating_npcaction_-MSmlKP8_x_name"])).toEqual({
      "repeating_npcaction_-MSmlKP8_x_name": "Bite",
    });
  });
  it("passes @{...} values through untouched", () => {
    expect(mapAttributeRecords({ a: { id: "a", name: "rb", current: "@{agility}+[[1d6]]" } })).toEqual({ rb: "@{agility}+[[1d6]]" });
  });
  it("returns {} for null (no attributes) and skips nameless records", () => {
    expect(mapAttributeRecords(null)).toEqual({});
    expect(mapAttributeRecords({ a: { id: "a", current: 1 } })).toEqual({});
  });
});

describe("readCharacterAttributesRt", () => {
  it("reads char-attribs/char/<id>", async () => {
    rt.rtGet.mockResolvedValue({ x: { id: "x", name: "ac", current: 14 } });
    expect(await readCharacterAttributesRt("-Mchar_1")).toEqual({ ac: 14 });
    expect(rt.rtGet).toHaveBeenCalledWith("char-attribs/char/-Mchar_1");
  });
  it("fails loudly with a typed error on RTDB failure (no fallback)", async () => {
    rt.rtGet.mockImplementation(async () => { throw new Error("permission_denied"); });
    const err = await readCharacterAttributesRt("-Mchar_1").then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(AttributeReadError);
    expect((err as Error).message).toContain("permission_denied");
  });
  it("refuses ids that would address a parent node", async () => {
    for (const bad of ["", "a/b", "..", " "]) {
      await expect(readCharacterAttributesRt(bad)).rejects.toBeInstanceOf(AttributeReadError);
    }
    expect(rt.rtGet).not.toHaveBeenCalled();
  });
  it("rejects a non-object node", async () => {
    rt.rtGet.mockResolvedValue("oops");
    await expect(readCharacterAttributesRt("c1")).rejects.toBeInstanceOf(AttributeReadError);
  });
});
