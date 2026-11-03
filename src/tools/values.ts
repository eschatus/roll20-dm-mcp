import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as roll20 from "../bridge/roll20.js";
import { rtGetTokenValues, rtSetTokenValue } from "../bridge/token-values.js";
import { json, resolveTokenOrThrow } from "./combatHelpers.js";

// ─────────────────────────────────────────────────────────────────────────────
// set_token_value / get_token_value — named values on a token, with NO game semantics (#259).
//
// Storage only: no markers, thresholds, death or layer moves. What a value means is the caller's
// business (#171). The HP tools keep their schemas as legacy shortcuts until the gem owns HP policy.
// ─────────────────────────────────────────────────────────────────────────────

// Leading letter keeps `__proto__` out of the map these keys index.
const keySchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/, "use letters, digits, _ . - and start with a letter");

const targetFields = {
  tokenId: z.string().optional().describe("Roll20 token ID — overrides characterName lookup."),
  characterName: z.string().optional().describe("Token/character name exactly as on the map."),
  pageId: z.string().optional().describe("Page holding the token — defaults to the player and initiative pages."),
};

// A name resolves on pageId when given: each page has its own copy of a token.
async function targetId(tokenId?: string, characterName?: string, pageId?: string): Promise<string> {
  if (tokenId) return tokenId;
  if (!characterName) throw new Error("Provide characterName or tokenId");
  const tokens = pageId
    ? await roll20.relayCommand<{ id: string; name: string }[]>({ action: "getTokens", pageId })
    : undefined;
  return resolveTokenOrThrow(characterName, tokens);
}

export function registerValueTools(server: McpServer): void {
  server.tool(
    "set_token_value",
    "Store a named value on a token with NO game semantics: no markers, thresholds, death or layer moves. value is any JSON (number, string, or a small object like {\"current\":3,\"max\":10}); value:null deletes the key. Stored in the token's GM-only notes, so players never see it and it travels with a copied token. The key \"hp\" is the PC HP block that update_token_hp uses: it must be {current,max}. For conditions use set_token_marker; for what shows on a bar use set_bar. Example: {\"characterName\":\"Adept\",\"key\":\"edge_spent\",\"value\":2}.",
    {
      ...targetFields,
      key: keySchema.describe("Value name, e.g. 'edge_spent'."),
      value: z.unknown().refine((v) => v !== undefined, "value is required; pass null to delete the key").describe("Any JSON value, or null to delete the key."),
    },
    async ({ tokenId, characterName, pageId, key, value }) => {
      const id = await targetId(tokenId, characterName, pageId);
      await rtSetTokenValue(id, key, value, pageId);
      return json({ ok: true, tokenId: id, key, deleted: value === null });
    }
  );

  server.tool(
    "get_token_value",
    "Read named values stored on a token with set_token_value. Pass key for one value, or omit it for all of them. A missing key is null, not an error. A PC's tracked HP appears as the key \"hp\". Example: {\"characterName\":\"Adept\",\"key\":\"edge_spent\"}.",
    {
      ...targetFields,
      key: keySchema.optional().describe("Value name. Omit for every value on the token."),
    },
    async ({ tokenId, characterName, pageId, key }) => {
      const id = await targetId(tokenId, characterName, pageId);
      const values = await rtGetTokenValues(id, pageId);
      if (key === undefined) return json({ tokenId: id, values });
      return json({ tokenId: id, key, value: Object.hasOwn(values, key) ? values[key] : null });
    }
  );
}
