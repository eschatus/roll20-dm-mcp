// Central config for the DM Whisper HUD. Tunable knobs live here so the rest of
// the code reads intent, not magic numbers.

import * as path from "path";

// Tool allow-list for LOCAL models. The full 60-tool schema is ~9.9k tokens —
// most of a 7B's context before the DM even speaks, and it tanks tool selection.
// Local models see only these live-combat tools (~15); map/vision/prep/journal
// tools are hidden (the MCP server still serves all 60 to Claude Code / map prep).
// Deduplicated to exactly ONE tool per job (small models pick badly when tools
// overlap): update_token_hp is the SINGLE HP+conditions tool — batch_exec is
// intentionally excluded here.
const LOCAL_TOOLS = [
  // session
  "list_campaigns", "active_campaign", "switch_campaign",
  // reads
  "list_tokens", "get_token", "get_turn_order", "find_tokens_in_range",
  "get_recent_chat", "get_dm_inbox",
  // state changes — clean primitives: HP (single + batch) and conditions
  "update_token_hp",   // hit points, one token
  "update_hp_many",    // hit points, many tokens in ONE call (AoE — no iteration)
  "set_token_marker",  // conditions (sticker + tracked state)
  "set_token_props",   // position / aura / visual
  // combat flow
  "roll_initiative", "advance_turn", "roll_dice",
  // areas
  "create_zone", "clear_zone",
  // comms
  "send_narration", "whisper_player",
];

// Tool allow-list for CLOUD (Claude). Same stripped scope — NO vision/map/prep
// tools (those ~15 schemas are pure bloat at the live table and were a real
// chunk of cloud turn latency). Cloud handles richer tool use well, so on top of
// the local set it keeps the power tools the 7B can't: batch ops, DDB-syncing HP,
// full turn-order control, token removal. (Server still serves all 60 to Claude
// Code for map prep.)
const CLOUD_TOOLS = [
  ...LOCAL_TOOLS,
  "batch_exec",                                   // one round-trip for bulk edits
  "get_token_markers", "get_selection", "list_custom_states", // richer reads
  "clear_turn_order", "update_turn_order", "inject_round_marker", // turn-order
  "set_turn_hook", "check_turn_hook", "plan_all_tactics", "plan_tactics", // combat start/round hooks
  "sync_character_state", "remove_object",
  "get_mob_plans",  // read persisted tactical plans for HUD display
  "ddb_get_character", "ddb_get_monster", "ddb_list_campaign_characters", "ddb_list_campaigns", // DDB reads
  "add_vocab", "add_nickname", "remove_vocab", "remove_nickname", // STT vocab + alias editing
  "register_campaign", "remove_campaign",                         // campaign setup
  "get_current_page",  // page verification in scene-set + cleanup
  "list_zones",        // enumerate zones for cleanup
];

// ---------------------------------------------------------------------------
// Phase-scoped tool allowlists
// ---------------------------------------------------------------------------
// Each phase narrows the toolset to what the agent should actually use during
// that phase. Wrong-phase tool calls are a major source of errors when one flat
// prompt drives every moment of play, so these lists are intentionally tight.
//
// IDLE — out of combat: read-only + lookup + journal. No HP/condition tools.
const IDLE_TOOLS = [
  "list_campaigns", "active_campaign", "switch_campaign",
  "list_tokens", "get_token", "get_recent_chat", "get_dm_inbox",
  "get_turn_order",
  "ddb_get_character", "ddb_get_monster", "ddb_list_campaign_characters", "ddb_list_campaigns",
  "create_handout", "create_character_stub", "get_journal_folder", "set_journal_folder",
  "send_narration", "whisper_player",
  "add_vocab", "add_nickname", "remove_vocab", "remove_nickname",
  "register_campaign", "remove_campaign",
];

