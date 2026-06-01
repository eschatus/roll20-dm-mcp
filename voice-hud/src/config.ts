// Central config for the DM Whisper HUD. Tunable knobs live here so the rest of
// the code reads intent, not magic numbers.

import * as path from "path";

export const CONFIG = {
  // --- Push-to-talk ---
  // PTT key. Default Right-Ctrl (hold to talk, release to send) — no toggle
  // side-effect, unlike CapsLock. Set DMW_PTT_KEY to any UiohookKey name
  // (e.g. "F8", "ScrollLock", "CapsLock"). UiohookKey names: right ctrl is
  // "CtrlRight". To use a mouse side-button instead, set DMW_PTT_BUTTON (uiohook
  // button number; back/forward usually 4/5) — when set, it takes precedence.
  pttKey: process.env.DMW_PTT_KEY || "CtrlRight",
  pttMouseButton: process.env.DMW_PTT_BUTTON ? Number(process.env.DMW_PTT_BUTTON) : null,

  // Dedicated confirm key for write proposals (separate from PTT). Default
  // Right-Shift (UiohookKey "ShiftRight") — pairs with Right-Ctrl PTT. Esc cancels.
  confirmKey: process.env.DMW_CONFIRM_KEY || "ShiftRight",

  // --- Whisper sidecar ---
  stt: {
    // The 3.10 venv python that has faster-whisper + CUDA libs installed.
    python: process.env.DMW_STT_PYTHON ||
      path.join(__dirname, "..", "stt", ".venv", "Scripts", "python.exe"),
    script: path.join(__dirname, "..", "stt", "whisper_server.py"),
    model: process.env.DMW_STT_MODEL || "large-v3-turbo",
    device: process.env.DMW_STT_DEVICE || "cuda",
    computeType: process.env.DMW_STT_COMPUTE || "float16",
  },

  // --- Live partial transcription ---
  // While PTT is held, re-transcribe the accumulated audio this often (ms) to
  // stream partial text into the box. Only one partial is ever in flight.
  partialMs: Number(process.env.DMW_PARTIAL_MS) || 900,

  // --- MCP server (Component A) ---
  mcpUrl: process.env.DMW_MCP_URL || "http://127.0.0.1:39200/mcp",

  // --- HUD agent provider ---
  // "ollama" (local, free, default) or "anthropic" (cloud). DMW_PROVIDER overrides.
  provider: (process.env.DMW_PROVIDER || "ollama") as "ollama" | "anthropic",

  // Anthropic (cloud) model — used when provider=anthropic.
  model: process.env.DMW_MODEL || "claude-sonnet-4-6",

  // Ollama (local) — OpenAI-compatible endpoint + a tool-calling model.
  // qwen2.5:14b-instruct handles tool-calling well; R1-distill does NOT, so it's
  // for tactics reasoning, not the HUD agent loop.
  ollamaUrl: process.env.DMW_OLLAMA_URL || "http://127.0.0.1:11434/v1",
  // Q3 quant (~7GB) so the 14B fits fully on the 3080 Ti alongside Whisper (~3GB)
  // without spilling layers to CPU (the Q4 ~10GB build ran 48% on CPU = very laggy).
  ollamaModel: process.env.DMW_OLLAMA_MODEL || "qwen2.5:14b-instruct-q3_K_M",

  // --- Agent whisper notification sound ---
  // The demonic whisper clip played when the agent responds. A random slice of
  // this length is played. Toggle persisted in settings.json (env DMW_AGENT_SOUND=0
  // disables by default).
  whisperSoundPath: process.env.DMW_WHISPER_MP3 ||
    path.join(__dirname, "..", "..", "data", "whisper.mp3"),
  whisperClipMs: Number(process.env.DMW_WHISPER_CLIP_MS) || 300,

  // --- Paths ---
  // Durable per-campaign data: vocab, nicknames, DM notes.
  dataDir: process.env.DMW_DATA_DIR || path.join(__dirname, "..", "data"),

  // Temp dir for captured audio clips.
  tmpDir: path.join(require("os").tmpdir(), "dm-whisper"),
};
