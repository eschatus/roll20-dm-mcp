import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import path from "path";
import { z } from "zod";
import * as campaigns from "../registry/campaigns.js";
import { reconnectRoll20 } from "../bridge/roll20.js";
import { readModConsole, deployModScript, modEditorUrl, dumpModPageStructure } from "../bridge/mod-editor.js";

export function registerCampaignTools(server: McpServer): void {
  server.tool(
    "register_campaign",
    "Register a campaign by name with its Roll20 and D&D Beyond IDs",
    {
      name: z.string().describe("Human-readable campaign name, e.g. 'Curse of Strahd'"),
      roll20CampaignId: z.string().describe("Roll20 campaign ID from the URL: app.roll20.net/campaigns/details/XXXXXX"),
      ddbCampaignId: z.string().describe("D&D Beyond campaign ID from the URL: dndbeyond.com/campaigns/XXXXXX"),
      notes: z.string().optional().describe("Optional notes about this campaign"),
    },
    async ({ name, roll20CampaignId, ddbCampaignId, notes }) => {
      const slug = campaigns.registerCampaign(name, roll20CampaignId, ddbCampaignId, notes);
      return {
        content: [
          {
            type: "text",
            text: `Registered campaign "${name}" as slug "${slug}". Use switch_campaign("${slug}") to make it active.`,
          },
        ],
      };
    }
  );

  server.tool(
    "list_campaigns",
    "List all registered campaigns and which one is currently active",
    {},
    async () => {
      const list = campaigns.listCampaigns();
      if (list.length === 0) {
        return {
          content: [{ type: "text", text: "No campaigns registered yet. Use register_campaign to add one." }],
        };
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              list.map((c) => ({
                slug: c.slug,
                name: c.name,
                active: c.active,
                roll20CampaignId: c.roll20CampaignId,
                ddbCampaignId: c.ddbCampaignId,
                ...(c.notes ? { notes: c.notes } : {}),
              })),
              null,
              2
            ),
          },
        ],
      };
    }
  );

  server.tool(
    "switch_campaign",
    "Switch the active campaign — all subsequent tool calls will use this campaign's Roll20 and DDB IDs",
    {
      slugOrName: z.string().describe("Campaign slug (e.g. 'curse-of-strahd') or partial name match"),
    },
    async ({ slugOrName }) => {
      const entry = campaigns.setActiveCampaign(slugOrName);
      return {
        content: [
          {
            type: "text",
            text: `Active campaign set to "${entry.name}" (Roll20: ${entry.roll20CampaignId}, DDB: ${entry.ddbCampaignId})`,
          },
        ],
      };
    }
  );

  server.tool(
    "active_campaign",
    "Show which campaign is currently active",
    {},
    async () => {
      try {
        const entry = campaigns.getActiveCampaign();
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                slug: entry.slug,
                name: entry.name,
                roll20CampaignId: entry.roll20CampaignId,
                ddbCampaignId: entry.ddbCampaignId,
              }),
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `No active campaign. ${(err as Error).message}` }],
        };
      }
    }
  );

  server.tool(
    "remove_campaign",
    "Remove a campaign from the registry (does not affect Roll20 or DDB data)",
    { slugOrName: z.string() },
    async ({ slugOrName }) => {
      const removed = campaigns.removeCampaign(slugOrName);
      return {
        content: [
          {
            type: "text",
            text: removed ? `Removed campaign "${slugOrName}"` : `Campaign not found: "${slugOrName}"`,
          },
        ],
      };
    }
  );

  server.tool(
    "reconnect_browser",
    "Force-rebind the Playwright browser + Roll20 page when relay commands or reads start failing/hanging with 'Target page, context or browser has been closed' (browser crashed, tab closed, page wedged, hooks dead). Tears down the cached Chromium context AND the Roll20 editor-page handle, then relaunches/reattaches and re-navigates to the active campaign. Use this instead of restarting the whole MCP server.",
    {
      hard: z
        .boolean()
        .optional()
        .describe("Default true: fully close the Chromium context before relaunching (kills a zombie browser). Set false for a soft re-acquire that reattaches if the browser is still alive."),
    },
    async ({ hard }) => {
      let name = "(unknown campaign)";
      try { name = campaigns.getActiveCampaign().name; } catch { /* no active campaign — still fine to rebind */ }
      try {
        const res = await reconnectRoll20({ hard: hard !== false });
        return {
          content: [
            {
              type: "text",
              text: `Rebound Roll20 browser (${res.hard ? "hard relaunch/reattach" : "soft re-acquire"}) for "${name}" — page at ${res.url}`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Reconnect failed: ${(err as Error).message}. If the profile is locked, close stray Chromium windows and retry, or restart the MCP server.` }],
        };
      }
    }
  );

  server.tool(
    "dump_mod_page_structure",
    "Debug: dump all id/class selectors from the Roll20 Mod editor page to find the right console/editor selectors.",
    {},
    async () => {
      const { roll20CampaignId } = campaigns.getActiveCampaign();
      const dump = await dumpModPageStructure(roll20CampaignId);
      return { content: [{ type: "text", text: dump }] };
    }
  );

  server.tool(
    "read_mod_console",
    "Read recent lines from the Roll20 Mod Output Console (API editor page). Returns log() output from the sandbox. Opens the API editor in a separate browser page — does not disturb the game session.",
    {},
    async () => {
      const { roll20CampaignId } = campaigns.getActiveCampaign();
      const lines = await readModConsole(roll20CampaignId);
      return {
        content: [{ type: "text", text: lines.length ? lines.join("\n") : "(console empty)" }],
      };
    }
  );

  server.tool(
    "deploy_mod_script",
    "Deploy the local ai-relay.js to Roll20 via browser automation: opens the API editor in a background page, sets the CodeMirror content, and clicks Save. Does not disturb the active game session.",
    {
      scriptPath: z
        .string()
        .optional()
        .describe("Absolute path to the relay script. Defaults to mod-scripts/ai-relay.js in the repo root."),
    },
    async ({ scriptPath }) => {
      const { roll20CampaignId } = campaigns.getActiveCampaign();
      const resolvedPath = scriptPath ?? path.resolve("mod-scripts/ai-relay.js");
      const result = await deployModScript(roll20CampaignId, resolvedPath, { tabName: "ai-relay.js" });
      return {
        content: [{ type: "text", text: `Deployed ${result.linesWritten} lines to campaign ${roll20CampaignId}.` }],
      };
    }
  );
}
