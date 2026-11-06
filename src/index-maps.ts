import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import "dotenv/config";

import { registerCampaignTools } from "./tools/campaigns.js";
import { registerMapTools } from "./tools/maps.js";
import { registerTokenTools } from "./tools/tokens.js";
import { registerVisionTools } from "./tools/vision.js";
import { registerWallReplaceTools } from "./tools/wall-replace.js";
import { registerBatchTools } from "./tools/batch.js";
import { registerZoneTools } from "./tools/zones.js";
import { BUILD_VERSION } from "./build-version.js";

const server = new McpServer({
  name: "roll20-dm-maps",
  version: BUILD_VERSION,
});

// The maps suite owns the full map/wall/zone domain: page setup, vision/wall
// analysis, token placement, batch import, zones, and screenshots. Zones +
// screenshot are also registered in the combat server (shared, live-use).
registerCampaignTools(server);
registerMapTools(server);
registerTokenTools(server);
registerVisionTools(server);
registerWallReplaceTools(server);
registerBatchTools(server);
registerZoneTools(server);

const transport = new StdioServerTransport();
await server.connect(transport);
