import type { Page } from "playwright";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import path from "path";
import { dataPath } from "../dataDir.js";
import { getPage, closeBrowser } from "./browser.js";
import { getActiveCampaign } from "../registry/campaigns.js";
import { rtEnabled, rtRelayCommand, rtGet } from "./roll20-rt.js";
import { READONLY_ACTIONS, newNonce } from "./actions.js";
import { recordSuccess, recordFailure, circuitOpen } from "./transport-health.js";

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

let _editorPage: Page | null = null;
let _loadedCampaignId: string | null = null;

// Pending relay Promises keyed by nonce, resolved by __aibridge_push__ from the page's MutationObserver.
const pendingRelays = new Map<number, { resolve: (d: unknown) => void; reject: (e: Error) => void }>();
// Tracks which Page instances have had exposeFunction registered (survives navigations on the same Page).
const _exposeFunctionPages = new WeakSet<Page>();

// Injected once per navigation. Sets up a MutationObserver on #textchat that calls
// window.__aibridge_push__(nonceStr, jsonStr) the instant a result node appears —
// eliminates the 100ms polling loop entirely.
const OBSERVER_SCRIPT = `(function() {
  var chat = document.querySelector("#textchat");
  if (!chat || window.__aibridge_observer_installed__) return;
  window.__aibridge_observer_installed__ = true;
  var MARKER = "AIBRIDGE_RESULT:";
  var seen = new Set();
  function scanNode(node) {
    var text = node.textContent || "";
    var pos = text.indexOf(MARKER);
    while (pos !== -1) {
      var start = pos + MARKER.length;
      if (text[start] === "{") {
        var depth = 0, inStr = false, esc = false;
        for (var i = start; i < text.length; i++) {
          var c = text[i];
          if (esc) { esc = false; continue; }
          if (inStr) { if (c === "\\\\") esc = true; else if (c === '"') inStr = false; continue; }
          if (c === '"') { inStr = true; continue; }
          if (c === "{") depth++;
          if (c === "}" && --depth === 0) {
            var json = text.slice(start, i + 1);
            try {
              var obj = JSON.parse(json);
              var key = String(obj.nonce);
              if (!seen.has(key)) { seen.add(key); window.__aibridge_push__(key, json); }
            } catch(e) {}
            break;
          }
        }
      }
      pos = text.indexOf(MARKER, pos + 1);
    }
  }
  new MutationObserver(function(ms) {
    ms.forEach(function(m) { m.addedNodes.forEach(scanNode); });
  }).observe(chat, { childList: true, subtree: true });
})()`;

export async function getEditorPage(): Promise<Page> {
  const { roll20CampaignId } = getActiveCampaign();

  // Discard a cached editor page that's been closed (Roll20 tab/window closed, or the
  // Chromium restarted out from under a long-lived server) — otherwise we keep handing back
  // a dead handle and every relay call fails instantly with "Target page, context or browser
  // has been closed". (DDB stays working in this state because it's a separate page handle.)
  if (_editorPage && _editorPage.isClosed()) {
    _editorPage = null;
    _loadedCampaignId = null;
  }

  if (_editorPage && _loadedCampaignId === roll20CampaignId) return _editorPage;

  const page = _editorPage ?? (await getPage("roll20"));

  // Register exposeFunction once per Page object — persists across navigations.
  if (!_exposeFunctionPages.has(page)) {
    _exposeFunctionPages.add(page);
    // Reject (not just clear) pending relays on navigation so callers fail fast.
    page.on("load", () => {
      for (const { reject } of pendingRelays.values()) reject(new Error("editor page navigated — relay interrupted"));
      pendingRelays.clear();
    });
    await page.exposeFunction("__aibridge_push__", (nonceStr: string, jsonStr: string) => {
      const nonce = parseInt(nonceStr, 10);
      const pending = pendingRelays.get(nonce);
      if (!pending) return;
      pendingRelays.delete(nonce);
      try {
        const parsed = JSON.parse(jsonStr);
        if (parsed.error) pending.reject(new Error("Relay error: " + parsed.error));
        else pending.resolve(parsed.data);
      } catch (e) { pending.reject(e as Error); }
    });
  }

  const url = `https://app.roll20.net/editor/setcampaign/${roll20CampaignId}/`;
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15_000 });
  await page.waitForFunction(
    () => typeof (window as any).Campaign !== "undefined" &&
          typeof (window as any).Campaign.get === "function",
    undefined,
    { timeout: 15_000, polling: 500 }
  );

  // Inject push-receive observer (re-injected after every navigation; guard prevents double-install).
  await page.evaluate(OBSERVER_SCRIPT);

  _editorPage = page;
  _loadedCampaignId = roll20CampaignId;
  return page;
}

