// Roll20 realtime transport — browserless relay over Firebase RTDB.
//
// Replaces the Playwright chat-typing relay (roll20.ts) with a direct Firebase connection:
// we PUSH the `!ai-relay {…}` command as a chat child and LISTEN for the Mod's
// `AIBRIDGE_RESULT:` whisper child — the Mod script (mod-scripts/ai-relay.js) is unchanged.
//
// Auth chain (see docs/roll20-realtime-protocol.md):
//   Roll20 session cookie  ──POST /editor/oauth_token──▶  custom token
//   custom token  ──firebase signInWithCustomToken──▶  ID token (RTDB cred, ~1h, SDK auto-refreshes)
//
// The session cookie is harvested ONCE via the existing browser bridge (which keeps a persistent
// logged-in profile), cached to disk, and only re-harvested on 401. The browser is NOT held open
// during operation — all traffic is the socket. Enable with ROLL20_TRANSPORT=rt.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import path from "path";
import { initializeApp, deleteApp, type FirebaseApp } from "firebase/app";
import { getAuth, signInWithCustomToken } from "firebase/auth";
import {
  getDatabase, ref, push, set, serverTimestamp, query, limitToLast, onChildAdded,
  type Database, type DatabaseReference,
} from "firebase/database";
import { getPage } from "./browser.js";
import type { Page } from "playwright";
import { getActiveCampaign } from "../registry/campaigns.js";

// Public web config captured from the live editor (safe to embed — it's the client config).
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyDSuyx7vpT7ZS0EdeX68qVKIQKv9MfSQN0",
  authDomain: "roll20-dev.firebaseapp.com",
  databaseURL: "https://roll20-99910.firebaseio.com/",
  projectId: "roll20-dev",
  storageBucket: "roll20-dev.appspot.com",
  messagingSenderId: "717330860670",
  appId: "1:717330860670:web:8bd50673cd0a383f4b662f",
};

const RELAY_TIMEOUT_MS = 30_000;
const TOKEN_CACHE = path.resolve("./data/roll20-rt-token.json");
// Firebase custom tokens are valid ~1h and re-exchangeable; cache below that so quick server
// restarts skip the browser entirely. Only a cold start past the window touches Chromium.
const TOKEN_MAX_AGE_MS = 50 * 60_000;

export function rtEnabled(): boolean {
  return (process.env.ROLL20_TRANSPORT || "").toLowerCase() === "rt";
}

// --- Firebase custom-token harvest (browser touched once at cold start, then cached) ---
//
// oauth_token returns a Roll20 OAuth token, NOT a Firebase custom token — the custom token is
// minted opaquely by the editor bootstrap and handed to signInWithCustomToken. The modular SDK
// only fires that call on a FRESH auth (otherwise it restores from IndexedDB), so to capture a
// fresh, re-exchangeable custom token we intercept the request body — forcing a fresh sign-in by
// clearing the firebase auth IndexedDB and reloading if the editor was already authenticated.

interface TokenCache { campaignId: string; customToken: string; harvestedAt: number }

function readTokenCache(): TokenCache | null {
  try { return existsSync(TOKEN_CACHE) ? JSON.parse(readFileSync(TOKEN_CACHE, "utf-8")) : null; }
  catch { return null; }
}

async function pollFor(get: () => string | null, ms: number): Promise<string | null> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = get();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 200));
  }
  return get();
}

