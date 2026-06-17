import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { registerCampaignTools } from "./tools/campaigns.js";
import { registerCombatTools } from "./tools/combat.js";
import { registerDdbTools } from "./tools/ddb.js";
import { registerScreenshotTool } from "./tools/vision.js";
import { registerTacticsTools } from "./tools/tactics.js";
import { registerJournalTools } from "./tools/journal.js";

// Single source of truth for the combat server's tool set, shared by the stdio
// (index-combat.ts) and HTTP (index-http.ts) entry points so they never drift.
export function buildCombatServer(): McpServer {
  const server = new McpServer({
    name: "roll20-dm",
    version: "0.1.0",
  });

  registerCampaignTools(server);
  registerCombatTools(server);
  registerDdbTools(server);
  // Map/wall authoring (analyze_battlemap, walls, decorate_openings) lives ONLY on
  // the roll20-dm-maps server now. Combat keeps just screenshot_roll20 so it can see
  // the board, plus zones + find_tokens_in_range (in registerCombatTools) for AoE.
  registerScreenshotTool(server);
  registerTacticsTools(server);
  registerJournalTools(server);

  return server;
}
