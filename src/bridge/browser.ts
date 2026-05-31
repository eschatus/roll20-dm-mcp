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

async function getContext(): Promise<BrowserContext> {
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
        return await chromium.launchPersistentContext(userDataDir, {
          headless: false,
          args: [
            "--disable-blink-features=AutomationControlled",
            `--remote-debugging-port=${DEBUG_PORT}`,
          ],
        });
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
  } catch {
    // Navigation failed — assume the existing session is still good rather than
    // triggering a login flow that may also fail.
    return true;
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
  await page.goto(LOGIN_URLS.roll20, { waitUntil: "domcontentloaded", timeout: 15_000 });
  console.error("[roll20-dm] Roll20 login required — complete login in the Chromium browser window, then this will continue automatically.");
  await page.waitForURL(
    (url) => !url.toString().includes("/sessions/") && !url.toString().includes("/login"),
    { timeout: 15_000 }
  );
}

async function loginDdb(page: Page): Promise<void> {
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
