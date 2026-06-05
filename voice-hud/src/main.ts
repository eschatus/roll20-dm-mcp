// DM Whisper — Electron main process.
//
// Full pipeline: transparent scrying-gem overlay + global PTT → mic capture →
// resident Whisper sidecar → Anthropic agent loop (with the DM persona + MCP
// tools over the shared HTTP server). Read tools run freely; write tools pause
// for a confirm (PTT tap = confirm, Esc = cancel). Per-campaign vocab/nicknames/
// notes are editable via the wizard panel (expanded mode).

import { app, BrowserWindow, ipcMain, screen } from "electron";
import * as path from "path";
import * as fs from "fs";
import * as dotenv from "dotenv";
import { CONFIG } from "./config";
import { PttHook } from "./ptt";
import { startStt, SttEngine } from "./stt";
import { McpRoll20 } from "./mcp";
import { DmAgent } from "./agent";
import { buildRoster, clearRosterCache } from "./roster";
import { loadCampaignData, saveCampaignData, buildVocabPrompt, addVocabTerm, CampaignData } from "./campaignData";
import { loadSettings, saveSettings, AppSettings } from "./settings";

// Load the repo-root .env so ANTHROPIC_API_KEY is available (shared with the MCP server).
dotenv.config({ path: path.join(__dirname, "..", "..", ".env") });
dotenv.config({ path: path.join(__dirname, "..", ".env") }); // optional HUD-local override

// Trim the HUD's own Chromium footprint. The gem/ledger are plain CSS + a little
// canvas waveform — they don't need GPU compositing, and the GPU is precious
// (shared with Whisper + the local LLM). Disabling GPU here drops a whole GPU
// process and its VRAM. Override with DMW_HUD_GPU=1 to re-enable.
if (process.env.DMW_HUD_GPU !== "1") {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch("disable-gpu");
}
app.commandLine.appendSwitch("js-flags", "--max-old-space-size=256");
app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");

let gem: BrowserWindow | null = null;
const ptt = new PttHook();
let stt: SttEngine | null = null; // resolved by startStt() (walks the fallback chain)
const mcp = new McpRoll20();
const agent = new DmAgent(mcp, loadSettings().provider ?? CONFIG.provider);

type Mode = "ghost" | "expanded";
let mode: Mode = "ghost";

// Active campaign + its editable data (vocab/nicknames/notes) and live roster names.
let activeSlug = "";
let campaignData: CampaignData = { slug: "", vocab: [], nicknames: [], notes: "" };
let rosterNames: string[] = [];
let settings: AppSettings = loadSettings();

// A pending write-tool proposal awaiting DM confirmation (tap=confirm, Esc=cancel).
let pendingConfirm: ((ok: boolean) => void) | null = null;

// Combat turn tracking — updated in refreshRoster, consumed by runAgent.
// lastNarratedTurnId: token id that was current when the DM last spoke to the gem.
// latestTurnId: token id that is currently first in the turn order.
// When they differ, turns have advanced without gem narration (misses, retcon, etc.).
let lastNarratedTurnId = "";
let latestTurnId = "";

// Combat state maintained via RTDB push events (updated by connectEventStream)
interface CombatPlan { name: string; shortTerm: string; mediumTerm?: string; longGoal?: string }
const combatPlans = new Map<string, CombatPlan>();
let combatCurrentId = "";
let combatCurrentName = "";
let combatRound = 0;
let inboxCount = 0;
// Token id→name map (updated from roster, consumed by RTDB event handler)
let rosterTokenById: Record<string, string> = {};

// Manual-drag state for the ✥ handle.
let dragTimer: NodeJS.Timeout | null = null;
let dragOffset: { dx: number; dy: number } | null = null;

// --- Debug log forwarding ---
interface LogEntry { level: string; text: string; ts: number; }
const logBuffer: LogEntry[] = [];
const LOG_BUFFER_MAX = 500;

