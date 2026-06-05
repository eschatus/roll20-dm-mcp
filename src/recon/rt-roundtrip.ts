// Live validation of the browserless RTDB transport (src/bridge/roll20-rt.ts).
// Proves the one unverified link: can a GM client WRITE to /chat and get the Mod to respond?
// Uses only READ-ONLY Mod actions (getTurnOrder, getPcHp) — nothing in the campaign is modified.
//
// Run:  npx tsx src/recon/rt-roundtrip.ts
// First run launches the browser ONCE to harvest the session cookie, then operates over the socket.

import { rtRelayCommand } from "../bridge/roll20-rt.js";
import { getActiveCampaign } from "../registry/campaigns.js";

async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const t = Date.now();
  const r = await fn();
  console.error(`  ✓ ${label} — ${Date.now() - t}ms`);
  return r;
}

async function main() {
  const camp = getActiveCampaign();
  console.error(`[rt-test] campaign: ${camp.name} (roll20 ${camp.roll20CampaignId})`);

  console.error("[rt-test] round-trip 1: getTurnOrder (read-only)");
  const turnorder = await timed("getTurnOrder", () => rtRelayCommand<unknown[]>({ action: "getTurnOrder" }));
  console.error(`    turn order entries: ${Array.isArray(turnorder) ? turnorder.length : "?"}`);

  console.error("[rt-test] round-trip 2: getPcHp (read-only)");
  const pcHp = await timed("getPcHp", () => rtRelayCommand<Record<string, unknown>>({ action: "getPcHp" }));
  console.error(`    pcHp keys: ${pcHp && typeof pcHp === "object" ? Object.keys(pcHp).length : "?"}`);

  console.error("\n✅ WRITE PATH CONFIRMED — GM client wrote to /chat and the Mod responded over Firebase.");
  console.error("   The browserless transport works. Enable everywhere with ROLL20_TRANSPORT=rt.");
}

main().then(
  () => process.exit(0),
  (err) => { console.error("\n❌ rt round-trip FAILED:", err); process.exit(1); }
);
