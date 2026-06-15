export type TransportName = "rt" | "browser";
export type Health = "ok" | "degraded" | "down";

interface TransportState {
  consecutiveFailures: number;
  lastFailureAt: number | null;
  lastFailureAction: string | null;
  successes: number;
  failures: number;
  fallbacks: number;
}

const QUIET_WINDOW_MS = 60_000;

const _state: Record<TransportName, TransportState> = {
  rt:      { consecutiveFailures: 0, lastFailureAt: null, lastFailureAction: null, successes: 0, failures: 0, fallbacks: 0 },
  browser: { consecutiveFailures: 0, lastFailureAt: null, lastFailureAction: null, successes: 0, failures: 0, fallbacks: 0 },
};

export function recordSuccess(name: TransportName): void {
  _state[name].consecutiveFailures = 0;
  _state[name].successes++;
}

export function recordFailure(name: TransportName, action?: string): void {
  _state[name].consecutiveFailures++;
  _state[name].lastFailureAt = Date.now();
  _state[name].lastFailureAction = action ?? null;
  _state[name].failures++;
}

export function recordFallback(from: TransportName): void {
  _state[from].fallbacks++;
}

export function getHealth(name: TransportName): Health {
  const s = _state[name];
  if (s.consecutiveFailures === 0) return "ok";
  if (s.lastFailureAt !== null && Date.now() - s.lastFailureAt >= QUIET_WINDOW_MS) return "ok";
  if (s.consecutiveFailures >= 2) return "down";
  return "degraded";
}

export function getStats(): Record<TransportName, {
  health: Health;
  successes: number;
  failures: number;
  consecutiveFailures: number;
  fallbacks: number;
  lastFailureAt: number | null;
  lastFailureAction: string | null;
}> {
  const result = {} as Record<TransportName, {
    health: Health;
    successes: number;
    failures: number;
    consecutiveFailures: number;
    fallbacks: number;
    lastFailureAt: number | null;
    lastFailureAction: string | null;
  }>;
  for (const name of Object.keys(_state) as TransportName[]) {
    const s = _state[name];
    result[name] = {
      health: getHealth(name),
      successes: s.successes,
      failures: s.failures,
      consecutiveFailures: s.consecutiveFailures,
      fallbacks: s.fallbacks,
      lastFailureAt: s.lastFailureAt,
      lastFailureAction: s.lastFailureAction,
    };
  }
  return result;
}

// Exposed for testing only — resets all state.
export function _resetForTest(): void {
  for (const name of Object.keys(_state) as TransportName[]) {
    _state[name].consecutiveFailures = 0;
    _state[name].lastFailureAt = null;
    _state[name].lastFailureAction = null;
    _state[name].successes = 0;
    _state[name].failures = 0;
    _state[name].fallbacks = 0;
  }
}