async function harvestCustomToken(campaignId: string): Promise<string> {
  const page: Page = await getPage("roll20");
  let captured: string | null = null;
  const onReq = (req: import("playwright").Request) => {
    if (!req.url().includes("signInWithCustomToken")) return;
    try { const b = JSON.parse(req.postData() || "{}"); if (b.token) captured = b.token as string; }
    catch { /* not the body we want */ }
  };
  page.on("request", onReq);
  const url = `https://app.roll20.net/editor/setcampaign/${campaignId}/`;
  try {
    // Pass 1: a normal load catches the case where the editor hasn't authed yet this session.
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {});
    captured = await pollFor(() => captured, 8_000);
    if (!captured) {
      // Already authed (restored from IndexedDB) → force a fresh sign-in so the call re-fires.
      await page.evaluate(() => new Promise<void>((res) => {
        const del = indexedDB.deleteDatabase("firebaseLocalStorageDb");
        del.onsuccess = del.onerror = del.onblocked = () => res();
      })).catch(() => {});
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {});
      captured = await pollFor(() => captured, 25_000);
    }
  } finally {
    page.off("request", onReq);
  }
  if (!captured) throw new Error("roll20-rt: could not harvest a Firebase custom token from the editor (logged in?)");
  mkdirSync(path.dirname(TOKEN_CACHE), { recursive: true });
  writeFileSync(TOKEN_CACHE, JSON.stringify({ campaignId, customToken: captured, harvestedAt: Date.now() } as TokenCache), "utf-8");
  return captured;
}

async function getCustomToken(campaignId: string, forceFresh = false): Promise<string> {
  if (!forceFresh) {
    const c = readTokenCache();
    if (c && c.campaignId === campaignId && Date.now() - c.harvestedAt < TOKEN_MAX_AGE_MS) return c.customToken;
  }
  return harvestCustomToken(campaignId);
}

// --- Connection (singleton per campaign) ---

interface RtConn {
  campaignId: string;
  app: FirebaseApp;
  db: Database;
  chatRef: DatabaseReference;
  storagePath: string;
  playerid: string;
  avatar: string;
}

let _connPromise: Promise<RtConn> | null = null;
let _connCampaignId: string | null = null;

// nonce → pending relay; resolved when the matching AIBRIDGE_RESULT child arrives.
const pending = new Map<number, { resolve: (d: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
const seenKeys = new Set<string>(); // dedupe onChildAdded replays
let _nonceCounter = 0;

const MARKER = "AIBRIDGE_RESULT:";

// Extract the first balanced-brace JSON object following the marker (mirrors roll20.ts OBSERVER_SCRIPT).
function parseAibridge(text: string): { nonce: number; data?: unknown; error?: string } | null {
  const pos = text.indexOf(MARKER);
  if (pos === -1) return null;
  const start = pos + MARKER.length;
  if (text[start] !== "{") return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (esc) { esc = false; continue; }
    if (inStr) { if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') { inStr = true; continue; }
    if (c === "{") depth++;
    if (c === "}" && --depth === 0) {
      try { return JSON.parse(text.slice(start, i + 1)); } catch { return null; }
    }
  }
  return null;
}

// Try to resolve a pending relay from a message `content` string. Returns true if it matched.
function tryResolveContent(content: unknown): boolean {
  if (typeof content !== "string" || !content.includes(MARKER)) return false;
  const parsed = parseAibridge(content);
  if (!parsed) return false;
  const p = pending.get(parsed.nonce);
  if (!p) return false; // not ours (or already timed out)
  pending.delete(parsed.nonce);
  clearTimeout(p.timer);
  if (parsed.error) p.reject(new Error("Relay error: " + parsed.error));
  else p.resolve(parsed.data);
  return true;
}

function handleChatChild(key: string | null, val: unknown): void {
  if (key) { if (seenKeys.has(key)) return; seenKeys.add(key); if (seenKeys.size > 500) seenKeys.clear(); }
  const content = (val as { content?: unknown })?.content;
  if (process.env.RT_DEBUG) {
    const who = (val as { who?: unknown })?.who;
    console.error(`[rt-debug] chat child key=${key} who=${JSON.stringify(who)} content=${String(content).slice(0, 120).replace(/\s+/g, " ")}`);
  }
  tryResolveContent(content);
}

async function connect(): Promise<RtConn> {
  const { roll20CampaignId } = getActiveCampaign();

  // Sign in with the cached custom token; if it's stale/invalid, re-harvest fresh and retry once.
  let app!: FirebaseApp;
  let cred!: Awaited<ReturnType<typeof signInWithCustomToken>>;
  for (let attempt = 0; attempt < 2; attempt++) {
    const customToken = await getCustomToken(roll20CampaignId, attempt > 0);
    app = initializeApp(FIREBASE_CONFIG, `roll20-rt-${roll20CampaignId}-${Date.now()}`);
    try {
      cred = await signInWithCustomToken(getAuth(app), customToken);
      break;
    } catch (err) {
      await deleteApp(app).catch(() => {});
      const code = (err as { code?: string })?.code || "";
      if (attempt === 0 && /invalid-custom-token|custom-token|invalid-credential/.test(code)) continue;
      throw err;
    }
  }

  const tokenResult = await cred.user.getIdTokenResult();
  const claims = tokenResult.claims as Record<string, unknown>;
  const storagePath = String(claims.currentcampaign || "");
  const playerid = String(claims.playerid || "");
  const userid = String(claims.userid || "");
  if (!storagePath || !playerid) throw new Error("roll20-rt: auth token missing currentcampaign/playerid claims");

  const db = getDatabase(app);
  const chatRef = ref(db, `${storagePath}/chat`);

  // Listen for new chat children (limit window covers a burst of concurrent results; dedup by key).
  // The Mod's AIBRIDGE_RESULT whisper is sent with noarchive:true — never persisted to history, but
  // delivered live as a /chat child, so onChildAdded catches it just like the browser DOM observer.
  onChildAdded(query(chatRef, limitToLast(30)), (snap) => {
    handleChatChild(snap.key, snap.val());
  });

  return { campaignId: roll20CampaignId, app, db, chatRef, storagePath, playerid, avatar: `/users/avatar/${userid}/30` };
}

async function getConn(): Promise<RtConn> {
  const { roll20CampaignId } = getActiveCampaign();
  if (_connPromise && _connCampaignId === roll20CampaignId) return _connPromise;
  // Campaign switched (or first call) — tear down any prior app and rebuild.
  if (_connPromise) {
    const prev = _connPromise;
    _connPromise = null;
    prev.then((c) => deleteApp(c.app)).catch(() => {});
  }
  _connCampaignId = roll20CampaignId;
  _connPromise = connect();
  _connPromise.catch(() => { _connPromise = null; });
  return _connPromise;
}

export async function rtReconnect(): Promise<void> {
  for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error("rt reconnecting")); }
  pending.clear();
  seenKeys.clear();
  const prev = _connPromise;
  _connPromise = null;
  _connCampaignId = null;
  if (prev) await prev.then((c) => deleteApp(c.app)).catch(() => {});
  await getConn();
}

