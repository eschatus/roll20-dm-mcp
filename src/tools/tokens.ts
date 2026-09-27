import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as roll20 from "../bridge/roll20.js";
import * as registry from "../registry/characters.js";
import { text, type BarNumPermission } from "./combatHelpers.js";

// Token creation takes CALLER-SUPPLIED STATS (#171). These tools used to look their
// own stats up in the D&D Beyond compendium, which coupled the maps suite to the DDB
// bridge and silently missed on reskins, homebrew, and any non-compendium name. The
// caller now resolves stats however it likes — ddb-mcp's ddb_get_monster /
// ddb_get_party_snapshot, a module PDF, or straight from the DM — and passes them in.

// Roll20 grid cells are 70px by default.
const CELL = 70;

interface CreateTokenArgs {
  name: string;
  hp: number;
  maxHp?: number;
  imageUrl?: string;
  pageId?: string;
  gridX?: number;
  gridY?: number;
  controlledBy?: string;
  bar1NumPermission?: BarNumPermission;
}

// One implementation behind all three tools — they differ only in what they report
// and whether they touch the registry.
async function createTokenAt(a: CreateTokenArgs): Promise<{ id: string; max: number }> {
  const activePage = a.pageId ?? (await roll20.getCurrentPageId());
  const max = a.maxHp ?? a.hp;

  const result = await roll20.relayCommand<{ id: string }>({
    action: "createToken",
    pageId: activePage,
    imgsrc: a.imageUrl ?? "",
    name: a.name,
    layer: "tokens",
    left: (a.gridX ?? 1) * CELL,
    top: (a.gridY ?? 1) * CELL,
    width: CELL,
    height: CELL,
    bar1_value: a.hp,
    bar1_max: max,
  });

  // Neither `controlledby` nor `bar1_num_permission` is a createToken field in the relay,
  // so they're a follow-up write — deliberately here rather than in createObj's field list,
  // because a setTokenProps write works against EVERY deployed relay version and a new
  // creation field would be silently dropped by a campaign on a stale paste (#175).
  //
  // controlledby matters: HP/death routing keys off it (isPcToken), so a "PC" token created
  // without it routes as an NPC — its HP would go to bar1 instead of tracked state.
  // bar1_num_permission is written ONLY when the caller opts a token into showing its digits
  // to everyone (#204). Roll20's default ("") already limits the number to the token's editors
  // — GM + controllers — and an NPC token has no controllers, so players can't read it anyway.
  // Writing "hidden" by default would protect nothing and could hide the GM's own overlay.
  const followUp: Record<string, unknown> = {};
  if (a.controlledBy) followUp.controlledby = a.controlledBy;
  if (a.bar1NumPermission !== undefined) followUp.bar1_num_permission = a.bar1NumPermission;
  if (Object.keys(followUp).length > 0) {
    await roll20.relayCommand({ action: "setTokenProps", tokenId: result.id, props: followUp });
  }

  return { id: result.id, max };
}

