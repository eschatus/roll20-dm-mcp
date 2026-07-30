// Gate-2 session instrumentation — pure shaping/decision logic for structured,
// replayable turn events. No fs/Electron here (that's logger.ts's events.jsonl
// sink) so all of this is independently unit-testable.
//
// Why this exists: mining 329 historical turns out of hud.log yielded only 110
// usable (utterance -> tool_calls) pairs, because args were truncated at 77
// chars and results at 60, failures were logged as successes ("tool ✓"
// unconditionally), the ↻persist/↑escalate loop-control tags masqueraded as
// tool calls (inflating tool counts), and there was no pre-turn board state, so
// nothing was replayable or gradeable. This module fixes all four, plus adds
// the single highest-value label in the corpus: repairOf linkage — a repair
// chain's FINAL turn is DM-accepted ground truth; the mid-chain ones are
// labeled negatives.
//
// main.ts wires these into the live onToolStart/onToolResult callbacks and the
// per-turn lifecycle; the prose lines (hud.log) are untouched so aar.ts/gate0.ts
// keep working unchanged.

import { logEvent } from "./logger";

// ---------------------------------------------------------------------------
// Success/failure detection (Gate-2 #2 — the success/failure lie)
// ---------------------------------------------------------------------------

// gate0.ts's own miner documents this exact heuristic (errors are detected by
// result TEXT, never the "tool ✓" glyph) — this is that detector, promoted from
// a one-off mining regex into the thing the LIVE agent uses to log truthfully.
const MCP_ERROR_RE = /\bMCP error -?\d+/i;

/** Did this tool result represent a failure? `isErrorFlag` lets a caller with
 *  access to the raw MCP CallToolResult.isError pass it straight through;
 *  otherwise (the common case — McpRoll20.call() already flattens to text)
 *  fall back to the text heuristic every MCP-error response carries. */
export function isToolError(resultText: string, isErrorFlag?: boolean): boolean {
  if (isErrorFlag) return true;
  return MCP_ERROR_RE.test(resultText);
}

/** The prose glyph for a tool result — ✓ on success, ✗ on failure (replacing
 *  the unconditional "tool ✓" the live agent used to log regardless of
 *  outcome). aar.ts's tool-error regex already accepts both glyphs. */
export function resultGlyph(resultText: string, isErrorFlag?: boolean): "✓" | "✗" {
  return isToolError(resultText, isErrorFlag) ? "✗" : "✓";
}

// ---------------------------------------------------------------------------
// Structured tool events (Gate-2 #1)
// ---------------------------------------------------------------------------

const MAX_ARGS_BYTES = 8 * 1024;
const RESULT_PREVIEW_CHARS = 500;
const ERROR_PREVIEW_CHARS = 300;

export interface ToolEventInput {
  turnId: string;
  seq: number;
  tool: string;
  args: unknown;
  ok: boolean;
  durMs: number;
  resultText: string;
  /** Set when this turn is a repair of a previous FAILED turn within the
   *  configured window (see isRepairOf below). */
  repairOf?: string;
}

export interface ToolEventRecord {
  ts: number;
  kind: "tool";
  turnId: string;
  seq: number;
  tool: string;
  args: unknown;
  argsTruncated?: true;
  ok: boolean;
  error?: string;
  durMs: number;
  resultPreview: string;
  repairOf?: string;
}

/** Shape one tool call into its full-fidelity record — FULL args (JSON, capped
 *  ~8KB with an explicit argsTruncated flag on overflow, never the 77-char
 *  console truncation), true ok/error, and a bounded result preview. Pure, so
 *  it's testable without touching the filesystem. */
export function buildToolEvent(e: ToolEventInput): ToolEventRecord {
  let args: unknown = e.args ?? {};
  let argsTruncated: true | undefined;
  try {
    const s = JSON.stringify(args);
    if (s.length > MAX_ARGS_BYTES) {
      args = s.slice(0, MAX_ARGS_BYTES);
      argsTruncated = true;
    }
  } catch {
    args = String(e.args);
    argsTruncated = true;
  }
  const rec: ToolEventRecord = {
    ts: Date.now(),
    kind: "tool",
    turnId: e.turnId,
    seq: e.seq,
    tool: e.tool,
    args,
    ok: e.ok,
    durMs: e.durMs,
    resultPreview: e.resultText.slice(0, RESULT_PREVIEW_CHARS),
  };
  if (argsTruncated) rec.argsTruncated = true;
  if (!e.ok) rec.error = e.resultText.slice(0, ERROR_PREVIEW_CHARS);
  if (e.repairOf) rec.repairOf = e.repairOf;
  return rec;
}

