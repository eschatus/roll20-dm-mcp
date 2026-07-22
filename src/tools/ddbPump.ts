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
    "Bridge D&D Beyond dice rolls into Roll20 chat as a Beyond20 FAILOVER. Use when a player's Beyond20 is flaky/down so their DDB rolls aren't reaching the table. Subscribes (browserless) to the DDB game log over its WebSocket and posts each roll into Roll20 chat AS the character, MIRRORING the exact dice (never a fresh re-roll). By default it SKIPS rolls Beyond20 already delivered (data.__b20Override__), so it only fills the gaps — safe to arm table-wide (omit characterNames) or per-player without double-posting, even when a bridge flaps. Reads the ACTIVE campaign's DDB game unless gameId is given; writes to whatever Roll20 game the relay points at — so the active campaign should be the table's. Requires the postChat relay action (redeploy with `npm run release:mod` if rolls don't appear).",
    {
      characterNames: z.array(z.string()).optional().describe("DDB character names to relay, e.g. [\"Broo Zbaaner\"]. Omit to cover EVERY character (gap-fill the whole table — only their non-Beyond20 rolls post)."),
      gameId: z.string().optional().describe("D&D Beyond game/campaign id to read. Defaults to the active campaign's ddbCampaignId."),
      includeBeyond20: z.boolean().optional().describe("Default false. Leave false to skip rolls Beyond20 already bridged to Roll20 (the failover behavior). Set true ONLY to mirror EVERY roll regardless — will double-post anything Beyond20 also delivers."),
    },
    async ({ characterNames, gameId, includeBeyond20 }) => {
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
        skipBeyond20: includeBeyond20 !== true,
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
      const mode = includeBeyond20 ? "ALL rolls (incl. Beyond20 — may double-post)" : "gap-fill (skips rolls Beyond20 already delivered)";
      return text(`D&D Beyond roll pump ARMED — game ${game}, relaying: ${resolvedNote}. Mode: ${mode}. Rolls appear in Roll20 chat as the character. Stop with stop_ddb_roll_pump.`);
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
