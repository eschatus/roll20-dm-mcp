// ─────────────────────────────────────────────────────────────────────────────
// Issue #217 — revive_token, the atomic inverse of kill_token.
//
// Undoing a wrong kill used to be four calls (update_token_hp setHp +
// set_token_marker dead:false + set_token_props layer:objects + roll_initiative),
// and a wrong kill happens by itself: a damage number that lands on the wrong NPC
// and crosses 0 gets that NPC killed by the threshold automation (#141). This
// suite drives the REAL revive_token MCP handler against the emulator
// (mod-scripts/ai-relay.js in a vm sandbox) and asserts all four effects land in
// ONE call — including the two things the manual chain got wrong most often: HP
// must not be left at 0 (the automation would re-kill the token) and the turn
// order must come back WITHOUT clobbering the players' entries.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupHarness, type Harness } from "./harness.js";
import * as characters from "../src/registry/characters.js";
import { relayVersionAtLeast } from "../src/bridge/relay-version.js";

let h: Harness;
let pageId: string;

const props = (id: string) => h.emu.tokenProps(id);
const bar = (id: string) => Number(props(id).bar1_value);
const layer = (id: string) => String(props(id).layer ?? "");
const markers = (id: string) => String(props(id).statusmarkers ?? "");
const gmnotes = (id: string) => String(props(id).gmnotes ?? "");

function parsePcHp(notes: string): { current: number; max: number } | null {
  const m = notes.match(/%%PCHP=(\{[\s\S]*?\})%%/);
  if (!m) return null;
  try { return JSON.parse(m[1]) as { current: number; max: number }; }
  catch { return null; }
}

/** Write the turn order directly, standing in for "combat was already running". */
function seedTurnOrder(entries: Array<{ id: string; pr: string; custom?: string }>): void {
  h.emu.relay({
    action: "setTurnOrder",
    entries: entries.map((e) => ({ id: e.id, pr: e.pr, custom: e.custom ?? "", _pageid: pageId })),
  });
}

function newToken(name: string, hp: number, controlledby = ""): string {
  return h.emu.createToken({
    pageid: pageId, name, controlledby, bar1_value: hp, bar1_max: hp,
  }).id;
}

beforeAll(() => {
  h = setupHarness({ seed: 217 });
  pageId = h.emu.createPage("Revive Tests");
  h.emu.setPlayerPage(pageId);
});

afterAll(() => h.teardown());

describe("revive_token — the four effects of an undone kill, in one call", () => {
  it("undoes kill_token: HP restored, dead cleared, back on the token layer, original initiative kept", async () => {
    const ogre = newToken("Ogre", 59);
    const pc = newToken("Sir Aldric", 30, "player-001");
    seedTurnOrder([{ id: pc, pr: "17" }, { id: ogre, pr: "11" }]);

    await h.callTool("kill_token", { tokenId: ogre });
    expect(layer(ogre)).toBe("map");
    expect(markers(ogre)).toMatch(/dead/);

    const { json } = await h.callTool("revive_token", { tokenId: ogre, hp: 14 });

    expect(bar(ogre)).toBe(14);
    expect(markers(ogre)).not.toMatch(/dead/);
    expect(layer(ogre)).toBe("objects");
    // The kill left the tracker entry alone, so the ORIGINAL pr comes back — no re-roll.
    expect(json).toMatchObject({ initiative: 11, initiativeSource: "preserved" });
    const order = h.emu.turnOrder();
    expect(order.find((e) => e.id === ogre)?.pr).toBe("11");
    // The player's entry is untouched — every turn-order write here is a merge upsert.
    expect(order.find((e) => e.id === pc)?.pr).toBe("17");
  });

  it("re-rolls initiative and upserts the entry when the kill took it with it", async () => {
    const orc = newToken("Orc", 15);
    const pc = newToken("Mother Vance", 24, "player-002");
    seedTurnOrder([{ id: pc, pr: "19" }, { id: "-1", pr: "99", custom: "⏺ Round Start" }]);

    await h.callTool("kill_token", { tokenId: orc });
    const { json } = await h.callTool("revive_token", { tokenId: orc, hp: 9 });

    const res = json as { initiative: number; initiativeSource: string; initiativeRoll?: string };
    expect(res.initiativeSource).toBe("rolled");
    expect(res.initiative).toBeGreaterThanOrEqual(1);
    expect(res.initiativeRoll).toMatch(/=\s*\d+/);
    const order = h.emu.turnOrder();
    expect(order.find((e) => e.id === orc)?.pr).toBe(String(res.initiative));
    // Player entry and round marker both survive the insert.
    expect(order.find((e) => e.id === pc)?.pr).toBe("19");
    expect(order.some((e) => e.id === "-1")).toBe(true);
  });

  it("restores an explicit pre-kill initiative when the DM passes one", async () => {
    const troll = newToken("Troll", 84);
    seedTurnOrder([{ id: troll, pr: "3" }]);

    const { json } = await h.callTool("revive_token", { tokenId: troll, hp: 40, initiative: 21 });

    expect(json).toMatchObject({ initiative: 21, initiativeSource: "explicit" });
    expect(h.emu.turnOrder().find((e) => e.id === troll)?.pr).toBe("21");
  });

  it("resolves the target by name, like kill_token", async () => {
    const id = newToken("Bugbear the Heavy-Handed", 27);
    characters.register("Bugbear the Heavy-Handed", id, 0);
    await h.callTool("kill_token", { characterName: "Bugbear the Heavy-Handed" });

    const { json } = await h.callTool("revive_token", { characterName: "Bugbear the Heavy-Handed", hp: 12 });

    expect(json).toMatchObject({ target: "Bugbear the Heavy-Handed", deadCleared: true, layer: "objects" });
    expect(bar(id)).toBe(12);
    expect(layer(id)).toBe("objects");
  });
});

