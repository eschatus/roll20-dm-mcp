// Electron-native token harvest — the packaged installer ships Electron's own Chromium but NOT
// Playwright (the server bundle externalizes it), so the server's browser-based harvest can't run
// in an installed app. Here the GEM opens a visible BrowserWindow, the user logs in, and we capture
// the same credentials the server would — then write the SAME cache files the server reads
// (<dataDir>/roll20-rt-token.json, <dataDir>/ddb-cobalt.json). No Playwright, no Chromium download.
//
// See issue #65. The cache shapes mirror src/bridge/roll20-rt.ts (TokenCache) and ddb-rt.ts (CobaltCache).

import { BrowserWindow, session as electronSession } from "electron";
import { writeFileSync, mkdirSync } from "fs";
import * as path from "path";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function dataDir(): string {
  return process.env.DMW_DATA_DIR || process.env.ROLL20_DATA_DIR || path.join(__dirname, "..", "..", "data");
}

// Roll20's default RTDB shard — written only when the campaign's actual namespace can't be detected,
// so the cache still has a non-empty databaseURL (an empty one makes the server treat it as a miss
// and re-harvest via its absent Playwright). Mirrors FIREBASE_CONFIG.databaseURL in roll20-rt.ts.
const ROLL20_DEFAULT_DB = "https://roll20-99910.firebaseio.com";

type HarvestResult = { ok: boolean; error?: string };

// Capture the Firebase custom token (from the editor's signInWithCustomToken request body) + the
// campaign's RTDB namespace, and cache them. Same logic as harvestCustomToken() in roll20-rt.ts,
// re-expressed with Electron's webRequest (request body) + executeJavaScript (FIREBASE_ROOT global).
export async function harvestRoll20(campaignId: string, onLog: (m: string) => void): Promise<HarvestResult> {
  if (!campaignId) return { ok: false, error: "no active campaign — register/switch to one first, then Connect Roll20" };

  const ses = electronSession.fromPartition("persist:roll20-harvest");
  let token: string | null = null;

  const onReq = (
    details: Electron.OnBeforeRequestListenerDetails,
    cb: (r: Electron.CallbackResponse) => void,
  ) => {
    if (!token && details.url.includes("signInWithCustomToken") && details.uploadData?.length) {
      try {
        const raw = Buffer.concat(
          details.uploadData.map((d) => d.bytes).filter((b): b is Buffer => !!b),
        ).toString("utf-8");
        const body = JSON.parse(raw || "{}") as { token?: string };
        if (body.token) { token = body.token; onLog("[harvest] captured Roll20 custom token"); }
      } catch { /* not the body we want */ }
    }
    cb({});
  };
  ses.webRequest.onBeforeRequest({ urls: ["*://*/*"] }, onReq);

  const win = new BrowserWindow({
    width: 1100, height: 820, title: "Connect Roll20 — log in, then this closes itself",
    webPreferences: { partition: "persist:roll20-harvest" },
  });
  const url = `https://app.roll20.net/editor/setcampaign/${campaignId}/`;

  try {
    onLog("[harvest] opening Roll20 editor — log in (and pass the 'I'm human' check) if prompted");
    await win.loadURL(url).catch(() => {});
    // Pass 1: a fresh sign-in fires signInWithCustomToken on load.
    for (let i = 0; i < 16 && !token && !win.isDestroyed(); i++) await sleep(500);

    // Already authed (token restored from IndexedDB → the call won't re-fire). Clear it and reload
    // so the editor signs in again. Generous window here: the user may need to log in on this pass.
    if (!token && !win.isDestroyed()) {
      onLog("[harvest] no token yet — forcing a fresh sign-in (log in if the page asks)");
      await win.webContents.executeJavaScript(
        `new Promise((res)=>{const d=indexedDB.deleteDatabase("firebaseLocalStorageDb");d.onsuccess=d.onerror=d.onblocked=()=>res(1)})`,
      ).catch(() => {});
      await win.loadURL(url).catch(() => {});
      for (let i = 0; i < 240 && !token && !win.isDestroyed(); i++) await sleep(500); // up to ~2 min for login
    }

    if (!token) return { ok: false, error: "no token captured — did you finish logging in?" };

    // Capture the campaign's RTDB shard from the page's FIREBASE_ROOT global (authoritative + stable).
    let ns: string | null = null;
    const end = Date.now() + 30_000;
    while (Date.now() < end && !ns && !win.isDestroyed()) {
      const dbUrl = await win.webContents.executeJavaScript(
        `(window.FIREBASE_ROOT||window.databaseURL||null)`,
      ).catch(() => null);
      if (dbUrl) { const m = /\/\/([^.]+)\.firebaseio/.exec(String(dbUrl)); if (m) { ns = m[1]; break; } }
      await sleep(500);
    }

    const databaseURL = ns ? `https://${ns}.firebaseio.com` : ROLL20_DEFAULT_DB;
    const dir = dataDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "roll20-rt-token.json"),
      JSON.stringify({ campaignId, customToken: token, databaseURL, harvestedAt: Date.now() }),
      "utf-8",
    );
    onLog(ns
      ? `[harvest] Roll20 token cached (shard ${ns})`
      : "[harvest] Roll20 token cached — WARNING: no shard namespace detected; reads may be empty if this campaign is on another shard");
    return { ok: true };
  } finally {
    ses.webRequest.onBeforeRequest(null);
    if (!win.isDestroyed()) win.close();
  }
}

// Read the long-lived CobaltSession cookie after the user logs into D&D Beyond, and cache it.
// Mirrors harvestCobalt() in ddb-rt.ts (cookie-from-logged-in-profile → <dataDir>/ddb-cobalt.json).
export async function harvestDdb(onLog: (m: string) => void): Promise<HarvestResult> {
  const ses = electronSession.fromPartition("persist:ddb-harvest");
  const win = new BrowserWindow({
    width: 1100, height: 820, title: "Connect D&D Beyond — log in, then this closes itself",
    webPreferences: { partition: "persist:ddb-harvest" },
  });
  try {
    onLog("[harvest] opening D&D Beyond — log in if prompted");
    // A page that requires auth → redirects to login when needed; the cookie appears once logged in.
    await win.loadURL("https://www.dndbeyond.com/my-characters").catch(() => {});
    let cookie: string | null = null;
    const end = Date.now() + 180_000; // up to 3 min for the user to log in
    while (Date.now() < end && !cookie && !win.isDestroyed()) {
      const cks = await ses.cookies.get({ name: "CobaltSession" }).catch(() => []);
      const c = cks.find((x) => (x.domain || "").includes("dndbeyond") && x.value);
      if (c?.value) cookie = c.value;
      else await sleep(1000);
    }
    if (!cookie) return { ok: false, error: "no CobaltSession cookie — did you finish logging in?" };
    const dir = dataDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "ddb-cobalt.json"), JSON.stringify({ cookie, harvestedAt: Date.now() }), "utf-8");
    onLog("[harvest] D&D Beyond cobalt cached");
    return { ok: true };
  } finally {
    if (!win.isDestroyed()) win.close();
  }
}
