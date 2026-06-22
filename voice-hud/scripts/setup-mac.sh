#!/usr/bin/env bash
# setup-mac.sh — idempotent setup for whisper.cpp STT on Apple Silicon (macOS)
# Run from anywhere; resolves paths relative to voice-hud/.
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VOICEHUD_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MODELS_DIR="$VOICEHUD_DIR/data/models"
MODEL_FILE="$MODELS_DIR/ggml-base.en.bin"
MODEL_URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin"

echo "=== roll20-dm-mcp voice-hud: macOS whisper.cpp setup ==="
echo "voice-hud dir: $VOICEHUD_DIR"
echo ""

# ── (a) Verify Homebrew ────────────────────────────────────────────────────────
if ! command -v brew &>/dev/null; then
  echo "ERROR: Homebrew is not installed."
  echo ""
  echo "Install it first:"
  echo '  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"'
  echo ""
  echo "Then re-run this script."
  exit 1
fi
echo "[ok] Homebrew found: $(brew --prefix)"

# ── (b) Install whisper-cpp via Homebrew if whisper-cli not on PATH ─────────────
if command -v whisper-cli &>/dev/null; then
  echo "[ok] whisper-cli already on PATH: $(command -v whisper-cli)"
else
  echo "[..] Installing whisper-cpp via Homebrew (builds with Metal + Accelerate)..."
  brew install whisper-cpp
  echo "[ok] whisper-cli installed: $(command -v whisper-cli)"
fi

# ── (c) Download ggml-base.en.bin if absent ────────────────────────────────────
mkdir -p "$MODELS_DIR"
if [ -f "$MODEL_FILE" ]; then
  echo "[ok] Model already present: $MODEL_FILE"
else
  echo "[..] Downloading ggml-base.en.bin (~148 MB) from Hugging Face..."
  curl -L --progress-bar -o "$MODEL_FILE" "$MODEL_URL"
  echo "[ok] Model saved: $MODEL_FILE"
fi

# ── (d) Print export lines + run steps ────────────────────────────────────────
WHISPER_BIN="$(command -v whisper-cli)"

echo ""
echo "═══════════════════════════════════════════════════════════════════════════"
echo "Setup complete! Paste these exports into your terminal (or add to ~/.zshrc):"
echo "═══════════════════════════════════════════════════════════════════════════"
echo ""
echo "export DMW_STT_ENGINE=whispercpp"
echo "export DMW_WHISPER_BIN=\"$WHISPER_BIN\""
echo "export DMW_WHISPER_MODEL=\"$MODEL_FILE\""
echo "export DMW_AB_ENGINES=whispercpp"
echo "export DMW_AB_VOCAB=\"Strahd, von Zarovich, Ireena, Kolyana, Ismark, Rahadin, Vasili, Ravenloft, Haregon, Brie Mossfrond, Daever Tympania, Dacorath Applebough, Eldran Silvershadow, Thorne, vampire spawn, dire wolf, swarm of bats\""
echo ""
echo "═══════════════════════════════════════════════════════════════════════════"
echo "Then run:"
echo "  npm run record    # open http://localhost:8137 and record the 24 lines"
echo "  npm run ab:stt    # run the whisper.cpp-only A/B harness"
echo "═══════════════════════════════════════════════════════════════════════════"