const _origConsoleError = console.error.bind(console);
console.error = (...args: unknown[]) => {
  _origConsoleError(...args);
  const text = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
  const entry: LogEntry = { level: "info", text, ts: Date.now() };
  logBuffer.push(entry);
  if (logBuffer.length > LOG_BUFFER_MAX) logBuffer.shift();
  send("log", entry);
};

// Horizontal cushion-cut gem: wider than tall. Window leaves margin for the
// rim handles (above the gem) and the drop-shadow.
const GEM_W = 460;
const GEM_H = 320;
const PANEL_W = 760;
const PANEL_H = 620;

function createGem() {
  const { workArea } = screen.getPrimaryDisplay();
  gem = new BrowserWindow({
    width: GEM_W, height: GEM_H,
    x: workArea.x + workArea.width - GEM_W - 24,
    y: workArea.y + workArea.height - GEM_H - 24,
    frame: false, transparent: true, resizable: false, movable: true,
    skipTaskbar: true, alwaysOnTop: true, hasShadow: false, focusable: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      // Defense-in-depth: sandbox the renderer. Safe here because preload.ts uses
      // only electron's contextBridge/ipcRenderer (both available in sandboxed
      // preloads) — it touches no Node APIs (fs/path/etc.), so the sandbox can't
      // break it. contextIsolation + nodeIntegration:false keep the bridge narrow.
      sandbox: true,
      contextIsolation: true, nodeIntegration: false,
    },
  });
  gem.setAlwaysOnTop(true, "screen-saver");
  gem.loadFile(path.join(__dirname, "..", "renderer", "gem.html"));
  setGhostClickThrough(true);
  // Null the reference on close so gem?.xxx never tries to use a destroyed object.
  gem.on("closed", () => { gem = null; });
}

let _clickThrough: boolean | null = null;
function setGhostClickThrough(on: boolean) {
  if (on === _clickThrough) return; // only toggle on change (called every mousemove)
  _clickThrough = on;
  gem?.setIgnoreMouseEvents(on, { forward: true });
}

function send(channel: string, payload: unknown) {
  if (gem && !gem.isDestroyed()) gem.webContents.send(channel, payload);
}

// --- PTT wiring ---
function wirePtt() {
  ptt.on("log", (m: string) => console.error("[ptt]", m));

  ptt.on("down", () => {
    send("state", "listening");
  });

  ptt.on("up", () => {
    send("state", "thinking");
  });

  ptt.on("confirm", () => {
    // Dedicated confirm key approves a pending write proposal.
    if (pendingConfirm) {
      const f = pendingConfirm; pendingConfirm = null;
      send("state", "thinking"); // clear the confirm banner immediately
      f(true);
    }
  });

  ptt.on("cancel", () => {
    if (pendingConfirm) {
      const f = pendingConfirm; pendingConfirm = null;
      send("agent", { kind: "info", text: "cancelled" });
      f(false);
    }
    send("state", "idle"); // always clears the banner
  });

  // Forward global wheel to the renderer only when the cursor is over the gem
  // (in ghost mode). In expanded mode the panel handles its own DOM scrolling.
  ptt.on("wheel", (e: { rotation: number; x: number; y: number }) => {
    if (mode === "expanded" || !gem) return;
    const b = gem.getBounds();
    const sx = e.x, sy = e.y; // uiohook gives screen coords
    if (sx >= b.x && sx <= b.x + b.width && sy >= b.y && sy <= b.y + b.height) {
      send("wheel", { rotation: e.rotation });
    }
  });

  // Click-through driven from the NATIVE hook (not the renderer): the gem is
  // interactive only while the cursor is within its visible disc. Because this
  // runs in main's hook thread, a starved/thrashing renderer can no longer wedge
  // click-through in the "on" state and make the HUD unclickable.
  ptt.on("mousemove", (e: { x: number; y: number }) => {
    if (!gem || mode === "expanded" || isDragging()) return;
    const b = gem.getBounds();
    const cx = b.x + b.width / 2, cy = b.y + b.height / 2;
    // Horizontal cushion: interactive zone is an ellipse spanning the gem's
    // width/height (plus the handles riding its top edge). Normalized ellipse
    // test with a little padding. Runs in the native hook thread, so a starved
    // renderer can't wedge click-through.
    const rx = b.width / 2, ry = b.height / 2;
    const nx = (e.x - cx) / rx, ny = (e.y - cy) / ry;
    const inside = (nx * nx + ny * ny) <= 1.0;
    setGhostClickThrough(!inside);
  });

  ptt.start();
}

