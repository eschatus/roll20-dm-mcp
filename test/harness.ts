// ─────────────────────────────────────────────────────────────────────────────
// Test harness: wires the Roll20 emulator into the real bridge + tools.
//
//  - Routes roll20.relayCommand / evaluate through the in-memory emulator via the
//    bridge test seam (no browser).
//  - Injects a mock Anthropic client so the full tactics pipeline runs without
//    real API calls (the live-eval suite opts back into the real client).
//  - Provides a FakeMcpServer that captures the real combat/tactics tool handlers
//    so tests can invoke them exactly as the MCP server would (zod defaults + all).
//  - Seeds a "diverse tiered warband" encounter for the round test.
//
// Isolation: ROLL20_DATA_DIR + ROLL20_CAMPAIGN_ID/DDB_CAMPAIGN_ID are set by
// vitest.config so the character/campaign registries use a throwaway temp dir and
// never touch the real ./data files.
// ─────────────────────────────────────────────────────────────────────────────
import { z } from "zod";
import { Roll20Emulator } from "./roll20-emulator.js";
import * as roll20 from "../src/bridge/roll20.js";
import * as tactics from "../src/tools/tactics.js";
import * as characters from "../src/registry/characters.js";
import { registerCombatTools } from "../src/tools/combat.js";
import { registerTacticsTools } from "../src/tools/tactics.js";

// ── Fake MCP server ───────────────────────────────────────────────────────────
type ToolResult = { content: Array<{ type: string; text: string }> };
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

export class FakeMcpServer {
  readonly handlers = new Map<string, { schema: z.ZodRawShape | null; handler: ToolHandler }>();
  // Real signature is tool(name, description, schemaShape, handler); some calls
  // omit the schema. The handler is always last.
  tool(name: string, ..._rest: unknown[]): void {
    const handler = _rest[_rest.length - 1] as ToolHandler;
    const maybeSchema = _rest.length >= 3 ? _rest[_rest.length - 2] : null;
    const schema = maybeSchema && typeof maybeSchema === "object" ? (maybeSchema as z.ZodRawShape) : null;
    this.handlers.set(name, { schema, handler });
  }
}

// ── Mock Anthropic ────────────────────────────────────────────────────────────
export interface MockCall { userContent: string; model: string }

export function makeMockAnthropic(planner?: (userContent: string) => string) {
  const calls: MockCall[] = [];
  const client = {
    messages: {
      create: async (params: Record<string, unknown>) => {
        const msgs = params.messages as Array<{ content: string }>;
        const userContent = String(msgs?.[0]?.content ?? "");
        calls.push({ userContent, model: String(params.model) });
        const text = (planner ?? defaultPlanner)(userContent);
        return { content: [{ type: "text", text }], stop_reason: "end_turn", usage: {} };
      },
    },
  };
  return { client, calls };
}

