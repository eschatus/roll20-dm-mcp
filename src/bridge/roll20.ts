import { Page } from "playwright";
import { getPage, closeBrowser } from "./browser.js";
import { getActiveCampaign } from "../registry/campaigns.js";
import { rtEnabled, rtRelayCommand } from "./roll20-rt.js";

const RELAY_TIMEOUT_MS = 30_000;

// Strictly-increasing nonce. Seeded from Date.now() so it stays unique across
// server restarts; ++ guarantees no two in-process commands ever collide.
let _nonce = Date.now();
const newNonce = () => ++_nonce;

// Read-only actions are safe to silently auto-retry on timeout (re-running them
// has no side effects). Everything else is a mutating write: re-sending a write
// with a fresh nonce can double-apply damage / duplicate tokens / double-advance
// the turn. Writes are made idempotent in the sandbox (last-nonce echo), but the
// TS side still must NOT null-retry them with a *new* nonce.
const READONLY_ACTIONS = new Set<string>([
  "getTokens", "getSelection", "getTokenById", "getWalls", "debugPage",
  "getPaths", "getDoors", "listPages", "getTurnOrder", "getRecentChat",
  "getDmInbox", "getTurnHookState", "getCharacterAttributes", "getRepeatingSection",
  "getTokenMarkers", "getCustomStates", "listZones", "findTokensInZone",
  "findTokensInRange", "getJournalFolder", "ping",
]);

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

async function getEditorPage(): Promise<Page> {
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
    // Clear stale pending relays when the page navigates away.
    page.on("load", () => pendingRelays.clear());
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
    if (!pg || !pg.thegraphics || !pg.thegraphics.models) throw new Error("graphics not loaded for " + pid);
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

  // Browserless realtime transport (ROLL20_TRANSPORT=rt): push !ai-relay over Firebase and read
  // the Mod's AIBRIDGE_RESULT back. The Mod handles every action, so RT can serve all of them.
  // On ANY failure (auth, timeout, disconnect) fall back to the Playwright relay below — so
  // enabling RT can only ever be faster/lighter, never less capable.
  if (rtEnabled()) {
    return rtRelayCommand<T>(cmd).catch((err) => {
      console.error(`[roll20] rt transport ${cmd.action} → browser fallback: ${(err as Error).message}`);
      return _relayDefault<T>(cmd);
    });
  }
  return _relayDefault<T>(cmd);
}

function _relayDefault<T>(cmd: Record<string, unknown>): Promise<T> {
  const action = cmd.action as string;

  // Client-direct reads: serve from the browser's live Backbone models. On ANY error, fall back
  // to the Mod relay — so this is strictly faster-or-equal, never less correct.
  const client = CLIENT_READS[action];
  if (client) {
    return getEditorPage()
      .then((page) => client(page, cmd as Record<string, any>) as Promise<T>)
      .catch((err) => {
        console.error(`[roll20] client-direct ${action} → relay fallback: ${(err as Error).message}`);
        return _relayViaChat<T>(cmd);
      });
  }

  // Legacy zero-arg Backbone reads (turn order).
  const reader = BACKBONE_READS[action];
  if (reader) {
    return getEditorPage().then((page) => page.evaluate(reader as () => T));
  }

  return _relayViaChat<T>(cmd);
}

// The original chat-relay path: serialized queue → !ai-relay command → AIBRIDGE_RESULT round-trip.
// Used for writes and anything without a client-direct evaluator.
function _relayViaChat<T>(cmd: Record<string, unknown>): Promise<T> {
  const queued = _relayQueue.then(() => _relayCommandRaw<T>(cmd));
  _relayQueue = queued.catch(() => {});
  return queued;
}

