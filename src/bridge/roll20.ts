import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import path from "path";
import { dataPath } from "../dataDir.js";
import { getActiveCampaign } from "../registry/campaigns.js";
import { rtRelayCommand, rtGet } from "./roll20-rt.js";
import { READONLY_ACTIONS, newNonce } from "./actions.js";
import { recordSuccess, recordFailure, circuitOpen } from "./transport-health.js";
import { ensureRelayVersionChecked } from "./relay-version-check.js";

const RELAY_TIMEOUT_MS = 30_000;

// ─── Test seam ────────────────────────────────────────────────────────────────
// When set (only by the test harness), relay/evaluate calls route here instead of
// the live browser → chat → sandbox path, so the real combat/tactics tools can run
// against an in-memory Roll20 emulator. Production never sets this; the default
// path below is completely unaffected.
export interface BridgeTestTransport {
  relay<T>(cmd: Record<string, unknown>): Promise<T>;
  evaluate<T>(fn: (args?: unknown) => T, args?: unknown): Promise<T>;
}
let _testTransport: BridgeTestTransport | null = null;
export function __setBridgeTestTransport(t: BridgeTestTransport | null): void {
  _testTransport = t;
}



export function relayCommand<T>(cmd: Record<string, unknown>): Promise<T> {
  // Test harness routes every relay action through the in-memory emulator (bypasses rt/browser).
  if (_testTransport) return _testTransport.relay<T>(cmd);

  // BROWSERLESS by default (ROLL20_TRANSPORT=rt, the default): push !ai-relay over Firebase RTDB and
  // read the Mod's AIBRIDGE_RESULT back. The Mod runs every action, so RT serves all of them — no
  // browser involved. There is deliberately NO silent Playwright fallback here: a packaged install
  // ships no browser, so an RT failure must SURFACE (and prompt a token re-harvest in the gem),
  // never quietly reach for a Chromium that isn't there. The legacy browser→chat relay is an
  // explicit dev opt-out via ROLL20_TRANSPORT=browser.
  const action = cmd.action as string;
  {

    // Version handshake: fire a one-time, un-awaited liveness+version probe (cached for the
    // process — see relay-version-check.ts). Never blocks or delays this call; a mismatch is
    // reported asynchronously once the probe resolves, whenever that is.
    ensureRelayVersionChecked();

    // Circuit-breaker gate (single source of truth in transport-health.ts, issue #102).
    // When OPEN we throw immediately WITHOUT calling rtRelayCommand — so no failure is recorded
    // for a skipped call (we never count a call we didn't make). After the reset window elapses,
    // circuitOpen() transitions to half-open and returns { open: false } so exactly the next call
    // probes liveness; a failed probe re-opens instantly (rtRelayCommand → recordFailure → the
    // half-open re-open path in transport-health). Success/failure recording for "rt" stays owned
    // by roll20-rt.ts (rtRelayCommand), so we DON'T record here — that's what advances the circuit
    // counter, and double-recording would corrupt it. (Bug #99.)
    const gate = circuitOpen("rt");
    if (gate.open) {
      throw new Error(
        `Roll20 RT circuit open after consecutive failures — skipping "${action}". ` +
        `Will probe again in ${gate.secsLeft}s. Reconnect Roll20 in the gem to re-harvest the token.`,
      );
    }

    // Nonce must be generated BEFORE the call and reused on retry — the Mod's
    // PROCESSED_NONCES LRU deduplicates same-nonce resends server-side. A fresh
    // nonce on retry would re-execute the action (double-apply damage, etc.).
    const nonce = newNonce();
    return rtRelayCommand<T>(cmd, { assignedNonce: nonce }).catch((err: Error) => {
      // No circuit/health recording here — rtRelayCommand already recorded the failure ("rt"),
      // which is what advances the shared circuit counter. We only reshape the error message.
      console.error(`[roll20] rt ${action} failed (browserless — no fallback): ${err.message}`);
      throw new Error(
        `Roll20 realtime transport failed for "${action}": ${err.message}. ` +
        `Reconnect Roll20 in the gem to re-harvest the token. There is no browser fallback and no ` +
        `browser in this server at all (#179) — RT is the only transport.`,
      );
    });
  }
}

const UPLOAD_CACHE_PATH = dataPath("roll20-upload-cache.json");
const UPLOAD_CACHE_TTL_MS = 8 * 60 * 60_000; // 8 h

interface UploadCache {
  endpoint: string;
  cookies: Record<string, string>; // name→value for app.roll20.net
  harvestedAt: number;
}

function readUploadCache(): UploadCache | null {
  try {
    if (!existsSync(UPLOAD_CACHE_PATH)) return null;
    const c = JSON.parse(readFileSync(UPLOAD_CACHE_PATH, "utf-8")) as UploadCache;
    if (Date.now() - c.harvestedAt > UPLOAD_CACHE_TTL_MS) return null;
    return c;
  } catch { return null; }
}

function writeUploadCache(c: UploadCache): void {
  mkdirSync(path.dirname(UPLOAD_CACHE_PATH), { recursive: true });
  writeFileSync(UPLOAD_CACHE_PATH, JSON.stringify(c), "utf-8");
}

