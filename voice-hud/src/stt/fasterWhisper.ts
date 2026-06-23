// faster-whisper engine — drives the Python sidecar (whisper_server.py). The same
// class serves any model size / compute type, so falling back to a smaller/cheaper
// model is just different constructor args (no new code).

import { spawn, ChildProcessWithoutNullStreams } from "child_process";
import * as readline from "readline";
import { EventEmitter } from "events";
import { SttEngine, TranscriptResult } from "./engine";
import { killAndWait } from "../procUtil";

export interface FasterWhisperOpts {
  python: string;
  script: string;
  model: string;       // e.g. "large-v3-turbo", "medium", "small"
  device: string;      // "cuda" | "cpu"
  computeType: string; // "float16" | "int8" | "int8_float16"
}

export class FasterWhisperEngine extends EventEmitter implements SttEngine {
  readonly name: string;
  private proc: ChildProcessWithoutNullStreams | null = null;
  private ready = false;
  private reqId = 0;
  private pending = new Map<string, { resolve: (r: TranscriptResult) => void; reject: (e: Error) => void }>();

  constructor(private opts: FasterWhisperOpts) {
    super();
    this.name = `faster-whisper:${opts.model}/${opts.computeType}`;
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const { python, script, model, device, computeType } = this.opts;
      this.proc = spawn(python, [
        script, "--model", model, "--device", device, "--compute-type", computeType,
      ], { windowsHide: true });

      const rl = readline.createInterface({ input: this.proc.stdout });
      rl.on("line", (line) => this.onLine(line, resolve));
      this.proc.stderr.on("data", (d) => this.emit("log", String(d)));
      this.proc.on("exit", (code) => {
        this.ready = false;
        this.emit("exit", code);
        for (const p of this.pending.values()) p.reject(new Error("whisper sidecar exited"));
        this.pending.clear();
      });
      this.proc.on("error", reject);

      setTimeout(() => { if (!this.ready) reject(new Error("whisper sidecar did not become ready in 120s")); }, 120_000);
    });
  }

  private onLine(line: string, onReady: () => void) {
    let msg: { fatal?: string; ready?: boolean; id?: string | number; error?: string } & Partial<TranscriptResult>;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.fatal) { this.emit("log", "FATAL: " + msg.fatal); return; }
    if (msg.ready) { this.ready = true; this.emit("ready", msg); onReady(); return; }
    if (msg.id != null) {
      const p = this.pending.get(String(msg.id));
      if (!p) return;
      this.pending.delete(String(msg.id));
      if (msg.error) p.reject(new Error(msg.error));
      else p.resolve(msg as TranscriptResult);
    }
  }

  transcribe(wavPath: string, initialPrompt?: string): Promise<TranscriptResult> {
    if (!this.proc || !this.ready) return Promise.reject(new Error("whisper sidecar not ready"));
    const id = String(++this.reqId);
    const req = JSON.stringify({ id, wav: wavPath, initial_prompt: initialPrompt || "" });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.proc!.stdin.write(req + "\n");
    });
  }

  async stop(): Promise<void> {
    const proc = this.proc;
    this.proc = null;
    this.ready = false;
    await killAndWait(proc);
  }
}
