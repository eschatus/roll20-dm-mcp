import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { registerCampaignTools } from "./tools/campaigns.js";
import { registerCampaignContextTools } from "./tools/campaignContext.js";
import { registerCombatTools } from "./tools/combat.js";
import { registerDdbTools } from "./tools/ddb.js";
import { registerTacticsTools } from "./tools/tactics.js";
import { registerJournalTools } from "./tools/journal.js";
import { registerTransportTools } from "./tools/transport.js";
import { registerCharacterEditTools } from "./tools/characters-edit.js";
import { registerZoneTools } from "./tools/zones.js";
import { registerScreenshotTools } from "./tools/screenshot.js";

// Single source of truth for the combat server's tool set, shared by the stdio
// (index-combat.ts) and HTTP (index-http.ts) entry points so they never drift.
export function buildCombatServer(): McpServer {
  const server = new McpServer({
    name: "roll20-dm",
    version: "0.1.0",
  });

  registerCampaignTools(server);
  registerCampaignContextTools(server);
  registerCombatTools(server);
  registerDdbTools(server);
  registerTacticsTools(server);
  registerJournalTools(server);
  registerTransportTools(server);
  registerCharacterEditTools(server);
  // Map/wall/zone tooling lives in the maps suite (roll20-dm-maps). Combat keeps
  // only the dual-use pieces it needs live: zones (fixed-area spells) + screenshot
  // (board vision). The prep-only analysis/wall tools (registerVisionTools) do NOT
  // belong here — see index-maps.ts.
  registerZoneTools(server);
  registerScreenshotTools(server);

  return server;
}