export function registerTokenTools(server: McpServer): void {
  server.tool(
    "create_pc_token",
    "Create a Roll20 token for a player character from stats YOU supply, and register it. Resolve the stats first (e.g. ddb-mcp's ddb_get_party_snapshot, which carries authoritative max HP) — this tool performs no lookup of its own. Pass controlledBy with the player's Roll20 id so HP and death route as a PC; without it the token is treated as an NPC. ddbCharId is recorded for linkage only, never fetched.",
    {
      name: z.string().describe("Character name, exactly as it should read on the token."),
      hp: z.number().int().describe("Current HP → bar1."),
      maxHp: z.number().int().positive().optional().describe("Max HP → bar1_max. Defaults to hp."),
      imageUrl: z.string().optional().describe("Roll20-hosted avatar URL. Must be an uploaded Roll20 URL — external/thumb URLs are silently refused by createObj."),
      controlledBy: z.string().optional().describe("Roll20 player id (or 'all') to own the token. Sets controlledby, which is what makes PC HP/death routing apply."),
      ddbCharId: z.number().int().positive().optional().describe("D&D Beyond character id, stored in the registry for linkage. NOT used to look anything up."),
      pageId: z.string().optional(),
      gridX: z.number().optional(),
      gridY: z.number().optional(),
    },
    async ({ name, hp, maxHp, imageUrl, controlledBy, ddbCharId, pageId, gridX = 1, gridY = 1 }) => {
      // NOTE bar1_num_permission is deliberately NOT set here (#204). Roll20's default ("")
      // lets the token's editors — the GM and the controlling player — read the number, which is
      // what a PC wants, and Beyond20 owns that bar anyway. A DM who wants it otherwise sets
      // bar1_num_permission with set_token_props.
      const { id, max } = await createTokenAt({ name, hp, maxHp, imageUrl, controlledBy, pageId, gridX, gridY });
      // 0 = "no DDB link" (the registry's existing sentinel).
      registry.register(name, id, ddbCharId ?? 0);
      const routing = controlledBy
        ? "controlled by " + controlledBy + " → routes as a PC"
        : "no controlledBy → routes as an NPC (pass controlledBy to fix)";
      return text(`Created PC token for ${name} (roll20Id: ${id}${ddbCharId ? `, ddbCharId: ${ddbCharId}` : ""}) at grid (${gridX}, ${gridY}). HP: ${hp}/${max}. Registered; ${routing}.`);
    }
  );

  server.tool(
    "create_npc_token",
    "Create a Roll20 token for an NPC or monster from stats you supply. Use this for everything non-PC — improvised NPCs and compendium creatures alike; look the stats up yourself (ddb-mcp's ddb_get_monster, a module stat block) and pass them here. HP digits are editor-only by Roll20's own default (an NPC token has no controllers, so only the GM reads them) — this tool writes nothing to change that unless you pass showHpNumbersToPlayers:true, which opts the token into showing its HP digits to everyone.",
    {
      name: z.string().describe("Token name as it should read on the map, e.g. 'Goblin A'."),
      hp: z.number().int().positive().describe("HP → bar1 and bar1_max."),
      ac: z.number().int().positive().optional().describe("Armor class. REPORTED BACK ONLY — a bare token has no character sheet to hold AC (createToken does not set `represents`), so nothing is written to the token."),
      imageUrl: z.string().optional().describe("Roll20-hosted image URL. Must be an uploaded Roll20 URL — external/thumb URLs are silently refused by createObj."),
      showHpNumbersToPlayers: z.boolean().default(false).describe("true sets bar1_num_permission to 'everyone' so the whole table can read the HP digits. false (default) writes nothing and leaves Roll20's default in place: digits visible to the token's editors only — for an NPC, just the GM. Only set true when the table is meant to know an NPC's exact HP."),
      pageId: z.string().optional(),
      gridX: z.number().optional(),
      gridY: z.number().optional(),
    },
    async ({ name, hp, ac, imageUrl, showHpNumbersToPlayers, pageId, gridX = 1, gridY = 1 }) => {
      const { id } = await createTokenAt({
        name, hp, imageUrl, pageId, gridX, gridY,
        bar1NumPermission: showHpNumbersToPlayers ? "everyone" : undefined,
      });
      // `ac` used to be accepted and silently dropped. It still isn't written anywhere
      // (there's nowhere to put it), but say so rather than swallowing it.
      return text(`Created NPC token for ${name} (roll20Id: ${id}) HP: ${hp}${ac ? ` · AC ${ac} (not stored — no sheet on a bare token)` : ""} · HP numbers ${showHpNumbersToPlayers ? "visible to everyone" : "editor-only (Roll20 default)"}`);
    }
  );

  server.tool(
    "create_monster_token",
    "Create a Roll20 token for a monster from stats you supply. IDENTICAL to create_npc_token now that the D&D Beyond compendium lookup has moved out of this server (#171) — kept so existing callers keep working. Prefer create_npc_token for new code.",
    {
      monsterName: z.string().describe("Monster name as it should read on the token."),
      hp: z.number().int().positive().describe("HP → bar1 and bar1_max. Look it up yourself (e.g. ddb_get_monster's averageHitPoints)."),
      ac: z.number().int().positive().optional().describe("Armor class. Reported back only — nothing to write it to on a bare token."),
      cr: z.string().optional().describe("Challenge rating, reported back only."),
      imageUrl: z.string().optional().describe("Roll20-hosted image URL."),
      showHpNumbersToPlayers: z.boolean().default(false).describe("true sets bar1_num_permission to 'everyone' so the table can read the HP digits; false (default) writes nothing — see create_npc_token."),
      pageId: z.string().optional(),
      gridX: z.number().optional(),
      gridY: z.number().optional(),
    },
    async ({ monsterName, hp, ac, cr, imageUrl, showHpNumbersToPlayers, pageId, gridX = 1, gridY = 1 }) => {
      const { id } = await createTokenAt({
        name: monsterName, hp, imageUrl, pageId, gridX, gridY,
        bar1NumPermission: showHpNumbersToPlayers ? "everyone" : undefined,
      });
      const extras = [ac ? `AC ${ac}` : "", cr ? `CR ${cr}` : ""].filter(Boolean).join(", ");
      return text(`Created monster token for ${monsterName} (roll20Id: ${id}) HP: ${hp}${extras ? ` · ${extras} (reported only — not stored)` : ""} · HP numbers ${showHpNumbersToPlayers ? "visible to everyone" : "editor-only (Roll20 default)"}`);
    }
  );
}
