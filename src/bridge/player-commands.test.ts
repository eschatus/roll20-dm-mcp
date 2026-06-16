import { describe, it, expect, beforeEach } from "vitest";
import {
  parsePlayerCommand,
  cooldownRemaining,
  __resetCooldownsForTest,
  pickPcToken,
  nameAffinity,
  woundState,
  filterRecapEntries,
  crToDc,
  extractJson,
  extractDdbOptionFacts,
  globalBucketAllowed,
  concurrencyAllowed,
  __resetGlobalBucketForTest,
  type ChatEntry,
  type PageToken,
} from "./player-commands.js";

describe("parsePlayerCommand", () => {
  it("parses bare commands", () => {
    expect(parsePlayerCommand("!tactics")).toEqual({ command: "tactics", arg: "" });
    expect(parsePlayerCommand("!recap")).toEqual({ command: "recap", arg: "" });
    expect(parsePlayerCommand("!help")).toEqual({ command: "help", arg: "" });
  });

  it("parses args, preserving inner whitespace", () => {
    expect(parsePlayerCommand("!recall Strahd von Zarovich")).toEqual({ command: "recall", arg: "Strahd von Zarovich" });
    expect(parsePlayerCommand("!rules  does grapple end on teleport? ")).toEqual({
      command: "rules",
      arg: "does grapple end on teleport?",
    });
  });

  it("is case-insensitive on the command", () => {
    expect(parsePlayerCommand("!TACTICS")).toEqual({ command: "tactics", arg: "" });
  });

  it("rejects unknown / foreign commands", () => {
    expect(parsePlayerCommand("!dm I attack the skeleton")).toBeNull();
    expect(parsePlayerCommand("!ai-relay {\"action\":\"x\"}")).toBeNull();
    expect(parsePlayerCommand("!beyond20-roll abc")).toBeNull();
    expect(parsePlayerCommand("hello there")).toBeNull();
    expect(parsePlayerCommand("!")).toBeNull();
  });
});

describe("cooldownRemaining", () => {
  beforeEach(() => __resetCooldownsForTest());

  it("allows first use and blocks repeats within the window", () => {
    const t0 = 1_000_000;
    expect(cooldownRemaining("p1", "tactics", t0)).toBe(0);
    expect(cooldownRemaining("p1", "tactics", t0 + 10_000)).toBe(80);
    expect(cooldownRemaining("p1", "tactics", t0 + 90_000)).toBe(0);
  });

  it("tracks players and commands independently", () => {
    const t0 = 1_000_000;
    expect(cooldownRemaining("p1", "tactics", t0)).toBe(0);
    expect(cooldownRemaining("p2", "tactics", t0)).toBe(0);
    expect(cooldownRemaining("p1", "recall", t0)).toBe(0);
  });

  it("does not record a use while blocked (no cooldown extension)", () => {
    const t0 = 1_000_000;
    cooldownRemaining("p1", "recall", t0);
    cooldownRemaining("p1", "recall", t0 + 5_000); // blocked
    expect(cooldownRemaining("p1", "recall", t0 + 30_000)).toBe(0);
  });
});