function isDragging(): boolean {
  return dragOffset != null;
}

// --- Audio clip → Whisper → agent ---
function wireClipHandler() {
  if (!fs.existsSync(CONFIG.tmpDir)) fs.mkdirSync(CONFIG.tmpDir, { recursive: true });

  ipcMain.handle("clip", async (_e, buf: ArrayBuffer) => {
    const wavPath = path.join(CONFIG.tmpDir, `clip-${Date.now()}.wav`);
    fs.writeFileSync(wavPath, Buffer.from(buf));
    try {
      if (!stt) throw new Error("STT not ready");
      if (activeSlug) campaignData = loadCampaignData(activeSlug); // pick up add_vocab writes
      const vocab = buildVocabPrompt(campaignData, rosterNames);
      const t0 = Date.now();
      const result = await stt.transcribe(wavPath, vocab);
      const text = result.text.trim();
      console.error(`[stt] ${Date.now() - t0}ms → "${text.slice(0, 80)}"${text ? "" : " (EMPTY)"}`);
      if (mode === "expanded") {
        // Ledger open: dictate into the editable chatbox for review/fix, don't auto-run.
        send("dictate", { text, lowConfidence: result.low_confidence });
        send("state", "idle");
      } else {
        send("transcript", { text: result.text, lowConfidence: result.low_confidence });
        if (text) runAgent(text);
        else send("state", "idle");
      }
      return { ok: true, text: result.text, lowConfidence: result.low_confidence };
    } catch (err) {
      send("agent", { kind: "error", text: "STT failed: " + (err as Error).message });
      send("state", "idle");
      return { ok: false, error: (err as Error).message };
    } finally {
      fs.promises.unlink(wavPath).catch(() => {});
    }
  });

  ipcMain.on("rec-started", () => send("state", "listening"));

  // Live partial: transcribe a mid-hold audio snapshot and just return the text.
  // No routing, no agent run — the renderer streams it into the active surface.
  ipcMain.handle("partial-clip", async (_e, buf: ArrayBuffer) => {
    const wavPath = path.join(CONFIG.tmpDir, `partial-${Date.now()}.wav`);
    try {
      fs.writeFileSync(wavPath, Buffer.from(buf));
      if (!stt) throw new Error("STT not ready");
      const vocab = buildVocabPrompt(campaignData, rosterNames);
      const result = await stt.transcribe(wavPath, vocab);
      return { ok: true, text: result.text };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    } finally {
      fs.promises.unlink(wavPath).catch(() => {});
    }
  });

  // Hover-to-grab: renderer hit-tests the cursor against the gem+widgets and tells
  // us when it's over them, so we disable click-through just then — making the
  // widgets clickable without blocking Roll20 the rest of the time.
  ipcMain.on("hover", (_e, over: boolean) => {
    if (mode === "expanded") return;
    setGhostClickThrough(!over);
  });

  // Manual window drag via the ✥ handle. We track the screen cursor and move the
  // window to keep its grab-offset constant. This avoids -webkit-app-region:drag
  // (which suppresses :hover/:active CSS, making the handle flicker/vanish).
  ipcMain.on("drag-start", () => {
    if (!gem || mode === "expanded") return;
    const cur = screen.getCursorScreenPoint();
    const b = gem.getBounds();
    dragOffset = { dx: cur.x - b.x, dy: cur.y - b.y };
    if (dragTimer) clearInterval(dragTimer);
    dragTimer = setInterval(() => {
      if (!gem || !dragOffset) return;
      const p = screen.getCursorScreenPoint();
      gem.setPosition(p.x - dragOffset.dx, p.y - dragOffset.dy);
    }, 16);
  });
  ipcMain.on("drag-end", () => {
    if (dragTimer) { clearInterval(dragTimer); dragTimer = null; }
    dragOffset = null;
  });

  // Typed input from the ledger chat box → treat exactly like a transcript.
  ipcMain.on("submit-text", (_e, text: string) => {
    const t = (text || "").trim();
    if (!t) return;
    send("transcript", { text: t, lowConfidence: false });
    runAgent(t);
  });
}

