// Structured logging + timing for the HUD. Every event goes three places:
//   1. a rotating file (data/hud.log) — survives the detached launch (stderr is lost),
//   2. console.error — unchanged, for anyone watching a live terminal,
//   3. a renderer sink — streamed into the gem's Debug panel.
//
// This is the answer to "the timings go to lost stderr": now they're durable + on-screen.

import * as fs from "fs";
import * as path from "path";

// Self-contained data dir (same default as the HUD config) so the logger has no import
// dependencies beyond fs/path — drop-in regardless of the config module's shape.
const DATA_DIR = process.env.DMW_DATA_DIR || path.join(__dirname, "..", "data");

export type LogLevel = "info" | "warn" | "error" | "perf";

export interface LogEvent {
  ts: number;        // epoch ms
  level: LogLevel;
  kind: string;      // "stt" | "llm" | "tool" | "turn" | "agent" | "mcp" | "system" | "campaign" | ...
  msg: string;       // short label
  ms?: number;       // duration, for perf events
  detail?: string;   // optional payload (args/result/error), shown expandable in the panel
}

type Sink = (e: LogEvent) => void;
let _sink: Sink | null = null;

/** main.ts wires this to forward events into the renderer's Debug panel. */
export function setLogSink(fn: Sink | null): void { _sink = fn; }

const LOG_PATH = () => path.join(DATA_DIR, "hud.log");
const MAX_BYTES = 5 * 1024 * 1024;
let _stream: fs.WriteStream | null = null;

function ensureStream(): fs.WriteStream | null {
  if (_stream) return _stream;
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    // Size-based rotation: keep one previous file.
    try {
      const st = fs.statSync(LOG_PATH());
      if (st.size > MAX_BYTES) fs.renameSync(LOG_PATH(), LOG_PATH() + ".1");
    } catch { /* no existing log — fine */ }
    _stream = fs.createWriteStream(LOG_PATH(), { flags: "a" });
  } catch { _stream = null; }
  return _stream;
}

export function log(e: Omit<LogEvent, "ts"> & { ts?: number }): void {
  const ev: LogEvent = {
    ts: e.ts ?? Date.now(),
    level: e.level,
    kind: e.kind,
    msg: e.msg,
    ...(e.ms != null ? { ms: e.ms } : {}),
    ...(e.detail != null ? { detail: e.detail } : {}),
  };

  // 1. file
  try { ensureStream()?.write(JSON.stringify(ev) + "\n"); } catch { /* ignore */ }

  // 2. console (kept for live terminals; perf events show the ms inline)
  const head = ev.ms != null ? `${ev.kind} ${ev.ms}ms` : ev.kind;
  const tail = ev.detail ? " :: " + ev.detail.slice(0, 100) : "";
  console.error(`[${head}] ${ev.msg}${tail}`);

  // 3. renderer (Debug panel)
  if (_sink) { try { _sink(ev); } catch { /* renderer gone */ } }
}

/** start()/stop() timer helper: const done = timer(); ...; const ms = done(); */
export function timer(): () => number {
  const t0 = Date.now();
  return () => Date.now() - t0;
}

/** Read the tail of the log file (for a "copy log" / panel backfill). */
export function readLogTail(maxBytes = 200_000): string {
  try {
    const buf = fs.readFileSync(LOG_PATH());
    return buf.length > maxBytes ? buf.subarray(buf.length - maxBytes).toString("utf-8") : buf.toString("utf-8");
  } catch { return ""; }
}
