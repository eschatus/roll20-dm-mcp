// whisper-server.exe resident engine (behind DMW_STT_ENGINE=whisperserver).
//
// Spawns whisper-server.exe once — the model stays resident in GPU/CPU memory across
// all transcribe() calls. Each call POSTs the WAV file to the /inference endpoint as a
// multipart/form-data body and parses the JSON response. This removes the per-clip model
// reload that makes the one-shot whisper-cli slow (~1200 ms on base.en/CPU) and should
// bring whisper.cpp closer to the faster-whisper resident latency.
//
// Server flags used:
//   -m <model>         ggml model path
//   --host 127.0.0.1   listen on loopback only
//   --port <port>      HTTP port (default 18080 — avoids collisions with common 8080)
//   -t <threads>       CPU threads
//   --inference-path /inference  (the default; documented here for clarity)
//
// Inference endpoint: POST http://127.0.0.1:<port>/inference
//   Content-Type: multipart/form-data
//   Fields:
//     file              – the WAV file bytes (field name "file")
//     response_format   – "verbose_json" (includes language + per-segment data)
//     prompt            – initial prompt string (optional)
//
// Response (verbose_json):
//   { text: string, segments: [...], language: string }
//
// No new deps — uses Node's built-in `http` and `child_process` modules only.
// Hand-built multipart body to avoid any npm dependency on `form-data` etc.

import { EventEmitter } from "events";
import * as fs from "fs";
import * as path from "path";
import * as http from "http";
import * as os from "os";
import { spawn, ChildProcess } from "child_process";

// CPU threads for whisper-server. The old hardcoded 4 left most of the CPU idle (and made the
// CPU build's medium.en crawl + queue). Default to most cores; override with DMW_WHISPER_THREADS.
// (Ignored by GPU builds, which do inference on the device.)
function defaultThreads(): number {
  const env = Number(process.env.DMW_WHISPER_THREADS);
  if (env > 0) return env;
  return Math.max(4, ((os.cpus() || []).length || 8) - 2);
}
import { SttEngine, TranscriptResult } from "./engine";

export interface WhisperServerOpts {
  binPath: string;
  modelPath: string;
  host?: string;
  port?: number;
  threads?: number;
}

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 18080;

export class WhisperServerEngine extends EventEmitter implements SttEngine {
  readonly name: string;
  private proc: ChildProcess | null = null;
  private host: string;
  private port: number;

  constructor(private opts: WhisperServerOpts) {
    super();
    this.host = opts.host ?? DEFAULT_HOST;
    this.port = opts.port ?? DEFAULT_PORT;
    this.name = `whisper-server:${path.basename(opts.modelPath)}`;
  }

