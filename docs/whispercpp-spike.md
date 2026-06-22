# whisper.cpp STT engine — spike (try-before-bundle)

Goal: replace the Python **faster-whisper** sidecar with a **native whisper.cpp** binding
(`smart-whisper`). This deletes the entire Python venv + CUDA-lib install — the single biggest
packaging simplification for an installer — and turns the model into one `ggml *.bin` file.

It's wired behind a flag so you can A/B it against the Python engine on real audio before we commit
to bundling it. The Python path stays the default and is the automatic fallback.

## What's in the repo now

- `voice-hud/src/stt/whisperCpp.ts` — `WhisperCppEngine` (same `SttEngine` contract as
  faster-whisper). Decodes the gem's 16 kHz/mono/16-bit WAV → float PCM (no ffmpeg), runs
  `smart-whisper`, returns the same `TranscriptResult`. The binding is **lazy-imported**, so the
  gem runs fine without it.
- `voice-hud/src/stt/index.ts` — when `DMW_STT_ENGINE=whispercpp`, tries this engine first and
  **falls back to the faster-whisper chain** on any failure (missing model, addon not built).
- `config.ts` — `sttEngine` + `whisperModel` knobs.

**Validated headlessly:** the WAV decoder (`decodeWav16ToF32`, unit-tested), the factory routing,
and the fallback. **NOT validated here:** the native addon build, GPU, and actual transcription —
that's this spike.

## Try it

```sh
cd voice-hud
npm i smart-whisper            # native addon — builds whisper.cpp
npx electron-rebuild           # CRITICAL: rebuild the addon against Electron's ABI, not Node's

# Get a model (ggml .bin). base.en is a good first test (~150 MB):
#   https://huggingface.co/ggerganov/whisper.cpp  → ggml-base.en.bin
mkdir -p data/models && curl -L -o data/models/ggml-base.en.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin

# Enable + launch:
set DMW_STT_ENGINE=whispercpp
set DMW_WHISPER_MODEL=...\data\models\ggml-base.en.bin   # optional; this is the default path
set DMW_STT_DEVICE=cuda                                  # or cpu (gpu = device !== "cpu")
npm run start
```

Watch the Debug tab: `[stt] using whisper.cpp:ggml-base.en.bin/...`. PTT a few lines and compare
latency + accuracy to faster-whisper (flip `DMW_STT_ENGINE` back to switch).

## Known adaptation points (this is a spike)

- **Electron ABI.** A Node-built addon won't load in Electron — `electron-rebuild` is mandatory, and
  it has to re-run on Electron upgrades. (The eventual installer handles this in its build step.)
- **GPU backend.** `smart-whisper`'s prebuilt may be CPU-only; a CUDA/Vulkan build may need build
  flags. Carries @ChiRomo1121's intent from #40 (detect device; don't burn time on doomed backends).
- **API shape.** `transcribe()` / segment fields (`tokens[].p` for the confidence estimate) can vary
  by version — `whisperCpp.ts` has one clearly-marked spot to adapt. The type shim
  (`src/stt/smart-whisper.d.ts`) is minimal; align it to the installed version if it drifts.
- **Model size** is the speed/accuracy/size knob: `base.en` (fast, ~150 MB) → `small.en` → `medium.en`.

## If it's good

Then: make `smart-whisper` an (optional) dependency, pick the bundled model(s), wire `electron-rebuild`
into the build, default `sttEngine` to `whispercpp`, and retire the Python sidecar + venv.
