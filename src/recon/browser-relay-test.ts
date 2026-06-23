// Control test: run a MOD-ONLY action through the known-good Playwright browser relay (RT disabled)
// in the current campaign. getPcHp has no client-direct reader, so it must round-trip through the
// Mod — exactly like RT does. If THIS also times out, the Mod sandbox is down (not our transport).

import { relayCommand } from "../bridge/roll20.js";
import { getActiveCampaign } from "../registry/campaigns.js";

async function main() {
  process.env.ROLL20_TRANSPORT = "browser"; // force the legacy browser relay (RT is the default now)
  const camp = getActiveCampaign();
  console.error(`[browser-relay] campaign: ${camp.name} (${camp.roll20CampaignId})`);
  console.error("[browser-relay] getPcHp (Mod round-trip via Playwright chat relay)...");
  const t = Date.now();
  const res = await relayCommand<Record<string, unknown>>({ action: "getPcHp" });
  console.error(`✅ Mod responded via browser relay in ${Date.now() - t}ms — Mod IS alive. keys=${res && typeof res === "object" ? Object.keys(res).length : "?"}`);
}

main().then(() => process.exit(0), (e) => { console.error(`❌ browser relay also failed: ${e?.message || e}\n→ Mod sandbox is down in this campaign (not a transport bug).`); process.exit(1); });
