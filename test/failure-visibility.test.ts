// ─────────────────────────────────────────────────────────────────────────────
// Failures must be visible as failures (#190 / #191 / #192).
//
// Every case here used to come back as a plausible SUCCESS: a write that never
// landed reported as prose with isError:false, a save rolled blind at +0 because
// the sheet read failed, an initiative roll quietly missing combatants, a
// "Cleared 0 plan(s)" after the plans were really cleared. The harness injects a
// relay failure (failRelayAction) to stand in for a transport blip or auth expiry.
//
// The invariant under test is not "it errors" but "it cannot be mistaken for
// success, and nothing is half-applied".
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { setupHarness, type Harness } from "./harness.js";

let h: Harness;
let pageId: string;
let barlessId: string, brawlerId: string, centerId: string, bruteId: string, nobodyId: string;

const CELL = 70; // px per 5ft cell
const hp = (id: string) => Number(h.emu.tokenProps(id).bar1_value);

beforeAll(() => {
  h = setupHarness({ seed: 77 });
  pageId = h.emu.createPage("Failure Visibility");
  h.emu.setPlayerPage(pageId);

  // A PC, so roll_initiative's nearPcsFeet gate has a centre to measure from.
  const pcChar = h.emu.createCharacter("Dame Rowan", { dexterity: 14 }, "player-001");
  h.emu.createToken({
    pageid: pageId, name: "Dame Rowan", represents: pcChar, controlledby: "player-001",
    bar1_value: 30, bar1_max: 30, left: 10 * CELL, top: 10 * CELL,
  });

  // An NPC with no HP bar at all — every write to it silently no-ops.
  barlessId = h.emu.createToken({
    pageid: pageId, name: "Barless Ghoul", controlledby: "", left: 40 * CELL, top: 40 * CELL,
  }).id;

  // An ordinary NPC with a bar, for the "success is still not an error" control.
  brawlerId = h.emu.createToken({
    pageid: pageId, name: "Bar Brawler", controlledby: "",
    bar1_value: 20, bar1_max: 20, left: 41 * CELL, top: 41 * CELL,
  }).id;

  // AoE cluster: centre is excluded by default, the other two are 5ft away.
  centerId = h.emu.createToken({
    pageid: pageId, name: "Blast Centre", controlledby: "",
    bar1_value: 40, bar1_max: 40, left: 20 * CELL, top: 20 * CELL,
  }).id;
  // Has a real CON save on its sheet.
  const bruteChar = h.emu.createCharacter("Save Brute", { npc_con_save: 7 }, "");
  bruteId = h.emu.createToken({
    pageid: pageId, name: "Save Brute", represents: bruteChar, controlledby: "",
    bar1_value: 40, bar1_max: 40, left: 21 * CELL, top: 20 * CELL,
  }).id;
  // Sheet carries nothing for CON — a genuine flat d20.
  const nobodyChar = h.emu.createCharacter("Save Nobody", {}, "");
  nobodyId = h.emu.createToken({
    pageid: pageId, name: "Save Nobody", represents: nobodyChar, controlledby: "",
    bar1_value: 40, bar1_max: 40, left: 20 * CELL, top: 21 * CELL,
  }).id;
});

afterEach(() => h.clearRelayFailures());
afterAll(() => h.teardown());

// ── #190: a returned failure is flagged, not just worded ──────────────────────
describe("#190 returned failures carry isError", () => {
  it("update_token_hp on a barless NPC reports isError, keeping its prose", async () => {
    const { text, isError } = await h.callTool("update_token_hp", {
      characterName: "Barless Ghoul", damage: 12,
    });
    expect(isError).toBe(true);
    // The message a DM reads is unchanged — this is additive.
    expect(text).toMatch(/no HP bar set/);
    expect(text).toMatch(/not applied/);
  });

  it("update_hp_many reports isError when it applied to none of its targets", async () => {
    const { text, isError } = await h.callTool("update_hp_many", {
      names: ["Barless Ghoul"], damage: 5,
    });
    expect(isError).toBe(true);
    expect(text).toMatch(/applied to 0\/1/);
  });

  it("advance_turn reports isError when there is no turn order to advance", async () => {
    await h.callTool("clear_turn_order", {});
    const { text, isError } = await h.callTool("advance_turn", {});
    expect(isError).toBe(true);
    expect(text).toMatch(/empty/i);
  });

  it("does not flag a write that actually landed", async () => {
    const before = hp(brawlerId);
    const { isError } = await h.callTool("update_token_hp", { characterName: "Bar Brawler", damage: 3 });
    expect(isError).toBe(false);
    expect(hp(brawlerId)).toBe(before - 3);
  });
});

// ── #191: a failed save-bonus read must not become a silent +0 ────────────────
describe("#191 resolve_aoe save bonuses", () => {
  const burst = {
    label: "Cloudkill", centerTokenName: "Blast Centre", radiusFeet: 15,
    saveAbility: "constitution", saveDc: 14, damageFormula: "3d6", halfOnSave: true,
  } as const;

  it("fails loudly instead of rolling saves blind, and applies no damage", async () => {
    const before = { brute: hp(bruteId), nobody: hp(nobodyId) };
    h.failRelayAction("getCharacterAttributes", "RTDB auth expired");

    await expect(h.callTool("resolve_aoe", burst)).rejects.toThrow(/could not read save bonuses/i);

    // The point of failing BEFORE the batch: nothing is half-applied.
    expect(hp(bruteId)).toBe(before.brute);
    expect(hp(nobodyId)).toBe(before.nobody);
  });

  it("marks a save rolled on a flat d20, and leaves a real bonus unmarked", async () => {
    const { text } = await h.callTool("resolve_aoe", burst);
    const line = (name: string) => text.split("\n").find((l) => l.startsWith(`${name}:`)) ?? "";
    expect(line("Save Nobody")).toMatch(/flat d20/);
    expect(line("Save Brute")).not.toMatch(/flat d20/);
  });
});

// ── #192: an empty answer must not stand in for an unanswered one ─────────────
describe("#192 empty results that were really failures", () => {
  it("roll_initiative fails rather than silently omitting combatants from the order", async () => {
    await h.callTool("clear_turn_order", {});
    h.failRelayAction("findTokensInRange", "relay timeout");

    // Under-reporting here is worse than erroring: a swallowed range read drops that
    // PC's neighbours, so an NPC never enters the turn order and never gets a turn.
    await expect(h.callTool("roll_initiative", { nearPcsFeet: 60 })).rejects.toThrow(/relay timeout/);

    const { json } = await h.callTool("get_turn_order", {});
    expect(Array.isArray(json) ? json : []).toHaveLength(0);
  });

  it("clear_mob_plans fails before clearing, leaving the plans intact", async () => {
    await h.callTool("set_mob_plan", { tokenId: brawlerId, shortTerm: "Flank the cleric" });
    h.failRelayAction("getMobPlans", "relay timeout");

    await expect(h.callTool("clear_mob_plans", {})).rejects.toThrow(/relay timeout/);

    // The plans must still be there — the old code cleared them and reported "0",
    // stranding the HUD with cards for plans the relay no longer had.
    h.clearRelayFailures();
    const { json } = await h.callTool("get_mob_plans", {});
    const plans = json as Record<string, { plan: { shortTerm: string } | null }>;
    expect(plans[brawlerId]?.plan?.shortTerm).toBe("Flank the cleric");
  });
});
