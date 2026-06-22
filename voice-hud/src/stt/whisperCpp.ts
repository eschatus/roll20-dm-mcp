// Native whisper.cpp STT engine (behind DMW_STT_ENGINE=whispercpp).
//
// Spawns the official PREBUILT whisper.cpp binary (whisper-cli) — no node-gyp, no
// native addon, no electron-rebuild, no C++ toolchain on the build box OR the end
// user's. It reads the gem's 16 kHz/mono/16-bit WAV directly (whisper.cpp decodes
// WAV itself), so there's no PCM/ffmpeg step either. Same SttEngine contract as
// FasterWhisperEngine, so main.ts is untouched; the factory (index.ts) picks it and
// falls back to the Python engine if the binary/model is missing.
//
// GPU is just a different prebuilt binary (CPU vs cuBLAS vs Vulkan) — point
// whisperBin at it; the spawn args are identical. Resident latency upgrade later:
// whisper-server.exe keeps the model loaded (this one-shot reloads per clip).
// See docs/whispercpp-spike.md.
import { EventEmitter } from "events";
import { execFile } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { SttEngine, TranscriptResult } from "./engine";

export interface WhisperCppOpts { binPath: string; modelPath: string; threads?: number }

export class WhisperCppEngine extends EventEmitter implements SttEngine {
  readonly name: string;
  constructor(private opts: WhisperCppOpts) {
    super();
    this.name = `whisper.cpp:${path.basename(opts.modelPath)}`;
  }

  async start(): Promise<void> {
    if (!fs.existsSync(this.opts.binPath)) {
      throw new Error(`whisper.cpp binary not found: ${this.opts.binPath} — download a release build (see docs/whispercpp-spike.md)`);
    }
    if (!fs.existsSync(this.opts.modelPath)) {
      throw new Error(`whisper.cpp model not found: ${this.opts.modelPath} — download a ggml .bin (see docs/whispercpp-spike.md)`);
    }
    // No resident process to load (one-shot CLI); just confirm the toolchain is present.
    this.emit("ready", { model: this.opts.modelPath, bin: this.opts.binPath });
  }

  transcribe(wavPath: string, initialPrompt?: string): Promise<TranscriptResult> {
    const outPrefix = wavPath.replace(/\.wav$/i, "") + ".out";
    const jsonPath = outPrefix + ".json";
    const args = buildWhisperArgs(this.opts, wavPath, outPrefix, initialPrompt);
    const t0 = Date.now();
    return new Promise<TranscriptResult>((resolve, reject) => {
      execFile(this.opts.binPath, args, { windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, _stdout, stderr) => {
        if (err) {
          fs.promises.unlink(jsonPath).catch(() => {});
          this.emit("log", `whisper-cli failed: ${stderr || err.message}`);
          return reject(new Error(`whisper-cli exited with error: ${stderr || err.message}`));
        }
        let json: string;
        try {
          json = fs.readFileSync(jsonPath, "utf-8");
        } catch {
          return reject(new Error("whisper-cli produced no JSON output"));
        }
        fs.promises.unlink(jsonPath).catch(() => {});
        const parsed = parseWhisperJson(json);
        resolve({ ...parsed, duration: (Date.now() - t0) / 1000 });
      });
    });
  }

  stop(): void { /* one-shot CLI — nothing resident to tear down */ }
}

// Build the whisper-cli argument vector. Pure/exported for unit tests.
//  -ojf → JSON with per-token probabilities (for the confidence estimate)
//  -of  → output file prefix (writes <prefix>.json)
//  -np  → suppress everything but the result
export function buildWhisperArgs(opts: WhisperCppOpts, wavPath: string, outPrefix: string, prompt?: string): string[] {
  const args = ["-m", opts.modelPath, "-f", wavPath, "-l", "en", "-np", "-ojf", "-of", outPrefix, "-t", String(opts.threads ?? 4)];
  if (prompt && prompt.trim()) args.push("--prompt", prompt);
  return args;
}

interface WhisperJsonToken { text?: string; p?: number }
interface WhisperJsonSegment { text?: string; tokens?: WhisperJsonToken[] }
interface WhisperJson { transcription?: WhisperJsonSegment[]; result?: { language?: string } }

// Parse whisper.cpp -ojf output → text + a best-effort low_confidence flag from the
// mean per-token probability. Pure/exported for unit tests.
export function parseWhisperJson(json: string): Omit<TranscriptResult, "duration"> {
  const data = JSON.parse(json) as WhisperJson;
  const segments = data.transcription ?? [];
  const text = segments.map((s) => s.text ?? "").join("").trim();
  const probs = segments.flatMap((s) => (s.tokens ?? []).map((t) => t.p)).filter((p): p is number => typeof p === "number");
  const avgP = probs.length ? probs.reduce((a, b) => a + b, 0) / probs.length : 1;
  return {
    text,
    avg_logprob: Math.log(Math.min(Math.max(avgP, 1e-6), 1)),
    no_speech_prob: 0,
    low_confidence: text.length > 0 && avgP < 0.5,
    language: data.result?.language ?? "en",
  };
}
