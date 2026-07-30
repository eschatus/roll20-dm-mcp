// Pre-turn board snapshot (Gate-2 #5) — a COMPACT read of the live table taken
// right before the agentic loop runs, so a mined (utterance -> tool_calls) pair
// can be replayed/graded against the board state it actually started from.
//
// I/O lives here (three mcp.call reads); kept separate from toolEvents.ts
// (pure shaping) so this half is testable with a fake Roll20McpLike — no
// fs/Electron involved — including the "soft fail" contract: a throwing
// client must reject so the caller (main.ts) can catch it and continue the
// turn rather than let a snapshot error break a live turn.

import type { Roll20McpLike } from "./agent";

export interface SnapshotToken {
  id: string;
  name?: string;
  controlledby?: string;
  hp?: unknown;
  statusmarkers?: string;
  layer?: string;
}

export interface Board {
  tokens: SnapshotToken[];
  turnOrder: unknown;
  zones: unknown;
}

function safeJson<T>(raw: string, fallback: T): T {
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

/** Shrink one raw token object (whatever shape list_tokens returns) down to
 *  the fields Gate-2 needs for replay: id/name/controlledby/hp/statusmarkers/layer. */
function compactToken(t: Record<string, unknown>): SnapshotToken {
  return {
    id: String(t.id ?? t._id ?? t.tokenId ?? ""),
    name: typeof t.name === "string" ? t.name : undefined,
    controlledby: typeof t.controlledby === "string" ? t.controlledby : undefined,
    hp: t.hp ?? t.bar1_value ?? t.bar1 ?? undefined,
    statusmarkers: typeof t.statusmarkers === "string" ? t.statusmarkers : undefined,
    layer: typeof t.layer === "string" ? t.layer : undefined,
  };
}

/**
 * Read tokens + turn order + zones off the already-connected MCP client and
 * shrink them to a compact, replayable board. Callers MUST wrap this in their
 * own try/catch (see main.ts's runAgent) — it makes no attempt to swallow its
 * own errors, so a transport hiccup surfaces to the caller rather than
 * silently returning an empty/misleading board.
 */
export async function captureBoardSnapshot(mcp: Roll20McpLike): Promise<Board> {
  const [tokensRaw, turnOrderRaw, zonesRaw] = await Promise.all([
    mcp.call("list_tokens", {}),
    mcp.call("get_turn_order", {}),
    mcp.call("list_zones", {}),
  ]);
  const tokensFull = safeJson<Array<Record<string, unknown>>>(tokensRaw, []);
  const tokens = Array.isArray(tokensFull) ? tokensFull.map(compactToken) : [];
  return {
    tokens,
    turnOrder: safeJson(turnOrderRaw, []),
    zones: safeJson(zonesRaw, []),
  };
}
