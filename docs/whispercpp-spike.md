# whisper.cpp STT engine — spike (try-before-bundle)

Goal: replace the Python **faster-whisper** sidecar with the **native whisper.cpp** binary. This
deletes the entire Python venv + CUDA-lib install — the single biggest packaging simplification for
an installer — and replaces it with one small prebuilt executable + one `ggml *.bin` model.

It's wired behind a flag so you can A/B it against the Python engine on real audio before we commit
to bundling it. The Python path stays the default and is the automatic fallback.

## Why a prebuilt binary (not a node addon)

We spawn the official prebuilt `whisper-cli` executable, **not** a native node binding. That means
**no node-gyp, no MSVC/Xcode, no `electron-rebuild`** — on the build box *or* the end user's machine.
GPU is just a different prebuilt binary (CPU / cuBLAS / Vulkan) pointed at by `DMW_WHISPER_BIN`; the
spawn args are identical. And it's exactly the per-OS packaging story we want: each installer drops in
that platform's whisper.cpp binary via `extraResources`.

## What's in the repo now

- `voice-hud/src/stt/whisperCpp.ts` — `WhisperCppEngine` (same `SttEngine` contract). Spawns
  `whisper-cli -m model -f clip.wav -l en -np -ojf -of <prefix> [--prompt vocab]`, reads the
  `<prefix>.json` it writes, joins the segment text, and derives `low_confidence` from the mean
  per-token probability. whisper.cpp reads the gem's 16 kHz WAV directly — no PCM/ffmpeg step.
- `voice-hud/src/stt/index.ts` — when `DMW_STT_ENGINE=whispercpp`, tries this engine first and
  **falls back to the faster-whisper chain** on any failure (binary or model missing).
- `config.ts` — `sttEngine`, `whisperBin`, `whisperModel`.

**Validated headlessly:** arg building + JSON parsing (`buildWhisperArgs` / `parseWhisperJson`,
unit-tested), the factory routing + fallback, and a real `whisper-cli -ojf` run whose JSON shape
matches the parser. **NOT validated here:** actual speech accuracy/latency on your mic — that's the
spike.

## Try it (Windows, CPU — already staged on this box)

The CPU binary (`whisper.cpp` v1.9.1 `whisper-bin-x64.zip`) and `ggml-base.en.bin` are already
downloaded under `voice-hud/data/` (gitignored), at the default paths. So just:

```sh
cd voice-hud
DMW_STT_ENGINE=whispercpp npm run start     # or: set DMW_STT_ENGINE=whispercpp && npm run start
```

Watch the Debug tab for `[stt] using whisper.cpp:ggml-base.en.bin`. PTT a few lines and compare
latency + accuracy to faster-whisper (unset the env var to switch back).

### GPU (your 3080 Ti) — drop-in swap

Download a cuBLAS build and repoint the binary; nothing else changes:

```sh
gh release download --repo ggerganov/whisper.cpp v1.9.1 \
  --pattern 'whisper-cublas-12.4.0-bin-x64.zip' --dir voice-hud/data/whisper-cuda
# unzip, then:
set DMW_WHISPER_BIN=...\voice-hud\data\whisper-cuda\Release\whisper-cli.exe
```

The cuBLAS release bundles the CUDA runtime DLLs, so it runs without installing the CUDA toolkit
(your GPU driver supplies the rest). If it fails to load, the factory falls back to faster-whisper.

### Other platforms

macOS/Linux: grab the matching release (`whisper-bin-ubuntu-x64.tar.gz`, the xcframework, or
`brew install whisper-cpp`) and point `DMW_WHISPER_BIN` at it. macOS gets CoreML/Metal for Apple
Silicon GPU. Default bin path is platform-aware (`Release/whisper-cli.exe` on win32, `whisper-cli`
elsewhere).

## Tunables

- **Model size** = speed/accuracy/size: `base.en` (fast, ~150 MB) → `small.en` → `medium.en`
  (`DMW_WHISPER_MODEL`).
- **Threads** (CPU): `WhisperCppOpts.threads` (default 4).
- **Latency upgrade if needed:** this one-shot reloads the model per clip. `whisper-server.exe`
  (also in the release) keeps it resident behind an HTTP API — a drop-in future engine if per-clip
  load time hurts at the table.

## If it's good

Then: vendor the binary + model into the build (electron-builder `extraResources`, one per GPU
config), default `sttEngine` to `whispercpp`, and **retire the Python sidecar + venv entirely** —
including making a CPU whisper.cpp build the universal fallback so there's no Python left in the HUD
runtime at all.