// Force a clean rebind of the browser + Roll20 editor page. The bridge self-heals lazily
// (closed handles are evicted on the next call), but a wedged/zombie page can pass the
// isClosed()/isConnected() checks while still failing every command. This explicitly tears
// down BOTH layers — the roll20 editor-page cache here AND the Chromium context in browser.ts
// — then re-acquires from scratch (relaunch or CDP reattach, re-navigate to the active
// campaign, reinstall the chat observer). Exposed as the reconnect_browser MCP tool.
export async function reconnectRoll20(opts: { hard?: boolean } = {}): Promise<{ url: string; hard: boolean }> {
  const hard = opts.hard !== false; // default true
  // Don't leave callers hanging on the dead page's nonces.
  for (const { reject } of pendingRelays.values()) reject(new Error("relay reconnecting"));
  pendingRelays.clear();
  _editorPage = null;
  _loadedCampaignId = null;
  if (hard) {
    // Close the whole Chromium context so a zombie page/browser can't survive the rebind.
    await closeBrowser().catch(() => {});
  }
  const page = await getEditorPage(); // relaunch/reattach + navigate + reinstall observer
  return { url: page.url(), hard };
}

export async function evaluate<T>(fn: () => T): Promise<T> {
  if (_testTransport) return _testTransport.evaluate<T>(fn as (args?: unknown) => T);
  const page = await getEditorPage();
  return page.evaluate(fn);
}

export async function evaluateWithArgs<T>(fn: (args: unknown) => T, args: unknown): Promise<T> {
  if (_testTransport) return _testTransport.evaluate<T>(fn, args);
  const page = await getEditorPage();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return page.evaluate(fn as any, args);
}

// Direct Backbone reads — served from window.Campaign without touching the serial queue or chat.
// Only properties confirmed readable from page context belong here.
const BACKBONE_READS: Record<string, () => unknown> = {
  getTurnOrder: () => {
    const raw = (window as any).Campaign.get("turnorder");
    return raw ? JSON.parse(raw) : [];
  },
};

// --- Client-direct READS ---
// Reads served straight from the browser's live Backbone models (Campaign.activePage().thegraphics,
// Campaign.get("token_markers")) — synchronous, no chat round-trip, no Mod, no timeout. WRITES stay
// on the server-authoritative Mod relay (guaranteed propagation). Each evaluator throws on any
// surprise (page not loaded, token on a non-active page, unexpected client shape) → relayCommand
// catches and falls back to the Mod relay, so this can only ever be faster, never less correct.
// Confirmed live (2026-06-02): `Campaign.activePage().thegraphics` is the token collection with
// `.get(id)`; models expose `.get(attr)`. `window.d20` no longer exists in this build.
type ClientRead = (page: Page, args: Record<string, any>) => Promise<unknown>;

// Pages the automation browser actually has graphics loaded for: the page it's VIEWING
// (activePage) and the PLAYER-ribbon page (where combat tokens live). Any other page may have
// unloaded graphics that only the server-side Mod can see — so we never serve those client-side.
// Each evaluator re-derives this guard inline (page.evaluate can't close over Node scope).

