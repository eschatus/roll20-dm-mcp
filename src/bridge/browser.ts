import { chromium, BrowserContext, Page } from "playwright";
import path from "path";

type Site = "roll20" | "ddb";

const SITE_URLS: Record<Site, string> = {
  roll20: "https://app.roll20.net/",
  ddb: "https://www.dndbeyond.com/",
};

const LOGIN_URLS: Record<Site, string> = {
  roll20: "https://app.roll20.net/sessions/new",
  ddb: "https://www.dndbeyond.com/login",
};

// Port used for CDP reattachment across server restarts and multi-server setups.
const DEBUG_PORT = parseInt(process.env.BROWSER_DEBUG_PORT ?? "9222", 10);

// Cache the in-flight promise so concurrent callers await the same launch,
// rather than each racing to call launchPersistentContext with the same profile dir.
let _contextPromise: Promise<BrowserContext> | null = null;

async function tryConnectCDP(timeoutMs: number): Promise<BrowserContext | null> {
  try {
    const browser = await chromium.connectOverCDP(`http://localhost:${DEBUG_PORT}`, { timeout: timeoutMs });
    return browser.contexts()[0] ?? await browser.newContext();
  } catch {
    return null;
  }
}

// Hide the automation browser to the taskbar by default (DMW_BROWSER_HIDE=0 keeps
// it visible). It still runs/renders normally — just out of the way. We can restore
// it when a manual login is needed so the GM is never locked out.
const HIDE_BROWSER = process.env.DMW_BROWSER_HIDE !== "0";

// Drive the OS window state via CDP Browser.setWindowBounds (windowState:
// "minimized" | "normal"). Playwright has no window-state API, so we reach the
// raw CDP session through the page's context.
async function setBrowserWindowState(page: Page, state: "minimized" | "normal"): Promise<void> {
  try {
    const session = await page.context().newCDPSession(page);
    const { windowId } = await session.send("Browser.getWindowForTarget");
    await session.send("Browser.setWindowBounds", { windowId, bounds: { windowState: state } });
    await session.detach().catch(() => {});
  } catch {
    // Best effort — never let window chrome block the relay.
  }
}

// Bring the browser back so the GM can complete a manual login, then it can be
// re-minimized by the caller.
export async function restoreBrowserWindow(): Promise<void> {
  const ctx = await getContext();
  const page = ctx.pages()[0];
  if (page) await setBrowserWindowState(page, "normal");
}

// Is this context's browser still alive? A cached context whose browser was
// closed (manual close, crash, or a sibling server restart killing the launch)
// would otherwise be handed back forever, every call throwing "Target page,
// context or browser has been closed". connectOverCDP and launchPersistentContext
// both expose the Browser via .browser(); isConnected() is the cheap truth.
function contextAlive(ctx: BrowserContext): boolean {
  try {
    const b = ctx.browser();
    return b ? b.isConnected() : true; // no handle → can't disprove; trust per-page checks
  } catch {
    return false;
  }
}

async function getContext(): Promise<BrowserContext> {
  // Validate a cached context before reuse; evict dead handles so we relaunch.
  if (_contextPromise) {
    try {
      const ctx = await _contextPromise;
      if (contextAlive(ctx)) return ctx;
    } catch { /* failed launch — fall through to rebuild */ }
    _contextPromise = null;
    for (const s of Object.keys(_pagePromises) as Site[]) delete _pagePromises[s];
  }
  if (!_contextPromise) {
    const userDataDir = path.resolve(
      process.env.BROWSER_USER_DATA_DIR ?? "./data/browser-session"
    );
    _contextPromise = (async () => {
      // Fast path: attach to a browser that's already running (handles MCP server restarts
      // and multi-server setups where another process already owns the profile dir).
      const cdpCtx = await tryConnectCDP(2_000);
      if (cdpCtx) return cdpCtx;

      // No existing browser — launch a fresh persistent context with the debug port
      // enabled so future server attaches can reuse it via CDP.
      try {
        // Window + viewport size. Smaller = less to rasterize (memory/GPU) and a
        // less obtrusive window. Roll20 still works at a modest size; bump via
        // DMW_BROWSER_W/H if a tool needs more of the map visible at once.
        const winW = Number(process.env.DMW_BROWSER_W) || 1280;
        const winH = Number(process.env.DMW_BROWSER_H) || 800;
        const launched = await chromium.launchPersistentContext(userDataDir, {
          headless: false,
          viewport: { width: winW, height: winH },
          args: [
            "--disable-blink-features=AutomationControlled",
            `--remote-debugging-port=${DEBUG_PORT}`,
            // Set the actual OS window size/position so it isn't a giant window.
            `--window-size=${winW},${winH}`,
            `--window-position=${process.env.DMW_BROWSER_X || 40},${process.env.DMW_BROWSER_Y || 40}`,
            // --- Footprint reduction ---
            // Roll20's map canvas needs WebGL, so we keep GPU on but cap and trim
            // everything around it. Override with DMW_BROWSER_LIGHT=0 to disable.
            ...(process.env.DMW_BROWSER_LIGHT === "0" ? [] : [
              // memory: cap the JS heap and tile/raster memory the VTT can hog
              "--js-flags=--max-old-space-size=512",
              "--force-gpu-mem-available-mb=512",
              "--disable-dev-shm-usage",
              // trim subsystems we never use in an automated VTT tab
              "--disable-extensions",
              "--disable-component-update",
              "--disable-background-networking",
              "--disable-sync",
              "--disable-translate",
              "--mute-audio",
              "--metrics-recording-only",
              "--no-first-run",
              // don't throttle/zero out the tab when it's not focused (we drive it
              // in the background), but do let renderer back the framebuffer off
              "--disable-features=CalculateNativeWinOcclusion,MediaRouter",
            ]),
          ],
        });
        // Tuck the window to the taskbar on a fresh launch (it still renders).
        if (HIDE_BROWSER) {
          const p0 = launched.pages()[0] ?? await launched.newPage();
          await setBrowserWindowState(p0, "minimized");
        }
        return launched;
      } catch {
        // Profile is locked — another server process won the race to launch.
        // Wait for it to finish opening, then connect via CDP.
        await new Promise(r => setTimeout(r, 3_500));
        const retryCtx = await tryConnectCDP(8_000);
        if (retryCtx) return retryCtx;
        throw new Error(
          `Browser profile locked and CDP on port ${DEBUG_PORT} unavailable. ` +
          `Close all windows using ${userDataDir} and restart.`
        );
      }
    })();
    _contextPromise.catch(() => { _contextPromise = null; });
  }
  return _contextPromise;
}

