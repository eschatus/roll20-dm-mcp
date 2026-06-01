import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import "dotenv/config";

import { registerCampaignTools } from "./tools/campaigns.js";
import { registerMapTools } from "./tools/maps.js";
import { registerTokenTools } from "./tools/tokens.js";
import { registerVisionTools, registerScreenshotTool } from "./tools/vision.js";

const server = new McpServer({
  name: "roll20-dm-maps",
  version: "0.1.0",
});

registerCampaignTools(server);
registerMapTools(server);
registerTokenTools(server);
registerVisionTools(server);
registerScreenshotTool(server);

const transport = new StdioServerTransport();
await server.connect(transport);
