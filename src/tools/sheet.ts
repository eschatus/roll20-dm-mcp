import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as roll20 from "../bridge/roll20.js";
import { text, fail, json, resolveCharSheetId } from "./combatHelpers.js";

// ─────────────────────────────────────────────────────────────────────────────
// Beacon character sheet access (Mod Script Sandbox v1.5) — issue #205.
//
// A Beacon ("advanced") sheet keeps character data in COMPUTED PROPERTIES rather than `attribute`
// objects, so get_character_attribute / set_character_attribute cannot see or reach any of it —
// set_character_attribute refuses such a write rather than reporting a success that did nothing.
// These are the carriers that DO reach it:
//
//   get_sheet_item / set_sheet_item   — work on BOTH sandbox versions (on v1.0 they wrap
//                                       attributes), so they are the version-agnostic pair and the
//                                       right default when you don't know which sandbox you're on.
//   get_computed_property /
//   set_computed_property             — Beacon computed properties specifically. v1.5 only.
//   perform_sheet_action              — run a Beacon sheet action (a monster's attack). v1.5 only.
//   get_sheet_summary                 — what this campaign's sheet actually offers. Start here.
//
// Every one of these is asynchronous inside the Mod sandbox; the relay defers its writeResult
// until the promise settles, and reports a carrier that never settles by name.
// ─────────────────────────────────────────────────────────────────────────────

type SheetStamp = { sandbox: string | null; sheetName: string | null; beacon: boolean };

const valtypeSchema = z.enum(["current", "max"]).optional()
  .describe("Which half of the field to touch: 'current' (default) or 'max'.");

