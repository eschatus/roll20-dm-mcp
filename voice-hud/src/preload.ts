// Preload bridge: typed API exposed to the gem renderer.

import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("dmw", {
  // main → renderer
  onState: (cb: (state: string) => void) => ipcRenderer.on("state", (_e, s) => cb(s)),
  onTranscript: (cb: (t: { text: string; lowConfidence: boolean }) => void) =>
    ipcRenderer.on("transcript", (_e, t) => cb(t)),
  onAgent: (cb: (msg: { kind: string; text: string; detail?: string }) => void) =>
    ipcRenderer.on("agent", (_e, m) => cb(m)),
  // voice dictation into the ledger chatbox (when the panel is open)
  onDictate: (cb: (d: { text: string; lowConfidence: boolean }) => void) =>
    ipcRenderer.on("dictate", (_e, d) => cb(d)),

  // renderer → main: audio + recording signal
  sendClip: (buf: ArrayBuffer) => ipcRenderer.invoke("clip", buf),
  sendPartial: (buf: ArrayBuffer) => ipcRenderer.invoke("partial-clip", buf),
  recStarted: () => ipcRenderer.send("rec-started"),

  // HUD mode (ghost gem ↔ expanded wizard panel)
  setMode: (mode: "ghost" | "expanded") => ipcRenderer.send("set-mode", mode),
  // shut the whole HUD down (stops PTT hook, whisper sidecar, MCP, then quits)
  quit: () => ipcRenderer.send("quit-app"),

  // hot-swap the LLM backend (local ↔ cloud)
  getProvider: () => ipcRenderer.invoke("get-provider"),
  setProvider: (name: "ollama" | "anthropic") => ipcRenderer.invoke("set-provider", name),

  // global mousewheel over the gem (captured via the native hook so it works
  // even while the gem is click-through). rotation>0 = wheel down.
  onWheel: (cb: (d: { rotation: number }) => void) => ipcRenderer.on("wheel", (_e, d) => cb(d)),

  // typed input from the ledger chat → run the agent on it
  submitText: (text: string) => ipcRenderer.send("submit-text", text),

  // hover hit-test: renderer reports when the cursor is over the gem (or its
  // widget) so main can briefly disable click-through, making it grabbable.
  setHover: (over: boolean) => ipcRenderer.send("hover", over),

  // manual window drag (the ✥ handle): mousedown starts following the cursor,
  // mouseup stops. Avoids -webkit-app-region:drag, which eats hover/active CSS.
  dragStart: () => ipcRenderer.send("drag-start"),
  dragEnd: () => ipcRenderer.send("drag-end"),

  // campaign-data wizard
  getCampaignData: () => ipcRenderer.invoke("get-campaign-data"),
  saveCampaignData: (data: unknown) => ipcRenderer.invoke("save-campaign-data", data),
  addVocab: (term: string) => ipcRenderer.invoke("add-vocab", term),
  rebuildRoster: () => ipcRenderer.invoke("rebuild-roster"),

  // settings + whisper notification audio
  getSettings: () => ipcRenderer.invoke("get-settings"),
  saveSettings: (s: unknown) => ipcRenderer.invoke("save-settings", s),
  onSettings: (cb: (s: { agentSound: boolean }) => void) => ipcRenderer.on("settings", (_e, s) => cb(s)),
  getWhisperAudio: () => ipcRenderer.invoke("get-whisper-audio"),

  // RTDB push: live combat state (turn order changes, tactical plans)
  onCombatUpdate: (cb: (d: { active: boolean; currentName: string; round: number; plan: { name: string; shortTerm: string; mediumTerm?: string; longGoal?: string } | null; allPlans: Record<string, { name: string; shortTerm: string; mediumTerm?: string; longGoal?: string }> }) => void) =>
    ipcRenderer.on("combat-update", (_e, d) => cb(d)),
  // RTDB push: player DM inbox items
  onInboxUpdate: (cb: (d: { count: number; item?: { who: string; content: string; type: string } }) => void) =>
    ipcRenderer.on("inbox-update", (_e, d) => cb(d)),

  // Debug log stream from the main process
  onLog: (cb: (entry: { level: string; text: string; ts: number }) => void) =>
    ipcRenderer.on("log", (_e, entry) => cb(entry)),
  getLogHistory: () => ipcRenderer.invoke("get-log-history"),

  // Runtime config read/write (persisted to voice-hud/.env)
  getConfig: () => ipcRenderer.invoke("get-config"),
  setConfig: (updates: Record<string, unknown>) => ipcRenderer.invoke("set-config", updates),

  // Reconnect MCP (in case server wasn't up at HUD start)
  reconnectMcp: () => ipcRenderer.invoke("reconnect-mcp"),
});
