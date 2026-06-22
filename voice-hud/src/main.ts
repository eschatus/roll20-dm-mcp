// DM Whisper — Electron main process.
//
// Full pipeline: transparent scrying-gem overlay + global PTT → mic capture →
// resident Whisper sidecar → Anthropic agent loop (with the DM persona + MCP
// tools over the shared HTTP server). Read tools run freely; write tools pause
// for a confirm (PTT tap = confirm, Esc = cancel). Per-campaign vocab/nicknames/
// notes are editable via the wizard panel (expanded mode).

import { app, BrowserWindow, ipcMain, screen, Menu, clipboard } from "electron";
import "./bootstrap"; // MUST precede ./config — sets DMW_DATA_DIR/ROLL20_DATA_DIR when packaged
import * as path from "path";
import * as fs from "fs";
import * as dotenv from "dotenv";
import { CONFIG } from "./config";
import { PttHook } from "./ptt";
import { startStt, startFinalStt, SttEngine } from "./stt";
import { ensureServerRunning, stopServer } from "./serverSupervisor";
import { McpRoll20 } from "./mcp";
import { DmAgent } from "./agent";
import { buildRoster, clearRosterCache } from "./roster";
import { loadCampaignData, saveCampaignData, buildVocabPrompt, buildVocabList, addVocabTerm, addCorrection, CampaignData } from "./campaignData";
import { loadBaseVocab } from "./baseVocab";
import { correctTranscript, DEFAULT_LITERAL_MAP } from "./correction";
import { runAar } from "./aar";
import { loadSettings, saveSettings, AppSettings } from "./settings";
import { setLogSink, persist } from "./logger";

// Load the repo-root .env so ANTHROPIC_API_KEY is available (shared with the MCP server).
dotenv.config({ path: path.join(__dirname, "..", "..", ".env") });
dotenv.config({ path: path.join(__dirname, "..", ".env") }); // optional HUD-local override
// Packaged: also load a .env from the per-user data dir (DMW_DATA_DIR is set by bootstrap;
// there's no repo .env inside the bundle). Lets a user/tester drop keys
// (ANTHROPIC_API_KEY, ROLL20_MCP_TOKEN, DDB_COBALT) in <userData>/.env before the config
// wizard (#47) automates it. dotenv is first-wins, so a real env var still takes precedence.
if (process.env.DMW_DATA_DIR) dotenv.config({ path: path.join(process.env.DMW_DATA_DIR, ".env") });
// Packaged: ensure a stable MCP auth token shared by the gem AND the server it supervises
// (the child inherits process.env). Generate once + persist to <userData>/.env so they
// always agree with no manual step; an existing token (loaded above) wins. Without this the
// gem connects with an empty bearer while the server auto-generates its own → 401.
if (process.env.DMW_DATA_DIR && !process.env.ROLL20_MCP_TOKEN) {
  const tok = require("crypto").randomBytes(24).toString("hex");
  process.env.ROLL20_MCP_TOKEN = tok;
  try { fs.appendFileSync(path.join(process.env.DMW_DATA_DIR, ".env"), `ROLL20_MCP_TOKEN=${tok}\n`); } catch { /* best effort */ }
}

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
let sttFinal: SttEngine | null = null; // optional two-tier: bigger model for the FINAL clip (else falls back to stt)
const mcp = new McpRoll20();
const agent = new DmAgent(mcp, loadSettings().provider ?? CONFIG.provider);

type Mode = "ghost" | "expanded";
let mode: Mode = "ghost";

