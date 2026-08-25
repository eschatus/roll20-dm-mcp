// ─────────────────────────────────────────────────────────────────────────────
// Issue #166 — the reconnect backoff must advance when a socket opens and then
// immediately dies. The live failure mode: DDB accepts the WS upgrade (so `open`
// fires and logs "connected") and then drops the connection with 1006; resetting
// the failure counter on `open` made the exponential ladder behave like a fixed
// 1 s retry (~90 reconnects → 429). Health is now proven by a received frame or
// by the open surviving HEALTHY_AFTER_MS — only that resets the counter.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

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

import { DdbGameLogPump } from "./ddb-gamelog.js";

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
