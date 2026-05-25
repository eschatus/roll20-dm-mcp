import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as campaigns from "../registry/campaigns.js";

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
}
