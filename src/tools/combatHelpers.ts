// Shared helpers for the combat tool suite (registered in combat.ts). Extracted
// so the name→token resolution, char-sheet resolution, turn-order shape, and the
// MCP response boilerplate live in one place instead of being copy-pasted across
// ~25 tool handlers.

import * as registry from "../registry/characters.js";
import * as roll20 from "../bridge/roll20.js";

// ── MCP response builders ─────────────────────────────────────────────────────
// Every tool returns { content: [{ type: "text", text }] }. These two trim the
// boilerplate: text() for a plain string, json() for a JSON.stringify'd value.
type ToolResult = { content: { type: "text"; text: string }[] };

export function text(s: string): ToolResult {
  return { content: [{ type: "text", text: s }] };
}

export function json(value: unknown, pretty = true): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, pretty ? null : undefined, pretty ? 2 : undefined) }] };
}

// ── Turn order ────────────────────────────────────────────────────────────────
// Roll20 turn order entry: {id, pr (string), custom, _pageid}. _pageid is
// required — without it Roll20's tracker shows "no tokens on this stage". The
// optional formula drives the round-marker auto-increment ("+1").
export type TurnEntry = { id: string; pr: string; custom: string; _pageid: string; formula?: string };

// ── Batch results ─────────────────────────────────────────────────────────────
// One entry per op returned by the relay's batchExec action.
export type BatchResult = { id: string | number; ok: boolean; data?: unknown; error?: string };

// Index a (possibly ragged / out-of-order) batchExec response by op id. CRITICAL:
// any id that was sent but is absent from the response is filled in as an explicit
// failure — a short or dropped relay response must NEVER silently read as success.
// (batch_exec itself does NOT use this — it reconciles positionally because its
// op ids are model-supplied and may collide or be absent.)
export function indexBatchResults(
  results: BatchResult[] | null | undefined,
  sentIds: (string | number)[],
): Map<string, BatchResult> {
  const byId = new Map<string, BatchResult>();
  for (const r of results ?? []) byId.set(String(r.id), r);
  for (const id of sentIds) {
    const key = String(id);
    if (!byId.has(key)) byId.set(key, { id, ok: false, error: "no result returned by relay" });
  }
  return byId;
}

// ── Token resolution ──────────────────────────────────────────────────────────

// Cheap existence check against the current page's token list — avoids the 30s
// relay hang when getTokenById is handed a nonexistent/hallucinated id.
export async function tokenIdExists(id: string): Promise<boolean> {
  try {
    const pageId = await roll20.getCurrentPageId();
    const tokens = await roll20.relayCommand<{ id: string }[]>({ action: "getTokens", pageId });
    return tokens.some((t) => t.id === id);
  } catch {
    return false;
  }
}

// Resolve a spoken name to a Roll20 token id. Registered characters win; otherwise
// fuzzy-match against token names on the current page. Returns the matched id, OR
// candidate names when the match is ambiguous/missing so the agent can ask the DM
// "did you mean X / Y?" instead of guessing a fake name. Matching: registry →
// exact → unique substring → else collect the closest candidates.
export async function resolveToken(
  name: string,
  tokenList?: { id: string; name: string }[],
): Promise<{ id?: string; candidates?: string[] }> {
  const entry = registry.lookup(name);
  if (entry?.roll20TokenId) return { id: entry.roll20TokenId };
  try {
    // Caller may pass a pre-fetched token list (batch resolution fetches once).
    const tokens = tokenList ?? await (async () => {
      const pageId = await roll20.getCurrentPageId();
      return roll20.relayCommand<{ id: string; name: string }[]>({ action: "getTokens", pageId });
    })();
    const want = name.trim().toLowerCase();
    const norm = (t: { name?: string }) => (t.name || "").split("\n")[0].trim();

    const exact = tokens.find((t) => norm(t).toLowerCase() === want);
    if (exact) return { id: exact.id };

    const subs = tokens.filter((t) => {
      const n = norm(t).toLowerCase();
      return n && (n.includes(want) || want.includes(n));
    });
    if (subs.length === 1) return { id: subs[0].id };
    if (subs.length > 1) return { candidates: subs.map(norm) };

    // No substring hit — offer token-word overlap candidates (e.g. "the twisted"
    // → every "Mage the Twisted"-ish name) so the agent can clarify.
    const words = want.split(/\s+/).filter((w) => w.length > 2);
    const near = tokens.filter((t) => {
      const n = norm(t).toLowerCase();
      return words.some((w) => n.includes(w));
    }).map(norm);
    return { candidates: Array.from(new Set(near)).slice(0, 8) };
  } catch {
    return {};
  }
}

// Resolve a name to a token id or throw the standard "ambiguous target" error
// (with did-you-mean candidates). The single place the agent-facing wording lives.
export async function resolveTokenOrThrow(
  name: string,
  tokenList?: { id: string; name: string }[],
): Promise<string> {
  const r = await resolveToken(name, tokenList);
  if (!r.id) {
    const hint = r.candidates?.length ? ` Did you mean: ${r.candidates.join(", ")}?` : " No matching token on the page.";
    throw new Error(`Ambiguous target "${name}".${hint} Ask the DM to confirm, don't guess.`);
  }
  return r.id;
}

// Resolve a registered character name (or an explicit charSheetId) to a Roll20
// character-sheet id, following token.represents. Shared by the attribute tools.
export async function resolveCharSheetId(
  characterName: string | undefined,
  charSheetId: string | undefined,
): Promise<string> {
  if (charSheetId) return charSheetId;
  if (!characterName) throw new Error("Provide characterName or charSheetId");
  const entry = registry.lookup(characterName);
  if (!entry) throw new Error(`Character not registered: ${characterName}`);
  const tokenData = await roll20.relayCommand<{ represents: string } | null>({
    action: "getTokenById",
    tokenId: entry.roll20TokenId,
  });
  if (!tokenData?.represents) throw new Error("Token has no linked character sheet");
  return tokenData.represents;
}
