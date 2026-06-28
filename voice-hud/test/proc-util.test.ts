import { describe, it, expect } from "vitest";
import { spawn } from "child_process";
import { killAndWait } from "../src/procUtil";

describe("killAndWait", () => {
  it("resolves immediately for a null process", async () => {
    await expect(killAndWait(null)).resolves.toBeUndefined();
  });

  it("resolves immediately for an already-exited process", async () => {
    const proc = spawn("true", []);
    await new Promise<void>((r) => proc.once("exit", () => r()));
    await expect(killAndWait(proc)).resolves.toBeUndefined();
  });

  it("kills a normal child that responds to SIGTERM", async () => {
    const proc = spawn("sleep", ["30"]);
    await killAndWait(proc, 2000);
    expect(proc.exitCode === null ? proc.signalCode : true).toBeTruthy();
  });

  it("escalates to SIGKILL when the child ignores SIGTERM", async () => {
    // A short shell script that traps SIGTERM and ignores it, forcing the SIGKILL path.
    const proc = spawn("sh", ["-c", "trap '' TERM; sleep 30"]);
    await new Promise((r) => setTimeout(r, 200)); // let the trap install
    const t0 = Date.now();
    await killAndWait(proc, 500); // short timeout so the test doesn't wait the full default
    const elapsed = Date.now() - t0;
    expect(proc.killed || proc.signalCode !== null || proc.exitCode !== null).toBeTruthy();
    expect(elapsed).toBeLessThan(3000);
  }, 5000);
});
