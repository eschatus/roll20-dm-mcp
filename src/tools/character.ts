import { randomBytes } from "crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as roll20 from "../bridge/roll20.js";
import { readCharacterAttributesRt, type AttributeValue } from "../bridge/attributes.js";
import { writeDefaultTokenRt } from "../bridge/default-token.js";
import { fail, failJson, json, resolveCharSheetId, resolveTokenOrThrow } from "./combatHelpers.js";

// ─────────────────────────────────────────────────────────────────────────────
// Character sheet primitives, whatever the game system or sheet.
//
// Everything on a Roll20 character is one of: the character object's own fields, an attribute, a
// row of attributes in a repeating section, a computed property (Beacon), or an ability. Spell
// slots, inventory, attacks and class resources are all attributes or repeating rows whose names
// belong to the sheet, so there are no tools for those by name here: that knowledge would be
// sheet-specific, and this repo holds none. Attribute and Beacon reads and writes live in combat.ts
// and sheet.ts; this file adds what they left out.
// ─────────────────────────────────────────────────────────────────────────────

const ROW_ID_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const ROW_ID_LENGTH = 20;

/**
 * A Roll20-shaped row id: 20 characters and a leading "-". Never contains "_": repeating attribute
 * names are split on it, and at least one official sheet breaks on a row id that has one.
 */
export function newRowId(): string {
  const bytes = randomBytes(ROW_ID_LENGTH - 1);
  return "-" + Array.from(bytes, (b) => ROW_ID_CHARS[b % ROW_ID_CHARS.length]).join("");
}

/** The row id and field of a `repeating_<section>_<row>_<field>` name, or null if it isn't one. */
export function parseRepeatingName(name: string, section: string): { rowId: string; field: string } | null {
  const prefix = `repeating_${section}_`;
  if (!name.startsWith(prefix)) return null;
  const rest = name.slice(prefix.length);
  // Roll20's own ids are 20 characters from a leading "-", and an older one may contain "_".
  const sep = rest.startsWith("-") && rest[ROW_ID_LENGTH] === "_" ? ROW_ID_LENGTH : rest.indexOf("_");
  if (sep <= 0 || sep === rest.length - 1) return null;
  return { rowId: rest.slice(0, sep), field: rest.slice(sep + 1) };
}

/** Group a character's attributes into the rows of one repeating section. */
export function groupRepeatingRows(
  attributes: Record<string, AttributeValue>,
  section: string,
): Record<string, Record<string, AttributeValue>> {
  const rows: Record<string, Record<string, AttributeValue>> = {};
  for (const [name, value] of Object.entries(attributes)) {
    const parsed = parseRepeatingName(name, section);
    if (parsed) (rows[parsed.rowId] ||= {})[parsed.field] = value;
  }
  return rows;
}

const characterTarget = {
  characterName: z.string().optional().describe("Character name as in the journal, or a registered name"),
  charSheetId: z.string().optional().describe("Roll20 character id, from list_characters"),
};
const section = z.string().regex(/^[-\w]+$/).describe("Section name without the repeating_ prefix, as the sheet names it, e.g. 'npcaction', 'inventory'");
const fieldValue = z.union([
  z.string(), z.number(), z.boolean(),
  z.object({ current: z.union([z.string(), z.number(), z.boolean()]).optional(), max: z.union([z.string(), z.number()]).optional() }),
]);

type Written = { updated?: string[]; created?: string[]; failed?: string[]; reasons?: Record<string, string> };