const CLIENT_READS: Record<string, ClientRead> = {
  // Mirrors the Mod's tokenSummary(profile) shape exactly. Serves only a loaded page (player/active).
  getTokens: (page, args) => page.evaluate((a: any) => {
    const C = (window as any).Campaign;
    if (!C) throw new Error("Campaign not ready");
    const playerId = C.get("playerpageid");
    const activeId = C.activePage ? C.activePage().id : null;
    const pid = a.pageId || playerId;                  // combat reads target the PLAYER page, not activePage
    if (!pid) throw new Error("no player page set in Backbone → RT/Mod");
    if (pid !== playerId && pid !== activeId) throw new Error("page " + pid + " not loaded client-side → Mod");
    const pg = C.pages && C.pages.get ? C.pages.get(pid) : null;
    if (!pg || !pg.thegraphics || !pg.thegraphics.models || pg.thegraphics.models.length === 0) throw new Error("graphics not loaded for " + pid + " → Mod");
    const profile = a.profile || "full";
    return pg.thegraphics.models.map((g: any) => {
      const s: any = { id: g.id, name: g.get("name"), represents: g.get("represents") || "", controlledby: g.get("controlledby") || "", layer: g.get("layer") };
      if (profile === "lean") return s;
      s.bar1_value = g.get("bar1_value"); s.bar1_max = g.get("bar1_max"); s.statusmarkers = g.get("statusmarkers");
      if (profile === "status") return s;
      s.left = g.get("left"); s.top = g.get("top"); s.width = g.get("width"); s.height = g.get("height");
      return s;
    });
  }, args),

  // Full token props. Searches the loaded pages (player + active); throws if not found so the Mod
  // (global getObj) does the authoritative lookup across all pages.
  getTokenById: (page, args) => page.evaluate((a: any) => {
    const C = (window as any).Campaign;
    const ids = [C.get("playerpageid"), C.activePage ? C.activePage().id : null].filter(Boolean);
    let g: any = null;
    for (const pid of ids) {
      const pg = C.pages && C.pages.get ? C.pages.get(pid) : null;
      if (pg && pg.thegraphics && pg.thegraphics.get) { const f = pg.thegraphics.get(a.tokenId); if (f) { g = f; break; } }
    }
    if (!g) throw new Error("token not on loaded pages: " + a.tokenId);
    return {
      id: g.id, name: g.get("name"), represents: g.get("represents") || "", layer: g.get("layer"),
      controlledby: g.get("controlledby") || "", left: g.get("left"), top: g.get("top"),
      width: g.get("width"), height: g.get("height"), rotation: g.get("rotation"),
      imgsrc: g.get("imgsrc"), statusmarkers: g.get("statusmarkers") || "",
      bar1_value: g.get("bar1_value"), bar1_max: g.get("bar1_max"),
      bar2_value: g.get("bar2_value"), bar2_max: g.get("bar2_max"),
      bar3_value: g.get("bar3_value"), bar3_max: g.get("bar3_max"),
      aura1_radius: g.get("aura1_radius"), aura1_color: g.get("aura1_color"), aura1_square: g.get("aura1_square"), showplayers_aura1: g.get("showplayers_aura1"),
      aura2_radius: g.get("aura2_radius"), aura2_color: g.get("aura2_color"), aura2_square: g.get("aura2_square"), showplayers_aura2: g.get("showplayers_aura2"),
      tint_color: g.get("tint_color"), light_radius: g.get("light_radius"), light_dimradius: g.get("light_dimradius"),
      gmnotes: g.get("gmnotes") || "",
    };
  }, args),

  // Mirrors the Mod's findTokensInRange (page scale → ft, nearest-first). Loaded page only.
  findTokensInRange: (page, args) => page.evaluate((a: any) => {
    const C = (window as any).Campaign;
    if (!C) throw new Error("Campaign not ready");
    const playerId = C.get("playerpageid");
    const activeId = C.activePage ? C.activePage().id : null;
    const pid = a.pageId || playerId;
    if (!pid) throw new Error("no player page set in Backbone → RT/Mod");
    if (pid !== playerId && pid !== activeId) throw new Error("page " + pid + " not loaded client-side → Mod");
    const pg = C.pages && C.pages.get ? C.pages.get(pid) : null;
    if (!pg || !pg.thegraphics) throw new Error("graphics not loaded for " + pid);
    const center = pg.thegraphics.get(a.centerTokenId);
    if (!center) throw new Error("center token not found: " + a.centerTokenId);
    const pixelsPerFoot = 70 / (pg.get("scale_number") || 5);
    const cx = center.get("left"), cy = center.get("top");
    const radiusFeet = a.radiusFeet || 15;
    const results: any[] = [];
    pg.thegraphics.models.forEach((g: any) => {
      if (g.id === a.centerTokenId) return;
      if (a.layerFilter && g.get("layer") !== a.layerFilter) return;
      const dx = g.get("left") - cx, dy = g.get("top") - cy;
      const distFeet = Math.sqrt(dx * dx + dy * dy) / pixelsPerFoot;
      if (distFeet <= radiusFeet) results.push({ id: g.id, name: g.get("name"), layer: g.get("layer"), distanceFeet: Math.round(distFeet * 10) / 10, bar1_value: g.get("bar1_value"), bar1_max: g.get("bar1_max"), controlledby: g.get("controlledby") || "" });
    });
    results.sort((x, y) => x.distanceFeet - y.distanceFeet);
    return results;
  }, args),

  // Campaign-level marker registry (mirrors the Mod's getTokenMarkers).
  getTokenMarkers: (page) => page.evaluate(() => {
    const C = (window as any).Campaign;
    const raw = C.get("token_markers");
    const m = typeof raw === "string" ? JSON.parse(raw) : (raw || []);
    return m.map((x: any) => ({ id: x.id, name: x.name, tag: x.tag }));
  }),
};

