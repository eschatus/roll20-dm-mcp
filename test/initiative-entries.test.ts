// ─────────────────────────────────────────────────────────────────────────────
// #172 — roll_initiative explicit {match, bonus?, hp?} entries.
//
// The gem (or Claude Code) resolves stats itself and feeds them in, instead of
// the server fuzzy-matching the DDB compendium by token name:
//   - bonus rolls 1d20+bonus through the Roll20 roller and BEATS the sheet-
//     derived bonus (relay-side bonusOverrides, keyed by token id).
//   - hp seeds bar1/bar1_max under the existing NPC/sidekick routing — a PC's
//     bar is never written, even when an entry matches it.
//   - Player turn-order entries survive (mergeTurnOrder path untouched).
// All calls pass initHp:false — the deprecated DDB auto-init is exercised by
// hp-init.test.ts and is not under test here.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupHarness, type Harness } from "./harness.js";
import * as characters from "../src/registry/characters.js";

let h: Harness;
let pageId: string;
let bugbearId: string;   // NPC with a sheet initiative_bonus of 1
let droopId: string;     // NPC, no sheet, no HP bar
let tuaId: string;       // sidekick (player-controlled, registry-flagged), no HP bar
let pcId: string;        // true PC with a bar Beyond20 owns

const bar = (id: string) => Number(h.emu.tokenProps(id).bar1_value);
const max = (id: string) => Number(h.emu.tokenProps(id).bar1_max);

type InitResult = {
  results: string[];
  turnOrder: { id?: string; pr: number | string }[];
  hpSeeded?: string[];
  hpSkippedPc?: string[];
  entriesUnmatched?: string[];
};

beforeAll(() => {
  h = setupHarness({ seed: 172 });
  pageId = h.emu.createPage("Entries Test Page");
  h.emu.setPlayerPage(pageId);

  const bugbearChar = h.emu.createCharacter("Bugbear", { initiative_bonus: 1 }, "");
  bugbearId = h.emu.createToken({
    pageid: pageId, name: "Bugbear", represents: bugbearChar, controlledby: "",
    bar1_value: 27, bar1_max: 27, left: 140, top: 140,
  }).id;

  droopId = h.emu.createToken({
    pageid: pageId, name: "Droop", controlledby: "", left: 210, top: 140,
  }).id;

  tuaId = h.emu.createToken({
    pageid: pageId, name: "Tua", controlledby: "player-001", left: 280, top: 140,
  }).id;
  characters.setSidekick("Tua", true);

  pcId = h.emu.createToken({
    pageid: pageId, name: "Glint Klinkinski", controlledby: "player-001",
    bar1_value: 30, bar1_max: 30, left: 350, top: 140,
  }).id;
});

afterAll(() => h.teardown());

