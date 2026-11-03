// #259: named values on a token, stored in gmnotes over direct RTDB. The HP key shares the
// %%PCHP%% block that adjustPcHp and the relay read, so its format is pinned here too.
import { describe, it, expect, vi, beforeEach } from "vitest";

const rt = vi.hoisted(() => ({ notes: {} as Record<string, unknown>, findPage: vi.fn() }));
vi.mock("../src/bridge/roll20-rt.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/bridge/roll20-rt.js")>();
  return {
    ...actual,
    rtFindTokenPage: rt.findPage,
    rtGet: async (path: string) => rt.notes[path],
    rtTransact: async (path: string, update: (current: unknown) => unknown) => {
      rt.notes[path] = update(rt.notes[path] ?? null);
    },
  };
});

import { readTokenValues, writeTokenValue, rtGetTokenValues, rtSetTokenValue, TokenValueError } from "../src/bridge/token-values.js";
import { parsePcHpBlock, writePcHpBlock } from "../src/bridge/rt-helpers.js";
import { FakeMcpServer } from "./harness.js";
import { __setBridgeTestTransport } from "../src/bridge/roll20.js";
import { registerValueTools } from "../src/tools/values.js";

const GM = "graphics/page/p1/t1/gmnotes";

beforeEach(() => {
  rt.notes = { [GM]: "Keep me", "graphics/page/p1/t1/name": "Adept\nthe Quick" };
  rt.findPage.mockReset();
  rt.findPage.mockResolvedValue("p1");
});

describe("gmnotes block", () => {
  it("round-trips numbers, strings and objects, and keeps surrounding notes", () => {
    let gm = writeTokenValue("Keep me", "edge", 2, "A");
    gm = writeTokenValue(gm, "stance", "guarded", "A");
    gm = writeTokenValue(gm, "track", { current: 3, max: 10 }, "A");
    expect(gm.startsWith("Keep me ")).toBe(true);
    expect((gm.match(/%%VALS=/g) ?? []).length).toBe(1);
    expect(readTokenValues(gm)).toEqual({ edge: 2, stance: "guarded", track: { current: 3, max: 10 } });
  });

  it("a value containing the block terminator or a chat trigger cannot escape the block", () => {
    const gm = writeTokenValue("", "note", "}%% @{x} [[1d6]] %%VALS=x%%", "A");
    expect(gm).not.toContain("@{");
    expect(gm).not.toContain("[[");
    expect(readTokenValues(gm)).toEqual({ note: "}%% @{x} [[1d6]] %%VALS=x%%" });
  });

  it("deleting the last key removes the block and leaves the notes", () => {
    expect(writeTokenValue(writeTokenValue("Keep me", "edge", 2, "A"), "edge", null, "A")).toBe("Keep me");
  });

  it("reads and rewrites a block Roll20 URL-encoded on a UI edit, without leaving a stale copy", () => {
    const encoded = encodeURIComponent(writeTokenValue("Keep me", "edge", 2, "A"));
    expect(readTokenValues(encoded)).toEqual({ edge: 2 });
    const rewritten = writeTokenValue(encoded, "edge", null, "A");
    expect(rewritten).toBe("Keep me");
    expect(readTokenValues(rewritten)).toEqual({});
  });

  it("keeps encoded values when adjustPcHp has appended a raw PCHP block to encoded notes", () => {
    const encoded = encodeURIComponent(writeTokenValue("Keep me", "edge", 2, "A"));
    const gm = `${encoded} %%PCHP={"current":7,"max":22,"name":"A","updated":1}%%`;
    expect(readTokenValues(gm)).toEqual({ edge: 2, hp: { current: 7, max: 22 } });
    const rewritten = writeTokenValue(gm, "edge", 3, "A");
    expect(rewritten.startsWith("Keep me ")).toBe(true);
    expect((rewritten.match(/%%VALS=/g) ?? []).length).toBe(1);
    expect(readTokenValues(rewritten)).toEqual({ edge: 3, hp: { current: 7, max: 22 } });
  });

  it("a raw PCHP block wins over a stale encoded one", () => {
    const stale = encodeURIComponent('%%PCHP={"current":1,"max":22,"name":"A","updated":1}%%');
    const gm = `${stale} %%PCHP={"current":9,"max":22,"name":"A","updated":2}%%`;
    expect(readTokenValues(gm).hp).toEqual({ current: 9, max: 22 });
    expect((writeTokenValue(gm, "edge", 1, "A").match(/PCHP/g) ?? []).length).toBe(1);
  });

  it("keeps values through GM edit → adjustPcHp → GM edit, with no set in between", () => {
    const gmEdit = (s: string) => encodeURIComponent(s);
    const adjust = (s: string, current: number) => writePcHpBlock(s, { current, max: 22, name: "A", updated: current });
    let gm = adjust(writeTokenValue("Keep me", "edge", 2, "A"), 10);
    gm = gmEdit(adjust(gmEdit(gm), 7));
    expect(readTokenValues(gm)).toEqual({ edge: 2, hp: { current: 7, max: 22 } });
    const rewritten = writeTokenValue(gm, "edge", 3, "A");
    expect(rewritten.startsWith("Keep me ")).toBe(true);
    expect((rewritten.match(/%%VALS=/g) ?? []).length).toBe(1);
    expect((rewritten.match(/%%PCHP=/g) ?? []).length).toBe(1);
    expect(readTokenValues(gmEdit(rewritten))).toEqual({ edge: 3, hp: { current: 7, max: 22 } });
  });

  it("of two copies a GM edit encoded together, the later one wins", () => {
    const gm = encodeURIComponent('Keep me %%PCHP={"current":10,"max":22,"name":"A","updated":1}%% %%PCHP={"current":7,"max":22,"name":"A","updated":2}%%');
    expect(readTokenValues(gm).hp).toEqual({ current: 7, max: 22 });
    expect((writeTokenValue(gm, "edge", 1, "A").match(/PCHP/g) ?? []).length).toBe(1);
  });

  it("leaves notes with a stray percent sign alone", () => {
    expect(writeTokenValue("100% sure", "edge", 1, "A").startsWith("100% sure ")).toBe(true);
  });

  it("a corrupt block throws on read and refuses to be overwritten", () => {
    expect(() => readTokenValues("%%VALS=notjson%%")).toThrow(TokenValueError);
    expect(() => writeTokenValue("%%VALS=notjson%%", "edge", 1, "A")).toThrow(/corrupt/);
  });
});