  async start(): Promise<void> {
    if (!fs.existsSync(this.opts.binPath)) {
      throw new Error(`whisper-server binary not found: ${this.opts.binPath}`);
    }
    if (!fs.existsSync(this.opts.modelPath)) {
      throw new Error(`whisper-server model not found: ${this.opts.modelPath}`);
    }

    const args = [
      "-m", this.opts.modelPath,
      "--host", this.host,
      "--port", String(this.port),
      "-t", String(this.opts.threads ?? defaultThreads()),
      "-l", "en",
    ];

    this.emit("log", `[whisper-server] spawning: ${this.opts.binPath} ${args.join(" ")}\n`);

    this.proc = spawn(this.opts.binPath, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    this.proc.stdout?.on("data", (d: Buffer) => this.emit("log", d.toString()));
    this.proc.stderr?.on("data", (d: Buffer) => this.emit("log", d.toString()));
    this.proc.on("exit", (code, signal) => {
      this.emit("log", `[whisper-server] exited code=${code} signal=${signal}\n`);
      this.emit("exit", code);
      this.proc = null;
    });

    // Wait for the server to be ready by polling the port.
    await this.waitReady();
    this.emit("ready", { model: this.opts.modelPath, port: this.port });
  }

  /** Poll http://host:port/inference with a tiny HEAD-like check until it responds. */
  private waitReady(timeoutMs = 15000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    return new Promise<void>((resolve, reject) => {
      const probe = () => {
        if (Date.now() > deadline) {
          return reject(new Error(`whisper-server did not become ready within ${timeoutMs}ms on port ${this.port}`));
        }
        // Simple TCP connection check via a GET to / — server returns 404 or 200, both
        // mean it's listening; we just need a non-ECONNREFUSED.
        const req = http.request(
          { host: this.host, port: this.port, path: "/", method: "GET", timeout: 1000 },
          () => resolve(),
        );
        req.on("error", (e: NodeJS.ErrnoException) => {
          if (e.code === "ECONNREFUSED" || e.code === "ECONNRESET") {
            setTimeout(probe, 200);
          } else {
            // Any response at all (even error pages) means the server is up.
            resolve();
          }
        });
        req.on("timeout", () => { req.destroy(); setTimeout(probe, 200); });
        req.end();
      };
      probe();
    });
  }

  transcribe(wavPath: string, initialPrompt?: string): Promise<TranscriptResult> {
    const t0 = Date.now();
    return new Promise<TranscriptResult>((resolve, reject) => {
      if (!this.proc) {
        return reject(new Error("whisper-server is not running — call start() first"));
      }

      const fileData = fs.readFileSync(wavPath);
      const fileName = path.basename(wavPath);

      // Build multipart/form-data body manually (no npm deps).
      const boundary = `----WhisperBoundary${Date.now()}`;
      const parts: Buffer[] = [];

      const addField = (name: string, value: string) => {
        parts.push(Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`
        ));
      };

      addField("response_format", "verbose_json");
      if (initialPrompt && initialPrompt.trim()) {
        addField("prompt", initialPrompt.trim());
      }

      // File field
      parts.push(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: audio/wav\r\n\r\n`
      ));
      parts.push(fileData);
      parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

      const body = Buffer.concat(parts);

      const options: http.RequestOptions = {
        host: this.host,
        port: this.port,
        path: "/inference",
        method: "POST",
        headers: {
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          "Content-Length": body.length,
        },
        timeout: 30000,
      };

      const req = http.request(options, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf-8");
          const elapsed = (Date.now() - t0) / 1000;
          if (res.statusCode !== 200) {
            return reject(new Error(`whisper-server returned HTTP ${res.statusCode}: ${raw.slice(0, 200)}`));
          }
          try {
            const result = parseServerResponse(raw, elapsed);
            resolve(result);
          } catch (e) {
            reject(new Error(`whisper-server response parse error: ${(e as Error).message} — body: ${raw.slice(0, 300)}`));
          }
        });
      });

      req.on("error", (e) => reject(new Error(`whisper-server request error: ${e.message}`)));
      req.on("timeout", () => { req.destroy(); reject(new Error("whisper-server request timed out")); });

      req.write(body);
      req.end();
    });
  }

  stop(): void {
    if (this.proc) {
      this.proc.kill("SIGTERM");
      this.proc = null;
    }
  }
}

// ── Response parsing ──────────────────────────────────────────────────────────

interface ServerSegment {
  text?: string;
  tokens?: Array<{ p?: number; text?: string }>;
}
interface ServerVerboseJson {
  text?: string;
  language?: string;
  segments?: ServerSegment[];
}

function parseServerResponse(json: string, duration: number): TranscriptResult {
  const data = JSON.parse(json) as ServerVerboseJson;

  // verbose_json includes top-level "text", "language", and "segments" array.
  const text = (data.text ?? "").trim();
  const language = data.language ?? "en";

  // Compute mean token probability from segments for a confidence estimate.
  const probs = (data.segments ?? [])
    .flatMap((s) => (s.tokens ?? []).map((t) => t.p))
    .filter((p): p is number => typeof p === "number");

  const avgP = probs.length ? probs.reduce((a, b) => a + b, 0) / probs.length : 1;

  return {
    text,
    avg_logprob: Math.log(Math.min(Math.max(avgP, 1e-6), 1)),
    no_speech_prob: 0,
    low_confidence: text.length > 0 && avgP < 0.5,
    language,
    duration,
  };
}