describe("pickPcToken", () => {
  const tok = (over: Partial<PageToken>): PageToken => ({ id: "t", name: "X", ...over });

  it("matches exact playerid in comma list, ignoring 'all'", () => {
    const tokens = [
      tok({ id: "a", name: "Door", controlledby: "all" }),
      tok({ id: "b", name: "Winsome", controlledby: "-PL1,-PL2" }),
      tok({ id: "c", name: "Goblin", controlledby: "" }),
    ];
    expect(pickPcToken(tokens, "-PL2", () => false)?.id).toBe("b");
    expect(pickPcToken(tokens, "-PL9", () => false)).toBeNull();
  });

  it("skips non-objects layers", () => {
    const tokens = [tok({ id: "g", controlledby: "-PL1", layer: "gmlayer" })];
    expect(pickPcToken(tokens, "-PL1", () => false)).toBeNull();
  });

  it("prefers a registry-registered token when the player controls several", () => {
    const tokens = [
      tok({ id: "fam", name: "Owl Familiar", controlledby: "-PL1" }),
      tok({ id: "pc", name: "Leolen", controlledby: "-PL1" }),
    ];
    expect(pickPcToken(tokens, "-PL1", (n) => n === "Leolen")?.id).toBe("pc");
    // falls back to first when nothing is registered
    expect(pickPcToken(tokens, "-PL1", () => false)?.id).toBe("fam");
  });

  it("breaks a multi-registered tie by fuzzy-matching the player's display name", () => {
    // One player controls three registered PCs — the right one is chosen by `who`.
    const tokens = [
      tok({ id: "eli", name: "Eli Yola", controlledby: "-PL1" }),
      tok({ id: "alt", name: "Alton Rhusc", controlledby: "-PL1" }),
      tok({ id: "rig", name: "Rigan Mor", controlledby: "-PL1" }),
    ];
    const reg = () => true;
    expect(pickPcToken(tokens, "-PL1", reg, "Elias Martinez de Castillo Yolanda")?.id).toBe("eli");
    expect(pickPcToken(tokens, "-PL1", reg, "Alton Rhuscanthe")?.id).toBe("alt");
    expect(pickPcToken(tokens, "-PL1", reg, "Rigan of the Mor")?.id).toBe("rig");
  });

  it("falls back to the first registered token when `who` matches nothing", () => {
    const tokens = [
      tok({ id: "eli", name: "Eli Yola", controlledby: "-PL1" }),
      tok({ id: "alt", name: "Alton Rhusc", controlledby: "-PL1" }),
    ];
    // No affinity → preserve legacy first-registered behavior.
    expect(pickPcToken(tokens, "-PL1", () => true, "Some Unrelated Name")?.id).toBe("eli");
    // No `who` supplied at all → first registered.
    expect(pickPcToken(tokens, "-PL1", () => true)?.id).toBe("eli");
  });
});

describe("nameAffinity", () => {
  it("counts word-prefix overlaps in either direction", () => {
    expect(nameAffinity("Eli Yola", "Elias Martinez de Castillo Yolanda")).toBe(2);
    expect(nameAffinity("Alton Rhusc", "Elias Martinez de Castillo Yolanda")).toBe(0);
    expect(nameAffinity("Rigan Mor", "Elias Martinez de Castillo Yolanda")).toBe(0);
  });

  it("ignores punctuation and single-letter words", () => {
    expect(nameAffinity("Eli, Yola!", "Elias Yolanda")).toBe(2); // punctuation stripped
    expect(nameAffinity("R Eli", "Elias")).toBe(1); // stray initial "r" dropped, eli⊂elias
    expect(nameAffinity("Eli", "")).toBe(0);
  });
});

describe("woundState", () => {
  it("maps HP percentage to qualitative bands with no numbers", () => {
    expect(woundState(20, 20)).toBe("unhurt");
    expect(woundState(14, 20)).toBe("lightly wounded");
    expect(woundState(10, 20)).toBe("bloodied");
    expect(woundState(4, 20)).toBe("badly wounded");
    expect(woundState(1, 20)).toBe("near death");
    expect(woundState(0, 20)).toBe("down");
    expect(woundState(5, 0)).toBe("condition unknown");
  });
});

describe("filterRecapEntries", () => {
  const entry = (over: Partial<ChatEntry>): ChatEntry => ({
    who: "Eli", type: "general", content: "I kick the door open", timestamp: 1, ...over,
  });

  it("keeps narration, drops roll spam and templates", () => {
    const entries = [
      entry({}),
      entry({ type: "rollresult", content: "rolling 1d20+5" }),
      entry({ type: "gmrollresult", content: "rolling 2d6" }),
      entry({ content: "&{template:atkdmg} {{rname=Eldritch Blast}}" }),
      entry({ content: "$[[0]] [[2d8+3]]" }),
      entry({ who: "The Bones", content: "ominous batch of rolls" }),
      entry({ who: "GM-AI-Bridge", content: "internal" }),
      entry({ type: "whisper", content: "psst" }),
      entry({ type: "emote", content: "draws her blade" }),
    ];
    const kept = filterRecapEntries(entries);
    expect(kept.map((e) => e.content)).toEqual(["I kick the door open", "draws her blade"]);
  });
});

