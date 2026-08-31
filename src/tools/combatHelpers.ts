// Shared helpers for the combat tool suite (registered in combat.ts). Extracted
// so the name→token resolution, char-sheet resolution, turn-order shape, and the
// MCP response boilerplate live in one place instead of being copy-pasted across
// ~25 tool handlers.

import * as registry from "../registry/characters.js";
import * as roll20 from "../bridge/roll20.js";
import { normalizeNameForMatch } from "./nameMatch.js";

// ── MCP response builders ─────────────────────────────────────────────────────
// Every tool returns { content: [{ type: "text", text }] }. These three trim the
// boilerplate: text() for a plain string, json() for a JSON.stringify'd value,
// fail() for a string describing something that did NOT happen.
//
// isError is the field an MCP client reads to tell a failure from a success. A
// handler that THROWS gets it for free (the SDK sets it), but one that RETURNS a
// failure had no way to say so, so every non-throwing failure arrived as a success
// carrying failure prose and clients had to pattern-match English to notice (#190).
// fail() is the one way to express that — don't hand-roll the object.
type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

export function text(s: string): ToolResult {
  return { content: [{ type: "text", text: s }] };
}

// A failure the handler chose to RETURN rather than throw, because the prose is
// more useful to the DM than a stack trace — but the caller must still be able to
// tell it from a success. The operation described did NOT happen.
export function fail(s: string): ToolResult {
  return { content: [{ type: "text", text: s }], isError: true };
}

export function json(value: unknown, pretty = true): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, pretty ? null : undefined, pretty ? 2 : undefined) }] };
}

