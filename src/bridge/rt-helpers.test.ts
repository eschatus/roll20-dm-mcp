import { describe, it, expect } from "vitest";
import {
  parseAibridge, cleanChat, parsePcHpBlock, writePcHpBlock,
  mapToken, parseTurnorder, stripUndefWrite, parseBroadcastPing,
} from "./rt-helpers.js";

describe("parseBroadcastPing", () => {
  // Captured live by src/recon/ping-sniff.ts (Beyond Phandelver, 2026-06-11).
  const LIVE_PAYLOAD = JSON.stringify({
    type: "ping",
    data: {
      position: { x: 938.5, y: -680.0000036621094 },
      focus: false,
      page: "-NbQVmQe8XItL3tk3g5f",
      player: "-OkALyGu02rkgCeggYHY",
      ts: 1781207868473,
    },
  });

  it("parses the live payload shape and un-negates y", () => {
    const ping = parseBroadcastPing(LIVE_PAYLOAD);
    expect(ping).toMatchObject({
      x: 938.5,
      y: 680.0000036621094,
      rawY: -680.0000036621094,
      pageId: "-NbQVmQe8XItL3tk3g5f",
      player: "-OkALyGu02rkgCeggYHY",
      ts: 1781207868473,
      focus: false,
    });
  });

  it("rejects non-ping broadcasts, garbage, and missing positions", () => {
    expect(parseBroadcastPing(JSON.stringify({ type: "cursor", data: { position: { x: 1, y: 2 } } }))).toBeNull();
    expect(parseBroadcastPing(JSON.stringify({ type: "ping", data: {} }))).toBeNull();
    expect(parseBroadcastPing("not json")).toBeNull();
    expect(parseBroadcastPing(null)).toBeNull();
    expect(parseBroadcastPing(42)).toBeNull();
  });
});

describe("parseAibridge", () => {
  const wrap = (json: string) => `<div style='display:none'>AIBRIDGE_RESULT:${json}</div>`;

  it("returns null when the marker is absent", () => {
    expect(parseAibridge("just some chat")).toBeNull();
  });
  it("returns null when the marker isn't followed by an object", () => {
    expect(parseAibridge("AIBRIDGE_RESULT:not-json")).toBeNull();
  });
  it("parses a simple result", () => {
    expect(parseAibridge(wrap('{"nonce":42,"data":{"ok":true}}'))).toEqual({ nonce: 42, data: { ok: true } });
  });
  it("parses an error result", () => {
    expect(parseAibridge(wrap('{"nonce":7,"error":"boom"}'))).toEqual({ nonce: 7, error: "boom" });
  });
  it("handles nested braces", () => {
    expect(parseAibridge(wrap('{"nonce":1,"data":{"a":{"b":[1,2]}}}'))).toEqual({ nonce: 1, data: { a: { b: [1, 2] } } });
  });
  it("ignores braces inside string values", () => {
    expect(parseAibridge(wrap('{"nonce":1,"data":{"s":"a}{b"}}'))).toEqual({ nonce: 1, data: { s: "a}{b" } });
  });
  it("handles escaped quotes inside strings", () => {
    expect(parseAibridge(wrap('{"nonce":1,"data":{"s":"he said \\"hi\\""}}'))).toEqual({ nonce: 1, data: { s: 'he said "hi"' } });
  });
  it("stops at the balanced close and ignores trailing text", () => {
    expect(parseAibridge('AIBRIDGE_RESULT:{"nonce":9,"data":1} trailing junk }}}')).toEqual({ nonce: 9, data: 1 });
  });
  it("returns null on malformed JSON after the marker", () => {
    expect(parseAibridge("AIBRIDGE_RESULT:{not valid json}")).toBeNull();
  });
});

describe("cleanChat", () => {
  it("returns empty string for null/undefined", () => {
    expect(cleanChat(null)).toBe("");
    expect(cleanChat(undefined)).toBe("");
  });
  it("strips HTML tags", () => {
    expect(cleanChat("<span style='x'>hello</span>")).toBe("hello");
  });
  it("turns <br> and block-close tags into spaces", () => {
    expect(cleanChat("a<br>b</div>c")).toBe("a b c");
  });
  it("drops bare URLs", () => {
    expect(cleanChat("see https://files.d20.io/x/y.png now")).toBe("see now");
  });
  it("decodes common entities", () => {
    expect(cleanChat("a&amp;b &lt;c&gt; &#39;d&#39; &quot;e&quot; &nbsp;f")).toBe("a&b <c> 'd' \"e\" f");
  });
  it("collapses whitespace and trims", () => {
    expect(cleanChat("  a   b\n\tc  ")).toBe("a b c");
  });
  it("caps at 240 chars", () => {
    expect(cleanChat("x".repeat(500)).length).toBe(240);
  });
});

