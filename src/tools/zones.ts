import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as roll20 from "../bridge/roll20.js";
import { json } from "./combatHelpers.js";

// Map zone tools — named AoE/terrain areas drawn on the map. Part of the maps
// suite (map/wall/zone domain), but ALSO registered in the combat server because
// live play creates zones for fixed-area spells (Web, Cloudkill, Spirit Guardians)
// per skills/dm-rules.md. Shared, not duplicated: one register fn, two servers.

// ── Terrain/duration model (issue #134) ──────────────────────────────────────
// Zones can now carry semantic metadata beyond shape/color/label:
//   terrain  — "difficult" (movement cost) or "damaging" (hazard, e.g. fire)
//   duration — how long the zone persists:
//     instant       — resolves immediately, caller clears it right after
//     rounds(n)     — expires at a round boundary; created mid-round R with n=1
//                     lasts the REMAINDER of round R and expires when round R+1
//                     starts. Expiry is processed explicitly via
//                     process_round_end_zones (not an automatic hook), which
//                     deletes expired zones and returns what expired so the
//                     agent can fold it into round-end narration.
//     concentration — tied to a caster; the concentration-break cascade itself
//                     is issue #135 — here we only STORE the linkage (caster).
export const ZONE_TERRAINS = ["difficult", "damaging"] as const;
export type ZoneTerrain = (typeof ZONE_TERRAINS)[number];

export const zoneDurationSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("instant") }),
  z.object({ type: z.literal("rounds"), n: z.number().int().positive() }),
  z.object({ type: z.literal("concentration"), caster: z.string() }),
]);
export type ZoneDuration = z.infer<typeof zoneDurationSchema>;

export interface ZoneMeta {
  zone?: boolean;
  name: string;
  shape: "circle" | "rect";
  centerX: number;
  centerY: number;
  radiusFeet: number;
  color: string;
  terrain?: ZoneTerrain | null;
  duration?: ZoneDuration & { createdRound?: number };
}

export interface ExpiredZone {
  id: string;
  name: string;
  meta: ZoneMeta;
}

// Default fill/stroke color by terrain when the caller doesn't pass an explicit
// one — project convention: difficult terrain green, damaging (hazard) red.
// Callers can always override with an explicit `color`; this never hard-fails.
export function defaultZoneColor(terrain?: ZoneTerrain | null): string {
  if (terrain === "damaging") return "#cc0000";
  if (terrain === "difficult") return "#00aa44";
  return "#aa00ff";
}

// ── Substance × trigger transition table ──────────────────────────────────────
// A handful of common battlefield interactions turn one zone into another
// (Web + fire → burns away taking damage; Grease + fire → ignites and burns for
// a round). This is DATA only — transitions execute as delete-then-create using
// clear_zone + create_zone (there is deliberately no modify_zone tool). Keyed by
// lowercased substance and trigger.
export interface ZoneTransitionSpec {
  /** Human label for the replacement zone, e.g. "Web (burning)". */
  namePrefix: string;
  terrain: ZoneTerrain;
  duration: ZoneDuration;
  color?: string;
}

export const ZONE_TRANSITIONS: Record<string, Record<string, ZoneTransitionSpec>> = {
  web: {
    fire: {
      namePrefix: "Web (burning)",
      terrain: "damaging",
      duration: { type: "instant" },
    },
  },
  grease: {
    fire: {
      namePrefix: "Grease Fire",
      terrain: "damaging",
      duration: { type: "rounds", n: 1 },
    },
  },
};

/** Look up the replacement zone spec for a substance zone hit by a trigger (e.g. "web","fire"). */
export function lookupZoneTransition(substance: string, trigger: string): ZoneTransitionSpec | undefined {
  return ZONE_TRANSITIONS[substance.toLowerCase()]?.[trigger.toLowerCase()];
}

export function registerZoneTools(server: McpServer): void {
  server.tool(
    "create_zone",
    "Draw a named AoE zone on the map — difficult terrain, spell area (Web, Cloudkill, Spirit Guardians, etc.), or any persistent effect area. Circle or rect. Zones persist on the map and can be listed/cleared by name. Use centerTokenId to anchor to a token's current position. Optionally tag with terrain (difficult/damaging) and duration (instant/rounds(n)/concentration) — rounds(n) zones expire at a round boundary via process_round_end_zones, not automatically.",
    {
      name: z.string().describe("Zone name, e.g. 'Web', 'Difficult Terrain', 'Spirit Guardians (Zeno)'"),
      shape: z.enum(["circle", "rect"]).default("circle"),
      centerTokenId: z.string().optional().describe("Anchor zone to this token's current position"),
      centerX: z.number().optional().describe("X center in page pixels (use if no centerTokenId)"),
      centerY: z.number().optional().describe("Y center in page pixels"),
      radiusFeet: z.number().default(15).describe("Radius in feet for circles; half-width/height for rects"),
      widthFeet: z.number().optional().describe("Width in feet for rect zones (defaults to radiusFeet*2)"),
      heightFeet: z.number().optional().describe("Height in feet for rect zones (defaults to radiusFeet*2)"),
      color: z
        .string()
        .optional()
        .describe(
          "Fill/stroke color as #hex. If omitted, defaults from terrain (difficult=green #00aa44, damaging=red #cc0000) or #aa00ff with no terrain."
        ),
      terrain: z.enum(ZONE_TERRAINS).optional().describe("difficult = movement cost, damaging = hazard (e.g. fire)"),
      duration: zoneDurationSchema
        .optional()
        .describe(
          "{type:'instant'} | {type:'rounds', n} | {type:'concentration', caster}. caster is a token id/name — just the linkage; the break cascade is a separate concern. Defaults to instant."
        ),
      pageId: z.string().optional(),
    },
    async ({ name, shape, centerTokenId, centerX, centerY, radiusFeet, widthFeet, heightFeet, color, terrain, duration, pageId }) => {
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

      const resolvedColor = color ?? defaultZoneColor(terrain);

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
        color: resolvedColor,
        terrain: terrain ?? null,
        duration: duration ?? { type: "instant" },
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
    "List all active named zones on the current page — shows zone names, positions, and metadata (terrain, duration).",
    { pageId: z.string().optional() },
    async ({ pageId }) => {
      const activePage = pageId ?? (await roll20.getCurrentPageId());
      const zones = await roll20.relayCommand({ action: "listZones", pageId: activePage });
      return json(zones);
    }
  );

  server.tool(
    "process_round_end_zones",
    "Expire rounds(n)-duration zones at a round boundary. Call this whenever a new round starts (round rollover). Deletes any zone whose rounds duration has elapsed and RETURNS the list of what expired, so the agent can fold it into round-end countdown narration (e.g. 'the grease fire burns out'). Zones with instant or concentration duration are untouched here.",
    {
      currentRound: z.number().optional().describe("Round number that just started. Defaults to the relay's own turn-hook round counter if omitted."),
      pageId: z.string().optional().describe("Limit to one page's zones; omit to check all pages."),
    },
    async ({ currentRound, pageId }) => {
      const result = await roll20.relayCommand({ action: "processRoundEndZones", currentRound, pageId });
      return json(result, false);
    }
  );
}
