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

  // --- STT engine (faster-whisper sidecar) ---
  stt: {
    // The 3.10 venv python that has faster-whisper + CUDA libs installed.
    python: process.env.DMW_STT_PYTHON ||
      path.join(__dirname, "..", "stt", ".venv", "Scripts", "python.exe"),
    script: path.join(__dirname, "..", "stt", "whisper_server.py"),
    // Primary engine. Default large-v3-turbo at int8 (~1.5GB, half of float16's
    // ~3GB) to leave more VRAM for the local LLM. Override via DMW_STT_*.
    model: process.env.DMW_STT_MODEL || "large-v3-turbo",
    device: process.env.DMW_STT_DEVICE || "cuda",
    computeType: process.env.DMW_STT_COMPUTE || "int8_float16",
    // Fallback chain: tried in order if the one before fails to load (OOM, missing
    // CUDA libs, etc.). Each step is smaller/cheaper; last is CPU so STT always works.
    fallbacks: [
      { model: "medium", device: "cuda", computeType: "int8" },
      { model: "small",  device: "cuda", computeType: "int8" },
      { model: "small",  device: "cpu",  computeType: "int8" },
    ],
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
  // 7B (~5GB) fits fully on the 3080 Ti alongside Whisper (int8 ~1.5GB) with real
  // headroom — no CPU spill. The 14B (even Q3 ~8.8GB) overflowed once Whisper +
  // desktop were resident, running 36-48% on CPU = laggy. 14B/R1 reserved for
  // tactics (runs when Whisper is idle).
  ollamaModel: process.env.DMW_OLLAMA_MODEL || "qwen2.5:7b-instruct",

  // Tool allow-list for LOCAL models. The full 60-tool schema is ~9.9k tokens —
  // most of a 7B's context before the DM even speaks, and it tanks tool selection.
  // Local models see only these live-combat tools (~15); map/vision/prep/journal
  // tools are hidden from the local agent (the MCP server still serves all 60 to
  // Claude Code / map prep). Cloud provider gets the full set (handles it fine).
  // Deduplicated to exactly ONE tool per job (small models pick badly when tools
  // overlap). Notably: update_token_hp is the SINGLE HP+conditions tool — the
  // DDB-syncing apply_damage/heal_character and the redundant set_token_marker
  // are intentionally excluded from the local set (cloud still gets all 60).
  // batch_exec/sync_character_state/get_selection dropped: schema-heavy or niche.
  localToolAllowlist: [
    // reads
    "list_tokens", "get_token", "get_turn_order", "find_tokens_in_range",
    "get_recent_chat", "get_dm_inbox",
    // state changes — two clean primitives: HP and conditions
    "update_token_hp",   // hit points only
    "set_token_marker",  // conditions (sticker + tracked state)
    "set_token_props",   // position / aura / visual
    // combat flow
    "roll_initiative", "advance_turn", "roll_dice",
    // areas
    "create_zone", "clear_zone",
    // comms
    "send_narration", "whisper_player",
  ],

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