describe("revive_token — the wrong-damage case the DM actually hits", () => {
  it("undoes a threshold auto-death (damage crossed 0) without leaving HP at 0", async () => {
    const skeleton = newToken("Skeleton", 13);
    seedTurnOrder([{ id: skeleton, pr: "8" }]);

    // The reported trigger: a damage number lands on the wrong NPC, crosses 0, and the
    // relay's own threshold automation kills it (dead marker + map layer).
    await h.callTool("update_token_hp", { tokenId: skeleton, damage: 20 });
    expect(bar(skeleton)).toBe(0);
    expect(layer(skeleton)).toBe("map");
    expect(markers(skeleton)).toMatch(/dead/);

    await h.callTool("revive_token", { tokenId: skeleton, hp: 13 });

    // HP above 0 is load-bearing: a revive to 0 would re-trigger the automation and
    // put the token straight back on the map layer.
    expect(bar(skeleton)).toBe(13);
    expect(layer(skeleton)).toBe("objects");
    expect(markers(skeleton)).not.toMatch(/dead/);
  });

  it("refuses hp:0 at the schema, so a revive can never re-trigger the death automation", async () => {
    const id = newToken("Zombie", 22);
    await expect(h.callTool("revive_token", { tokenId: id, hp: 0 })).rejects.toThrow();
    await expect(h.callTool("revive_token", { tokenId: id, hp: -5 })).rejects.toThrow();
  });

  it("leaves the wounded marker consistent with the HP it comes back at", async () => {
    const boar = newToken("Dire Boar", 42);
    await h.callTool("kill_token", { tokenId: boar });

    await h.callTool("revive_token", { tokenId: boar, hp: 10 }); // ≤ half of 42
    expect(markers(boar)).toMatch(/Wounded/);

    await h.callTool("revive_token", { tokenId: boar, hp: 42 }); // full
    expect(markers(boar)).not.toMatch(/Wounded/);
  });
});

describe("revive_token — HP routes three ways, like update_token_hp", () => {
  it("PC: HP goes to tracked state and the Beyond20-owned bar1 is never written", async () => {
    const id = newToken("Glint Klinkinski", 30, "player-glint");
    const barBefore = bar(id);
    await h.callTool("kill_token", { tokenId: id });

    const { json } = await h.callTool("revive_token", { tokenId: id, hp: 18 });

    expect(bar(id)).toBe(barBefore); // bar1 untouched — Beyond20 owns it
    expect(parsePcHp(gmnotes(id))?.current).toBe(18);
    expect((json as { hp: string }).hp).toMatch(/\(tracked\)/);
    expect(layer(id)).toBe("objects");
    expect(markers(id)).not.toMatch(/dead/);
  });

  it("SIDEKICK: HP goes to bar1, same as an NPC (issue #132 routing)", async () => {
    const id = newToken("Tua", 22, "player-glint");
    characters.setSidekick("Tua", true);
    await h.callTool("kill_token", { tokenId: id });

    const { json } = await h.callTool("revive_token", { tokenId: id, hp: 11 });

    expect(bar(id)).toBe(11);
    expect(parsePcHp(gmnotes(id))).toBeNull();
    expect((json as { hp: string }).hp).not.toMatch(/tracked/);
  });

  it("NPC with no HP bar: the revive establishes one, so later damage isn't refused", async () => {
    const id = h.emu.createToken({ pageid: pageId, name: "Bare Ghoul", controlledby: "" }).id;
    await h.callTool("revive_token", { tokenId: id, hp: 22 });

    expect(bar(id)).toBe(22);
    expect(Number(props(id).bar1_max)).toBe(22);
    const { text } = await h.callTool("update_token_hp", { tokenId: id, damage: 5 });
    expect(text).toMatch(/17\/22/);
  });
});

