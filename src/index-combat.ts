import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import "dotenv/config";

import { registerCampaignTools } from "./tools/campaigns.js";
import { registerCombatTools } from "./tools/combat.js";
import { registerDdbTools } from "./tools/ddb.js";
import { registerVisionTools } from "./tools/vision.js";

const server = new McpServer({
  name: "roll20-dm",
  version: "0.1.0",
});

registerCampaignTools(server);
registerCombatTools(server);
registerDdbTools(server);
registerVisionTools(server);

const transport = new StdioServerTransport();
await server.connect(transport);