async function sendToChat(page: Page, payload: string): Promise<void> {
  await page.evaluate(() => {
    const chatTab = document.querySelector<HTMLElement>("a[href='#textchat']");
    chatTab?.click();
  });
  const chatInput = await page.waitForSelector("#textchat-input textarea", { state: "attached", timeout: 15_000 });
  await chatInput.fill("!ai-relay " + payload);
  await page.evaluate(() => {
    const ta = document.querySelector<HTMLTextAreaElement>("#textchat-input textarea");
    ta?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, keyCode: 13, which: 13 }));
  });
  await chatInput.press("Enter");
}

async function relayCommandOnce<T>(page: Page, cmd: Record<string, unknown>, nonce: number): Promise<T | null> {
  const payload = JSON.stringify({ ...cmd, nonce });

  // Register before sending — avoids a race where the result arrives before we're listening.
  const resultPromise = new Promise<T | null>((resolve, reject) => {
    const timer = setTimeout(() => { pendingRelays.delete(nonce); resolve(null); }, RELAY_TIMEOUT_MS);
    pendingRelays.set(nonce, {
      resolve: (data) => { clearTimeout(timer); resolve(data as T); },
      reject: (err)  => { clearTimeout(timer); reject(err); },
    });
  });

  await sendToChat(page, payload);
  return resultPromise;
}

// Serial queue — concurrent callers wait their turn so they never race for the chat input.
let _relayQueue: Promise<unknown> = Promise.resolve();

export function relayCommand<T>(cmd: Record<string, unknown>): Promise<T> {
  // Test harness routes every relay action through the in-memory emulator (bypasses rt/browser).
  if (_testTransport) return _testTransport.relay<T>(cmd);

  // BROWSERLESS by default (ROLL20_TRANSPORT=rt, the default): push !ai-relay over Firebase RTDB and
  // read the Mod's AIBRIDGE_RESULT back. The Mod runs every action, so RT serves all of them — no
  // browser involved. There is deliberately NO silent Playwright fallback here: a packaged install
  // ships no browser, so an RT failure must SURFACE (and prompt a token re-harvest in the gem),
  // never quietly reach for a Chromium that isn't there. The legacy browser→chat relay is an
  // explicit dev opt-out via ROLL20_TRANSPORT=browser.
  if (rtEnabled()) {
    const action = cmd.action as string;

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
        `Reconnect Roll20 in the gem to re-harvest the token — combat does not fall back to a browser. ` +
        `(Dev: set ROLL20_TRANSPORT=browser for the legacy browser relay.)`,
      );
    });
  }
  return _relayDefault<T>(cmd);
}

function _relayDefault<T>(cmd: Record<string, unknown>): Promise<T> {
  return _relayDefaultWithNonce<T>(cmd, undefined);
}

