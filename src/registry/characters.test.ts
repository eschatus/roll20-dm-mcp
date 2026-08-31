import { describe, it, expect } from "vitest";
import {
  resolveCharacterKey, register, lookup, setSidekick, isSidekick, listSidekickNames,
  type CharacterEntry,
} from "./characters.js";

function entry(): CharacterEntry {
  return { roll20TokenId: "tok", ddbCharId: 1 };
}

describe("resolveCharacterKey", () => {
  const reg: Record<string, CharacterEntry> = {
    eli: entry(),
    "rigan stormcrow": entry(),
    winsome: entry(),
  };

  it("returns the exact key for a case-insensitive exact match", () => {
    expect(resolveCharacterKey("Eli", reg)).toBe("eli");
    expect(resolveCharacterKey("eli", reg)).toBe("eli");
  });

  it("matches when the query is a substring of a key", () => {
    expect(resolveCharacterKey("Rigan", reg)).toBe("rigan stormcrow");
  });

  it("matches when a key is a substring of the query", () => {
    expect(resolveCharacterKey("Winsome the Bard", reg)).toBe("winsome");
  });

  it("returns null when nothing matches", () => {
    expect(resolveCharacterKey("Strahd", reg)).toBeNull();
  });

  it("returns null against an empty registry", () => {
    expect(resolveCharacterKey("Eli", {})).toBeNull();
  });

  // Issue #195: the registry short-circuit ahead of the token scan needs the
  // same punctuation fold resolveToken got, or a registered PC addressed with
  // natural spoken punctuation ("Rigan, Stormcrow") falls through to it
  // instead of hitting the registry directly.
  it("matches a punctuated query against an unpunctuated key (issue #195)", () => {
    expect(resolveCharacterKey("Rigan, Stormcrow", reg)).toBe("rigan stormcrow");
    expect(resolveCharacterKey("Winsome, the Bard", reg)).toBe("winsome");
  });

  it("still finds the raw case-only match first when both apply (no behavior change for the common case)", () => {
    expect(resolveCharacterKey("Eli", reg)).toBe("eli");
  });

  // PR #198 review, finding 3 (Devin): adjacent punctuation with no space
  // ("Rigan,Stormcrow") used to fold to "riganstormcrow" (words fused
  // together), which could never match the stored key "rigan stormcrow".
  it("matches adjacent (no-space) punctuation the same way (PR #198 finding 3)", () => {
    expect(resolveCharacterKey("Rigan,Stormcrow", reg)).toBe("rigan stormcrow");
  });

  // PR #198 review, finding 1 (Devin) — the wildcard bug: a punctuation-only
  // query folds to "", and an unguarded fuzzy check ("".includes("")) would
  // treat that as matching every key. Must return null, not the first key.
  it("a punctuation-only query does not wildcard-match every registered key (PR #198 finding 1)", () => {
    expect(resolveCharacterKey(",", reg)).toBeNull();
    expect(resolveCharacterKey("...", reg)).toBeNull();
    expect(resolveCharacterKey(" ; : ", reg)).toBeNull();
  });

  // PR #198 review, finding 2 (Devin) — collision consistency: two DIFFERENT
  // registered keys that fold to the same comparison form must refuse
  // (return null), not silently resolve to whichever Object.keys() lists
  // first. Neither registered key literally equals the query, so this
  // exercises the fold-collision path, not the raw-exact-match fast path.
  it("refuses (returns null) rather than guessing when two DIFFERENT keys fold to the same comparison form (PR #198 finding 2)", () => {
    const collidingReg: Record<string, CharacterEntry> = {
      "iron, golem": entry(),
      "iron golem.": entry(),
    };
    expect(resolveCharacterKey("Iron Golem", collidingReg)).toBeNull();
  });

  it("a single fold-collision match still resolves normally (only ambiguity refuses, not every fuzzy match)", () => {
    const oneMatch: Record<string, CharacterEntry> = {
      "iron, golem": entry(),
      winsome: entry(),
    };
    expect(resolveCharacterKey("Iron Golem", oneMatch)).toBe("iron, golem");
  });
});

// Issue #132: the sidekick override is a per-character field persisted to disk
// (characters.json, under the active campaign, via the same load/save path as
// the rest of the registry), read back through the same fuzzy name resolution
// as resolveCharacterKey, and must survive re-registration (create_pc_token /
// DDB relink) rather than being silently wiped.
//
// The on-disk registry is a real file shared by the whole test worker (see
// test/setup.ts — one throwaway dir per worker pid, one "env-default" campaign
// bucket), so assertions below check membership of OUR names rather than
// exact set equality/size, and every test uses a name unlikely to collide
// with other suites (Tua/Salros Eventide/Amri from the golden-pairs doc).
describe("sidekick registry round-trip (issue #132)", () => {
  it("setSidekick creates a minimal entry that round-trips through disk, case-insensitively", () => {
    setSidekick("Tua", true);
    expect(isSidekick("Tua")).toBe(true);
    expect(isSidekick("tua")).toBe(true);
    expect(listSidekickNames().has("tua")).toBe(true);
  });

  it("setSidekick(false) clears the override", () => {
    setSidekick("Amri", true);
    expect(isSidekick("Amri")).toBe(true);
    setSidekick("Amri", false);
    expect(isSidekick("Amri")).toBe(false);
    expect(listSidekickNames().has("amri")).toBe(false);
  });

  it("register() preserves a prior sidekick flag instead of wiping it", () => {
    setSidekick("Salros Eventide", true);
    register("Salros Eventide", "-tok123", 4242);
    const entry = lookup("Salros Eventide") as CharacterEntry;
    expect(entry.sidekick).toBe(true);
    expect(entry.roll20TokenId).toBe("-tok123");
    expect(entry.ddbCharId).toBe(4242);
  });

  it("register() does not mark a normal PC as a sidekick", () => {
    register("Glint Klinkinski Golden Pair", "-tokPc", 1000);
    expect(isSidekick("Glint Klinkinski Golden Pair")).toBe(false);
    expect(listSidekickNames().has("glint klinkinski golden pair")).toBe(false);
  });

  it("listSidekickNames resolves fuzzily via resolveCharacterKey (epithets, substrings)", () => {
    setSidekick("Wynne Testonly Sidekick", true);
    expect(isSidekick("Wynne Testonly Sidekick the Storm-Touched")).toBe(true);
  });
});