// --- Run the agent on a transcript ---
async function runAgent(transcript: string) {
  send("state", "thinking");
  console.error(`[agent] turn start: "${transcript.slice(0, 80)}"`);
  try {
    // Keep the roster current every turn (cheap — DDB list is cached, only
    // list_tokens re-runs). Also fetches the current turn order to build the
    // COMBAT STATE header — Haiku sees whose turn it is and whether turns advanced.
    await refreshRoster({ silent: true });
    await agent.handle(transcript, {
      onText: (text) => { console.error(`[agent] say: ${text.slice(0, 80)}`); send("agent", { kind: "say", text }); },
      onToolStart: (name, args) => { console.error(`[agent] tool → ${name}(${shortArgs(args)})`); send("agent", { kind: "tool", text: `${name}(${shortArgs(args)})` }); },
      onToolResult: (name, resultText) => { console.error(`[agent] tool ✓ ${name}: ${resultText.slice(0, 60)}`); send("agent", { kind: "result", text: `${name} ✓`, detail: resultText }); },
      onProposeWrite: (name, args) => new Promise<boolean>((resolve) => {
        pendingConfirm = resolve;
        send("agent", { kind: "confirm", text: `${name}(${shortArgs(args)})` });
        send("state", "confirm");
      }),
    });
    // Record the turn that was current when the DM just spoke, so the next
    // refreshRoster can tell whether turns have advanced since this narration.
    if (latestTurnId) lastNarratedTurnId = latestTurnId;
    // Reload vocab from disk (agent may have called add_vocab/add_nickname) and
    // refresh roster names so names discovered this turn are in STT next utterance.
    if (activeSlug) campaignData = loadCampaignData(activeSlug);
    refreshRoster({ silent: true }).catch((e) => console.error("[roster] post-turn refresh failed:", (e as Error).message));
  } catch (err) {
    send("agent", { kind: "error", text: (err as Error).message });
  } finally {
    if (!pendingConfirm) send("state", "idle");
  }
}

function shortArgs(args: unknown): string {
  try {
    const s = JSON.stringify(args);
    return s.length > 80 ? s.slice(0, 77) + "…" : s;
  } catch { return ""; }
}

// Write/merge key=value pairs into voice-hud/.env for persistence across restarts.
function writeHudEnv(updates: Record<string, string>) {
  const envPath = path.join(__dirname, "..", ".env");
  let content = "";
  try { content = fs.readFileSync(envPath, "utf-8"); } catch { /* file may not exist yet */ }
  for (const [key, val] of Object.entries(updates)) {
    const re = new RegExp(`^${key}=.*$`, "m");
    if (re.test(content)) {
      content = content.replace(re, `${key}=${val}`);
    } else {
      if (content && !content.endsWith("\n")) content += "\n";
      content += `${key}=${val}\n`;
    }
  }
  fs.writeFileSync(envPath, content, "utf-8");
}