// Variant that accepts a pre-assigned nonce (from relayCommand's centralized generator).
// The nonce is threaded down to _relayCommandRaw so that rt→browser fallbacks re-send the
// same nonce, enabling idempotent deduplication in the Mod's PROCESSED_NONCES LRU.
function _relayDefaultWithNonce<T>(cmd: Record<string, unknown>, nonce: number | undefined): Promise<T> {
  const action = cmd.action as string;

  // Client-direct reads: serve from the browser's live Backbone models. On ANY error, fall back
  // to the Mod relay — so this is strictly faster-or-equal, never less correct.
  // (Client-direct reads don't use the Mod nonce, so nonce is not threaded here.)
  const client = CLIENT_READS[action];
  if (client) {
    return getEditorPage()
      .then((page) => client(page, cmd as Record<string, any>) as Promise<T>)
      .catch((err) => {
        console.error(`[roll20] client-direct ${action} → relay fallback: ${(err as Error).message}`);
        return _relayViaChat<T>(cmd, nonce);
      });
  }

  // Legacy zero-arg Backbone reads (turn order).
  const reader = BACKBONE_READS[action];
  if (reader) {
    return getEditorPage().then((page) => page.evaluate(reader as () => T));
  }

  return _relayViaChat<T>(cmd, nonce);
}

// The original chat-relay path: serialized queue → !ai-relay command → AIBRIDGE_RESULT round-trip.
// Used for writes and anything without a client-direct evaluator.
// `preAssignedNonce` is threaded from relayCommand (via _relayDefaultWithNonce) so that an
// rt→browser fallback re-sends the same nonce, enabling idempotent Mod deduplication.
function _relayViaChat<T>(cmd: Record<string, unknown>, preAssignedNonce?: number): Promise<T> {
  const queued = _relayQueue.then(() => _relayCommandRaw<T>(cmd, preAssignedNonce));
  _relayQueue = queued.catch(() => {});
  return queued;
}

async function _relayCommandRaw<T>(cmd: Record<string, unknown>, preAssignedNonce?: number): Promise<T> {
  const page = await getEditorPage();

  // Use the caller-provided nonce when present (cross-transport fallback with same nonce for
  // Mod-side deduplication); otherwise generate a fresh one for direct browser-path calls.
  const nonce = preAssignedNonce !== undefined ? preAssignedNonce : newNonce();
  const result = await relayCommandOnce<T>(page, cmd, nonce);
  if (result !== null) { recordSuccess("browser"); return result; }

  const isReadOnly = READONLY_ACTIONS.has(cmd.action as string);
  if (!isReadOnly) {
    // Mutating write timed out. Re-send ONCE with the SAME nonce — the Mod's PROCESSED_NONCES
    // LRU (ai-relay.js) will deduplicate the resend if the original already ran, making this safe.
    // We can re-register the pending promise under the same nonce because relayCommandOnce already
    // removed it from pendingRelays on timeout (resolved to null).
    //
    // NOTE: Until the updated ai-relay.js is deployed in Roll20, an OLD Mod script will re-execute
    // the same-nonce retry as a fresh command (no deduplication). This is no worse than the previous
    // behaviour of failing loudly without retrying — but the DM must redeploy the Mod for full safety.
    console.error(`[roll20] mutating timeout for '${cmd.action}' (nonce=${nonce}) — retrying once with same nonce`);
    await new Promise((r) => setTimeout(r, 2_000));
    const retryResult = await relayCommandOnce<T>(page, cmd, nonce);
    if (retryResult !== null) { recordSuccess("browser"); return retryResult; }

    const chatDump = await page.evaluate(() => {
      const el = document.querySelector("#textchat") ?? document.body;
      return el.textContent?.slice(-800) ?? "(empty)";
    });
    recordFailure("browser");
    throw new Error(
      `Relay timeout for mutating action '${cmd.action}' (nonce=${nonce}) — one same-nonce retry also timed out. ` +
      `If Mod deduplication is active, the action may have run once; verify state in Roll20 before resending.\nChat tail: ${chatDump}`
    );
  }

  // Read-only action — safe to retry with a fresh nonce. Relay may have been restarting.
  await new Promise((r) => setTimeout(r, 4_000));
  const retryNonce = newNonce();
  const retryResult = await relayCommandOnce<T>(page, cmd, retryNonce);
  if (retryResult !== null) { recordSuccess("browser"); return retryResult; }

  const chatDump = await page.evaluate(() => {
    const el = document.querySelector("#textchat") ?? document.body;
    return el.textContent?.slice(-800) ?? "(empty)";
  });
  recordFailure("browser");
  throw new Error(`Relay timeout after ${RELAY_TIMEOUT_MS}ms for command: ${cmd.action}\nChat tail: ${chatDump}`);
}

