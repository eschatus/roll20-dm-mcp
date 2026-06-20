import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as roll20 from "../bridge/roll20.js";

// Character-editing tools: modify top-level fields on an existing Roll20 character
// object (name, bio, avatar, controlledby, archived, inplayerjournals).
// The relay action (editCharacter in ai-relay.js) is GM-gated and stripUndef-guarded.
export function registerCharacterEditTools(server: McpServer): void {
  server.tool(
    "set_character_props",
    [
      "Edit top-level fields on an existing Roll20 character object.",
      "Supports: name, bio, avatar (Roll20 CDN url), controlledby (player ids or 'all'),",
      "archived (boolean), inplayerjournals (player ids or 'all' or '').",
      "Pass only the fields you want to change — unset fields are not touched.",
      "Returns the list of fields that were updated.",
    ].join(" "),
    {
      charId: z.string().describe("Roll20 character object id"),
      name: z.string().optional().describe("New character name"),
      bio: z.string().optional().describe("Player-visible biography HTML"),
      avatar: z.string().url().optional().describe("Roll20 CDN avatar URL"),
      controlledby: z
        .string()
        .optional()
        .describe("Comma-separated player ids, 'all', or '' for GM-only"),
      archived: z.boolean().optional().describe("Archive (hide) the character"),
      inplayerjournals: z
        .string()
        .optional()
        .describe("Comma-separated player ids, 'all', or '' for GM-only"),
    },
    async ({ charId, name, bio, avatar, controlledby, archived, inplayerjournals }) => {
      const result = await roll20.relayCommand<{ ok: boolean; updated: string[] }>({
        action: "editCharacter",
        charId,
        name,
        bio,
        avatar,
        controlledby,
        archived,
        inplayerjournals,
      });
      return {
        content: [
          {
            type: "text",
            text: `character ${charId} updated: [${result.updated.join(", ")}]`,
          },
        ],
      };
    }
  );
}
