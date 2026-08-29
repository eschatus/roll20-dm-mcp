// ─────────────────────────────────────────────────────────────────────────────
// #187 — $[[n]] roll-pointer resolution, and the hand-synced-copy lock for it.
//
// resolveInlineRolls exists TWICE, because the Mod sandbox cannot import TS:
// src/bridge/rt-helpers.ts (the RT path, which serves get_recent_chat in practice) and
// mod-scripts/ai-relay.js (the Mod's own CHAT_BUFFER, reachable through the __forceMod
// escape hatch). The condition→marker tables in this repo drifted in exactly this way, so
// these tests pin the two implementations to the same output on the same input rather than
// testing each in isolation.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect, beforeEach } from "vitest";
import { resolveInlineRolls, cleanChat } from "../src/bridge/rt-helpers.js";
import { Roll20Emulator } from "./roll20-emulator.js";

interface BufferedChat {
  who: string;
  type: string;
  content: string;
  inlinerolls: { expression: string; total: number | null }[];
}

// The payload from the issue: a GM rolltemplate whose to-hit total lives only in inlinerolls.
const ROCK =
  "{{charname=Fire Giant Trooper}} {{rname=Rock (Group Attack)}} {{mod=+10}} " +
  "{{r1=$[[0]]}} {{attack=1}} {{damage=1}} {{dmg1flag=1}} {{dmg1=6}} {{dmg1type=bludgeoning}}";

describe("the Mod's chat buffer resolves $[[n]] the same way the TS path does (#187)", () => {
  let emu: Roll20Emulator;
  beforeEach(() => {
    emu = new Roll20Emulator({ seed: 7 });
    emu.load();
  });

  // Speak as a non-API player so the Mod buffers it as real table chat.
  const speak = (content: string, total: number) =>
    emu.emit("chat:message", {
      type: "general",
      who: "Fire Giant Trooper",
      playerid: "p-gm",
      content,
      inlinerolls: [{ expression: "1d20 +10", results: { total } }],
    });

  const buffered = () => emu.relay<BufferedChat[]>({ action: "getRecentChat", limit: 10 });

  it("returns the total in content instead of the pointer", () => {
    speak(ROCK, 16);
    const chat = buffered();
    expect(chat).toHaveLength(1);
    expect(chat[0].content).toContain("{{r1=16}}");
    expect(chat[0].content).not.toContain("$[[0]]");
    // inlinerolls still rides along — `expression` carries what the substitution does not.
    expect(chat[0].inlinerolls).toEqual([{ expression: "1d20 +10", total: 16 }]);
  });

  it("agrees byte-for-byte with the TS copy", () => {
    speak(ROCK, 16);
    expect(buffered()[0].content).toBe(cleanChat(resolveInlineRolls(ROCK, [{ total: 16 }])));
  });

  it("leaves an unresolvable pointer verbatim in BOTH copies", () => {
    const outOfRange = "{{r1=$[[3]]}}";
    speak(outOfRange, 4);
    expect(buffered()[0].content).toContain("$[[3]]");
    expect(buffered()[0].content).toBe(cleanChat(resolveInlineRolls(outOfRange, [{ total: 4 }])));
  });

  it("distinguishes attacks that were byte-identical before the fix", () => {
    speak(ROCK, 16);
    speak(ROCK, 13);
    const contents = buffered().map((c) => c.content);
    expect(contents[0]).toContain("{{r1=16}}");
    expect(contents[1]).toContain("{{r1=13}}");
    expect(contents[0]).not.toBe(contents[1]);
  });
});