// --- Browserless upload cache (mirrors RTDB/DDB session-cookie harvest pattern) ---
// On first successful Playwright upload we capture: the endpoint Roll20's Dropzone POSTed to,
// and the session cookies. Subsequent uploads skip the browser entirely.

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

export async function uploadArt(localAbsPath: string): Promise<string> {
  // Fast path: try direct HTTP with cached credentials (no browser needed).
  const cache = readUploadCache();
  if (cache) {
    try {
      return await uploadArtDirect(localAbsPath, cache);
    } catch (e) {
      console.error(`[roll20] direct upload failed, falling back to Playwright: ${(e as Error).message}`);
      // Invalidate the cache so the next Playwright upload refreshes it.
      try { writeUploadCache({ ...cache, harvestedAt: 0 }); } catch {}
    }
  }

  // Playwright path — used on first upload or after a direct-upload failure.
  const page = await getEditorPage();

  // Dismiss any open art library dialog before starting — Roll20's file input loses its
  // change-event listener after one upload, so re-opening fresh is the only reliable way
  // to get a new listener for sequential uploads. Without this, every second upload hangs.
  await page.evaluate(() => {
    const dialog = document.getElementById("imagedialog");
    if (!dialog) return;
    // Try Bootstrap .modal('hide') if jQuery is present
    try { const jq = (window as unknown as Record<string, unknown>)["$"] as ((s: string) => Record<string, (a: string) => void>) | undefined; jq?.("#imagedialog")?.["modal"]?.("hide"); } catch {}
    // Fallback: click the × close button
    const closeBtn = dialog.querySelector<HTMLElement>(".close, button[data-dismiss='modal']");
    if (closeBtn) closeBtn.click();
  }).catch(() => {});
  await new Promise(r => setTimeout(r, 500));

  // Intercept ALL network responses during the upload window and log them for diagnostics.
  // Roll20 Jumpgate may PUT to S3/R2 (not POST to Roll20), so we capture any method.
  let capturedUrl: string | null = null;
  const uploadLog: string[] = [];
  const onResponse = async (response: import("playwright").Response) => {
    const method = response.request().method();
    const url = response.url();
    try {
      const ct = response.headers()["content-type"] ?? "";
      if (ct.includes("json")) {
        const body = await response.json().catch(() => null);
        const found = extractCdnUrl(body);
        uploadLog.push(`${method} ${url} JSON: ${JSON.stringify(body).slice(0, 300)}`);
        if (found && !capturedUrl) capturedUrl = found;
      } else if (ct.includes("xml") || ct.includes("text")) {
        const text = await response.text().catch(() => "");
        uploadLog.push(`${method} ${url} TEXT: ${text.slice(0, 300)}`);
        // Roll20 often returns JSON with Content-Type: text/plain — try parsing it
        if (text.trimStart().startsWith("{")) {
          try {
            const parsed = JSON.parse(text) as unknown;
            const found = extractCdnUrl(parsed);
            if (found && !capturedUrl) capturedUrl = found;
          } catch { /* not JSON */ }
        }
        // Some CDN responses embed the URL in XML Location or <Location> element
        const xmlLoc = text.match(/<Location>(https?:\/\/[^<]+)<\/Location>/)?.[1];
        if (xmlLoc && isCdnUrl(xmlLoc) && !capturedUrl) capturedUrl = xmlLoc;
      } else if (isCdnUrl(url)) {
        uploadLog.push(`${method} ${url} (CDN request)`);
      }
    } catch { /* ignore */ }
  };
  page.on("response", onResponse);

  try {
    // Open art library panel
    await page.evaluate(() => {
      const el = document.querySelector<HTMLElement>("a[href='#imagedialog']");
      if (!el) throw new Error("Art library tab not found");
      el.click();
    });
    await new Promise(r => setTimeout(r, 600));

    await page.evaluate(() => {
      const btn = document.querySelector<HTMLElement>("button.btn.showuploaddialog");
      if (!btn) throw new Error("showuploaddialog button not found");
      btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await new Promise(r => setTimeout(r, 800));

    // Snapshot ALL img.src values before upload (not filtered by URL pattern,
    // because Jumpgate may use a different CDN domain/path than the old regex assumed).
    const preUploadImgs = await page.evaluate(() =>
      Array.from(document.querySelectorAll<HTMLImageElement>("img"))
        .map(i => i.src).filter(Boolean)
    ).catch(() => [] as string[]);
    const preSet = new Set(preUploadImgs);

    // Always trigger via filechooser — using the stale hidden input directly causes every
    // second upload to silently fail (the change-event listener is consumed after first use).
    // Clicking the dropzone button forces Roll20 to open a fresh file picker with a new listener.
    const [fileChooser] = await Promise.all([
      page.waitForEvent("filechooser", { timeout: 15_000 }),
      page.evaluate(() => {
        const btn = document.querySelector<HTMLElement>("button.file-uploader__dropzone-button");
        const inp = document.querySelector<HTMLElement>("input[type='file']");
        const target = btn ?? inp;
        if (!target) throw new Error("upload button/input not found");
        target.click();
      }),
    ]);
    await fileChooser.setFiles(localAbsPath);

    // Poll for a new img.src that (a) wasn't there before and (b) looks like a CDN URL.
    // Also check data-src (lazy-load pattern). Derive "original" from whatever thumb URL we find.
    const deadline = Date.now() + 120_000;
    while (!capturedUrl && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 2000));
      if (!capturedUrl) {
        capturedUrl = await page.evaluate((args: { preSet: string[] }) => {
          const pre = new Set(args.preSet);
          const isCdn = (s: string) =>
            s.startsWith("http") && (s.includes("d20.io") || s.includes("roll20.net") || s.includes("cloudfront.net"));
          // Check img.src and img[data-src]
          for (const img of Array.from(document.querySelectorAll<HTMLImageElement>("img"))) {
            for (const src of [img.src, img.dataset["src"] ?? ""]) {
              if (src && !pre.has(src) && isCdn(src)) {
                // Normalise to "original": strip thumb suffix variants
                return src
                  .replace(/\/thumb\.webp(\?.*)?$/, "/original.webp")
                  .replace(/\/thumb\.jpg(\?.*)?$/, "/original.webp")
                  .replace(/[?&]thumb=[^&]*/, "");
              }
            }
          }
          return null;
        }, { preSet: preUploadImgs }).catch(() => null);
      }
    }

    // Write diagnostic log regardless of outcome
    const { writeFileSync } = await import("fs");
    const logPath = dataPath("upload-debug.log");
    writeFileSync(logPath, [`=== upload ${path.basename(localAbsPath)} ${new Date().toISOString()} ===`, ...uploadLog, `capturedUrl: ${capturedUrl ?? "null"}`].join("\n") + "\n", { flag: "a" });

    if (!capturedUrl) {
      throw new Error(
        "Art upload timed out — Roll20 upload response not detected. " +
        "The file may have uploaded — check Roll20 art library and use place_map_image with the URL manually."
      );
    }

    return capturedUrl;
  } finally {
    page.off("response", onResponse);
    // Reset art library UI state so sequential uploads start clean
    await page.evaluate(() => {
      const close = document.querySelector<HTMLElement>("#imagedialog .close, #imagedialog [data-dismiss]");
      if (close) close.click();
    }).catch(() => {});
  }
}