describe('the "hp" key is the PCHP block', () => {
  const pchp = '%%PCHP={"current":7,"max":22,"name":"Runner","updated":1}%%';

  it("reads an existing block written by adjustPcHp", () => {
    expect(readTokenValues(pchp)).toEqual({ hp: { current: 7, max: 22 } });
  });

  it("writes a block the HP path can read, and doesn't put hp in VALS", () => {
    const gm = writeTokenValue("", "hp", { current: 5, max: 20 }, "Runner");
    expect(gm).not.toContain("VALS");
    expect(parsePcHpBlock(gm)).toMatchObject({ current: 5, max: 20, name: "Runner" });
  });

  it("deletes the block on null and refuses any other shape", () => {
    expect(writeTokenValue(pchp, "hp", null, "Runner")).toBe("");
    expect(() => writeTokenValue(pchp, "hp", 5, "Runner")).toThrow(/\{current, max\}/);
    expect(() => writeTokenValue(pchp, "hp", { current: "5", max: 20 }, "Runner")).toThrow(/finite numbers/);
  });

  it("sits beside VALS entries without disturbing them", () => {
    const gm = writeTokenValue(writeTokenValue(pchp, "edge", 2, "Runner"), "hp", { current: 1, max: 22 }, "Runner");
    expect(readTokenValues(gm)).toEqual({ edge: 2, hp: { current: 1, max: 22 } });
  });
});

describe("RTDB access", () => {
  it("writes through a transaction on the token's gmnotes and reads back", async () => {
    await rtSetTokenValue("t1", "edge", 2);
    expect(rt.notes[GM]).toContain("Keep me");
    expect(await rtGetTokenValues("t1")).toEqual({ edge: 2 });
  });

  it("uses the first line of the token name for the HP block", async () => {
    await rtSetTokenValue("t1", "hp", { current: 1, max: 2 });
    expect(parsePcHpBlock(rt.notes[GM])?.name).toBe("Adept");
  });

  it("fails loudly when the token can't be found, and passes pageId as the search hint", async () => {
    rt.findPage.mockResolvedValue(null);
    await expect(rtGetTokenValues("nope", "p9")).rejects.toThrow(/Token not found: nope/);
    expect(rt.findPage).toHaveBeenCalledWith("nope", "p9");
  });
});

describe("tools", () => {
  const server = new FakeMcpServer();
  registerValueTools(server as never);
  const call = async (name: string, args: Record<string, unknown>) => {
    const res = await server.handlers.get(name)!.handler(args);
    return JSON.parse(res.content[0].text) as Record<string, unknown>;
  };

  it("resolves characterName on pageId, not the current page", async () => {
    const asked: Record<string, unknown>[] = [];
    __setBridgeTestTransport({
      relay: async <T,>(cmd: Record<string, unknown>) => {
        asked.push(cmd);
        return [{ id: "t1", name: "Adept" }] as T;
      },
      evaluate: async () => { throw new Error("no page lookup expected"); },
    });
    try {
      await call("set_token_value", { characterName: "Adept", pageId: "p1", key: "edge", value: 2 });
    } finally {
      __setBridgeTestTransport(null);
    }
    expect(asked).toEqual([{ action: "getTokens", pageId: "p1" }]);
    expect(await rtGetTokenValues("t1")).toEqual({ edge: 2 });
  });

  it("get with a key: the value, or null when missing, even for an Object.prototype name", async () => {
    await call("set_token_value", { tokenId: "t1", key: "edge", value: 2 });
    expect((await call("get_token_value", { tokenId: "t1", key: "edge" })).value).toBe(2);
    expect((await call("get_token_value", { tokenId: "t1", key: "nope" })).value).toBeNull();
    expect((await call("get_token_value", { tokenId: "t1", key: "constructor" })).value).toBeNull();
  });

  it("get without a key returns everything; value:null reports the delete", async () => {
    await call("set_token_value", { tokenId: "t1", key: "edge", value: 2 });
    expect((await call("get_token_value", { tokenId: "t1" })).values).toEqual({ edge: 2 });
    expect((await call("set_token_value", { tokenId: "t1", key: "edge", value: null })).deleted).toBe(true);
    expect((await call("get_token_value", { tokenId: "t1" })).values).toEqual({});
  });
});
