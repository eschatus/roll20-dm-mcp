import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as ddb from "../bridge/dndbeyond.js";
import { getActiveCampaign } from "../registry/campaigns.js";

export function registerDdbTools(server: McpServer): void {
  server.tool(
    "ddb_get_character",
    "Fetch a character sheet from D&D Beyond by numeric ID",
    { ddbCharId: z.number().int().positive() },
    async ({ ddbCharId }) => {
      const char = await ddb.getCharacter(ddbCharId);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              id: char.id,
              name: char.name,
              currentHp: ddb.getCurrentHp(char),
              maxHp: ddb.getMaxHp(char),
              temporaryHitPoints: char.temporaryHitPoints,
              armorClass: char.armorClass,
              passivePerception: char.passivePerception,
              conditions: char.conditions.map((c) => c.id),
              avatarUrl: char.avatarUrl,
            }),
          },
        ],
      };
    }
  );

  server.tool(
    "ddb_list_campaign_characters",
    "List all player characters in the DDB campaign",
    { campaignId: z.string().optional() },
    async ({ campaignId }) => {
      const id = campaignId ?? getActiveCampaign().ddbCampaignId;
      const chars = await ddb.getCampaignCharacters(id);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(chars),
          },
        ],
      };
    }
  );

  server.tool(
    "ddb_list_campaigns",
    "List all DnD Beyond campaigns visible on the my-campaigns page, with IDs and character counts",
    {},
    async () => {
      const campaigns = await ddb.listCampaigns();
      return {
        content: [{ type: "text", text: JSON.stringify(campaigns, null, 2) }],
      };
    }
  );

  server.tool(
    "ddb_get_monster",
    "Get monster stats and art URL from the D&D Beyond compendium",
    { nameOrId: z.union([z.string(), z.number()]) },
    async ({ nameOrId }) => {
      const monster = await ddb.getMonster(nameOrId);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              id: monster.id,
              name: monster.name,
              averageHitPoints: monster.averageHitPoints,
              armorClass: monster.armorClass,
              challengeRating: monster.challengeRating,
              largeAvatarUrl: monster.largeAvatarUrl,
            }),
          },
        ],
      };
    }
  );
}
