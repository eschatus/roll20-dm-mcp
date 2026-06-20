// Hermetic per-PR gate for the judge plumbing. No model, no key — an injected fake
// ask() returns canned replies so we prove the JSON parsing, malformed-reply
// handling, and k-of-n threshold are correct. (Whether the real judge classifies
// real prose correctly is the opt-in calibration block in narration-judge-eval.)

import { describe, it, expect } from "vitest";
import { parseVerdict, judge, judgeMajority, type AskFn } from "./judge";

/** A fake ask() that returns scripted replies in order, looping the last one. */
function scriptedAsk(replies: string[]): AskFn {
  let i = 0;
  return async () => replies[Math.min(i++, replies.length - 1)];
}

describe("parseVerdict", () => {
  it("parses a clean JSON verdict", () => {
    expect(parseVerdict('{"pass": true, "reason": "terse receipt"}')).toEqual({ pass: true, reason: "terse receipt" });
  });

  it("extracts JSON embedded in prose / fences", () => {
    const raw = "Sure!\n```json\n{\"pass\": false, \"reason\": \"flowery recap\"}\n```";
    expect(parseVerdict(raw)).toEqual({ pass: false, reason: "flowery recap" });
  });

  it("throws on a reply with no JSON object", () => {
    expect(() => parseVerdict("the output looks fine to me")).toThrow(/no JSON/);
  });

  it("throws when 'pass' is not a boolean", () => {
    expect(() => parseVerdict('{"pass": "yes"}')).toThrow(/boolean/);
  });
});

describe("judge", () => {
  it("returns the parsed verdict from ask()", async () => {
    const v = await judge("RULE", "OUTPUT", scriptedAsk(['{"pass": true, "reason": "ok"}']));
    expect(v).toEqual({ pass: true, reason: "ok" });
  });
});

describe("judgeMajority (k-of-n)", () => {
  it("passes when strictly more than half pass", async () => {
    const ask = scriptedAsk([
      '{"pass": true, "reason": "a"}',
      '{"pass": false, "reason": "b"}',
      '{"pass": true, "reason": "c"}',
    ]);
    const r = await judgeMajority("RULE", "OUTPUT", ask, 3);
    expect(r.pass).toBe(true);
    expect(r.passes).toBe(2);
    expect(r.total).toBe(3);
  });

  it("fails on a tie / minority", async () => {
    const ask = scriptedAsk([
      '{"pass": true, "reason": "a"}',
      '{"pass": false, "reason": "b"}',
      '{"pass": false, "reason": "c"}',
    ]);
    const r = await judgeMajority("RULE", "OUTPUT", ask, 3);
    expect(r.pass).toBe(false);
    expect(r.passes).toBe(1);
  });
});