describe("roll_initiative entries (#172)", () => {
  it("explicit bonus beats the sheet bonus and rolls through the Roll20 roller", async () => {
    const { json } = await h.callTool("roll_initiative", {
      entries: [{ match: "Bugbear", bonus: 5 }],
      initHp: false, publicRoll: false,
    });
    const r = json as InitResult;

    // The sheet says +1; the entry says +5 — the result line must show the d20
    // and the EXPLICIT bonus, and the tracker pr must be their sum.
    const line = r.results.find((l) => l.startsWith("Bugbear:"));
    expect(line).toBeDefined();
    const m = /Bugbear: (\d+)\+5 = \*\*(\d+)\*\*/.exec(line!);
    expect(m, `line was: ${line}`).not.toBeNull();
    const [, d20, total] = m!.map(Number) as unknown as [string, number, number];
    expect(total).toBe(d20 + 5);
    expect(r.turnOrder.find((e) => e.id === bugbearId)?.pr).toBe(total);
  });

  it("falls back to the sheet bonus when an entry omits bonus", async () => {
    const { json } = await h.callTool("roll_initiative", {
      entries: [{ match: "Bugbear" }],
      initHp: false, publicRoll: false,
    });
    const r = json as InitResult;
    expect(r.results.find((l) => l.startsWith("Bugbear:"))).toMatch(/Bugbear: \d+\+1 = /);
  });

  it("matches an entry by exact token id", async () => {
    const { json } = await h.callTool("roll_initiative", {
      entries: [{ match: bugbearId, bonus: 3 }],
      initHp: false, publicRoll: false,
    });
    const r = json as InitResult;
    expect(r.results.find((l) => l.startsWith("Bugbear:"))).toMatch(/\+3 = /);
    expect(r.entriesUnmatched).toBeUndefined();
  });

  it("hp seeds bar1/bar1_max for an NPC and a sidekick, never a PC", async () => {
    expect(max(droopId)).toBe(0);
    expect(max(tuaId)).toBe(0);

    const { json } = await h.callTool("roll_initiative", {
      entries: [
        { match: "Droop", bonus: 1, hp: 5 },
        { match: "Tua", bonus: 2, hp: 22 },
        { match: "Glint", bonus: 4, hp: 99 },
      ],
      npcOnly: false, initHp: false, publicRoll: false,
    });
    const r = json as InitResult;

    expect(bar(droopId)).toBe(5);
    expect(max(droopId)).toBe(5);
    expect(bar(tuaId)).toBe(22);     // sidekick routes as NPC (bar1) despite controlledby
    expect(max(tuaId)).toBe(22);
    expect(bar(pcId)).toBe(30);      // PC bar untouched — Beyond20 owns it
    expect(max(pcId)).toBe(30);
    expect(r.hpSeeded).toEqual(expect.arrayContaining(["Droop → 5", "Tua → 22"]));
    expect(r.hpSkippedPc).toEqual(["Glint Klinkinski (PC — bar never written)"]);
  });

  it("explicit hp overwrites an existing bar (the caller said so)", async () => {
    const { json } = await h.callTool("roll_initiative", {
      entries: [{ match: "Droop", hp: 12 }],
      initHp: false, publicRoll: false,
    });
    expect((json as InitResult).hpSeeded).toContain("Droop → 12");
    expect(bar(droopId)).toBe(12);
    expect(max(droopId)).toBe(12);
  });

  it("preserves player turn-order entries on an entries-based roll with clearFirst", async () => {
    // A player rolled their own initiative — that entry must survive any NPC roll.
    h.emu.campaignModel.set("turnorder", JSON.stringify([
      { id: pcId, pr: "17", custom: "", _pageid: pageId },
    ]));

    const { json } = await h.callTool("roll_initiative", {
      entries: [{ match: "Bugbear", bonus: 2 }, { match: "Droop", bonus: 0 }],
      clearFirst: true, initHp: false, publicRoll: false,
    });
    const r = json as InitResult;

    const pcEntry = r.turnOrder.find((e) => e.id === pcId);
    expect(pcEntry?.pr).toBe(17);
    expect(r.turnOrder.find((e) => e.id === bugbearId)).toBeDefined();
    expect(r.turnOrder.find((e) => e.id === droopId)).toBeDefined();
  });

  it("reports entries that matched no token", async () => {
    const { json } = await h.callTool("roll_initiative", {
      entries: [{ match: "Bugbear" }, { match: "Nonexistent Wight", bonus: 3 }],
      initHp: false, publicRoll: false,
    });
    expect((json as InitResult).entriesUnmatched).toEqual(["Nonexistent Wight"]);
  });

  it("accepts a JSON-stringified entries array (model compatibility)", async () => {
    const { json } = await h.callTool("roll_initiative", {
      entries: JSON.stringify([{ match: "Bugbear", bonus: 7 }]),
      initHp: false, publicRoll: false,
    });
    expect((json as InitResult).results.find((l) => l.startsWith("Bugbear:"))).toMatch(/\+7 = /);
  });
});