/** Build + append a structured tool event to events.jsonl. */
export function emitToolEvent(e: ToolEventInput): void {
  // ToolEventRecord is a closed interface (for callers' precise typing); logger's
  // StructuredEvent is intentionally open ([k: string]: unknown) so every event
  // kind can share one sink. The cast bridges those two shapes at the one seam.
  logEvent(buildToolEvent(e) as unknown as Parameters<typeof logEvent>[0]);
}

// ---------------------------------------------------------------------------
// Loop-control tags (Gate-2 #3 — stop masquerading as tools)
// ---------------------------------------------------------------------------

export type LoopTag = "persist" | "complete" | "escalate";

/** agent.ts emits `↻persist` / `↻complete` (loop-policy re-prompts) and
 *  `↑escalate` (local→cloud escalation) as the tool NAME argument to
 *  cb.onToolResult — the exact "masquerading as a tool call" bug. Recognize
 *  those names here so main.ts can route them to a `kind:"loop"` record
 *  instead of a `kind:"tool"` one. Returns null for anything else (a real tool
 *  name never starts with ↻/↑). */
export function parseLoopTag(name: string): LoopTag | null {
  const m = /^↻(persist|complete)$/.exec(name);
  if (m) return m[1] as LoopTag;
  if (name === "↑escalate") return "escalate";
  return null;
}

export function emitLoopEvent(turnId: string, tag: LoopTag, repairOf?: string): void {
  logEvent({ kind: "loop", turnId, tag, ...(repairOf ? { repairOf } : {}) });
}

// ---------------------------------------------------------------------------
// Pre-turn board snapshot (Gate-2 #5) — event emission only; capture lives in
// snapshot.ts (needs the MCP client, so it isn't "pure").
// ---------------------------------------------------------------------------

export function emitSnapshotEvent(
  turnId: string,
  board: unknown,
  ms: number,
  opts: { error?: string; repairOf?: string } = {},
): void {
  logEvent({
    kind: "snapshot",
    turnId,
    board,
    ms,
    ...(opts.error ? { error: opts.error } : {}),
    ...(opts.repairOf ? { repairOf: opts.repairOf } : {}),
  });
}

// ---------------------------------------------------------------------------
// repairOf linkage (Gate-2 #4) — the single highest-value label in the corpus
// ---------------------------------------------------------------------------

export interface TurnOutcome {
  turnId: string;
  /** Turn end time — the anchor for the "started within N seconds" window
   *  (matches gate0.ts's repairFlags, which anchors off the PRIOR turn's end,
   *  not its start). */
  endTs: number;
  mcpErrorCount: number;
  statesOutcome: boolean;
  mutations: number;
}

/** A turn "failed" for repair-chain purposes: it threw/returned at least one
 *  MCP error, or it stated an outcome yet produced zero mutations (the
 *  Failure-A flake loop-policy.ts's decideTerminal nudges against live — this
 *  is the same test applied post-hoc to whether the nudge actually worked).
 *  Mirrors gate0.ts's `failed()` minus the "capped" case, which is an
 *  historical-log-only concept (a turn that never reached "turn DONE"); a live
 *  turn always resolves one way or another before repairOf is computed. */
export function turnFailed(t: Pick<TurnOutcome, "mcpErrorCount" | "statesOutcome" | "mutations">): boolean {
  return t.mcpErrorCount > 0 || (t.statesOutcome && t.mutations === 0);
}

const DEFAULT_REPAIR_WINDOW_SEC = 45;

/** Does a turn starting at `startTs` count as a repair of `prev`? Only true
 *  when prev FAILED and the gap between prev's end and this turn's start is
 *  within the window (default 45s, configurable — see CONFIG.repairWindowSec). */
export function isRepairOf(prev: TurnOutcome, startTs: number, windowSec = DEFAULT_REPAIR_WINDOW_SEC): boolean {
  return turnFailed(prev) && (startTs - prev.endTs) <= windowSec * 1000;
}
