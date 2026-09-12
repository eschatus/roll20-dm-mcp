// Pure helpers for the RTDB transport — extracted from roll20-rt.ts so they can be unit-tested in
// isolation (no Firebase, no Playwright, no module state). roll20-rt.ts imports these; the I/O and
// connection logic stays there. Keep these pure and deterministic.

export const AIBRIDGE_MARKER = "AIBRIDGE_RESULT:";

// Relay >= 2.7.0 percent-encodes the whole payload under its own marker. The old marker carried
// raw JSON with three sequences HTML-entity-escaped, which Roll20 decoded back before scanning for
// inline rolls — so a malformed one still disabled the sandbox. Both are parsed here: the encoded
// form is preferred, and the legacy form keeps a campaign on an older relay working until it is
// redeployed (deploys are per-campaign and manual).
export const AIBRIDGE_MARKER_ENC = "AIBRIDGE_RESULT_ENC:";

// The ONE place that decides whether a chat message is a relay reply. It used to be two: a cheap
// `content.includes(AIBRIDGE_MARKER)` pre-filter guarding the call to parseAibridge, in
// roll20-rt.ts. When relay 2.7.0 moved the payload under AIBRIDGE_RESULT_ENC:, parseAibridge
// learned the new marker and that pre-filter did not — and "AIBRIDGE_RESULT_ENC:" does not
// contain the substring "AIBRIDGE_RESULT:", so every reply was rejected before it was ever
// parsed and every relay round-trip timed out (#213). Marker knowledge lives here, next to the
// parser, and nothing else may re-derive it.
export function hasAibridgeMarker(text: unknown): boolean {
  return typeof text === "string"
    && (text.includes(AIBRIDGE_MARKER_ENC) || text.includes(AIBRIDGE_MARKER));
}

