// Locks the three-channel routing: conversational diagnostics (hud.log) must stay
// separate from whisper-speed noise (whisper.log) and startup/shutdown (system.log).
import { describe, it, expect } from "vitest";
import { classifyConsole, channelForKind } from "../src/logger";

describe("classifyConsole — route console lines by [prefix]", () => {
  const cases: Array<[string, string, string]> = [
    // line, expected channel, expected kind
    ["[agent] say: the ogre lunges",                 "conversation", "agent"],
    ["[agent] tool → update_token_hp({...})",        "conversation", "agent"],
    ["[ptt] PTT up (held 812ms)",                    "conversation", "ptt"],
    ["[ptt] PTT force-released — stuck key detected", "conversation", "ptt"],
    ["[aar] 6 turns, avg 2 steps",                   "conversation", "aar"],
    ["[inbox] reply failed: timeout",                "conversation", "inbox"],
    ["[roster] 7 names",                             "conversation", "roster"],
    ["[anthropic] SLOW 4100ms — rate-limit backoff", "conversation", "llm"],
    ["[stt] 540ms → \"fireball on the goblins\"",    "whisper",      "stt"],
    ["[correct] \"hair gone\" → \"Haregon\"",        "whisper",      "stt"],
    ["[ab-clip] save failed: disk full",             "whisper",      "stt"],
    ["[whisper] using whisper-server (cuda)",        "whisper",      "stt"],
    ["[whisper-server] exited code=0",               "whisper",      "stt"],
    ["[mcp] connected — 51 tools",                   "system",       "mcp"],
    ["[events] SSE closed — reconnecting in 3s",     "system",       "events"],
  ];

  for (const [line, channel, kind] of cases) {
    it(`"${line.slice(0, 32)}…" → ${channel}/${kind}`, () => {
      expect(classifyConsole(line)).toEqual({ channel, kind });
    });
  }

  it("unprefixed boot/shutdown noise falls through to system (not conversation)", () => {
    expect(classifyConsole("Electron Security Warning (Insecure CSP)")).toEqual({
      channel: "system", kind: "console",
    });
    expect(classifyConsole("app quitting").channel).toBe("system");
  });

  it("an unknown [prefix] is treated as system, not conversation", () => {
    expect(classifyConsole("[supervisorboot] spawned server").channel).toBe("system");
  });
});

describe("channelForKind — structured log() routing", () => {
  it("stt-family kinds → whisper", () => {
    for (const k of ["stt", "whisper", "correct", "ab-clip"]) {
      expect(channelForKind(k)).toBe("whisper");
    }
  });
  it("connection/lifecycle kinds → system", () => {
    for (const k of ["mcp", "events", "system", "supervisor", "boot"]) {
      expect(channelForKind(k)).toBe("system");
    }
  });
  it("everything else (the agent turn) → conversation", () => {
    for (const k of ["agent", "tool", "turn", "llm", "campaign", "ptt", "aar", "inbox", "console"]) {
      expect(channelForKind(k)).toBe("conversation");
    }
  });
});
