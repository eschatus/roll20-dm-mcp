// #257: "Ambiguous target" for a token that simply isn't there sent models hunting for a
// "which one?" answer that doesn't exist — the same class as #239. The wording decides the
// recovery, so the three outcomes stay distinct.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupHarness, type Harness } from "./harness.js";

let h: Harness;

beforeAll(() => {
  h = setupHarness({ seed: 257 });
  const pageId = h.emu.createPage("Wording Page");
  h.emu.setPlayerPage(pageId);
  for (const name of ["Goblin Archer", "Goblin Boss", "Ogre"]) {
    h.emu.createToken({ pageid: pageId, name, controlledby: "", bar1_value: 10, bar1_max: 10 });
  }
});

afterAll(() => h.teardown());

const hurt = (characterName: string) =>
  h.callTool("update_token_hp", { characterName, damage: 1 }).then(
    () => { throw new Error(`expected "${characterName}" to be refused`); },
    (e: Error) => e.message,
  );

describe("resolveTokenOrThrow wording (#257)", () => {
  it("zero matches: says the token is absent, not ambiguous", async () => {
    const err = await hurt("Beholder");
    expect(err).toMatch(/No token named "Beholder" on this page\./);
    expect(err).not.toMatch(/Ambiguous|Closest/);
  });

  it("near-miss only: absent, with the closest names offered rather than a choice", async () => {
    const err = await hurt("Goblin Captain");
    expect(err).toMatch(/No token named "Goblin Captain" on this page\. Closest: .*Goblin Archer.*Goblin Boss/);
    expect(err).not.toMatch(/Ambiguous|Did you mean/);
  });

  it("two genuine candidates: still ambiguous, with the choice offered", async () => {
    const err = await hurt("Goblin");
    expect(err).toMatch(/Ambiguous target "Goblin"\. Did you mean: Goblin Archer, Goblin Boss\?/);
  });

  it("batch_exec reports each op with the same wording, and still runs the ops that resolved", async () => {
    const { text } = await h.callTool("batch_exec", {
      ops: ["Beholder", "Goblin Captain", "Goblin", "Ogre"].map((characterName) => ({
        id: characterName, action: "toggleCondition", args: { characterName, condition: "prone", active: true },
      })),
    });
    const results = JSON.parse(text.slice(text.lastIndexOf("\n\n"))) as { id: string; error?: string }[];
    const errors = Object.fromEntries(results.map((r) => [r.id, r.error]));
    expect(errors.Beholder).toMatch(/^No token named "Beholder" on this page\. Ask/);
    expect(errors["Goblin Captain"]).toMatch(/^No token named "Goblin Captain" on this page\. Closest: /);
    expect(errors["Goblin Captain"]).not.toMatch(/Did you mean/i);
    expect(errors.Goblin).toMatch(/^Ambiguous target "Goblin"\. Did you mean:/);
    expect(errors.Ogre).toBeUndefined();
  });
});