// --- Campaign data wizard IPC (expanded panel) ---
function wireWizard() {
  ipcMain.handle("get-campaign-data", () => ({ data: campaignData, roster: rosterNames }));
  ipcMain.handle("save-campaign-data", (_e, data: CampaignData) => {
    campaignData = { ...data, slug: activeSlug };
    saveCampaignData(campaignData);
    return { ok: true };
  });
  ipcMain.handle("add-vocab", (_e, term: string) => {
    campaignData = addVocabTerm(activeSlug, term);
    return { ok: true, data: campaignData };
  });
  ipcMain.handle("rebuild-roster", async () => {
    await refreshRoster({ force: true });
    return { roster: rosterNames };
  });
  ipcMain.on("set-mode", (_e, m: Mode) => setMode(m));

  // Hot-swap the LLM backend (local Ollama ↔ cloud Claude) when local gives bad
  // results. Returns the active provider so the UI reflects reality.
  ipcMain.handle("get-provider", () => agent.currentProvider());
  ipcMain.handle("set-provider", (_e, name: "ollama" | "anthropic") => {
    const r = agent.switchProvider(name);
    send("agent", { kind: "info", text: r.ok ? `model → ${name}` : `swap refused: ${r.reason}` });
    if (r.ok) { settings = { ...settings, provider: name }; saveSettings(settings); }
    return { ...r, active: agent.currentProvider() };
  });

  ipcMain.on("quit-app", () => {
    ptt.stop();
    stt?.stop();
    mcp.close().catch(() => {});
    app.quit();
  });

  // Settings (agent whisper sound).
  ipcMain.handle("get-settings", () => settings);
  ipcMain.handle("save-settings", (_e, s: AppSettings) => {
    settings = s; saveSettings(settings);
    send("settings", settings);
    return { ok: true };
  });

  // Hand the renderer the whisper mp3 bytes (avoids file:// + CSP issues).
  ipcMain.handle("get-whisper-audio", () => {
    try {
      const bytes = fs.readFileSync(CONFIG.whisperSoundPath);
      return { ok: true, data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), clipMs: CONFIG.whisperClipMs };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });

  // Debug log history (for populating the debug tab when it opens).
  ipcMain.handle("get-log-history", () => logBuffer.slice());

  // Config read: returns the live runtime CONFIG values the renderer can display/edit.
  ipcMain.handle("get-config", () => ({
    pttKey: CONFIG.pttKey,
    pttMouseButton: CONFIG.pttMouseButton ?? 0,
    confirmKey: CONFIG.confirmKey,
    sttModel: CONFIG.stt.model,
    sttDevice: CONFIG.stt.device,
    sttComputeType: CONFIG.stt.computeType,
    partialMs: CONFIG.partialMs,
    mcpUrl: CONFIG.mcpUrl,
    provider: CONFIG.provider,
    model: CONFIG.model,
    autoEscalate: CONFIG.autoEscalate,
    ollamaUrl: CONFIG.ollamaUrl,
    ollamaModel: CONFIG.ollamaModel,
    whisperClipMs: CONFIG.whisperClipMs,
  }));

  // Config write: update CONFIG in memory (immediate) + persist to voice-hud/.env (restarts).
  // Keys marked ★ in the UI (pttKey, confirmKey, stt.*) need a restart to fully take effect.
  ipcMain.handle("set-config", (_e, updates: Record<string, unknown>) => {
    const envMap: Record<string, string> = {
      pttKey: "DMW_PTT_KEY", pttMouseButton: "DMW_PTT_BUTTON", confirmKey: "DMW_CONFIRM_KEY",
      sttModel: "DMW_STT_MODEL", sttDevice: "DMW_STT_DEVICE", sttComputeType: "DMW_STT_COMPUTE",
      partialMs: "DMW_PARTIAL_MS", mcpUrl: "DMW_MCP_URL", provider: "DMW_PROVIDER",
      model: "DMW_MODEL", autoEscalate: "DMW_AUTO_ESCALATE",
      ollamaUrl: "DMW_OLLAMA_URL", ollamaModel: "DMW_OLLAMA_MODEL",
      whisperClipMs: "DMW_WHISPER_CLIP_MS",
    };
    const envUpdates: Record<string, string> = {};
    for (const [key, val] of Object.entries(updates)) {
      if (key === "pttKey"         && typeof val === "string")  CONFIG.pttKey = val;
      if (key === "pttMouseButton" && typeof val === "number")  CONFIG.pttMouseButton = val || null;
      if (key === "confirmKey"     && typeof val === "string")  CONFIG.confirmKey = val;
      if (key === "sttModel"       && typeof val === "string")  CONFIG.stt.model = val;
      if (key === "sttDevice"      && typeof val === "string")  CONFIG.stt.device = val;
      if (key === "sttComputeType" && typeof val === "string")  CONFIG.stt.computeType = val;
      if (key === "partialMs"      && typeof val === "number")  CONFIG.partialMs = val;
      if (key === "mcpUrl"         && typeof val === "string")  CONFIG.mcpUrl = val;
      if (key === "provider"       && (val === "ollama" || val === "anthropic")) CONFIG.provider = val;
      if (key === "model"          && typeof val === "string")  CONFIG.model = val;
      if (key === "autoEscalate"   && typeof val === "boolean") CONFIG.autoEscalate = val;
      if (key === "ollamaUrl"      && typeof val === "string")  CONFIG.ollamaUrl = val;
      if (key === "ollamaModel"    && typeof val === "string")  CONFIG.ollamaModel = val;
      if (key === "whisperClipMs"  && typeof val === "number")  CONFIG.whisperClipMs = val;
      if (envMap[key] !== undefined) {
        let envVal = String(val);
        if (typeof val === "boolean") envVal = val ? "1" : "0";
        if (key === "pttMouseButton") envVal = String(val || "");
        envUpdates[envMap[key]] = envVal;
      }
    }
    try { writeHudEnv(envUpdates); return { ok: true }; }
    catch (e) { return { ok: false, error: (e as Error).message }; }
  });
}

