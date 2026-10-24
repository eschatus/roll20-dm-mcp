import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as roll20 from "../bridge/roll20.js";
import { json, resolveTokenOrThrow } from "./combatHelpers.js";

// ─────────────────────────────────────────────────────────────────────────────
// set_bar — the SEMANTICS-FREE token-bar primitive (issue #246).
//
// Bars are just three numeric tracks on a token. What they MEAN (5e HP, SR6 Physical/Matrix/Edge,
// anything) is the caller's business, not this server's. So this tool does exactly one thing:
// change bar N's value and/or max, with an optional relative delta. It deliberately has NONE of
// the 5e HP interpretation that update_token_hp / setTokenBar carry: no wounded/dead markers, no
// thresholds, no PC gmnotes routing, no layer moves. That is also why it is allowed to touch
// bar1, which set_token_props refuses (bar1 there is reachable only through the HP tools).
//
// Why a NEW relay action ("setBar") rather than reusing setTokenProps: a delta needs a read and a
// write that cannot be interleaved with another write, and a linked bar must be written through
// its attribute. Both belong in the sandbox, in one call.
// ─────────────────────────────────────────────────────────────────────────────

const finite = z.number().refine(Number.isFinite, "must be a finite number");

const targetFields = {
  tokenId: z.string().optional().describe("Roll20 token ID — overrides characterName lookup."),
  characterName: z.string().optional().describe("Token/character name exactly as on the map."),
  bar: z.union([z.literal(1), z.literal(2), z.literal(3)]).describe("Which bar: 1, 2 or 3 (a bare number)."),
  value: finite.optional().describe("ABSOLUTE new current value. Not clamped — you said the number. Mutually exclusive with delta."),
  delta: finite.optional().describe("RELATIVE change to the current value, e.g. -3. Clamped to [0, max] unless clamp:false. Mutually exclusive with value."),
  max: finite.optional().describe("New MAX for the bar. May be combined with value or delta (max is applied first, so a delta clamps against the NEW max)."),
  clamp: z.boolean().optional().describe("Only governs delta. Default true: result is kept within [0, max]. clamp:false lets a delta run past the track (overflow damage)."),
};
const targetSchema = z.object(targetFields);
type BarTarget = z.infer<typeof targetSchema>;

/** Reject ambiguous or empty input before anything is sent. Exported for tests. */
export function validateBarTarget(t: BarTarget, label: string): void {
  if (!t.tokenId && !t.characterName) throw new Error(`${label}: provide tokenId or characterName`);
  if (t.value !== undefined && t.delta !== undefined) throw new Error(`${label}: pass value OR delta, not both`);
  if (t.value === undefined && t.delta === undefined && t.max === undefined) {
    throw new Error(`${label}: pass at least one of value, delta, max`);
  }
  if (t.clamp !== undefined && t.delta === undefined) throw new Error(`${label}: clamp only applies to delta`);
}

type BarResult = {
  tokenId: string; name: string; bar: number;
  before: { value: number | null; max: number | null };
  after: { value: number | null; max: number | null };
  clamped: boolean;
  linked: { attributeId: string; attributeName: string; wroteAttribute: boolean; wroteToken: boolean } | null;
};

export function registerBarTools(server: McpServer): void {
  server.tool(
    "set_bar",
    "Set or adjust ONE of a token's three bars (bar 1/2/3) with NO game semantics: no wounded/dead markers, no thresholds, no PC routing, no layer moves. Use it when the bars mean something other than 5e HP (e.g. Shadowrun: bar1 Physical, bar2 Matrix, bar3 Edge) or whenever you want a plain number change. It works on bar1, which set_token_props deliberately refuses (bar1 there belongs to the 5e HP tools — update_token_hp — which add PC routing, wounded at half, and death at 0; this tool is the semantics-free path and does none of that). Give EXACTLY ONE of value (absolute) or delta (relative, e.g. -3), and/or max; value+delta together is rejected. delta clamps to [0, max] unless clamp:false (overflow); a delta on a bar with no numeric value, or with clamp on and no numeric max, fails loudly rather than writing NaN. Target with tokenId or characterName. Bulk: pass targets[] (each item has the same fields) INSTEAD of the top-level fields — all items are validated before any write, so one bad item changes nothing. Linked bars: if the bar is linked to a character attribute (bar<N>_link), the ATTRIBUTE is read and written as the source of truth and the token bar is mirrored so they cannot drift; the result's `linked` field says what was written (null = unlinked, token only). This tool never creates or removes links. Returns before/after per token. Example: {\"characterName\":\"Barghest\",\"bar\":1,\"delta\":-3}.",
    {
      ...targetFields,
      bar: targetFields.bar.optional().describe("Which bar: 1, 2 or 3 (a bare number). Required unless using targets[]."),
      targets: z.array(targetSchema).min(1).optional().describe("Bulk form: an array of {tokenId|characterName, bar, value|delta, max, clamp}. Use INSTEAD of the top-level target fields."),
    },
    async ({ targets, ...single }) => {
      const hasSingle = Object.values(single).some((v) => v !== undefined);
      let items: BarTarget[];
      if (targets) {
        if (hasSingle) throw new Error("Pass targets[] OR the top-level fields, not both");
        items = targets;
      } else {
        if (single.bar === undefined) throw new Error("set_bar: bar (1, 2 or 3) is required");
        items = [single as BarTarget];
      }
      items.forEach((t, i) => validateBarTarget(t, targets ? `targets[${i}]` : "set_bar"));

      // Resolve every name BEFORE the first write: an ambiguous name must stop the whole call.
      const resolved = [];
      for (const t of items) {
        resolved.push({
          tokenId: t.tokenId ?? (await resolveTokenOrThrow(t.characterName as string)),
          bar: t.bar, value: t.value, delta: t.delta, max: t.max, clamp: t.clamp,
        });
      }

      const res = await roll20.relayCommand<{ ok: boolean; results: BarResult[] }>({ action: "setBar", targets: resolved });
      return json({ ok: true, results: res.results });
    }
  );
}