export function registerCharacterTools(server: McpServer): void {
  server.tool(
    "list_characters",
    "List the characters in the campaign's journal: id, name, who controls them, who can see them, whether archived, avatar. Use it to find a charSheetId, and to tell PCs (controlledby set) from NPCs. Does not need a token on the map or any prior registration.",
    {
      nameContains: z.string().optional().describe("Case-insensitive name filter"),
      includeArchived: z.boolean().optional().describe("Include archived characters. Default false."),
    },
    async ({ nameContains, includeArchived }) => {
      const rows = await roll20.relayCommand<{ id: string; name: string }[]>({ action: "listCharacters", includeArchived });
      const want = nameContains?.toLowerCase();
      return json({ characters: want ? rows.filter((c) => c.name.toLowerCase().includes(want)) : rows });
    }
  );

  server.tool(
    "get_character",
    "Read one character's own fields: name, bio, GM notes, avatar, controlledby, inplayerjournals, archived, default token. Attributes are separate: read_character_attributes, or get_sheet_item on a Beacon sheet. set_character_props writes these fields. GM notes are GM-only: don't pass them to players.",
    characterTarget,
    async ({ characterName, charSheetId }) => {
      const charId = await resolveCharSheetId(characterName, charSheetId);
      return json(await roll20.relayCommand({ action: "getCharacter", charId }));
    }
  );

  server.tool(
    "get_repeating_section",
    "Read a repeating section (attacks, inventory, spells, whatever this sheet calls them) as rows: {rowId: {field: value}}. Reads straight from the campaign database, so it needs no Mod and is safe on macro fields such as rollbase. Section and field names belong to the sheet; read_character_attributes shows them as repeating_<section>_<row>_<field>. Data a Beacon sheet holds in computed properties does not appear here.",
    { section, ...characterTarget },
    async ({ section: name, characterName, charSheetId }) => {
      const charId = await resolveCharSheetId(characterName, charSheetId);
      const rows = groupRepeatingRows(await readCharacterAttributesRt(charId), name);
      return json({ charSheetId: charId, section: name, rows });
    }
  );

  server.tool(
    "set_repeating_row",
    "Add a row to a repeating section, or update fields on one. Omit rowId to add a row; the new id is returned. Field names are the sheet's, without the repeating prefix. A plain write does NOT run the sheet's own JavaScript, so derived fields such as a clickable attack button stay missing: pass withWorker:true to write through the sheet's workers. workersExecuted in that result is true, false or null, and null means Roll20 never said.",
    {
      section,
      rowId: z.string().regex(/^[-\w]+$/).optional().describe("Existing row to update, from get_repeating_section. Omit to add a row."),
      fields: z.record(z.string().regex(/^\w+$/), fieldValue).describe("field → value, or {current, max}"),
      withWorker: z.boolean().optional().describe("Write through the sheet's workers. Default false."),
      ...characterTarget,
    },
    async ({ section: name, rowId, fields, withWorker, characterName, charSheetId }) => {
      const charId = await resolveCharSheetId(characterName, charSheetId);
      if (Object.keys(fields).length === 0) throw new Error("fields is empty: nothing to write.");
      const row = rowId ?? newRowId();
      const attributes = Object.fromEntries(
        Object.entries(fields).map(([field, value]) => [`repeating_${name}_${row}_${field}`, value])
      );
      if (withWorker) {
        const r = await roll20.relayCommand<{ written: string[]; workersExecuted: boolean | null; note: string | null }>(
          { action: "setAttrs", charId, attributes }
        );
        return json({ charSheetId: charId, section: name, rowId: row, added: !rowId, written: r.written, workersExecuted: r.workersExecuted, note: r.note });
      }
      const r = await roll20.relayCommand<Written>({ action: "setCharacterAttributes", charId, attributes });
      if (r.failed?.length) return failJson({ charSheetId: charId, section: name, rowId: row, partial: true, ...r });
      return json({ charSheetId: charId, section: name, rowId: row, added: !rowId, updated: r.updated, created: r.created });
    }
  );

  server.tool(
    "delete_repeating_row",
    "Delete one row of a repeating section: every attribute of that row, permanently. Fails if the row has no attributes.",
    { section, rowId: z.string().regex(/^[-\w]+$/), ...characterTarget },
    async ({ section: name, rowId, characterName, charSheetId }) => {
      const charId = await resolveCharSheetId(characterName, charSheetId);
      const r = await roll20.relayCommand<{ removed: string[] }>({
        action: "deleteAttributes", charId, prefix: `repeating_${name}_${rowId}_`,
      });
      if (r.removed.length === 0) return fail(`No row ${rowId} in section ${name} on character ${charId}: nothing was deleted.`);
      return json({ charSheetId: charId, section: name, rowId, removed: r.removed });
    }
  );

  server.tool(
    "delete_character_attributes",
    "Permanently delete named attributes from a character. The sheet falls back to its default for any field it still defines. Names not found are listed under missing. A Beacon computed property is not an attribute and cannot be deleted here.",
    { names: z.array(z.string().min(1)).min(1), ...characterTarget },
    async ({ names, characterName, charSheetId }) => {
      const charId = await resolveCharSheetId(characterName, charSheetId);
      const r = await roll20.relayCommand<{ removed: string[]; missing: string[] }>({ action: "deleteAttributes", charId, names });
      return json({ charSheetId: charId, ...r });
    }
  );

  server.tool(
    "list_character_abilities",
    "List a character's abilities (its macros): id, name, description, action text, and whether each shows as a token action. Action text comes back literally, including any @{ or [[.",
    characterTarget,
    async ({ characterName, charSheetId }) => {
      const charId = await resolveCharSheetId(characterName, charSheetId);
      return json({ charSheetId: charId, abilities: await roll20.relayCommand({ action: "listAbilities", charId }) });
    }
  );

  server.tool(
    "set_character_ability",
    "Create or update a character ability (macro). Matches an existing ability by abilityId, else by exact name, else creates it. Only given fields change. Writing never runs the macro. To run one on sandbox v1.5, use perform_sheet_action with allowAbilityFallback:true.",
    {
      name: z.string().min(1).optional().describe("Ability name. Required to create one."),
      abilityId: z.string().optional().describe("Update this ability by id; lets you rename it with name."),
      action: z.string().optional().describe("The macro text"),
      description: z.string().optional(),
      isTokenAction: z.boolean().optional().describe("Show as a button when the token is selected"),
      ...characterTarget,
    },
    async ({ name, abilityId, action, description, isTokenAction, characterName, charSheetId }) => {
      const charId = await resolveCharSheetId(characterName, charSheetId);
      if (!name && !abilityId) throw new Error("Provide name or abilityId.");
      const r = await roll20.relayCommand<{ id: string; created: boolean }>({
        action: "setAbility", charId, abilityId, name, abilityAction: action, description, istokenaction: isTokenAction,
      });
      return json({ charSheetId: charId, ...r });
    }
  );

  server.tool(
    "delete_character_ability",
    "Permanently delete one character ability by id, from list_character_abilities.",
    { abilityId: z.string().min(1) },
    async ({ abilityId }) => json(await roll20.relayCommand({ action: "removeObject", objectType: "ability", objectId: abilityId }))
  );

  server.tool(
    "link_token_to_character",
    "Make a token represent a character and optionally link its bars to sheet attributes, so a bar and the attribute follow each other. Each bar takes the attribute's current values. Linking checks every attribute first and changes nothing if one is missing. When the token moves to a different character, any bar not relinked in this call is unlinked and listed under unlinked, because it would otherwise keep editing the previous character. A Beacon sheet's computed property is not an attribute, so it can't be linked here. A token linked this way on a Beyond20 table hands that bar to the sheet.",
    {
      tokenId: z.string().optional(),
      tokenName: z.string().optional().describe("Token name on the current page, if no tokenId"),
      bars: z.array(z.object({
        bar: z.union([z.literal(1), z.literal(2), z.literal(3)]),
        attribute: z.string().min(1).describe("Attribute name on the sheet, e.g. 'hp'"),
      })).optional(),
      ...characterTarget,
    },
    async ({ tokenId, tokenName, bars, characterName, charSheetId }) => {
      const charId = await resolveCharSheetId(characterName, charSheetId);
      if (!tokenId && !tokenName) throw new Error("Provide tokenId or tokenName.");
      const id = tokenId ?? await resolveTokenOrThrow(tokenName!);
      return json(await roll20.relayCommand({ action: "linkToken", tokenId: id, charId, bars }));
    }
  );

  server.tool(
    "set_default_token",
    "Save a token as its character's default token, the one Roll20 places when the sheet is dragged onto a map. Uses the character the token represents unless charSheetId is given. The saved token is read back before this reports success.",
    { tokenId: z.string().min(1), charSheetId: z.string().optional() },
    async ({ tokenId, charSheetId }) => {
      const r = await roll20.relayCommand<{ charId: string; character: string; fields: number; defaulttoken?: string }>({
        action: "setDefaultToken", tokenId, ...(charSheetId ? { charId: charSheetId } : {}),
      });
      if (!r.defaulttoken) throw new Error("The deployed relay did not return the default token, so nothing was saved. Re-paste relay 2.12.2.");
      await writeDefaultTokenRt(r.charId, r.defaulttoken);
      return json({ charSheetId: r.charId, character: r.character, fields: r.fields });
    }
  );
}