// Roll20 stores numeric fields as STRINGS (token bar1_value/bar1_max, turnorder pr,
// selection geometry, …). Passing them through untyped puts QUOTED numbers ("133",
// "17") into the JSON tool-results the model reads back — a "retyping smell" that
// primes the model to quote its OWN numeric args on the next write, tripping the
// server's strict Zod validation (-32602). Read tools normalize to real JSON
// numbers with num() so the board the model reads is typed the way it must reply.
// Returns null for empty/non-numeric input (preserving "no bar set" as null, not 0).
export function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Tolerate the ways small/cloud models pass array params (Haiku in the HUD does
// this constantly): a real array passes through; a JSON-stringified array
// (`'["a","b"]'`) is parsed; a bare string (`"a"`) becomes `["a"]`; empty → `[]`.
// Use as a Zod preprocess: `z.preprocess(coerceStringArray, z.array(z.string()))`.
// Mirrors the relay's normProps leniency — the model's natural call shouldn't
// hard-fail Zod validation. Anything else is returned untouched for Zod to reject.
export function coerceStringArray(v: unknown): unknown {
  if (Array.isArray(v)) return v;
  if (typeof v === "string") {
    const s = v.trim();
    if (s.startsWith("[")) {
      try { return JSON.parse(s); } catch { /* not JSON — treat as a single name */ }
    }
    return s ? [s] : [];
  }
  return v;
}

// Tolerate a JSON-stringified array — and a bare single object — for object-array
// params, mirroring coerceStringArray (models sometimes stringify the whole array).
// Anything else falls through untouched for Zod to reject.
export function coerceObjectArray(v: unknown): unknown {
  if (Array.isArray(v)) return v;
  if (typeof v === "string") {
    const s = v.trim();
    if (s.startsWith("[") || s.startsWith("{")) {
      try {
        const parsed: unknown = JSON.parse(s);
        return Array.isArray(parsed) ? parsed : [parsed];
      } catch { /* not JSON — let Zod reject the string */ }
    }
    return v;
  }
  if (v && typeof v === "object") return [v];
  return v;
}

// Tolerate the ways small/cloud models pass boolean params: "true"/"false"/"1"/"0"
// are mapped to native booleans; real booleans pass through unchanged; anything else
// is returned untouched for Zod to reject. Use as a Zod preprocess:
//   `z.preprocess(coerceBoolean, z.boolean())`.
export function coerceBoolean(v: unknown): unknown {
  if (typeof v === "boolean") return v;
  if (v === "true" || v === "1") return true;
  if (v === "false" || v === "0") return false;
  return v;
}

// ── Roll cards ────────────────────────────────────────────────────────────────
// Render PRE-COMPUTED roll results as a Roll20 default-template card, for the
// postChat relay action (post_roll_as_character). The dice were already rolled
// elsewhere — D&D Beyond, the gem's roll-pump bridging, a companion app — so the
// output must carry no [[…]] inline-roll syntax, which Roll20 would re-roll into
// different numbers. Escaping strips template-breaking chars ({}|) and
// neutralizes inline-roll brackets for the same reason.
export interface RollCardRow { label: string; notation?: string; total: number | string; breakdown?: string }

const escapeRollText = (s: string) =>
  String(s).replace(/[{}|]/g, "").replace(/\[\[/g, "[").replace(/\]\]/g, "]");

export function renderRollCard(title: string, rows: RollCardRow[]): string {
  const parts = rows.map((r) => {
    const label = escapeRollText(r.label.trim() || "Roll");
    const notation = r.notation ? ` ${escapeRollText(r.notation)}` : "";
    const total = escapeRollText(String(r.total));
    const breakdown = r.breakdown ? escapeRollText(r.breakdown) : "";
    // Show the die faces only when they say more than the bare total.
    const detail = breakdown && breakdown !== total ? ` (${breakdown})` : "";
    return `{{${label}${notation} = ${total}${detail}}}`;
  });
  return `&{template:default} {{name=${escapeRollText(title)}}} ${parts.join(" ")}`;
}

// ── Mob-plan whisper card ─────────────────────────────────────────────────────
// Default rendering for a plan stored via set_mob_plan without caller-supplied
// HTML. Whispered to the DM by the turn hook when the mob's turn comes up, so it
// must be a self-contained inline-styled block like the tactics cascade's card.
export interface MobPlan { name: string; shortTerm: string; mediumTerm?: string; longGoal?: string }

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function renderMobPlanCard(plan: MobPlan): string {
  const line = (label: string, v?: string) =>
    v ? `<div style='margin-top:4px;'><b style='color:#9a86d8;'>${label}:</b> ${escapeHtml(v)}</div>` : "";
  return "<div style='border:1px solid #4a3a6a;border-left-width:3px;background:#0c0814;padding:6px 10px;border-radius:2px;color:#cbc0e8;font-family:Georgia,serif;line-height:1.5;'>"
    + `<div style='color:#9a86d8;font-weight:bold;'>🧠 ${escapeHtml(plan.name)}</div>`
    + line("Now", plan.shortTerm)
    + line("Then", plan.mediumTerm)
    + line("Goal", plan.longGoal)
    + "</div>";
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
  // PR #198 review (Devin, finding 1): a punctuation-only name ("," / "...")
  // — or, for this required-string param, an outright empty/whitespace-only
  // one — normalizes to "". String.prototype.includes("") is true for every
  // string, so letting this flow into the exact/substring/word-overlap
  // passes below (or into the registry lookup, which has the same risk)
  // would silently match or resolve EVERY token on the page. Refuse up
  // front — returning {} (no id, no candidates) rather than throwing keeps
  // this consistent with every other "couldn't resolve" outcome resolveToken
  // already produces: resolveTokenOrThrow turns it into the same loud
  // "Ambiguous target … No matching token on the page" error, and callers
  // that loop over many selectors (batch_exec's per-op resolution) report it
  // as a normal per-op failure instead of aborting the whole batch.
  if (!normalizeNameForMatch(name)) return {};
  const entry = registry.lookup(name);
  if (entry?.roll20TokenId) return { id: entry.roll20TokenId };
  try {
    // Caller may pass a pre-fetched token list (batch resolution fetches once).
    const tokens = tokenList ?? await (async () => {
      const pageId = await roll20.getCurrentPageId();
      return roll20.relayCommand<{ id: string; name: string }[]>({ action: "getTokens", pageId });
    })();
    // norm(): display form (original case, first line, trimmed) — used only for
    // "did you mean" candidates. normalizeNameForMatch(): comparison form,
    // case- AND punctuation-folded (issue #195: "Bandit Captain, the Scarred"
    // must match "Bandit Captain the Scarred") — used for every
    // equality/substring test below. Folding punctuation only ever WIDENS a
    // match versus the old case-only fold, so a name that was unambiguous
    // stays unambiguous; a normalization that newly collides two tokens still
    // falls through to the candidates path below rather than picking one.
    const norm = (t: { name?: string }) => (t.name || "").split("\n")[0].trim();
    const want = normalizeNameForMatch(name);

    // filter (not find): two DIFFERENT board names that fold to the same
    // comparison form ("Iron, Golem" / "Iron Golem") must still surface as
    // ambiguous, not silently resolve to whichever came first in the list.
    // Also covers two GENUINELY IDENTICAL names (no punctuation involved at
    // all, e.g. two hand-placed "Goblin" tokens, or #199's epithet renamer
    // re-issuing an epithet already on the board) — writing damage to
    // whichever came first is a silent wrong write; refusing with both named
    // as candidates is correct. Same "only widen, never guess" principle the
    // issue itself states for punctuation, applied here to a case #195
    // didn't name but the DM confirmed should behave the same way.
    const exactMatches = tokens.filter((t) => normalizeNameForMatch(norm(t)) === want);
    if (exactMatches.length === 1) return { id: exactMatches[0].id };
    if (exactMatches.length > 1) return { candidates: exactMatches.map(norm) };

    const subs = tokens.filter((t) => {
      const n = normalizeNameForMatch(norm(t));
      return n && (n.includes(want) || want.includes(n));
    });
    if (subs.length === 1) return { id: subs[0].id };
    if (subs.length > 1) return { candidates: subs.map(norm) };

    // No substring hit — offer token-word overlap candidates (e.g. "the twisted"
    // → every "Mage the Twisted"-ish name) so the agent can clarify. NOTE
    // (issue #195 follow-up): this branch is candidates-only BY CONSTRUCTION —
    // there is no `if (near.length === 1) return { id }`. Once the substring
    // pass above misses, resolveTokenOrThrow is guaranteed to throw; the
    // outcome was decided two branches earlier, not rescued here. On a board
    // where every candidate shares a common word (e.g. four "Bandit Captain
    // the <epithet>" tokens all containing "bandit"), this returns ALL of
    // them and the caller sees "Ambiguous target … Did you mean: …?" even for
    // a name that was never actually ambiguous — the normalization above
    // (issue #195) is what keeps queries like "the Scarred"/"Scarred" out of
    // this branch in the first place, by resolving them via the substring
    // pass instead. Don't read a near-miss here as something the next line
    // might still rescue.
    const words = want.split(/\s+/).filter((w) => w.length > 2);
    const near = tokens.filter((t) => {
      const n = normalizeNameForMatch(norm(t));
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
  if (!entry?.roll20TokenId) throw new Error(`Character not registered: ${characterName}`);
  const tokenData = await roll20.relayCommand<{ represents: string } | null>({
    action: "getTokenById",
    tokenId: entry.roll20TokenId,
  });
  if (!tokenData?.represents) throw new Error("Token has no linked character sheet");
  return tokenData.represents;
}