export function registerSheetTools(server: McpServer): void {
  server.tool(
    "get_sheet_summary",
    "What this campaign's character sheet actually offers: the Mod Script Sandbox version, the sheet name, whether it is a Beacon ('advanced') sheet, the list of Beacon COMPUTED PROPERTY names (usable with get/set_computed_property and get/set_sheet_item), the list of Beacon ACTION names (usable with perform_sheet_action), and which carrier functions exist in the sandbox. Call this FIRST when a character read or write comes back empty or refused — on a Beacon sheet the attribute tools cannot see the data at all.",
    {},
    async () => {
      const r = await roll20.relayCommand<{
        sandbox: string | null; node: string | null; sheetName: string | null;
        beacon: boolean; computedUnreadable: boolean;
        computed: string[]; actions: string[]; carriers: Record<string, boolean>;
      }>({ action: "getSheetSummary" });
      return json(r);
    }
  );

  server.tool(
    "get_sheet_item",
    "Read character sheet fields the VERSION-AGNOSTIC way: on sandbox v1.0 this wraps ordinary attributes, on v1.5 it also reaches Beacon computed properties and 'user.*' custom attributes. Prefer this over read_character_attributes when the campaign might be on a Beacon sheet. Reads several names in one round trip; a name that cannot be read is reported under failed/reasons rather than costing you the others.",
    {
      names: z.array(z.string()).min(1).describe("Sheet property names, e.g. ['hp','ac'] or ['user.mob_plan']"),
      valtype: valtypeSchema,
      characterName: z.string().optional(),
      charSheetId: z.string().optional().describe("Target a character sheet directly by its Roll20 ID"),
    },
    async ({ names, valtype, characterName, charSheetId }) => {
      const charId = await resolveCharSheetId(characterName, charSheetId);
      const r = await roll20.relayCommand<{
        valtype: string; values: Record<string, unknown>;
        failed: string[]; reasons: Record<string, string>; sheet: SheetStamp;
      }>({ action: "getSheetItem", charId, names, valtype });
      if (r.failed.length === names.length) {
        return fail(`Could not read any of [${names.join(", ")}] on character ${charId}: ` +
          names.map((n) => `${n}: ${r.reasons[n]}`).join("; "));
      }
      return json({ charSheetId: charId, ...r });
    }
  );

  server.tool(
    "set_sheet_item",
    "Write character sheet fields the VERSION-AGNOSTIC way: on sandbox v1.0 this sets ordinary attributes, on v1.5 it also reaches Beacon computed properties and 'user.*' custom attributes. This is the tool set_character_attribute points you at when it refuses a write on a Beacon sheet. A value may be a scalar (sets 'current') or {current, max}. The write is STRICT by default — a property that is missing or read-only is reported as failed rather than reported as written, because Roll20's lenient mode resolves whether or not the write landed.",
    {
      attributes: z.record(z.string(), z.union([
        z.string(), z.number(), z.boolean(),
        z.object({ current: z.union([z.string(), z.number(), z.boolean()]).optional(), max: z.union([z.string(), z.number()]).optional() }),
      ])).describe("name → value map, e.g. {\"hp\":{\"current\":31,\"max\":44},\"ac\":17}"),
      createAttr: z.boolean().optional().describe("Roll20 setSheetItem option: create a backing attribute if none exists."),
      withWorker: z.boolean().optional().describe("Roll20 setSheetItem option: fire the sheet's own sheet-worker JS for this write."),
      allowThrow: z.boolean().optional().describe("Defaults TRUE. Set false ONLY to accept Roll20's lenient behaviour, where the call resolves without telling you whether the write landed — the result then says so."),
      characterName: z.string().optional(),
      charSheetId: z.string().optional().describe("Target a character sheet directly by its Roll20 ID"),
    },
    async ({ attributes, createAttr, withWorker, allowThrow, characterName, charSheetId }) => {
      const charId = await resolveCharSheetId(characterName, charSheetId);
      const r = await roll20.relayCommand<{
        written: string[]; failed: string[]; reasons: Record<string, string>;
        allowThrow: boolean; note?: string; sheet: SheetStamp;
      }>({ action: "setSheetItem", charId, attributes, createAttr, withWorker, allowThrow });
      if (r.written.length === 0) {
        return fail(`Nothing was written to character ${charId}: ` +
          r.failed.map((n) => `${n}: ${r.reasons[n]}`).join("; "));
      }
      return json({ charSheetId: charId, ...r });
    }
  );

  server.tool(
    "get_computed_property",
    "Read ONE Beacon computed property (Mod Script Sandbox v1.5 only). Use get_sheet_summary to list the available names. get_sheet_item is the better default — it reaches the same data and also works on v1.0 — but this is the carrier that takes Beacon's own args payload.",
    {
      property: z.string().describe("Computed property name, as listed by get_sheet_summary"),
      args: z.record(z.string(), z.unknown()).optional().describe("Beacon's args payload for this property, if it takes one"),
      playerId: z.string().optional().describe("Roll20 player id to attribute the read to (some Beacon features, e.g. roll queries, need one). Defaults to the GM running the relay."),
      characterName: z.string().optional(),
      charSheetId: z.string().optional(),
    },
    async ({ property, args, playerId, characterName, charSheetId }) => {
      const charId = await resolveCharSheetId(characterName, charSheetId);
      const r = await roll20.relayCommand<{ property: string; value: unknown; known: boolean; sheet: SheetStamp }>(
        { action: "getComputed", charId, property, args, playerId }
      );
      return json({ charSheetId: charId, ...r });
    }
  );

  server.tool(
    "set_computed_property",
    "Write ONE writable Beacon computed property (Mod Script Sandbox v1.5 only). Roll20 does NOT publish where the new value sits inside setComputed's payload, so pass 'value' and/or 'args' and the relay forwards both verbatim rather than guessing a key that would write nothing. setComputed itself returns void, so the result carries a readBack — a read of the same property immediately afterwards, which is the only evidence the write landed. For anything that also exists as a plain attribute, prefer set_sheet_item.",
    {
      property: z.string().describe("Computed property name, as listed by get_sheet_summary"),
      value: z.union([z.string(), z.number(), z.boolean()]).optional().describe("The new value, forwarded as call.value"),
      args: z.record(z.string(), z.unknown()).optional().describe("Beacon's args payload, forwarded verbatim as call.args"),
      playerId: z.string().optional().describe("Roll20 player id to attribute the write to. Defaults to the GM running the relay."),
      characterName: z.string().optional(),
      charSheetId: z.string().optional(),
    },
    async ({ property, value, args, playerId, characterName, charSheetId }) => {
      const charId = await resolveCharSheetId(characterName, charSheetId);
      const r = await roll20.relayCommand<{
        ok: boolean; property: string; known: boolean; readBack: unknown; note: string; sheet: SheetStamp;
      }>({ action: "setComputed", charId, property, value, args, playerId });
      return json({ charSheetId: charId, ...r });
    }
  );

  server.tool(
    "perform_sheet_action",
    "Run a Beacon sheet ACTION on a character — this is how a monster's attack is triggered on a Beacon sheet, where the repeating_npcaction attributes do not exist (Mod Script Sandbox v1.5 only). List the available names with get_sheet_summary. The roll lands in Roll20 chat; the tool result reports that the sheet accepted the call, not what it rolled. If the name is not a Beacon action, Roll20 falls back to invoking a character ability of that name — the result flags that with known:false.",
    {
      actionName: z.string().describe("Beacon action name, as listed by get_sheet_summary"),
      args: z.record(z.string(), z.unknown()).optional().describe("Beacon's args payload for this action, if it takes one"),
      playerId: z.string().optional().describe("Roll20 player id to attribute the action to. Defaults to the GM running the relay."),
      characterName: z.string().optional(),
      charSheetId: z.string().optional(),
    },
    async ({ actionName, args, playerId, characterName, charSheetId }) => {
      const charId = await resolveCharSheetId(characterName, charSheetId);
      const r = await roll20.relayCommand<{ ok: boolean; action: string; known: boolean; note: string; sheet: SheetStamp }>(
        { action: "performAction", charId, actionName, args, playerId }
      );
      if (!r.known) {
        return text(`Dispatched "${actionName}" on character ${charId}, but it is NOT in Campaign().actionSummary — ` +
          `Roll20 will have fallen back to a character ability of that name, and if there is no such ability nothing happened. ` +
          `Run get_sheet_summary to see the real action names.`);
      }
      return json({ charSheetId: charId, ...r });
    }
  );
}