describe("revive_token — a mid-round revive never rewinds the active turn", () => {
  it("splices a re-rolled entry into the rotated order and leaves row 0 alone", async () => {
    const goblin = newToken("Goblin", 7);
    const fighter = newToken("Fighter", 30, "player-f");
    const ogre = newToken("Ogre", 59);
    const orc = newToken("Orc", 15);
    // Two turns in: Goblin is up, Fighter and Ogre have acted. Orc was killed and its row dropped.
    seedTurnOrder([{ id: goblin, pr: "8" }, { id: fighter, pr: "17" }, { id: ogre, pr: "11" }]);
    await h.callTool("kill_token", { tokenId: orc });

    const { json } = await h.callTool("revive_token", { tokenId: orc, hp: 9 });

    const order = h.emu.turnOrder();
    expect(order[0].id).toBe(goblin); // still Goblin's turn
    expect(order.map((e) => e.id)).toHaveLength(4);
    const pr = Number((json as { initiative: number }).initiative);
    const idx = order.findIndex((e) => e.id === orc);
    // Above Goblin → in the already-acted segment, sorted; else right after Goblin.
    if (pr > 8) {
      expect(idx).toBeGreaterThanOrEqual(1);
      const acted = order.slice(1).map((e) => Number(e.pr));
      expect(acted).toEqual([...acted].sort((a, b) => b - a));
    } else {
      expect(idx).toBe(1);
    }
    // Players' rows are untouched.
    expect(order.find((e) => e.id === fighter)?.pr).toBe("17");
  });

  it("explicit initiative lands at its slot without changing row 0 (the reviewer's example)", async () => {
    const goblin = newToken("Goblin B", 7);
    const fighter = newToken("Fighter B", 30, "player-fb");
    const ogre = newToken("Ogre B", 59);
    const orc = newToken("Orc B", 15);
    seedTurnOrder([{ id: goblin, pr: "8" }, { id: fighter, pr: "17" }, { id: ogre, pr: "11" }]);
    await h.callTool("kill_token", { tokenId: orc });

    await h.callTool("revive_token", { tokenId: orc, hp: 9, initiative: 6 });
    expect(h.emu.turnOrder().map((e) => e.id)).toEqual([goblin, orc, fighter, ogre]);

    await h.callTool("revive_token", { tokenId: orc, hp: 9, initiative: 15 });
    expect(h.emu.turnOrder().map((e) => e.id)).toEqual([goblin, fighter, orc, ogre]);
  });

  it("relay mergeTurnOrder keepTurn: re-slots an existing row, keeps round markers, never sorts row 0 away", () => {
    seedTurnOrder([
      { id: "tok-ogre", pr: "11" },
      { id: "tok-gob", pr: "8" },
      { id: "-1", pr: "99", custom: "⏺ Round Start" },
      { id: "tok-ftr", pr: "17" },
    ]);
    // A row that already exists moves to its new slot; row 0 stays.
    h.emu.relay({ action: "mergeTurnOrder", keepTurn: true, entries: [{ id: "tok-gob", pr: "20", custom: "", _pageid: pageId }] });
    expect(h.emu.turnOrder().map((e) => e.id)).toEqual(["tok-ogre", "-1", "tok-gob", "tok-ftr"]);
    // Row 0 itself is replaced in place when re-slotted.
    h.emu.relay({ action: "mergeTurnOrder", keepTurn: true, entries: [{ id: "tok-ogre", pr: "3", custom: "", _pageid: pageId }] });
    const order = h.emu.turnOrder();
    expect(order[0]).toMatchObject({ id: "tok-ogre", pr: "3" });
    // Without keepTurn the legacy sort still applies (roll_initiative & co. depend on it).
    h.emu.relay({ action: "mergeTurnOrder", entries: [{ id: "tok-new", pr: "50", custom: "", _pageid: pageId }] });
    expect(h.emu.turnOrder().map((e) => e.id)).toEqual(["-1", "tok-new", "tok-gob", "tok-ftr", "tok-ogre"]);
  });
});

