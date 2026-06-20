// Hermetic per-PR gate for the narration-rule checkers. No model, no network —
// fixed good/bad call-logs prove the structural checks (N2/N7/N8) catch what they
// must. This keeps the eval's assertion logic honest even though the live-model
// run that produces real logs is opt-in (narration-live-eval.test.ts).

import { describe, it, expect } from "vitest";
import {
  type ToolCallLog,
  isBatchedMultiTarget,
  playerNarrationsAreRedacted,
  containsDigit,
  hpClaimIsBacked,
  callsTargeting,
} from "./structural";

describe("N2 — multi-target must be one batched call", () => {
  it("passes a single update_hp_many", () => {
    const log: ToolCallLog[] = [{ name: "update_hp_many", args: { nameMatch: "wolf", damage: 22 } }];
    expect(isBatchedMultiTarget(log)).toBe(true);
  });

  it("passes a single batch_exec", () => {
    const log: ToolCallLog[] = [{ name: "batch_exec", args: { ops: [] } }];
    expect(isBatchedMultiTarget(log)).toBe(true);
  });

  it("FAILS a loop of single-target updates", () => {
    const log: ToolCallLog[] = [
      { name: "update_token_hp", args: { characterName: "Wolf 1", damage: 22 } },
      { name: "update_token_hp", args: { characterName: "Wolf 2", damage: 22 } },
      { name: "update_token_hp", args: { characterName: "Goblin", damage: 22 } },
    ];
    expect(isBatchedMultiTarget(log)).toBe(false);
  });
});

describe("N7 — player-facing narration carries no numbers", () => {
  it("flags exact HP in player text", () => {
    expect(containsDigit("Goblin at 4/15, bloodied")).toBe(true);
  });

  it("passes descriptive, number-free wounds", () => {
    expect(containsDigit("The goblin reels, bloodied and near death.")).toBe(false);
  });

  it("redaction check FAILS when any narration leaks a figure", () => {
    const log: ToolCallLog[] = [
      { name: "send_narration", args: { text: "The wolves howl as fire washes over them." } },
      { name: "send_narration", args: { text: "Goblin: 22 damage, now at 0." } },
    ];
    expect(playerNarrationsAreRedacted(log)).toBe(false);
  });

  it("redaction check PASSES when all narration is word-only", () => {
    const log: ToolCallLog[] = [
      { name: "send_narration", args: { text: "Flame engulfs the pack; the goblin drops, lifeless." } },
    ];
    expect(playerNarrationsAreRedacted(log)).toBe(true);
  });
});

describe("N8 — a claimed effect must be backed by a real HP call", () => {
  it("backed when an HP call references the target (by characterName)", () => {
    const log: ToolCallLog[] = [{ name: "update_token_hp", args: { characterName: "Zeno", damage: 12 } }];
    expect(hpClaimIsBacked(log, "Zeno")).toBe(true);
  });

  it("backed when the target appears in a batch names[]", () => {
    const log: ToolCallLog[] = [{ name: "update_hp_many", args: { names: ["Brie", "Zeno"], heal: 8 } }];
    expect(hpClaimIsBacked(log, "zeno")).toBe(true); // case-insensitive
  });

  it("NOT backed when there is no HP call (phantom effect)", () => {
    const log: ToolCallLog[] = [{ name: "send_narration", args: { text: "Zeno is struck!" } }];
    expect(hpClaimIsBacked(log, "Zeno")).toBe(false);
  });

  it("callsTargeting ignores unrelated targets", () => {
    const log: ToolCallLog[] = [{ name: "update_token_hp", args: { characterName: "Goblin", damage: 7 } }];
    expect(callsTargeting(log, "Zeno")).toHaveLength(0);
  });
});
