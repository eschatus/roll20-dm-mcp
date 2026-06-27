export type TransportName = "rt" | "browser";
export type Health = "ok" | "degraded" | "down";

interface TransportState {
  consecutiveFailures: number;
  lastFailureAt: number | null;
  lastFailureAction: string | null;
  successes: number;
  failures: number;
  fallbacks: number;
  // Circuit-breaker machine (folded in — single source of truth, issue #102).
  // openedAt: wall-clock ms when the circuit last OPENED (null while closed).
  openedAt: number | null;
  // halfOpen: true while exactly one probe is allowed through after the reset window
  // elapsed. A FAILED half-open probe must re-open immediately (issue #97), so we flag
  // it rather than letting the counter re-accumulate from zero.
  halfOpen: boolean;
}

// ─── Single source of truth for failure thresholds (issue #102) ─────────────────
// The circuit-breaker state machine and getHealth() are derived from ONE counter
// (consecutiveFailures) and ONE pair of thresholds, so call-gating and the reported
// health can never disagree.
//   - CB_THRESHOLD: open the circuit after this many consecutive failures.
//   - CB_RESET_MS:  while open, skip calls for this long; then allow one half-open probe.
// getHealth() is made consistent: "down" once the circuit is open (>= CB_THRESHOLD
// consecutive failures), "degraded" for 1..CB_THRESHOLD-1 failures, "ok" otherwise.
const CB_THRESHOLD = 3;
const CB_RESET_MS = 30_000;

function freshState(): TransportState {
  return {
    consecutiveFailures: 0,
    lastFailureAt: null,
    lastFailureAction: null,
    successes: 0,
    failures: 0,
    fallbacks: 0,
    openedAt: null,
    halfOpen: false,
  };
}

const _state: Record<TransportName, TransportState> = {
  rt: freshState(),
  browser: freshState(),
};

export function recordSuccess(name: TransportName): void {
  // Any success fully self-heals the circuit (closes it, clears the probe flag).
  const s = _state[name];
  s.consecutiveFailures = 0;
  s.openedAt = null;
  s.halfOpen = false;
  s.successes++;
}

export function recordFailure(name: TransportName, action?: string): void {
  const s = _state[name];
  s.consecutiveFailures++;
  s.lastFailureAt = Date.now();
  s.lastFailureAction = action ?? null;
  s.failures++;

  if (s.halfOpen) {
    // A failed half-open probe means the transport is still dead — re-open IMMEDIATELY
    // rather than granting CB_THRESHOLD fresh retries. (Issue #97.)
    s.halfOpen = false;
    s.openedAt = Date.now();
    return;
  }
  if (s.consecutiveFailures >= CB_THRESHOLD && s.openedAt === null) {
    s.openedAt = Date.now();
  }
}

export function recordFallback(from: TransportName): void {
  _state[from].fallbacks++;
}

// Circuit-breaker decision the relay consults BEFORE attempting a call.
//   - { open: false }                       → attempt normally.
//   - { open: false, halfOpen: true }       → attempt as a probe (reset window elapsed);
//                                             a failure will re-open immediately.
//   - { open: true, secsLeft }              → skip the call (circuit open, still cooling down).
// IMPORTANT: this has a side effect when the reset window elapses — it transitions the
// circuit to half-open so the very next call is the single allowed probe. Call it exactly
// once per attempt, right before sending.
export function circuitOpen(name: TransportName): { open: boolean; secsLeft?: number; halfOpen?: boolean } {
  const s = _state[name];
  if (s.openedAt === null) {
    // Closed (or already half-open from a prior elapse). Surface halfOpen so callers can log.
    return { open: false, halfOpen: s.halfOpen };
  }
  const elapsed = Date.now() - s.openedAt;
  if (elapsed >= CB_RESET_MS) {
    // Transition to half-open: clear the open window and let exactly one probe through.
    // (Don't touch consecutiveFailures — recordSuccess clears it on a passing probe,
    // recordFailure re-opens on a failing one.)
    s.openedAt = null;
    s.halfOpen = true;
    return { open: false, halfOpen: true };
  }
  const secsLeft = Math.ceil((CB_RESET_MS - elapsed) / 1000);
  return { open: true, secsLeft };
}

export function getHealth(name: TransportName): Health {
  const s = _state[name];
  // Circuit open → unambiguously down (consistent with call-gating, issue #102).
  if (s.openedAt !== null) return "down";
  if (s.consecutiveFailures === 0) return "ok";
  // Stale failures with no open circuit and a long quiet spell → recovered.
  if (s.lastFailureAt !== null && Date.now() - s.lastFailureAt >= CB_RESET_MS) return "ok";
  if (s.consecutiveFailures >= CB_THRESHOLD) return "down";
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
  circuitOpen: boolean;
  halfOpen: boolean;
}> {
  const result = {} as Record<TransportName, {
    health: Health;
    successes: number;
    failures: number;
    consecutiveFailures: number;
    fallbacks: number;
    lastFailureAt: number | null;
    lastFailureAction: string | null;
    circuitOpen: boolean;
    halfOpen: boolean;
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
      circuitOpen: s.openedAt !== null,
      halfOpen: s.halfOpen,
    };
  }
  return result;
}

// Reset ALL transport state — the single test-reset seam (issue #103). Clears the
// circuit-breaker fields (openedAt, halfOpen) too, so no circuit state leaks between cases.
export function resetHealth(): void {
  for (const name of Object.keys(_state) as TransportName[]) {
    _state[name] = freshState();
  }
}

// Back-compat alias for existing test imports.
export const _resetForTest = resetHealth;
