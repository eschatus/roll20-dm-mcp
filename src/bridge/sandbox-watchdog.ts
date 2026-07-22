import { pingMod, broadcastSandboxStatus } from "./roll20-rt.js";
import { reconnectRoll20 } from "./roll20.js";

const DEFAULT_INTERVAL_MS = 5 * 60_000;
const WAKE_SETTLE_MS = 20_000;

let _inFlight = false;
let _suspended = false; // true after 2nd consecutive miss; cleared when a ping succeeds

export function startWatchdog(): void {
  const intervalMs = process.env.SANDBOX_WATCHDOG_MS !== undefined
    ? parseInt(process.env.SANDBOX_WATCHDOG_MS, 10)
    : DEFAULT_INTERVAL_MS;
  if (!intervalMs || intervalMs <= 0) {
    console.error("[watchdog] disabled (SANDBOX_WATCHDOG_MS=0)");
    return;
  }
  console.error(`[watchdog] started (interval ${intervalMs}ms)`);
  schedule(intervalMs);
}

function schedule(intervalMs: number): void {
  // runCycle reschedules itself in its `finally`, but if its body throws, `finally` runs AND
  // then re-throws — a bare `void`'d rejection would crash the process. Swallow it here (the
  // reschedule already happened): the watchdog loop must survive any single cycle's failure.
  setTimeout(() => {
    runCycle(intervalMs).catch((e) => console.error("[watchdog] cycle error (loop continues):", (e as Error).message));
  }, intervalMs);
}

async function runCycle(intervalMs: number): Promise<void> {
  if (_inFlight) { schedule(intervalMs); return; }
  _inFlight = true;
  try {
    const alive = await pingMod();
    if (alive) {
      if (_suspended) {
        console.error("[watchdog] sandbox is back online");
        _suspended = false;
      }
      broadcastSandboxStatus(true);
    } else if (_suspended) {
      // Already gave up after the last miss — skip the wake dance, just broadcast state
      console.error("[watchdog] sandbox still unreachable (suspended — waiting for ping to succeed)");
      broadcastSandboxStatus(false);
    } else {
      // First miss this run — try to wake by joining the editor
      console.error("[watchdog] sandbox ping missed — attempting wake via browser");
      broadcastSandboxStatus(false);
      try {
        await reconnectRoll20({ hard: false });
      } catch (e) {
        console.error("[watchdog] reconnect error:", (e as Error).message);
      }
      await new Promise<void>((r) => setTimeout(r, WAKE_SETTLE_MS));
      const alive2 = await pingMod();
      if (alive2) {
        console.error("[watchdog] sandbox woke successfully");
        broadcastSandboxStatus(true);
      } else {
        console.error("[watchdog] sandbox unreachable after wake attempt — Mod may have crashed; check the API console");
        _suspended = true;
        broadcastSandboxStatus(false);
      }
    }
  } finally {
    _inFlight = false;
    schedule(intervalMs);
  }
}