export async function getTokens(pageId: string) {
  return relayCommand<{ id: string; name: string; bar1_value: number; bar1_max: number }[]>({
    action: "getTokens",
    pageId,
  });
}

export async function getCurrentPageId(): Promise<string> {
  // Under rt, read the authoritative player page straight from RTDB — no browser.
  // The browser path reads window.Campaign, which returns `false` (or a stale id)
  // whenever the attached Chrome isn't sitting on THIS campaign; rt is the source
  // of truth for ROLL20_TRANSPORT=rt and keeps the browserless path browserless.
  if (rtEnabled()) {
    try {
      const c = await rtGet<{ playerpageid?: unknown }>("campaign");
      const pid = c?.playerpageid;
      if (typeof pid === "string" && pid) return pid;
    } catch { /* fall through to the browser read */ }
  }
  const pid = await evaluate(() => (window as any).Campaign.get("playerpageid"));
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

export async function takeScreenshot(outputPath: string, clip?: { x: number; y: number; width: number; height: number }, dlEditor = false, timeoutMs = 60000): Promise<void> {
  const page = await getEditorPage();
  if (dlEditor) {
    await page.keyboard.press("Control+,");
    await page.waitForTimeout(400);
  }
  await page.screenshot({ path: outputPath, fullPage: false, timeout: timeoutMs, ...(clip ? { clip } : {}) });
  if (dlEditor) {
    await page.keyboard.press("Control+,");
  }
}

export async function createPageViaUI(
  name: string,
  widthSquares: number,
  heightSquares: number,
  scaleNumber: number,
  scaleUnits: string,
): Promise<string> {
  const page = await getEditorPage();

  // Snapshot existing page IDs so we can identify what's new after creation
  const before = await relayCommand<{ id: string; name: string }[]>({ action: "listPages" });
  const beforeIds = new Set(before.map((p) => p.id));

  // Open the page navigator by clicking the pageList icon in the toolbar
  const navOpened = await page.evaluate(() => {
    const spans = Array.from(document.querySelectorAll("span.grimoire__roll20-icon"));
    const target = spans.find((s) => s.textContent?.trim() === "pageList");
    if (!target) return false;
    const btn = target.closest("button") ?? (target as HTMLElement);
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    return true;
  });
  if (!navOpened) throw new Error("Could not find the pageList icon to open the page navigator.");
  await new Promise((r) => setTimeout(r, 600));

  // Click Create Page via JS dispatch using the stable test-id
  const createClicked = await page.evaluate(() => {
    const btn = document.querySelector<HTMLElement>('[data-test-id="test-create-page-button"]');
    if (!btn) return false;
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    return true;
  });
  if (!createClicked) throw new Error("Could not find 'Create Page' button ([data-test-id='test-create-page-button']) after opening page navigator.");
  await new Promise((r) => setTimeout(r, 800));

  // Handle dialog — Roll20 may show a jQuery UI dialog or a SweetAlert prompt for the page name
  const dialogInputSelectors = [
    ".ui-dialog input[type='text']",
    "[role='dialog'] input[type='text']",
    ".sweet-alert input",
    ".swal2-input",
    "dialog input[type='text']",
  ];
  let named = false;
  for (const sel of dialogInputSelectors) {
    const input = page.locator(sel).first();
    if (await input.isVisible({ timeout: 1500 }).catch(() => false)) {
      await input.fill(name);
      // Confirm — try common confirm button patterns
      const confirm = page.locator(
        ".ui-dialog button:has-text('OK'), [role='dialog'] button:has-text('Create'), " +
        ".sweet-alert button.confirm, .swal2-confirm, button:has-text('OK')"
      ).first();
      await confirm.click({ timeout: 5_000 });
      named = true;
      break;
    }
  }

  await new Promise((r) => setTimeout(r, 1200));

  // Find the newly created page by diffing the page list
  let newPage: { id: string; name: string } | undefined;
  for (let attempt = 0; attempt < 5; attempt++) {
    const after = await relayCommand<{ id: string; name: string }[]>({ action: "listPages" });
    newPage = after.find((p) => !beforeIds.has(p.id));
    if (newPage) break;
    await new Promise((r) => setTimeout(r, 800));
  }
  if (!newPage) throw new Error(`Page creation via UI timed out — no new page appeared in listPages after clicking Create Page`);

  // If the dialog didn't fire (Roll20 created with a default name), rename via setPageProps
  if (!named || newPage.name.toLowerCase() !== name.toLowerCase()) {
    await relayCommand({
      action: "setPageProps",
      pageId: newPage.id,
      name,
      width: widthSquares,
      height: heightSquares,
      scale_number: scaleNumber,
      scale_units: scaleUnits,
      showgrid: true,
    });
  } else {
    await relayCommand({
      action: "setPageProps",
      pageId: newPage.id,
      width: widthSquares,
      height: heightSquares,
      scale_number: scaleNumber,
      scale_units: scaleUnits,
      showgrid: true,
    });
  }

  return newPage.id;
}
