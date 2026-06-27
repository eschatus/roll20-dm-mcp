import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  getHealth, recordSuccess, recordFailure, recordFallback, getStats, _resetForTest,
  resetHealth, circuitOpen,
  type TransportName,
} from "./transport-health.js";

beforeEach(() => _resetForTest());
afterEach(() => vi.useRealTimers());

describe("getHealth — initial state", () => {
  it("rt starts ok", () => expect(getHealth("rt")).toBe("ok"));
  it("browser starts ok", () => expect(getHealth("browser")).toBe("ok"));
});

describe("degraded after 1 failure", () => {
  it("rt is degraded after one failure", () => {
    recordFailure("rt");
    expect(getHealth("rt")).toBe("degraded");
  });
  it("browser is degraded after one failure", () => {
    recordFailure("browser");
    expect(getHealth("browser")).toBe("degraded");
  });
});

describe("down once the circuit opens (CB_THRESHOLD=3 consecutive failures)", () => {
  it("rt is still degraded after 2 failures (below threshold)", () => {
    recordFailure("rt");
    recordFailure("rt");
    expect(getHealth("rt")).toBe("degraded");
  });
  it("rt goes down at 3 failures (circuit open)", () => {
    recordFailure("rt");
    recordFailure("rt");
    recordFailure("rt");
    expect(getHealth("rt")).toBe("down");
  });
});

describe("success clears failures", () => {
  it("success after 3 failures resets to ok", () => {
    recordFailure("rt");
    recordFailure("rt");
    recordFailure("rt");
    expect(getHealth("rt")).toBe("down");
    recordSuccess("rt");
    expect(getHealth("rt")).toBe("ok");
  });
  it("success after 1 failure resets to ok", () => {
    recordFailure("rt");
    recordSuccess("rt");
    expect(getHealth("rt")).toBe("ok");
  });
});

describe("reset window clears stale-failure down state", () => {
  it("returns ok after 30s of quiet following sub-threshold failures", () => {
    vi.useFakeTimers();
    recordFailure("rt");
    recordFailure("rt");
    expect(getHealth("rt")).toBe("degraded");
    vi.advanceTimersByTime(30_001);
    expect(getHealth("rt")).toBe("ok");
  });
  it("stays degraded before the 30s window expires", () => {
    vi.useFakeTimers();
    recordFailure("rt");
    recordFailure("rt");
    vi.advanceTimersByTime(29_999);
    expect(getHealth("rt")).toBe("degraded");
  });
});

describe("transports are independent", () => {
  it("rt down does not affect browser", () => {
    recordFailure("rt");
    recordFailure("rt");
    recordFailure("rt");
    expect(getHealth("rt")).toBe("down");
    expect(getHealth("browser")).toBe("ok");
  });
});

describe("success/failure counters", () => {
  it("successes increments on recordSuccess", () => {
    recordSuccess("rt");
    recordSuccess("rt");
    expect(getStats().rt.successes).toBe(2);
  });
  it("failures increments on recordFailure", () => {
    recordFailure("rt");
    recordFailure("rt");
    expect(getStats().rt.failures).toBe(2);
  });
  it("success does not affect failures counter", () => {
    recordFailure("rt");
    recordSuccess("rt");
    expect(getStats().rt.failures).toBe(1);
    expect(getStats().rt.successes).toBe(1);
  });
  it("counters are independent per transport", () => {
    recordFailure("rt");
    recordSuccess("browser");
    expect(getStats().rt.failures).toBe(1);
    expect(getStats().rt.successes).toBe(0);
    expect(getStats().browser.failures).toBe(0);
    expect(getStats().browser.successes).toBe(1);
  });
});

describe("recordFallback", () => {
  it("increments fallbacks for the from-transport", () => {
    recordFallback("rt");
    recordFallback("rt");
    expect(getStats().rt.fallbacks).toBe(2);
    expect(getStats().browser.fallbacks).toBe(0);
  });
  it("fallbacks on browser do not affect rt", () => {
    recordFallback("browser");
    expect(getStats().rt.fallbacks).toBe(0);
    expect(getStats().browser.fallbacks).toBe(1);
  });
});

describe("recordFailure with action", () => {
  it("records lastFailureAction when action is provided", () => {
    recordFailure("rt", "relay:sendChat");
    expect(getStats().rt.lastFailureAction).toBe("relay:sendChat");
  });
  it("lastFailureAction is null when no action provided", () => {
    recordFailure("rt");
    expect(getStats().rt.lastFailureAction).toBeNull();
  });
  it("action is overwritten by subsequent failure", () => {
    recordFailure("rt", "action1");
    recordFailure("rt", "action2");
    expect(getStats().rt.lastFailureAction).toBe("action2");
  });
  it("action is backward compatible — existing callers pass no arg", () => {
    // Should not throw
    expect(() => recordFailure("browser")).not.toThrow();
    expect(getStats().browser.lastFailureAction).toBeNull();
  });
});

