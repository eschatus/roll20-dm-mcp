import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as ctx from "../registry/campaignContext.js";
import { getActiveCampaign } from "../registry/campaigns.js";

// Shared campaign CONTEXT tools — vocab (STT biasing), spoken-alias nicknames, and DM notes.
// Backed by data/campaign-context.json, the same store the voice-HUD reads/writes, so edits
// here are visible to the HUD's transcription + agent and vice-versa. All default to the
// active campaign's slug; pass slug to target another.

function resolveSlug(slug?: string): string {
  if (slug && slug.trim()) return slug.trim();
  return getActiveCampaign().slug;
}

export function registerCampaignContextTools(server: McpServer): void {
  server.tool(
    "get_campaign_context",
    "Read the shared per-campaign context: proper-noun vocab (speech-to-text biasing), spoken-alias nicknames (say → canonical name), and durable DM notes. Shared with the voice-HUD. Defaults to the active campaign.",
    { slug: z.string().optional().describe("Campaign slug; defaults to the active campaign") },
    async ({ slug }) => {
      const s = resolveSlug(slug);
      return { content: [{ type: "text", text: JSON.stringify({ slug: s, ...ctx.getContext(s) }, null, 2) }] };
    }
  );

  server.tool(
    "add_vocab",
    "Add a proper noun to the campaign's shared vocab (used to bias the voice-HUD's speech-to-text so names like 'Calisandre' or 'Rahadin' stop getting mangled). De-duplicated. Defaults to the active campaign.",
    {
      term: z.string().describe("The proper noun / phrase, e.g. 'Calisandre Gravebloom'"),
      slug: z.string().optional(),
    },
    async ({ term, slug }) => {
      const s = resolveSlug(slug);
      const c = ctx.addVocab(s, term);
      return { content: [{ type: "text", text: `Added "${term}" to ${s} vocab (${c.vocab.length} terms).` }] };
    }
  );

  server.tool(
    "remove_vocab",
    "Remove a proper noun from the campaign's shared vocab. Defaults to the active campaign.",
    { term: z.string(), slug: z.string().optional() },
    async ({ term, slug }) => {
      const s = resolveSlug(slug);
      const c = ctx.removeVocab(s, term);
      return { content: [{ type: "text", text: `Removed "${term}" from ${s} vocab (${c.vocab.length} terms).` }] };
    }
  );

  server.tool(
    "add_nickname",
    "Add or update a spoken-alias nickname for the campaign (e.g. 'Z' → 'Zeno', 'the big guy' → 'Berserker the Lurking'). The voice agent uses these to resolve what the DM says to a canonical token/character name. Re-using a nickname updates its target. Defaults to the active campaign.",
    {
      nickname: z.string().describe("What the DM says, e.g. 'Z'"),
      target: z.string().describe("Canonical token/character name it resolves to, e.g. 'Zeno'"),
      slug: z.string().optional(),
    },
    async ({ nickname, target, slug }) => {
      const s = resolveSlug(slug);
      ctx.addNickname(s, nickname, target);
      return { content: [{ type: "text", text: `Alias set for ${s}: "${nickname}" → "${target}".` }] };
    }
  );

  server.tool(
    "remove_nickname",
    "Remove a spoken-alias nickname from the campaign. Defaults to the active campaign.",
    { nickname: z.string(), slug: z.string().optional() },
    async ({ nickname, slug }) => {
      const s = resolveSlug(slug);
      ctx.removeNickname(s, nickname);
      return { content: [{ type: "text", text: `Removed alias "${nickname}" from ${s}.` }] };
    }
  );

  server.tool(
    "set_campaign_notes",
    "Set the campaign's durable DM notes (free text, shown to the voice agent as party/campaign context). Replaces existing notes. Defaults to the active campaign.",
    { notes: z.string(), slug: z.string().optional() },
    async ({ notes, slug }) => {
      const s = resolveSlug(slug);
      ctx.setNotes(s, notes);
      return { content: [{ type: "text", text: `Notes updated for ${s} (${notes.length} chars).` }] };
    }
  );
}