async function _relayCommandRaw<T>(cmd: Record<string, unknown>): Promise<T> {
  const page = await getEditorPage();

  const nonce = newNonce();
  const result = await relayCommandOnce<T>(page, cmd, nonce);
  if (result !== null) return result;

  const isReadOnly = READONLY_ACTIONS.has(cmd.action as string);
  if (!isReadOnly) {
    // Mutating write that timed out — re-sending with a fresh nonce risks a
    // double-apply (the original may still land in the sandbox). Reject instead
    // of blindly retrying. (Sandbox-side last-nonce echo makes a *same-nonce*
    // resend idempotent, but we don't have a safe channel to resend the same
    // nonce after our listener was torn down, so we fail loud.)
    const chatDump = await page.evaluate(() => {
      const el = document.querySelector("#textchat") ?? document.body;
      return el.textContent?.slice(-800) ?? "(empty)";
    });
    throw new Error(`Relay timeout after ${RELAY_TIMEOUT_MS}ms for mutating action '${cmd.action}' — not auto-retried to avoid double-apply. Verify state before resending.\nChat tail: ${chatDump}`);
  }

  // Read-only action — safe to retry. Relay may have been restarting; wait and retry with a fresh nonce.
  await new Promise((r) => setTimeout(r, 4_000));
  const retryNonce = newNonce();
  const retryResult = await relayCommandOnce<T>(page, cmd, retryNonce);
  if (retryResult !== null) return retryResult;

  const chatDump = await page.evaluate(() => {
    const el = document.querySelector("#textchat") ?? document.body;
    return el.textContent?.slice(-800) ?? "(empty)";
  });
  throw new Error(`Relay timeout after ${RELAY_TIMEOUT_MS}ms for command: ${cmd.action}\nChat tail: ${chatDump}`);
}

export async function uploadArt(localAbsPath: string): Promise<string> {
  const page = await getEditorPage();

  // Step 1: open the art library panel (#imagedialog tab)
  await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>("a[href='#imagedialog']");
    if (!el) throw new Error("Art library tab not found");
    el.click();
  });
  await new Promise(r => setTimeout(r, 600));

  // Force-click the showuploaddialog button even if not visible
  await page.evaluate(() => {
    const btn = document.querySelector<HTMLElement>("button.btn.showuploaddialog");
    if (!btn) throw new Error("showuploaddialog button not found");
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await new Promise(r => setTimeout(r, 800));

  // Snapshot all current Roll20 CDN URLs in the page before upload.
  const beforeUrls = new Set(await page.evaluate(() => {
    const urls: string[] = [];
    document.querySelectorAll("*").forEach(el => {
      for (const attr of Array.from(el.attributes)) {
        if ((attr.value.includes("d20.io") || attr.value.includes("files.roll20")) && attr.value.startsWith("http")) {
          urls.push(attr.value);
        }
      }
    });
    return urls;
  }));

  // Click "Browse Files" and intercept the file chooser Dropzone opens.
  const [fileChooser] = await Promise.all([
    page.waitForEvent("filechooser", { timeout: 15_000 }),
    page.click("button.file-uploader__dropzone-button"),
  ]);
  await fileChooser.setFiles(localAbsPath);

  // Poll every attribute on every element for a new CDN URL that appeared after upload.
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 500));
    const newUrl = await page.evaluate((before: string[]) => {
      const beforeSet = new Set(before);
      const els = Array.from(document.querySelectorAll("*"));
      for (const el of els) {
        for (const attr of Array.from(el.attributes)) {
          const v = attr.value;
          if ((v.includes("d20.io") || v.includes("files.roll20")) && v.startsWith("http") && !beforeSet.has(v)) {
            return v;
          }
        }
        // Also check img src directly
        if (el instanceof HTMLImageElement) {
          const src = el.src;
          if ((src.includes("d20.io") || src.includes("files.roll20")) && !beforeSet.has(src)) return src;
        }
      }
      return null;
    }, Array.from(beforeUrls));
    if (newUrl) return newUrl;
  }

  throw new Error("Art upload timed out — could not find new CDN URL after upload. The file may have uploaded — check Roll20 art library and use place_map_image with the URL manually.");
}

export async function getTokens(pageId: string) {
  return relayCommand<{ id: string; name: string; bar1_value: number; bar1_max: number }[]>({
    action: "getTokens",
    pageId,
  });
}

export async function getCurrentPageId(): Promise<string> {
  return evaluate(() => (window as any).Campaign.get("playerpageid") as string);
}

export async function takeScreenshot(outputPath: string): Promise<void> {
  const page = await getEditorPage();
  await page.screenshot({ path: outputPath, fullPage: false });
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
