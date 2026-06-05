// LIVE integration test: proves the DDB <-> Roll20 pump is clean end to end.
//   DDB read pump  → getCharacterStats(ddbId): coherent HP/AC/saves (read-only)
//   sync pump      → reflect DDB current HP into a Roll20 token's PC-HP gmnotes via the relay
//   readback pump  → read it back over BOTH the socket AND the Mod; all three values must agree
//   round-trip     → damage through the relay, re-read, assert the math
//   contract       → re-read DDB, assert HP UNCHANGED (Roll20-only writes; DDB is read-only)
//
// Safe to run mid-session: DDB access is a background fetch (no navigation/focus steal); the Roll20
// write side uses a hidden gmlayer SCRATCH token (no real PC touched) that is deleted at the end.
//
// Run:  DDB_CHAR_ID=<id> npx tsx src/recon/ddb-roll20-sync-it.ts
// (omit DDB_CHAR_ID to let it discover the first linked char — that one navigates the DDB page.)
process.env.ROLL20_TRANSPORT = "rt";

import { getCharacterStats, getRawCharacter, getCurrentHp, getCampaignCharacters } from "../bridge/dndbeyond.js";
import { relayCommand } from "../bridge/roll20.js";
import { rtGet, rtRemove } from "../bridge/roll20-rt.js";
import { getActiveCampaign } from "../registry/campaigns.js";

let pass = 0, fail = 0;
const check = (label: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.error(`  ✓ ${label}${detail ? " — " + detail : ""}`); }
  else { fail++; console.error(`  ✗ FAIL: ${label}${detail ? " — " + detail : ""}`); }
};

async function main() {
  const camp = getActiveCampaign();
  console.error(`[it] campaign: ${camp.name} (ddb ${camp.ddbCampaignId}, roll20 ${camp.roll20CampaignId})`);

  // Resolve a DDB character to read.
  let charId = process.env.DDB_CHAR_ID ? Number(process.env.DDB_CHAR_ID) : null;
  if (!charId) {
    console.error("[it] DDB_CHAR_ID not set — discovering first linked character (navigates DDB)…");
    const chars = await getCampaignCharacters(camp.ddbCampaignId);
    if (!chars.length) { console.error("❌ no linked DDB characters found; set DDB_CHAR_ID"); process.exit(1); }
    charId = chars[0].id;
    console.error(`[it] using ${chars[0].characterName} (${charId})`);
  }

  // 1) DDB read pump — coherent stats.
  console.error("== DDB read pump ==");
  let stats;
  try {
    stats = await getCharacterStats(charId);
  } catch (e) {
    const msg = String(e);
    if (msg.includes("403") || msg.includes("Unauthorized")) {
      console.error(`⚠️  SKIPPED: DDB stats API returned 403 for character ${charId}.`);
      console.error("   getCharacterStats/getRawCharacter use the direct character-service API, which");
      console.error("   only serves characters this account OWNS or that are public — player-owned");
      console.error("   characters 403 (unlike getCharacter, which has a browser-page fallback).");
      console.error("   → Run with DDB_CHAR_ID=<a character you own or a public one> to exercise this pump.");
      console.error("   (The Roll20 write/readback pump is covered by soak-test.ts and ux-scenario-it.ts.)");
      console.error("\n⏭️  DDB↔Roll20 PUMP: skipped (DDB read not authorized for the chosen character)");
      process.exit(0);
    }
    throw e;
  }
  const ddbCurrent = stats.hp.current;
  check("getCharacterStats returns HP", typeof ddbCurrent === "number" && stats.hp.max > 0, `hp ${ddbCurrent}/${stats.hp.max}`);
  check("current ≤ max", ddbCurrent <= stats.hp.max);
  check("AC present", typeof stats.armorClass === "number" && stats.armorClass > 0, `AC ${stats.armorClass}`);
  check("six ability mods derived", Object.keys(stats.abilityMods).length === 6);
  const rawBefore = await getRawCharacter(charId);
  const ddbHpBefore = getCurrentHp(rawBefore);

  // 2) Sync pump — reflect DDB current HP onto a scratch Roll20 token's PC-HP block.
  console.error("== sync pump (DDB → Roll20) ==");
  const pid = (await rtGet<{ playerpageid?: string }>("campaign"))?.playerpageid!;
  const graphics = await rtGet<Record<string, { imgsrc?: string }>>(`graphics/page/${pid}`);
  const imgsrc = Object.values(graphics || {}).map((g) => g.imgsrc).find(Boolean);
  const { id } = await relayCommand<{ id: string }>({ action: "createToken", pageId: pid, name: "IT-SYNC " + stats.name, imgsrc, left: 35, top: 35, width: 70, height: 70, layer: "gmlayer" });
  const tokPath = `graphics/page/${pid}/${id}`;
  const synced = await relayCommand<{ current: number }>({ action: "adjustPcHp", tokenId: id, setHp: ddbCurrent });
  check("relay accepted DDB current HP", Number(synced.current) === ddbCurrent, `set ${synced.current}`);

  // 3) Readback pump — socket AND Mod must agree with the DDB value.
  console.error("== readback pump (socket + Mod agree) ==");
  const viaSocket = await relayCommand<{ current: number } | null>({ action: "getPcHp", tokenId: id });
  const viaMod = await relayCommand<{ current: number } | null>({ action: "getPcHp", tokenId: id, __forceMod: true });
  check("socket read = DDB current", Number(viaSocket?.current) === ddbCurrent, `socket ${viaSocket?.current}`);
  check("Mod read = DDB current", Number(viaMod?.current) === ddbCurrent, `Mod ${viaMod?.current}`);

  // 4) Round-trip — damage through the relay, re-read, assert math.
  console.error("== mutation round-trip ==");
  const dmg = 3;
  const after = await relayCommand<{ current: number }>({ action: "adjustPcHp", tokenId: id, damage: dmg });
  check("relay damage math", Number(after.current) === Math.max(0, ddbCurrent - dmg), `${ddbCurrent}-${dmg}=${after.current}`);
  const reread = await relayCommand<{ current: number } | null>({ action: "getPcHp", tokenId: id });
  check("re-read reflects mutation", Number(reread?.current) === Math.max(0, ddbCurrent - dmg));

  // 5) Read-only contract — DDB must be unchanged by anything above.
  console.error("== DDB read-only contract ==");
  const ddbHpAfter = getCurrentHp(await getRawCharacter(charId));
  check("DDB HP unchanged (Roll20-only writes)", ddbHpAfter === ddbHpBefore, `before ${ddbHpBefore}, after ${ddbHpAfter}`);

  // cleanup
  await rtRemove(tokPath);
  console.error(`\n${fail === 0 ? "✅" : "❌"} DDB↔Roll20 PUMP: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error("❌ integration test crashed:", e); process.exit(1); });