// Extract the first balanced-brace JSON object following the AIBRIDGE marker (mirrors the
// roll20.ts OBSERVER_SCRIPT). Tolerates braces inside strings and escaped quotes.
export function parseAibridge(text: string): { nonce: number; data?: unknown; error?: string } | null {
  // Relay >= 2.7.0: the whole payload is one percent-encoded token, so there is no brace-scanning
  // to do and nothing in it Roll20 could have mangled. Runs first — a message carrying the encoded
  // marker never also carries the legacy one.
  const encPos = text.indexOf(AIBRIDGE_MARKER_ENC);
  if (encPos !== -1) {
    const encStart = encPos + AIBRIDGE_MARKER_ENC.length;
    // The payload ends at the first character outside the percent-encoding alphabet — in practice
    // the "<" of the closing </div> the Mod wraps it in.
    const encoded = /^[A-Za-z0-9\-_.!~*'()%]+/.exec(text.slice(encStart));
    if (!encoded) return null;
    try { return JSON.parse(decodeURIComponent(encoded[0])); } catch { return null; }
  }

  const pos = text.indexOf(AIBRIDGE_MARKER);
  if (pos === -1) return null;
  const start = pos + AIBRIDGE_MARKER.length;
  if (text[start] !== "{") return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (esc) { esc = false; continue; }
    if (inStr) { if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') { inStr = true; continue; }
    if (c === "{") depth++;
    if (c === "}" && --depth === 0) {
      // The Mod (writeResult in ai-relay.js) HTML-entity-encodes "@{", "%{", and "[[" before
      // sending — those sequences make Roll20's OWN chat pipeline try to live-evaluate the echoed
      // text as an attribute reference / ability call / inline roll, which crashes the whole
      // sandbox on a malformed one. The browser-relay path gets these decoded for free (DOM
      // textContent auto-decodes entities); RT reads the raw RTDB string, so decode explicitly
      // here. Safe no-op if the entities are already decoded (nothing to match).
      const slice = text.slice(start, i + 1)
        .replace(/&#64;\{/g, "@{")
        .replace(/&#37;\{/g, "%{")
        .replace(/&#91;&#91;/g, "[[");
      try { return JSON.parse(slice); } catch { return null; }
    }
  }
  return null;
}

// Roll20 rolltemplate content carries roll RESULTS as pointers rather than values: "{{r1=$[[0]]}}"
// means "the total of inlinerolls[0]", and the number itself appears nowhere in the string. Left
// alone, eight Fire Giant rock attacks that came up 16/13/21/21/13/20/13/20 are byte-identical
// `content` strings and a caller cannot tell which one landed (#187). The join is possible, but
// every consumer would have to implement it, and get_recent_chat reads as though it already had.
//
// Substitute in place so `content` stands on its own. The caller still returns `inlinerolls`
// alongside, because `expression` ("1d20 +10") carries what the substitution does not.
//
// A pointer whose total is missing — index out of range, or a roll with no result — is left
// VERBATIM. An unresolved "$[[2]]" is visibly unreadable; a fabricated 0 is not, and the whole
// point of this tool is that an agent doesn't proceed on an invented number.
//
// Call this BEFORE cleanChat: its 240-char cap would otherwise truncate a pointer late in a long
// template out of reach (and resolving shortens the string, so more of it survives the cap).
export function resolveInlineRolls(raw: unknown, rolls: { total: number | null }[] = []): string {
  const s = String(raw == null ? "" : raw);
  if (!s.includes("$[[")) return s;
  return s.replace(/\$\[\[(\d+)\]\]/g, (whole, idx: string) => {
    const total = rolls[Number(idx)]?.total;
    return typeof total === "number" ? String(total) : whole;
  });
}

// Strip rolltemplate HTML / URLs to dense text (roll totals are kept separately in inlinerolls, so
// this can be aggressive). Mirrors the Mod's cleanChat — keep byte-compatible.
export function cleanChat(raw: unknown): string {
  return String(raw == null ? "" : raw)
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/(div|p|tr|td|li|h[1-6])>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'").replace(/&rsquo;/g, "'").replace(/&quot;/g, '"')
    .replace(/\s+/g, " ").trim().slice(0, 240);
}

// PC HP carrier: a %%PCHP={...}%% block in a token's GM-only gmnotes. Single source of truth shared
// raw with the Mod. parse returns null when absent/garbage; write replaces (never duplicates) the
// block and preserves any surrounding notes.
export const PCHP_RE = /%%PCHP=({[\s\S]*?})%%/;
export interface PcHpEntry { current: number; max: number; name: string; updated: number }
export function parsePcHpBlock(gm: unknown): PcHpEntry | null {
  const raw = String(gm ?? "");
  let m = raw.match(PCHP_RE);
  if (!m) {
    // Roll20 URL-encodes gmnotes when edited in the UI — try decoding and re-matching.
    try {
      const decoded = decodeURIComponent(raw);
      m = decoded.match(PCHP_RE);
    } catch {
      // decodeURIComponent throws on malformed sequences — treat as no block.
    }
  }
  if (!m) return null;
  try { return JSON.parse(m[1]) as PcHpEntry; } catch { return null; }
}
export function writePcHpBlock(gm: unknown, entry: PcHpEntry): string {
  const base = String(gm ?? "").replace(PCHP_RE, "").replace(/\s+$/, "");
  return (base ? base + " " : "") + "%%PCHP=" + JSON.stringify(entry) + "%%";
}

// Map ping broadcast: the `broadcast` node under the campaign storage root is a single-value
// channel overwritten on each shift+click ping with a JSON string like
//   {"type":"ping","data":{"position":{"x":938.5,"y":-680.0},"focus":false,
//    "page":"<pageid>","player":"<playerid>","ts":1781207868473}}
// y uses Roll20's negated canvas convention (same as door objects) — we negate it back so
// callers get normal page-pixel coordinates. Returns null for non-ping broadcast payloads.
export interface MapPing {
  x: number;
  y: number;       // page coords (already un-negated)
  rawY: number;    // as transmitted, for debugging
  pageId: string;
  player: string;
  ts: number;
  focus: boolean;
}
export function parseBroadcastPing(raw: unknown): MapPing | null {
  if (typeof raw !== "string" || !raw) return null;
  let msg: { type?: unknown; data?: Record<string, unknown> };
  try { msg = JSON.parse(raw) as typeof msg; } catch { return null; }
  if (msg?.type !== "ping" || !msg.data) return null;
  const pos = msg.data.position as { x?: unknown; y?: unknown } | undefined;
  const x = Number(pos?.x), rawY = Number(pos?.y);
  if (!isFinite(x) || !isFinite(rawY)) return null;
  return {
    x,
    y: -rawY,
    rawY,
    pageId: String(msg.data.page ?? ""),
    player: String(msg.data.player ?? ""),
    ts: Number(msg.data.ts) || 0,
    focus: msg.data.focus === true,
  };
}

// Project a raw graphics-node record to the tokenSummary shape, by profile (lean/status/full).
// Mirrors the Mod's tokenSummary; default-fills missing sparse fields.
export function mapToken(g: Record<string, unknown>, profile: string): Record<string, unknown> {
  const s: Record<string, unknown> = {
    id: g.id, name: g.name || "", represents: g.represents || "",
    controlledby: g.controlledby || "", layer: g.layer,
  };
  if (profile === "lean") return s;
  s.bar1_value = g.bar1_value; s.bar1_max = g.bar1_max; s.statusmarkers = g.statusmarkers || "";
  if (profile === "status") return s;
  s.left = g.left; s.top = g.top; s.width = g.width; s.height = g.height;
  if (g.layer === "map") s.imgsrc = g.imgsrc;
  return s;
}

// turnorder is stored either as a JSON string (classic) or a live array — tolerate both. Drops the
// repeated per-entry _pageid.
export function parseTurnorder(v: unknown): Record<string, unknown>[] {
  let arr: unknown = v;
  if (typeof v === "string") { try { arr = JSON.parse(v); } catch { arr = []; } }
  if (!Array.isArray(arr)) return [];
  return arr.map((e) => { const o: Record<string, unknown> = {}; for (const k in e) if (k !== "_pageid") o[k] = (e as Record<string, unknown>)[k]; return o; });
}

// Firebase rejects undefined/NaN; scrub before any write (client-side equivalent of the Mod's
// stripUndef guard — see relay-undefined-firebase-crash). null is allowed (it deletes a key).
export function stripUndefWrite(o: Record<string, unknown>): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  for (const k of Object.keys(o)) {
    const v = o[k];
    if (v === undefined) continue;
    if (typeof v === "number" && Number.isNaN(v)) continue;
    clean[k] = v;
  }
  return clean;
}
