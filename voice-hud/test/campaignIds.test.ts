// Unit tests for extractRoll20Id/extractDdbId — the campaign-maker form (gem.html "Campaign"
// section) accepts either a bare numeric id or a pasted campaign URL for both Roll20 and D&D
// Beyond; these pure helpers do the extraction.

import { describe, it, expect } from "vitest";
import { extractRoll20Id, extractDdbId } from "../src/campaignIds";

describe("extractRoll20Id", () => {
  it("accepts a bare numeric id", () => {
    expect(extractRoll20Id("8675309")).toBe("8675309");
  });

  it("extracts the id from a full details URL", () => {
    expect(extractRoll20Id("https://app.roll20.net/campaigns/details/8675309")).toBe("8675309");
  });

  it("tolerates a trailing slug after the id", () => {
    expect(extractRoll20Id("https://app.roll20.net/campaigns/details/8675309/curse-of-strahd")).toBe("8675309");
  });

  it("tolerates surrounding whitespace", () => {
    expect(extractRoll20Id("  8675309  ")).toBe("8675309");
  });

  it("returns null for garbage input", () => {
    expect(extractRoll20Id("not a campaign")).toBeNull();
  });

  it("returns null for empty input", () => {
    expect(extractRoll20Id("")).toBeNull();
    expect(extractRoll20Id(undefined as unknown as string)).toBeNull();
  });

  it("returns null for a D&D Beyond URL (wrong domain shape)", () => {
    expect(extractRoll20Id("https://www.dndbeyond.com/campaigns/5201061")).toBeNull();
  });

  it("returns null for a non-numeric id in the URL path", () => {
    expect(extractRoll20Id("https://app.roll20.net/campaigns/details/abc123")).toBeNull();
  });
});

describe("extractDdbId", () => {
  it("accepts a bare numeric id", () => {
    expect(extractDdbId("5201061")).toBe("5201061");
  });

  it("extracts the id from a campaigns URL", () => {
    expect(extractDdbId("https://www.dndbeyond.com/campaigns/5201061")).toBe("5201061");
  });

  it("tolerates a trailing slug after the id", () => {
    expect(extractDdbId("https://www.dndbeyond.com/campaigns/5201061/fabulous-faerun-firebirds")).toBe("5201061");
  });

  it("tolerates surrounding whitespace", () => {
    expect(extractDdbId("  5201061  ")).toBe("5201061");
  });

  it("returns null for garbage input", () => {
    expect(extractDdbId("nope")).toBeNull();
  });

  it("returns null for empty input", () => {
    expect(extractDdbId("")).toBeNull();
    expect(extractDdbId(undefined as unknown as string)).toBeNull();
  });

  it("returns null for a non-numeric id in the URL path", () => {
    expect(extractDdbId("https://www.dndbeyond.com/campaigns/abc123")).toBeNull();
  });
});
