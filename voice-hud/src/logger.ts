// Structured logging + timing for the HUD, split into THREE durable channels so the
// post-hoc review of one concern isn't buried under the others' noise:
//
//   conversation → data/hud.log     — the agent turn: PTT, [agent] say/tool/result,
//                                      phase, [aar], [inbox], [roster], [anthropic].
//                                      (The AAR reads hud.log, so this channel keeps that name.)
//   whisper      → data/whisper.log  — STT speed + correction: [stt], [correct], [ab-clip],
//                                      [whisper]/[whisper-server] runtime lines.
//   system       → data/system.log   — startup/shutdown/connection + any unclassified
//                                      console noise: [mcp], [events], Electron warnings, etc.
//
// Every event still goes three places: its channel file (survives the detached launch where
// stderr is lost), console.error (live terminals), and a renderer sink (the gem Debug panel).
// Each channel file rotates independently at MAX_BYTES, so high-volume whisper timings can't
// evict conversational history.

import * as fs from "fs";
import * as path from "path";

// Self-contained data dir (same default as the HUD config) so the logger has no import
// dependencies beyond fs/path — drop-in regardless of the config module's shape.
const DATA_DIR = process.env.DMW_DATA_DIR || path.join(__dirname, "..", "data");

// Capture the ORIGINAL console.error at import time. main.ts later monkeypatches console.error to
// fan out to the renderer panel, so log() must use the original — otherwise logging through log()
// would recurse back into that shim. (logger is imported before the shim is installed.)
const _consoleError: (...a: unknown[]) => void =
  typeof console !== "undefined" && console.error ? console.error.bind(console) : () => {};

export type LogLevel = "info" | "warn" | "error" | "perf";
export type LogChannel = "conversation" | "whisper" | "system";

export interface LogEvent {
  ts: number;            // epoch ms
  level: LogLevel;
  kind: string;          // "stt" | "llm" | "tool" | "turn" | "agent" | "mcp" | "system" | "campaign" | ...
  msg: string;           // short label
  ms?: number;           // duration, for perf events
  detail?: string;       // optional payload (args/result/error), shown expandable in the panel
  channel?: LogChannel;  // explicit channel; otherwise derived from `kind`
}

const CHANNEL_FILE: Record<LogChannel, string> = {
  conversation: "hud.log",
  whisper: "whisper.log",
  system: "system.log",
};

/** Map a structured `kind` to a channel (for callers of log()/persist() that omit `channel`). */
export function channelForKind(kind: string): LogChannel {
  switch (kind) {
    case "stt": case "whisper": case "correct": case "ab-clip":
      return "whisper";
    case "mcp": case "events": case "system": case "supervisor": case "boot":
      return "system";
    default:
      return "conversation";
  }
}

// Console messages are tagged with a `[prefix]` (e.g. "[agent] say: …"). Classify by that prefix
// into a (channel, kind) so the catch-all console.error shim routes each line to the right file.
// Unrecognized lines → system (boot/shutdown/Electron warnings), keeping conversation clean.
const CONSOLE_PREFIX: Record<string, { channel: LogChannel; kind: string }> = {
  ptt:               { channel: "conversation", kind: "ptt" },
  agent:             { channel: "conversation", kind: "agent" },
  aar:               { channel: "conversation", kind: "aar" },
  inbox:             { channel: "conversation", kind: "inbox" },
  roster:            { channel: "conversation", kind: "roster" },
  anthropic:         { channel: "conversation", kind: "llm" },
  stt:               { channel: "whisper",      kind: "stt" },
  correct:           { channel: "whisper",      kind: "stt" },
  "ab-clip":         { channel: "whisper",      kind: "stt" },
  whisper:           { channel: "whisper",      kind: "stt" },
  "whisper-server":  { channel: "whisper",      kind: "stt" },
  mcp:               { channel: "system",       kind: "mcp" },
  events:            { channel: "system",       kind: "events" },
};

export function classifyConsole(text: string): { channel: LogChannel; kind: string } {
  const m = /^\[([\w-]+)\]/.exec(text);
  return (m && CONSOLE_PREFIX[m[1]]) || { channel: "system", kind: "console" };
}

type Sink = (e: LogEvent) => void;
let _sink: Sink | null = null;

/** main.ts wires this to forward events into the renderer's Debug panel. */
export function setLogSink(fn: Sink | null): void { _sink = fn; }

const MAX_BYTES = 5 * 1024 * 1024;
const _streams: Partial<Record<LogChannel, fs.WriteStream | null>> = {};

function logPath(channel: LogChannel): string { return path.join(DATA_DIR, CHANNEL_FILE[channel]); }

function ensureStream(channel: LogChannel): fs.WriteStream | null {
  const existing = _streams[channel];
  if (existing) return existing;
  let stream: fs.WriteStream | null = null;
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const p = logPath(channel);
    // Size-based rotation: keep one previous file per channel.
    try {
      const st = fs.statSync(p);
      if (st.size > MAX_BYTES) fs.renameSync(p, p + ".1");
    } catch { /* no existing log — fine */ }
    stream = fs.createWriteStream(p, { flags: "a" });
  } catch { stream = null; }
  _streams[channel] = stream;
  return stream;
}

function resolveChannel(e: Pick<LogEvent, "kind" | "channel">): LogChannel {
  return e.channel ?? channelForKind(e.kind);
}

function build(e: Omit<LogEvent, "ts"> & { ts?: number }): LogEvent {
  const channel = resolveChannel(e);
  return {
    ts: e.ts ?? Date.now(),
    level: e.level,
    kind: e.kind,
    msg: e.msg,
    channel,
    ...(e.ms != null ? { ms: e.ms } : {}),
    ...(e.detail != null ? { detail: e.detail } : {}),
  };
}

