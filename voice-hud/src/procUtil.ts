// Shared child-process teardown helper.
//
// Several spawned binaries here (whisper-server, the supervised roll20-dm MCP server)
// do not exit on SIGTERM — their native runtime appears to mask/ignore it. A bare
// `proc.kill()` followed by `proc = null` therefore lies: the JS handle is dropped but
// the OS process keeps running, orphaned, still bound to its port. Confirmed in
// practice: a whisper-server child survived an app quit+restart for 18+ hours, and a
// separate MCP server process needed SIGKILL twice after SIGTERM was ignored.
//
// killAndWait sends SIGTERM, waits for the real "exit" event up to timeoutMs, and
// escalates to SIGKILL if the process is still alive — resolving only once the OS
// process is actually gone (or already gone).
import { ChildProcess } from "child_process";

export function killAndWait(proc: ChildProcess | null, timeoutMs = 2000): Promise<void> {
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve();
  return new Promise<void>((resolve) => {
    let settled = false;
    const done = () => { if (!settled) { settled = true; clearTimeout(timer); resolve(); } };
    proc.once("exit", done);
    const timer = setTimeout(() => {
      if (settled) return;
      try { proc.kill("SIGKILL"); } catch { /* already gone */ }
      // Give SIGKILL a moment to land; if the "exit" event still doesn't fire, resolve
      // anyway rather than hang the caller forever on an unkillable process.
      setTimeout(done, 1000);
    }, timeoutMs);
    try { proc.kill("SIGTERM"); } catch { done(); }
  });
}
