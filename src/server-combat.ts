import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { registerCampaignTools } from "./tools/campaigns.js";
import { registerCampaignContextTools } from "./tools/campaignContext.js";
import { registerCombatTools } from "./tools/combat.js";
import { registerDdbTools } from "./tools/ddb.js";
import { registerVisionTools } from "./tools/vision.js";
import { registerTacticsTools } from "./tools/tactics.js";
import { registerJournalTools } from "./tools/journal.js";
import { registerTransportTools } from "./tools/transport.js";

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
  registerVisionTools(server);
  registerTacticsTools(server);
  registerJournalTools(server);
  registerTransportTools(server);

  return server;
}
