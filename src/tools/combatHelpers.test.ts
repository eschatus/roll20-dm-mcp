import { describe, it, expect } from "vitest";
import { z } from "zod";
import { indexBatchResults, coerceStringArray, coerceBoolean, type BatchResult } from "./combatHelpers.js";

describe("coerceStringArray (model-tolerant array param)", () => {
  it("passes a real array through unchanged", () => {
    expect(coerceStringArray(["Bugbear", "Droop"])).toEqual(["Bugbear", "Droop"]);
  });

  it("parses a JSON-stringified array (the Haiku failure mode)", () => {
    expect(coerceStringArray('["Bugbear the Heavy-Handed", "Droop", "Iarno"]'))
      .toEqual(["Bugbear the Heavy-Handed", "Droop", "Iarno"]);
  });

  it("wraps a bare single name in an array", () => {
    expect(coerceStringArray("Droop")).toEqual(["Droop"]);
  });

  it("treats an empty string as an empty array", () => {
    expect(coerceStringArray("")).toEqual([]);
    expect(coerceStringArray("   ")).toEqual([]);
  });

  it("falls back to a single-element array on malformed JSON (not a throw)", () => {
    expect(coerceStringArray('["unterminated')).toEqual(['["unterminated']);
  });

  it("leaves a non-string/array value for Zod to reject", () => {
    expect(coerceStringArray(42)).toBe(42);
    expect(coerceStringArray(null)).toBe(null);
  });
});

describe("coerceBoolean (model-tolerant boolean param)", () => {
  it("passes real booleans through unchanged", () => {
    expect(coerceBoolean(true)).toBe(true);
    expect(coerceBoolean(false)).toBe(false);
  });

  it('coerces "true" string to true', () => {
    expect(coerceBoolean("true")).toBe(true);
  });

  it('coerces "false" string to false', () => {
    expect(coerceBoolean("false")).toBe(false);
  });

  it('coerces "1" to true and "0" to false', () => {
    expect(coerceBoolean("1")).toBe(true);
    expect(coerceBoolean("0")).toBe(false);
  });

  it("leaves unknown values untouched for Zod to reject", () => {
    expect(coerceBoolean("yes")).toBe("yes");
    expect(coerceBoolean(42)).toBe(42);
    expect(coerceBoolean(null)).toBe(null);
  });

  it("leaves undefined untouched so Zod .default() can apply", () => {
    expect(coerceBoolean(undefined)).toBe(undefined);
  });

  it("works end-to-end as a Zod preprocess — stringified args coerce to booleans", () => {
    // This is the exact schema shape used in roll_initiative for npcOnly / clearFirst.
    const schema = z.object({
      npcOnly: z.preprocess(coerceBoolean, z.boolean().default(true)),
      clearFirst: z.preprocess(coerceBoolean, z.boolean().default(false)),
      names: z.preprocess(coerceStringArray, z.array(z.string())).optional(),
    });

    // Simulate the Haiku / cloud-model failure mode from issue #44:
    // booleans stringified, names as a JSON-stringified array.
    const result = schema.parse({
      npcOnly: "true",
      clearFirst: "false",
      names: '["Droop","Iarno"]',
    });

    expect(result.npcOnly).toBe(true);
    expect(result.clearFirst).toBe(false);
    expect(result.names).toEqual(["Droop", "Iarno"]);
  });

  it("default values apply when the param is omitted", () => {
    const schema = z.object({
      npcOnly: z.preprocess(coerceBoolean, z.boolean().default(true)),
      clearFirst: z.preprocess(coerceBoolean, z.boolean().default(false)),
    });
    const result = schema.parse({});
    expect(result.npcOnly).toBe(true);
    expect(result.clearFirst).toBe(false);
  });

  it("native booleans still work unchanged", () => {
    const schema = z.object({
      npcOnly: z.preprocess(coerceBoolean, z.boolean().default(true)),
      clearFirst: z.preprocess(coerceBoolean, z.boolean().default(false)),
    });
    const result = schema.parse({ npcOnly: false, clearFirst: true });
    expect(result.npcOnly).toBe(false);
    expect(result.clearFirst).toBe(true);
  });
});

describe("indexBatchResults", () => {
  it("indexes results by stringified id", () => {
    const results: BatchResult[] = [
      { id: "a", ok: true },
      { id: 2, ok: false, error: "boom" },
    ];
    const m = indexBatchResults(results, ["a", 2]);
    expect(m.get("a")).toEqual({ id: "a", ok: true });
    expect(m.get("2")).toEqual({ id: 2, ok: false, error: "boom" });
  });

  it("fills a sent id with no result as an explicit failure (never silent success)", () => {
    const m = indexBatchResults([{ id: "a", ok: true }], ["a", "b"]);
    expect(m.get("b")).toEqual({ id: "b", ok: false, error: "no result returned by relay" });
  });

  it("treats a short relay response as failures for the missing ids", () => {
    const m = indexBatchResults([], ["x", "y", "z"]);
    expect([...m.values()].every((r) => !r.ok)).toBe(true);
    expect(m.size).toBe(3);
  });

  it("tolerates a null/undefined response", () => {
    const m = indexBatchResults(null, ["only"]);
    expect(m.get("only")?.ok).toBe(false);
  });

  it("does not invent entries for ids that were never sent", () => {
    const m = indexBatchResults([{ id: "a", ok: true }], ["a"]);
    expect(m.has("b")).toBe(false);
  });

  it("keeps a relay-returned result even if its id was not in sentIds", () => {
    // The relay echoing an extra/out-of-order id is preserved; only missing
    // sent ids are synthesized. (sentIds drives the failure backfill, not pruning.)
    const m = indexBatchResults([{ id: "extra", ok: true }], []);
    expect(m.get("extra")?.ok).toBe(true);
  });
});