// Deterministic stand-in for a tactical recommendation, in the tool's output shape.
function defaultPlanner(userContent: string): string {
  // Pull the acting creature's name out of the context if present (best-effort).
  const m = userContent.match(/It is ([^’'\n.]+?)'s turn/) ?? userContent.match(/\[SELF\][^\n]*\bname:\s*([^\n]+)/i);
  const who = m ? m[1].trim() : "the creature";
  return `**Move:** reposition for advantage · **Action:** attack the nearest wounded foe · **Note:** mock plan for ${who}`;
}

// ── Harness ───────────────────────────────────────────────────────────────────
export interface Harness {
  emu: Roll20Emulator;
  server: FakeMcpServer;
  mock: ReturnType<typeof makeMockAnthropic>;
  callTool(name: string, args?: Record<string, unknown>): Promise<{ text: string; json: unknown }>;
  teardown(): void;
}

export interface HarnessOptions {
  seed?: number;
  planner?: (userContent: string) => string;
  /** Use the real Anthropic client (live-eval suite). Default false = mock. */
  liveLLM?: boolean;
}

export function setupHarness(opts: HarnessOptions = {}): Harness {
  const emu = new Roll20Emulator({ seed: opts.seed });
  emu.load();

  roll20.__setBridgeTestTransport({
    relay: <T>(cmd: Record<string, unknown>) => Promise.resolve(emu.relay<T>(cmd)),
    evaluate: <T>(fn: (args?: unknown) => T, args?: unknown) => {
      // The page-eval closures used by the bridge read window.Campaign.* — point
      // window at the emulator's Campaign model and run them in Node.
      (globalThis as unknown as { window: unknown }).window = { Campaign: emu.campaignModel };
      return Promise.resolve(fn(args));
    },
  });

  const mock = makeMockAnthropic(opts.planner);
  if (!opts.liveLLM) tactics.__setAnthropicForTest(mock.client as never);

  const server = new FakeMcpServer();
  registerCombatTools(server as never);
  registerTacticsTools(server as never);

  async function callTool(name: string, args: Record<string, unknown> = {}) {
    const entry = server.handlers.get(name);
    if (!entry) throw new Error(`No such tool registered: ${name}`);
    const parsed = entry.schema ? (z.object(entry.schema).parse(args) as Record<string, unknown>) : args;
    const res = await entry.handler(parsed);
    const text = res?.content?.[0]?.text ?? "";
    let json: unknown;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { text, json };
  }

  return { emu, server, mock, callTool, teardown: () => roll20.__setBridgeTestTransport(null) };
}

// ── Scenario: a diverse tiered warband ───────────────────────────────────────
// 2 PCs vs a mixed encounter spanning the tactical tiers, plus a spellcaster
// (AoE) and an emanation user, so one round exercises every tier, spells, zones,
// and auras. NPC stats are pre-baked into each token's gmnotes TACDATA cache so
// tactics planning is deterministic and never reaches for D&D Beyond.
export interface WarbandToken {
  name: string;
  id: string;
  charId: string;
}

export interface Warband {
  pageId: string;
  playerId: string;
  pcs: Record<string, WarbandToken>;
  npcs: Record<string, WarbandToken>;
}

const CELL = 70; // px per 5ft cell (scale 5)

function tacdata(int: number, wis: number, abilities: string): string {
  return "TACDATA:" + JSON.stringify({
    strength: 12, dexterity: 12, constitution: 12,
    intelligence: int, wisdom: wis, charisma: 10,
    abilitySummary: abilities,
  });
}

export function seedWarband(emu: Roll20Emulator): Warband {
  const pageId = emu.createPage("Crypt of the Tiered Warband");
  emu.setPlayerPage(pageId);
  const playerId = "player-001";

  const pc = (name: string, hp: number, x: number, y: number, attrs: Record<string, number | string>): WarbandToken => {
    const charId = emu.createCharacter(name, attrs, playerId);
    const tok = emu.createToken({
      pageid: pageId, name, represents: charId, controlledby: playerId,
      bar1_value: hp, bar1_max: hp, left: x * CELL, top: y * CELL,
    });
    characters.register(name, tok.id, 0);
    return { name, id: tok.id, charId };
  };

  const npc = (name: string, hp: number, x: number, y: number, int: number, wis: number, abilities: string): WarbandToken => {
    const charId = emu.createCharacter(name, {}, "");
    const tok = emu.createToken({
      pageid: pageId, name, represents: charId, controlledby: "",
      bar1_value: hp, bar1_max: hp, left: x * CELL, top: y * CELL,
      gmnotes: tacdata(int, wis, abilities),
    });
    characters.register(name, tok.id, 0);
    return { name, id: tok.id, charId };
  };

  // PCs clustered near the middle (so the emanation/AoE catch them).
  const pcs = {
    fighter: pc("Sir Aldric", 30, 10, 10, { wisdom: 12, perception: 14, ac: 18, spell_save_dc: 0 }),
    cleric:  pc("Mother Vance", 24, 11, 10, { wisdom: 16, religion: 16, ac: 16, spell_save_dc: 14 }),
  };

  // NPCs spanning the tactical tiers.
  const npcs = {
    // Tier 1 (Dim): Int 8 / Wis 8 → effective 8.
    goblinA: npc("Goblin Cutter", 7, 8, 9, 8, 8, "Scimitar: melee 1d6+2. Nimble Escape: disengage/hide as bonus action."),
    goblinB: npc("Goblin Cutter", 7, 9, 8, 8, 8, "Scimitar: melee 1d6+2. Nimble Escape: disengage/hide as bonus action."),
    // Tier 3 (Sharp): Int 12 / Wis 12 → 12.
    captain: npc("Hobgoblin Captain", 39, 8, 8, 12, 12, "Martial Advantage: +2d6 if ally adjacent to target. Leadership: allies add 1d4 to rolls."),
    // Tier 4 (Brilliant, medium cascade): Int 18 / Wis 16 → 17.
    warmage: npc("War Mage", 22, 7, 7, 18, 16, "Fireball: 20ft radius, DEX save DC 15 for half, 8d6 fire. Misty Step: teleport 30ft bonus action."),
    // Tier 5 (Mastermind, full cascade): Int 20 / Wis 22 → 21. Emanation user.
    cultist: npc("Arch-Cultist Zeno", 45, 11, 11, 20, 22, "Spirit Guardians: 15ft emanation, WIS save DC 16, 3d8 radiant, half speed. Counterspell. Reads enemy weaknesses."),
  };

  return { pageId, playerId, pcs, npcs };
}
