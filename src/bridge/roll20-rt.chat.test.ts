// ─────────────────────────────────────────────────────────────────────────────
// SSE chat forwarding (#171) — the transport half the repo keeps when the LLM
// brain moves to the gem: every live table message, !-command, and !dm must
// reach /events as a `chat-message` event; the bridge's own traffic must not.
// Driven through the __handleChatChildForTest seam (no RTDB connection).
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  __handleChatChildForTest as handleChatChild,
  __seedPendingRelayForTest as seedPending,
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

// ─────────────────────────────────────────────────────────────────────────────
// #213 — the relay REPLY must resolve the pending command, whichever marker the
// campaign's deployed relay uses. Relay 2.7.0 moved the payload under
// AIBRIDGE_RESULT_ENC:; parseAibridge learned that marker but the gate in front
// of it kept testing for "AIBRIDGE_RESULT:", which is NOT a substring of
// "AIBRIDGE_RESULT_ENC:". Every reply was dropped before it was parsed, every
// round-trip timed out, and every test stayed green because they all called
// parseAibridge directly. These go through the gate.
// ─────────────────────────────────────────────────────────────────────────────
describe("relay reply resolution (#213)", () => {
  const encReply = (payload: object) =>
    `<div style='display:none'>AIBRIDGE_RESULT_ENC:${encodeURIComponent(JSON.stringify(payload))}</div>`;
  const legacyReply = (payload: object) =>
    `<div style='display:none'>AIBRIDGE_RESULT:${JSON.stringify(payload)}</div>`;
  const deliver = (content: string) =>
    handleChatChild(nextKey(), { who: "GM-AI-Bridge", playerid: "API", content }, true);

  it("resolves a pending command from a relay >= 2.7.0 percent-encoded reply", async () => {
    const p = seedPending(4242);
    deliver(encReply({ nonce: 4242, data: { ok: true, version: "2.7.0" } }));
    await expect(p).resolves.toEqual({ ok: true, version: "2.7.0" });
  });

  it("still resolves a legacy reply (deploys are per-campaign and manual)", async () => {
    const p = seedPending(4243);
    deliver(legacyReply({ nonce: 4243, data: { ok: true } }));
    await expect(p).resolves.toEqual({ ok: true });
  });

  it("rejects on a relay error, encoded", async () => {
    const p = seedPending(4244);
    deliver(encReply({ nonce: 4244, error: "no such token" }));
    await expect(p).rejects.toThrow("no such token");
  });

  it("does not consume a reply meant for another nonce", async () => {
    const p = seedPending(4245);
    deliver(encReply({ nonce: 999999, data: "someone else's" }));
    let settled = false;
    void p.then(() => { settled = true; }, () => { settled = true; });
    await new Promise((r) => setTimeout(r, 0));
    expect(settled).toBe(false);
  });
});
