// ─────────────────────────────────────────────────────────────────────────────
// SSE chat forwarding (#171) — the transport half the repo keeps when the LLM
// brain moves to the gem: every live table message, !-command, and !dm must
// reach /events as a `chat-message` event; the bridge's own traffic must not.
// Driven through the __handleChatChildForTest seam (no RTDB connection).
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  __handleChatChildForTest as handleChatChild,
  onRtdbEvent,
  type RtdbBroadcastEvent,
  type ChatMessageEvent,
} from "./roll20-rt.js";

let events: RtdbBroadcastEvent[];
let unsub: () => void;
let keyCounter = 0;

// Unique RTDB child key per message — handleChatChild dedups on it.
const nextKey = () => `chat-key-${++keyCounter}`;

const chatOf = (e: RtdbBroadcastEvent): ChatMessageEvent | null =>
  e.type === "chat-message" ? e.message : null;
const chatEvents = () => events.map(chatOf).filter((m): m is ChatMessageEvent => m !== null);

beforeEach(() => {
  events = [];
  unsub = onRtdbEvent((e) => events.push(e));
});
afterEach(() => unsub());

describe("SSE chat forwarding (#171)", () => {
  it("forwards a live player message with who/playerid/content", () => {
    handleChatChild(nextKey(), { who: "Rigan", playerid: "p-rigan", type: "general", content: "I search the altar" }, true);
    expect(chatEvents()).toHaveLength(1);
    expect(chatEvents()[0]).toMatchObject({
      who: "Rigan", playerid: "p-rigan", content: "I search the altar", isCommand: false,
    });
  });

  it("forwards player !-commands raw, flagged isCommand", () => {
    handleChatChild(nextKey(), { who: "Winsome", playerid: "p-win", content: "!tactics" }, true);
    expect(chatEvents()[0]).toMatchObject({ content: "!tactics", isCommand: true });
  });

  it("forwards !dm messages AND still classifies them as inbox items", () => {
    handleChatChild(nextKey(), { who: "Leolen", playerid: "p-leo", content: "!dm can I sneak past?" }, true);
    expect(chatEvents()[0]).toMatchObject({ content: "!dm can I sneak past?", isCommand: true });
    const inbox = events.find((e) => e.type === "inbox-item");
    expect(inbox).toMatchObject({ type: "inbox-item", item: { who: "Leolen", content: "can I sneak past?", type: "query" } });
  });

  it("carries inline-roll results machine-readable (Beyond20 rolls)", () => {
    handleChatChild(nextKey(), {
      who: "Hugh", playerid: "p-hugh", content: "attack [[1d20+5]]",
      inlinerolls: [{ expression: "1d20+5", results: { total: 19 } }],
    }, true);
    expect(chatEvents()[0]?.inlinerolls).toEqual([{ expression: "1d20+5", total: 19 }]);
  });

  // #187: a rolltemplate's numbers are pointers into inlinerolls, so two attacks that hit for
  // different amounts arrive as byte-identical `content`. Resolve them where parseTableChat is
  // shared, so the SSE stream and the get_recent_chat buffer both carry the real total.
  it("resolves $[[n]] roll pointers into content (Beyond20 / GM rolltemplates)", () => {
    const rockAttack = (total: number) => ({
      who: "Fire Giant Trooper", playerid: "p-gm", type: "general",
      content: "{{charname=Fire Giant Trooper}} {{rname=Rock (Group Attack)}} {{mod=+10}} {{r1=$[[0]]}} {{attack=1}} {{dmg1=6}}",
      inlinerolls: [{ expression: "1d20 +10", results: { total } }],
    });
    handleChatChild(nextKey(), rockAttack(16), true);
    handleChatChild(nextKey(), rockAttack(13), true);

    const contents = chatEvents().map((m) => m.content);
    expect(contents[0]).toContain("{{r1=16}}");
    expect(contents[1]).toContain("{{r1=13}}");
    expect(contents[0]).not.toContain("$[[0]]");
    // The two rolls used to be indistinguishable — that identity WAS the bug.
    expect(contents[0]).not.toBe(contents[1]);
    // inlinerolls still rides along: `expression` carries what the substitution does not.
    expect(chatEvents()[0]?.inlinerolls).toEqual([{ expression: "1d20 +10", total: 16 }]);
  });

  it("never forwards the bridge's own traffic", () => {
    handleChatChild(nextKey(), { who: "GM", playerid: "p-gm", content: '!ai-relay {"action":"getTokens"}' }, true);
    handleChatChild(nextKey(), { who: "GM-AI-Bridge", playerid: "API", content: "AIBRIDGE_RESULT:{\"nonce\":123}" }, true);
    handleChatChild(nextKey(), { who: "Initiative", playerid: "API", content: "some mod output" }, true);
    expect(chatEvents()).toHaveLength(0);
  });

  it("stays silent during the connect-time replay burst (live=false)", () => {
    handleChatChild(nextKey(), { who: "Rigan", playerid: "p-rigan", content: "old message" }, false);
    expect(chatEvents()).toHaveLength(0);
  });

  it("dedups on the RTDB child key", () => {
    const key = nextKey();
    handleChatChild(key, { who: "Rigan", playerid: "p-rigan", content: "once" }, true);
    handleChatChild(key, { who: "Rigan", playerid: "p-rigan", content: "once" }, true);
    expect(chatEvents()).toHaveLength(1);
  });
});