describe("getStats shape", () => {
  it("returns all expected fields for both transports", () => {
    for (const name of ["rt", "browser"] as TransportName[]) {
      const s = getStats()[name];
      expect(s).toHaveProperty("health");
      expect(s).toHaveProperty("successes");
      expect(s).toHaveProperty("failures");
      expect(s).toHaveProperty("consecutiveFailures");
      expect(s).toHaveProperty("fallbacks");
      expect(s).toHaveProperty("lastFailureAt");
      expect(s).toHaveProperty("lastFailureAction");
    }
  });
  it("health in getStats matches getHealth", () => {
    recordFailure("rt");
    recordFailure("rt");
    expect(getStats().rt.health).toBe(getHealth("rt"));
    expect(getStats().browser.health).toBe(getHealth("browser"));
  });
  it("consecutiveFailures resets on success but failures counter does not", () => {
    recordFailure("rt");
    recordFailure("rt");
    recordSuccess("rt");
    const s = getStats().rt;
    expect(s.consecutiveFailures).toBe(0);
    expect(s.failures).toBe(2);
    expect(s.successes).toBe(1);
  });
  it("lastFailureAt is null before any failure", () => {
    expect(getStats().rt.lastFailureAt).toBeNull();
  });
  it("lastFailureAt is set after a failure", () => {
    const before = Date.now();
    recordFailure("rt");
    expect(getStats().rt.lastFailureAt).toBeGreaterThanOrEqual(before);
  });
});

describe("_resetForTest clears new counters", () => {
  it("resets successes, failures, fallbacks, lastFailureAction", () => {
    recordSuccess("rt");
    recordFailure("rt", "some-action");
    recordFallback("rt");
    _resetForTest();
    const s = getStats().rt;
    expect(s.successes).toBe(0);
    expect(s.failures).toBe(0);
    expect(s.fallbacks).toBe(0);
    expect(s.lastFailureAt).toBeNull();
    expect(s.lastFailureAction).toBeNull();
    expect(s.consecutiveFailures).toBe(0);
  });
  it("resetHealth also clears circuit fields (openedAt, halfOpen) — issue #103", () => {
    recordFailure("rt");
    recordFailure("rt");
    recordFailure("rt"); // circuit open
    expect(getStats().rt.circuitOpen).toBe(true);
    resetHealth();
    const s = getStats().rt;
    expect(s.circuitOpen).toBe(false);
    expect(s.halfOpen).toBe(false);
    expect(getHealth("rt")).toBe("ok");
    // circuitOpen() sees a clean machine.
    expect(circuitOpen("rt").open).toBe(false);
  });
});

describe("circuit breaker (folded into transport-health, issue #102)", () => {
  it("circuit is closed until CB_THRESHOLD consecutive failures", () => {
    recordFailure("rt");
    recordFailure("rt");
    expect(circuitOpen("rt").open).toBe(false);
    recordFailure("rt"); // 3rd → open
    expect(circuitOpen("rt").open).toBe(true);
    expect(circuitOpen("rt").secsLeft).toBeGreaterThan(0);
  });

  it("a success closes the circuit (self-heal)", () => {
    recordFailure("rt");
    recordFailure("rt");
    recordFailure("rt");
    expect(circuitOpen("rt").open).toBe(true);
    recordSuccess("rt");
    expect(circuitOpen("rt").open).toBe(false);
    expect(getStats().rt.circuitOpen).toBe(false);
  });

  it("half-open probe is allowed through after the reset window", () => {
    vi.useFakeTimers();
    recordFailure("rt");
    recordFailure("rt");
    recordFailure("rt");
    expect(circuitOpen("rt").open).toBe(true);
    vi.advanceTimersByTime(30_001);
    const decision = circuitOpen("rt");
    expect(decision.open).toBe(false);
    expect(decision.halfOpen).toBe(true);
  });

  it("a FAILED half-open probe re-opens immediately (issue #97)", () => {
    vi.useFakeTimers();
    recordFailure("rt");
    recordFailure("rt");
    recordFailure("rt");
    vi.advanceTimersByTime(30_001);
    expect(circuitOpen("rt").halfOpen).toBe(true); // probe allowed
    recordFailure("rt"); // probe failed → re-open NOW (not after 3 more)
    expect(circuitOpen("rt").open).toBe(true);
  });

  it("a SUCCESSFUL half-open probe closes the circuit", () => {
    vi.useFakeTimers();
    recordFailure("rt");
    recordFailure("rt");
    recordFailure("rt");
    vi.advanceTimersByTime(30_001);
    expect(circuitOpen("rt").halfOpen).toBe(true);
    recordSuccess("rt"); // probe succeeded
    expect(circuitOpen("rt").open).toBe(false);
    expect(getStats().rt.halfOpen).toBe(false);
    expect(getHealth("rt")).toBe("ok");
  });

  it("getHealth reports down exactly while the circuit is open (no divergence, #102)", () => {
    vi.useFakeTimers();
    recordFailure("rt");
    recordFailure("rt");
    recordFailure("rt");
    expect(getHealth("rt")).toBe("down");
    expect(getStats().rt.circuitOpen).toBe(true);
  });
});
