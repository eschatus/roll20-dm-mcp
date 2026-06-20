import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as registry from "../registry/characters.js";
import * as ddb from "../bridge/dndbeyond.js";
import * as roll20 from "../bridge/roll20.js";
import { fireTacticsForPage } from "./tactics.js";
import {
  SAVE_ABILITIES, type SaveAbility, type AoeToken,
  saveAttrNames, resolveSaveBonus, damageOnSave,
  isPcToken, splitPcNpc, isDowned, resolveNamesToTokens, hasHpBar,
} from "./aoe.js";
import { getLastPing } from "../bridge/roll20-rt.js";
import {
  type TurnEntry, type BatchResult,
  text, json, indexBatchResults,
  tokenIdExists, resolveToken, resolveTokenOrThrow, resolveCharSheetId,
} from "./combatHelpers.js";

// ONE canonical condition table — Roll20 status marker tags for D&D 5e
// conditions, keyed by natural-language / DDB condition name. The marker-tag→
// condition lookup (RESERVED_MARKER_CONDITIONS, used by get_token_markers) is
// derived from this. Keep in sync with ai-relay.js CONDITION_MARKERS (the Roll20
// sandbox keeps its own separate copy — do not assume they share this module).
const CONDITION_MARKERS: { name: string; marker: string; label?: string }[] = [
  { name: "dead",          marker: "Unconscious::4444317", label: "unconscious / dead" },
  { name: "unconscious",   marker: "Unconscious::4444317", label: "unconscious / dead" },
  { name: "wounded",       marker: "Wounded::4444333",     label: "wounded / bloodied" },
  { name: "poisoned",      marker: "Poisoned::4444329" },
  { name: "blinded",       marker: "Blinded::4444318" },
  { name: "charmed",       marker: "Charmed::4444320" },
  { name: "deafened",      marker: "Deafened::4444321" },
  { name: "frightened",    marker: "Feared::4444323",      label: "frightened" },
  { name: "grappled",      marker: "Grappled::4444314" },
  { name: "incapacitated", marker: "Incapacitated::4444325" },
  { name: "invisible",     marker: "Invisible::4444344" },
  { name: "paralyzed",     marker: "Paralyzed::4444327" },
  { name: "petrified",     marker: "Petrified::4444328" },
  { name: "prone",         marker: "Prone::4444315" },
  { name: "restrained",    marker: "Restrained::4444316" },
  { name: "stunned",       marker: "Stunned::4444331" },
  { name: "exhaustion",    marker: "Exhausted::4444322" },
];

// marker tag → the 5e condition it represents (first name wins for shared markers,
// e.g. Unconscious::… is shared by dead+unconscious). Used to flag RESERVED markers.
const RESERVED_MARKER_CONDITIONS: Record<string, string> = (() => {
  const out: Record<string, string> = {};
  for (const c of CONDITION_MARKERS) {
    if (!(c.marker in out)) out[c.marker] = c.label ?? c.name;
  }
  return out;
})();

// Average HP from the DDB compendium, keyed by lowercased monster name so a mob
// of identical tokens is a single lookup. Misses (unknown monster, network) cache
// as null so we don't retry them all session. Falls back to stripping a duplicate
// epithet (" the Savage") when the direct name search misses.
const monsterHpCache = new Map<string, number | null>();
async function resolveMonsterAvgHp(name: string): Promise<number | null> {
  const key = name.toLowerCase().trim();
  if (monsterHpCache.has(key)) return monsterHpCache.get(key)!;
  let hp: number | null = null;
  for (const candidate of [name, name.replace(/\s+the\s+\S+$/i, "")]) {
    try {
      const m = await ddb.getMonster(candidate);
      const avg = Number(m.averageHitPoints);
      if (isFinite(avg) && avg > 0) { hp = avg; break; }
    } catch { /* try next candidate */ }
    if (candidate === name && !/\s+the\s+\S+$/i.test(name)) break; // no epithet to strip
  }
  monsterHpCache.set(key, hp);
  return hp;
}

