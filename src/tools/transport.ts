import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getStats } from "../bridge/transport-health.js";
import { getActiveCampaign } from "../registry/campaigns.js";
import { EXPECTED_RELAY_VERSION } from "../bridge/relay-version.js";
import { getRelayVersionMismatch } from "../bridge/relay-version-check.js";
import { BUILD_VERSION } from "../build-version.js";

export function registerTransportTools(server: McpServer): void {
  server.tool(
    "transport_status",
    "Show this server's build version, RT transport health, circuit-breaker state, counters, active campaign, and the deployed Mod relay's version handshake",
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
            // This server's own build, the same value announced to MCP callers in serverInfo.
            serverVersion: BUILD_VERSION,
            // RT is the only transport (#122/#179) — there is no ROLL20_TRANSPORT switch to
            // report any more (#180). getStats() already carries RT's own health/circuit state.
            activeCampaign,
            relayVersion: {
              expected: EXPECTED_RELAY_VERSION,
              // null = no mismatch detected yet (either not probed, or the deployed relay matches).
              mismatch,
              note: mismatch
                ? `Roll20 relay is out of date — found ${mismatch.found}, expected ${mismatch.expected}. Paste mod-scripts/ai-relay.js into this campaign's Roll20 API console (Settings → API Scripts) and save, then confirm the Mod console prints "Relay script loaded (v${mismatch.expected})". Deploys are per-campaign.`
                : undefined,
            },
          }),
        }],
      };
    }
  );
}
