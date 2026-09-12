// ─────────────────────────────────────────────────────────────────────────────
// Regression suite for issue #199 — epithets are ONE pool drawn down globally across
// the page, keyed on the epithet WORD rather than the full name, and rebuilt fresh
// from the live board on every call (not a per-call/per-species local, not persisted
// state). Drives the REAL mod-scripts/ai-relay.js through the emulator (roll20-emulator.ts),
// same as test/combat-round.test.ts's escalation tests — no reimplementation of the
// relay's logic here.
// ─────────────────────────────────────────────────────────────────────────────
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { setupHarness, type Harness } from "./harness.js";
import * as characters from "../src/registry/characters.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AI_RELAY_PATH = path.resolve(__dirname, "../mod-scripts/ai-relay.js");
const CELL = 70;

// Reads the CURRENT GENERIC_EPITHETS pool straight out of the real relay source, so
// this suite tracks the actual pool rather than a hand-copied (and driftable) list.
function readGenericEpithets(): string[] {
  const src = fs.readFileSync(AI_RELAY_PATH, "utf8");
  const m = /const GENERIC_EPITHETS = \[([\s\S]*?)\];/.exec(src);
  if (!m) throw new Error("Could not locate GENERIC_EPITHETS in ai-relay.js — did it get renamed?");
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}

// Pull the "<Epithet>" (or "<Word1> <Word2>" / "<Word> #N") tail off a rendered
// "<baseName> the <epithet>" token name.
function epithetOf(name: string): string {
  const i = name.lastIndexOf(" the ");
  return i === -1 ? "" : name.slice(i + 5);
}

interface Ctx { h: Harness; pageId: string }

function seedTokens(h: Harness, pageId: string, name: string, count: number, startX = 0): string[] {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const charId = h.emu.createCharacter(name, {}, "");
    const tok = h.emu.createToken({
      pageid: pageId, name, represents: charId, controlledby: "",
      bar1_value: 10, bar1_max: 10, left: (startX + i) * CELL, top: 70,
    });
    characters.register(name, tok.id, 0);
    ids.push(tok.id);
  }
  return ids;
}

describe("GENERIC_EPITHETS pool (#199)", () => {
  it("no longer contains 'Dire' — it's real monster vocabulary (Dire Wolf/Bear/Rat)", () => {
    const words = readGenericEpithets();
    expect(words).not.toContain("Dire");
    // Sanity: the audit didn't accidentally gut the list.
    expect(words.length).toBeGreaterThan(30);
  });
});

describe("epithets never repeat across two separate roll_initiative calls (#199)", () => {
  let h: Harness;
  let pageId: string;

  beforeAll(() => {
    h = setupHarness({ seed: 7 });
    pageId = h.emu.createPage("Reinforcements");
    h.emu.setPlayerPage(pageId);
  });
  afterAll(() => h.teardown());

  it("renames a lone reinforcement joining an already-renamed group, with a fresh epithet", async () => {
    // Call 1: three goblins are already on the board; roll init for two of them only
    // (by id), leaving the third bare — mirrors a DM rolling for what's currently
    // visible while more of the mob is still arriving.
    const [gobA, gobB, gobC] = seedTokens(h, pageId, "Goblin", 3);
    const first = await h.callTool("roll_initiative", {
      npcOnly: true, clearFirst: true, publicRoll: false,
      entries: [{ match: gobA }, { match: gobB }],
    });
    const firstJson = first.json as { rolledFor: number };
    expect(firstJson.rolledFor).toBe(2);

    const nameA = h.emu.tokenProps(gobA).name as string;
    const nameB = h.emu.tokenProps(gobB).name as string;
    const nameCUntouched = h.emu.tokenProps(gobC).name as string;
    expect(nameA).toMatch(/^Goblin the /);
    expect(nameB).toMatch(/^Goblin the /);
    expect(nameA).not.toBe(nameB);
    // The old defect: a token outside the batch stays bare and invisible to renaming.
    // That's fine on its own (it's simply not part of this call) — the real bug this
    // repro exercises is the NEXT call.
    expect(nameCUntouched).toBe("Goblin");

    // Call 2: the reinforcement (still bare "Goblin") rolls on its own. #199 defect 2:
    // the old code built an EMPTY usedNames every call, so this could hand out an
    // already-active epithet again, and a lone arrival's own-batch nameCounts was 1,
    // so it was never renamed in the first place.
    const second = await h.callTool("roll_initiative", {
      npcOnly: true, clearFirst: false, publicRoll: false,
      entries: [{ match: gobC }],
    });
    const secondJson = second.json as { rolledFor: number };
    expect(secondJson.rolledFor).toBe(1);

    const nameC = h.emu.tokenProps(gobC).name as string;
    // It got renamed at all (defect 2b — lone reinforcement joining a renamed group).
    expect(nameC).toMatch(/^Goblin the /);
    // And its epithet is neither of the two already active on the board (defect 2a —
    // cross-call memory of what's already spoken for).
    expect(nameC).not.toBe(nameA);
    expect(nameC).not.toBe(nameB);
    expect(new Set([nameA, nameB, nameC]).size).toBe(3);
  });
});

