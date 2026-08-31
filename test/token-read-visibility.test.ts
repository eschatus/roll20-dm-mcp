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
// "pc" | "npc" | "sidekick" — derived from the SAME registry fact the routing
// reads (classifyToken + listSidekickNames), never a second source of truth.
//
// NOTE: the issue's "second, smaller ask" (a distinct `familiar` class) was
// tried and reverted — see the DM's correction on PR #197: a familiar, an
// animal companion, and a summon are not a distinct case, they're all just a
// player-controlled NPC, exactly what `sidekick` already models. They route
// identically, so a per-flavor enum value would have been surface without
// behavior (and the next one would be `summon`, then `companion`...). The fix
// was broadening what "sidekick" means in the docs, not adding a class.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupHarness, type Harness } from "./harness.js";
import * as characters from "../src/registry/characters.js";

let h: Harness;
let pageId: string;
let pcId: string, npcId: string, sidekickId: string;

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
  // Stands in for any player-controlled NPC — sidekick, familiar, animal
  // companion, summon — they're all flagged the same way (see the DM's
  // correction above).
  h.emu.createToken({
    pageid: pageId, name: "Tua", controlledby: "player-win",
    bar1_value: 22, bar1_max: 22,
  });
  characters.setSidekick("Tua", true);

  pcId = tokenId("Winsome");
  npcId = tokenId("Goblin Grunt");
  sidekickId = tokenId("Tua");
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
  it("get_token reports tokenClass for a PC, NPC, and sidekick (player-controlled NPC)", async () => {
    const pc = await h.callTool("get_token", { tokenId: pcId });
    expect((pc.json as { tokenClass: string }).tokenClass).toBe("pc");

    const npc = await h.callTool("get_token", { tokenId: npcId });
    expect((npc.json as { tokenClass: string }).tokenClass).toBe("npc");

    const sidekick = await h.callTool("get_token", { tokenId: sidekickId });
    expect((sidekick.json as { tokenClass: string }).tokenClass).toBe("sidekick");
  });

  it("list_tokens reports the same tokenClass for every token on the page", async () => {
    const { json } = await h.callTool("list_tokens", { pageId });
    const rows = json as Array<{ id: string; tokenClass: string }>;
    const byId = new Map(rows.map((r) => [r.id, r.tokenClass]));
    expect(byId.get(pcId)).toBe("pc");
    expect(byId.get(npcId)).toBe("npc");
    expect(byId.get(sidekickId)).toBe("sidekick");
  });
});

// ── #196: set_token_class round-trip ────────────────────────────────────────
describe("#196 set_token_class", () => {
  it("accepts tokenClass:'sidekick' and persists the override", async () => {
    const { text } = await h.callTool("set_token_class", { characterName: "New Companion", tokenClass: "sidekick" });
    expect(text).toMatch(/New Companion set to sidekick/);
    expect(characters.isSidekick("New Companion")).toBe(true);
  });

  it("tokenClass:'pc' clears the override", async () => {
    characters.setSidekick("Test Clear Me", true);
    const { text } = await h.callTool("set_token_class", { characterName: "Test Clear Me", tokenClass: "pc" });
    expect(text).toMatch(/Test Clear Me set to pc/);
    expect(characters.isSidekick("Test Clear Me")).toBe(false);
  });
});
