// Live combat harness — exercises the full write path against a REAL Roll20 campaign
// + deployed Mod, focused on the reliability changes in the 2026-06-14 review pass.
// Seeds throwaway tokens, runs a scripted combat, verifies, then cleans up.
//
// Run (stop the long-running HTTP server first — two processes sharing the browser/
// relay collide on the chat input and the nonce stream):
//
//     ROLL20_TRANSPORT=rt npx tsx src/recon/fake-combat-it.ts
//
// ROLL20_TRANSPORT=rt is important: the read-modify-write transaction fix lives on the
// RT direct-write path. Without it the concurrency probe tests the (serialized) browser
// relay instead, which would pass for a different reason and not exercise the fix.
//
// Safety: refuses to run unless the active campaign slug looks like a throwaway
// (matches /candlekeep|test|harness/), or HARNESS_FORCE=1 is set — so it can't seed
// junk tokens into a real game.
//
// What each phase validates (today's commit):
//   - setTokenBar / getTokenById ........ relay write + centralized nonce
//   - toggleCondition (parallel x6) ..... runTransaction on statusmarkers (RMW race fix)
//   - adjustPcHp + getPcHp .............. runTransaction on gmnotes PCHP block
//   - rollInitiative + advanceTurn ...... turn hook + round-end narration
//   - internalPlanToken tier 5 .......... Opus 4.8 + adaptive thinking (the tier-5 400 fix)
//   - switch_campaign → CoS → back ...... per-campaign state reset on switch
//   - getStats() ........................ transport counters / fallback tracking

import "dotenv/config";
import * as campaigns from "../registry/campaigns.js";
import * as roll20 from "../bridge/roll20.js";
import { rtEnabled, rtGet } from "../bridge/roll20-rt.js";
import { getStats } from "../bridge/transport-health.js";
import { internalPlanToken } from "../tools/tactics.js";

const HARNESS_SLUG = process.env.HARNESS_CAMPAIGN || "candlekeep-and-golden-vault";
const SAFE = /candlekeep|test|harness/i;
const POISON = "Poisoned::4444329"; // condition marker tag used by the RMW probe

let pass = 0, fail = 0;
const seededIds: string[] = [];

async function step<T>(label: string, fn: () => Promise<T>, check?: (r: T) => string | null): Promise<T | undefined> {
  const t = Date.now();
  try {
    const r = await fn();
    const problem = check ? check(r) : null;
    if (problem) { fail++; console.error(`  ✗ ${label} — ${problem} (${Date.now() - t}ms)`); }
    else { pass++; console.error(`  ✓ ${label} (${Date.now() - t}ms)`); }
    return r;
  } catch (e) {
    fail++; console.error(`  ✗ ${label} — THREW: ${(e as Error).message} (${Date.now() - t}ms)`);
    return undefined;
  }
}

type Tok = { id: string; name: string; bar1_value: number; bar1_max: number; statusmarkers: string };

async function seed(pageId: string, name: string, hp: number, x: number, controlledby?: string): Promise<string> {
  const r = await roll20.relayCommand<{ id: string }>({
    action: "createToken", pageId, name, layer: "objects", imgsrc: "",
    left: x, top: 140, width: 70, height: 70, bar1_value: hp, bar1_max: hp,
  });
  if (controlledby) await roll20.relayCommand({ action: "setTokenProps", tokenId: r.id, props: { controlledby } });
  seededIds.push(r.id);
  return r.id;
}

const getTok = (tokenId: string) => roll20.relayCommand<Tok | null>({ action: "getTokenById", tokenId });
const markers = (t: Tok | null) => String(t?.statusmarkers || "").split(",").filter(Boolean);

// Resolve the player page robustly. The RT campaign read (shard-correct as of the namespace fix)
// is the most reliable headless source; fall back to the browser Backbone read, then to the first
// listed page. The old harness trusted getCurrentPageId() alone, which returned false on a cold
// browser and on the wrong shard.
async function resolvePageId(): Promise<string> {
  try { const c = await rtGet<{ playerpageid?: string }>("campaign"); if (c?.playerpageid) return c.playerpageid; } catch { /* fall through */ }
  try { const p = await roll20.getCurrentPageId(); if (p && typeof p === "string") return p; } catch { /* fall through */ }
  const pages = await roll20.relayCommand<{ id: string; name: string }[]>({ action: "listPages" });
  if (pages?.length) return pages[0].id;
  throw new Error("could not resolve a page id (campaign read, browser, and listPages all failed)");
}