async function isLoggedIn(page: Page, site: Site): Promise<boolean> {
  try {
    // "commit" fires as soon as a response is received — tolerates pages that
    // immediately redirect via JS (which would abort a domcontentloaded wait).
    await page.goto(SITE_URLS[site], { waitUntil: "commit", timeout: 15000 });
    // Give any client-side redirect a moment to settle
    await page.waitForTimeout(1500);
    const url = page.url();
    if (site === "roll20") return !url.includes("/sessions/new");
    if (site === "ddb") return !url.includes("/login");
    return false;
  } catch (e) {
    // Return true only if we're already on the target site — plausibly still live.
    // Otherwise re-throw so the caller surfaces a real connectivity error.
    if (page.url().startsWith(SITE_URLS[site])) return true;
    throw e as Error;
  }
}

async function waitForManualAuth(page: Page, site: Site, timeoutMs = 15_000): Promise<void> {
  const notLoggedInPattern = site === "roll20" ? "/sessions/new" : "/login";
  await page.waitForFunction(
    (pattern: string) => !window.location.href.includes(pattern),
    notLoggedInPattern,
    { timeout: timeoutMs, polling: 1000 }
  );
}

async function loginRoll20(page: Page): Promise<void> {
  if (HIDE_BROWSER) await setBrowserWindowState(page, "normal"); // un-minimize so the GM can log in
  await page.goto(LOGIN_URLS.roll20, { waitUntil: "domcontentloaded", timeout: 15_000 });
  console.error("[roll20-dm] Roll20 login required — complete login in the Chromium browser window, then this will continue automatically.");
  await page.waitForURL(
    (url) => !url.toString().includes("/sessions/") && !url.toString().includes("/login"),
    { timeout: 15_000 }
  );
}

async function loginDdb(page: Page): Promise<void> {
  if (HIDE_BROWSER) await setBrowserWindowState(page, "normal"); // un-minimize so the GM can log in
  console.error("[roll20-dm] DnD Beyond login required — complete login in the Chromium browser window, then this will continue automatically.");
  await page.goto(LOGIN_URLS.ddb, { waitUntil: "commit", timeout: 15_000 }).catch(() => {});
  await waitForManualAuth(page, "ddb", 120_000);
}

const LOGIN_FNS: Record<Site, (page: Page) => Promise<void>> = {
  roll20: loginRoll20,
  ddb: loginDdb,
};

// Per-site promise cache — same race-prevention pattern as _contextPromise.
const _pagePromises: Partial<Record<Site, Promise<Page>>> = {};

export async function getPage(site: Site): Promise<Page> {
  // Validate a cached page before reuse: a closed page (or one whose browser
  // died) must be rebuilt, not handed back to throw on the next evaluate().
  if (_pagePromises[site]) {
    try {
      const p = await _pagePromises[site]!;
      if (!p.isClosed() && contextAlive(p.context())) return p;
    } catch { /* failed page promise — rebuild */ }
    delete _pagePromises[site];
  }
  if (!_pagePromises[site]) {
    _pagePromises[site] = (async () => {
      const ctx = await getContext();
      const blankPage = ctx.pages().find(p => p.url() === "about:blank");
      const page = blankPage ?? await ctx.newPage();
      if (!(await isLoggedIn(page, site))) {
        await LOGIN_FNS[site](page);
      }
      return page;
    })();
    _pagePromises[site]!.catch(() => { delete _pagePromises[site]; });
  }
  return _pagePromises[site]!;
}

export async function getBrowserCookie(page: Page, name: string): Promise<string | null> {
  const cookies = await page.context().cookies();
  return cookies.find((c) => c.name === name)?.value ?? null;
}

// Open a new page in the existing browser context without touching the per-site caches.
// Used for ephemeral pages (Mod editor, diagnostics) that shouldn't share state with
// the long-lived roll20/ddb pages.
export async function newBrowserPage(): Promise<Page> {
  const ctx = await getContext();
  return ctx.newPage();
}

export async function closeBrowser(): Promise<void> {
  const promise = _contextPromise;
  _contextPromise = null;
  for (const site of Object.keys(_pagePromises) as Site[]) {
    delete _pagePromises[site];
  }
  if (promise) {
    const ctx = await promise.catch(() => null);
    if (ctx) await ctx.close();
  }
}
