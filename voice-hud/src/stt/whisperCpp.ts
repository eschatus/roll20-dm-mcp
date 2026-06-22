// Native whisper.cpp STT engine (SPIKE, behind DMW_STT_ENGINE=whispercpp).
//
// Why: it drops the Python faster-whisper sidecar (+ its CUDA-lib install) entirely
// — the single biggest packaging simplification — using a native node binding
// (smart-whisper) and one ggml `.bin` model. Same SttEngine contract as
// FasterWhisperEngine, so main.ts is untouched; the factory (index.ts) picks it.
//
// The gem hand-rolls a 16 kHz / mono / 16-bit PCM WAV (see renderer/gem.js
// encodeWav), which is exactly whisper.cpp's required input — decode is a plain
// int16 → float, no ffmpeg/resampling.
//
// NOT yet validated end-to-end (native addon needs an Electron ABI rebuild + a
// model + real audio + a GPU). See docs/whispercpp-spike.md to try it. The binding
// is lazy-imported so the gem runs fine without it; the factory falls back to the
// Python engine if this fails to load.
import { EventEmitter } from "events";
import * as fs from "fs";
import * as path from "path";
import { SttEngine, TranscriptResult } from "./engine";

export interface WhisperCppOpts { modelPath: string; gpu: boolean }

export class WhisperCppEngine extends EventEmitter implements SttEngine {
  readonly name: string;
  private whisper: import("smart-whisper").Whisper | null = null;
  constructor(private opts: WhisperCppOpts) {
    super();
    this.name = `whisper.cpp:${path.basename(opts.modelPath)}/${opts.gpu ? "gpu" : "cpu"}`;
  }

  async start(): Promise<void> {
    if (!fs.existsSync(this.opts.modelPath)) {
      throw new Error(`whisper.cpp model not found: ${this.opts.modelPath} — download a ggml .bin (see docs/whispercpp-spike.md)`);
    }
    let mod: typeof import("smart-whisper");
    try {
      mod = await import("smart-whisper");
    } catch {
      throw new Error("smart-whisper not installed/built — `npm i smart-whisper` then `npx electron-rebuild` (see docs/whispercpp-spike.md)");
    }
    this.whisper = new mod.Whisper(this.opts.modelPath, { gpu: this.opts.gpu });
    this.emit("ready", { model: this.opts.modelPath, gpu: this.opts.gpu });
  }

  async transcribe(wavPath: string, initialPrompt?: string): Promise<TranscriptResult> {
    if (!this.whisper) throw new Error("whisper.cpp engine not started");
    const t0 = Date.now();
    const pcm = decodeWav16ToF32(fs.readFileSync(wavPath));
    // smart-whisper: transcribe(pcm, opts) → { result: Promise<segments> }. (API
    // shape can vary by version — this is the one spot to adapt on install.)
    const task = await this.whisper.transcribe(pcm, { language: "en", prompt: initialPrompt || "" });
    const segments = await task.result;
    const text = segments.map((s) => s.text).join("").trim();
    // Best-effort confidence from per-token probabilities, if the build exposes them.
    const probs = segments.flatMap((s) => (s.tokens ?? []).map((t) => t.p)).filter((p): p is number => typeof p === "number");
    const avgP = probs.length ? probs.reduce((a, b) => a + b, 0) / probs.length : 1;
    return {
      text,
      avg_logprob: Math.log(Math.min(Math.max(avgP, 1e-6), 1)),
      no_speech_prob: 0,
      low_confidence: text.length > 0 && avgP < 0.5,
      language: "en",
      duration: (Date.now() - t0) / 1000,
    };
  }

  stop(): void {
    try { void this.whisper?.free?.(); } catch { /* ignore */ }
    this.whisper = null;
  }
}

// 16-bit PCM mono WAV → Float32 [-1, 1]. Scans the RIFF chunks for `data` (the gem
// writes a canonical 44-byte header, but scanning is robust + cheap). Exported for
// unit tests — this is the part we CAN verify without the native addon.
export function decodeWav16ToF32(buf: Buffer): Float32Array {
  let off = 12; // skip "RIFF"<size>"WAVE"
  let dataStart = 44;
  let dataLen = Math.max(0, buf.length - 44);
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === "data") { dataStart = off + 8; dataLen = size; break; }
    off += 8 + size + (size & 1); // chunks are word-aligned
  }
  const n = Math.min(dataLen, buf.length - dataStart) >> 1;
  const out = new Float32Array(Math.max(0, n));
  for (let i = 0; i < out.length; i++) out[i] = buf.readInt16LE(dataStart + i * 2) / 32768;
  return out;
}
