import { existsSync, readFileSync } from "fs";
import { dataPath } from "../dataDir.js";
import { getActiveCampaign } from "../registry/campaigns.js";
import { rtRelayCommand, rtGet, RtModSilentError, RtRelayError } from "./roll20-rt.js";
import { READONLY_ACTIONS, newNonce } from "./actions.js";
import { recordSuccess, recordFailure, circuitOpen } from "./transport-health.js";
import { ensureRelayVersionChecked } from "./relay-version-check.js";
import { prepareUpload, uploadPrepared, UploadAuthError, type UploadCredential } from "./art-upload.js";

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

  // BROWSERLESS, unconditionally: push !ai-relay over Firebase RTDB and read the Mod's
  // AIBRIDGE_RESULT back. The Mod runs every action, so RT serves all of them — no browser
  // involved, and there is no env var that selects anything else (#122/#179/#180 — the legacy
  // browser→chat relay is deleted, not an opt-out). There is deliberately NO silent Playwright
  // fallback here: a packaged install ships no browser, so an RT failure must SURFACE (and
  // prompt a token re-harvest in the gem), never quietly reach for a Chromium that isn't there.
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
        `Will probe again in ${gate.secsLeft}s. ${lastFailureRemedy}`,
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
      const failure = describeRelayFailure(action, err);
      if (failure.remedy) lastFailureRemedy = failure.remedy;
      throw new Error(failure.message);
    });
  }
}

const TOKEN_REMEDY =
  `Reconnect Roll20 in the gem to re-harvest the token, or furnish one with \`npm run furnish:token\`.`;

// The remedy the circuit-breaker message repeats: whatever the last real failure called for.
let lastFailureRemedy = TOKEN_REMEDY;

// #234: three failures used to share "re-harvest the token", which is only right for the first.
// The DM following it for the other two re-harvests forever while the real fault sits elsewhere.
function describeRelayFailure(action: string, err: Error): { message: string; remedy?: string } {
  if (err instanceof RtModSilentError) {
    // The command reached the campaign; its Mod never answered. Name the campaign and point at
    // the sandbox, where the fix is.
    const camp = getActiveCampaign();
    const remedy =
      `Open ${camp.name} (${camp.roll20CampaignId}) in Roll20 → Settings → API Scripts, check the ` +
      `sandbox is running (restart it, or re-paste the relay), and look for the ` +
      `"[GM_AI_Bridge] Relay script loaded" line in its console.`;
    return {
      message: `Roll20 campaign ${camp.name} (${camp.roll20CampaignId}) received "${action}" but its ` +
        `Mod script never replied (${err.timeoutMs / 1000}s). ${remedy}`,
      remedy,
    };
  }
  if (err instanceof RtRelayError) {
    // The Mod answered — the transport and the credential are both fine.
    return { message: `Roll20 refused "${action}": ${err.message}` };
  }
  // Couldn't sign in, connect or push: a credential/connection problem. err.message is kept
  // verbatim — dm-whisper re-harvests on its "No usable Roll20 realtime token" phrase.
  return {
    message: `Roll20 realtime transport failed for "${action}": ${err.message}. ${TOKEN_REMEDY} ` +
      `There is no browser fallback and no browser in this server at all (#179) — RT is the only transport.`,
    remedy: TOKEN_REMEDY,
  };
}

const UPLOAD_CACHE_PATH = dataPath("roll20-upload-cache.json");
const UPLOAD_CACHE_TTL_MS = 8 * 60 * 60_000; // 8 h

/**
 * The furnished upload credential: the logged-in browser's app.roll20.net cookies, plus that
 * browser's User-Agent (Cloudflare binds `cf_clearance` to it). Written by whoever harvests it —
 * the gem's own logged-in session, human present — never by this server (#177, #243). A file from
 * before #243 also carries a dead `endpoint` field; it is ignored.
 */
interface UploadCache extends UploadCredential {
  harvestedAt: number;
}

function readUploadCache(): UploadCache | null {
  try {
    if (!existsSync(UPLOAD_CACHE_PATH)) return null;
    const c = JSON.parse(readFileSync(UPLOAD_CACHE_PATH, "utf-8")) as UploadCache;
    if (!c.cookies || typeof c.cookies !== "object" || !Object.keys(c.cookies).length) return null;
    if (Date.now() - c.harvestedAt > UPLOAD_CACHE_TTL_MS) return null;
    return c;
  } catch { return null; }
}

/**
 * Raised when the furnished Roll20 upload credential is missing, stale, or refused by Roll20.
 * Only those cases: any other upload failure is an UploadStageError naming the step, so a broken
 * upload never sends someone off to refresh a credential that would not help (#243).
 */
export class Roll20UploadCredentialError extends Error {
  constructor(reason: string) {
    super(
      `Roll20 art upload unavailable (${reason}). Uploads are browserless here — this server ` +
      `runs Roll20's own upload flow itself but never harvests the credential. Refresh it from the ` +
      `gem's logged-in Roll20 session, or point ROLL20_DATA_DIR at a data dir holding a current ` +
      `roll20-upload-cache.json ({cookies, userAgent, harvestedAt}, ${UPLOAD_CACHE_TTL_MS / 3_600_000}h TTL).`
    );
    this.name = "Roll20UploadCredentialError";
  }
}

/**
 * Upload a local image to the Roll20 Art Library and return its CDN URL — the `original`
 * variant, which is what token `imgsrc` and map images use. Browserless by construction: Roll20's
 * own three-step flow (reqimage → s3putsign_batch → four presigned PUTs), with the four size
 * variants generated here the way Roll20's client generates them. See art-upload.ts.
 */
export async function uploadArt(localAbsPath: string): Promise<string> {
  const cache = readUploadCache();
  if (!cache) throw new Roll20UploadCredentialError("no roll20-upload-cache.json with cookies, or it is older than its TTL");
  const prepared = await prepareUpload(localAbsPath, readFileSync(localAbsPath));
  try {
    return await uploadPrepared(prepared, cache);
  } catch (e) {
    if (e instanceof UploadAuthError) throw new Roll20UploadCredentialError(e.message);
    throw e;
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
