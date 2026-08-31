// ─────────────────────────────────────────────────────────────────────────────
// Issue #195 — resolveToken is punctuation-sensitive.
//
// A spoken/transcribed name carries natural punctuation a board token's name
// doesn't ("Bandit Captain, the Scarred" vs "Bandit Captain the Scarred").
// Case was already folded; this proves punctuation now is too, at the shared
// chokepoint (resolveToken/resolveTokenOrThrow in combatHelpers.ts) that every
// by-name tool (update_token_hp, set_token_marker, kill_token, ...) routes
// through — driving the REAL update_token_hp and set_token_marker MCP handlers
// against the emulator, same pattern as hp-threshold-automation.test.ts.
//
// Safety property under test: normalization only WIDENS what matches. A
// normalization that newly collides two distinct token names must still
// degrade to the existing "did you mean" ambiguity refusal — never guess a
// write.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupHarness, type Harness } from "./harness.js";
import * as characters from "../src/registry/characters.js";

let h: Harness;
let pageId: string;

const bar = (id: string) => Number(h.emu.tokenProps(id).bar1_value);

function tokenId(name: string): string {
  const tokens = h.emu.relay<Array<{ id: string; name: string }>>({ action: "getTokens", pageId });
  const tok = tokens.find((t) => t.name === name);
  if (!tok) throw new Error(`Token not found in emulator: ${name}`);
  return tok.id;
}

beforeAll(() => {
  h = setupHarness({ seed: 195 });
  pageId = h.emu.createPage("Punctuation Resolution Tests");
  h.emu.setPlayerPage(pageId);

  h.emu.createToken({ pageid: pageId, name: "Bandit Captain the Scarred", controlledby: "", bar1_value: 30, bar1_max: 30 });
  h.emu.createToken({ pageid: pageId, name: "Ogre", controlledby: "", bar1_value: 40, bar1_max: 40 });
  h.emu.createToken({ pageid: pageId, name: "Skeleton the Cursed", controlledby: "", bar1_value: 13, bar1_max: 13 });
});

afterAll(() => h.teardown());

describe("update_token_hp — punctuation-insensitive name resolution (issue #195)", () => {
  it("resolves the exact repro: a comma-separated epithet matches the unpunctuated board name", async () => {
    const id = tokenId("Bandit Captain the Scarred");
    const { text } = await h.callTool("update_token_hp", {
      characterName: "Bandit Captain, The Scarred",
      damage: 19,
    });
    expect(bar(id)).toBe(11);
    expect(text).toMatch(/11\/30/);
  });

  it("still resolves the exact, unpunctuated name (no regression)", async () => {
    const id = tokenId("Ogre");
    await h.callTool("update_token_hp", { characterName: "Ogre", damage: 5 });
    expect(bar(id)).toBe(35);
  });

  it("tolerates a period and collapsed/extra whitespace the same way", async () => {
    const id = tokenId("Skeleton the Cursed");
    await h.callTool("update_token_hp", { characterName: "Skeleton.  the   Cursed", damage: 3 });
    expect(bar(id)).toBe(10);
  });

  it("tolerates a semicolon and a colon as the same class of difference as a comma", async () => {
    const idA = tokenId("Bandit Captain the Scarred");
    const before = bar(idA);
    await h.callTool("update_token_hp", { characterName: "Bandit Captain; the Scarred", damage: 1 });
    expect(bar(idA)).toBe(before - 1);

    await h.callTool("update_token_hp", { characterName: "Bandit Captain: the Scarred", damage: 1 });
    expect(bar(idA)).toBe(before - 2);
  });
});

