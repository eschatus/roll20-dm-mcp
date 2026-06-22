import { describe, it, expect, afterAll } from "vitest";
import { existsSync, rmSync } from "fs";
import { dataPath } from "../dataDir.js";
import { trackCustomState, getCustomStates } from "./relayState.js";

// Use unique throwaway campaign ids so tests never touch real data/relay-state files.
const ids: string[] = [];
function freshCampaign(): string {
  const id = `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  ids.push(id);
  return id;
}

afterAll(() => {
  for (const id of ids) {
    const f = dataPath(`relay-state-${id}.json`);
    if (existsSync(f)) rmSync(f);
  }
});

describe("relayState custom-state tracking", () => {
  it("starts empty", () => {
    expect(getCustomStates(freshCampaign())).toEqual({});
  });

  it("tracks a token holding a custom state", () => {
    const c = freshCampaign();
    trackCustomState(c, "hexed", "strong", "tok1", true);
    expect(getCustomStates(c)).toEqual({ hexed: { tag: "strong", tokens: ["tok1"] } });
  });

  it("accumulates multiple tokens and de-dupes", () => {
    const c = freshCampaign();
    trackCustomState(c, "hexed", "strong", "tok1", true);
    trackCustomState(c, "hexed", "strong", "tok2", true);
    trackCustomState(c, "hexed", "strong", "tok1", true); // duplicate add
    expect(getCustomStates(c).hexed.tokens.sort()).toEqual(["tok1", "tok2"]);
  });

  it("removes a token and prunes the state when empty", () => {
    const c = freshCampaign();
    trackCustomState(c, "hexed", "strong", "tok1", true);
    trackCustomState(c, "hexed", "strong", "tok2", true);
    trackCustomState(c, "hexed", "strong", "tok1", false);
    expect(getCustomStates(c).hexed.tokens).toEqual(["tok2"]);
    trackCustomState(c, "hexed", "strong", "tok2", false);
    expect(getCustomStates(c)).toEqual({}); // pruned
  });

  it("isolates state between campaigns", () => {
    const a = freshCampaign(), b = freshCampaign();
    trackCustomState(a, "hexed", "strong", "tokA", true);
    expect(getCustomStates(b)).toEqual({});
    expect(getCustomStates(a).hexed.tokens).toEqual(["tokA"]);
  });

  it("persists to disk (a fresh read sees prior writes)", () => {
    const c = freshCampaign();
    trackCustomState(c, "marked", "arrowed", "tokX", true);
    expect(existsSync(dataPath(`relay-state-${c}.json`))).toBe(true);
  });
});
