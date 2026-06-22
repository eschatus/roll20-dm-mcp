import { describe, it, expect, afterEach } from "vitest";
import path from "path";
import { dataDir, dataPath } from "./dataDir.js";

const original = process.env.ROLL20_DATA_DIR;
afterEach(() => {
  // Never leak the override — a stray ROLL20_DATA_DIR breaks sibling tests that
  // assume ./data (this is exactly how the relayState test got bitten).
  if (original === undefined) delete process.env.ROLL20_DATA_DIR;
  else process.env.ROLL20_DATA_DIR = original;
});

describe("dataDir", () => {
  it("defaults to ./data (cwd-relative) when ROLL20_DATA_DIR is unset", () => {
    delete process.env.ROLL20_DATA_DIR;
    expect(dataDir()).toBe(path.resolve("./data"));
    expect(dataPath("campaigns.json")).toBe(path.resolve("./data", "campaigns.json"));
  });

  it("honors ROLL20_DATA_DIR (resolved absolute)", () => {
    process.env.ROLL20_DATA_DIR = path.join(path.sep === "\\" ? "C:\\tmp" : "/tmp", "dmw-test");
    expect(dataPath("roll20-rt-token.json")).toBe(
      path.resolve(process.env.ROLL20_DATA_DIR, "roll20-rt-token.json"),
    );
  });

  it("is lazy — a change between calls is reflected (launcher can set it at runtime)", () => {
    process.env.ROLL20_DATA_DIR = "first";
    const a = dataDir();
    process.env.ROLL20_DATA_DIR = "second";
    const b = dataDir();
    expect(a).not.toBe(b);
    expect(b).toBe(path.resolve("second"));
  });
});