async function refreshRoster(opts: { silent?: boolean; force?: boolean } = {}) {
  try {
    if (opts.force) clearRosterCache();
    const { text, names, tokenById } = await buildRoster(mcp);
    rosterNames = names;

    // Update the tokenById cache used by RTDB event handler
    rosterTokenById = tokenById;

    // -- Combat state header (driven by RTDB push events, no relay needed) --
    let combatHeader = "";
    if (combatCurrentName) {
      const roundStr = combatRound > 0 ? `Round ${combatRound}` : "Combat active";
      const turnAdvanced = !!lastNarratedTurnId && !!combatCurrentId && combatCurrentId !== lastNarratedTurnId;
      combatHeader = `COMBAT STATE (${roundStr}) — current turn: ${combatCurrentName}`;
      if (turnAdvanced) combatHeader += " — [turns advanced without gem narration; assume retcon or uneventful — do NOT ask]";
      const plan = combatPlans.get(combatCurrentId);
      if (plan) {
        combatHeader += `\nTACTIC: ${plan.shortTerm}`;
        if (plan.mediumTerm) combatHeader += ` | 2-3r: ${plan.mediumTerm}`;
      }
      const allLines = Array.from(combatPlans.entries())
        .filter(([id]) => id !== combatCurrentId)
        .map(([, p]) => `• ${p.name}: ${p.shortTerm.slice(0, 100)}`)
        .join("\n");
      if (allLines) combatHeader += `\n\nOther mobs:\n${allLines}`;
      combatHeader += "\n\n";
    }

    // Fold the campaign's nickname aliases + notes into the roster block so the
    // agent can resolve "Ryan"/"Diver"→character and has party context. (These
    // were previously only used for STT vocab biasing, never shown to the model.)
    let block = combatHeader + text;
    if (campaignData.nicknames?.length) {
      block += "\n\nAliases (say → means):\n" +
        campaignData.nicknames.map((n) => `- ${n.nickname} → ${n.target}`).join("\n");
    }
    if (campaignData.notes?.trim()) {
      block += "\n\nCampaign notes:\n" + campaignData.notes.trim();
    }
    agent.setRoster(block);
    if (!opts.silent) send("agent", { kind: "info", text: `roster: ${names.length} names` });
  } catch (err) {
    send("agent", { kind: "error", text: "roster build failed: " + (err as Error).message });
  }
}

