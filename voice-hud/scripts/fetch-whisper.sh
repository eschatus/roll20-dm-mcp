#!/usr/bin/env bash
# Acquire the CPU whisper.cpp binaries + the base.en model for packaging on mac/linux.
# (Windows uses the official prebuilt release zip — see fetch-whisper.ps1.)
#
# Output layout (matches voice-hud/src/config.ts whisperBin/whisperServerBin for non-win32):
#   voice-hud/data/whisper/whisper-cli
#   voice-hud/data/whisper/whisper-server
#   voice-hud/data/models/ggml-base.en.bin
#
# Built static (-DBUILD_SHARED_LIBS=OFF) so there is no libwhisper/.dylib/.so to ship or
# resolve at runtime — the binaries depend only on system libs present on every host.
set -euo pipefail

TAG="${WHISPER_TAG:-v1.9.1}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # voice-hud/
WDIR="$HERE/data/whisper"
MDIR="$HERE/data/models"
mkdir -p "$WDIR" "$MDIR"

# 1) base.en model — the offline floor; identical file on every platform.
MODEL="$MDIR/ggml-base.en.bin"
if [ ! -f "$MODEL" ]; then
  echo "==> downloading ggml-base.en.bin"
  curl -fL --retry 3 -o "$MODEL" \
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin?download=true"
fi

# 2) whisper.cpp CPU binaries — built static from a pinned tag.
if [ ! -x "$WDIR/whisper-server" ]; then
  SRC="$(mktemp -d)/whisper.cpp"
  echo "==> building whisper.cpp $TAG (static, CPU)"
  git clone --depth 1 --branch "$TAG" https://github.com/ggerganov/whisper.cpp "$SRC"
  cmake -S "$SRC" -B "$SRC/build" \
    -DCMAKE_BUILD_TYPE=Release \
    -DBUILD_SHARED_LIBS=OFF \
    -DWHISPER_BUILD_TESTS=OFF
  cmake --build "$SRC/build" --config Release -j
  cp "$SRC/build/bin/whisper-cli" "$WDIR/"
  cp "$SRC/build/bin/whisper-server" "$WDIR/"
  chmod +x "$WDIR/whisper-cli" "$WDIR/whisper-server"
fi

echo "==> whisper assets ready:"
ls -la "$WDIR" "$MDIR"
