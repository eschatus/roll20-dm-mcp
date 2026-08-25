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

// --- Beyond20 gap-filler filtering (DdbGameLogPump.onFrame) -----------------
import { DdbGameLogPump } from "./ddb-gamelog.js";

// Build a minimal fulfilled-roll frame. b20=true marks a roll Beyond20 already
// bridged to Roll20 (data.__b20Override__), as seen live on players using Beyond20.
function frame(id: string, entityId: string, name: string, b20: boolean): string {
  return JSON.stringify({
    id, dateTime: "1", gameId: "1117568", userId: "1", entityId,
    eventType: "dice/roll/fulfilled",
    data: { action: "Roll", context: { name }, rolls: [{ rollType: "check", result: { constant: 0, text: "12", total: 12, values: [12] } }], ...(b20 ? { __b20Override__: true } : {}) },
  });
}
// Reach the private frame handler to exercise the real filter without a live WS.
const feed = (p: DdbGameLogPump, raw: string) => (p as unknown as { onFrame(r: string): void }).onFrame(raw);

describe("Beyond20 failover filtering", () => {
  it("by default SKIPS rolls Beyond20 already delivered, emits native ones", () => {
    const got: string[] = [];
    const p = new DdbGameLogPump({ gameId: "1117568", onRoll: (m) => { got.push(m.id); } });
    feed(p, frame("a", "111", "Morticia", true));   // bridged → skip
    feed(p, frame("b", "222", "Broo", false));       // native  → emit
    expect(got).toEqual(["b"]);
  });

  it("a FLAPPING bridge: emits only the dropped (native) rolls of the same character", () => {
    const got: string[] = [];
    const p = new DdbGameLogPump({ gameId: "1117568", onRoll: (m) => { got.push(m.id); } });
    // Glint: some rolls bridged, some dropped — only the dropped ones should post.
    feed(p, frame("g1", "333", "Glint", true));
    feed(p, frame("g2", "333", "Glint", false));
    feed(p, frame("g3", "333", "Glint", true));
    feed(p, frame("g4", "333", "Glint", false));
    expect(got).toEqual(["g2", "g4"]);
  });

  it("includeBeyond20 (skipBeyond20:false) mirrors EVERY roll", () => {
    const got: string[] = [];
    const p = new DdbGameLogPump({ gameId: "1117568", skipBeyond20: false, onRoll: (m) => { got.push(m.id); } });
    feed(p, frame("a", "111", "Morticia", true));
    feed(p, frame("b", "222", "Broo", false));
    expect(got).toEqual(["a", "b"]);
  });

  it("still honors the entity filter and dedups by id", () => {
    const got: string[] = [];
    const p = new DdbGameLogPump({ gameId: "1117568", entityIds: ["222"], onRoll: (m) => { got.push(m.id); } });
    feed(p, frame("b", "222", "Broo", false));
    feed(p, frame("b", "222", "Broo", false));   // same id → dedup
    feed(p, frame("c", "999", "Someone", false)); // other entity → filtered
    expect(got).toEqual(["b"]);
  });
});

// --- Reconnect backoff (#166) -----------------------------------------------
// The live failure mode: DDB accepts the WS upgrade (`open` fires and logs
// "connected") and then drops the connection with 1006; resetting the failure
// counter on `open` made the exponential ladder behave like a fixed 1s retry
// (~90 reconnects → 429). Health is now proven by a received frame or by the
// open surviving HEALTHY_AFTER_MS — only that resets the counter.
import { beforeEach, afterEach, vi } from "vitest";

