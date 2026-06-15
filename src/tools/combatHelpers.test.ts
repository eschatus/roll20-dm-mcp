import { describe, it, expect } from "vitest";
import { indexBatchResults, type BatchResult } from "./combatHelpers.js";

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
