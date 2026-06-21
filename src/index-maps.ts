import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import "dotenv/config";

import { registerCampaignTools } from "./tools/campaigns.js";
import { registerCampaignContextTools } from "./tools/campaignContext.js";
import { registerMapTools } from "./tools/maps.js";
import { registerTokenTools } from "./tools/tokens.js";
import { registerVisionTools } from "./tools/vision.js";
import { registerBatchTools } from "./tools/batch.js";
import { registerZoneTools } from "./tools/zones.js";
import { registerScreenshotTools } from "./tools/screenshot.js";

const server = new McpServer({
  name: "roll20-dm-maps",
  version: "0.1.0",
});

// The maps suite owns the full map/wall/zone domain: page setup, vision/wall
// analysis, token placement, batch import, zones, and screenshots. Zones +
// screenshot are also registered in the combat server (shared, live-use).
registerCampaignTools(server);
registerCampaignContextTools(server);
registerMapTools(server);
registerTokenTools(server);
registerVisionTools(server);
registerBatchTools(server);
registerZoneTools(server);
registerScreenshotTools(server);

const transport = new StdioServerTransport();
await server.connect(transport);
