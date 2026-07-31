// End-to-end proof: read a REAL recent Broo roll from DDB game 1117568, render it, and
// post it to the ACTIVE campaign's Roll20 chat via the deployed postChat relay action.
// Proves the last hop (the Roll20 write). Posts ONE card, clearly from D&D Beyond.
import { rtAuthToken, rtRawFetch } from "../bridge/ddb-rt.js";
import { renderRollForRoll20, type DdbGameLogMessage } from "../bridge/ddb-gamelog.js";
import * as roll20 from "../bridge/roll20.js";
import { getActiveCampaign } from "../registry/campaigns.js";

async function main() {
  const c = getActiveCampaign();
  console.error(`[e2e] active campaign: ${c.slug} → Roll20 ${c.roll20CampaignId} (write target)`);

  const { userId } = await rtAuthToken();
  const res = await rtRawFetch(`https://game-log-rest-live.dndbeyond.com/v1/getmessages?gameId=1117568&userId=${userId}`, { auth: "bearer" });
  const body = await res.json() as { data: DdbGameLogMessage[] };
  const broo = body.data.find((m) => m.entityId === "130003005" && m.eventType === "dice/roll/fulfilled");
  if (!broo) { console.error("[e2e] no recent Broo roll found in game 1117568"); process.exit(1); }

  const { speakAs, message } = renderRollForRoll20(broo);
  console.error(`[e2e] posting as "${speakAs}": ${message}`);
  const r = await roll20.relayCommand({ action: "postChat", speakAs, message });
  console.error(`[e2e] relay result:`, JSON.stringify(r));
  console.error(`[e2e] ✓ check Roll20 chat in game ${c.roll20CampaignId} for the card.`);
}
main().then(() => process.exit(0)).catch((e) => { console.error("[e2e] FAILED:", (e as Error).message); process.exit(1); });