describe("update_token_hp — punctuation normalization only WIDENS matches, never guesses (issue #195)", () => {
  it("a name that collides with two tokens ONLY after punctuation-folding still refuses as ambiguous", async () => {
    // Two distinct board tokens that are punctuation-only variants of each
    // other — case-and-punctuation-folded they are identical, so this MUST
    // refuse (did-you-mean) rather than silently pick one and write to it.
    h.emu.createToken({ pageid: pageId, name: "Iron, Golem", controlledby: "", bar1_value: 50, bar1_max: 50 });
    h.emu.createToken({ pageid: pageId, name: "Iron Golem", controlledby: "", bar1_value: 50, bar1_max: 50 });

    const idA = tokenId("Iron, Golem");
    const idB = tokenId("Iron Golem");
    const hpBefore = { a: bar(idA), b: bar(idB) };

    await expect(h.callTool("update_token_hp", { characterName: "Iron Golem", damage: 10 }))
      .rejects.toThrow(/Ambiguous target/i);

    // Neither token was written — refusal, not a guess.
    expect(bar(idA)).toBe(hpBefore.a);
    expect(bar(idB)).toBe(hpBefore.b);
  });

  it("a genuinely ambiguous name (unrelated to punctuation) still refuses, as before", async () => {
    h.emu.createToken({ pageid: pageId, name: "Guard A", controlledby: "", bar1_value: 11, bar1_max: 11 });
    h.emu.createToken({ pageid: pageId, name: "Guard B", controlledby: "", bar1_value: 11, bar1_max: 11 });

    await expect(h.callTool("update_token_hp", { characterName: "Guard", damage: 5 }))
      .rejects.toThrow(/Ambiguous target/i);
  });

  // DM-approved behaviour change surfaced by this PR (not just a punctuation
  // fix): resolveToken's exact-match branch used to be Array.find(), which
  // silently returned whichever of several IDENTICALLY-named tokens came
  // first. #199 (relay epithet renamer has no cross-call memory) means a
  // second roll_initiative can re-issue an epithet already on the board and
  // produce two truly duplicate-named tokens — this is a real, not merely
  // theoretical, way to hit it. Writing damage to an arbitrary one of two
  // identically-named tokens is a silent wrong write; refusing is correct,
  // same "only widen, never guess" principle the issue itself states,
  // applied to a case #195 didn't name.
  it("two unregistered tokens with the EXACT SAME name (no punctuation at all) refuse rather than silently resolving to whichever came first", async () => {
    // Deliberately NOT registered via characters.register()/setSidekick() —
    // resolveToken checks registry.lookup(name) BEFORE the token scan, and a
    // registered name would return the registered id without ever reaching
    // the exact-match filter() this test targets (seedWarband's two
    // identically-named "Goblin Cutter" tokens hit exactly this short-circuit
    // and don't exercise the fix, which is why this needs its own token
    // names, unregistered).
    const dupeName = "Goblin Skirmisher";
    const tokA = h.emu.createToken({ pageid: pageId, name: dupeName, controlledby: "", bar1_value: 7, bar1_max: 7 });
    const tokB = h.emu.createToken({ pageid: pageId, name: dupeName, controlledby: "", bar1_value: 7, bar1_max: 7 });
    const before = { a: bar(tokA.id), b: bar(tokB.id) };

    let caught: Error | undefined;
    try {
      await h.callTool("update_token_hp", { characterName: dupeName, damage: 3 });
    } catch (e) {
      caught = e as Error;
    }
    expect(caught, "expected update_token_hp to reject — a duplicate exact name must refuse, not silently pick one").toBeDefined();
    expect(caught!.message).toMatch(/Ambiguous target/i);
    // Both candidates named (the duplicate name appears twice in the
    // did-you-mean list) — proves the exact-match branch surfaced BOTH
    // tokens (filter) rather than collapsing to a single first hit (find).
    expect(caught!.message).toMatch(/Did you mean: Goblin Skirmisher, Goblin Skirmisher\?/);

    // Refusal, not a guess — neither token was written.
    expect(bar(tokA.id)).toBe(before.a);
    expect(bar(tokB.id)).toBe(before.b);
  });
});

