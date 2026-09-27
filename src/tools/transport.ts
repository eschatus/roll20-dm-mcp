import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getStats } from "../bridge/transport-health.js";
import { getActiveCampaign } from "../registry/campaigns.js";
import { EXPECTED_RELAY_VERSION } from "../bridge/relay-version.js";
import { getRelayVersionMismatch, getRelaySandboxInfo } from "../bridge/relay-version-check.js";
import { getRtTokenStatus } from "../bridge/roll20-rt.js";
import { BUILD_VERSION } from "../build-version.js";

export function registerTransportTools(server: McpServer): void {
  server.tool(
    "transport_status",
    "Show this server's build version, RT transport health, circuit-breaker state, counters, active campaign, the age of the on-disk Roll20 realtime token, and the deployed Mod relay's version handshake",
    {},
    async () => {
      let activeCampaign = "(none)";
      let activeRoll20Id: string | null = null;
      try {
        const c = getActiveCampaign();
        activeCampaign = c.slug;
        activeRoll20Id = c.roll20CampaignId;
      } catch { /* no active campaign */ }
      const mismatch = getRelayVersionMismatch();
      const sandbox = getRelaySandboxInfo();
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
            // Which Roll20 Mod Script Sandbox this campaign runs (v1.0 vs v1.5 — Roll20 made 1.5
            // the default on 2026-09-02). null = not probed yet, or the deployed relay is older
            // than 2.6.0 and doesn't echo it.
            sandbox,
            // Age of the furnished roll20-rt-token.json (#216). An already-connected server runs
            // off its live socket and stays healthy long after this file goes cold, which is
            // exactly when every OTHER reader of the data dir (roll20-dm-maps over stdio, a CLI
            // script) gets locked out. Reporting it here is the only warning anyone gets. Also
            // flags a token harvested for a different campaign than the active one.
            rtToken: getRtTokenStatus(activeRoll20Id),
            relayVersion: {
              expected: EXPECTED_RELAY_VERSION,
              // null = no mismatch detected yet (either not probed, or the deployed relay matches).
              mismatch,
              note: mismatch
                ? `Roll20 relay is out of date — found ${mismatch.found}, expected ${mismatch.expected}. Run "npm run build:mod", paste mod-scripts/.ai-relay.deploy.js into this campaign's Settings → API Scripts and save, then confirm the Mod console prints "[GM_AI_Bridge] Relay script loaded (v${mismatch.expected})". Deploys are per-campaign.`
                : undefined,
            },
          }),
        }],
      };
    }
  );
}
