// STALE (#180): this was meant as a control test running a MOD-ONLY action through the legacy
// Playwright browser relay (RT disabled) to distinguish "Mod is down" from "RT is down". That
// browser relay was deleted in #122/#179, and relayCommand (src/bridge/roll20.ts) never branched
// on ROLL20_TRANSPORT to begin with — it always dispatches over RT. So this script is now
// identical to running the RT path a second time; it no longer isolates anything. Left in place
// as a plain "is the Mod alive" liveness probe, not a control test.

import { relayCommand } from "../bridge/roll20.js";
import { getActiveCampaign } from "../registry/campaigns.js";

async function main() {
  const camp = getActiveCampaign();
  console.error(`[browser-relay] campaign: ${camp.name} (${camp.roll20CampaignId})`);
  console.error("[browser-relay] getPcHp (Mod round-trip via Playwright chat relay)...");
  const t = Date.now();
  const res = await relayCommand<Record<string, unknown>>({ action: "getPcHp" });
  console.error(`✅ Mod responded via browser relay in ${Date.now() - t}ms — Mod IS alive. keys=${res && typeof res === "object" ? Object.keys(res).length : "?"}`);
}

main().then(() => process.exit(0), (e) => { console.error(`❌ browser relay also failed: ${e?.message || e}\n→ Mod sandbox is down in this campaign (not a transport bug).`); process.exit(1); });