// SCENE_SET — board review (read-mostly, silent to players). No writes except
// campaign switch. The agent confirms the campaign, verifies the map page,
// matches cast to tokens, and flags rules keywords. No initiative, no turn order.
const SCENE_SET_TOOLS = [
  "list_campaigns", "active_campaign", "switch_campaign",
  "get_current_page", "list_tokens", "get_token",
  "ddb_get_character", "ddb_get_monster", "ddb_list_campaign_characters", "ddb_list_campaigns",
  "get_dm_inbox",
];

// INIT_PREP — stage the monster side while players sort their own inits.
// NPC-only initiative roll, nameplate reveal, tactics launch. NO advance_turn,
// NO clear_turn_order, NO HP writes.
const INIT_PREP_TOOLS = [
  "list_tokens", "get_token", "get_turn_order",
  "roll_initiative",          // must use npcOnly=true, clearFirst=false
  "set_token_props",          // nameplate on (showname / showplayers_name)
  "batch_exec",               // bulk nameplate update across all NPCs
  "plan_all_tactics",         // queue tactical plans before first turn
  "ddb_get_monster",
];

// COMBAT_LOOP — turn by turn. Full live-combat toolset; still no map/vision/prep.
const COMBAT_LOOP_TOOLS = CLOUD_TOOLS;