async function main() {
  const original = (() => { try { return campaigns.getActiveCampaign().slug; } catch { return null; } })();

  // --- Guard ---------------------------------------------------------------
  const target = campaigns.setActiveCampaign(HARNESS_SLUG);
  const slug = campaigns.getActiveCampaign().slug;
  if (!SAFE.test(slug) && process.env.HARNESS_FORCE !== "1") {
    console.error(`✗ refusing to run: "${slug}" doesn't look like a throwaway campaign. Set HARNESS_FORCE=1 to override.`);
    process.exit(2);
  }
  console.error(`[harness] campaign: ${target.name} (roll20 ${target.roll20CampaignId})`);
  console.error(`[harness] transport: ${rtEnabled() ? "rt (transaction path WILL be exercised)" : "browser — ⚠ set ROLL20_TRANSPORT=rt to exercise the RMW fix"}`);

  const pageId = await resolvePageId();
  console.error(`[harness] player page: ${pageId}\n`);

  // --- Seed ----------------------------------------------------------------
  console.error("[seed]");
  const pc = await seed(pageId, "Test Fighter", 30, 140, "harness-player");
  const gobA = await seed(pageId, "Test Goblin", 7, 210);
  const gobB = await seed(pageId, "Test Goblin", 7, 280); // duplicate name → epithet test on init
  const mage = await seed(pageId, "Test Archmage", 40, 350);
  console.error(`  seeded pc=${pc} gobA=${gobA} gobB=${gobB} mage=${mage}\n`);

  // --- 1. NPC HP write -----------------------------------------------------
  console.error("[write path]");
  await step("setTokenBar: damage goblin to 3", () => roll20.relayCommand({ action: "setTokenBar", tokenId: gobA, value: 3, max: 7 }));
  await step("read back HP === 3", () => getTok(gobA), (t) => Number(t?.bar1_value) === 3 ? null : `got ${t?.bar1_value}`);

  // --- 2. Condition toggle (transaction, single) ---------------------------
  await step("toggleCondition poisoned ON", () => roll20.relayCommand({ action: "toggleCondition", tokenId: gobA, condition: "poisoned", active: true }));
  await step("marker present", () => getTok(gobA), (t) => markers(t).includes(POISON) ? null : `markers=[${markers(t)}]`);
  await step("toggleCondition poisoned OFF", () => roll20.relayCommand({ action: "toggleCondition", tokenId: gobA, condition: "poisoned", active: false }));
  await step("marker gone", () => getTok(gobA), (t) => !markers(t).includes(POISON) ? null : `markers=[${markers(t)}]`);

  // --- 3. CONCURRENCY PROBE — the RMW race fix -----------------------------
  // Six conditions toggled in parallel onto ONE token. Pre-fix, the read-splice-write
  // interleaves and loses some; the runTransaction fix must land all six.
  console.error("\n[RMW race probe — 6 parallel condition toggles on one token]");
  const conds = ["poisoned", "prone", "blinded", "charmed", "stunned", "restrained"];
  await step("6x toggleCondition in parallel", () =>
    Promise.all(conds.map((c) => roll20.relayCommand({ action: "toggleCondition", tokenId: mage, condition: c, active: true }))));
  await step("all 6 markers present (no lost update)", () => getTok(mage), (t) => {
    const n = markers(t).length;
    return n >= 6 ? null : `only ${n}/6 markers landed — markers=[${markers(t)}]`;
  });
  await step("6x clear in parallel", () =>
    Promise.all(conds.map((c) => roll20.relayCommand({ action: "toggleCondition", tokenId: mage, condition: c, active: false }))));
  await step("all markers cleared", () => getTok(mage), (t) => markers(t).length === 0 ? null : `leftover=[${markers(t)}]`);

  // --- 4. PC HP transaction (gmnotes PCHP block) ---------------------------
  console.error("\n[PC HP — gmnotes transaction + parse]");
  await step("adjustPcHp damage 8 (30→22)", () => roll20.relayCommand({ action: "adjustPcHp", tokenId: pc, damage: 8 }));
  await step("getPcHp current === 22", () => roll20.relayCommand<{ current: number } | null>({ action: "getPcHp", tokenId: pc }), (r) => Number(r?.current) === 22 ? null : `got ${JSON.stringify(r)}`);
  await step("adjustPcHp heal 3 (22→25)", () => roll20.relayCommand({ action: "adjustPcHp", tokenId: pc, heal: 3 }));
  await step("getPcHp current === 25", () => roll20.relayCommand<{ current: number } | null>({ action: "getPcHp", tokenId: pc }), (r) => Number(r?.current) === 25 ? null : `got ${JSON.stringify(r)}`);

  // --- 5. Initiative + turn hook -------------------------------------------
  console.error("\n[initiative + turn hook]");
  const ids = [pc, gobA, gobB, mage];
  const rolls = await step("rollInitiativeForTokens (renames dup goblins)", () =>
    roll20.relayCommand<{ tokenId: string; total: number }[]>({ action: "rollInitiativeForTokens", tokenIds: ids, rollPublic: true }));
  if (rolls?.length) {
    const entries = rolls.map((r) => ({ id: r.tokenId, pr: String(r.total), custom: "", _pageid: pageId }));
    await step("mergeTurnOrder", () => roll20.relayCommand({ action: "mergeTurnOrder", entries, clearNpcFirst: true }));
    await step("setTurnHook on", () => roll20.relayCommand({ action: "setTurnHook", enabled: true, reset: true }));
    for (let i = 0; i < ids.length + 1; i++) {
      await step(`advanceTurn ${i + 1} (round-end narration on wrap)`, () => roll20.relayCommand<{ ok: boolean }>({ action: "advanceTurn" }), (r) => r?.ok ? null : "not ok");
    }
  }

  // --- 6. TACTICS — Opus 4.8 tier 5 (the headline 400 fix) -----------------
  console.error("\n[tactics — model calls]");
  await step("tier-5 plan (Opus 4.8, full cascade, NO 400)", () =>
    internalPlanToken(mage, pageId, { intOverride: 22, wisOverride: 22, postToChat: true, debug: false }),
    (r) => {
      if (r.error) return `plan error: ${r.error}`;
      if (r.tier !== 5) return `expected tier 5, got ${r.tier}`;
      if (!r.shortTermPlan?.trim()) return "empty short-term plan";
      if (!r.longTermGoal?.trim()) return "no long-term goal — Opus cascade pass didn't complete";
      return null;
    });
  await step("tier-0 plan (Haiku, instinct)", () =>
    internalPlanToken(gobA, pageId, { intOverride: 3, wisOverride: 3, postToChat: false, debug: false }),
    (r) => r.error ? `plan error: ${r.error}` : (r.tier === 0 && r.shortTermPlan?.trim() ? null : `tier=${r.tier} plan="${r.shortTermPlan}"`));

  // --- 7. Transport counters ----------------------------------------------
  console.error("\n[transport_status]");
  const stats = getStats();
  console.error(`  ${JSON.stringify(stats)}`);
  if (stats.rt.fallbacks > 0) console.error(`  ⚠ ${stats.rt.fallbacks} rt→browser fallback(s) — rt had trouble; check lastFailureAction=${stats.rt.lastFailureAction}`);

  // --- 8. Campaign-switch reset --------------------------------------------
  console.error("\n[campaign-switch reset]");
  await step("switch → curse-of-strahd + read", async () => {
    campaigns.setActiveCampaign("curse-of-strahd");
    return roll20.relayCommand({ action: "getTurnOrder" });
  });
  await step("switch back → harness + read (no crash, subscriptions rebind)", async () => {
    campaigns.setActiveCampaign(HARNESS_SLUG);
    return roll20.relayCommand({ action: "getTurnOrder" });
  });

  // --- Cleanup -------------------------------------------------------------
  console.error("\n[cleanup]");
  await step("clear turn order", () => roll20.relayCommand({ action: "setTurnOrder", entries: [] }));
  await step("clear mob plans", () => roll20.relayCommand({ action: "clearMobPlans" }));
  for (const id of seededIds) {
    await step(`remove token ${id}`, () => roll20.relayCommand({ action: "removeObject", objectType: "graphic", objectId: id }));
  }
  if (original) { try { campaigns.setActiveCampaign(original); console.error(`[harness] restored active campaign → ${original}`); } catch { /* ignore */ } }

  // --- Summary -------------------------------------------------------------
  console.error(`\n${fail === 0 ? "✅" : "❌"} ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error("\n❌ harness crashed:", e); process.exit(1); });