export function registerCombatTools(server: McpServer): void {
  server.tool(
    "get_token_markers",
    "List the campaign's token markers, split into RESERVED (tied to a mechanical condition — apply/clear with set_token_marker by condition name; it also tracks state) and AVAILABLE (free for ad-hoc visual use: buffs, concentration, GM annotations — apply by tag via set_token_props/batch_exec statusmarkers). Use this to find the correct name::id tag. NOTE: 'bloodied' is NOT a real marker (renders nothing) — use the Wounded marker. The built-in color dots (red/blue/green/brown/purple/pink/yellow) and 'dead' (renders as a red X over the whole token) are always available but not listed here.",
    {},
    async () => {
      const markers = await roll20.relayCommand<{ id: number; name: string; tag: string }[]>({ action: "getTokenMarkers" });
      const reserved: { name: string; tag: string; condition: string }[] = [];
      const available: { name: string; tag: string }[] = [];
      for (const m of markers) {
        const condition = RESERVED_MARKER_CONDITIONS[m.tag];
        if (condition) reserved.push({ name: m.name, tag: m.tag, condition });
        else available.push({ name: m.name, tag: m.tag });
      }
      const out = {
        note: "RESERVED = mechanical conditions; apply/clear via set_token_marker (condition name), which also writes tracked state. AVAILABLE = free visual markers; apply by tag via set_token_props/batch_exec statusmarkers. Don't repurpose RESERVED markers for decoration. 'bloodied' is not real — use Wounded. 'dead' (red-X overlay) + color dots are built-in.",
        reserved,
        available,
      };
      return json(out);
    }
  );

  server.tool(
    "set_token_marker",
    "Apply or clear a state on a token — sets the visible status sticker AND tracks the state. Pass ANY state name; the relay picks the icon and the tracking automatically: (1) true 5e conditions (poisoned, prone, frightened, blinded, charmed, deafened, grappled, incapacitated, invisible, paralyzed, petrified, restrained, stunned, unconscious, exhaustion, dead) get their canonical icon + sync to the character's tracked conditions; (2) common pseudo-conditions (bloodied, concentrating, blessed, bane, hasted, raging, marked, hidden, dodging, enlarged, flying, sleeping, burning, surprised, cursed, …) get a fixed well-known icon, DM-managed; (3) any OTHER name you invent (e.g. 'hunters-mark', 'charging-up') is auto-assigned a consistent icon and tracked in campaign state — list_custom_states shows these. NEVER use 'bloodied' worrying it won't show — it's handled. Use characterName or tokenId. For hit points use update_token_hp.",
    {
      condition: z.string().describe("Any state name. True conditions + pseudo-conditions get canonical icons; anything else is auto-assigned a consistent icon and tracked."),
      active: z.boolean().describe("true to apply, false to clear"),
      characterName: z.string().optional(),
      tokenId: z.string().optional().describe("Roll20 token ID — overrides characterName lookup"),
    },
    async ({ condition, active, characterName, tokenId }) => {
      let resolvedTokenId = tokenId;
      let charId: string | undefined;
      if (!resolvedTokenId) {
        if (!characterName) throw new Error("Provide characterName or tokenId");
        resolvedTokenId = await resolveTokenOrThrow(characterName);
      }
      // Resolve the linked character so condition STATE (active_conditions) syncs,
      // not just the sticker. toggleCondition handles both + the pseudo/custom tiers.
      const tok = await roll20.relayCommand<{ represents?: string } | null>({ action: "getTokenById", tokenId: resolvedTokenId });
      charId = tok?.represents || undefined;
      const res = await roll20.relayCommand<{ tier?: string; marker?: string }>({ action: "toggleCondition", tokenId: resolvedTokenId, charId, condition, active });
      const tierNote = res?.tier === "custom" ? " (custom state — icon auto-assigned + tracked)" : res?.tier === "pseudo" ? " (pseudo-condition)" : "";
      return text(`${condition} ${active ? "applied to" : "cleared from"} ${characterName ?? resolvedTokenId}${tierNote}`);
    }
  );

  server.tool(
    "list_custom_states",
    "List the ad-hoc DM-defined states currently being tracked (tier-2 custom states set via set_token_marker that aren't standard conditions or pseudo-conditions) — each with its auto-assigned icon tag and which tokens currently hold it. Use to answer 'who is <custom state>?' or to see what bespoke states are in play.",
    {},
    async () => {
      const states = await roll20.relayCommand<{ state: string; tag: string; tokens: { id: string; name: string }[] }[]>({ action: "getCustomStates" });
      if (!states.length) return text("No custom states currently tracked.");
      return json(states);
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
      return json(tokens.map((t) => ({
        id: t.id,
        name: t.name,
        layer: t.layer,
        controlledby: t.controlledby,
        represents: t.represents,
        hp: t.bar1_max ? `${t.bar1_value}/${t.bar1_max}` : null,
        statusmarkers: t.statusmarkers || "",
      })));
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
      return json(selection);
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
      speakAs: z.string().optional().describe("Name shown in chat as the roller. Default: 'The Bones'"),
      silent: z.boolean().default(false).describe("If true, roll is hidden from chat log (noarchive). Default false — rolls are visible."),
    },
    async ({ rolls, speakAs, silent }) => {
      const results = await roll20.relayCommand<{ label: string; formula: string; total: number; dice: number[]; error?: string }[]>({
        action: "rollFormulas",
        items: rolls,
        speakAs: speakAs ?? "The Bones",
        silent,
      });
      const lines = results.map((r) =>
        r.error
          ? `${r.label}: ERROR — ${r.error}`
          : `${r.label}: [${r.dice.join(", ")}] = **${r.total}**`
      );
      return text(lines.join("\n") + "\n\n" + JSON.stringify(results));
    }
  );

  server.tool(
    "batch_exec",
    "Execute multiple Roll20 operations in a single relay round-trip — eliminates per-call overhead for bulk combat updates. Use this instead of separate calls when applying damage/conditions to multiple tokens at once. TARGET BY NAME: set args.characterName to the token's on-map name (e.g. \"Mage the Twisted\") and the server resolves it to the right token — you do NOT need to call list_tokens first or pass raw token IDs. (tokenId still works if you already have one.) Supported actions: setTokenBar (HP), setTokenProps (aura/tint/name — put the values under args.props), toggleCondition (merge-add/remove one condition), syncConditionsToToken (replace all conditions; conditions:[] clears the standard-condition markers), getTokenById (read token state), setTurnOrder.",
    {
      ops: z.array(z.object({
        id: z.string().optional().describe("Optional label returned with the result for tracking which op is which"),
        action: z.enum(["setTokenBar", "setTokenProps", "toggleCondition", "syncConditionsToToken", "getTokenById", "setTurnOrder"])
          .describe("Relay action to execute"),
        args: z.record(z.string(), z.unknown()).describe("Arguments for the action. Target a token with characterName (preferred — server resolves it) or tokenId. For setTokenProps, put the properties to change under a `props` object."),
      })).min(1).max(50).describe("Operations to run. All execute in order; failures are per-op and don't abort the batch."),
    },
    async ({ ops }) => {
      // Actions that target a single token by id — these can be addressed by
      // characterName instead and resolved here.
      const TOKEN_ACTIONS = new Set(["setTokenBar", "setTokenProps", "toggleCondition", "syncConditionsToToken", "getTokenById"]);
      const validId = (v: unknown) => typeof v === "string" && v.length > 0;
      const selectorOf = (a: Record<string, unknown>) =>
        [a.characterName, a.tokenName, a.targetName].find((s) => typeof s === "string" && s) as string | undefined;

      // Fetch the page token list ONCE if any op needs name→id resolution, so the
      // model never has to call list_tokens (and never burns a turn on a 0/N
      // failure from guessing a tokenId). Registry is consulted per-name first.
      const needsResolve = ops.some((op) => TOKEN_ACTIONS.has(op.action) && !validId((op.args as Record<string, unknown>)?.tokenId) && selectorOf((op.args ?? {}) as Record<string, unknown>));
      let pageTokens: { id: string; name: string }[] = [];
      if (needsResolve) {
        try {
          const pageId = await roll20.getCurrentPageId();
          pageTokens = await roll20.relayCommand<{ id: string; name: string }[]>({ action: "getTokens", pageId });
        } catch { /* resolution will fail per-op below with a clear message */ }
      }

      const resolveErrors = new Map<number, { id: string | number; error: string }>();
      const relayOps: { id?: string; action: string; args: Record<string, unknown> }[] = [];
      const relayOrigIndex: number[] = [];

      for (let i = 0; i < ops.length; i++) {
        const op = ops[i];
        const label = op.id ?? i;
        let args = { ...(op.args ?? {}) } as Record<string, unknown>;

        // 1. Resolve a characterName/tokenName selector → tokenId (token actions only).
        if (TOKEN_ACTIONS.has(op.action) && !validId(args.tokenId)) {
          const sel = selectorOf(args);
          if (sel) {
            const r = await resolveToken(sel, pageTokens);
            if (r.id) {
              args.tokenId = r.id;
            } else {
              resolveErrors.set(i, { id: label, error: `Could not resolve "${sel}"${r.candidates?.length ? ` — did you mean: ${r.candidates.join(", ")}?` : " (no matching token)"}` });
              continue; // don't relay an op we couldn't target
            }
          }
        }
        // Drop selector aliases so they aren't mistaken for props/relay args.
        delete args.characterName; delete args.tokenName; delete args.targetName;

        // 2. Normalize setTokenProps: models flatten fields ({tokenId, name})
        // instead of nesting under props. The relay only reads `props`, so a flat
        // call silently no-ops. Reshape so the change actually lands.
        if (op.action === "setTokenProps" && !(args.props && typeof args.props === "object")) {
          const { tokenId, id: _id, action: _action, ...rest } = args;
          args = { tokenId, props: rest };
        }

        relayOrigIndex.push(i);
        relayOps.push({ id: typeof label === "string" ? label : String(label), action: op.action, args });
      }

      const relayResults = relayOps.length
        ? await roll20.relayCommand<BatchResult[]>({ action: "batchExec", ops: relayOps })
        : [];

      // Merge relayed results + synthetic resolution failures back into op order.
      const merged: BatchResult[] = new Array(ops.length);
      relayResults.forEach((r, k) => { merged[relayOrigIndex[k]] = r; });
      for (const [i, e] of resolveErrors) merged[i] = { id: e.id, ok: false, error: e.error };

      // Guard against a short/long relay response (relayResults.length !== relayOps.length):
      // any op slot the relay didn't answer for stays undefined and would crash the
      // .filter(r => !r.ok) below. Fill those with an explicit failure so it's reported.
      if (relayResults.length !== relayOps.length) {
        for (let k = 0; k < relayOps.length; k++) {
          const slot = relayOrigIndex[k];
          if (merged[slot] === undefined) {
            merged[slot] = { id: relayOps[k].id ?? slot, ok: false, error: "no result returned by relay (batch response length mismatch)" };
          }
        }
      }
      // Final safety: ensure no undefined slot survives (e.g. unexpected gaps).
      for (let i = 0; i < merged.length; i++) {
        if (merged[i] === undefined) {
          merged[i] = { id: ops[i].id ?? i, ok: false, error: "no result returned for this op" };
        }
      }

      const failed = merged.filter((r) => !r.ok);
      const lines = merged.map((r) => (r.ok ? `✓ ${r.id}` : `✗ ${r.id}: ${r.error}`));
      const summary = `${merged.length - failed.length}/${merged.length} ops succeeded`;
      return text(`${summary}\n${lines.join("\n")}\n\n${JSON.stringify(merged)}`);
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
      // NB: kept inline — this tool destructures a `text` param, which shadows the text() helper.
      return { content: [{ type: "text", text: `Narration sent (style: ${style})` }] };
    }
  );

  server.tool(
    "roll_initiative",
    "Roll initiative for tokens on the current (or specified) page and load results into Roll20's turn order tracker. Use flatInit to place matched tokens at a fixed value instead of rolling. Use nameFilter to target a subset by name (e.g. 'goblin'). NPCs dropped on the map without an HP bar are auto-initialized from DDB average HP at this point (disable with initHp:false) so AoE/damage actually lands.",
    {
      pageId: z.string().optional().describe("Page to roll for. Defaults to the current player page."),
      npcOnly: z.boolean().default(true).describe("If true, skip tokens whose controlledby field contains a player ID (i.e. PC tokens)."),
      clearFirst: z.boolean().default(false).describe("Wipe the existing turn order before adding rolls. Set true at combat start."),
      flatInit: z.number().int().optional().describe("If set, place all matched tokens at this fixed initiative value instead of rolling."),
      nameFilter: z.string().optional().describe("Case-insensitive substring filter on token names. E.g. 'goblin' matches 'Goblin 1', 'Goblin Archer', etc."),
      publicRoll: z.boolean().default(true).describe("If true (default), posts a public gothic initiative card to chat showing all rolled tokens sorted by result. Pass false to roll silently."),
      nearPcsFeet: z.number().optional().describe("Only include NPCs within this many feet of any PC token — use at combat start so distant mobs elsewhere on the map don't join the fight. 60-90 is a good default when the DM just says 'roll inits'."),
      initHp: z.boolean().default(true).describe("Auto-initialize bar1/bar1_max from DDB average HP for any NPC combatant with no HP bar set (bar1_max unset → hp:null). PCs are never touched. Set false to skip the DDB lookups."),
    },
    async ({ pageId, npcOnly, clearFirst, flatInit, nameFilter, publicRoll, nearPcsFeet, initHp }) => {
      const activePage = pageId ?? (await roll20.getCurrentPageId());

      const tokens = await roll20.relayCommand<{ id: string; name: string; layer: string; controlledby: string; bar1_value?: number | string; bar1_max?: number | string }[]>({
        action: "getTokens",
        pageId: activePage,
      });

      // Proximity gate: union of findTokensInRange around each PC token. Reuses
      // the Mod's page-scale-aware geometry instead of reimplementing it here.
      let nearIds: Set<string> | null = null;
      if (nearPcsFeet !== undefined && nearPcsFeet > 0) {
        const pcTokens = tokens.filter((t) => isPcToken(t) && (t.layer === "tokens" || t.layer === "objects"));
        nearIds = new Set(pcTokens.map((t) => t.id)); // PCs always count as "near"
        for (const pc of pcTokens) {
          const nearby = await roll20.relayCommand<{ id: string }[]>({
            action: "findTokensInRange",
            centerTokenId: pc.id,
            radiusFeet: nearPcsFeet,
            pageId: activePage,
            layerFilter: "objects",
          }).catch(() => [] as { id: string }[]);
          for (const n of nearby ?? []) nearIds.add(n.id);
        }
      }

      const TOKEN_LAYERS = new Set(["tokens", "objects"]);
      const needle = nameFilter?.toLowerCase();
      const combatants = tokens.filter((t) => {
        if (!TOKEN_LAYERS.has(t.layer)) return false;
        if (npcOnly && t.controlledby && t.controlledby.trim() !== "") return false;
        if (needle && !t.name.toLowerCase().includes(needle)) return false;
        if (nearIds && !nearIds.has(t.id)) return false;
        return true;
      });

      if (combatants.length === 0) {
        const layers = [...new Set(tokens.map((t) => t.layer))];
        return text(`No tokens found on token layer. All graphic layers on this page: [${layers.join(", ")}]. Try list_tokens for full details.`);
      }

      // Auto-init HP bars for NPC combatants placed without one (bar1_max unset →
      // hp:null → damage/AoE silently no-ops). Look up average HP from DDB by the
      // token's (pre-epithet) name, one lookup per unique name, then write bar1 in
      // a single batch. PCs are never touched (Beyond20 owns their bars). Must run
      // BEFORE rollInitiativeForTokens, which renames duplicates with epithets.
      const hpInit = { set: [] as string[], missed: [] as string[] };
      if (initHp) {
        const needHp = combatants.filter((t) => !isPcToken(t) && !hasHpBar(t));
        if (needHp.length) {
          const avgByName = new Map<string, number | null>();
          for (const nm of new Set(needHp.map((t) => t.name))) avgByName.set(nm, await resolveMonsterAvgHp(nm));
          const ops = needHp
            .filter((t) => (avgByName.get(t.name) ?? 0) > 0)
            .map((t) => ({ id: `hpinit:${t.id}`, action: "setTokenBar", args: { tokenId: t.id, value: avgByName.get(t.name)!, max: avgByName.get(t.name)! } }));
          if (ops.length) await roll20.relayCommand({ action: "batchExec", ops });
          for (const t of needHp) {
            const hp = avgByName.get(t.name);
            if (hp && hp > 0) hpInit.set.push(`${t.name} → ${hp}`);
            else hpInit.missed.push(t.name);
          }
        }
      }

      // Roll20 turn order entry format: {id, pr (string), custom, _pageid}
      // _pageid is required — without it Roll20's tracker shows "no tokens on this stage"

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

      // clearFirst: strip NPC-controlled entries first (preserves PC player initiatives),
      // then upsert our new NPC rolls. Never does a full setTurnOrder([]) wipe.
      // Otherwise (default): upsert only, preserving everything.
      const merged = await roll20.relayCommand<{ ok: boolean; turnorder: TurnEntry[] }>({
        action: "mergeTurnOrder",
        entries: newEntries,
        clearNpcFirst: clearFirst,
      });
      const finalOrder = merged.turnorder ?? newEntries;
      await roll20.relayCommand({ action: "setTurnHook", enabled: true, reset: true });

      // Auto-fire tactics at combat start — whisper cards arrive as each mob's plan completes.
      if (clearFirst) void fireTacticsForPage(activePage);

      return json({
        rolledFor: newEntries.length,
        results: lines,
        turnOrder: finalOrder.map((e) => ({ id: e.id, pr: e.pr })),
        ...(hpInit.set.length ? { hpInitialized: hpInit.set } : {}),
        ...(hpInit.missed.length ? { hpLookupFailed: hpInit.missed } : {}),
      }, false);
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
      return text(String(raw));
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
      return json(resolved);
    }
  );

  server.tool(
    "clear_turn_order",
    "Wipe Roll20's initiative turn order (use between encounters).",
    {},
    async () => {
      await roll20.relayCommand({ action: "setTurnOrder", entries: [] });
      return text("Turn order cleared.");
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
      if (!result.ok) return text(result.note ?? "Turn order is empty.");
      return text(`Now up: **${result.current!.name}** (initiative ${result.current!.pr})`);
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
      const resolvedCharId = await resolveCharSheetId(characterName, charSheetId);
      const attrs = await roll20.relayCommand<Record<string, { current: unknown; max: unknown } | string | number>>({
        action: "getCharacterAttributes",
        charId: resolvedCharId,
        names: [attributeName],
      });
      // The relay's attr-collapse compaction returns a FLAT value (not {current,max}) when the
      // attribute's max is empty — which is the common case. Handle both shapes.
      const attr = attrs[attributeName];
      const isObj = attr !== null && typeof attr === "object";
      const current = isObj ? ((attr as { current: unknown }).current ?? null) : (attr ?? null);
      const max = isObj ? ((attr as { max: unknown }).max ?? null) : null;
      return json({ charSheetId: resolvedCharId, attribute: attributeName, current, max }, false);
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
      const resolvedCharId = await resolveCharSheetId(characterName, charSheetId);
      const attrValue = max !== undefined ? { current: value, max } : value;
      const result = await roll20.relayCommand<{ updated: string[]; created: string[]; failed: string[] }>({
        action: "setCharacterAttributes",
        charId: resolvedCharId,
        attributes: { [attributeName]: attrValue },
      });
      const status = result.updated.length ? "updated" : result.created.length ? "created" : "failed";
      return json({ charSheetId: resolvedCharId, attribute: attributeName, value, max, status }, false);
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
      const resolvedCharId = await resolveCharSheetId(characterName, charSheetId);
      const attrs = await roll20.relayCommand<Record<string, { current: unknown; max: unknown }>>({
        action: "getCharacterAttributes",
        charId: resolvedCharId,
        names,
      });
      return json({ charSheetId: resolvedCharId, attributes: attrs });
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

      return json({
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
      });
    }
  );

  server.tool(
    "update_token_hp",
    "The SINGLE HP primitive — replaces the old apply_damage and heal_character tools. Apply damage (clamps at 0), healing (clamps at max), or set HP to an exact value on ANY Roll20 token. Routes automatically by controlledby: a player-controlled token (PC) has its HP tracked in relay state (a block in the token's gmnotes) and its visible token bar is NEVER touched (Beyond20 owns it) — reported as '(tracked)'; an NPC's HP is its token bar1. Resolve by characterName (fuzzy/registry) or tokenId. Roll20-only — D&D Beyond is read-only and is NOT written. For CONDITIONS (poisoned, prone, dead, etc.) use set_token_marker instead — not this. (The condition args here are legacy/bulk-only.)",
    {
      characterName: z.string().optional().describe("USE THIS. The token/character name exactly as it appears on the map, e.g. 'Brie Mossfrond', 'Skeleton the Armored'. Resolved to the token automatically."),
      tokenId: z.string().optional().describe("Internal Roll20 ID only. Do NOT invent or guess this — if you don't have a real ID from a prior tool result, use characterName instead."),
      damage: z.number().int().min(0).optional().describe("Subtract this much from current HP (clamps at 0)"),
      heal: z.number().int().min(0).optional().describe("Add this much to current HP (clamps at bar1_max)"),
      setHp: z.number().int().min(0).optional().describe("Set HP to this exact value regardless of current"),
      addConditions: z.array(z.string()).optional().describe("Legacy/bulk: add conditions. Prefer set_token_marker."),
      removeConditions: z.array(z.string()).optional().describe("Legacy/bulk: remove conditions. Prefer set_token_marker."),
      replaceConditions: z.array(z.string()).optional().describe("Legacy/bulk: replace ALL conditions. Prefer set_token_marker."),
    },
    async ({ characterName, tokenId, damage, heal, setHp, addConditions, removeConditions, replaceConditions }) => {
      // If a raw tokenId was supplied (not name-resolved), validate it against the
      // page list FIRST — getTokenById on a bogus/hallucinated id hangs the relay
      // for 30s instead of failing fast (the 7B invented "skeleton1" and froze a turn).
      let resolvedTokenId = tokenId;
      if (resolvedTokenId && !(await tokenIdExists(resolvedTokenId))) resolvedTokenId = undefined;
      if (!resolvedTokenId) {
        if (!characterName) throw new Error("Provide characterName or tokenId");
        resolvedTokenId = await resolveTokenOrThrow(characterName);
      }
      type TokenData = { id: string; bar1_value: number; bar1_max: number; name: string; controlledby?: string };
      const token = await roll20.relayCommand<TokenData | null>({ action: "getTokenById", tokenId: resolvedTokenId });
      if (!token) throw new Error(`Token not found: ${characterName ?? tokenId}`);

      if (damage === undefined && heal === undefined && setHp === undefined) {
        throw new Error("Provide damage, heal, or setHp");
      }

      const isPc = isPcToken(token);
      let newHp: number;
      let maxHp: number;

      if (isPc) {
        // PC HP is tracked in relay state (a block in the token's gmnotes), routed by
        // controlledby — NEVER the visible token bar (Beyond20 owns a player's bar1).
        // adjustPcHp reads the tracked block, computes, and writes it back.
        const res = await roll20.relayCommand<{ current: number; max: number; name: string }>({
          action: "adjustPcHp",
          tokenId: resolvedTokenId,
          ...(damage !== undefined ? { damage } : {}),
          ...(heal !== undefined ? { heal } : {}),
          ...(setHp !== undefined ? { setHp } : {}),
        });
        newHp = res.current;
        maxHp = res.max;
      } else {
        // NPC: the token bar IS the source of truth. Guard a missing bar (writing to it
        // silently no-ops); setHp is allowed — it establishes a value.
        if (setHp === undefined && !hasHpBar(token)) {
          return text(`${token.name}: no HP bar set (bar1_max is empty) — ${damage !== undefined ? "damage" : "healing"} not applied. Roll initiative to auto-init NPC HP from DDB, set the bar in Roll20, or use setHp to establish one.`);
        }
        maxHp = Number(token.bar1_max) || 0;
        const currentHp = Number(token.bar1_value) || 0;
        if (setHp !== undefined) newHp = setHp;
        else if (damage !== undefined) newHp = Math.max(0, currentHp - damage);
        else newHp = maxHp ? Math.min(maxHp, currentHp + heal!) : currentHp + heal!;
        await roll20.relayCommand({ action: "setTokenProps", tokenId: resolvedTokenId, props: { bar1_value: newHp } });
      }

      if (replaceConditions !== undefined) {
        await roll20.relayCommand({ action: "syncConditionsToToken", tokenId: resolvedTokenId, conditions: replaceConditions });
      } else {
        for (const c of addConditions ?? []) {
          await roll20.relayCommand({ action: "toggleCondition", tokenId: resolvedTokenId, condition: c, active: true });
        }
        for (const c of removeConditions ?? []) {
          await roll20.relayCommand({ action: "toggleCondition", tokenId: resolvedTokenId, condition: c, active: false });
        }
      }

      const hpStr = (maxHp ? `${newHp}/${maxHp}` : String(newHp)) + (isPc ? " (tracked)" : "");
      const delta = damage !== undefined ? `-${damage}` : heal !== undefined ? `+${heal}` : `→${newHp}`;
      const condNote = replaceConditions !== undefined
        ? ` | conditions set: [${replaceConditions.join(", ") || "none"}]`
        : addConditions?.length || removeConditions?.length
          ? ` | +[${(addConditions ?? []).join(", ")}] -[${(removeConditions ?? []).join(", ")}]`
          : "";
      return text(`${token.name}: ${delta} HP → ${hpStr}${condNote}`);
    }
  );

  // Batch HP — ONE call hits many tokens, so the (weak-at-iteration) local model
  // never has to loop. Either list explicit names, or use nameMatch to hit every
  // token whose name contains a substring (e.g. "skeleton" → all skeletons).
  server.tool(
    "update_hp_many",
    "Apply the SAME damage or healing to MANY tokens in one call — use this for area effects ('40 to all the skeletons', 'whole party heals 8'). Either pass names[] (explicit list) OR nameMatch (a substring that selects every token whose name contains it, case-insensitive). Do NOT call update_token_hp repeatedly for an AoE — use this once.",
    {
      names: z.array(z.string()).optional().describe("Explicit token names, e.g. ['Skeleton the Armored','Skeleton the Cursed']"),
      nameMatch: z.string().optional().describe("Substring selecting all matching tokens, e.g. 'skeleton' hits every skeleton on the page"),
      damage: z.number().int().min(0).optional(),
      heal: z.number().int().min(0).optional(),
    },
    async ({ names, nameMatch, damage, heal }) => {
      if (damage === undefined && heal === undefined) throw new Error("Provide damage or heal");
      const pageId = await roll20.getCurrentPageId();
      type Tk = { id: string; name: string; bar1_value: number; bar1_max: number; controlledby?: string };
      const tokens = await roll20.relayCommand<Tk[]>({ action: "getTokens", pageId });

      let targets: Tk[] = [];
      if (nameMatch) {
        const m = nameMatch.trim().toLowerCase();
        targets = tokens.filter((t) => (t.name || "").toLowerCase().includes(m));
      }
      if (names?.length) {
        for (const want of names) {
          const w = want.trim().toLowerCase();
          const hit = tokens.find((t) => (t.name || "").trim().toLowerCase() === w)
                   ?? tokens.find((t) => (t.name || "").toLowerCase().includes(w));
          if (hit && !targets.some((x) => x.id === hit.id)) targets.push(hit);
        }
      }
      if (!targets.length) throw new Error(`No tokens matched ${nameMatch ? `'${nameMatch}'` : (names || []).join(", ")}`);

      // Route by controlledby: PCs track HP in relay state (gmnotes block) via adjustPcHp —
      // never their token bar (Beyond20 owns it); NPCs write bar1. NPCs need a real bar
      // (writing to a barless NPC silently no-ops); PCs don't (their HP lives in gmnotes).
      const { pcs, npcs } = splitPcNpc(targets);
      const noBar = npcs.filter((t) => !hasHpBar(t));
      const npcTargets = npcs.filter((t) => hasHpBar(t));
      if (!pcs.length && !npcTargets.length) {
        return text(`${damage !== undefined ? "−" + damage : "+" + heal} applied to 0/${noBar.length}: no HP bar — ${noBar.map((t) => (t.name || "").split("\n")[0].trim()).join(", ")} (roll initiative to auto-init NPC HP, or set bar1 in Roll20).`);
      }

      // Tag each op with the target token id so the per-op batch result can be
      // matched back to a token and any failure surfaced (don't blindly report all OK).
      type HpOp = { id: string; action: string; args: Record<string, unknown>; _name: string; _pc: boolean; _nv: number; _max: number };
      const ops: HpOp[] = [];
      for (const t of npcTargets) {
        const cur = Number(t.bar1_value) || 0, max = Number(t.bar1_max) || 0;
        const nv = damage !== undefined ? Math.max(0, cur - damage) : (max ? Math.min(max, cur + heal!) : cur + heal!);
        ops.push({
          id: t.id, action: "setTokenBar", args: { tokenId: t.id, value: nv, max: max || undefined },
          _name: (t.name || "").split("\n")[0].trim(), _pc: false, _nv: nv, _max: max,
        });
      }
      for (const t of pcs) {
        // adjustPcHp reads the tracked block and computes; the result carries the new value.
        ops.push({
          id: t.id, action: "adjustPcHp",
          args: { tokenId: t.id, ...(damage !== undefined ? { damage } : { heal }) },
          _name: (t.name || "").split("\n")[0].trim(), _pc: true, _nv: 0, _max: Number(t.bar1_max) || 0,
        });
      }

      const relayOps = ops.map(({ id, action, args }) => ({ id, action, args }));
      const results = await roll20.relayCommand<BatchResult[]>({ action: "batchExec", ops: relayOps });
      // indexBatchResults guarantees an entry per sent op (missing → failure).
      const byId = indexBatchResults(results, ops.map((o) => o.id));

      const okLines: string[] = [];
      const failLines: string[] = [];
      for (const op of ops) {
        const r = byId.get(op.id)!;
        if (r.ok) {
          if (op._pc) {
            const data = r.data as { current?: number; max?: number } | undefined;
            const max = data?.max || op._max || 0;
            okLines.push(`${op._name}: ${data?.current ?? "?"}${max ? "/" + max : ""} (tracked)`);
          } else {
            okLines.push(`${op._name}: ${op._nv}${op._max ? "/" + op._max : ""}`);
          }
        } else {
          failLines.push(`${op._name}: FAILED (${r.error ?? "no result returned by relay"})`);
        }
      }

      const verb = damage !== undefined ? `−${damage}` : `+${heal}`;
      const summary = `${verb} applied to ${okLines.length}/${targets.length}`;
      const body = [
        okLines.length ? okLines.join(" · ") : null,
        failLines.length ? `failed: ${failLines.join(" · ")}` : null,
        noBar.length ? `no HP bar: ${noBar.map((t) => (t.name || "").split("\n")[0].trim()).join(", ")}` : null,
      ].filter(Boolean).join(" | ");
      return text(`${summary}: ${body}`);
    }
  );

  server.tool(
    "get_token",
    "Read all properties of a single Roll20 token by ID — position, size, aura, statusmarkers, HP bars, layer, rotation, etc.",
    { tokenId: z.string().describe("Roll20 token ID") },
    async ({ tokenId }) => {
      const token = await roll20.relayCommand({ action: "getTokenById", tokenId });
      return json(token);
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
      return text(`Updated token ${tokenId}: ${Object.keys(props).join(", ")}`);
    }
  );

  server.tool(
    "get_recent_chat",
    "Read recent Roll20 chat messages. Includes Beyond20 dice roll output with inline roll results. Use this to read saving throw or attack roll results after players roll on DDB character sheets, then apply damage/conditions accordingly.",
    { limit: z.number().int().min(1).max(100).default(30).describe("Number of recent messages to return") },
    async ({ limit }) => {
      const messages = await roll20.relayCommand({ action: "getRecentChat", limit });
      return json(messages);
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
      return json(results);
    }
  );

  // One-call AoE resolution: target → NPC saves (real Roll20 dice, public) →
  // damage applied (half on save) → conditions on failure. PCs in the area are
  // REPORTED ONLY — they roll their own saves via Beyond20 and their HP/bars are
  // never touched here.
  server.tool(
    "resolve_aoe",
    "Resolve an area-of-effect spell in ONE call: finds targets, rolls NPC saving throws publicly via Roll20's dice engine, applies damage (half on save by default), and optionally applies a condition to NPCs that fail. PCs caught in the area are listed in the report but NEVER auto-rolled or damaged — players roll their own saves. For HEALING AoEs (Mass Cure Wounds, Healing Spirit, etc.) set healing:true: the formula is applied as positive HP to every resolved target (PCs included, via adjustPcHp), with no saves or conditions — pair it with targetNames to pick the allies. Target via ONE of: atPing + radiusFeet (centered on the GM's last shift+click map ping — the natural 'fireball lands THERE' gesture; draws a visible zone at the spot), centerTokenName/centerTokenId + radiusFeet (sphere/emanation), zoneName/zoneId (existing create_zone area), or targetNames (explicit list — use for cones/lines you judge by eye). Use dryRun:true to preview who's affected without rolling anything.",
    {
      label: z.string().describe("Effect name for chat roll labels, e.g. 'Fireball (Strahd)'"),
      atPing: z.boolean().default(false).describe("Center on the most recent shift+click map ping (within the last 3 minutes). Requires radiusFeet. Creates a visible zone named after the label — clear it later with clear_zone."),
      centerTokenName: z.string().optional().describe("Token name at the center (resolved exact-then-substring)"),
      centerTokenId: z.string().optional(),
      radiusFeet: z.number().optional().describe("Radius in feet when centering on a token or ping"),
      includeCenter: z.boolean().default(false).describe("Include the center token itself (false = emanation excludes caster)"),
      zoneName: z.string().optional().describe("Resolve against a named zone from create_zone"),
      zoneId: z.string().optional(),
      targetNames: z.array(z.string()).optional().describe("Explicit target names — for cones/lines or hand-picked targets"),
      excludeNames: z.array(z.string()).optional().describe("Names to exempt, e.g. allies dodging around the Web"),
      saveAbility: z.enum(SAVE_ABILITIES).optional().describe("Saving throw ability. Omit for no-save effects (e.g. Magic Missile volley)"),
      saveDc: z.number().int().optional().describe("Save DC. Required when saveAbility is set"),
      damageFormula: z.string().optional().describe("Dice formula rolled ONCE publicly for the whole effect, e.g. '8d6'. With healing:true this is the HEAL formula, e.g. '5d8' for Mass Cure Wounds."),
      damage: z.number().int().min(0).optional().describe("Flat damage (or, with healing:true, flat healing) instead of rolling"),
      healing: z.boolean().default(false).describe("true = restore HP instead of dealing it. The formula/flat amount is applied as POSITIVE HP to every resolved target (PCs route through adjustPcHp; NPCs write bar1). No saving throws, no conditions; downed creatures ARE included so you can heal them up. Use targetNames to hand-pick the allies you're healing (e.g. Mass Cure Wounds)."),
      halfOnSave: z.boolean().default(true).describe("true = save takes half (Fireball); false = save negates"),
      onFailCondition: z.string().optional().describe("Condition applied to NPCs that FAIL, e.g. 'restrained', 'prone'"),
      draw: z.enum(["zone", "aura", "none"]).default("zone").describe("Visual for the area: 'zone' (default) draws a circle on the map at the blast point — clear with clear_zone when it ends; 'aura' (token-centered mode only) sets a player-visible aura on the center token instead — right for emanations like Spirit Guardians that move with the caster; 'none' skips the visual. Ignored for zoneName/targetNames modes (nothing new to draw)."),
      color: z.string().default("#cc0000").describe("Zone/aura color as #hex"),
      dryRun: z.boolean().default(false).describe("Preview targets only — no rolls, no damage (atPing still draws its zone so you can see the spot)"),
      pageId: z.string().optional(),
    },
    async (args) => {
      const activePage = args.pageId ?? (await roll20.getCurrentPageId());
      if (args.saveAbility && args.saveDc === undefined) throw new Error("saveDc is required when saveAbility is set");
      if (args.healing && (args.saveAbility || args.onFailCondition)) {
        throw new Error("healing:true takes no saveAbility/onFailCondition — healing isn't saved against and applies no conditions");
      }
      if (args.healing && args.damageFormula === undefined && args.damage === undefined && !args.dryRun) {
        throw new Error("healing:true needs a damageFormula (e.g. '5d8') or flat damage amount to restore (or set dryRun:true to preview targets)");
      }
      if (!args.dryRun && args.damageFormula === undefined && args.damage === undefined && !args.onFailCondition) {
        throw new Error("Provide damageFormula, damage, or onFailCondition (or set dryRun:true to just preview targets)");
      }

      const all = await roll20.relayCommand<(AoeToken & { layer: string; left?: number; top?: number })[]>({ action: "getTokens", pageId: activePage });
      const byId = new Map(all.map((t) => [t.id, t]));
      const TOKEN_LAYERS = new Set(["tokens", "objects"]);

      // ── Targeting: one of four modes ──
      let targetIds: string[] = [];
      let centerId: string | undefined;
      let drawNote = "";
      if (args.atPing) {
        if (args.radiusFeet === undefined) throw new Error("radiusFeet is required with atPing");
        const ping = getLastPing();
        if (!ping) throw new Error("No recent map ping seen. Shift+click the spot in Roll20, then call again (rt transport must be connected).");
        const pingPage = ping.pageId || activePage;
        // The zone doubles as the visible AoE marker at the pinged spot.
        const zone = await roll20.relayCommand<{ id: string; name: string }>({
          action: "createZone", pageId: pingPage, name: args.label, shape: "circle",
          centerX: ping.x, centerY: ping.y, radiusFeet: args.radiusFeet, color: args.color,
        });
        const inZone = await roll20.relayCommand<{ id: string }[]>({ action: "findTokensInZone", zoneId: zone.id, pageId: pingPage });
        targetIds = (inZone ?? []).map((t) => t.id);
        drawNote = `Centered on map ping (${Math.round(ping.x)}, ${Math.round(ping.y)}); zone '${zone.name}' drawn — clear_zone when the effect ends.`;
      } else if (args.targetNames?.length) {
        const { matched, missed } = resolveNamesToTokens(args.targetNames, all);
        if (missed.length) throw new Error(`No token matched: ${missed.join(", ")}`);
        targetIds = matched.map((t) => t.id);
      } else if (args.zoneName || args.zoneId) {
        let zid = args.zoneId;
        if (!zid) {
          const zones = await roll20.relayCommand<{ id: string; name: string }[]>({ action: "listZones", pageId: activePage });
          const w = args.zoneName!.toLowerCase();
          const z = zones.find((x) => x.name.toLowerCase().includes(w));
          if (!z) throw new Error(`No zone matching '${args.zoneName}'. Active zones: ${zones.map((x) => x.name).join(", ") || "none"}`);
          zid = z.id;
        }
        const inZone = await roll20.relayCommand<{ id: string }[]>({ action: "findTokensInZone", zoneId: zid, pageId: activePage });
        targetIds = (inZone ?? []).map((t) => t.id);
      } else if (args.centerTokenName || args.centerTokenId) {
        if (args.radiusFeet === undefined) throw new Error("radiusFeet is required when centering on a token");
        centerId = args.centerTokenId;
        if (!centerId) {
          const { matched, missed } = resolveNamesToTokens([args.centerTokenName!], all);
          if (missed.length) throw new Error(`No token matched center '${args.centerTokenName}'`);
          centerId = matched[0].id;
        }
        const nearby = await roll20.relayCommand<{ id: string }[]>({
          action: "findTokensInRange", centerTokenId: centerId, radiusFeet: args.radiusFeet,
          pageId: activePage, layerFilter: "objects",
        });
        targetIds = (nearby ?? []).map((t) => t.id);
        if (args.includeCenter) targetIds.push(centerId);

        // Visual for token-centered blasts: a zone at the blast point (fixed
        // areas), or a player-visible aura that moves with the token (emanations
        // like Spirit Guardians — table convention is aura, not zone).
        const center = byId.get(centerId);
        if (args.draw === "zone" && !args.dryRun && center?.left !== undefined) {
          const zone = await roll20.relayCommand<{ id: string; name: string }>({
            action: "createZone", pageId: activePage, name: args.label, shape: "circle",
            centerX: center.left, centerY: center.top, radiusFeet: args.radiusFeet, color: args.color,
          });
          drawNote = `Zone '${zone.name}' drawn at ${center.name}'s position — clear_zone when the effect ends.`;
        } else if (args.draw === "aura" && !args.dryRun) {
          await roll20.relayCommand({
            action: "setTokenProps", tokenId: centerId,
            props: { aura1_radius: args.radiusFeet, aura1_color: args.color, showplayers_aura1: true },
          });
          drawNote = `Aura set on ${center?.name ?? "the center token"} (moves with the token) — clear with set_token_props aura1_radius 0.`;
        }
      } else {
        throw new Error("Target via atPing, centerTokenName/centerTokenId + radiusFeet, zoneName/zoneId, or targetNames");
      }

      // ── Filter: token layers only, no corpses, exclusions, center handling ──
      const excludeIds = new Set<string>();
      if (args.excludeNames?.length) {
        for (const t of resolveNamesToTokens(args.excludeNames, all).matched) excludeIds.add(t.id);
      }
      if (centerId && !args.includeCenter) excludeIds.add(centerId);

      const skippedDown: string[] = [];
      const targets: AoeToken[] = [];
      for (const id of new Set(targetIds)) {
        const t = byId.get(id);
        if (!t || !TOKEN_LAYERS.has(t.layer) || excludeIds.has(id) || !t.name) continue;
        // Healing brings creatures up FROM 0, so downed targets stay in; damage skips corpses.
        if (!args.healing && isDowned(t)) { skippedDown.push(t.name); continue; }
        targets.push(t);
      }
      const { pcs, npcs } = splitPcNpc(targets);

      // ── Healing: no saves, no conditions — restore HP to every resolved
      // target. Unlike damage, PCs are NOT spectators here: heal them via
      // adjustPcHp (Beyond20 owns their visible bar). NPCs write bar1 directly.
      if (args.healing) {
        if (args.dryRun) {
          return json({ wouldHeal: { pcs: pcs.map((p) => p.name), npcs: npcs.map((n) => n.name) }, drawNote: drawNote || undefined });
        }
        let heal = args.damage ?? 0;
        if (args.damageFormula) {
          const healRoll = await roll20.relayCommand<{ total: number; error?: string }[]>({
            action: "rollFormulas",
            items: [{ label: `${args.label} — healing`, formula: args.damageFormula }],
            speakAs: "The Bones", silent: false,
          });
          if (healRoll?.[0]?.error || healRoll?.[0]?.total === undefined) throw new Error(`Healing roll failed: ${healRoll?.[0]?.error ?? "no result"}`);
          heal = healRoll[0].total;
        }

        type Op = { id: string; action: string; args: Record<string, unknown> };
        const ops: Op[] = [];
        for (const n of npcs) {
          const cur = Number(n.bar1_value) || 0;
          const max = Number(n.bar1_max) || 0;
          ops.push({ id: `heal:${n.id}`, action: "setTokenBar", args: { tokenId: n.id, value: max ? Math.min(max, cur + heal) : cur + heal, max: max || undefined } });
        }
        for (const p of pcs) {
          ops.push({ id: `heal:${p.id}`, action: "adjustPcHp", args: { tokenId: p.id, heal } });
        }
        const batch = ops.length ? await roll20.relayCommand<BatchResult[]>({ action: "batchExec", ops }) : [];
        const opRes = indexBatchResults(batch, ops.map((o) => o.id));

        const healLines = [...pcs, ...npcs].map((t) => {
          const r = opRes.get(`heal:${t.id}`);
          if (r && !r.ok) return `${t.name}: heal FAILED (${r.error ?? "failed"})`;
          // adjustPcHp returns the new {current,max}; for NPCs we computed it ourselves.
          const data = r?.data as { current?: number; max?: number } | undefined;
          const max = Number(t.bar1_max) || data?.max || 0;
          const newHp = data?.current ?? (max ? Math.min(max, (Number(t.bar1_value) || 0) + heal) : (Number(t.bar1_value) || 0) + heal);
          return `${t.name}: +${heal}${max ? ` (${newHp}/${max})` : ` (→${newHp})`}`;
        });

        return text([
          `${args.label}: +${heal} healing to ${[...pcs, ...npcs].length} target(s)`,
          ...healLines,
          drawNote,
        ].filter(Boolean).join("\n"));
      }

      const pcNote = pcs.length
        ? `PCs in the area — they roll their own saves${args.saveAbility ? ` (${args.saveAbility.toUpperCase().slice(0, 3)} DC ${args.saveDc})` : ""}: ${pcs.map((p) => p.name).join(", ")}`
        : "No PCs in the area.";

      if (args.dryRun) {
        return json({ wouldAffect: { npcs: npcs.map((n) => n.name), pcs: pcs.map((p) => p.name), skippedDown }, drawNote: drawNote || undefined });
      }

      // ── Damage: one public roll for the whole effect ──
      let dmg = args.damage ?? 0;
      if (args.damageFormula) {
        const dmgRoll = await roll20.relayCommand<{ total: number; error?: string }[]>({
          action: "rollFormulas",
          items: [{ label: `${args.label} — damage`, formula: args.damageFormula }],
          speakAs: "The Bones", silent: false,
        });
        if (dmgRoll?.[0]?.error || dmgRoll?.[0]?.total === undefined) throw new Error(`Damage roll failed: ${dmgRoll?.[0]?.error ?? "no result"}`);
        dmg = dmgRoll[0].total;
      }

      // ── NPC saves: bonus per unique sheet (mobs share), one public batch roll ──
      type NpcResult = { token: AoeToken; bonus: number; source: string; total?: number; saved: boolean; applied: number; noBar?: boolean };
      const npcResults: NpcResult[] = [];
      if (args.saveAbility && npcs.length) {
        const bonusByChar = new Map<string, { bonus: number; source: string }>();
        for (const npc of npcs) {
          const charId = npc.represents || "";
          if (charId && !bonusByChar.has(charId)) {
            const attrs = await roll20.relayCommand<Record<string, { current: unknown }>>({
              action: "getCharacterAttributes", charId, names: saveAttrNames(args.saveAbility),
            }).catch(() => null);
            bonusByChar.set(charId, resolveSaveBonus(attrs, args.saveAbility));
          }
          const b = charId ? bonusByChar.get(charId)! : { bonus: 0, source: "none" };
          npcResults.push({ token: npc, ...b, saved: false, applied: 0 });
        }
        const abilityLabel = args.saveAbility.toUpperCase().slice(0, 3);
        const saveRolls = await roll20.relayCommand<{ label: string; total: number; error?: string }[]>({
          action: "rollFormulas",
          items: npcResults.map((r) => ({
            label: `${r.token.name} — ${abilityLabel} save vs ${args.label}`,
            formula: `1d20${r.bonus >= 0 ? "+" : ""}${r.bonus}`,
          })),
          speakAs: "The Bones", silent: false,
        });
        for (let i = 0; i < npcResults.length; i++) {
          const roll = saveRolls?.[i];
          npcResults[i].total = roll?.total;
          npcResults[i].saved = roll?.total !== undefined && roll.total >= args.saveDc!;
        }
      } else {
        for (const npc of npcs) npcResults.push({ token: npc, bonus: 0, source: "none", saved: false, applied: 0 });
      }

      // ── Apply: HP deltas + fail conditions in one batch ──
      type Op = { id: string; action: string; args: Record<string, unknown> };
      const ops: Op[] = [];
      for (const r of npcResults) {
        r.applied = damageOnSave(r.saved, dmg, args.halfOnSave);
        if (r.applied > 0 && !hasHpBar(r.token)) {
          // No HP bar (bar1_max unset) → writing would silently no-op. Flag it so
          // the report says "no HP bar" rather than a phantom −X. A fail-condition
          // can still apply below.
          r.noBar = true;
        } else if (r.applied > 0) {
          const cur = Number(r.token.bar1_value) || 0;
          const max = Number(r.token.bar1_max) || 0;
          ops.push({
            id: `hp:${r.token.id}`, action: "setTokenBar",
            args: { tokenId: r.token.id, value: Math.max(0, cur - r.applied), max: max || undefined },
          });
        }
        if (!r.saved && args.onFailCondition) {
          ops.push({
            id: `cond:${r.token.id}`, action: "toggleCondition",
            args: { tokenId: r.token.id, charId: r.token.represents || undefined, condition: args.onFailCondition, active: true },
          });
        }
      }
      const batch = ops.length ? await roll20.relayCommand<BatchResult[]>({ action: "batchExec", ops }) : [];
      // Per-op result keyed by id; a sent op the relay didn't answer for becomes a
      // failure (was previously a silent success). errOf → error string, or
      // undefined when the op succeeded OR was never sent (e.g. no hp op for a 0-damage save).
      const opRes = indexBatchResults(batch, ops.map((o) => o.id));
      const errOf = (id: string): string | undefined => {
        const r = opRes.get(id);
        return r && !r.ok ? (r.error ?? "failed") : undefined;
      };

      // ── DM report (numbers are fine here — this never reaches players) ──
      const lines = npcResults.map((r) => {
        const cur = Number(r.token.bar1_value) || 0;
        const max = Number(r.token.bar1_max) || 0;
        const newHp = Math.max(0, cur - r.applied);
        const save = r.total !== undefined ? `save ${r.total} vs DC ${args.saveDc} ${r.saved ? "✓" : "✗"}` : "no save";
        const hpErr = errOf(`hp:${r.token.id}`);
        const condErr = errOf(`cond:${r.token.id}`);
        const condNote = !r.saved && args.onFailCondition ? (condErr ? ` cond FAILED(${condErr})` : ` +${args.onFailCondition}`) : "";
        if (r.noBar) return `${r.token.name}: ${save} → ${r.applied} damage NOT applied (no HP bar — roll initiative to auto-init, or set bar1)${condNote}`;
        if (hpErr) return `${r.token.name}: ${save} → FAILED to apply (${hpErr})`;
        return `${r.token.name}: ${save} → −${r.applied}${max ? ` (${newHp}/${max})` : ""}${newHp === 0 && max > 0 ? " DOWN" : ""}${condNote}`;
      });

      return text([
        `${args.label}: ${dmg} damage${args.saveAbility ? `, ${args.saveAbility.toUpperCase().slice(0, 3)} DC ${args.saveDc}${args.halfOnSave ? " half on save" : " negates on save"}` : ""}`,
        ...lines,
        pcNote,
        drawNote,
        skippedDown.length ? `Skipped (already down): ${skippedDown.join(", ")}` : "",
        npcResults.some((r) => Number(r.token.bar1_max) > 0 && Math.max(0, (Number(r.token.bar1_value) || 0) - r.applied) === 0)
          ? "Reminder: mark the fallen dead and move them to the map layer." : "",
      ].filter(Boolean).join("\n"));
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
    "remove_object",
    "Remove any Roll20 object (token, zone path, AoE template) by ID. Use after resolving a one-shot AoE spell to clean up the template token. Tries graphic first, then path.",
    {
      objectId: z.string().describe("Roll20 object ID to remove"),
      objectType: z.string().optional().describe("Roll20 type: 'graphic' (default) or 'path'"),
    },
    async ({ objectId, objectType }) => {
      const result = await roll20.relayCommand({ action: "removeObject", objectId, objectType });
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

  server.tool(
    "set_turn_hook",
    "Enable or disable the automatic turn announcement and end-of-round summary in Roll20 chat. The hook fires on turn order changes — posting the active combatant's name, HP bar, and conditions. At round end it posts a full party status summary. Call with reset=true at combat start to reset the round counter.",
    {
      enabled: z.boolean().describe("true to enable, false to disable"),
      reset: z.boolean().default(false).describe("Reset round counter and first-token tracking (use at combat start)"),
    },
    async ({ enabled, reset }) => {
      const result = await roll20.relayCommand({ action: "setTurnHook", enabled, reset });
      return json(result, false);
    }
  );

  server.tool(
    "check_turn_hook",
    "Check whether the turn announcement hook is enabled in the relay, and what round it's on. Use this at session start to verify the hook survived the last relay redeploy — if enabled is false but combat is active, call set_turn_hook with enabled=true to re-arm it.",
    {},
    async () => {
      const result = await roll20.relayCommand<{ enabled: boolean; round: number; firstTokenId: string | null }>({ action: "getTurnHookState" });
      const status = result.enabled ? `ENABLED (round ${result.round})` : "DISABLED";
      return text(`Turn hook: ${status}\n${JSON.stringify(result)}`);
    }
  );

  server.tool(
    "get_mob_plans",
    "Read the stored tactical plans for all mob tokens. Plans are set by plan_all_tactics and persist until overwritten by a fresh run. Returns a map of tokenId → { html, plan: { name, shortTerm, mediumTerm?, longGoal? } }.",
    {},
    async () => {
      const result = await roll20.relayCommand<Record<string, unknown>>({ action: "getMobPlans" });
      return json(result, false);
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

      return text(`Synced ${characterName}: HP ${currentHp}/${maxHp}, conditions: [${effectiveConditions.join(", ") || "none"}]`);
    }
  );

  server.tool(
    "get_dm_inbox",
    "Read player !dm messages — intents queued for upcoming turns, or queries needing answers. Intents are auto-consumed by the turn hook when the player's turn arrives; queries stay until answered.",
    { type: z.enum(["intent", "query"]).optional().describe("Filter by type. Omit to get all.") },
    async ({ type }) => {
      const entries = await roll20.relayCommand({ action: "getDmInbox", type });
      return json(entries);
    }
  );

  server.tool(
    "clear_dm_inbox",
    "Clear processed !dm entries from the queue. Use after answering player queries.",
    { playerName: z.string().optional().describe("Clear only this player's entries. Omit to flush all.") },
    async ({ playerName }) => {
      const result = await roll20.relayCommand({ action: "clearDmInbox", playerName });
      return json(result, false);
    }
  );

  server.tool(
    "whisper_player",
    "Whisper a message to a player by their Roll20 display name (GM→player, not shown to the table). Use to answer !dm queries or reply to a DM-inbox item.",
    {
      playerName: z.string().describe("Roll20 display name of the player to whisper (or 'gm' for a self-whisper)"),
      message: z.string().describe("Message content. Newlines are converted to <br>."),
    },
    async ({ playerName, message }) => {
      // Roll20 reports a GM's display name as "Name (GM)", but `/w` resolves by the BARE name —
      // strip that suffix. Then quote multi-word names so the Mod's `/w <name> <msg>` targets
      // correctly, and convert newlines. Matches the player-command whisper helper.
      const bare = playerName.replace(/\s*\(GM\)\s*$/i, "").trim();
      const target = bare === "gm" || !bare.includes(" ") ? bare : `"${bare}"`;
      const result = await roll20.relayCommand({ action: "whisperPlayer", playerName: target, message: message.replace(/\n/g, "<br>") });
      return json(result, false);
    }
  );

  server.tool(
    "inject_round_marker",
    "Insert or remove a synthetic 'Top of Order' marker at initiative 99 to mark the round start. Use this before roll_initiative to ensure the marker stays sorted at position 1 (rounds always begin with this sentinel before any actual combatant).",
    {
      active: z.boolean().describe("true to inject the marker, false to remove it"),
    },
    async ({ active }) => {

      const pageId = await roll20.getCurrentPageId();
      let current: TurnEntry[] = await roll20.relayCommand<TurnEntry[]>({ action: "getTurnOrder" });

      // Custom (non-token) entries use id="-1" in Roll20's API; detect by custom text
      const existing = current.findIndex((e) => e.id === "-1" && e.custom?.includes("Round"));

      if (active) {
        if (existing !== -1) {
          return text("Round Start marker already present.");
        }
        const marker: TurnEntry = {
          id: "-1",
          pr: "99",
          custom: "⏺ Round Start",
          _pageid: pageId,
          formula: "+1",
        };
        // Upsert the sentinel via mergeTurnOrder (atomic, preserves player entries —
        // no full-order write-back race). Merge keys on id ("-1" = the round marker).
        const merged = await roll20.relayCommand<{ ok: boolean; turnorder: TurnEntry[] }>({
          action: "mergeTurnOrder",
          entries: [marker],
        });
        current = (merged.turnorder ?? [marker, ...current]).slice();
      } else {
        if (existing === -1) {
          return text("Round Start marker not found.");
        }
        // Removal can't be expressed as a merge upsert — filter and write back the remainder.
        current = current.filter((_, i) => i !== existing);
        await roll20.relayCommand({ action: "setTurnOrder", entries: current });
      }

      // Sort by pr descending (for the reported order)
      current.sort((a, b) => Number(b.pr) - Number(a.pr));

      const action = active ? "Injected" : "Removed";
      return json({
        action,
        markerPresent: active,
        totalEntries: current.length,
        turnOrder: current.map((e) => ({ id: e.id, name: e.custom || e.id, pr: e.pr })),
      });
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


      const pageId = await roll20.getCurrentPageId();

      // insert/update upsert a SINGLE entry via mergeTurnOrder (atomic merge by id,
      // preserves every entry we don't pass — no full-order write-back race).
      // remove still needs a read-filter-write since merge can only upsert.
      let modified: TurnEntry[];
      if (operation === "insert" || operation === "update") {
        const entry: TurnEntry = {
          id: tokenId,
          pr: String(pr!),
          custom: name ?? "",
          _pageid: pageId,
        };
        const merged = await roll20.relayCommand<{ ok: boolean; turnorder: TurnEntry[] }>({
          action: "mergeTurnOrder",
          entries: [entry],
        });
        modified = (merged.turnorder ?? [entry]).slice().sort((a, b) => Number(b.pr) - Number(a.pr));
      } else {
        // Remove — read, filter out the target, write back the remainder.
        const current: TurnEntry[] = await roll20.relayCommand<TurnEntry[]>({ action: "getTurnOrder" });
        modified = current.filter((e) => e.id !== tokenId).sort((a, b) => Number(b.pr) - Number(a.pr));
        await roll20.relayCommand({ action: "setTurnOrder", entries: modified });
      }

      // Return summary
      const summary =
        operation === "insert"
          ? `Inserted ${tokenId} at initiative ${pr}`
          : operation === "update"
            ? `Updated ${tokenId} initiative to ${pr}`
            : `Removed ${tokenId}`;

      const resultOrder = modified.map((e) => ({ id: e.id, pr: e.pr }));
      return json({
        operation,
        summary,
        totalEntries: modified.length,
        turnOrder: resultOrder,
      });
    }
  );
}