// Drop-in replacement for roll20.ts relayCommand. Pushes the command to chat and awaits the
// Mod's AIBRIDGE_RESULT whisper. Throws on timeout/auth failure so callers can fall back.
export async function rtRelayCommand<T>(cmd: Record<string, unknown>): Promise<T> {
  const conn = await getConn();
  // Monotonic, unique, and safely within MAX_SAFE_INTEGER (seeded once from Date.now()).
  if (_nonceCounter === 0) _nonceCounter = Date.now();
  const nonce = ++_nonceCounter;
  const content = "!ai-relay " + JSON.stringify({ ...cmd, nonce });

  const result = new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(nonce);
      reject(new Error(`rt relay timeout after ${RELAY_TIMEOUT_MS}ms for action: ${cmd.action}`));
    }, RELAY_TIMEOUT_MS);
    pending.set(nonce, { resolve: resolve as (d: unknown) => void, reject, timer });
  });

  // Mirror the EXACT shape Roll20's UI writes (captured): a separate `messageId` push id and a
  // server-timestamp `.priority`. Without these the server chat processor treats the child as
  // replayed history and never fires the Mod's on("chat:message") — so the Mod stayed silent.
  const msgRef = push(conn.chatRef);                 // path key
  const messageId = push(conn.chatRef).key as string; // distinct generated id, as the UI does
  await set(msgRef, {
    avatar: conn.avatar,
    content,
    messageId,
    playerid: conn.playerid,
    type: "api",
    who: "DM (GM)",
    ".priority": serverTimestamp(),
  } as Record<string, unknown>);

  return result;
}
