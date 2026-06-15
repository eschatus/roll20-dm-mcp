import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getStats } from "../bridge/transport-health.js";
import { rtEnabled } from "../bridge/roll20-rt.js";
import { getActiveCampaign } from "../registry/campaigns.js";

export function registerTransportTools(server: McpServer): void {
  server.tool(
    "transport_status",
    "Show health of RT and browser transports, circuit-breaker state, counters, and active campaign",
    {},
    async () => {
      let activeCampaign = "(none)";
      try { activeCampaign = getActiveCampaign().slug; } catch { /* no active campaign */ }
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            ...getStats(),
            rtEnabled: rtEnabled(),
            activeCampaign,
          }),
        }],
      };
    }
  );
}