// --- Determine active campaign from the main project's registry ---
function readActiveSlug(): string {
  try {
    const p = path.join(__dirname, "..", "..", "data", "active-campaign.json");
    return (JSON.parse(fs.readFileSync(p, "utf-8")) as { slug: string }).slug || "";
  } catch { return ""; }
}

app.whenReady().then(async () => {
  createGem();
  wirePtt();
  wireClipHandler();
  wireWizard();

  activeSlug = readActiveSlug();
  campaignData = loadCampaignData(activeSlug);
  settings = loadSettings();

  // Start STT (walks the fallback chain) + MCP in parallel; neither blocks the gem.
  startStt((m) => process.stderr.write(m))
    .then((engine) => {
      stt = engine;
      stt.on("exit", (code: number) => send("agent", { kind: "error", text: `STT exited (${code})` }));
      send("agent", { kind: "info", text: `scrying gem attuned (${engine.name})` });
    })
    .catch((err) => send("agent", { kind: "error", text: "STT failed: " + (err as Error).message }));

  try {
    const tools = await mcp.connect();
    console.error(`[mcp] connected — ${tools.length} tools`);
    send("agent", { kind: "info", text: "bound to Roll20" });
    await refreshRoster();
    console.error(`[roster] ${rosterNames.length} names`);
    // Start RTDB event stream for live turn order + tactical plan push
    connectEventStream();
  } catch (err) {
    console.error(`[mcp] CONNECT FAILED: ${(err as Error).message}`);
    send("agent", { kind: "error", text: "MCP connect failed (is the server running on 39200?): " + (err as Error).message });
  }
});

let appQuitting = false;
app.on("before-quit", () => { appQuitting = true; });

app.on("window-all-closed", () => {
  appQuitting = true;
  ptt.stop();
  stt?.stop();
  mcp.close().catch(() => {});
  app.quit();
});

let _gemBoundsBeforeExpand: { x: number; y: number } | null = null;

// --- RTDB event stream (SSE from the MCP server, replaces polling) ---
function connectEventStream() {
  if (!process.env.ROLL20_MCP_TOKEN) return; // no token → RT transport not configured
  const baseUrl = CONFIG.mcpUrl.replace(/\/mcp$/, "");
  const url = new URL(baseUrl + "/events");
  const reqOpts = {
    hostname: url.hostname,
    port: url.port || 39200,
    path: url.pathname,
    method: "GET" as const,
    headers: {
      Authorization: `Bearer ${process.env.ROLL20_MCP_TOKEN}`,
      Accept: "text/event-stream",
      Connection: "keep-alive",
    },
  };

  const http = require("http") as typeof import("http");
  const req = http.request(reqOpts, (res) => {
    if (res.statusCode !== 200) {
      console.error(`[events] SSE ${res.statusCode} — retrying in 10s`);
      if (!appQuitting) setTimeout(connectEventStream, 10_000);
      return;
    }
    let buf = "";
    let evtType = "";
    res.on("data", (chunk: Buffer) => {
      buf += chunk.toString();
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (line.startsWith("event: ")) { evtType = line.slice(7).trim(); }
        else if (line.startsWith("data: ") && evtType) {
          try { handleRtdbEvent(evtType, JSON.parse(line.slice(6))); } catch { /* malformed */ }
          evtType = "";
        }
      }
    });
    res.on("end", () => { if (!appQuitting) { console.error("[events] SSE closed — reconnecting in 3s"); setTimeout(connectEventStream, 3_000); } });
    res.on("error", (e: Error) => { if (!appQuitting) { console.error("[events] SSE error:", e.message); setTimeout(connectEventStream, 5_000); } });
  });
  req.on("error", (e: Error) => { if (!appQuitting) { console.error("[events] SSE connect error:", e.message); setTimeout(connectEventStream, 5_000); } });
  req.end();
}

