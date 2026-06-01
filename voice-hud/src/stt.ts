// Whisper sidecar manager. Spawns whisper_server.py once (model stays resident),
// then exposes transcribe(wavPath, initialPrompt) over its newline-JSON protocol.

import { spawn, ChildProcessWithoutNullStreams } from "child_process";
import * as readline from "readline";
import { EventEmitter } from "events";
import { CONFIG } from "./config";

export interface TranscriptResult {
  text: string;
  avg_logprob: number;
  no_speech_prob: number;
  low_confidence: boolean;
  language: string;
  duration: number;
}

export class WhisperSidecar extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private ready = false;
  private reqId = 0;
  private pending = new Map<string, { resolve: (r: TranscriptResult) => void; reject: (e: Error) => void }>();

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const { python, script, model, device, computeType } = CONFIG.stt;
      this.proc = spawn(python, [
        script,
        "--model", model,
        "--device", device,
        "--compute-type", computeType,
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

      // Cold start can take ~20s (download) — generous timeout.
      setTimeout(() => { if (!this.ready) reject(new Error("whisper sidecar did not become ready in 120s")); }, 120_000);
    });
  }

  private onLine(line: string, onReady: () => void) {
    let msg: any;
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

  stop() {
    this.proc?.kill();
    this.proc = null;
    this.ready = false;
  }
}
