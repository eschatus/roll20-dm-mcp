import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import "dotenv/config";

import { registerCampaignTools } from "./tools/campaigns.js";
import { registerCampaignContextTools } from "./tools/campaignContext.js";
import { registerMapTools } from "./tools/maps.js";
import { registerTokenTools } from "./tools/tokens.js";
import { registerVisionTools } from "./tools/vision.js";
import { registerBatchTools } from "./tools/batch.js";

const server = new McpServer({
  name: "roll20-dm-maps",
  version: "0.1.0",
});

registerCampaignTools(server);
registerCampaignContextTools(server);
registerMapTools(server);
registerTokenTools(server);
registerVisionTools(server);
registerBatchTools(server);

const transport = new StdioServerTransport();
await server.connect(transport);