function handleRtdbEvent(type: string, data: unknown) {
  type TurnEntry = { id?: string; pr?: string | number; custom?: string; formula?: string };
  type Plan = { name: string; shortTerm: string; mediumTerm?: string; longGoal?: string };

  if (type === "combat-update") {
    const d = data as { turnOrder: TurnEntry[]; round: number };
    combatRound = d.round;
    const activeEntry = d.turnOrder.find((e) => e.id && String(e.id) !== "-1") ?? null;
    const newId = activeEntry ? String(activeEntry.id ?? "") : "";
    combatCurrentId = newId;
    combatCurrentName = newId ? (rosterTokenById[newId] ?? "") : "";
    const plan = newId ? (combatPlans.get(newId) ?? null) : null;
    send("combat-update", {
      active: d.turnOrder.length > 0 && !!newId,
      currentName: combatCurrentName,
      round: combatRound,
      plan,
      allPlans: Object.fromEntries(combatPlans),
    });
  } else if (type === "mob-plan") {
    const d = data as { tokenId: string; plan: Plan };
    combatPlans.set(d.tokenId, d.plan);
    if (d.tokenId === combatCurrentId) {
      send("combat-update", {
        active: true,
        currentName: combatCurrentName,
        round: combatRound,
        plan: d.plan,
        allPlans: Object.fromEntries(combatPlans),
      });
    }
  } else if (type === "inbox-item") {
    inboxCount++;
    send("inbox-update", { count: inboxCount, item: (data as { item?: unknown }).item });
  }
}

export function setMode(next: Mode) {
  mode = next;
  if (!gem) return;
  const { workArea } = screen.getPrimaryDisplay();
  if (mode === "expanded") {
    // Remember where the gem was so we can restore it on close (don't snap back
    // to a default corner). Center the panel; keep gem center as panel center.
    const b = gem.getBounds();
    _gemBoundsBeforeExpand = { x: b.x, y: b.y };
    const cx = b.x + b.width / 2, cy = b.y + b.height / 2;
    gem.setIgnoreMouseEvents(false);
    gem.setFocusable(true);
    // Expanded ledger behaves like a normal app window: resizable, movable, not
    // pinned above everything. (Drag via the header's CSS app-region; resize from
    // edges now that resizable is on.)
    gem.setResizable(true);
    gem.setMinimumSize(420, 320);
    gem.setAlwaysOnTop(false);
    gem.setSize(PANEL_W, PANEL_H);
    gem.setPosition(
      Math.round(Math.min(Math.max(workArea.x, cx - PANEL_W / 2), workArea.x + workArea.width - PANEL_W)),
      Math.round(Math.min(Math.max(workArea.y, cy - PANEL_H / 2), workArea.y + workArea.height - PANEL_H)),
    );
    gem.focus();
  } else {
    gem.setFocusable(false);
    gem.setAlwaysOnTop(true, "screen-saver");
    // setBounds atomically resets position + size before locking resizable,
    // avoiding the Windows quirk where setSize is ignored after setResizable(false).
    const rx = _gemBoundsBeforeExpand?.x ?? workArea.x + workArea.width - GEM_W - 24;
    const ry = _gemBoundsBeforeExpand?.y ?? workArea.y + workArea.height - GEM_H - 24;
    gem.setBounds({ x: rx, y: ry, width: GEM_W, height: GEM_H });
    gem.setResizable(false);
    setGhostClickThrough(true);
  }
  send("state", mode === "expanded" ? "expanded" : "idle");
}