// One fake socket per connect() call, in creation order. Tests drive lifecycle
// by emitting open/message/close on the latest instance. Defined via vi.hoisted
// (with a hand-rolled emitter) so the hoisted vi.mock factory can reference it.
const { sockets, FakeWebSocket } = vi.hoisted(() => {
  class FakeWebSocket {
    private handlers = new Map<string, Array<(...a: unknown[]) => void>>();
    closed = false;
    constructor(public url: string, public opts?: unknown) {
      sockets.push(this);
    }
    on(event: string, fn: (...a: unknown[]) => void): this {
      const list = this.handlers.get(event) ?? [];
      list.push(fn);
      this.handlers.set(event, list);
      return this;
    }
    emit(event: string, ...args: unknown[]): void {
      for (const fn of this.handlers.get(event) ?? []) fn(...args);
    }
    removeAllListeners(): void { this.handlers.clear(); }
    close(): void { this.closed = true; }
  }
  const sockets: FakeWebSocket[] = [];
  return { sockets, FakeWebSocket };
});

vi.mock("ws", () => ({ default: FakeWebSocket }));
vi.mock("./ddb-rt.js", () => ({
  rtAuthToken: vi.fn(async () => ({ token: "jwt", userId: "u1", expiresAt: Date.now() + 300_000 })),
  // History seed responds not-ok → seed is skipped; the pump proceeds regardless.
  rtRawFetch: vi.fn(async () => ({ ok: false, status: 404 })),
}));

const HEALTHY_AFTER_MS = 15_000;

function makePump(logs: string[]): DdbGameLogPump {
  return new DdbGameLogPump({
    gameId: "g1",
    onRoll: () => { /* not under test */ },
    onStatus: (s) => logs.push(s),
  });
}

// Delays actually scheduled, read from the user-visible log lines.
function loggedDelays(logs: string[]): number[] {
  return logs
    .map((l) => /reconnecting in (\d+)ms/.exec(l)?.[1])
    .filter((d): d is string => d !== undefined)
    .map(Number);
}

const latest = () => sockets[sockets.length - 1];

// Emit open→close(1006) on the current socket, then advance past the reconnect
// delay so the next connect() has produced a fresh socket.
async function failCycle(delayMs: number): Promise<void> {
  latest().emit("open");
  latest().emit("close", 1006);
  await vi.advanceTimersByTimeAsync(delayMs);
}

describe("DdbGameLogPump backoff (#166)", () => {
  let logs: string[];
  let pump: DdbGameLogPump;

  beforeEach(async () => {
    vi.useFakeTimers();
    sockets.length = 0;
    logs = [];
    pump = makePump(logs);
    await pump.start();
  });
  afterEach(() => {
    pump.stop();
    vi.useRealTimers();
  });

  it("advances the ladder when sockets open and immediately die", async () => {
    // Six open→1006 cycles. Before the fix, `open` reset the counter each time
    // and every delay stayed 1000ms.
    for (const d of [1_000, 2_000, 5_000, 10_000, 20_000, 20_000]) await failCycle(d);
    expect(loggedDelays(logs)).toEqual([1_000, 2_000, 5_000, 10_000, 20_000, 20_000]);
  });

  it("resets the ladder when a frame arrives, and not before", async () => {
    await failCycle(1_000);
    await failCycle(2_000);
    expect(pump.status().failures).toBe(2);

    // Third socket opens and actually talks to us.
    latest().emit("open");
    latest().emit("message", Buffer.from(JSON.stringify({ eventType: "noise" })));
    expect(pump.status().failures).toBe(0);

    // The next drop starts from the bottom of the ladder again.
    latest().emit("close", 1006);
    expect(loggedDelays(logs).pop()).toBe(1_000);
  });

  it("resets the ladder when an open survives HEALTHY_AFTER_MS", async () => {
    await failCycle(1_000);
    await failCycle(2_000);

    latest().emit("open");
    expect(pump.status().failures).toBe(2);           // opening alone proves nothing
    await vi.advanceTimersByTimeAsync(HEALTHY_AFTER_MS);
    expect(pump.status().failures).toBe(0);           // surviving does
  });

  it("reports retrying vs connected with failure count and last error", async () => {
    latest().emit("open");
    expect(pump.status()).toMatchObject({ state: "connected", failures: 0, lastError: null });

    latest().emit("close", 1006);
    expect(pump.status()).toMatchObject({ state: "retrying", failures: 1, lastError: "closed (1006)" });

    pump.stop();
    expect(pump.status().state).toBe("stopped");
  });
});
