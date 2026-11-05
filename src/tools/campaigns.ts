import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as campaigns from "../registry/campaigns.js";
import { resetRelayProbeForCampaignSwitch } from "../bridge/relay-version-check.js";

export function registerCampaignTools(server: McpServer): void {
  server.tool(
    "register_campaign",
    "Register a campaign by name with its Roll20 id.",
    {
      name: z.string().describe("Human-readable campaign name, e.g. 'Curse of Strahd'"),
      roll20CampaignId: z.string().describe("Roll20 campaign ID from the URL: app.roll20.net/campaigns/details/XXXXXX"),
      notes: z.string().optional().describe("Optional notes about this campaign"),
    },
    async ({ name, roll20CampaignId, notes }) => {
      const slug = campaigns.registerCampaign(name, roll20CampaignId, notes);
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
    "set_pc_hp_source",
    "Choose where the ACTIVE campaign keeps a true PC's HP. 'tracked' (the default) keeps it in a GM-only block on the token, for tables whose players' sheets live outside Roll20 (D&D Beyond with Beyond20, a companion app). 'sheet' is for tables that play on Roll20's own character sheets: update_token_hp, update_hp_many, resolve_aoe healing and revive_token then read and write that sheet field, reported as '(sheet)'. The token bar is never written either way; a bar linked to the sheet field follows it. NPCs and sidekicks stay on bar1. Saved per campaign.",
    {
      source: z.enum(["tracked", "sheet"]).describe("'sheet' = Roll20's character sheet holds PC HP; 'tracked' = the GM-only token block does."),
      attribute: z.string().min(1).optional().describe("Sheet field holding HP when source is 'sheet'. Default 'hp'. get_sheet_summary lists a Beacon sheet's names."),
    },
    async ({ source, attribute }) => {
      if (source === "tracked" && attribute) throw new Error("attribute only applies to source 'sheet'.");
      const field = source === "sheet" ? (attribute ?? "hp") : null;
      campaigns.setPcSheetHp(field);
      const name = campaigns.getActiveCampaign().name;
      return {
        content: [{
          type: "text",
          text: field
            ? `${name}: PC HP now lives on the character sheet ('${field}'). Tracked HP already on tokens is not copied across, and turn announcements keep showing a tracked value while its block remains on the token.`
            : `${name}: PC HP is tracked on the token again. Sheet values are not copied across.`,
        }],
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
                ...(c.notes ? { notes: c.notes } : {}),
                pcHpSource: c.pcSheetHp ? "sheet" : "tracked",
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
    "Switch the active campaign — all subsequent tool calls will use this campaign's Roll20 id",
    {
      slugOrName: z.string().describe("Campaign slug (e.g. 'curse-of-strahd') or partial name match"),
    },
    async ({ slugOrName }) => {
      const entry = campaigns.setActiveCampaign(slugOrName);
      // The relay version and the Mod Script Sandbox are BOTH per-campaign. Drop what we learned
      // about the campaign we just left so the next command re-probes, instead of transport_status
      // reporting the previous campaign's numbers as this one's.
      resetRelayProbeForCampaignSwitch();
      return {
        content: [
          {
            type: "text",
            text: `Active campaign set to "${entry.name}" (Roll20: ${entry.roll20CampaignId})`,
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