describe("roll_initiative — entries[].match / names[] tolerate punctuation too (issue #195)", () => {
  it("entries[].match with a comma-epithet still selects the token", async () => {
    h.emu.createToken({ pageid: pageId, name: "Ghast the Ravenous", controlledby: "", bar1_value: 15, bar1_max: 15 });

    const { json } = await h.callTool("roll_initiative", {
      entries: [{ match: "Ghast, the Ravenous", bonus: 2 }],
      npcOnly: true,
      publicRoll: false,
    });
    const r = json as { results: string[]; entriesUnmatched?: string[] };
    expect(r.entriesUnmatched).toBeUndefined();
    expect(r.results.find((l) => l.startsWith("Ghast the Ravenous:"))).toMatch(/\+2 = /);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Issue #195 follow-up (DM comment on the issue) — the exact fixture and test
// table the DM specified, verifying every row named there:
//   Bandit Captain, The Scarred | Bandit Captain the Scarred | the Scarred |
//   Scarred | Bandit Captain (ambiguous, 4) | Road-Worn (hyphen survives)
//
// The DM's comment also records two things pinned here rather than re-derived:
//  - resolveToken's word-overlap fallback branch NEVER returns a single id —
//    it is candidates-only by construction (see the comment at that branch in
//    combatHelpers.ts). On this exact 4-epithet board, every token contains
//    "bandit", so a query that reaches that branch surfaces ALL FOUR as
//    "did you mean" candidates, not "no matching token".
//  - a renaming scheme (`<Epithet> (<Base>)`) was considered and rejected: it
//    still fails the comma case AND breaks "the Scarred", which resolves
//    today. Not retested here (nothing to assert against — the alternative
//    was never implemented) — recorded in the PR description instead.
// ─────────────────────────────────────────────────────────────────────────────
describe("resolveToken — issue-specified fixture: Bandit Captain the {Scarred, Desperate, Road-Worn, Grim}", () => {
  let epithetPageId: string;
  let scarredId: string;

  function idOn(name: string): string {
    const tokens = h.emu.relay<Array<{ id: string; name: string }>>({ action: "getTokens", pageId: epithetPageId });
    const tok = tokens.find((t) => t.name === name);
    if (!tok) throw new Error(`Token not found in emulator: ${name}`);
    return tok.id;
  }

  // Switching the active player page (resolveToken resolves against
  // roll20.getCurrentPageId(), i.e. whatever setPlayerPage last set) leaks
  // into every test that runs after this describe block in the same file
  // unless restored — the later set_token_marker suite targets a token on
  // the ORIGINAL pageId and would otherwise silently resolve against this
  // fixture's page instead (both pages have a "Bandit Captain the Scarred").
  let priorPlayerPageId: string;

  beforeAll(() => {
    priorPlayerPageId = h.emu.campaignModel.get("playerpageid") as string;
    epithetPageId = h.emu.createPage("Epithet Roster Fixture (issue #195)");
    h.emu.setPlayerPage(epithetPageId);
    for (const epithet of ["Scarred", "Desperate", "Road-Worn", "Grim"]) {
      h.emu.createToken({
        pageid: epithetPageId, name: `Bandit Captain the ${epithet}`, controlledby: "",
        bar1_value: 30, bar1_max: 30,
      });
    }
    scarredId = idOn("Bandit Captain the Scarred");
  });

  afterAll(() => {
    h.emu.setPlayerPage(priorPlayerPageId);
  });

  it("'Bandit Captain, The Scarred' (comma) resolves to the Scarred", async () => {
    const before = bar(scarredId);
    await h.callTool("update_token_hp", { characterName: "Bandit Captain, The Scarred", damage: 1 });
    expect(bar(scarredId)).toBe(before - 1);
  });

  it("'Bandit Captain the Scarred' (exact, unpunctuated) resolves to the Scarred", async () => {
    const before = bar(scarredId);
    await h.callTool("update_token_hp", { characterName: "Bandit Captain the Scarred", damage: 1 });
    expect(bar(scarredId)).toBe(before - 1);
  });

  it("'the Scarred' (short form) resolves to the Scarred", async () => {
    const before = bar(scarredId);
    await h.callTool("update_token_hp", { characterName: "the Scarred", damage: 1 });
    expect(bar(scarredId)).toBe(before - 1);
  });

  it("'Scarred' (bare epithet) resolves to the Scarred", async () => {
    const before = bar(scarredId);
    await h.callTool("update_token_hp", { characterName: "Scarred", damage: 1 });
    expect(bar(scarredId)).toBe(before - 1);
  });

  it("'Bandit Captain' alone is ambiguous across all 4 epithets (word-overlap branch, candidates-only by construction)", async () => {
    const before = bar(scarredId);
    let caught: Error | undefined;
    try {
      await h.callTool("update_token_hp", { characterName: "Bandit Captain", damage: 1 });
    } catch (e) {
      caught = e as Error;
    }
    expect(caught, "expected update_token_hp to reject").toBeDefined();
    expect(caught!.message).toMatch(/Ambiguous target/i);
    // All four epithets — not "no matching token" — because every one of
    // them contains "bandit" and the word-overlap fallback returns every
    // token it overlaps with, never a single best guess.
    for (const epithet of ["Scarred", "Desperate", "Road-Worn", "Grim"]) {
      expect(caught!.message).toContain(`Bandit Captain the ${epithet}`);
    }
    // Refusal, not a guess — nothing was written.
    expect(bar(scarredId)).toBe(before);
  });

  it("'Road-Worn' (hyphenated epithet) resolves — the hyphen is not stripped", async () => {
    const roadWornId = idOn("Bandit Captain the Road-Worn");
    const before = bar(roadWornId);
    await h.callTool("update_token_hp", { characterName: "Road-Worn", damage: 1 });
    expect(bar(roadWornId)).toBe(before - 1);
    // Note: this row alone does NOT prove the hyphen survives normalization —
    // normalizeNameForMatch runs on both the query and the token name, so
    // even a mutation that strips hyphens would strip them symmetrically and
    // this assertion would still pass (verified: adding "-" to PUNCT_RE does
    // not break this specific resolution, because "Road-Worn" doesn't collide
    // with "Scarred"/"Desperate"/"Grim" either way). The actual guard rail —
    // the test that WOULD fail if "-" were added to PUNCT_RE — is the literal
    // string assertion in src/tools/nameMatch.test.ts ("does NOT strip a
    // hyphen"), which pins normalizeNameForMatch("Road-Worn") === "road-worn"
    // directly. Keeping this row anyway because it's the resolution-level
    // proof the DM's table asked for and documents that a spoken hyphenated
    // epithet works end to end.
  });
});

describe("set_token_marker — same chokepoint, same tolerance (issue #195)", () => {
  it("resolves a comma-epithet name for a non-HP tool too (proves the shared chokepoint, not a local patch)", async () => {
    const id = tokenId("Bandit Captain the Scarred");
    const { text } = await h.callTool("set_token_marker", {
      characterName: "Bandit Captain, the Scarred",
      condition: "frightened",
      active: true,
    });
    // "frightened" maps to the campaign's custom "Feared" marker tag (see
    // CONDITION_MARKERS in combat.ts) — this asserts the write landed on the
    // right token, not the exact marker label.
    expect(String(h.emu.tokenProps(id).statusmarkers || "")).toMatch(/Feared/i);
    expect(text).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PR #198 review (Devin's automated review, three findings assessed VALID):
//   1. Punctuation-only selectors ("," / "...") normalize to "" and
//      String.includes("") is true for every name — an unguarded matcher
//      would treat that as a WILDCARD, e.g. update_hp_many applying damage
//      to the whole board. Most serious finding — fixed with a loud refusal
//      at every top-level selector param (nameMatch, nameFilter, names[]).
//   2. Collision handling was inconsistent — resolveNamesToTokens (aoe.ts)
//      and the registry short-circuit (resolveCharacterKey) still picked a
//      first match silently instead of refusing like resolveToken's own
//      exact-match branch already does. Fixed for consistency.
//   3. Adjacent punctuation ("Rigan,Stormcrow") used to fuse words together
//      by stripping to nothing instead of a space — covered at the pure
//      normalizeNameForMatch level (nameMatch.test.ts) and the registry
//      level (characters.test.ts); not re-tested at the tool level here.
// ─────────────────────────────────────────────────────────────────────────────
describe("update_hp_many — punctuation-only selectors must never wildcard the whole board (PR #198 finding 1)", () => {
  it("nameMatch of pure punctuation refuses loudly instead of applying damage to every token", async () => {
    const ogreId = tokenId("Ogre");
    const scarredId = tokenId("Bandit Captain the Scarred");
    const before = { ogre: bar(ogreId), scarred: bar(scarredId) };

    await expect(h.callTool("update_hp_many", { nameMatch: ",", damage: 5 }))
      .rejects.toThrow(/punctuation-only/i);

    // Nothing on the board was touched — refusal, not a wildcard write.
    expect(bar(ogreId)).toBe(before.ogre);
    expect(bar(scarredId)).toBe(before.scarred);
  });

  it("names[] containing only punctuation-only entries refuses (no tokens matched), never wildcards", async () => {
    const ogreId = tokenId("Ogre");
    const before = bar(ogreId);

    await expect(h.callTool("update_hp_many", { names: [",", "..."], damage: 5 }))
      .rejects.toThrow(/No tokens matched/i);

    expect(bar(ogreId)).toBe(before);
  });

  it("a punctuation-only entry mixed into a valid names[] list is dropped, not wildcarded — the valid name still resolves (batch semantics preserved)", async () => {
    const skeletonId = tokenId("Skeleton the Cursed");
    const ogreId = tokenId("Ogre");
    const before = { skeleton: bar(skeletonId), ogre: bar(ogreId) };

    await h.callTool("update_hp_many", { names: [",", "Skeleton the Cursed"], damage: 2 });

    expect(bar(skeletonId)).toBe(before.skeleton - 2); // the valid name still worked
    expect(bar(ogreId)).toBe(before.ogre);             // NOT wildcarded to the rest of the board
  });
});

describe("roll_initiative — punctuation-only selectors must never wildcard the whole board (PR #198 finding 1)", () => {
  it("nameFilter of pure punctuation refuses loudly instead of rolling initiative for every token", async () => {
    await expect(h.callTool("roll_initiative", { nameFilter: "...", publicRoll: false }))
      .rejects.toThrow(/punctuation-only/i);
  });

  it("names[] of pure punctuation refuses loudly instead of selecting every token", async () => {
    await expect(h.callTool("roll_initiative", { names: [","], publicRoll: false }))
      .rejects.toThrow(/punctuation-only/i);
  });

  it("entries[].match of pure punctuation refuses loudly instead of selecting every token", async () => {
    await expect(h.callTool("roll_initiative", { entries: [{ match: ";" }], publicRoll: false }))
      .rejects.toThrow(/punctuation-only/i);
  });
});

describe("resolveToken — a punctuation-only characterName refuses rather than resolving to an arbitrary token (PR #198 finding 1)", () => {
  it("update_token_hp with a punctuation-only characterName refuses; nothing on the board is written", async () => {
    const ogreId = tokenId("Ogre");
    const before = bar(ogreId);

    await expect(h.callTool("update_token_hp", { characterName: "...", damage: 5 }))
      .rejects.toThrow(/Ambiguous target/i);

    expect(bar(ogreId)).toBe(before);
  });
});

describe("resolveToken — the registry short-circuit does not bypass the ambiguity refusal (PR #198 finding 2)", () => {
  it("two registered characters whose names collide only after punctuation-folding refuse rather than silently resolving to whichever was registered first", async () => {
    // Neither raw key equals the query ("rook the bound"), so this exercises
    // the fold-collision path inside resolveCharacterKey specifically, not
    // the raw-exact-match fast path. Fake token ids: nothing here should
    // ever reach a relay write.
    characters.register("Rook, The Bound", "-fake-tok-registry-collision-a", 0);
    characters.register("Rook The Bound.", "-fake-tok-registry-collision-b", 0);

    // Neither registry entry AND no matching board token exist for this
    // exact phrase, so this refuses end to end — the point is that it does
    // NOT silently resolve to "-fake-tok-registry-collision-a" (whichever
    // register() call happened to run first) via the registry short-circuit
    // in resolveToken/combatHelpers.ts.
    await expect(h.callTool("update_token_hp", { characterName: "Rook The Bound", damage: 1 }))
      .rejects.toThrow(/Ambiguous target|No matching token/i);
  });
});
