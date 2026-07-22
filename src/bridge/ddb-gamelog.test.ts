import { describe, it, expect } from "vitest";
import { renderRollForRoll20, type DdbGameLogMessage } from "./ddb-gamelog.js";

// Fixtures are trimmed from REAL game-log messages captured off game 1117568
// (src/recon/ddb-gamelog-*.ts). The renderer MIRRORS the values DDB already rolled —
// it must never invent or re-roll — so these pin the exact Roll20 output.

// A weapon roll that DOES carry diceNotationStr, with two sets and per-die values.
const WEAPON: DdbGameLogMessage = {
  id: "w1", dateTime: "1784681529261", gameId: "1117568", userId: "108931691",
  entityId: "130003005", entityType: "character", eventType: "dice/roll/fulfilled",
  data: {
    action: "Elemental Cleaver",
    context: { name: "Broo Zbaaner" },
    rolls: [
      { diceNotationStr: "5d8", rollType: "Force", result: { constant: 0, text: "7+1+5+8+4", total: 25, values: [7, 1, 5, 8, 4] } },
      { diceNotationStr: "4d6 + 5", rollType: "Bludgeoning", result: { constant: 5, text: "2+2+5+4+5", total: 18, values: [2, 2, 5, 4] } },
    ],
  },
};

// A skill check that has NO diceNotationStr — only the structured diceNotation.
const CHECK: DdbGameLogMessage = {
  id: "c1", dateTime: "1784683000000", gameId: "1117568", userId: "108931691",
  entityId: "130003005", entityType: "character", eventType: "dice/roll/fulfilled",
  data: {
    action: "Athletics",
    context: { name: "Broo Zbaaner" },
    rolls: [
      { rollType: "check", diceNotation: { constant: 10, set: [{ count: 1, dieType: "d20", operation: 0 }] }, result: { constant: 10, text: "15+10", total: 25, values: [15] } },
    ],
  },
};

describe("renderRollForRoll20 — mirrors DDB's actual dice", () => {
  it("speaks as the character, not the DM", () => {
    expect(renderRollForRoll20(WEAPON).speakAs).toBe("Broo Zbaaner");
  });

  it("emits a Roll20 default-template card tagged as coming from D&D Beyond", () => {
    const { message } = renderRollForRoll20(WEAPON);
    expect(message.startsWith("&{template:default}")).toBe(true);
    expect(message).toContain("{{name=Elemental Cleaver — via D&D Beyond}}");
  });

  it("shows DDB's real totals and breakdowns (never a fresh roll)", () => {
    const { message } = renderRollForRoll20(WEAPON);
    expect(message).toContain("Force 5d8 = 25 (7+1+5+8+4)");
    expect(message).toContain("Bludgeoning 4d6 + 5 = 18 (2+2+5+4+5)");
  });

  it("reconstructs notation from diceNotation when diceNotationStr is absent", () => {
    const { message } = renderRollForRoll20(CHECK);
    // 1×d20 + constant 10 → "1d20 + 10", total 25, breakdown 15+10
    expect(message).toContain("Check 1d20 + 10 = 25 (15+10)");
  });

  it("contains NO inline-roll syntax (which Roll20 would re-roll)", () => {
    const { message } = renderRollForRoll20(WEAPON);
    expect(message).not.toMatch(/\[\[/);   // no [[ … ]]
  });

  it("falls back gracefully when context/action are missing", () => {
    const bare: DdbGameLogMessage = {
      id: "b1", dateTime: "0", gameId: "1117568", userId: "1", entityId: "130003005",
      eventType: "dice/roll/fulfilled",
      data: { rolls: [{ rollType: "", diceNotation: { set: [{ count: 1, dieType: "d20" }] }, result: { constant: 0, text: "12", total: 12, values: [12] } }] },
    };
    const { speakAs, message } = renderRollForRoll20(bare);
    expect(speakAs).toBe("D&D Beyond");
    expect(message).toContain("{{name=Dice Roll — via D&D Beyond}}");
    expect(message).toContain("Roll 1d20 = 12");
  });
});
