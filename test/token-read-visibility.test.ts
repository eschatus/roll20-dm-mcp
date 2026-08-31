// ─────────────────────────────────────────────────────────────────────────────
// Issues #194 and #196 — read tools tell the truth about what they found.
//
// #194: get_token on a miss used to come back isError:false with a body of
// "null" — indistinguishable from a real success carrying a null token. It
// must now match the shape the write tools already use (fail(), isError:true).
//
// #196: set_token_class writes a per-character class override the server
// already routes HP/death on (see sidekick-routing.test.ts) but never handed
// back to a client. list_tokens and get_token now report `tokenClass` —
// "pc" | "npc" | "sidekick" | "familiar" — derived from the SAME registry
// fact the routing reads (classifyTokenDisplay → classifyToken +
// listSidekickNames/listFamiliarNames), never a second source of truth. A
// third `familiar` class is additive on top of `sidekick`: it routes
// identically (bar1 HP, NPC death semantics) but is a distinct, readable
// label for a companion/summon that isn't a party sidekick.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupHarness, type Harness } from "./harness.js";
import * as characters from "../src/registry/characters.js";

let h: Harness;
let pageId: string;
let pcId: string, npcId: string, sidekickId: string, familiarId: string;

function tokenId(name: string): string {
  const tokens = h.emu.relay<Array<{ id: string; name: string }>>({ action: "getTokens", pageId });
  const tok = tokens.find((t) => t.name === name);
  if (!tok) throw new Error(`Token not found in emulator: ${name}`);
  return tok.id;
}

beforeAll(() => {
  h = setupHarness({ seed: 194196 });
  pageId = h.emu.createPage("Token Read Visibility Tests");
  h.emu.setPlayerPage(pageId);

  h.emu.createToken({
    pageid: pageId, name: "Winsome", controlledby: "player-win",
    bar1_value: 25, bar1_max: 25,
  });
  h.emu.createToken({
    pageid: pageId, name: "Goblin Grunt", controlledby: "",
    bar1_value: 7, bar1_max: 7,
  });
  h.emu.createToken({
    pageid: pageId, name: "Tua", controlledby: "player-win",
    bar1_value: 22, bar1_max: 22,
  });
  characters.setSidekick("Tua", true);
  h.emu.createToken({
    pageid: pageId, name: "Sparkwing", controlledby: "player-win",
    bar1_value: 5, bar1_max: 5,
  });
  characters.setTokenClass("Sparkwing", "familiar");

  pcId = tokenId("Winsome");
  npcId = tokenId("Goblin Grunt");
  sidekickId = tokenId("Tua");
  familiarId = tokenId("Sparkwing");
});

afterAll(() => h.teardown());

// ── #194: get_token miss is a reported failure ─────────────────────────────
describe("#194 get_token miss reporting", () => {
  it("reports isError:true with a 'token not found' message for a nonexistent id", async () => {
    const { text, isError, json } = await h.callTool("get_token", { tokenId: "no-such-token-id" });
    expect(isError).toBe(true);
    expect(text).toMatch(/token not found: no-such-token-id/);
    // The failure must not ALSO look like a parseable "found nothing" success body.
    expect(json).toBeUndefined();
  });

  it("does not flag a real token as an error, and still returns its properties", async () => {
    const { isError, json } = await h.callTool("get_token", { tokenId: npcId });
    expect(isError).toBe(false);
    expect(json).toMatchObject({ id: npcId, name: "Goblin Grunt" });
  });
});

// ── #196: tokenClass on get_token / list_tokens ────────────────────────────
describe("#196 tokenClass read-back", () => {
  it("get_token reports tokenClass for a PC, NPC, sidekick, and familiar", async () => {
    const pc = await h.callTool("get_token", { tokenId: pcId });
    expect((pc.json as { tokenClass: string }).tokenClass).toBe("pc");

    const npc = await h.callTool("get_token", { tokenId: npcId });
    expect((npc.json as { tokenClass: string }).tokenClass).toBe("npc");

    const sidekick = await h.callTool("get_token", { tokenId: sidekickId });
    expect((sidekick.json as { tokenClass: string }).tokenClass).toBe("sidekick");

    const familiar = await h.callTool("get_token", { tokenId: familiarId });
    expect((familiar.json as { tokenClass: string }).tokenClass).toBe("familiar");
  });

  it("list_tokens reports the same tokenClass for every token on the page", async () => {
    const { json } = await h.callTool("list_tokens", { pageId });
    const rows = json as Array<{ id: string; tokenClass: string }>;
    const byId = new Map(rows.map((r) => [r.id, r.tokenClass]));
    expect(byId.get(pcId)).toBe("pc");
    expect(byId.get(npcId)).toBe("npc");
    expect(byId.get(sidekickId)).toBe("sidekick");
    expect(byId.get(familiarId)).toBe("familiar");
  });

  it("a familiar routes identically to a sidekick for HP writes (bar1, not tracked state)", async () => {
    const before = Number(h.emu.tokenProps(familiarId).bar1_value);
    const { text } = await h.callTool("update_token_hp", { tokenId: familiarId, damage: 2 });
    expect(Number(h.emu.tokenProps(familiarId).bar1_value)).toBe(before - 2);
    expect(text).not.toMatch(/\(tracked\)/);
  });
});

// ── #196: set_token_class familiar enum + registry round-trip ─────────────
describe("#196 set_token_class familiar", () => {
  it("accepts tokenClass:'familiar' and persists both sidekick+familiar flags", async () => {
    const { text } = await h.callTool("set_token_class", { characterName: "Sparkwing", tokenClass: "familiar" });
    expect(text).toMatch(/Sparkwing set to familiar/);
    expect(characters.isSidekick("Sparkwing")).toBe(true);
    expect(characters.listFamiliarNames().has("sparkwing")).toBe(true);
  });

  it("tokenClass:'pc' clears both the sidekick and familiar flags", async () => {
    characters.setTokenClass("Test Clear Familiar", "familiar");
    expect(characters.listFamiliarNames().has("test clear familiar")).toBe(true);

    const { text } = await h.callTool("set_token_class", { characterName: "Test Clear Familiar", tokenClass: "pc" });
    expect(text).toMatch(/Test Clear Familiar set to pc/);
    expect(characters.isSidekick("Test Clear Familiar")).toBe(false);
    expect(characters.listFamiliarNames().has("test clear familiar")).toBe(false);
  });

  it("tokenClass:'sidekick' does not mark familiar", async () => {
    const { text } = await h.callTool("set_token_class", { characterName: "Plain Sidekick", tokenClass: "sidekick" });
    expect(text).toMatch(/Plain Sidekick set to sidekick/);
    expect(characters.isSidekick("Plain Sidekick")).toBe(true);
    expect(characters.listFamiliarNames().has("plain sidekick")).toBe(false);
  });
});