export function log(e: Omit<LogEvent, "ts"> & { ts?: number }): void {
  const ev = build(e);

  // 1. file (the resolved channel)
  try { ensureStream(ev.channel!)?.write(JSON.stringify(ev) + "\n"); } catch { /* ignore */ }

  // 2. console (kept for live terminals; perf events show the ms inline). Uses the ORIGINAL
  // console.error so it doesn't recurse through main.ts's console shim.
  const head = ev.ms != null ? `${ev.kind} ${ev.ms}ms` : ev.kind;
  const tail = ev.detail ? " :: " + ev.detail.slice(0, 100) : "";
  _consoleError(`[${head}] ${ev.msg}${tail}`);

  // 3. renderer (Debug panel)
  if (_sink) { try { _sink(ev); } catch { /* renderer gone */ } }
}

/**
 * File-only write (no console, no sink) — for a caller that already handles console + panel itself
 * (e.g. main.ts's console.error shim), so its messages still land durably in the right channel file.
 */
export function persist(e: Omit<LogEvent, "ts"> & { ts?: number }): void {
  const ev = build(e);
  try { ensureStream(ev.channel!)?.write(JSON.stringify(ev) + "\n"); } catch { /* ignore */ }
}

/** start()/stop() timer helper: const done = timer(); ...; const ms = done(); */
export function timer(): () => number {
  const t0 = Date.now();
  return () => Date.now() - t0;
}

/** Read the tail of a channel's log file (for a "copy log" / panel backfill). Defaults to the
 *  conversation channel (data/hud.log) — the one a human reviews after a session. */
export function readLogTail(maxBytes = 200_000, channel: LogChannel = "conversation"): string {
  try {
    const buf = fs.readFileSync(logPath(channel));
    return buf.length > maxBytes ? buf.subarray(buf.length - maxBytes).toString("utf-8") : buf.toString("utf-8");
  } catch { return ""; }
}

// ---------------------------------------------------------------------------
// Gate-2 session instrumentation: events.jsonl — structured, full-fidelity
// records (tool calls, loop-control tags, pre-turn board snapshots), kept in a
// FOURTH file deliberately separate from the three channels above so mining
// replayable (utterance -> tool_calls -> board effect) training data never
// disturbs hud.log/whisper.log/system.log or their existing parsers (aar.ts,
// gate0.ts). See src/toolEvents.ts / src/snapshot.ts for the shaping logic;
// this module only owns the file + rotation.
//
// Rotation differs deliberately from the three channels above: those keep only
// ONE previous generation (`.1`, overwritten every rotation) because they're
// read live for the current/last session. events.jsonl accumulates the corpus
// this whole project exists to grow, so overwriting `.1` would be silent data
// loss — instead we keep NUMBERED generations (.1 newest .. .5 oldest, default
// EVENTS_KEEP) and only drop the oldest once that many have piled up.
const EVENTS_FILE = "events.jsonl";
const EVENTS_MAX_BYTES = 5 * 1024 * 1024;
const EVENTS_KEEP = 5;

function eventsPath(): string { return path.join(DATA_DIR, EVENTS_FILE); }

function rotateNumbered(p: string, keep: number): void {
  try { fs.unlinkSync(`${p}.${keep}`); } catch { /* nothing that old yet */ }
  for (let i = keep - 1; i >= 1; i--) {
    try { fs.renameSync(`${p}.${i}`, `${p}.${i + 1}`); } catch { /* gap in the sequence — fine */ }
  }
  try { fs.renameSync(p, `${p}.1`); } catch { /* first rotation ever */ }
}

// Synchronous append (unlike the streamed hud.log/whisper.log/system.log
// channels above): each write is one bounded record per tool call/loop-tag/
// snapshot — not a hot path — and a mining/replay corpus needs every write to
// have actually landed before the process can be assumed to hold it, with no
// buffered-stream race to reason about (a crash mid-session must not lose the
// last few records any more than it already risks losing the last write).
function appendEvent(rec: Record<string, unknown>): void {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const p = eventsPath();
    try {
      const st = fs.statSync(p);
      if (st.size > EVENTS_MAX_BYTES) rotateNumbered(p, EVENTS_KEEP);
    } catch { /* no existing file — fine */ }
    fs.appendFileSync(p, JSON.stringify(rec) + "\n");
  } catch { /* ignore — logEvent() must never throw into a live turn */ }
}

/** A Gate-2 structured record: an open shape (kind discriminates "tool" | "loop" |
 *  "snapshot") since each carries different fields — see toolEvents.ts for the
 *  concrete builders. `ts` is filled in here if the caller omits it. */
export interface StructuredEvent {
  ts?: number;
  kind: string;
  turnId: string;
  [k: string]: unknown;
}

/**
 * Append one Gate-2 structured record to events.jsonl. This is the "real call
 * site" logger.ts's log()/persist() were missing for session instrumentation —
 * kept as its own function (rather than overloading log()'s fixed LogEvent
 * shape) because these records are inherently open-ended (full tool args, a
 * board snapshot) and must NEVER be truncated the way the console/hud.log path
 * truncates `detail`. Fails soft: a write error here must never break a live turn.
 */
export function logEvent(e: StructuredEvent): void {
  const rec = { ts: e.ts ?? Date.now(), ...e };
  appendEvent(rec);
  // Short breadcrumb on the ORIGINAL console (bypasses main.ts's shim — same
  // reasoning as log()'s _consoleError use above) so a live terminal still shows
  // that instrumentation is flowing, without duplicating the full record.
  try { _consoleError(`[events] ${rec.kind} turn=${String(rec.turnId).slice(0, 8)}`); } catch { /* ignore */ }
}
