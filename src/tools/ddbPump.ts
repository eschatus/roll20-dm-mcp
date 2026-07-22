import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as roll20 from "../bridge/roll20.js";
import * as campaigns from "../registry/campaigns.js";
import { rtGetCampaignCharacters } from "../bridge/ddb-rt.js";
import { DdbGameLogPump, renderRollForRoll20, type DdbGameLogMessage } from "../bridge/ddb-gamelog.js";
import { text } from "./combatHelpers.js";

// One pump per server process — a single WebSocket to the active campaign's DDB game log.
let pump: DdbGameLogPump | null = null;
let pumpInfo: { gameId: string; names: string[]; started: number; posted: number; lastError?: string } | null = null;

async function resolveEntityIds(gameId: string, names: string[]): Promise<{ ids: string[]; resolved: string[]; missing: string[] }> {
  const chars = await rtGetCampaignCharacters(gameId);       // [{ id, characterName }]
  const ids: string[] = [], resolved: string[] = [], missing: string[] = [];
  for (const n of names) {
    const hit = chars.find((c) => c.characterName?.toLowerCase().includes(n.toLowerCase()) || n.toLowerCase().includes((c.characterName ?? "").toLowerCase()));
    if (hit) { ids.push(String(hit.id)); resolved.push(`${n} → ${hit.characterName} (${hit.id})`); }
    else missing.push(n);
  }
  return { ids, resolved, missing };
}

export function registerDdbPumpTools(server: McpServer): void {
  server.tool(
    "start_ddb_roll_pump",
    "Pump a D&D Beyond character's live dice rolls into Roll20 chat. For an ORPHANED PC — one whose player rolls on D&D Beyond but has no Beyond20 bridge, so their rolls never reach the table. Subscribes (browserless) to the DDB game log over its WebSocket, filters to the named character(s), and posts each roll into Roll20 chat AS that character, MIRRORING the exact dice they rolled (never a fresh re-roll). Reads from the ACTIVE campaign's D&D Beyond game unless gameId is given; writes to whatever Roll20 game the relay is pointed at — so the active campaign should be the one at the table. Requires the postChat relay action (redeploy the Mod with `npm run release:mod` if rolls don't appear).",
    {
      characterNames: z.array(z.string()).optional().describe("DDB character names to relay, e.g. [\"Broo Zbaaner\"]. Omit to relay EVERY character's rolls in the game."),
      gameId: z.string().optional().describe("D&D Beyond game/campaign id to read. Defaults to the active campaign's ddbCampaignId."),
    },
    async ({ characterNames, gameId }) => {
      const active = campaigns.getActiveCampaign();
      const game = gameId || active.ddbCampaignId;
      if (!game || game === "0") return text(`Active campaign "${active.slug}" has no D&D Beyond game id — pass gameId, or switch to a DDB-linked campaign.`);

      if (pump) { pump.stop(); pump = null; }

      let entityIds: string[] | undefined;
      let resolvedNote = "all characters";
      if (characterNames?.length) {
        const { ids, resolved, missing } = await resolveEntityIds(game, characterNames);
        if (!ids.length) return text(`None of [${characterNames.join(", ")}] matched a character in DDB game ${game}. Check the names.`);
        entityIds = ids;
        resolvedNote = resolved.join("; ") + (missing.length ? ` · UNMATCHED: ${missing.join(", ")}` : "");
      }

      pumpInfo = { gameId: game, names: characterNames ?? [], started: Date.now(), posted: 0 };
      pump = new DdbGameLogPump({
        gameId: game,
        entityIds,
        onStatus: (s) => console.error(s),
        onRoll: async (m: DdbGameLogMessage) => {
          const { speakAs, message } = renderRollForRoll20(m);
          try {
            await roll20.relayCommand({ action: "postChat", speakAs, message });
            if (pumpInfo) pumpInfo.posted++;
          } catch (e) {
            if (pumpInfo) pumpInfo.lastError = (e as Error).message;
            console.error(`[ddb-pump] post failed: ${(e as Error).message}`);
          }
        },
      });
      await pump.start();
      return text(`D&D Beyond roll pump ARMED — game ${game}, relaying: ${resolvedNote}. Rolls will appear in Roll20 chat as the character. Stop with stop_ddb_roll_pump.`);
    }
  );

  server.tool(
    "stop_ddb_roll_pump",
    "Stop the D&D Beyond roll pump (disconnect the game-log WebSocket).",
    {},
    async () => {
      if (!pump) return text("No roll pump is running.");
      pump.stop(); pump = null;
      const posted = pumpInfo?.posted ?? 0;
      pumpInfo = null;
      return text(`Roll pump stopped. Relayed ${posted} roll(s) this session.`);
    }
  );

  server.tool(
    "ddb_roll_pump_status",
    "Report whether the D&D Beyond roll pump is running and how many rolls it has relayed.",
    {},
    async () => {
      if (!pump || !pumpInfo) return text("Roll pump: not running.");
      const mins = Math.round((Date.now() - pumpInfo.started) / 60000);
      return text(`Roll pump: RUNNING · game ${pumpInfo.gameId} · ${pumpInfo.names.length ? pumpInfo.names.join(", ") : "all characters"} · ${pumpInfo.posted} roll(s) relayed · up ${mins}m${pumpInfo.lastError ? ` · last error: ${pumpInfo.lastError}` : ""}`);
    }
  );
}