describe("parsePcHpBlock / writePcHpBlock", () => {
  const entry = { current: 17, max: 23, name: "Ander", updated: 1 };

  it("parses null when no block present", () => {
    expect(parsePcHpBlock("just gm notes")).toBeNull();
    expect(parsePcHpBlock("")).toBeNull();
    expect(parsePcHpBlock(null)).toBeNull();
  });
  it("parses null on a malformed block", () => {
    expect(parsePcHpBlock("%%PCHP={bad}%%")).toBeNull();
  });
  it("round-trips an entry", () => {
    expect(parsePcHpBlock(writePcHpBlock("", entry))).toEqual(entry);
  });
  it("preserves surrounding gmnotes", () => {
    const gm = writePcHpBlock("important note", entry);
    expect(gm.startsWith("important note ")).toBe(true);
    expect(parsePcHpBlock(gm)).toEqual(entry);
  });
  it("replaces (never duplicates) an existing block", () => {
    const once = writePcHpBlock("note", entry);
    const twice = writePcHpBlock(once, { ...entry, current: 5 });
    expect((twice.match(/%%PCHP=/g) || []).length).toBe(1);
    expect(parsePcHpBlock(twice)!.current).toBe(5);
    expect(twice.startsWith("note ")).toBe(true);
  });
  it("parses a URL-encoded block (Roll20 UI edits encode gmnotes)", () => {
    const plain = writePcHpBlock("some notes", entry);
    const encoded = encodeURIComponent(plain);
    expect(parsePcHpBlock(encoded)).toEqual(entry);
  });
  it("returns null for garbage that is neither plain nor decodable block", () => {
    expect(parsePcHpBlock("%%PCHP={not valid json}%%")).toBeNull();
    expect(parsePcHpBlock(encodeURIComponent("no block here at all"))).toBeNull();
  });
  it("write-then-parse round-trip is unchanged (plain, no encoding)", () => {
    const written = writePcHpBlock("gm text", entry);
    expect(parsePcHpBlock(written)).toEqual(entry);
    // Also verify encoding the written string round-trips
    expect(parsePcHpBlock(encodeURIComponent(written))).toEqual(entry);
  });
});

describe("mapToken", () => {
  const g = {
    id: "t1", name: "Goblin", represents: "c1", controlledby: "all", layer: "tokens",
    bar1_value: 5, bar1_max: 7, statusmarkers: "dead", left: 70, top: 140, width: 70, height: 70,
  };
  it("lean profile = identity fields only", () => {
    expect(mapToken(g, "lean")).toEqual({ id: "t1", name: "Goblin", represents: "c1", controlledby: "all", layer: "tokens" });
  });
  it("status profile adds bars + markers", () => {
    expect(mapToken(g, "status")).toMatchObject({ bar1_value: 5, bar1_max: 7, statusmarkers: "dead" });
  });
  it("full profile adds geometry", () => {
    expect(mapToken(g, "full")).toMatchObject({ left: 70, top: 140, width: 70, height: 70 });
  });
  it("default-fills missing sparse fields", () => {
    expect(mapToken({ id: "t2", layer: "gmlayer" }, "status")).toEqual({
      id: "t2", name: "", represents: "", controlledby: "", layer: "gmlayer",
      bar1_value: undefined, bar1_max: undefined, statusmarkers: "",
    });
  });
});

describe("parseTurnorder", () => {
  it("parses a JSON string and drops _pageid", () => {
    const raw = JSON.stringify([{ id: "a", pr: 18, _pageid: "p1" }, { id: "b", pr: 9, _pageid: "p1" }]);
    expect(parseTurnorder(raw)).toEqual([{ id: "a", pr: 18 }, { id: "b", pr: 9 }]);
  });
  it("accepts an already-parsed array", () => {
    expect(parseTurnorder([{ id: "a", pr: 1, _pageid: "p" }])).toEqual([{ id: "a", pr: 1 }]);
  });
  it("returns [] for garbage string, non-array, null", () => {
    expect(parseTurnorder("not json")).toEqual([]);
    expect(parseTurnorder(null)).toEqual([]);
    expect(parseTurnorder(42)).toEqual([]);
    expect(parseTurnorder("")).toEqual([]);
  });
});

describe("stripUndefWrite", () => {
  it("drops undefined and NaN, keeps null/0/empty/false", () => {
    expect(stripUndefWrite({ a: 1, b: undefined, c: NaN, d: null, e: 0, f: "", g: false })).toEqual({
      a: 1, d: null, e: 0, f: "", g: false,
    });
  });
  it("returns a new object", () => {
    const src = { a: 1 };
    expect(stripUndefWrite(src)).not.toBe(src);
  });
});
