import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getStats } from "../bridge/transport-health.js";
import { rtEnabled } from "../bridge/roll20-rt.js";
import { getActiveCampaign } from "../registry/campaigns.js";
import { EXPECTED_RELAY_VERSION } from "../bridge/relay-version.js";
import { getRelayVersionMismatch } from "../bridge/relay-version-check.js";

export function registerTransportTools(server: McpServer): void {
  server.tool(
    "transport_status",
    "Show health of RT and browser transports, circuit-breaker state, counters, active campaign, and the deployed Mod relay's version handshake",
    {},
    async () => {
      let activeCampaign = "(none)";
      try { activeCampaign = getActiveCampaign().slug; } catch { /* no active campaign */ }
      const mismatch = getRelayVersionMismatch();
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            ...getStats(),
            rtEnabled: rtEnabled(),
            activeCampaign,
            relayVersion: {
              expected: EXPECTED_RELAY_VERSION,
              // null = no mismatch detected yet (either not probed, or the deployed relay matches).
              mismatch,
              note: mismatch
                ? `Roll20 relay is out of date — found ${mismatch.found}, expected ${mismatch.expected}. Run "npm run release:mod" to redeploy.`
                : undefined,
            },
          }),
        }],
      };
    }
  );
}
