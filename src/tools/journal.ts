import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as roll20 from "../bridge/roll20.js";
import { resolveConfinedImage } from "./maps.js";

// Journal tools: write Roll20 handouts, character (bestiary) stubs, and the
// journal folder tree (_journalfolder). Mirrors the relay actions defined in
// mod-scripts/ai-relay.js (createHandout / createCharacter / get+setJournalFolder)
// and the existing uploadArt flow in bridge/roll20.ts.
export function registerJournalTools(server: McpServer): void {
  server.tool(
    "upload_image",
    "Upload a local image file to the Roll20 art library and return its CDN URL (use for handout/character avatars).",
    {
      localPath: z.string(),
    },
    async ({ localPath }) => {
      // Confine to the asset dir + image allowlist + size cap (uploadArt would
      // otherwise hand any local file to the Roll20 art library).
      const { abs } = resolveConfinedImage(localPath);
      const url = await roll20.uploadArt(abs);
      return { content: [{ type: "text", text: url }] };
    }
  );

  server.tool(
    "create_handout",
    "Create a Roll20 journal handout (full page). notesHtml = player-visible body; gmNotesHtml = GM-only. Returns the handout id.",
    {
      name: z.string(),
      notesHtml: z.string().optional(),
      gmNotesHtml: z.string().optional(),
      sharedWithPlayers: z.boolean().optional(),
      avatarUrl: z.string().optional(),
    },
    async ({ name, notesHtml, gmNotesHtml, sharedWithPlayers, avatarUrl }) => {
      const result = await roll20.relayCommand<{ id: string }>({
        action: "createHandout",
        name,
        notes: notesHtml,
        gmnotes: gmNotesHtml,
        inplayerjournals: sharedWithPlayers ? "all" : "",
        avatar: avatarUrl,
      });
      return { content: [{ type: "text", text: `handout ${result.id} (${name})` }] };
    }
  );

  server.tool(
    "create_character_stub",
    "Create a Roll20 character entry (a draggable bestiary stub token). attributes = [{name,current,max?}] (e.g. bar1 hp). Returns the character id.",
    {
      name: z.string(),
      bio: z.string().optional(),
      gmNotes: z.string().optional(),
      avatarUrl: z.string().optional(),
      attributes: z
        .array(
          z.object({
            name: z.string(),
            current: z.union([z.string(), z.number()]).optional(),
            max: z.union([z.string(), z.number()]).optional(),
          })
        )
        .optional(),
    },
    async ({ name, bio, gmNotes, avatarUrl, attributes }) => {
      const result = await roll20.relayCommand<{ id: string }>({
        action: "createCharacter",
        name,
        bio,
        gmnotes: gmNotes,
        avatar: avatarUrl,
        attributes,
      });
      return { content: [{ type: "text", text: `character ${result.id} (${name})` }] };
    }
  );

  server.tool(
    "get_journal_folder",
    "Read the Roll20 campaign journal folder tree (_journalfolder) as JSON. Merge new ids in, then set_journal_folder.",
    {},
    async () => {
      const tree = await roll20.relayCommand<unknown>({ action: "getJournalFolder" });
      return { content: [{ type: "text", text: JSON.stringify(tree) }] };
    }
  );

  server.tool(
    "set_journal_folder",
    "Replace the Roll20 campaign journal folder tree (_journalfolder). Pass the COMPLETE merged tree (array) as json — this overwrites, so always get_journal_folder + merge first.",
    {
      json: z.any(),
    },
    async ({ json }) => {
      await roll20.relayCommand({ action: "setJournalFolder", json });
      return { content: [{ type: "text", text: "journal folder tree updated" }] };
    }
  );
}
