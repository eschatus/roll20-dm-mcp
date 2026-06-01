import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import "dotenv/config";

import { buildCombatServer } from "./server-combat.js";

const server = buildCombatServer();

const transport = new StdioServerTransport();
await server.connect(transport);