// Active campaign + its editable data (vocab/nicknames/notes) and live roster names.
let activeSlug = "";
let campaignData: CampaignData = { slug: "", vocab: [], nicknames: [], notes: "", corrections: {} };
let rosterNames: string[] = [];
// Global STT base vocab (common D&D terms), loaded once at startup. Separate from
// per-campaign vocab; extend via <dataDir>/base-vocab.json. Relaunch to pick up edits.
const baseVocab = loadBaseVocab();
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
// DM inbox: player !dm queries/intents (+ rules escalations) pushed from the server via SSE.
// We keep the full items here (not just a count) so the gem's Inbox tab can read and reply.
interface InboxItem { key: string; who: string; playerid?: string; content: string; type: string; timestamp: number; handled?: boolean }
const inboxItems: InboxItem[] = [];
const INBOX_MAX = 50;
function inboxCount(): number { return inboxItems.filter((i) => !i.handled).length; }
function pushInbox(): void { send("inbox-update", { count: inboxCount(), items: inboxItems.slice(-INBOX_MAX) }); }
// SWR guard: true while runAgent is running. refreshRoster stashes the built block
// here instead of calling agent.setRoster mid-turn; runAgent's finally applies it.
let _agentTurnActive = false;
let _pendingRosterBlock: string | null = null;
// Token id→name map (updated from roster, consumed by RTDB event handler)
let rosterTokenById: Record<string, string> = {};
// Warn-once when the DMW_SAVE_CLIPS A/B corpus hits its size/count budget.
let abClipBudgetWarned = false;

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
  // Durable file (survives the detached launch, where stderr is lost). The in-memory logBuffer
  // only backfills the panel for the current session; hud.log persists across runs.
  persist({ ts: entry.ts, level: "info", kind: "console", msg: text });
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
  // Register the standard edit accelerators (Ctrl+C/V/X/A/Z/Y). The window is frameless with no
  // menu, so without this the renderer's inputs can't paste and selected text can't be copied.
  // editMenu registers the accelerators app-wide; no visible menu bar appears on a frameless window.
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: "editMenu" }]));
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