function isCdnUrl(v: unknown): v is string {
  return typeof v === "string" && (v.includes("d20.io") || v.includes("files.roll20")) && v.startsWith("http");
}

// Extract CDN URL from Roll20's upload response JSON. Roll20 has used several field names
// across versions; try them all rather than assume one.
function extractCdnUrl(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  for (const key of ["imgsrc", "url", "imageUrl", "image_url", "src", "final"]) {
    if (isCdnUrl(b[key])) return b[key] as string;
  }
  // Roll20 Jumpgate s3putsign_batch: {"thumb":{"final":"https://files.d20.io/.../thumb.webp",...}}
  // Convert thumb URL → original.webp since that's the usable full-res asset URL.
  if (b["thumb"] && typeof b["thumb"] === "object") {
    const thumb = b["thumb"] as Record<string, unknown>;
    if (isCdnUrl(thumb["final"])) {
      return (thumb["final"] as string).replace(/\/thumb\.\w+(\?.*)?$/, "/original.webp");
    }
  }
  // Recurse one level for other nested structures (e.g. { data: { imgsrc: "..." } })
  for (const nested of Object.values(b)) {
    const found = extractCdnUrl(nested);
    if (found) return found;
  }
  return null;
}

// Attempt a direct HTTP upload using cached session credentials. Returns the CDN URL or
// throws — caller must fall back to Playwright if this fails.
async function uploadArtDirect(localAbsPath: string, cache: UploadCache): Promise<string> {
  const { readFileSync } = await import("fs");

  const ext = path.extname(localAbsPath).toLowerCase();
  const mimeTypes: Record<string, string> = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".gif": "image/gif", ".webp": "image/webp",
  };
  const mimeType = mimeTypes[ext] ?? "application/octet-stream";

  const form = new FormData();
  const fileBytes = readFileSync(localAbsPath);
  form.append("file", new Blob([fileBytes], { type: mimeType }), path.basename(localAbsPath));

  const cookieHeader = Object.entries(cache.cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");

  const res = await fetch(cache.endpoint, {
    method: "POST",
    headers: { Cookie: cookieHeader },
    body: form,
  });

  if (!res.ok) throw new Error(`Roll20 upload HTTP ${res.status}`);
  const body = await res.json().catch(() => null);
  const url = extractCdnUrl(body);
  if (!url) throw new Error(`Roll20 upload response missing CDN URL: ${JSON.stringify(body)}`);
  return url;
}

/**
 * Raised when the furnished Roll20 upload credential is missing or stale. Uploads go over
 * a plain multipart POST (uploadArtDirect) — no browser — but the endpoint + session cookies
 * have to come from somewhere. Harvesting them is a human-attended act that belongs in the
 * gem's own logged-in session, not in an MCP server (#177).
 */
export class Roll20UploadCredentialError extends Error {
  constructor(reason: string) {
    super(
      `Roll20 art upload unavailable (${reason}). Uploads are browserless here — this server ` +
      `POSTs the file itself but never harvests the credential. Refresh it from the gem's ` +
      `logged-in Roll20 session, or point ROLL20_DATA_DIR at a data dir holding a current ` +
      `roll20-upload-cache.json ({endpoint, cookies, harvestedAt}, ${UPLOAD_CACHE_TTL_MS / 3_600_000}h TTL).`
    );
    this.name = "Roll20UploadCredentialError";
  }
}

export async function uploadArt(localAbsPath: string): Promise<string> {
  // Browserless by construction (#177): a direct multipart POST with furnished credentials.
  // There is deliberately NO Playwright fallback — it used to harvest the credential itself,
  // which is the capability being removed. If the file can't go over HTTP, it doesn't go.
  const cache = readUploadCache();
  if (!cache) throw new Roll20UploadCredentialError("no roll20-upload-cache.json, or it is older than its TTL");
  try {
    return await uploadArtDirect(localAbsPath, cache);
  } catch (e) {
    throw new Roll20UploadCredentialError(`direct upload failed: ${(e as Error).message}`);
  }
}

export async function getTokens(pageId: string) {
  return relayCommand<{ id: string; name: string; bar1_value: number; bar1_max: number }[]>({
    action: "getTokens",
    pageId,
  });
}

export async function getCurrentPageId(): Promise<string> {
  // RT is the only transport (#179): playerpageid comes straight off the campaign node.
  // The emulator harness has no RTDB, so honour its evaluate seam when present — that keeps
  // this browser-free in production (nothing but a test ever sets _testTransport) while the
  // emulator can still answer, which is what the old ROLL20_TRANSPORT=browser branch did.
  const pid = _testTransport
    ? await _testTransport.evaluate(() => (globalThis as unknown as { window: { Campaign: { get(k: string): unknown } } }).window.Campaign.get("playerpageid"))
    : (await rtGet<{ playerpageid?: unknown }>("campaign"))?.playerpageid;
  // Never let a falsy non-string (Roll20 returns boolean `false` when no player page
  // is set) escape as a "page id" — it silently mis-targets every relay call that
  // defaults to it. Fail loudly with an actionable message instead.
  if (typeof pid !== "string" || !pid) {
    throw new Error(
      "Could not resolve the current page id — Roll20 has no player page set (playerpageid is unset). " +
      "Pass an explicit pageId, or set a player page in Roll20.",
    );
  }
  return pid;
}
