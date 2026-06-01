import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as registry from "../registry/characters.js";
import * as ddb from "../bridge/dndbeyond.js";
import * as roll20 from "../bridge/roll20.js";

// Roll20 status marker names for D&D 5e conditions.
// Roll20 uses short marker strings; we map from DDB/natural-language condition names.
const CONDITION_TO_MARKER: Record<string, string> = {
  dead:          "Unconscious::4444317",
  unconscious:   "Unconscious::4444317",
  wounded:       "Wounded::4444333",
  poisoned:      "Poisoned::4444329",
  blinded:       "Blinded::4444318",
  charmed:       "Charmed::4444320",
  deafened:      "Deafened::4444321",
  frightened:    "Feared::4444323",
  grappled:      "Grappled::4444314",
  incapacitated: "Incapacitated::4444325",
  invisible:     "Invisible::4444344",
  paralyzed:     "Paralyzed::4444327",
  petrified:     "Petrified::4444328",
  prone:         "Prone::4444315",
  restrained:    "Restrained::4444316",
  stunned:       "Stunned::4444331",
  exhaustion:    "Exhausted::4444322",
};

function toRoll20Marker(condition: string): string {
  return CONDITION_TO_MARKER[condition.toLowerCase()] ?? condition.toLowerCase();
}

export function registerCombatTools(server: McpServer): void {
  server.tool(
    "apply_damage",
    "Apply damage (and optional conditions) to a character — syncs both Roll20 and D&D Beyond",
    {
      characterName: z.string(),
      damage: z.number().int().min(0),
      conditions: z.array(z.string()).optional(),
    },
    async ({ characterName, damage, conditions = [] }) => {
      const entry = registry.lookup(characterName);
      if (!entry) throw new Error(`Character not registered: ${characterName}. Use create_pc_token first.`);

      const { roll20TokenId, ddbCharId } = entry;

      // Fetch current DDB HP to compute new value
      const char = await ddb.getCharacter(ddbCharId);
      const maxHp = ddb.getMaxHp(char);
      const currentRemovedHp = char.removedHitPoints;
      const newRemovedHp = Math.min(currentRemovedHp + damage, maxHp);
      const currentHp = maxHp - newRemovedHp;

      const results = await Promise.allSettled([
        // Roll20: update token bar and status markers
        (async () => {
          await roll20.relayCommand({ action: "setTokenBar", tokenId: roll20TokenId, value: currentHp, max: maxHp });
          for (const condition of conditions) {
            await roll20.relayCommand({
              action: "setStatusMarker",
              tokenId: roll20TokenId,
              marker: toRoll20Marker(condition),
              active: true,
            });
          }
        })(),
        // DDB: patch HP and apply conditions
        (async () => {
          await ddb.patchCharacter(ddbCharId, { removedHitPoints: newRemovedHp });
          for (const condition of conditions) {
            await ddb.applyCondition(ddbCharId, condition);
          }
        })(),
      ]);

      const roll20Updated = results[0].status === "fulfilled";
      const ddbUpdated = results[1].status === "fulfilled";
      const errors = results
        .filter((r) => r.status === "rejected")
        .map((r) => (r as PromiseRejectedResult).reason?.message ?? String((r as PromiseRejectedResult).reason));

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              character: characterName,
              damageTaken: damage,
              newHp: currentHp,
              maxHp,
              conditionsApplied: conditions,
              roll20Updated,
              ddbUpdated,
              ...(errors.length ? { errors } : {}),
            }),
          },
        ],
      };
    }
  );

  server.tool(
    "heal_character",
    "Heal a character by amount — syncs both Roll20 and D&D Beyond",
    {
      characterName: z.string(),
      amount: z.number().int().min(0),
    },
    async ({ characterName, amount }) => {
      const entry = registry.lookup(characterName);
      if (!entry) throw new Error(`Character not registered: ${characterName}`);

      const { roll20TokenId, ddbCharId } = entry;

      const char = await ddb.getCharacter(ddbCharId);
      const maxHp = ddb.getMaxHp(char);
      const newRemovedHp = Math.max(char.removedHitPoints - amount, 0);
      const newHp = maxHp - newRemovedHp;

      await Promise.all([
        roll20.relayCommand({ action: "setTokenBar", tokenId: roll20TokenId, value: newHp, max: maxHp }),
        ddb.patchCharacter(ddbCharId, { removedHitPoints: newRemovedHp }),
      ]);

      return {
        content: [
          {
            type: "text",
            text: `${characterName} healed ${amount} HP → now at ${newHp}/${maxHp}`,
          },
        ],
      };
    }
  );

  server.tool(
    "get_token_markers",
    "List all custom token markers in the Roll20 campaign with their IDs and tags — use this to find the correct name::id format for set_token_marker",
    {},
    async () => {
      const markers = await roll20.relayCommand<{ id: number; name: string; tag: string }[]>({ action: "getTokenMarkers" });
      return { content: [{ type: "text", text: JSON.stringify(markers, null, 2) }] };
    }
  );

  server.tool(
    "set_token_marker",
    "Add or remove a status marker (sticker) on a Roll20 token by exact marker name. Use characterName to look up the token, or tokenId directly.",
    {
      marker: z.string().describe("Exact Roll20 marker name, e.g. 'Charmed', 'pink', 'dead'"),
      active: z.boolean().describe("true to add the marker, false to remove it"),
      characterName: z.string().optional(),
      tokenId: z.string().optional().describe("Roll20 token ID — overrides characterName lookup"),
    },
    async ({ marker, active, characterName, tokenId }) => {
      let resolvedTokenId = tokenId;
      if (!resolvedTokenId) {
        if (!characterName) throw new Error("Provide characterName or tokenId");
        const entry = registry.lookup(characterName);
        if (!entry) throw new Error(`Character not registered: ${characterName}`);
        resolvedTokenId = entry.roll20TokenId;
      }
      await roll20.relayCommand({ action: "setStatusMarker", tokenId: resolvedTokenId, marker, active });
      return { content: [{ type: "text", text: `Marker '${marker}' ${active ? "added to" : "removed from"} token ${resolvedTokenId}` }] };
    }
  );

  server.tool(
    "list_tokens",
    "List all tokens on the current (or specified) page with their name, layer, controlledby, and represents fields. Useful for diagnosing which tokens are present before combat.",
    {
      pageId: z.string().optional().describe("Page to inspect. Defaults to the current player page."),
    },
    async ({ pageId }) => {
      const activePage = pageId ?? (await roll20.getCurrentPageId());
      const tokens = await roll20.relayCommand<{ id: string; name: string; layer: string; controlledby: string; represents: string; bar1_value: number; bar1_max: number; statusmarkers: string }[]>({
        action: "getTokens",
        pageId: activePage,
      });
      return {
        content: [{
          type: "text",
          text: JSON.stringify(tokens.map((t) => ({
            id: t.id,
            name: t.name,
            layer: t.layer,
            controlledby: t.controlledby,
            represents: t.represents,
            hp: t.bar1_max ? `${t.bar1_value}/${t.bar1_max}` : null,
            statusmarkers: t.statusmarkers || "",
          })), null, 2),
        }],
      };
    }
  );

  server.tool(
    "get_selection",
    "Read the tokens the GM currently has selected in the Roll20 editor, resolving each to its name and linked character. Use this to capture a roster from the tabletop — e.g. select the party (or a group of NPCs) and call this to learn who they are. Roll20 only exposes the selection on the command that triggers it, so this reflects whatever is selected at the moment of the call.",
    {},
    async () => {
      const selection = await roll20.relayCommand<{
        id: string; name: string; represents: string; characterName: string;
        left: number; top: number; width: number; height: number;
        bar1_value: number; bar1_max: number; statusmarkers: string;
        layer: string; controlledby: string;
      }[]>({ action: "getSelection" });
      return {
        content: [{
          type: "text",
          text: JSON.stringify(selection, null, 2),
        }],
      };
    }
  );

  server.tool(
    "roll_dice",
    "Roll one or more dice formulas using Roll20's real in-game dice engine. Results appear in Roll20 chat and are returned here. Use for saving throws, ability checks, attack rolls, damage, or any other roll where the result needs to be visible to players.",
    {
      rolls: z.array(z.object({
        label: z.string().describe("Who or what is rolling, e.g. 'Goblin — DEX save', 'Strahd — Attack'"),
        formula: z.string().describe("Roll20 dice formula, e.g. '1d20+5', '2d8+3', '1d20'"),
      })).min(1),
      speakAs: z.string().optional().describe("Name shown in chat as the roller. Default: 'GM-AI-Bridge'"),
      silent: z.boolean().default(false).describe("If true, roll is hidden from chat log (noarchive). Default false — rolls are visible."),
    },
    async ({ rolls, speakAs, silent }) => {
      const results = await roll20.relayCommand<{ label: string; formula: string; total: number; dice: number[]; error?: string }[]>({
        action: "rollFormulas",
        items: rolls,
        speakAs: speakAs ?? "GM-AI-Bridge",
        silent,
      });
      const lines = results.map((r) =>
        r.error
          ? `${r.label}: ERROR — ${r.error}`
          : `${r.label}: [${r.dice.join(", ")}] = **${r.total}**`
      );
      return {
        content: [{ type: "text", text: lines.join("\n") + "\n\n" + JSON.stringify(results) }],
      };
    }
  );

  server.tool(
    "batch_exec",
    "Execute multiple Roll20 operations in a single relay round-trip — eliminates per-call overhead for bulk combat updates. Use this instead of separate calls when applying damage/conditions to multiple tokens at once. Supported actions: setTokenBar (HP), setTokenProps (aura/tint/name), toggleCondition (merge-add/remove one condition), syncConditionsToToken (replace all conditions), getTokenById (read token state), setTurnOrder.",
    {
      ops: z.array(z.object({
        id: z.string().optional().describe("Optional label returned with the result for tracking which op is which"),
        action: z.enum(["setTokenBar", "setTokenProps", "toggleCondition", "syncConditionsToToken", "getTokenById", "setTurnOrder"])
          .describe("Relay action to execute"),
        args: z.record(z.string(), z.unknown()).describe("Arguments for the action — same fields as the individual relay action"),
      })).min(1).max(50).describe("Operations to run. All execute in order; failures are per-op and don't abort the batch."),
    },
    async ({ ops }) => {
      type BatchResult = { id: string | number; ok: boolean; data?: unknown; error?: string };
      const results = await roll20.relayCommand<BatchResult[]>({ action: "batchExec", ops });
      const failed = results.filter((r) => !r.ok);
      const lines = results.map((r) =>
        r.ok ? `✓ ${r.id}` : `✗ ${r.id}: ${r.error}`
      );
      const summary = `${results.length - failed.length}/${results.length} ops succeeded`;
      return {
        content: [{ type: "text", text: `${summary}\n${lines.join("\n")}\n\n${JSON.stringify(results)}` }],
      };
    }
  );

  server.tool(
    "send_narration",
    "Send styled narrative text to Roll20 chat, visible to all players. Use to describe action outcomes, atmospheric moments, or dramatic events. Styles: 'narration' (italic amber, default — for description/atmosphere), 'combat' (bold red — for action outcomes and hits), 'dramatic' (bold gold centered — for climactic moments), 'ambient' (italic green — for environmental/sensory details).",
    {
      text: z.string().describe("The narrative text to display. HTML is supported for emphasis (<em>, <strong>, <br>)."),
      style: z.enum(["narration", "combat", "dramatic", "ambient"]).default("narration"),
      speakAs: z.string().optional().describe("Speaker name shown in chat. Default: 'The Dark Powers'"),
    },
    async ({ text, style, speakAs }) => {
      await roll20.relayCommand<{ ok: boolean }>({
        action: "sendNarration",
        text,
        style,
        speakAs: speakAs ?? "The Dark Powers",
      });
      return {
        content: [{ type: "text", text: `Narration sent (style: ${style})` }],
      };
    }
  );

  server.tool(
    "roll_initiative",
    "Roll initiative for tokens on the current (or specified) page and load results into Roll20's turn order tracker. Use flatInit to place matched tokens at a fixed value instead of rolling. Use nameFilter to target a subset by name (e.g. 'goblin').",
    {
      pageId: z.string().optional().describe("Page to roll for. Defaults to the current player page."),
      npcOnly: z.boolean().default(true).describe("If true, skip tokens whose controlledby field contains a player ID (i.e. PC tokens)."),
      clearFirst: z.boolean().default(false).describe("Wipe the existing turn order before adding rolls. Set true at combat start."),
      flatInit: z.number().int().optional().describe("If set, place all matched tokens at this fixed initiative value instead of rolling."),
      nameFilter: z.string().optional().describe("Case-insensitive substring filter on token names. E.g. 'goblin' matches 'Goblin 1', 'Goblin Archer', etc."),
      publicRoll: z.boolean().default(false).describe("If true, tokens with a linked character sheet get a public chat announcement of their roll result (name, d20, bonus, total)."),
    },
    async ({ pageId, npcOnly, clearFirst, flatInit, nameFilter, publicRoll }) => {
      const activePage = pageId ?? (await roll20.getCurrentPageId());

      const tokens = await roll20.relayCommand<{ id: string; name: string; layer: string; controlledby: string }[]>({
        action: "getTokens",
        pageId: activePage,
      });

      const TOKEN_LAYERS = new Set(["tokens", "objects"]);
      const needle = nameFilter?.toLowerCase();
      const combatants = tokens.filter((t) => {
        if (!TOKEN_LAYERS.has(t.layer)) return false;
        if (npcOnly && t.controlledby && t.controlledby.trim() !== "") return false;
        if (needle && !t.name.toLowerCase().includes(needle)) return false;
        return true;
      });

      if (combatants.length === 0) {
        const layers = [...new Set(tokens.map((t) => t.layer))];
        return { content: [{ type: "text", text: `No tokens found on token layer. All graphic layers on this page: [${layers.join(", ")}]. Try list_tokens for full details.` }] };
      }

      // Roll20 turn order entry format: {id, pr (string), custom, _pageid}
      // _pageid is required — without it Roll20's tracker shows "no tokens on this stage"
      type TurnEntry = { id: string; pr: string; custom: string; _pageid: string };

      let newEntries: TurnEntry[];
      let lines: string[];

      if (flatInit !== undefined) {
        newEntries = combatants.map((t) => ({ id: t.id, pr: String(flatInit), custom: "", _pageid: activePage }));
        lines = combatants.map((t) => `${t.name}: ${flatInit}`);
      } else {
        const rolls = await roll20.relayCommand<{ tokenId: string; name: string; d20: number; initBonus: number; total: number }[]>({
          action: "rollInitiativeForTokens",
          tokenIds: combatants.map((t) => t.id),
          rollPublic: publicRoll,
        });
        rolls.sort((a, b) => b.total - a.total);
        newEntries = rolls.map((r) => ({ id: r.tokenId, pr: String(r.total), custom: "", _pageid: activePage }));
        lines = rolls.map((r) => `${r.name}: ${r.d20}${r.initBonus >= 0 ? "+" : ""}${r.initBonus} = **${r.total}**`);
      }

      let existing: TurnEntry[] = [];
      if (!clearFirst) {
        existing = await roll20.relayCommand<TurnEntry[]>({ action: "getTurnOrder" });
        const newIds = new Set(newEntries.map((e) => e.id));
        existing = existing.filter((e) => !newIds.has(e.id));
      }

      const finalOrder = [...existing, ...newEntries].sort((a, b) => Number(b.pr) - Number(a.pr));
      await roll20.relayCommand({ action: "setTurnOrder", entries: finalOrder });
      await roll20.relayCommand({ action: "setTurnHook", enabled: true, reset: true });

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            rolledFor: newEntries.length,
            results: lines,
            turnOrder: finalOrder.map((e) => ({ id: e.id, pr: e.pr })),
          }),
        }],
      };
    }
  );

  server.tool(
    "debug_turn_order",
    "Read the raw Campaign.turnorder string directly from the Roll20 browser page (bypasses relay). Use this to see the exact format Roll20 uses internally.",
    {},
    async () => {
      const raw = await roll20.evaluate(() => {
        const camp = (window as any).Campaign;
        return camp ? camp.get("turnorder") : "Campaign not found";
      });
      return { content: [{ type: "text", text: String(raw) }] };
    }
  );

  server.tool(
    "get_turn_order",
    "Return the current Roll20 initiative turn order with token names resolved.",
    {},
    async () => {
      const pageId = await roll20.getCurrentPageId();
      const [entries, tokens] = await Promise.all([
        roll20.relayCommand<{ id: string; pr: number; custom: string }[]>({ action: "getTurnOrder" }),
        roll20.relayCommand<{ id: string; name: string }[]>({ action: "getTokens", pageId }),
      ]);
      const nameMap = new Map(tokens.map((t) => [t.id, t.name]));
      const resolved = entries.map((e, i) => ({
        position: i + 1,
        name: e.id ? (nameMap.get(e.id) ?? e.custom ?? e.id) : (e.custom || "?"),
        initiative: e.pr,
      }));
      return { content: [{ type: "text", text: JSON.stringify(resolved, null, 2) }] };
    }
  );

  server.tool(
    "clear_turn_order",
    "Wipe Roll20's initiative turn order (use between encounters).",
    {},
    async () => {
      await roll20.relayCommand({ action: "setTurnOrder", entries: [] });
      return { content: [{ type: "text", text: "Turn order cleared." }] };
    }
  );

  server.tool(
    "advance_turn",
    "Advance to the next combatant in Roll20's initiative tracker.",
    {},
    async () => {
      const result = await roll20.relayCommand<{ ok: boolean; current?: { id: string; pr: number; name: string }; note?: string }>({
        action: "advanceTurn",
      });
      if (!result.ok) return { content: [{ type: "text", text: result.note ?? "Turn order is empty." }] };
      return {
        content: [{
          type: "text",
          text: `Now up: **${result.current!.name}** (initiative ${result.current!.pr})`,
        }],
      };
    }
  );

  server.tool(
    "get_character_attribute",
    "Read a single attribute from a Roll20 character sheet by name. Use charSheetId to target a sheet directly without going through token lookup.",
    {
      attributeName: z.string().describe("The Roll20 attribute name, e.g. 'wisdom', 'hp', 'ac'"),
      characterName: z.string().optional(),
      charSheetId: z.string().optional().describe("Target a character sheet directly by its Roll20 ID"),
    },
    async ({ attributeName, characterName, charSheetId }) => {
      let resolvedCharId = charSheetId;
      if (!resolvedCharId) {
        if (!characterName) throw new Error("Provide characterName or charSheetId");
        const entry = registry.lookup(characterName);
        if (!entry) throw new Error(`Character not registered: ${characterName}`);
        const tokenData = await roll20.relayCommand<{ represents: string } | null>({ action: "getTokenById", tokenId: entry.roll20TokenId });
        if (!tokenData?.represents) throw new Error("Token has no linked character sheet");
        resolvedCharId = tokenData.represents;
      }
      const attrs = await roll20.relayCommand<Record<string, { current: unknown; max: unknown }>>({
        action: "getCharacterAttributes",
        charId: resolvedCharId,
        names: [attributeName],
      });
      const attr = attrs[attributeName];
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ charSheetId: resolvedCharId, attribute: attributeName, current: attr?.current ?? null, max: attr?.max ?? null }),
        }],
      };
    }
  );

  server.tool(
    "set_character_attribute",
    "Set a single attribute on a Roll20 character sheet. Use max to set the max value (e.g. for hp). Use charSheetId to target a sheet directly.",
    {
      attributeName: z.string().describe("The Roll20 attribute name, e.g. 'wisdom', 'hp', 'ac'"),
      value: z.union([z.string(), z.number()]).describe("The current value to set"),
      max: z.number().optional().describe("The max value to set (e.g. max HP). If provided, sets both current and max on the same attribute."),
      characterName: z.string().optional(),
      charSheetId: z.string().optional().describe("Target a character sheet directly by its Roll20 ID"),
    },
    async ({ attributeName, value, max, characterName, charSheetId }) => {
      let resolvedCharId = charSheetId;
      if (!resolvedCharId) {
        if (!characterName) throw new Error("Provide characterName or charSheetId");
        const entry = registry.lookup(characterName);
        if (!entry) throw new Error(`Character not registered: ${characterName}`);
        const tokenData = await roll20.relayCommand<{ represents: string } | null>({ action: "getTokenById", tokenId: entry.roll20TokenId });
        if (!tokenData?.represents) throw new Error("Token has no linked character sheet");
        resolvedCharId = tokenData.represents;
      }
      const attrValue = max !== undefined ? { current: value, max } : value;
      const result = await roll20.relayCommand<{ updated: string[]; created: string[]; failed: string[] }>({
        action: "setCharacterAttributes",
        charId: resolvedCharId,
        attributes: { [attributeName]: attrValue },
      });
      const status = result.updated.length ? "updated" : result.created.length ? "created" : "failed";
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ charSheetId: resolvedCharId, attribute: attributeName, value, max, status }),
        }],
      };
    }
  );

  server.tool(
    "read_character_attributes",
    "Read raw Roll20 character sheet attributes for a registered PC — useful for verifying sync results",
    {
      characterName: z.string().optional(),
      charSheetId: z.string().optional().describe("Query a specific Roll20 character sheet ID directly"),
      names: z.array(z.string()).optional().describe("Attribute names to fetch (omit for all)"),
    },
    async ({ characterName, charSheetId, names }) => {
      let resolvedCharId = charSheetId;

      if (!resolvedCharId) {
        if (!characterName) throw new Error("Provide characterName or charSheetId");
        const entry = registry.lookup(characterName);
        if (!entry) throw new Error(`Character not registered: ${characterName}`);

        const tokenData = await roll20.relayCommand<{ id: string; represents: string } | null>({
          action: "getTokenById",
          tokenId: entry.roll20TokenId,
        });
        if (!tokenData?.represents) throw new Error("Token has no linked character sheet");
        resolvedCharId = tokenData.represents;
      }

      const attrs = await roll20.relayCommand<Record<string, { current: unknown; max: unknown }>>({
        action: "getCharacterAttributes",
        charId: resolvedCharId,
        names,
      });

      return { content: [{ type: "text", text: JSON.stringify({ charSheetId: resolvedCharId, attributes: attrs }, null, 2) }] };
    }
  );

  server.tool(
    "full_sync_character",
    "Sync a PC from D&D Beyond to their Roll20 2014 OGL character sheet: ability scores, HP, AC, initiative, passive perception, speed, and proficiency bonus. Pass charSheetId to override the token's linked sheet.",
    {
      characterName: z.string(),
      charSheetId: z.string().optional().describe("Override the Roll20 character sheet ID (use when the token's 'represents' field hasn't been updated yet)"),
    },
    async ({ characterName, charSheetId }) => {
      const entry = registry.lookup(characterName);
      if (!entry) throw new Error(`Character not registered: ${characterName}`);

      const [stats, tokenData] = await Promise.all([
        ddb.getCharacterStats(entry.ddbCharId),
        roll20.relayCommand<{ id: string; represents: string } | null>({
          action: "getTokenById",
          tokenId: entry.roll20TokenId,
        }),
      ]);

      const resolvedCharId = charSheetId ?? tokenData?.represents;
      if (!resolvedCharId) {
        throw new Error(`Token ${entry.roll20TokenId} has no linked character sheet. Pass charSheetId explicitly or link the token to a sheet in Roll20.`);
      }

      // 2014 OGL sheet: split into two sequential batches to avoid Roll20 sandbox timeout.
      // Batch 1 — ability scores (triggers heavy sheet worker cascade for mods/saves/skills).
      const abilityScores: Record<string, number> = {};
      for (const [ability, score] of Object.entries(stats.abilityScores)) {
        abilityScores[ability] = score;
      }

      // Batch 2 — stats the sheet does NOT auto-compute.
      const derivedStats: Record<string, string | number | { current: number; max: number }> = {
        ac: stats.armorClass,
        hp: { current: stats.hp.current, max: stats.hp.max },
        hp_temp: stats.hp.temp,
        passive_wisdom: stats.passivePerception,
        initiative_bonus: stats.initiativeBonus,
        speed: stats.walkSpeed,
        pb: stats.proficiencyBonus,
        level: stats.level,
      };

      const [scoresResult, derivedResult] = await Promise.all([
        roll20.relayCommand<{ updated: string[]; created: string[]; failed: string[] }>({
          action: "setCharacterAttributes",
          charId: resolvedCharId,
          attributes: abilityScores,
        }),
        roll20.relayCommand<{ updated: string[]; created: string[]; failed: string[] }>({
          action: "setCharacterAttributes",
          charId: resolvedCharId,
          attributes: derivedStats,
        }),
      ]);

      const result = {
        updated: [...scoresResult.updated, ...derivedResult.updated],
        created: [...scoresResult.created, ...derivedResult.created],
        failed: [...scoresResult.failed, ...derivedResult.failed],
      };

      await roll20.relayCommand({
        action: "setTokenBar",
        tokenId: entry.roll20TokenId,
        value: stats.hp.current,
        max: stats.hp.max,
      });

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            character: stats.name,
            charSheetId: resolvedCharId,
            level: stats.level,
            classes: stats.classes,
            hp: `${stats.hp.current}/${stats.hp.max}`,
            ac: stats.armorClass,
            initiativeBonus: stats.initiativeBonus,
            passivePerception: stats.passivePerception,
            updated: result.updated.length,
            created: result.created.length,
            failed: result.failed,
          }, null, 2),
        }],
      };
    }
  );

  server.tool(
    "update_token_hp",
    "Apply damage, healing, or set HP directly on any Roll20 token by ID — no character sheet or DDB required. Use this for NPC/monster tokens that aren't registered characters. Reads bar1_value/bar1_max, computes new HP, writes back. Use addConditions/removeConditions to merge-add or merge-remove individual status markers without disturbing others. Use replaceConditions only when you want to set the complete condition list from scratch.",
    {
      tokenId: z.string().describe("Roll20 token ID"),
      damage: z.number().int().min(0).optional().describe("Subtract this much from current HP (clamps at 0)"),
      heal: z.number().int().min(0).optional().describe("Add this much to current HP (clamps at bar1_max)"),
      setHp: z.number().int().min(0).optional().describe("Set HP to this exact value regardless of current"),
      addConditions: z.array(z.string()).optional().describe("Add these conditions without removing others (e.g. ['poisoned']). Safe to use alongside existing conditions."),
      removeConditions: z.array(z.string()).optional().describe("Remove these conditions without touching others."),
      replaceConditions: z.array(z.string()).optional().describe("REPLACES ALL existing condition markers with this list. Use only when setting the complete state from scratch."),
    },
    async ({ tokenId, damage, heal, setHp, addConditions, removeConditions, replaceConditions }) => {
      type TokenData = { bar1_value: number; bar1_max: number; name: string };
      const token = await roll20.relayCommand<TokenData | null>({ action: "getTokenById", tokenId });
      if (!token) throw new Error(`Token not found: ${tokenId}`);

      const maxHp = Number(token.bar1_max) || 0;
      const currentHp = Number(token.bar1_value) || 0;

      let newHp: number;
      if (setHp !== undefined) {
        newHp = setHp;
      } else if (damage !== undefined) {
        newHp = Math.max(0, currentHp - damage);
      } else if (heal !== undefined) {
        newHp = maxHp ? Math.min(maxHp, currentHp + heal) : currentHp + heal;
      } else {
        throw new Error("Provide damage, heal, or setHp");
      }

      await roll20.relayCommand({ action: "setTokenProps", tokenId, props: { bar1_value: newHp } });

      if (replaceConditions !== undefined) {
        await roll20.relayCommand({ action: "syncConditionsToToken", tokenId, conditions: replaceConditions });
      } else {
        for (const c of addConditions ?? []) {
          await roll20.relayCommand({ action: "toggleCondition", tokenId, condition: c, active: true });
        }
        for (const c of removeConditions ?? []) {
          await roll20.relayCommand({ action: "toggleCondition", tokenId, condition: c, active: false });
        }
      }

      const hpStr = maxHp ? `${newHp}/${maxHp}` : String(newHp);
      const delta = damage !== undefined ? `-${damage}` : heal !== undefined ? `+${heal}` : `→${newHp}`;
      const condNote = replaceConditions !== undefined
        ? ` | conditions set: [${replaceConditions.join(", ") || "none"}]`
        : addConditions?.length || removeConditions?.length
          ? ` | +[${(addConditions ?? []).join(", ")}] -[${(removeConditions ?? []).join(", ")}]`
          : "";
      return {
        content: [{ type: "text", text: `${token.name}: ${delta} HP → ${hpStr}${condNote}` }],
      };
    }
  );

  server.tool(
    "get_token",
    "Read all properties of a single Roll20 token by ID — position, size, aura, statusmarkers, HP bars, layer, rotation, etc.",
    { tokenId: z.string().describe("Roll20 token ID") },
    async ({ tokenId }) => {
      const token = await roll20.relayCommand({ action: "getTokenById", tokenId });
      return { content: [{ type: "text", text: JSON.stringify(token, null, 2) }] };
    }
  );

  server.tool(
    "set_token_props",
    "Set one or more properties on a Roll20 token — name, position, aura, tint, bars, layer, etc. Use aura1_radius (feet, 0 to clear) + aura1_color (#hex) + showplayers_aura1=true for visible spell auras. Use tint_color for colored overlays.",
    {
      tokenId: z.string(),
      name: z.string().optional(),
      left: z.number().optional().describe("X position in page pixels"),
      top: z.number().optional().describe("Y position in page pixels"),
      width: z.number().optional().describe("Width in pixels"),
      height: z.number().optional().describe("Height in pixels"),
      rotation: z.number().optional().describe("Rotation in degrees"),
      layer: z.string().optional().describe("Roll20 layer: tokens, map, gmlayer, objects"),
      aura1_radius: z.number().optional().describe("Aura 1 radius in feet (0 clears it)"),
      aura1_color: z.string().optional().describe("Aura 1 color as #hex"),
      aura1_square: z.boolean().optional().describe("True for square aura, false (default) for circle"),
      showplayers_aura1: z.boolean().optional().describe("Show aura 1 to players"),
      aura2_radius: z.number().optional(),
      aura2_color: z.string().optional(),
      aura2_square: z.boolean().optional(),
      showplayers_aura2: z.boolean().optional(),
      tint_color: z.string().optional().describe("#hex color overlay on token, or 'transparent' to clear"),
      bar2_value: z.number().optional(),
      bar2_max: z.number().optional(),
      bar3_value: z.number().optional(),
      bar3_max: z.number().optional(),
      controlledby: z.string().optional(),
      showname: z.boolean().optional(),
    },
    async ({ tokenId, ...fields }) => {
      const props: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(fields)) {
        if (v !== undefined) props[k] = v;
      }
      await roll20.relayCommand({ action: "setTokenProps", tokenId, props });
      return { content: [{ type: "text", text: `Updated token ${tokenId}: ${Object.keys(props).join(", ")}` }] };
    }
  );

  server.tool(
    "get_recent_chat",
    "Read recent Roll20 chat messages. Includes Beyond20 dice roll output with inline roll results. Use this to read saving throw or attack roll results after players roll on DDB character sheets, then apply damage/conditions accordingly.",
    { limit: z.number().int().min(1).max(100).default(30).describe("Number of recent messages to return") },
    async ({ limit }) => {
      const messages = await roll20.relayCommand({ action: "getRecentChat", limit });
      return { content: [{ type: "text", text: JSON.stringify(messages, null, 2) }] };
    }
  );

  server.tool(
    "find_tokens_in_range",
    "Find all Roll20 tokens within radiusFeet of a center token. Use for AoE targeting — find who's in range of a spell or effect. Returns token names, HP, layer, and distance sorted nearest-first. After targeting, place a visual marker with set_token_props (aura1_radius + aura1_color) on the caster and create_zone to track the persistent AoE area.",
    {
      centerTokenId: z.string().describe("Roll20 token ID of the caster / effect origin"),
      radiusFeet: z.number().describe("Effect radius in feet, e.g. 15 for Spiritual Guardians, 20 for Fireball"),
      pageId: z.string().optional().describe("Page to search — defaults to current player page"),
      layerFilter: z.string().optional().describe("Restrict to a layer, e.g. 'tokens' to exclude map art"),
    },
    async ({ centerTokenId, radiusFeet, pageId, layerFilter }) => {
      const activePage = pageId ?? (await roll20.getCurrentPageId());
      const results = await roll20.relayCommand({
        action: "findTokensInRange",
        centerTokenId,
        radiusFeet,
        pageId: activePage,
        layerFilter,
      });
      return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
    }
  );

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
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
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
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }
  );

  server.tool(
    "remove_object",
    "Remove any Roll20 object (token, zone path, AoE template) by ID. Use after resolving a one-shot AoE spell to clean up the template token. Tries graphic first, then path.",
    {
      objectId: z.string().describe("Roll20 object ID to remove"),
      objectType: z.string().optional().describe("Roll20 type: 'graphic' (default) or 'path'"),
    },
    async ({ objectId, objectType }) => {
      const result = await roll20.relayCommand({ action: "removeObject", objectId, objectType });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }
  );

  server.tool(
    "list_zones",
    "List all active named zones on the current page — shows zone names, positions, and metadata.",
    { pageId: z.string().optional() },
    async ({ pageId }) => {
      const activePage = pageId ?? (await roll20.getCurrentPageId());
      const zones = await roll20.relayCommand({ action: "listZones", pageId: activePage });
      return { content: [{ type: "text", text: JSON.stringify(zones, null, 2) }] };
    }
  );

  server.tool(
    "set_turn_hook",
    "Enable or disable the automatic turn announcement and end-of-round summary in Roll20 chat. The hook fires on turn order changes — posting the active combatant's name, HP bar, and conditions. At round end it posts a full party status summary. Call with reset=true at combat start to reset the round counter.",
    {
      enabled: z.boolean().describe("true to enable, false to disable"),
      reset: z.boolean().default(false).describe("Reset round counter and first-token tracking (use at combat start)"),
    },
    async ({ enabled, reset }) => {
      const result = await roll20.relayCommand({ action: "setTurnHook", enabled, reset });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }
  );

  server.tool(
    "check_turn_hook",
    "Check whether the turn announcement hook is enabled in the relay, and what round it's on. Use this at session start to verify the hook survived the last relay redeploy — if enabled is false but combat is active, call set_turn_hook with enabled=true to re-arm it.",
    {},
    async () => {
      const result = await roll20.relayCommand<{ enabled: boolean; round: number; firstTokenId: string | null }>({ action: "getTurnHookState" });
      const status = result.enabled ? `ENABLED (round ${result.round})` : "DISABLED";
      return { content: [{ type: "text", text: `Turn hook: ${status}\n${JSON.stringify(result)}` }] };
    }
  );

  server.tool(
    "sync_character_state",
    "Pull ground truth from D&D Beyond and push to Roll20 token (reconciles drift)",
    { characterName: z.string() },
    async ({ characterName }) => {
      const entry = registry.lookup(characterName);
      if (!entry) throw new Error(`Character not registered: ${characterName}`);

      const [stats, tokenData] = await Promise.all([
        ddb.getCharacterStats(entry.ddbCharId),
        roll20.relayCommand<{ represents: string } | null>({ action: "getTokenById", tokenId: entry.roll20TokenId }),
      ]);

      const { hp, conditions: activeConditions } = stats;
      const currentHp = hp.current;
      const maxHp = hp.max;

      const effectiveConditions = [...activeConditions];
      if (currentHp * 2 <= maxHp) effectiveConditions.push("wounded");

      await roll20.relayCommand({ action: "setTokenBar", tokenId: entry.roll20TokenId, value: currentHp, max: maxHp });
      await roll20.relayCommand({
        action: "syncConditionsToToken",
        tokenId: entry.roll20TokenId,
        charId: tokenData?.represents || undefined,
        conditions: effectiveConditions,
      });

      return {
        content: [{
          type: "text",
          text: `Synced ${characterName}: HP ${currentHp}/${maxHp}, conditions: [${effectiveConditions.join(", ") || "none"}]`,
        }],
      };
    }
  );

  server.tool(
    "get_dm_inbox",
    "Read player !dm messages — intents queued for upcoming turns, or queries needing answers. Intents are auto-consumed by the turn hook when the player's turn arrives; queries stay until answered.",
    { type: z.enum(["intent", "query"]).optional().describe("Filter by type. Omit to get all.") },
    async ({ type }) => {
      const entries = await roll20.relayCommand({ action: "getDmInbox", type });
      return { content: [{ type: "text", text: JSON.stringify(entries, null, 2) }] };
    }
  );

  server.tool(
    "clear_dm_inbox",
    "Clear processed !dm entries from the queue. Use after answering player queries.",
    { playerName: z.string().optional().describe("Clear only this player's entries. Omit to flush all.") },
    async ({ playerName }) => {
      const result = await roll20.relayCommand({ action: "clearDmInbox", playerName });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }
  );

  server.tool(
    "whisper_player",
    "Whisper a message to a player by their Roll20 display name. Use to answer !dm queries.",
    {
      playerName: z.string().describe("Roll20 display name of the player to whisper"),
      message: z.string().describe("Message content"),
    },
    async ({ playerName, message }) => {
      const result = await roll20.relayCommand({ action: "whisperPlayer", playerName, message });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }
  );

  server.tool(
    "inject_round_marker",
    "Insert or remove a synthetic 'Top of Order' marker at initiative 99 to mark the round start. Use this before roll_initiative to ensure the marker stays sorted at position 1 (rounds always begin with this sentinel before any actual combatant).",
    {
      active: z.boolean().describe("true to inject the marker, false to remove it"),
    },
    async ({ active }) => {
      type TurnEntry = { id: string; pr: string; custom: string; _pageid: string; formula?: string };

      const pageId = await roll20.getCurrentPageId();
      let current: TurnEntry[] = await roll20.relayCommand<TurnEntry[]>({ action: "getTurnOrder" });

      // Custom (non-token) entries use id="-1" in Roll20's API; detect by custom text
      const existing = current.findIndex((e) => e.id === "-1" && e.custom?.includes("Round"));

      if (active) {
        if (existing !== -1) {
          return { content: [{ type: "text", text: "Round Start marker already present." }] };
        }
        const marker: TurnEntry = {
          id: "-1",
          pr: "99",
          custom: "⏺ Round Start",
          _pageid: pageId,
          formula: "+1",
        };
        current = [marker, ...current];
      } else {
        if (existing === -1) {
          return { content: [{ type: "text", text: "Round Start marker not found." }] };
        }
        current = current.filter((_, i) => i !== existing);
      }

      // Sort by pr descending
      current.sort((a, b) => Number(b.pr) - Number(a.pr));

      // Write back
      await roll20.relayCommand({ action: "setTurnOrder", entries: current });

      const action = active ? "Injected" : "Removed";
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            action,
            markerPresent: active,
            totalEntries: current.length,
            turnOrder: current.map((e) => ({ id: e.id, name: e.custom || e.id, pr: e.pr })),
          }, null, 2),
        }],
      };
    }
  );

  server.tool(
    "update_turn_order",
    "Insert, update, or remove a single turn-order entry while preserving all existing entries. Reads the full turn order, applies the modification, and rebuilds before sending back. Use to adjust an NPC's initiative mid-combat without affecting player slots.",
    {
      operation: z.enum(["insert", "update", "remove"]).describe("insert=add new token, update=change existing token's pr, remove=delete token"),
      tokenId: z.string().describe("Roll20 token ID to operate on"),
      pr: z.number().int().optional().describe("Initiative value (required for insert/update)"),
      name: z.string().optional().describe("Token name for display (required for insert without a token lookup)"),
    },
    async ({ operation, tokenId, pr, name }) => {
      // Validate inputs
      if ((operation === "insert" || operation === "update") && pr === undefined) {
        throw new Error(`${operation} requires a pr (initiative) value`);
      }
      if (operation === "insert" && !name && !tokenId) {
        throw new Error("insert requires either name or tokenId");
      }

      type TurnEntry = { id: string; pr: string; custom: string; _pageid: string };

      // Read current turn order
      const pageId = await roll20.getCurrentPageId();
      let current: TurnEntry[] = await roll20.relayCommand<TurnEntry[]>({ action: "getTurnOrder" });

      // Apply modification
      let modified: TurnEntry[];
      if (operation === "insert") {
        // Check if already in order (shouldn't be, but be safe)
        const alreadyExists = current.some((e) => e.id === tokenId);
        if (alreadyExists) {
          throw new Error(`Token ${tokenId} already in turn order. Use operation='update' instead.`);
        }
        // Add new entry
        const newEntry: TurnEntry = {
          id: tokenId,
          pr: String(pr!),
          custom: name ?? "",
          _pageid: pageId,
        };
        modified = [...current, newEntry];
      } else if (operation === "update") {
        // Find and update existing entry
        const idx = current.findIndex((e) => e.id === tokenId);
        if (idx === -1) {
          throw new Error(`Token ${tokenId} not found in turn order. Use operation='insert' to add it.`);
        }
        modified = [...current];
        modified[idx] = { ...modified[idx], pr: String(pr!) };
      } else {
        // Remove
        modified = current.filter((e) => e.id !== tokenId);
      }

      // Sort by initiative descending
      modified.sort((a, b) => Number(b.pr) - Number(a.pr));

      // Write back
      await roll20.relayCommand({ action: "setTurnOrder", entries: modified });

      // Return summary
      const summary =
        operation === "insert"
          ? `Inserted ${tokenId} at initiative ${pr}`
          : operation === "update"
            ? `Updated ${tokenId} initiative to ${pr}`
            : `Removed ${tokenId}`;

      const resultOrder = modified.map((e) => ({ id: e.id, pr: e.pr }));
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            operation,
            summary,
            totalEntries: modified.length,
            turnOrder: resultOrder,
          }, null, 2),
        }],
      };
    }
  );
}
