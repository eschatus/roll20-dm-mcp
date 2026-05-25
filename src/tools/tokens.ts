import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as ddb from "../bridge/dndbeyond.js";
import * as roll20 from "../bridge/roll20.js";
import * as registry from "../registry/characters.js";

export function registerTokenTools(server: McpServer): void {
  server.tool(
    "create_pc_token",
    "Create a Roll20 token for a D&D Beyond player character — links them in the registry",
    {
      ddbCharId: z.number().int().positive(),
      pageId: z.string().optional(),
      gridX: z.number().optional(),
      gridY: z.number().optional(),
    },
    async ({ ddbCharId, pageId, gridX = 1, gridY = 1 }) => {
      const char = await ddb.getCharacter(ddbCharId);
      const maxHp = ddb.getMaxHp(char);
      const currentHp = ddb.getCurrentHp(char);

      const activePage = pageId ?? (await roll20.getCurrentPageId());

      // Roll20 grid cells are 70px by default
      const CELL = 70;

      const result = await roll20.relayCommand<{ id: string }>({
        action: "createToken",
        pageId: activePage,
        imgsrc: char.avatarUrl ?? "",
        name: char.name,
        layer: "tokens",
        left: gridX * CELL,
        top: gridY * CELL,
        width: CELL,
        height: CELL,
        bar1_value: currentHp,
        bar1_max: maxHp,
      });

      registry.register(char.name, result.id, ddbCharId);

      return {
        content: [
          {
            type: "text",
            text: `Created token for ${char.name} (roll20Id: ${result.id}, ddbCharId: ${ddbCharId}) at grid (${gridX}, ${gridY}). HP: ${currentHp}/${maxHp}`,
          },
        ],
      };
    }
  );

  server.tool(
    "create_monster_token",
    "Create a Roll20 token for a monster from the D&D Beyond compendium",
    {
      monsterName: z.string(),
      pageId: z.string().optional(),
      gridX: z.number().optional(),
      gridY: z.number().optional(),
      customHp: z.number().int().positive().optional(),
    },
    async ({ monsterName, pageId, gridX = 1, gridY = 1, customHp }) => {
      const monster = await ddb.getMonster(monsterName);
      const hp = customHp ?? monster.averageHitPoints;

      const activePage = pageId ?? (await roll20.getCurrentPageId());
      const CELL = 70;

      const result = await roll20.relayCommand<{ id: string }>({
        action: "createToken",
        pageId: activePage,
        imgsrc: monster.largeAvatarUrl ?? "",
        name: monster.name,
        layer: "tokens",
        left: gridX * CELL,
        top: gridY * CELL,
        width: CELL,
        height: CELL,
        bar1_value: hp,
        bar1_max: hp,
      });

      return {
        content: [
          {
            type: "text",
            text: `Created monster token for ${monster.name} (roll20Id: ${result.id}) HP: ${hp}, AC: ${monster.armorClass}, CR: ${monster.challengeRating}`,
          },
        ],
      };
    }
  );

  server.tool(
    "create_npc_token",
    "Create a Roll20 token for a custom NPC with manual stats",
    {
      name: z.string(),
      hp: z.number().int().positive(),
      ac: z.number().int().positive().optional(),
      imageUrl: z.string().url().optional(),
      pageId: z.string().optional(),
      gridX: z.number().optional(),
      gridY: z.number().optional(),
    },
    async ({ name, hp, imageUrl, pageId, gridX = 1, gridY = 1 }) => {
      const activePage = pageId ?? (await roll20.getCurrentPageId());
      const CELL = 70;

      const result = await roll20.relayCommand<{ id: string }>({
        action: "createToken",
        pageId: activePage,
        imgsrc: imageUrl ?? "",
        name,
        layer: "tokens",
        left: gridX * CELL,
        top: gridY * CELL,
        width: CELL,
        height: CELL,
        bar1_value: hp,
        bar1_max: hp,
      });

      return {
        content: [
          {
            type: "text",
            text: `Created NPC token for ${name} (roll20Id: ${result.id}) HP: ${hp}`,
          },
        ],
      };
    }
  );
}
