// ─────────────────────────────────────────────────────────────────────────────
// Nothing this relay says may contain a LIVE chat-pipeline trigger.
//
// Roll20 live-evaluates three sequences in every outgoing chat message: "[[" (inline
// roll), "@{" (attribute ref) and "%{" (ability/macro call). A malformed one throws
// inside Roll20's own chat pipeline — asynchronously, where no try/catch of ours can
// reach it — and DISABLES THE WHOLE Mod sandbox, not just that message.
//
// writeResult neutralized these; nothing else did. The `!dm` handler takes text a
// PLAYER typed and echoes it straight back into chat, so `!dm [[grapple the ogre`
// killed the relay for the entire table — a player-triggerable outage, no GM
// involvement and no malice required. That is the case pinned first below.
//
// esc() was never protection here: it escapes HTML metacharacters and leaves all
// three triggers perfectly intact.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { Roll20Emulator } from "./roll20-emulator.js";

let emu: Roll20Emulator;

beforeEach(() => {
  emu = new Roll20Emulator({ seed: 7 });
  emu.load();
  emu.chatLog.length = 0;
});

/** Every trigger sequence that must never survive into an outgoing message. */
function assertNoLiveTriggers(content: string): void {
  expect(content).not.toContain("[[");
  expect(content).not.toContain("@{");
  expect(content).not.toContain("%{");
}

describe("chatSend is the only door out", () => {
  // The source-level guard, and the reason this bug cannot come back the way it arrived.
  // Patching call sites one at a time is precisely how sixteen sendChat sites ended up with one
  // escape between them. A new sendChat added later must fail here rather than in a live session,
  // where the symptom is the entire Mod sandbox switching off mid-combat.
  it("has exactly one raw sendChat( call in the relay, inside chatSend", () => {
    const src = readFileSync("mod-scripts/ai-relay.js", "utf8");
    const calls = src
      .split("\n")
      .map((line, i) => ({ line: line.trim(), n: i + 1 }))
      .filter((l) => /(^|[^A-Za-z0-9_.])sendChat\s*\(/.test(l.line) && !l.line.startsWith("//"));

    expect(
      calls.map((c) => `${c.n}: ${c.line}`),
      "every outgoing message must go through chatSend()",
    ).toHaveLength(1);
    expect(src).toContain("function chatSend(");
  });
});

describe("player-typed text can never carry a live trigger into chat", () => {
  it("neutralizes an inline roll a player typed after !dm", () => {
    // The exact shape that took the sandbox down: an unclosed inline roll whose first
    // character is a letter, so Roll20's dice parser fails on "g" and kills the sandbox.
    emu.dispatchChat("!dm [[grapple the ogre", { playerid: "player-1", who: "Brie" });

    expect(emu.chatLog.length).toBeGreaterThan(0);
    for (const m of emu.chatLog) assertNoLiveTriggers(m.content);

    // Neutralized, not dropped — the DM still needs to read what the player said.
    const ack = emu.chatLog.map((m) => m.content).join("\n");
    expect(ack).toContain("grapple the ogre");
  });

  it("neutralizes attribute and macro refs a player typed", () => {
    emu.dispatchChat("!dm I use @{Brie|strength} and %{Vampire|kingdom-culture-action}", {
      playerid: "player-1", who: "Brie",
    });
    for (const m of emu.chatLog) assertNoLiveTriggers(m.content);
  });

  it("neutralizes a trigger hidden in a player's DISPLAY NAME", () => {
    // who is player-controlled too, and it lands in the /desc broadcast.
    emu.dispatchChat("!dm ready", { playerid: "player-1", who: "[[grim" });
    for (const m of emu.chatLog) assertNoLiveTriggers(m.content);
  });

  it("shows entity text a player typed as literal text, without reviving a trigger", () => {
    // esc() escapes "&" before chatSafe runs, so a player who literally types "&#91;&#91;" reads
    // back "&amp;#91;&amp;#91;" — which RENDERS as the "&#91;&#91;" they typed. That is correct
    // HTML escaping, and the point here is the invariant it protects: no round-trip through chat
    // can turn player text back into a live "[[".
    emu.dispatchChat("!dm &#91;&#91;already encoded", { playerid: "player-1", who: "Brie" });
    const joined = emu.chatLog.map((m) => m.content).join("\n");
    assertNoLiveTriggers(joined);
    expect(joined).toContain("already encoded");
  });
});

describe("relay-authored free text is neutralized too", () => {
  it("neutralizes narration text", () => {
    emu.relay({ action: "sendNarration", text: "The rune reads [[goblin-tongue @{secret}", style: "narration" });
    for (const m of emu.chatLog) assertNoLiveTriggers(m.content);
  });

  it("neutralizes a whisper body but leaves the whisper TARGET addressable", () => {
    emu.relay({ action: "whisperPlayer", playerName: "Brie", message: "psst [[goblins ahead" });
    const whisper = emu.chatLog.find((m) => m.content.startsWith("/w "));
    expect(whisper).toBeDefined();
    assertNoLiveTriggers(whisper!.content);
    // "/w <name>" is a routing address, not display text — escaping it would misroute.
    expect(whisper!.content.startsWith("/w Brie ")).toBe(true);
  });
});

describe("rolls we MEAN to send still go out live", () => {
  it("keeps the relay's own inline roll intact while escaping the token name", () => {
    // The initiative message carries a deliberate [[1d20…]] in the SAME string as a
    // token name. Blanket-escaping it would silently stop initiative from rolling.
    const pageId = emu.playerPageId;
    const token = emu.createToken({ name: "Goblin [[grim", pageId, bar1_value: 7, bar1_max: 7 });
    emu.chatLog.length = 0;

    emu.relay({ action: "rollInitiativeForTokens", tokenIds: [token.id], pageId });

    const initMsg = emu.chatLog.find((m) => m.who === "Initiative" && m.content.includes("1d20"));
    expect(initMsg).toBeDefined();
    // The roll survives...
    expect(initMsg!.content).toContain("[[1d20");
    // ...but the name's trigger does not: no SECOND, malformed inline roll.
    expect(initMsg!.content).not.toContain("[[grim");
    expect(initMsg!.content).toContain("&#91;&#91;grim");
  });
});