describe("revive_token — PC initiative is player-owned", () => {
  it("does not roll for a true PC whose row is gone; reports pending and writes no entry", async () => {
    const pc = newToken("Thorne", 40, "player-thorne");
    const npc = newToken("Cultist", 9);
    seedTurnOrder([{ id: npc, pr: "12" }]);
    await h.callTool("kill_token", { tokenId: pc });

    const { json } = await h.callTool("revive_token", { tokenId: pc, hp: 25 });

    expect(json).toMatchObject({ initiative: null, initiativeSource: "pending" });
    expect((json as { summary: string }).summary).toMatch(/player rolls/);
    expect(layer(pc)).toBe("objects");
    expect(parsePcHp(gmnotes(pc))?.current).toBe(25);
    expect(h.emu.turnOrder().some((e) => e.id === pc)).toBe(false);
  });

  it("still restores a PC's row when the DM passes the pre-kill initiative", async () => {
    const pc = newToken("Mira", 40, "player-mira");
    seedTurnOrder([{ id: newToken("Cultist 2", 9), pr: "12" }]);
    await h.callTool("kill_token", { tokenId: pc });

    const { json } = await h.callTool("revive_token", { tokenId: pc, hp: 25, initiative: 14 });

    expect(json).toMatchObject({ initiative: 14, initiativeSource: "explicit" });
    expect(h.emu.turnOrder().find((e) => e.id === pc)?.pr).toBe("14");
  });
});

describe("revive_token — a stale deployed relay never gets a keepTurn write", () => {
  // keepTurn exists only from relay 2.9.0. An older relay drops the flag and re-sorts the order,
  // rewinding play to the top and firing the turn hook — so revive must not write there at all.
  const setup = async (name: string) => {
    const goblin = newToken(`${name} Goblin`, 7);
    const fighter = newToken(`${name} Fighter`, 30, `player-${name}`);
    const orc = newToken(`${name} Orc`, 15);
    // Mid-round: the Goblin (pr 8) is up, the Fighter (pr 17) has acted.
    seedTurnOrder([{ id: goblin, pr: "8" }, { id: fighter, pr: "17" }]);
    await h.callTool("kill_token", { tokenId: orc });
    return { goblin, fighter, orc };
  };

  it("relay 2.8.0: revives the token but leaves the order alone and says to redeploy", async () => {
    const { goblin, fighter, orc } = await setup("Stale");
    const before = h.emu.turnOrder().map((e) => `${e.id}:${e.pr}`);
    h.stubRelayAction("ping", { pong: true, version: "2.8.0" });
    h.clearRelayLog();
    let json: unknown;
    try {
      ({ json } = await h.callTool("revive_token", { tokenId: orc, hp: 9, initiative: 12 }));
    } finally {
      h.clearRelayFailures();
    }

    expect(json).toMatchObject({ initiative: null, initiativeSource: "pending" });
    const res = json as { initiativeNote: string; summary: string };
    expect(res.initiativeNote).toMatch(/v2\.8\.0/);
    expect(res.initiativeNote).toMatch(/[Rr]edeploy the relay/);
    expect(res.initiativeNote).toMatch(/initiative:12/);
    expect(res.summary).toMatch(/turn order NOT updated/);
    // HP / marker / layer still landed.
    expect(bar(orc)).toBe(9);
    expect(markers(orc)).not.toMatch(/dead/);
    expect(layer(orc)).toBe("objects");
    // Nothing touched the order: no write, no roll, and the Goblin is still up.
    expect(h.relayLog).not.toContain("mergeTurnOrder");
    expect(h.relayLog).not.toContain("rollInitiativeForTokens");
    expect(h.emu.turnOrder().map((e) => `${e.id}:${e.pr}`)).toEqual(before);
    expect(h.emu.turnOrder()[0].id).toBe(goblin);
    expect(h.emu.turnOrder().find((e) => e.id === fighter)?.pr).toBe("17");
  });

  it("unknown relay version (ping carries none): treated as stale, no roll and no write", async () => {
    const { orc } = await setup("Unknown");
    const before = h.emu.turnOrder().map((e) => `${e.id}:${e.pr}`);
    h.stubRelayAction("ping", { pong: true });
    h.clearRelayLog();
    let json: unknown;
    try {
      ({ json } = await h.callTool("revive_token", { tokenId: orc, hp: 9 }));
    } finally {
      h.clearRelayFailures();
    }

    expect(json).toMatchObject({ initiative: null, initiativeSource: "pending" });
    expect((json as { initiativeNote: string }).initiativeNote).toMatch(/unknown version/);
    expect(layer(orc)).toBe("objects");
    expect(h.relayLog).not.toContain("mergeTurnOrder");
    expect(h.relayLog).not.toContain("rollInitiativeForTokens");
    expect(h.emu.turnOrder().map((e) => `${e.id}:${e.pr}`)).toEqual(before);
  });

  it("a surviving row needs no write, so it is preserved even on a stale relay", async () => {
    const ogre = newToken("Stale Ogre", 59);
    seedTurnOrder([{ id: ogre, pr: "11" }]);
    await h.callTool("kill_token", { tokenId: ogre });
    h.stubRelayAction("ping", { pong: true, version: "2.8.0" });
    let json: unknown;
    try {
      ({ json } = await h.callTool("revive_token", { tokenId: ogre, hp: 14 }));
    } finally {
      h.clearRelayFailures();
    }
    expect(json).toMatchObject({ initiative: 11, initiativeSource: "preserved" });
  });
});

