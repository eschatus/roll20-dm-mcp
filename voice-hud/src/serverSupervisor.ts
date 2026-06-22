// App-owned MCP-server supervision (packaging Phase B).
//
// In a packaged / gem-primary install the gem OWNS the roll20-dm HTTP server: it spawns
// it as a child (inheriting DMW/ROLL20 env, incl. ROLL20_DATA_DIR from bootstrap.ts),
// waits for it to bind :39200, restarts it on crash, and kills it on quit — so that user
// never opens a terminal or runs launch-gem.cmd. This folds the .cmd's crude
// "start-if-not-running" into the app and adds restart + clean shutdown.
//
// OPT-IN: engages only when packaged OR DMW_SUPERVISE_SERVER=1. In plain dev it's a
// no-op, so `npm run serve` / launch-gem.cmd stay the source of truth — zero regression.
import { app } from "electron";
import { spawn, ChildProcess } from "child_process";
import * as net from "net";
import * as path from "path";

const PORT = Number(process.env.ROLL20_HTTP_PORT) || 39200;
const HOST = "127.0.0.1";

export function shouldSupervise(): boolean {
  return app.isPackaged || process.env.DMW_SUPERVISE_SERVER === "1";
}

// TCP liveness probe — route-agnostic; a successful connect means something is bound.
export function portUp(port = PORT, host = HOST, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.createConnection({ port, host });
    const done = (up: boolean) => { sock.removeAllListeners(); sock.destroy(); resolve(up); };
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
    sock.setTimeout(timeoutMs, () => done(false));
  });
}

// Where the server entry lives + the cwd to run it from. Packaged: the bundled server
// under resources/ (run via Electron-as-Node, so no system Node is required). Dev-
// supervised: the repo's built dist/index-http.js (`npm run build` first). Pure/exported
// for tests. (The packaged layout is finalized with electron-builder in Phase 4.)
export function buildServerSpawn(packaged: boolean, resourcesPath: string, repoRoot: string): { entry: string; cwd: string } {
  return packaged
    // Packaged: the esbuild ESM bundle (npm run bundle:server) — runs without node_modules.
    ? { entry: path.join(resourcesPath, "server", "dist", "index-http.mjs"), cwd: path.join(resourcesPath, "server") }
    // Dev-supervised: the tsc build (ESM, repo type:module). Run `npm run build` first.
    : { entry: path.join(repoRoot, "dist", "index-http.js"), cwd: repoRoot };
}

let child: ChildProcess | null = null;
let quitting = false;
let restarts = 0;
let healthyTimer: NodeJS.Timeout | null = null;
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Ensure the server is reachable on :39200. No-op in dev (external server owns it).
// Reuses an already-bound server (matches the .cmd's "only if nothing on 39200"), else
// spawns + waits up to 15s for it to bind. Never throws — the gem keeps retrying connect.
export async function ensureServerRunning(onLog: (m: string) => void): Promise<void> {
  if (!shouldSupervise()) return;
  if (await portUp()) { onLog(`[server] reusing server already on :${PORT}\n`); return; }
  spawnServer(onLog);
  for (let i = 0; i < 30; i++) {
    if (await portUp()) { restarts = 0; onLog(`[server] up on :${PORT}\n`); return; }
    await delay(500);
  }
  onLog(`[server] did not bind :${PORT} within 15s — gem will keep retrying to connect\n`);
}

function spawnServer(onLog: (m: string) => void): void {
  const repoRoot = path.join(__dirname, "..", ".."); // voice-hud/dist → repo root (dev)
  const { entry, cwd } = buildServerSpawn(app.isPackaged, process.resourcesPath || "", repoRoot);
  onLog(`[server] spawning ${entry}\n`);
  child = spawn(process.execPath, [entry], {
    cwd,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, // run the .js under Electron's bundled Node
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout?.on("data", (d) => onLog(`[server] ${String(d).trimEnd()}\n`));
  child.stderr?.on("data", (d) => onLog(`[server] ${String(d).trimEnd()}\n`));
  // If it survives 30s, treat the crash counter as cleared.
  healthyTimer = setTimeout(() => { restarts = 0; }, 30_000);
  child.on("exit", (code) => {
    child = null;
    if (healthyTimer) { clearTimeout(healthyTimer); healthyTimer = null; }
    if (quitting) return;
    if (restarts++ < 5) {
      onLog(`[server] exited (${code}) — restarting (#${restarts})\n`);
      setTimeout(() => spawnServer(onLog), Math.min(1000 * restarts, 5000));
    } else {
      onLog(`[server] exited (${code}) — gave up after ${restarts} restarts\n`);
    }
  });
}

export function stopServer(): void {
  quitting = true;
  if (healthyTimer) { clearTimeout(healthyTimer); healthyTimer = null; }
  try { child?.kill(); } catch { /* ignore */ }
  child = null;
}
