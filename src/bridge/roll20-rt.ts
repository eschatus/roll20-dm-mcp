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
import { getAuth, signInWithCustomToken, type User } from "firebase/auth";
import {
  getDatabase, ref, get, push, set, serverTimestamp, query, limitToLast, onChildAdded,
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
  user: User;
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

// --- Live chat buffer (replaces the Mod's getRecentChat round-trip) ---
// We already receive every /chat child on the socket; buffer the real table chat here so
// get_recent_chat is served from memory — no Mod, no chat-command echo. Mirrors the Mod's
// CHAT_BUFFER filter (skip our own !ai-relay commands and API/bridge output) and cleanChat.
interface ChatEntry { who: string; type: string; content: string; inlinerolls: { expression: string; total: number | null }[]; timestamp: number }
const chatBuffer: ChatEntry[] = [];
const CHAT_BUFFER_MAX = 100;

// Port of the Mod's cleanChat: strip rolltemplate HTML / URLs to dense text (roll totals are kept
// separately in inlinerolls, so this can be aggressive).
function cleanChat(raw: unknown): string {
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

function bufferChat(val: unknown): void {
  const m = val as { content?: unknown; who?: unknown; type?: unknown; playerid?: unknown; inlinerolls?: unknown };
  const content = m?.content;
  if (typeof content !== "string") return;
  if (content.startsWith("!ai-relay")) return;          // our own commands
  if (m.playerid === "API") return;                     // bridge/Mod output (incl. AIBRIDGE whispers)
  const rolls = Array.isArray(m.inlinerolls) ? m.inlinerolls : [];
  chatBuffer.push({
    who: String(m.who || ""),
    type: String(m.type || ""),
    content: cleanChat(content),
    inlinerolls: rolls.map((r) => {
      const rr = r as { expression?: string; results?: { total?: number } };
      return { expression: String(rr?.expression ?? ""), total: rr?.results?.total ?? null };
    }),
    timestamp: Date.now(),
  });
  if (chatBuffer.length > CHAT_BUFFER_MAX) chatBuffer.shift();
}

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
  // An AIBRIDGE result resolves a pending relay; anything else is real table chat → buffer it.
  if (!tryResolveContent(content)) bufferChat(val);
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
  onChildAdded(query(chatRef, limitToLast(CHAT_BUFFER_MAX)), (snap) => {
    handleChatChild(snap.key, snap.val());
  });

  return { campaignId: roll20CampaignId, app, db, user: cred.user, chatRef, storagePath, playerid, avatar: `/users/avatar/${userid}/30` };
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

// --- Direct RTDB reads (served straight off the socket — no Mod round-trip, never touch /chat) ---
// Returns NOT_HANDLED for anything not directly readable, so it falls through to the Mod relay.
const NOT_HANDLED = Symbol("not-handled");

function mapToken(g: Record<string, unknown>, profile: string): Record<string, unknown> {
  const s: Record<string, unknown> = {
    id: g.id, name: g.name || "", represents: g.represents || "",
    controlledby: g.controlledby || "", layer: g.layer,
  };
  if (profile === "lean") return s;
  s.bar1_value = g.bar1_value; s.bar1_max = g.bar1_max; s.statusmarkers = g.statusmarkers || "";
  if (profile === "status") return s;
  s.left = g.left; s.top = g.top; s.width = g.width; s.height = g.height;
  return s;
}

// turnorder is stored either as a JSON string (classic) or a live array — tolerate both.
function parseTurnorder(v: unknown): Record<string, unknown>[] {
  let arr: unknown = v;
  if (typeof v === "string") { try { arr = JSON.parse(v); } catch { arr = []; } }
  if (!Array.isArray(arr)) return [];
  return arr.map((e) => { const o: Record<string, unknown> = {}; for (const k in e) if (k !== "_pageid") o[k] = (e as Record<string, unknown>)[k]; return o; });
}

async function tryDirectRead(cmd: Record<string, unknown>): Promise<unknown | typeof NOT_HANDLED> {
  const action = cmd.action as string;
  try {
    switch (action) {
      case "getRecentChat": {
        const n = Math.min(Number(cmd.limit) || 50, chatBuffer.length);
        return chatBuffer.slice(-n);
      }
      case "getTurnOrder": {
        const campaign = await rtGet<Record<string, unknown>>("campaign");
        return parseTurnorder(campaign?.turnorder);
      }
      case "getTokenMarkers": {
        const campaign = await rtGet<Record<string, unknown>>("campaign");
        const raw = campaign?.token_markers;
        const m = typeof raw === "string" ? JSON.parse(raw) : (raw || []);
        return (Array.isArray(m) ? m : []).map((x: Record<string, unknown>) => ({ id: x.id, name: x.name, tag: x.tag }));
      }
      case "getTokens": {
        if (!cmd.pageId) return NOT_HANDLED;
        const g = await rtGet<Record<string, Record<string, unknown>>>(`graphics/page/${cmd.pageId}`);
        const profile = (cmd.profile as string) || "full";
        return Object.values(g || {}).map((t) => mapToken(t, profile));
      }
      case "getTokenById": {
        const pid = (cmd.pageId as string) || (await rtGet<Record<string, unknown>>("campaign"))?.playerpageid as string;
        if (!pid) return NOT_HANDLED;
        const t = await rtGet<Record<string, unknown> | null>(`graphics/page/${pid}/${cmd.tokenId}`);
        if (!t) return NOT_HANDLED; // not on player/given page → let the Mod do a global lookup
        return {
          id: t.id, name: t.name || "", represents: t.represents || "", layer: t.layer,
          controlledby: t.controlledby || "", left: t.left, top: t.top, width: t.width, height: t.height,
          rotation: t.rotation || 0, imgsrc: t.imgsrc, statusmarkers: t.statusmarkers || "",
          bar1_value: t.bar1_value, bar1_max: t.bar1_max, bar2_value: t.bar2_value, bar2_max: t.bar2_max,
          bar3_value: t.bar3_value, bar3_max: t.bar3_max,
          aura1_radius: t.aura1_radius, aura1_color: t.aura1_color, aura2_radius: t.aura2_radius, aura2_color: t.aura2_color,
          tint_color: t.tint_color, light_radius: t.light_radius, light_dimradius: t.light_dimradius,
          gmnotes: t.gmnotes || "",
        };
      }
      case "getDoors": {
        const mapOpening = (o: Record<string, unknown>, type: string) => {
          const p = (o.path as { handle0?: Record<string, number>; handle1?: Record<string, number> }) || {};
          const h0 = p.handle0 || {}, h1 = p.handle1 || {};
          return {
            id: o.id, type, x: o.x, y: o.y !== undefined ? -(o.y as number) : undefined,
            handle0: { x: h0.x, y: h0.y !== undefined ? -h0.y : undefined },
            handle1: { x: h1.x, y: h1.y !== undefined ? -h1.y : undefined },
            color: o.color, isOpen: o.isOpen, isLocked: o.isLocked, isSecret: o.isSecret,
          };
        };
        const empty: Record<string, Record<string, unknown>> = {};
        const doors = await rtGet<Record<string, Record<string, unknown>>>(`doors/page/${cmd.pageId}`).catch(() => empty);
        const windows = await rtGet<Record<string, Record<string, unknown>>>(`windows/page/${cmd.pageId}`).catch(() => empty);
        return {
          doors: Object.values(doors || {}).map((d) => mapOpening(d, "door")),
          windows: Object.values(windows || {}).map((w) => mapOpening(w, "window")),
        };
      }
      case "getPaths": {
        const layer = cmd.layer as string | undefined;
        const includePath = cmd.includePath === true;
        const paths = await rtGet<Record<string, Record<string, unknown>>>(`paths/page/${cmd.pageId}`).catch(() => ({} as Record<string, Record<string, unknown>>));
        let list: Record<string, unknown>[] = Object.values(paths || {});
        if (layer) list = list.filter((p) => p.layer === layer);
        const out = list.map((p) => {
          const base: Record<string, unknown> = { type: "path", id: p.id, layer: p.layer, left: p.left, top: p.top, width: p.width, height: p.height, rotation: p.rotation || 0, stroke: p.stroke };
          if (includePath) base.path = p.path;
          return base;
        });
        if (cmd.includeGraphics) return NOT_HANDLED; // graphics-on-layer mix: let the Mod handle it
        return out;
      }
      default:
        return NOT_HANDLED;
    }
  } catch (err) {
    if (process.env.RT_DEBUG) console.error(`[rt-debug] direct read ${action} failed → Mod fallback: ${(err as Error).message}`);
    return NOT_HANDLED;
  }
}

// Drop-in replacement for roll20.ts relayCommand. Reads are served directly off the socket;
// everything else (writes + un-mapped reads) is pushed to /chat for the Mod and awaits the
// AIBRIDGE_RESULT whisper. Throws on timeout/auth failure so callers can fall back to the browser.
export async function rtRelayCommand<T>(cmd: Record<string, unknown>): Promise<T> {
  const direct = await tryDirectRead(cmd);
  if (direct !== NOT_HANDLED) return direct as T;

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

// One-shot read of a path under the campaign's storage root (e.g. "turnorder", "chat",
// `pages/${pageId}/graphics`). The object reads migrate onto this — no Mod round-trip, no chat.
// `shallow:true` uses the RTDB REST endpoint to return just child KEYS (cheap key-listing /
// schema discovery; never downloads a whole subtree). The auth token never leaves this module.
export async function rtGet<T = unknown>(relPath: string, opts: { shallow?: boolean } = {}): Promise<T> {
  const conn = await getConn();
  const clean = relPath.replace(/^\/+|\/+$/g, "");
  if (opts.shallow) {
    const token = await conn.user.getIdToken();
    const base = FIREBASE_CONFIG.databaseURL.replace(/\/+$/, "");
    const url = `${base}/${conn.storagePath}/${clean}.json?shallow=true&auth=${encodeURIComponent(token)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`rtGet shallow ${res.status}: ${await res.text().catch(() => "")}`);
    return (await res.json()) as T;
  }
  const snap = await get(ref(conn.db, `${conn.storagePath}/${clean}`));
  return snap.val() as T;
}

// Expose the storage path for callers that need to build their own refs/paths.
export async function rtStoragePath(): Promise<string> {
  return (await getConn()).storagePath;
}