describe("relayVersionAtLeast", () => {
  it("compares dotted versions numerically and treats unreadable as too old", () => {
    expect(relayVersionAtLeast("2.9.0", "2.9.0")).toBe(true);
    expect(relayVersionAtLeast("2.10.0", "2.9.0")).toBe(true);
    expect(relayVersionAtLeast("3.0", "2.9.0")).toBe(true);
    expect(relayVersionAtLeast("2.8.9", "2.9.0")).toBe(false);
    expect(relayVersionAtLeast("2.9", "2.9.0")).toBe(true);
    expect(relayVersionAtLeast(null, "2.9.0")).toBe(false);
    expect(relayVersionAtLeast("2.9.0-beta", "2.9.0")).toBe(false);
  });
});

describe("revive_token — failure visibility", () => {
  it("surfaces a relay failure instead of reporting a revive that never happened", async () => {
    const id = newToken("Wight", 45);
    await h.callTool("kill_token", { tokenId: id });
    h.failRelayAction("setTokenProps", "injected relay failure: setTokenProps");
    try {
      await expect(h.callTool("revive_token", { tokenId: id, hp: 20 })).rejects.toThrow(/setTokenProps/);
    } finally {
      h.clearRelayFailures();
    }
    expect(layer(id)).toBe("map"); // still dead on the map layer — nothing pretended otherwise
  });

  it("a part-way failure names the committed steps and the repair call for each remaining one", async () => {
    const id = newToken("Ghast", 36);
    await h.callTool("kill_token", { tokenId: id });
    h.failRelayAction("setTokenProps", "injected relay failure");
    let message = "";
    try {
      await h.callTool("revive_token", { tokenId: id, hp: 20 });
    } catch (e) {
      message = (e as Error).message;
    } finally {
      h.clearRelayFailures();
    }
    expect(message).toMatch(/failed at step 'layer'/);
    expect(message).toMatch(/Committed: hp, dead/);
    expect(message).toMatch(/Still to do: layer, initiative/);
    // The repair is the idempotent tool itself — never roll_initiative (legacy sort rewinds the
    // turn, and it would roll a PC's initiative) or the per-step tools.
    expect(message).toContain(`re-run revive_token tokenId:"${id}" hp:20`);
    expect(message).toMatch(/initiative:N/);
    expect(message).not.toMatch(/roll_initiative|set_token_props|set_token_marker|update_token_hp/);
    // What the error says landed, did land.
    expect(bar(id)).toBe(20);
    expect(markers(id)).not.toMatch(/dead/);
    expect(layer(id)).toBe("map");
  });

  it("errors on a target that resolves to nothing", async () => {
    await expect(h.callTool("revive_token", { hp: 10 })).rejects.toThrow(/characterName or tokenId/);
  });
});
