// ─────────────────────────────────────────────────────────────────────────────
// Token creation takes CALLER-SUPPLIED STATS (#171 Phase 2).
//
// These three tools used to look their own stats up in the D&D Beyond compendium,
// which coupled the MAPS suite to the DDB bridge and silently missed on reskins and
// homebrew. They now take what the caller resolved. Pinned here because they had no
// test at all before, and because two behaviours are easy to regress:
//   - create_pc_token must set controlledby, or the "PC" token it makes fails
//     isPcToken and its HP routes to bar1 like an NPC's.
//   - create_npc_token's `ac` used to be accepted and silently discarded.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { z } from "zod";
import { Roll20Emulator } from "./roll20-emulator.js";
import * as roll20 from "../src/bridge/roll20.js";
import * as registry from "../src/registry/characters.js";
import { registerTokenTools } from "../src/tools/tokens.js";
import { FakeMcpServer } from "./harness.js";
import { isPcToken } from "../src/tools/aoe.js";

let emu: Roll20Emulator;
let server: FakeMcpServer;
let pageId: string;

async function callTool(name: string, args: Record<string, unknown> = {}) {
  const entry = server.handlers.get(name);
  if (!entry) throw new Error(`No such tool registered: ${name}`);
  const parsed = entry.schema ? (z.object(entry.schema).parse(args) as Record<string, unknown>) : args;
  const res = await entry.handler(parsed);
  return { text: res?.content?.[0]?.text ?? "" };
}

const props = (id: string) => emu.tokenProps(id);
const idFrom = (t: string) => {
  const m = /roll20Id: ([^,)\s]+)/.exec(t);
  if (!m) throw new Error(`no token id in: ${t}`);
  return m[1];
};

beforeAll(() => {
  emu = new Roll20Emulator({ seed: 171 });
  emu.load();
  roll20.__setBridgeTestTransport({
    relay: <T>(cmd: Record<string, unknown>) => Promise.resolve(emu.relay<T>(cmd)),
    evaluate: <T>(fn: (args?: unknown) => T, args?: unknown) => {
      (globalThis as unknown as { window: unknown }).window = { Campaign: emu.campaignModel };
      return Promise.resolve(fn(args));
    },
  });
  server = new FakeMcpServer();
  registerTokenTools(server as never);
  pageId = emu.createPage("Token Creation");
  emu.setPlayerPage(pageId);
});

afterAll(() => {
  roll20.__setBridgeTestTransport(null as never);
});

describe("create_pc_token — caller-supplied stats", () => {
  it("writes the HP it was given and registers the character, with no DDB call", async () => {
    const { text } = await callTool("create_pc_token", {
      name: "Thorne", hp: 34, maxHp: 52, pageId, gridX: 5, gridY: 5, controlledBy: "player-thorne",
    });
    const id = idFrom(text);
    expect(Number(props(id).bar1_value)).toBe(34);
    expect(Number(props(id).bar1_max)).toBe(52);   // maxHp honored, not collapsed to hp
    expect(registry.lookup("Thorne")?.roll20TokenId).toBe(id);
  });

  it("sets controlledby so the token actually routes as a PC", async () => {
    const { text } = await callTool("create_pc_token", {
      name: "Wren", hp: 20, pageId, controlledBy: "player-wren",
    });
    const id = idFrom(text);
    expect(String(props(id).controlledby)).toBe("player-wren");
    // The routing predicate the HP/death paths actually use.
    expect(isPcToken({ controlledby: String(props(id).controlledby), name: "Wren" }, new Set())).toBe(true);
  });

  it("without controlledBy says so plainly — the token would route as an NPC", async () => {
    const { text } = await callTool("create_pc_token", { name: "Unclaimed", hp: 10, pageId });
    expect(text).toMatch(/routes as an NPC/);
    expect(isPcToken({ controlledby: String(props(idFrom(text)).controlledby ?? ""), name: "Unclaimed" }, new Set())).toBe(false);
  });

  it("defaults bar1_max to hp when maxHp is omitted", async () => {
    const { text } = await callTool("create_pc_token", { name: "Fullhealth", hp: 27, pageId });
    const id = idFrom(text);
    expect(Number(props(id).bar1_value)).toBe(27);
    expect(Number(props(id).bar1_max)).toBe(27);
  });

  it("records ddbCharId for linkage without looking anything up", async () => {
    const { text } = await callTool("create_pc_token", { name: "Linked", hp: 15, pageId, ddbCharId: 130003005 });
    expect(text).toContain("ddbCharId: 130003005");
    expect(registry.lookup("Linked")?.ddbCharId).toBe(130003005);
  });
});

describe("create_npc_token / create_monster_token — caller-supplied stats", () => {
  it("seeds bar1 and bar1_max from the given hp", async () => {
    const { text } = await callTool("create_npc_token", { name: "Goblin A", hp: 7, pageId });
    const id = idFrom(text);
    expect(Number(props(id).bar1_value)).toBe(7);
    expect(Number(props(id).bar1_max)).toBe(7);
  });

  it("reports ac instead of silently discarding it", async () => {
    const { text } = await callTool("create_npc_token", { name: "Ogre", hp: 59, ac: 11, pageId });
    // The old handler destructured without `ac` — the value vanished with no trace.
    expect(text).toContain("AC 11");
    expect(text).toMatch(/not stored/);
  });

  it("create_monster_token behaves identically and reports cr", async () => {
    const { text } = await callTool("create_monster_token", {
      monsterName: "Bugbear", hp: 27, ac: 16, cr: "1", pageId,
    });
    const id = idFrom(text);
    expect(Number(props(id).bar1_value)).toBe(27);
    expect(String(props(id).name)).toBe("Bugbear");
    expect(text).toContain("AC 16");
    expect(text).toContain("CR 1");
  });

  it("places tokens on the grid the caller asked for", async () => {
    const { text } = await callTool("create_npc_token", { name: "Placed", hp: 5, pageId, gridX: 3, gridY: 4 });
    const id = idFrom(text);
    expect(Number(props(id).left)).toBe(3 * 70);
    expect(Number(props(id).top)).toBe(4 * 70);
  });
});