// CLEANUP — explicit close sequence. Destructive but gated: each step is a
// write that will be proposed for DM confirmation. NO HP writes (combat is over).
const CLEANUP_TOOLS = [
  "set_turn_hook",
  "clear_turn_order",
  "list_zones", "clear_zone",
  "set_token_props",           // clear auras (aura1_radius=0)
  "batch_exec",
  "sync_character_state",
  "list_tokens",
];

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

  // STT engine selector. "faster-whisper" = the Python sidecar (default). "whispercpp"
  // = the native prebuilt whisper.cpp CLI binary (one-shot, reloads per clip). "whisperserver"
  // = whisper-server.exe kept resident (model loads once; much lower per-clip latency).
  // The factory falls back to faster-whisper if the selected engine fails to start.
  sttEngine: (process.env.DMW_STT_ENGINE || "faster-whisper") as "faster-whisper" | "whispercpp" | "whisperserver",
  // whisper.cpp prebuilt CLI binary. Default = the extracted release under the data
  // dir (CPU on win32). Swap to a cuBLAS/Vulkan build via DMW_WHISPER_BIN for GPU.
  whisperBin: process.env.DMW_WHISPER_BIN ||
    path.join(__dirname, "..", "data", "whisper", process.platform === "win32" ? "Release/whisper-cli.exe" : "whisper-cli"),
  // whisper.cpp ggml model (.bin) for the native engine. Default under the data dir.
  whisperModel: process.env.DMW_WHISPER_MODEL ||
    path.join(__dirname, "..", "data", "models", "ggml-base.en.bin"),
  // whisper-server.exe binary path. Default = Release dir alongside whisper-cli.exe.
  // Set DMW_WHISPER_SERVER_BIN to override (e.g. point at the cuBLAS build for GPU).
  whisperServerBin: process.env.DMW_WHISPER_SERVER_BIN ||
    path.join(__dirname, "..", "data", "whisper", process.platform === "win32" ? "Release/whisper-server.exe" : "whisper-server"),
  // HTTP port for the resident whisper-server (default 18080 — avoids conflicts with
  // common 8080). Set DMW_WHISPER_SERVER_PORT to override.
  whisperServerPort: Number(process.env.DMW_WHISPER_SERVER_PORT) || 18080,
  // Optional TWO-TIER (only with whisperserver): when set, the FINAL committed clip is
  // transcribed by a second resident server on this bigger/more-accurate model, while
  // fast live partials keep using whisperModel — spending latency headroom where it
  // matters (the agent-driving final) without lagging the 900 ms partial loop. Empty =
  // single-tier. e.g. DMW_WHISPER_FINAL_MODEL=…/ggml-medium.en.bin with a base.en primary.
  whisperFinalModel: process.env.DMW_WHISPER_FINAL_MODEL || "",

  // --- STT engine (faster-whisper sidecar) ---
  stt: {
    // The 3.10 venv python that has faster-whisper + CUDA libs installed.
    python: process.env.DMW_STT_PYTHON ||
      path.join(__dirname, "..", "stt", ".venv", "Scripts", "python.exe"),
    script: path.join(__dirname, "..", "stt", "whisper_server.py"),
    // Primary engine: large-v3-turbo at float16 (~3GB) for best accuracy. We used
    // to run int8_float16 (~1.5GB) to share the GPU with the local 7B LLM — but the
    // HUD agent now runs on cloud Claude (DMW_PROVIDER=anthropic), so that VRAM is
    // free and full float16 fits with headroom on the 3080 Ti. Override via
    // DMW_STT_*; the fallback chain below still drops to int8 on OOM.
    model: process.env.DMW_STT_MODEL || "large-v3-turbo",
    device: process.env.DMW_STT_DEVICE || "cuda",
    computeType: process.env.DMW_STT_COMPUTE || "float16",
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
  // Local LLM (Ollama) is MOTHBALLED behind a flag — it needs a much bigger GPU than
  // the cloud default delivers, so it's hidden/disabled unless DMW_ENABLE_LOCAL_LLM=1.
  enableLocalLlm: process.env.DMW_ENABLE_LOCAL_LLM === "1",
  // "anthropic" (cloud, default) or "ollama" (local — only honored when the flag is on,
  // so a stale DMW_PROVIDER=ollama can't strand the gem on a backend that's disabled).
  provider: ((process.env.DMW_ENABLE_LOCAL_LLM === "1" && process.env.DMW_PROVIDER)
    ? process.env.DMW_PROVIDER : "anthropic") as "ollama" | "anthropic",

  // Anthropic (cloud) model — used when provider=anthropic or on auto-escalation.
  // Haiku 4.5 is cheap + reliable at narration parsing / multi-target tool use
  // (the exact thing the local 7B flubs). Bump to sonnet via DMW_MODEL if needed.
  model: process.env.DMW_MODEL || "claude-haiku-4-5",

  // Auto-escalate complex narration turns from local → cloud (Haiku). Off via
  // DMW_AUTO_ESCALATE=0. Heuristic lives in agent.ts (length + multiple targets).
  autoEscalate: process.env.DMW_AUTO_ESCALATE !== "0",

  // Ollama (local) — OpenAI-compatible endpoint + a tool-calling model.
  // qwen2.5:14b-instruct handles tool-calling well; R1-distill does NOT, so it's
  // for tactics reasoning, not the HUD agent loop.
  ollamaUrl: process.env.DMW_OLLAMA_URL || "http://127.0.0.1:11434/v1",
  // 7B (~5GB) fits fully on the 3080 Ti alongside Whisper (int8 ~1.5GB) with real
  // headroom — no CPU spill. The 14B (even Q3 ~8.8GB) overflowed once Whisper +
  // desktop were resident, running 36-48% on CPU = laggy. 14B/R1 reserved for
  // tactics (runs when Whisper is idle).
  ollamaModel: process.env.DMW_OLLAMA_MODEL || "qwen2.5:7b-instruct",

  // Live-play tool allow-lists (defined above). Both strip the vision/map/prep
  // tools; cloud additionally keeps the heavier combat tools the 7B can't.
  localToolAllowlist: LOCAL_TOOLS,
  cloudToolAllowlist: CLOUD_TOOLS,

  // Phase-scoped tool allowlists. toolSpecs() in agent.ts picks among these
  // based on the current DmPhase instead of using the flat cloud/local lists.
  phaseTools: {
    IDLE:         IDLE_TOOLS,
    SCENE_SET:    SCENE_SET_TOOLS,
    INIT_PREP:    INIT_PREP_TOOLS,
    COMBAT_LOOP:  COMBAT_LOOP_TOOLS,
    CLEANUP:      CLEANUP_TOOLS,
  } as Record<string, string[]>,

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
