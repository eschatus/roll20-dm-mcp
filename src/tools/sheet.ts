import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as roll20 from "../bridge/roll20.js";
import { fail, failJson, json, resolveCharSheetId } from "./combatHelpers.js";

// ─────────────────────────────────────────────────────────────────────────────
// Beacon character sheet access (Mod Script Sandbox v1.5) — issue #205.
//
// A Beacon ("advanced") sheet keeps SOME of its character data in COMPUTED PROPERTIES rather than
// `attribute` objects. Data held that way is not reachable as an attribute — `findObjs` never sees
// it and an attribute write aimed at it is created, unread, and looks successful — so
// set_character_attribute refuses such a write rather than reporting a success that did nothing.
// It is NOT true that attributes are dead on a Beacon sheet: a live spike (#225) saw `setAttrs`
// write attributes, fire sheet workers and materialise `rollbase`/`attack_onhit` on a sandbox 1.5
// ogl5e campaign, and the RTDB probe (#230) found plain createObj("attribute") records landing in
// char-attribs there too. These are the carriers that reach the computed-property side:
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
    "What this campaign's character sheet actually offers: the Mod Script Sandbox version, the sheet name, whether it is a Beacon ('advanced') sheet, the list of Beacon COMPUTED PROPERTY names (usable with get/set_computed_property and get/set_sheet_item), the list of Beacon ACTION names (usable with perform_sheet_action), and which carrier functions exist in the sandbox. Call this FIRST when a character read or write comes back empty or refused — on a Beacon sheet, data held in computed properties is not reachable through the attribute tools (attributes still exist there; the computed side is simply a different store).",
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
    "Write character sheet fields the VERSION-AGNOSTIC way: on sandbox v1.0 this sets ordinary attributes, on v1.5 it also reaches Beacon computed properties and 'user.*' custom attributes. This is the tool set_character_attribute points you at when it refuses a write on a Beacon sheet. A value may be a scalar (sets 'current') or {current, max}. The write is STRICT by default — a property that is missing or read-only is reported as failed rather than reported as written, because Roll20's lenient mode resolves whether or not the write landed. If ANY field fails the result is an error (partial:true) that still lists which fields were written.",
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
      if (r.failed.length > 0) {
        // A partial write is still a failed write — the caller asked for the whole map. Keep the
        // structured result so they can see exactly which fields landed.
        return failJson({ charSheetId: charId, partial: true, ...r });
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
    "Write ONE writable Beacon computed property (Mod Script Sandbox v1.5 only). Roll20 does NOT publish where the new value sits inside setComputed's payload, so pass 'value' and/or 'args' and the relay forwards both verbatim rather than guessing a key that would write nothing. setComputed itself returns void, so the result carries a readBack — a read of the same property immediately afterwards, which is the only evidence the write landed. With a scalar 'value' the relay compares readBack against it: a mismatch is returned as an error (verified:false). An args-only write cannot be compared and comes back verified:null (unverified) — check readBack yourself. For anything that also exists as a plain attribute, prefer set_sheet_item.",
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
        ok: boolean; verified: boolean | null; property: string; known: boolean;
        readBack: unknown; readBackError?: string; note: string; sheet: SheetStamp;
      }>({ action: "setComputed", charId, property, value, args, playerId });
      if (!r.ok) {
        return failJson({ charSheetId: charId, ...r });
      }
      return json({ charSheetId: charId, ...r });
    }
  );

  server.tool(
    "perform_sheet_action",
    "Run a Beacon sheet ACTION on a character — this is how a monster's attack is triggered when the sheet defines it as a Beacon action held in computed data rather than as repeating_npcaction attribute rows (Mod Script Sandbox v1.5 only). If get_sheet_summary lists no actions but the character has repeating_npcaction rows, those rows are ordinary attributes and the attribute tools still reach them. List the available names with get_sheet_summary. The roll lands in Roll20 chat; the tool result reports that the sheet accepted the call, not what it rolled. `known` in the result: true = the name is in the sheet's action list; null = the sheet lists actions but their names could not be read, so the call went through unverified (check chat); false = not a Beacon action. In the false case Roll20 falls back to running a character ABILITY of that name as a chat macro — that is a sendChat outside the relay's chat-safety chokepoint, so it is REFUSED unless you pass allowAbilityFallback:true, and the result then flags abilityFallback:true. If neither an action nor an ability exists the call is refused rather than dispatched to nowhere.",
    {
      actionName: z.string().describe("Beacon action name, as listed by get_sheet_summary"),
      args: z.record(z.string(), z.unknown()).optional().describe("Beacon's args payload for this action, if it takes one"),
      playerId: z.string().optional().describe("Roll20 player id to attribute the action to. Defaults to the GM running the relay."),
      allowAbilityFallback: z.boolean().optional().describe("Explicitly permit Roll20's fallback to a same-named character ABILITY when actionName is not a Beacon action. The ability runs as a chat macro through Roll20's own sendChat; without this flag such a call is refused."),
      characterName: z.string().optional(),
      charSheetId: z.string().optional(),
    },
    async ({ actionName, args, playerId, allowAbilityFallback, characterName, charSheetId }) => {
      const charId = await resolveCharSheetId(characterName, charSheetId);
      const r = await roll20.relayCommand<{
        ok: boolean; action: string; known: boolean | null; abilityFallback: boolean; abilityId?: string;
        note: string; sheet: SheetStamp;
      }>({ action: "performAction", charId, actionName, args, playerId, allowAbilityFallback });
      return json({ charSheetId: charId, ...r });
    }
  );
}