// Forward structured logger.log() events (kind/perf/ms) to the same renderer Debug panel, shaped
// like the LogEntry the panel already renders. logger.log() also persists them to hud.log itself.
setLogSink((e) => send("log", {
  level: e.level === "error" ? "error" : "info",
  text: (e.ms != null ? `[${e.kind} ${e.ms}ms] ` : `[${e.kind}] `) + e.msg + (e.detail ? ` :: ${e.detail.slice(0, 120)}` : ""),
  ts: e.ts,
}));

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
    // A/B corpus capture: with DMW_SAVE_CLIPS=1, keep a copy of the real production
    // audio under data/ab-clips/ for `npm run ab:stt`. (The clip is otherwise deleted
    // in finally.) A .draft.txt with the live transcript is written too — a CONVENIENCE
    // starting point; the harness ignores it. Edit it to ground truth → <clip>.txt for WER.
    let abClip: string | null = null;
    if (process.env.DMW_SAVE_CLIPS === "1") {
      try {
        const dir = path.join(__dirname, "..", "data", "ab-clips");
        fs.mkdirSync(dir, { recursive: true });
        // Hard budget so an enabled capture never balloons: skip (never delete) once the
        // corpus would exceed the byte cap (default 1 GB) or the file cap. Override via
        // DMW_SAVE_CLIPS_MAX_MB / DMW_SAVE_CLIPS_MAX_FILES.
        const maxBytes = (Number(process.env.DMW_SAVE_CLIPS_MAX_MB) || 1024) * 1024 * 1024;
        const maxFiles = Number(process.env.DMW_SAVE_CLIPS_MAX_FILES) || 250;
        const audio = fs.readdirSync(dir).filter((f) => /\.(wav|mp3|ogg|flac)$/i.test(f));
        const used = audio.reduce((n, f) => { try { return n + fs.statSync(path.join(dir, f)).size; } catch { return n; } }, 0);
        const incoming = fs.statSync(wavPath).size;
        if (audio.length >= maxFiles || used + incoming > maxBytes) {
          if (!abClipBudgetWarned) {
            console.error(`[ab-clip] corpus full (${audio.length} clips, ${(used / 1e6).toFixed(0)} MB) — not saving more. Prune data/ab-clips/ to resume.`);
            abClipBudgetWarned = true;
          }
        } else {
          abClip = path.join(dir, path.basename(wavPath));
          fs.copyFileSync(wavPath, abClip);
        }
      } catch (e) { console.error("[ab-clip] save failed: " + (e as Error).message); }
    }
    try {
      if (!stt) throw new Error("STT not ready");
      if (activeSlug) campaignData = loadCampaignData(activeSlug); // pick up add_vocab writes
      const vocabList = buildVocabList(campaignData, rosterNames, baseVocab);
      const t0 = Date.now();
      // Final clip → the bigger two-tier engine if configured, else the primary.
      const result = await (sttFinal ?? stt).transcribe(wavPath, vocabList.join(", "));
      // Post-STT correction (deterministic, µs): fix mishears against the same
      // glossary — split names, dice/mechanics notation. Only the FINAL transcript
      // is corrected (partials stay raw/fast). Log when it actually changes anything.
      const corrected = correctTranscript(result.text, {
        glossary: vocabList,
        literalMap: { ...DEFAULT_LITERAL_MAP, ...campaignData.corrections }, // learned (AAR-accepted) corrections
      });
      if (corrected !== result.text) console.error(`[correct] "${result.text.slice(0, 60)}" → "${corrected.slice(0, 60)}"`);
      const text = corrected.trim();
      console.error(`[stt] ${Date.now() - t0}ms → "${text.slice(0, 80)}"${text ? "" : " (EMPTY)"}`);
      if (abClip) { try { fs.writeFileSync(abClip.replace(/\.wav$/i, ".draft.txt"), text); } catch { /* ignore */ } }
      if (mode === "expanded") {
        // Ledger open: dictate into the editable chatbox for review/fix, don't auto-run.
        send("dictate", { text, lowConfidence: result.low_confidence });
        send("state", "idle");
      } else {
        send("transcript", { text, lowConfidence: result.low_confidence });
        if (text) runAgent(text, result.low_confidence);
        else send("state", "idle");
      }
      return { ok: true, text, lowConfidence: result.low_confidence };
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
      const vocab = buildVocabPrompt(campaignData, rosterNames, baseVocab);
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
async function runAgent(transcript: string, lowConfidence = false) {
  send("state", "thinking");
  console.error(`[agent] turn start: "${transcript.slice(0, 80)}"${lowConfidence ? " (LOW CONF)" : ""}`);
  _agentTurnActive = true;
  // A shaky transcript: flag it to the agent (the persona reads this) so it leans
  // toward confirming destructive writes rather than acting on a likely mishear.
  // Detector-safe — the marker carries no phase keywords.
  const utterance = lowConfidence
    ? `[LOW-CONFIDENCE voice transcript — a likely mishear; interpret cautiously and confirm any destructive write] ${transcript}`
    : transcript;
  try {
    // SWR: fire roster refresh in the background so the LLM starts immediately.
    // If the refresh lands mid-turn, refreshRoster stashes the block; we apply it below.
    refreshRoster({ silent: true }).catch((e) => console.error("[roster] pre-turn refresh failed:", (e as Error).message));
    await agent.handle(utterance, {
      onText: (text) => { console.error(`[agent] say: ${text.slice(0, 80)}`); send("agent", { kind: "say", text }); },
      onToolStart: (name, args) => { console.error(`[agent] tool → ${name}(${shortArgs(args)})`); send("agent", { kind: "tool", text: `${name}(${shortArgs(args)})` }); },
      onToolResult: (name, resultText) => { console.error(`[agent] tool ✓ ${name}: ${resultText.slice(0, 60)}`); send("agent", { kind: "result", text: `${name} ✓`, detail: resultText }); },
      onProposeWrite: (name, args) => new Promise<boolean>((resolve) => {
        pendingConfirm = resolve;
        send("agent", { kind: "confirm", text: `${name}(${shortArgs(args)})` });
        send("state", "confirm");
      }),
      onPhaseChange: (phase) => {
        console.error(`[agent] phase → ${phase}`);
        send("phase", { phase });
        // Combat closing → run the After-Action Review and surface its report +
        // proposed corrections to the Training panel (the reinforcement loop).
        if (phase === "CLEANUP") {
          try {
            const report = runAar(activeSlug);
            send("aar", report);
            console.error(`[aar] ${report.turns} turns, avg ${report.avgSteps} steps; ${report.proposals.length} proposal(s)`);
          } catch (e) { console.error("[aar] failed:", (e as Error).message); }
        }
      },
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
    _agentTurnActive = false;
    if (_pendingRosterBlock !== null) {
      agent.setRoster(_pendingRosterBlock);
      _pendingRosterBlock = null;
    }
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
  // After-Action Review: run on demand (the auto-run is in onPhaseChange at combat end).
  ipcMain.handle("run-aar", () => runAar(activeSlug));
  // Training panel "accept": persist a learned spoken→canonical correction so the
  // corrector applies it from the next transcript on. The reinforcement loop's write.
  ipcMain.handle("accept-correction", (_e, p: { spoken: string; canonical: string }) => {
    campaignData = addCorrection(activeSlug, p.spoken, p.canonical);
    return { ok: true, corrections: campaignData.corrections };
  });
  ipcMain.handle("rebuild-roster", async () => {
    await refreshRoster({ force: true });
    return { roster: rosterNames };
  });
  ipcMain.on("set-mode", (_e, m: Mode) => setMode(m));

  // Phase indicator: current DmPhase (for the gem UI phase badge).
  ipcMain.handle("get-phase", () => agent.currentPhase());

  // Hot-swap the LLM backend (local Ollama ↔ cloud Claude) when local gives bad
  // results. Returns the active provider so the UI reflects reality.
  ipcMain.handle("get-provider", () => agent.currentProvider());
  ipcMain.handle("set-provider", (_e, name: "ollama" | "anthropic") => {
    if (name === "ollama" && !CONFIG.enableLocalLlm) {
      send("agent", { kind: "info", text: "local LLM is mothballed (set DMW_ENABLE_LOCAL_LLM=1)" });
      return { ok: false, active: agent.currentProvider(), reason: "local LLM disabled" };
    }
    const r = agent.switchProvider(name);
    send("agent", { kind: "info", text: r.ok ? `model → ${name}` : `swap refused: ${r.reason}` });
    if (r.ok) { settings = { ...settings, provider: name }; saveSettings(settings); }
    return { ...r, active: agent.currentProvider() };
  });

  ipcMain.handle("reconnect-mcp", async () => {
    try {
      await mcp.close();
      const tools = await mcp.connect();
      console.error(`[mcp] reconnected — ${tools.length} tools`);
      send("agent", { kind: "info", text: `reconnected to Roll20 (${tools.length} tools)` });
      await refreshRoster();
      connectEventStream();
      return { ok: true, tools: tools.length };
    } catch (err) {
      const msg = (err as Error).message;
      console.error(`[mcp] RECONNECT FAILED: ${msg}`);
      send("agent", { kind: "error", text: "MCP reconnect failed: " + msg });
      return { ok: false, error: msg };
    }
  });

  // DM inbox: renderer asks for the current snapshot (on tab open / HUD start).
  ipcMain.handle("get-inbox", () => ({ count: inboxCount(), items: inboxItems.slice(-INBOX_MAX) }));

  // DM inbox: reply to a player and mark the item handled. Whispers via the server's
  // whisper_player tool (the only path that can target a single player on any shard).
  ipcMain.handle("reply-inbox", async (_e, p: { key: string; playerName: string; message: string }) => {
    if (!p?.message?.trim()) return { ok: false, error: "empty message" };
    try {
      await mcp.call("whisper_player", { playerName: p.playerName, message: p.message });
      const item = inboxItems.find((i) => i.key === p.key);
      if (item) item.handled = true;
      pushInbox();
      return { ok: true };
    } catch (err) {
      const msg = (err as Error).message;
      console.error(`[inbox] reply failed: ${msg}`);
      return { ok: false, error: msg };
    }
  });

  // DM inbox: dismiss an item without replying (mark handled).
  ipcMain.handle("dismiss-inbox", (_e, key: string) => {
    const item = inboxItems.find((i) => i.key === key);
    if (item) item.handled = true;
    pushInbox();
    return { ok: true };
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
    partialMs: CONFIG.partialMs,
    mcpUrl: CONFIG.mcpUrl,
    provider: CONFIG.provider,
    enableLocalLlm: CONFIG.enableLocalLlm,
    model: CONFIG.model,
    autoEscalate: CONFIG.autoEscalate,
    ollamaUrl: CONFIG.ollamaUrl,
    ollamaModel: CONFIG.ollamaModel,
    whisperClipMs: CONFIG.whisperClipMs,
  }));

  // --- Setup wizard (first-run onboarding) ---
  // What the Setup tab shows: configured vs still-needed. Cheap reads off env + the data dir.
  ipcMain.handle("get-setup-status", () => {
    const dataDir = process.env.DMW_DATA_DIR || CONFIG.dataDir;
    const has = (f: string) => { try { return fs.existsSync(path.join(dataDir, f)); } catch { return false; } };
    let campaigns = 0;
    try { campaigns = Object.keys(JSON.parse(fs.readFileSync(path.join(dataDir, "campaigns.json"), "utf-8"))).length; } catch { /* none yet */ }
    return {
      dataDir,
      apiKey: !!process.env.ANTHROPIC_API_KEY,
      rtToken: has("roll20-rt-token.json"),
      cobalt: !!process.env.DDB_COBALT || has("ddb-cobalt.json"),
      campaigns,
      activeSlug,
    };
  });

  // Save the Anthropic API key — live immediately (process.env, next agent call uses it) and
  // persisted to <dataDir>/.env for next launch.
  ipcMain.handle("save-api-key", (_e, key: string) => {
    const k = String(key || "").trim();
    if (!k.startsWith("sk-")) return { ok: false, error: "expected a key starting with sk-" };
    process.env.ANTHROPIC_API_KEY = k;
    try { upsertEnv("ANTHROPIC_API_KEY", k); } catch (e) { return { ok: false, error: (e as Error).message }; }
    return { ok: true };
  });

  // Token harvests — force the relevant transport once; the server opens the (visible) browser
  // for login + caches the token on success. We don't strictly trust the tool's return (the
  // interactive login can outlast a tool timeout) — the renderer re-reads get-setup-status, and
  // the cached token file is the real success signal.
  // Roll20: any relay read drives roll20-rt → intercepts signInWithCustomToken → caches the token.
  ipcMain.handle("connect-roll20", async () => {
    try { await mcp.call("list_tokens", {}); return { ok: true }; }
    catch (e) { return { ok: false, error: (e as Error).message }; }
  });
  // D&D Beyond: ddb_list_campaigns harvests the CobaltSession cookie AND returns the games list.
  ipcMain.handle("connect-ddb", async () => {
    try { const r = await mcp.call("ddb_list_campaigns", {}); return { ok: true, result: String(r).slice(0, 400) }; }
    catch (e) { return { ok: false, error: (e as Error).message }; }
  });

  // STT model upgrade — base.en ships bundled (fast live partials); the user can download a bigger
  // model used for FINAL transcription (two-tier via DMW_WHISPER_FINAL_MODEL). No browser needed.
  ipcMain.handle("get-stt-models", () => {
    const dir = path.join(process.env.DMW_DATA_DIR || CONFIG.dataDir, "models");
    const finalPath = process.env.DMW_WHISPER_FINAL_MODEL || CONFIG.whisperFinalModel || "";
    const current = finalPath ? path.basename(finalPath).replace(/^ggml-|\.bin$/g, "") : "base.en";
    const models = STT_MODELS.map((m) => ({
      ...m,
      present: !!m.bundled || fs.existsSync(path.join(dir, `ggml-${m.id}.bin`)),
    }));
    return { models, current };
  });
  // Download (if needed) and select a model for FINAL transcription. base.en clears the final
  // tier (single-tier base). Anything else downloads to <dataDir>/models and becomes the final
  // model with base.en kept as the fast-partial primary. Restart applies it (★ STT setting).
  ipcMain.handle("select-stt-model", async (_e, id: string) => {
    const model = STT_MODELS.find((m) => m.id === id);
    if (!model) return { ok: false, error: `unknown model: ${id}` };
    try {
      if (id === "base.en") {
        process.env.DMW_WHISPER_FINAL_MODEL = "";
        upsertEnv("DMW_WHISPER_FINAL_MODEL", "");
        return { ok: true, restart: true };
      }
      const dir = path.join(process.env.DMW_DATA_DIR || CONFIG.dataDir, "models");
      const dest = path.join(dir, `ggml-${id}.bin`);
      if (!fs.existsSync(dest)) await downloadModel(id, dest);
      process.env.DMW_WHISPER_FINAL_MODEL = dest;
      upsertEnv("DMW_WHISPER_FINAL_MODEL", dest);
      return { ok: true, restart: true };
    } catch (e) { return { ok: false, error: (e as Error).message }; }
  });

  // Copy the ai-relay.js Mod source to the clipboard for manual deploy (Roll20 → Settings → API
  // Scripts → New Script → paste → Save). Avoids bundling Playwright/Chromium just to automate the
  // paste; the automated path stays available from Claude Code (`npm run release:mod`).
  ipcMain.handle("copy-mod-script", () => {
    try {
      const assetRoot = process.env.DMW_ASSET_ROOT || path.join(__dirname, "..", "..");
      const src = fs.readFileSync(path.join(assetRoot, "mod-scripts", "ai-relay.js"), "utf-8");
      clipboard.writeText(src);
      return { ok: true, bytes: src.length };
    } catch (e) { return { ok: false, error: (e as Error).message }; }
  });

  // Config write: update CONFIG in memory (immediate) + persist to voice-hud/.env (restarts).
  // Keys marked ★ in the UI (pttKey, confirmKey, stt.*) need a restart to fully take effect.
  ipcMain.handle("set-config", (_e, updates: Record<string, unknown>) => {
    const envMap: Record<string, string> = {
      pttKey: "DMW_PTT_KEY", pttMouseButton: "DMW_PTT_BUTTON", confirmKey: "DMW_CONFIRM_KEY",
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

    // Detect campaign switch and reset combat state so stale turn/plan data doesn't bleed over.
    const currentSlug = readActiveSlug();
    if (currentSlug && currentSlug !== activeSlug) {
      activeSlug = currentSlug;
      campaignData = loadCampaignData(activeSlug);
      combatPlans.clear();
      combatCurrentId = "";
      combatCurrentName = "";
      combatRound = 0;
      inboxItems.length = 0;
      pushInbox();
      // Clear the combat band in the renderer so stale turn info doesn't persist after a switch.
      send("combat-update", { active: false, currentName: "", round: 0, plan: null, allPlans: {} });
      console.error(`[roster] campaign switched to ${activeSlug} — combat state reset`);
    }

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
    if (_agentTurnActive) {
      _pendingRosterBlock = block;
    } else {
      agent.setRoster(block);
    }
    if (!opts.silent) send("agent", { kind: "info", text: `roster: ${names.length} names` });
  } catch (err) {
    send("agent", { kind: "error", text: "roster build failed: " + (err as Error).message });
  }
}

// --- Determine active campaign from the main project's registry ---
function readActiveSlug(): string {
  try {
    const p = path.join(process.env.DMW_DATA_DIR || path.join(__dirname, "..", "..", "data"), "active-campaign.json");
    return (JSON.parse(fs.readFileSync(p, "utf-8")) as { slug: string }).slug || "";
  } catch { return ""; }
}

// Upsert KEY=value into <dataDir>/.env (replace the line if present, else append) so the
// setup wizard's secrets persist to the per-user dir loaded on next launch.
function upsertEnv(key: string, value: string): void {
  const dir = process.env.DMW_DATA_DIR || CONFIG.dataDir;
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, ".env");
  let txt = ""; try { txt = fs.readFileSync(file, "utf-8"); } catch { /* new file */ }
  const re = new RegExp(`^${key}=.*$`, "m");
  txt = re.test(txt) ? txt.replace(re, `${key}=${value}`) : `${txt.replace(/\n?$/, "\n")}${key}=${value}\n`;
  fs.writeFileSync(file, txt);
}

// STT model catalog — ggml whisper.cpp models. base.en ships bundled; the rest download on demand
// to <dataDir>/models and serve as the two-tier FINAL model (base.en stays the fast-partial primary).
const STT_MODELS: Array<{ id: string; label: string; sizeMB: number; bundled?: boolean }> = [
  { id: "base.en",   label: "Base (built-in, fastest)", sizeMB: 148, bundled: true },
  { id: "small.en",  label: "Small (balanced)",         sizeMB: 488 },
  { id: "medium.en", label: "Medium (most accurate)",   sizeMB: 1530 },
];

// Stream a ggml model from HuggingFace to disk, emitting progress to the gem. Writes to a .part
// file then renames, so a crash never leaves a half file that looks complete.
async function downloadModel(id: string, dest: string): Promise<void> {
  const url = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${id}.bin?download=true`;
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`);
  const total = Number(res.headers.get("content-length")) || 0;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.part`;
  const out = fs.createWriteStream(tmp);
  let recv = 0, lastPct = -1;
  const reader = (res.body as { getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }>; releaseLock?(): void } }).getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      if (!out.write(Buffer.from(value))) await new Promise<void>((r) => out.once("drain", () => r()));
      recv += value.length;
      const pct = total ? Math.floor((recv / total) * 100) : 0;
      if (pct !== lastPct) { lastPct = pct; send("stt-model-progress", { id, pct, recvMB: Math.round(recv / 1e6) }); }
    }
  } finally { reader.releaseLock?.(); }
  await new Promise<void>((resolve, reject) => out.end((e?: Error | null) => (e ? reject(e) : resolve())));
  fs.renameSync(tmp, dest);
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
  startStt((m) => console.error(String(m).trimEnd()))
    .then((engine) => {
      stt = engine;
      stt.on("exit", (code: number) => send("agent", { kind: "error", text: `STT exited (${code})` }));
      send("agent", { kind: "info", text: `scrying gem attuned (${engine.name})` });
    })
    .catch((err) => send("agent", { kind: "error", text: "STT failed: " + (err as Error).message }));

  // Two-tier (opt-in): a second resident server on a bigger model for FINAL clips only.
  // Off unless DMW_WHISPER_FINAL_MODEL is set + whisperserver; null on failure → finals
  // just use the primary engine. Started in the background; never blocks the gem.
  startFinalStt((m) => console.error(String(m).trimEnd()))
    .then((engine) => {
      if (!engine) return;
      sttFinal = engine;
      sttFinal.on("exit", () => { sttFinal = null; }); // crash → silently fall back to primary
      send("agent", { kind: "info", text: `two-tier finals: ${engine.name}` });
    })
    .catch(() => { /* finals fall back to the primary engine */ });

  try {
    // Phase B: when packaged (or DMW_SUPERVISE_SERVER=1), the gem owns the MCP server —
    // spawn + wait for it to bind before connecting. No-op in dev (external server).
    await ensureServerRunning((m) => console.error(String(m).trimEnd()));
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
app.on("before-quit", () => { appQuitting = true; try { sttFinal?.stop(); } catch { /* ignore */ } try { stopServer(); } catch { /* ignore */ } });

app.on("window-all-closed", () => {
  appQuitting = true;
  ptt.stop();
  stt?.stop();
  stopServer();              // kill the supervised MCP server (no-op if we didn't spawn it)
  mcp.close().catch(() => {});
  app.quit();
});

let _gemBoundsBeforeExpand: { x: number; y: number } | null = null;

// --- RTDB event stream (SSE from the MCP server, replaces polling) ---
let _eventsReq: import("http").ClientRequest | null = null;
let _eventsGen = 0;

function connectEventStream() {
  if (!process.env.ROLL20_MCP_TOKEN) return; // no token → cannot authenticate to MCP server

  const gen = ++_eventsGen;
  _eventsReq?.destroy();

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
      if (gen === _eventsGen && !appQuitting) setTimeout(connectEventStream, 10_000);
      return;
    }
    console.error(`[events] connected (gen ${gen})`);
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
    res.on("end", () => { if (gen === _eventsGen && !appQuitting) { console.error("[events] SSE closed — reconnecting in 3s"); setTimeout(connectEventStream, 3_000); } });
    res.on("error", (e: Error) => { if (gen === _eventsGen && !appQuitting) { console.error("[events] SSE error:", e.message); setTimeout(connectEventStream, 5_000); } });
  });
  req.on("error", (e: Error) => { if (gen === _eventsGen && !appQuitting) { console.error("[events] SSE connect error:", e.message); setTimeout(connectEventStream, 5_000); } });
  _eventsReq = req;
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
    const it = (data as { item?: Partial<InboxItem> }).item;
    if (it && it.content) {
      inboxItems.push({
        key: it.key || `dm-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
        who: it.who || "?",
        playerid: it.playerid,
        content: it.content,
        type: it.type || "intent",
        timestamp: it.timestamp || Date.now(),
        handled: false,
      });
      if (inboxItems.length > INBOX_MAX) inboxItems.splice(0, inboxItems.length - INBOX_MAX);
      pushInbox();
    }
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