describe("epithets are one pool shared across species, not one per species (#199)", () => {
  let h: Harness;

  beforeAll(() => {
    h = setupHarness({ seed: 13 });
  });
  afterAll(() => h.teardown());

  it("two different species drawing from the same page never end up with the same epithet word", async () => {
    const pageId = h.emu.createPage("Mixed Warband");
    h.emu.setPlayerPage(pageId);

    // Goblin bank has 14 words, Skeleton bank has 12 — oversize each stack past its
    // own bank so both spill into the SHARED generic pool, which is exactly where the
    // old per-full-name keying let two species collide on the same word (#199 defect 1).
    const goblinIds = seedTokens(h, pageId, "Goblin", 16, 0);
    const skeletonIds = seedTokens(h, pageId, "Skeleton", 14, 20);

    const { json } = await h.callTool("roll_initiative", { npcOnly: true, clearFirst: true, publicRoll: false });
    expect((json as { rolledFor: number }).rolledFor).toBe(30);

    const goblinNames = goblinIds.map((id) => h.emu.tokenProps(id).name as string);
    const skeletonNames = skeletonIds.map((id) => h.emu.tokenProps(id).name as string);

    // All renamed, all unique overall.
    expect(goblinNames.every((n) => n.startsWith("Goblin the "))).toBe(true);
    expect(skeletonNames.every((n) => n.startsWith("Skeleton the "))).toBe(true);
    expect(new Set([...goblinNames, ...skeletonNames]).size).toBe(30);

    // No epithet WORD shared between the two species — the actual #199 invariant.
    // (Single-adjective names only at this stack size, so splitting on spaces is safe.)
    const goblinWords = new Set(goblinNames.flatMap((n) => epithetOf(n).split(" ").map((w) => w.toLowerCase())));
    const skeletonWords = new Set(skeletonNames.flatMap((n) => epithetOf(n).split(" ").map((w) => w.toLowerCase())));
    const overlap = [...goblinWords].filter((w) => skeletonWords.has(w));
    expect(overlap).toEqual([]);
  });
});

describe("epithet escalation reaches the numeric fallback once the shared pool is exhausted (#199, #185)", () => {
  let h: Harness;
  let pageId: string;

  beforeAll(() => {
    h = setupHarness({ seed: 17 });
    pageId = h.emu.createPage("Ooze Pit");
    h.emu.setPlayerPage(pageId);
  });
  afterAll(() => h.teardown());

  it("a stack that outlasts the whole generic pool still gets unique names via '#N' suffixes", async () => {
    // "Ooze" has no per-monster bank, so it draws from GENERIC_EPITHETS alone. A single
    // decoy token whose NAME is every generic word concatenated reserves the entire
    // pool in one shot (buildEpithetReservations tests word membership, not who "owns"
    // a name) — proving reservations are read off the live board, not a persisted set,
    // and forcing every Ooze straight past rungs 1-3 into rung 4.
    const allWords = readGenericEpithets();
    seedTokens(h, pageId, allWords.join(" "), 1, 99); // decoy, not rolled for init

    const oozeIds = seedTokens(h, pageId, "Ooze", 10, 0);
    const { json } = await h.callTool("roll_initiative", {
      npcOnly: true, clearFirst: true, publicRoll: false,
      entries: oozeIds.map((id) => ({ match: id })),
    });
    expect((json as { rolledFor: number }).rolledFor).toBe(10);

    const names = oozeIds.map((id) => h.emu.tokenProps(id).name as string);
    // Terminates, and every name is distinct.
    expect(new Set(names).size).toBe(10);
    // Every one of them landed on rung 4 (numeric suffix) — rungs 1-3 were all fully
    // reserved by the decoy, so nothing else could have produced these names.
    expect(names.every((n) => /#\d+$/.test(n))).toBe(true);
  });
});

describe("a removed token's epithet frees up for reuse (#199)", () => {
  let h: Harness;
  let pageId: string;

  beforeAll(() => {
    h = setupHarness({ seed: 19 });
    pageId = h.emu.createPage("Battlefield Cleanup");
    h.emu.setPlayerPage(pageId);
  });
  afterAll(() => h.teardown());

  it("un-reserves an epithet once its token is removed from the page", async () => {
    // Poison every generic word except "Deadly" via a decoy, so a "Blob" (no bank)
    // stack has EXACTLY one free single-word option — makes the outcome deterministic
    // instead of "probably picks something new".
    const allWords = readGenericEpithets();
    const poisoned = allWords.filter((w) => w !== "Deadly");
    seedTokens(h, pageId, poisoned.join(" "), 1, 99);

    const [blobA, blobB] = seedTokens(h, pageId, "Blob", 2, 0);
    await h.callTool("roll_initiative", {
      npcOnly: true, clearFirst: true, publicRoll: false,
      entries: [{ match: blobA }, { match: blobB }],
    });
    const nameA = h.emu.tokenProps(blobA).name as string;
    const nameB = h.emu.tokenProps(blobB).name as string;
    // Exactly one free word existed, so exactly one of the two claims it outright and
    // the other is pushed straight to the numeric fallback (no free word left for it).
    const holder = nameA === "Blob the Deadly" ? blobA : blobB;
    const holderName = nameA === "Blob the Deadly" ? nameA : nameB;
    const other = holder === blobA ? blobB : blobA;
    expect(holderName).toBe("Blob the Deadly");
    expect(h.emu.tokenProps(other).name).toMatch(/#\d+$/);

    // Remove the token holding "Deadly" — its word must vanish from the reservation
    // scan on the very next call, with no cleanup step of our own.
    await h.callTool("remove_object", { objectId: holder, objectType: "graphic" });

    const [blobC] = seedTokens(h, pageId, "Blob", 1, 5);
    await h.callTool("roll_initiative", {
      npcOnly: true, clearFirst: false, publicRoll: false,
      entries: [{ match: blobC }],
    });
    // "Deadly" is free again — the only word it COULD get, since it's still the only
    // unpoisoned generic word and the removed token no longer blocks it.
    expect(h.emu.tokenProps(blobC).name).toBe("Blob the Deadly");
  });
});
