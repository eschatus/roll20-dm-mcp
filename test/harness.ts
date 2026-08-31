// ─────────────────────────────────────────────────────────────────────────────
// Test harness: wires the Roll20 emulator into the real bridge + tools.
//
//  - Routes roll20.relayCommand / evaluate through the in-memory emulator via the
//    bridge test seam (no browser).
//  - Provides a FakeMcpServer that captures the real combat tool handlers so tests
//    can invoke them exactly as the MCP server would (zod defaults + all).
//  - Seeds a "diverse tiered warband" encounter for the round test.
//
// No LLM seam here any more: the tactics cascade moved to the gem (#171), so nothing
// this harness drives calls a model. The warband's Int/Wis spread is kept because the
// turn/HP/marker tests read it as ordinary token data.
//
// Isolation: ROLL20_DATA_DIR + ROLL20_CAMPAIGN_ID/DDB_CAMPAIGN_ID are set by
// vitest.config so the character/campaign registries use a throwaway temp dir and
// never touch the real ./data files.
// ─────────────────────────────────────────────────────────────────────────────
import { z } from "zod";
import { Roll20Emulator } from "./roll20-emulator.js";
import * as roll20 from "../src/bridge/roll20.js";
import * as characters from "../src/registry/characters.js";
import { registerCombatTools } from "../src/tools/combat.js";
import { registerZoneTools } from "../src/tools/zones.js";

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

// ── Harness ───────────────────────────────────────────────────────────────────
export interface Harness {
  emu: Roll20Emulator;
  server: FakeMcpServer;
  callTool(name: string, args?: Record<string, unknown>): Promise<{ text: string; json: unknown }>;
  teardown(): void;
}

export interface HarnessOptions {
  seed?: number;
}

export function setupHarness(opts: HarnessOptions = {}): Harness {
  // The test seam is __setBridgeTestTransport (below), not an env var: relayCommand and
  // getCurrentPageId (src/bridge/roll20.ts) both check whether a test transport is installed
  // and, if so, route reads/writes through it instead of real RTDB/Firebase. There used to be a
  // ROLL20_TRANSPORT=browser env-var seam too, but it was already dead by the time it was
  // removed in #180 — the read paths it once gated (getCurrentPageId) had moved onto this same
  // _testTransport check, so setting it here was a no-op that nothing exercised.
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

  const server = new FakeMcpServer();
  registerCombatTools(server as never);
  registerZoneTools(server as never);

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

  return {
    emu, server, callTool,
    teardown: () => {
      roll20.__setBridgeTestTransport(null);
    },
  };
}

// ── Scenario: a diverse tiered warband ───────────────────────────────────────
// 2 PCs vs a mixed encounter spanning the tactical tiers, plus a spellcaster
// (AoE) and an emanation user, so one round exercises a mixed board, spells, zones,
// and auras. NPC stats stay pre-baked into each token's gmnotes TACDATA cache so the
// board is deterministic and no test reaches for D&D Beyond.
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
