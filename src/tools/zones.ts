import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as roll20 from "../bridge/roll20.js";
import { json } from "./combatHelpers.js";

// Map zone tools — named AoE/terrain areas drawn on the map. Part of the maps
// suite (map/wall/zone domain), but ALSO registered in the combat server because
// live play creates zones for fixed-area spells (Web, Cloudkill, Spirit Guardians)
// per skills/dm-rules.md. Shared, not duplicated: one register fn, two servers.
export function registerZoneTools(server: McpServer): void {
  server.tool(
    "create_zone",
    "Draw a named AoE zone on the map — difficult terrain, spell area (Web, Cloudkill, Spirit Guardians, etc.), or any persistent effect area. Circle or rect. Zones persist on the map and can be listed/cleared by name. Use centerTokenId to anchor to a token's current position.",
    {
      name: z.string().describe("Zone name, e.g. 'Web', 'Difficult Terrain', 'Spirit Guardians (Zeno)'"),
      shape: z.enum(["circle", "rect"]).default("circle"),
      centerTokenId: z.string().optional().describe("Anchor zone to this token's current position"),
      centerX: z.number().optional().describe("X center in page pixels (use if no centerTokenId)"),
      centerY: z.number().optional().describe("Y center in page pixels"),
      radiusFeet: z.number().default(15).describe("Radius in feet for circles; half-width/height for rects"),
      widthFeet: z.number().optional().describe("Width in feet for rect zones (defaults to radiusFeet*2)"),
      heightFeet: z.number().optional().describe("Height in feet for rect zones (defaults to radiusFeet*2)"),
      color: z.string().default("#aa00ff").describe("Fill/stroke color as #hex. Suggested: #aa00ff=purple, #00aa44=green, #aa5500=brown, #cc0000=red, #0055cc=blue"),
      pageId: z.string().optional(),
    },
    async ({ name, shape, centerTokenId, centerX, centerY, radiusFeet, widthFeet, heightFeet, color, pageId }) => {
      const activePage = pageId ?? (await roll20.getCurrentPageId());

      let cx = centerX ?? 0;
      let cy = centerY ?? 0;
      if (centerTokenId) {
        type TokenPos = { left: number; top: number };
        const t = await roll20.relayCommand<TokenPos | null>({ action: "getTokenById", tokenId: centerTokenId });
        if (!t) throw new Error(`Token not found: ${centerTokenId}`);
        cx = t.left;
        cy = t.top;
      }

      const result = await roll20.relayCommand({
        action: "createZone",
        pageId: activePage,
        name,
        shape,
        centerX: cx,
        centerY: cy,
        radiusFeet,
        widthFeet,
        heightFeet,
        color,
      });
      return json(result, false);
    }
  );

  server.tool(
    "clear_zone",
    "Remove a named zone from the map. Use name to find by zone name, or zoneId for the exact Roll20 path ID.",
    {
      name: z.string().optional().describe("Zone name as passed to create_zone"),
      zoneId: z.string().optional().describe("Roll20 path ID returned by create_zone"),
      pageId: z.string().optional(),
    },
    async ({ name, zoneId, pageId }) => {
      const activePage = pageId ?? (await roll20.getCurrentPageId());
      const result = await roll20.relayCommand({ action: "clearZone", name, zoneId, pageId: activePage });
      return json(result, false);
    }
  );

  server.tool(
    "list_zones",
    "List all active named zones on the current page — shows zone names, positions, and metadata.",
    { pageId: z.string().optional() },
    async ({ pageId }) => {
      const activePage = pageId ?? (await roll20.getCurrentPageId());
      const zones = await roll20.relayCommand({ action: "listZones", pageId: activePage });
      return json(zones);
    }
  );
}