describe("crToDc", () => {
  it("computes DC 10 + floor(CR/2) with clamping", () => {
    expect(crToDc("1/2")).toBe(10);
    expect(crToDc("1")).toBe(10);
    expect(crToDc("5")).toBe(12);
    expect(crToDc("9")).toBe(14);
    expect(crToDc(13)).toBe(16);
    expect(crToDc("30")).toBe(22); // clamp high
    expect(crToDc(undefined)).toBe(10);
    expect(crToDc("garbage")).toBe(10);
  });
});

describe("extractJson", () => {
  it("parses plain and fenced JSON", () => {
    expect(extractJson('{"confident": true, "answer": "yes"}')).toEqual({ confident: true, answer: "yes" });
    expect(extractJson('Here you go:\n```json\n{"skill": "nature"}\n```')).toEqual({ skill: "nature" });
  });
  it("returns null on garbage", () => {
    expect(extractJson("no json here")).toBeNull();
    expect(extractJson("{broken")).toBeNull();
  });
});

describe("extractDdbOptionFacts", () => {
  it("pulls slots, action names, and equipped weapons defensively", () => {
    const raw = {
      spellSlots: [
        { level: 1, used: 2, available: 4 },
        { level: 2, used: 0, available: 0 }, // no slots at this level → omitted
      ],
      pactMagic: [{ level: 3, used: 1, available: 2 }],
      actions: {
        race: [{ name: "Breath Weapon" }],
        class: [{ name: "Second Wind" }, { name: null }],
        feat: [],
      },
      inventory: [
        { equipped: true, definition: { filterType: "Weapon", name: "Longsword" } },
        { equipped: false, definition: { filterType: "Weapon", name: "Dagger" } },
        { equipped: true, definition: { filterType: "Armor", name: "Chain Mail" } },
      ],
    };
    const facts = extractDdbOptionFacts(raw);
    expect(facts.slots).toEqual(["L1: 2/4 remaining", "L3: 1/2 remaining"]);
    expect(facts.abilities).toEqual(["Breath Weapon", "Second Wind"]);
    expect(facts.weapons).toEqual(["Longsword"]);
  });

  it("handles a completely empty blob", () => {
    expect(extractDdbOptionFacts({})).toEqual({ slots: [], abilities: [], weapons: [] });
    expect(extractDdbOptionFacts(null)).toEqual({ slots: [], abilities: [], weapons: [] });
  });
});

// ─── globalBucketAllowed ──────────────────────────────────────────────────────

describe("globalBucketAllowed", () => {
  beforeEach(() => __resetGlobalBucketForTest());

  it("allows up to 10 calls within the 60s window", () => {
    const t0 = 2_000_000;
    for (let i = 0; i < 10; i++) {
      expect(globalBucketAllowed(t0 + i)).toBe(true);
    }
    // 11th call within same window is blocked
    expect(globalBucketAllowed(t0 + 10)).toBe(false);
  });

  it("slides the window: old calls expire and new capacity opens", () => {
    const t0 = 2_000_000;
    // Fill the bucket
    for (let i = 0; i < 10; i++) globalBucketAllowed(t0 + i * 1_000);
    // Still blocked just before the oldest entry expires
    expect(globalBucketAllowed(t0 + 59_999)).toBe(false);
    // One slot opens once the oldest call is > 60 000 ms old
    expect(globalBucketAllowed(t0 + 60_001)).toBe(true);
  });

  it("resets cleanly between tests", () => {
    // Fresh slate — first call is always allowed
    expect(globalBucketAllowed(3_000_000)).toBe(true);
  });
});

// ─── concurrencyAllowed ───────────────────────────────────────────────────────

describe("concurrencyAllowed", () => {
  beforeEach(() => __resetGlobalBucketForTest());

  it("allows calls when in-flight count is below the cap", () => {
    expect(concurrencyAllowed()).toBe(true);
  });
});
