// Roll20 realtime transport — browserless relay over Firebase RTDB.
//
// Replaces the Playwright chat-typing relay (roll20.ts) with a direct Firebase connection:
// we PUSH the `!ai-relay {…}` command as a chat child and LISTEN for the Mod's
// `AIBRIDGE_RESULT:` whisper child — the Mod script (mod-scripts/ai-relay.js) is unchanged.
//
// Auth chain (see docs/roll20-realtime-protocol.md — NOTE: /editor/oauth_token returns a Roll20
// OAuth token, NOT the Firebase custom token; we instead intercept the custom token from the
// browser's signInWithCustomToken request body):
//   logged-in browser  ──intercept signInWithCustomToken request──▶  Firebase custom token
//   custom token  ──firebase signInWithCustomToken──▶  ID token (RTDB cred, ~1h, SDK auto-refreshes)
//
// The session cookie is harvested ONCE via the existing browser bridge (which keeps a persistent
// logged-in profile), cached to disk, and only re-harvested on 401. The browser is NOT held open
// during operation — all traffic is the socket. Enable with ROLL20_TRANSPORT=rt.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import path from "path";
import { dataPath } from "../dataDir.js";
import { initializeApp, deleteApp, type FirebaseApp } from "firebase/app";
import { getAuth, signInWithCustomToken, type User } from "firebase/auth";
import {
  getDatabase, ref, get, push, set, update, remove, runTransaction, serverTimestamp, query, limitToLast, onChildAdded, onValue,
  type Database, type DatabaseReference,
} from "firebase/database";
import { getPage, closeBrowser } from "./browser.js";
import type { Page } from "playwright";
import { getActiveCampaign } from "../registry/campaigns.js";
import { READONLY_ACTIONS, newNonce } from "./actions.js";
import { recordSuccess, recordFailure } from "./transport-health.js";
import { resolveMarkerForState } from "./markers.js";
import { trackCustomState, getCustomStates as getCustomStatesStore } from "./relayState.js";
import {
  AIBRIDGE_MARKER as MARKER, parseAibridge, cleanChat,
  parsePcHpBlock, writePcHpBlock, type PcHpEntry,
  mapToken, parseTurnorder, stripUndefWrite,
  parseBroadcastPing, type MapPing,
} from "./rt-helpers.js";

export type { MapPing } from "./rt-helpers.js";

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

// Thrown when the command never reached /chat (auth/connection failure before the push).
// The caller may safely fall back to another transport — no idempotency hazard.
export class RtPreSendError extends Error {
  constructor(msg: string) { super(msg); this.name = "RtPreSendError"; }
}
const TOKEN_CACHE = dataPath("roll20-rt-token.json");
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

// databaseURL is the campaign's actual Firebase RTDB instance. Roll20 shards campaigns across
// multiple instances (roll20-99910, roll20-99922, …); a hardcoded URL only reads one shard, so
// campaigns on another shard read empty and silently fall back to the Mod. Captured at harvest.
interface TokenCache { campaignId: string; customToken: string; databaseURL: string; harvestedAt: number }
interface HarvestResult { customToken: string; databaseURL: string }

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

async function harvestCustomToken(campaignId: string): Promise<HarvestResult> {
  const page: Page = await getPage("roll20");
  let captured: string | null = null;
  let capturedNs: string | null = null;
  const onReq = (req: import("playwright").Request) => {
    if (!req.url().includes("signInWithCustomToken")) return;
    try { const b = JSON.parse(req.postData() || "{}"); if (b.token) captured = b.token as string; }
    catch { /* not the body we want */ }
  };
  // The editor opens its realtime socket against the campaign's actual RTDB instance
  // (wss://…firebaseio.com/.ws?…&ns=roll20-XXXXX). Capture that namespace so we connect to the
  // SAME shard the live client uses — see TokenCache.databaseURL.
  const onWs = (ws: import("playwright").WebSocket) => {
    const u = ws.url();
    if (capturedNs || !/firebaseio/.test(u)) return;
    const m = /[?&]ns=([^&]+)/.exec(u);
    if (m) capturedNs = decodeURIComponent(m[1]);
  };
  page.on("request", onReq);
  page.on("websocket", onWs);
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
    // The realtime socket / firebase config appear only after the editor JS boots — and that can
    // be slow on a COLD (archived) campaign, which is why the ws-only capture missed it before
    // (it raced a 10s window the socket opened after). Poll BOTH the captured ws ns and the page's
    // own FIREBASE_ROOT global — the global is authoritative and persists, unlike the one-shot ws
    // event — for a generous window. The onWs handler still feeds capturedNs if it fires first.
    if (!capturedNs) {
      const end = Date.now() + 30_000;
      while (Date.now() < end && !capturedNs) {
        const dbUrl = await page.evaluate(() => {
          const w = window as unknown as { FIREBASE_ROOT?: string; databaseURL?: string };
          return w.FIREBASE_ROOT || w.databaseURL || null;
        }).catch(() => null);
        if (dbUrl) { const m = /\/\/([^.]+)\.firebaseio/.exec(String(dbUrl)); if (m) { capturedNs = m[1]; break; } }
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  } finally {
    page.off("request", onReq);
    page.off("websocket", onWs);
  }
  if (!captured) throw new Error("roll20-rt: could not harvest a Firebase custom token from the editor (logged in?)");
  const databaseURL = capturedNs ? `https://${capturedNs}.firebaseio.com` : FIREBASE_CONFIG.databaseURL;
  if (!capturedNs) console.error(`[roll20-rt] WARNING: no Firebase namespace detected for campaign ${campaignId}; falling back to ${FIREBASE_CONFIG.databaseURL} (reads will be empty if this campaign is on another shard)`);
  mkdirSync(path.dirname(TOKEN_CACHE), { recursive: true });
  writeFileSync(TOKEN_CACHE, JSON.stringify({ campaignId, customToken: captured, databaseURL, harvestedAt: Date.now() } as TokenCache), "utf-8");
  // Token cached — browser no longer needed until a Mod-relay write comes in. Close it now
  // so it doesn't sit as a visible window; it will reopen on demand for sendChat/writes.
  closeBrowser().catch(() => {});
  return { customToken: captured, databaseURL };
}

async function getCustomToken(campaignId: string, forceFresh = false): Promise<HarvestResult> {
  if (!forceFresh) {
    const c = readTokenCache();
    // Require databaseURL too: a pre-shard-fix cache entry lacks it, so treat that as a miss and
    // re-harvest to capture the namespace (otherwise we'd reconnect to the wrong shard).
    if (c && c.campaignId === campaignId && c.databaseURL && Date.now() - c.harvestedAt < TOKEN_MAX_AGE_MS) {
      return { customToken: c.customToken, databaseURL: c.databaseURL };
    }
  }
  return harvestCustomToken(campaignId);
}

// --- Connection (singleton per campaign) ---

interface RtConn {
  campaignId: string;
  app: FirebaseApp;
  db: Database;
  databaseURL: string;
  user: User;
  chatRef: DatabaseReference;
  storagePath: string;
  playerid: string;
  avatar: string;
}

let _connPromise: Promise<RtConn> | null = null;
let _connCampaignId: string | null = null;

const CAMPAIGN_CACHE_TTL_MS = 30_000;
let _campaignPageCache: { playerpageid: string; initiativepage: string } | null = null;
let _campaignPageCacheAt = 0;
function _clearCampaignPageCache() { _campaignPageCache = null; _campaignPageCacheAt = 0; }

// nonce → pending relay; resolved when the matching AIBRIDGE_RESULT child arrives.
const pending = new Map<number, { resolve: (d: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
const seenKeys = new Set<string>(); // dedupe onChildAdded replays

// --- Live chat buffer (replaces the Mod's getRecentChat round-trip) ---
// We already receive every /chat child on the socket; buffer the real table chat here so
// get_recent_chat is served from memory. cleanChat/parsing live in rt-helpers (unit-tested).
interface ChatEntry { who: string; type: string; content: string; inlinerolls: { expression: string; total: number | null }[]; timestamp: number }
const chatBuffer: ChatEntry[] = [];
const CHAT_BUFFER_MAX = 100;

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

// Player chat commands (!tactics, !recall, …): the listener is registered by
// src/bridge/player-commands.ts via the composition root. Kept as a callback so
// this module never imports downstream code (roll20.ts imports us — no cycles).
export interface PlayerChatCommand {
  who: string;
  playerid: string;
  content: string;
}
let _playerCommandListener: ((cmd: PlayerChatCommand) => void) | null = null;
export function setPlayerCommandListener(fn: ((cmd: PlayerChatCommand) => void) | null): void {
  _playerCommandListener = fn;
}

function handleChatChild(key: string | null, val: unknown, live: boolean): void {
  if (key) {
    if (seenKeys.has(key)) return;
    seenKeys.add(key);
    if (seenKeys.size > 500) {
      // Trim the oldest 100 entries (Set iterates insertion order) rather than
      // clearing wholesale, which would create a replay window.
      const iter = seenKeys.values();
      for (let i = 0; i < 100; i++) seenKeys.delete(iter.next().value as string);
    }
  }
  const content = (val as { content?: unknown })?.content;
  if (process.env.RT_DEBUG) {
    const who = (val as { who?: unknown })?.who;
    console.error(`[rt-debug] chat child key=${key} who=${JSON.stringify(who)} content=${String(content).slice(0, 120).replace(/\s+/g, " ")}`);
  }
  // Surface !dm messages to the gem HUD once the initial replay burst settles. Broadcast straight
  // to the SSE stream — the old aibridge/dmInbox RTDB write is denied on every shard (see
  // publishInboxItem). (The Mod separately stashes !dm in its own state for the turn-hook line.)
  if (live && typeof content === "string" && content.startsWith("!dm ")) {
    const text = content.slice(4).trim();
    if (text) {
      const m = val as { who?: unknown; playerid?: unknown };
      const isQuery = /^(what|who|how|is|am|are|do|does|can|did|\?)/i.test(text) || text.endsWith("?");
      publishInboxItem({
        who: String(m.who || ""),
        playerid: String(m.playerid || ""),
        content: text,
        type: isQuery ? "query" : "intent",
        timestamp: Date.now(),
        key: `dm-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
      });
    }
  }
  // Player commands (!tactics etc.) — same live-only guard as !dm so the
  // connect-time replay burst can't re-fire handlers. API-origin messages are
  // bridge output, never a player command.
  if (live && _playerCommandListener && typeof content === "string"
      && content.startsWith("!")
      && !content.startsWith("!ai-relay") && !content.startsWith("!dm ")) {
    const m = val as { who?: unknown; playerid?: unknown };
    if (String(m.playerid || "") !== "API") {
      _playerCommandListener({ who: String(m.who || ""), playerid: String(m.playerid || ""), content });
    }
  }
  // An AIBRIDGE result resolves a pending relay; anything else is real table chat → buffer it.
  if (!tryResolveContent(content)) bufferChat(val);
}

async function connect(): Promise<RtConn> {
  const { roll20CampaignId } = getActiveCampaign();

  // Sign in with the cached custom token; if it's stale/invalid, re-harvest fresh and retry once.
  let app!: FirebaseApp;
  let cred!: Awaited<ReturnType<typeof signInWithCustomToken>>;
  let databaseURL = FIREBASE_CONFIG.databaseURL;
  for (let attempt = 0; attempt < 2; attempt++) {
    const harvested = await getCustomToken(roll20CampaignId, attempt > 0);
    databaseURL = harvested.databaseURL;
    app = initializeApp(FIREBASE_CONFIG, `roll20-rt-${roll20CampaignId}-${Date.now()}`);
    try {
      cred = await signInWithCustomToken(getAuth(app), harvested.customToken);
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

  // Connect to the campaign's actual RTDB shard (captured at harvest), not the config default.
  const db = getDatabase(app, databaseURL);
  const chatRef = ref(db, `${storagePath}/chat`);

  // Listen for new chat children (limit window covers a burst of concurrent results; dedup by key).
  // The Mod's AIBRIDGE_RESULT whisper is sent with noarchive:true — never persisted to history, but
  // delivered live as a /chat child, so onChildAdded catches it just like the browser DOM observer.
  // `live` flips after 2 s — RTDB delivers the replay burst synchronously on connect, so anything
  // arriving before then is historical and must not re-trigger the !dm inbox.
  let live = false;
  setTimeout(() => { live = true; }, 2000);
  onChildAdded(query(chatRef, limitToLast(CHAT_BUFFER_MAX)), (snap) => {
    handleChatChild(snap.key, snap.val(), live);
  });

  return { campaignId: roll20CampaignId, app, db, databaseURL, user: cred.user, chatRef, storagePath, playerid, avatar: `/users/avatar/${userid}/30` };
}

async function getConn(): Promise<RtConn> {
  const { roll20CampaignId } = getActiveCampaign();
  if (_connPromise && _connCampaignId === roll20CampaignId) return _connPromise;
  // Campaign switched (or first call) — tear down any prior app and rebuild.
  if (_connPromise) {
    const prev = _connPromise;
    _connPromise = null;
    prev.then((c) => deleteApp(c.app)).catch(() => {});
    // Reset all per-campaign in-memory state (chat buffer, seen keys, round tracking, etc.)
    // and allow subscriptions to restart for the new campaign (Bug 1 + Bug 2).
    _resetPerCampaignState();
  }
  _connCampaignId = roll20CampaignId;
  // _connPromise must be set BEFORE re-invoking startRtdbSubscriptions so that the nested
  // getConn() inside _doStartRtdbSubscriptions resolves this same promise (no recursion).
  _connPromise = connect();
  _connPromise.catch(() => { _connPromise = null; });
  // Re-subscribe if subscriptions were previously requested (fire-and-forget; Bug 1).
  if (_subsWanted) {
    _connPromise.then(() => startRtdbSubscriptions()).catch((e: Error) => {
      console.error("[rtdb] re-subscribe after campaign switch failed:", e.message);
    });
  }
  return _connPromise;
}

export async function rtReconnect(): Promise<void> {
  for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error("rt reconnecting")); }
  pending.clear();
  // Reset all per-campaign state so the new connection gets a clean slate (Bug 1 + Bug 2).
  _resetPerCampaignState();
  const prev = _connPromise;
  _connPromise = null;
  _connCampaignId = null;
  if (prev) await prev.then((c) => deleteApp(c.app)).catch(() => {});
  // getConn() will re-invoke startRtdbSubscriptions() if _subsWanted is true (Bug 1).
  await getConn();
}

// --- Direct RTDB reads (served straight off the socket — no Mod round-trip, never touch /chat) ---
// Returns NOT_HANDLED for anything not directly readable, so it falls through to the Mod relay.
const NOT_HANDLED = Symbol("not-handled");

// PC HP carrier: a %%PCHP={...}%% block in the token's GM-only gmnotes (never shown to players).
// Single source of truth read/written by BOTH this client (direct) and the Mod (batchExec +
// turn-hook narration) — verified to round-trip raw in both directions. Existing gmnotes preserved.
async function tryDirectRead(cmd: Record<string, unknown>): Promise<unknown | typeof NOT_HANDLED> {
  const action = cmd.action as string;
  if (cmd.__forceMod) return NOT_HANDLED; // debug/escape hatch: force the Mod path
  try {
    switch (action) {
      case "getRecentChat": {
        const n = Math.min(Number(cmd.limit) || 50, chatBuffer.length);
        return chatBuffer.slice(-n);
      }
      case "getPcHp": {
        // By token → read the gmnotes PCHP block directly. by-name / whole-map → Mod fallback.
        if (!cmd.tokenId) return NOT_HANDLED;
        const pid = await rtFindTokenPage(cmd.tokenId as string, cmd.pageId as string | undefined);
        if (!pid) return NOT_HANDLED;
        const tok = await rtGet<Record<string, unknown>>(`graphics/page/${pid}/${cmd.tokenId}`);
        return parsePcHpBlock(tok?.gmnotes);
      }
      case "getCustomStates": {
        const cs = getCustomStatesStore(getActiveCampaign().roll20CampaignId);
        const out: { state: string; tag: string; tokens: { id: string; name: string }[] }[] = [];
        for (const key of Object.keys(cs)) {
          const entry = cs[key];
          const tokens: { id: string; name: string }[] = [];
          for (const tid of entry.tokens) {
            const p = await rtFindTokenPage(tid);
            const t = p ? await rtGet<Record<string, unknown>>(`graphics/page/${p}/${tid}`).catch(() => null) : null;
            tokens.push({ id: tid, name: String(t?.name || "") });
          }
          out.push({ state: key, tag: entry.tag, tokens });
        }
        return out;
      }
      case "listPages": {
        const pages = await rtGet<Record<string, Record<string, unknown>>>("pages");
        if (!pages) throw new Error("listPages: no pages in RTDB → Mod fallback");
        return Object.values(pages).map((p) => ({
          id: p.id, name: p.name, width: p.width, height: p.height,
        }));
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
        const pid = (cmd.pageId as string) || (await rtGet<Record<string, unknown>>("campaign"))?.playerpageid as string;
        if (!pid) throw new Error("getTokens: no player page in RTDB → Mod fallback");
        const g = await rtGet<Record<string, Record<string, unknown>>>(`graphics/page/${pid}`);
        if (!g || Object.keys(g).length === 0) throw new Error(`getTokens: graphics/page/${pid} empty in RTDB → Mod fallback`);
        const profile = (cmd.profile as string) || "full";
        return Object.values(g).map((t) => mapToken(t, profile));
      }
      case "getTokenById": {
        const pid = (cmd.pageId as string) || (await rtGet<Record<string, unknown>>("campaign"))?.playerpageid as string;
        if (!pid) throw new Error("getTokenById: no player page in RTDB → Mod global lookup");
        const t = await rtGet<Record<string, unknown> | null>(`graphics/page/${pid}/${cmd.tokenId}`);
        if (!t) throw new Error(`getTokenById: token ${String(cmd.tokenId)} not on player page → Mod global lookup`);
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

// --- Direct RTDB writes (token props/bars/markers straight to graphics/page/<id>, like the UI) ---
// Validated: accepted by rules, persisted, and propagated to all clients (incl. the Mod's getObj).
// Token writes are proven; map-object writes (walls/doors/windows) are likely valid — same RTDB auth,
// same collection pattern as graphics. Falls back to the Mod on any error so the caller is unaffected.
async function tryDirectWrite(cmd: Record<string, unknown>): Promise<unknown | typeof NOT_HANDLED> {
  if (cmd.__forceMod) return NOT_HANDLED;
  const action = cmd.action as string;
  try {
    switch (action) {
      // createWalls and createPolylines: RTDB direct writes to both pathv2/page/ and paths/page/
      // are rejected by Roll20's Firebase rules. Always use the Mod relay (which creates proper
      // pathv2 UDL barriers via createObj("pathv2", { shape:"pol", points:JSON.stringify([...]) })).
      case "createWalls":
      case "createPolylines":
        return NOT_HANDLED;
      case "createDLDoors": {
        const doors = cmd.doors as Array<{ x: number; y: number; x0: number; y0: number; x1: number; y1: number; color?: string }> | undefined;
        const pageId = cmd.pageId as string | undefined;
        if (!Array.isArray(doors) || !doors.length || !pageId) return NOT_HANDLED;
        const conn = await getConn();
        const baseRef = ref(conn.db, `${conn.storagePath}/doors/page/${pageId}`);
        const results = await Promise.all(doors.map(async (d) => {
          const doorRef = push(baseRef);
          await set(doorRef, stripUndefWrite({
            pageid: pageId,
            x: d.x, y: d.y,
            path: { handle0: { x: d.x0, y: d.y0 }, handle1: { x: d.x1, y: d.y1 } },
            color: d.color || "#FF0000",
            isOpen: false, isLocked: false, isSecret: false,
          }));
          return { id: doorRef.key };
        }));
        return results;
      }
      case "createDLWindows": {
        const windows = cmd.windows as Array<{ x: number; y: number; x0: number; y0: number; x1: number; y1: number; color?: string }> | undefined;
        const pageId = cmd.pageId as string | undefined;
        if (!Array.isArray(windows) || !windows.length || !pageId) return NOT_HANDLED;
        const conn = await getConn();
        const baseRef = ref(conn.db, `${conn.storagePath}/windows/page/${pageId}`);
        const results = await Promise.all(windows.map(async (w) => {
          const winRef = push(baseRef);
          await set(winRef, stripUndefWrite({
            pageid: pageId,
            x: w.x, y: w.y,
            path: { handle0: { x: w.x0, y: w.y0 }, handle1: { x: w.x1, y: w.y1 } },
            color: w.color || "#00FFFF",
            isOpen: false, isLocked: false, isSecret: false,
          }));
          return { id: winRef.key };
        }));
        return results;
      }
      case "clearDLOpenings": {
        const pageId = cmd.pageId as string | undefined;
        if (!pageId) return NOT_HANDLED;
        const conn = await getConn();
        await Promise.all([
          remove(ref(conn.db, `${conn.storagePath}/doors/page/${pageId}`)),
          remove(ref(conn.db, `${conn.storagePath}/windows/page/${pageId}`)),
        ]);
        return { removed: "all" };
      }
      case "setTokenBar": {
        const v = Number(cmd.value);
        if (!Number.isFinite(v)) return NOT_HANDLED; // let the Mod throw its descriptive error
        const pid = await rtFindTokenPage(cmd.tokenId as string, cmd.pageId as string | undefined);
        if (!pid) return NOT_HANDLED;
        const props: Record<string, unknown> = { bar1_value: v };
        if (cmd.max !== undefined && Number.isFinite(Number(cmd.max))) props.bar1_max = Number(cmd.max);
        await rtUpdate(`graphics/page/${pid}/${cmd.tokenId}`, props);
        return { ok: true };
      }
      case "setTokenProps": {
        const p = cmd.props as Record<string, unknown> | undefined;
        if (!p || typeof p !== "object" || !Object.keys(p).length) return NOT_HANDLED; // flattened shape → Mod
        const pid = await rtFindTokenPage(cmd.tokenId as string, cmd.pageId as string | undefined);
        if (!pid) return NOT_HANDLED;
        await rtUpdate(`graphics/page/${pid}/${cmd.tokenId}`, p);
        return { ok: true, set: Object.keys(p) };
      }
      case "setStatusMarker": {
        const marker = cmd.marker as string;
        if (!marker) return NOT_HANDLED; // malformed input guard before any transaction
        const pid = await rtFindTokenPage(cmd.tokenId as string, cmd.pageId as string | undefined);
        if (!pid) return NOT_HANDLED;
        const conn = await getConn();
        const smRef = ref(conn.db, `${conn.storagePath}/graphics/page/${pid}/${cmd.tokenId}/statusmarkers`);
        await runTransaction(smRef, (current: unknown) => {
          const markers = String(current ?? "").split(",").filter(Boolean);
          const i = markers.indexOf(marker);
          if (cmd.active && i === -1) markers.push(marker);
          else if (!cmd.active && i !== -1) markers.splice(i, 1);
          return markers.join(",");
        });
        return { ok: true };
      }
      case "adjustPcHp": {
        // Malformed-input guards before any transaction — caller gets NOT_HANDLED (Mod throws descriptive error).
        const hasOp = (cmd.setHp !== undefined && cmd.setHp !== null) || (cmd.damage !== undefined && cmd.damage !== null) || (cmd.heal !== undefined && cmd.heal !== null);
        if (!hasOp) return NOT_HANDLED;
        const pid = await rtFindTokenPage(cmd.tokenId as string, cmd.pageId as string | undefined);
        if (!pid) return NOT_HANDLED;
        // We need the token's name and bar values for the return shape; read them once outside the
        // transaction (they're not fields we're transacting on, so no race concern here).
        const conn = await getConn();
        const tokSnap = await get(ref(conn.db, `${conn.storagePath}/graphics/page/${pid}/${cmd.tokenId}`));
        const tok = tokSnap.val() as Record<string, unknown> | null;
        const name = String(tok?.name || "").split("\n")[0].trim();
        const tokBar = Number(tok?.bar1_value), tokMax = Number(tok?.bar1_max);
        // Capture computed values out of the transaction callback so we can include them in the return.
        // Sentinel NaN signals "transaction aborted" (callback returned currentGm unchanged).
        let computedNv = NaN, computedMax = 0;
        const gmRef = ref(conn.db, `${conn.storagePath}/graphics/page/${pid}/${cmd.tokenId}/gmnotes`);
        await runTransaction(gmRef, (currentGm: unknown) => {
          const existing = parsePcHpBlock(currentGm);
          const cur = existing && Number.isFinite(existing.current) ? existing.current : (Number.isFinite(tokBar) ? tokBar : 0);
          const max = existing && Number.isFinite(existing.max) && existing.max > 0 ? existing.max : (Number.isFinite(tokMax) ? tokMax : 0);
          let nv: number;
          if (cmd.setHp !== undefined && cmd.setHp !== null) nv = Number(cmd.setHp);
          else if (cmd.damage !== undefined && cmd.damage !== null) nv = Math.max(0, cur - Number(cmd.damage));
          else if (cmd.heal !== undefined && cmd.heal !== null) nv = max ? Math.min(max, cur + Number(cmd.heal)) : cur + Number(cmd.heal);
          else return currentGm; // abort: no valid operation (should not reach here due to outer guard)
          if (!Number.isFinite(nv)) return currentGm; // abort: bad numeric input — write clean string not NaN
          computedNv = nv;
          computedMax = max;
          const entry: PcHpEntry = { current: nv, max, name, updated: Date.now() };
          return writePcHpBlock(currentGm, entry);
        });
        // NaN sentinel means the transaction callback aborted — fall back to Mod path.
        if (!Number.isFinite(computedNv)) return NOT_HANDLED;
        return { ok: true, pc: true, name, current: computedNv, max: computedMax, tokenBar: Number.isFinite(tokBar) ? tokBar : null };
      }
      case "toggleCondition": {
        const cond = String(cmd.condition || "").toLowerCase().trim();
        if (!cond) return NOT_HANDLED; // malformed input guard before any transaction
        const pid = await rtFindTokenPage(cmd.tokenId as string, cmd.pageId as string | undefined);
        if (!pid) return NOT_HANDLED;
        const res = resolveMarkerForState(cond);
        const conn = await getConn();
        const smRef = ref(conn.db, `${conn.storagePath}/graphics/page/${pid}/${cmd.tokenId}/statusmarkers`);
        await runTransaction(smRef, (current: unknown) => {
          const markers = String(current ?? "").split(",").filter(Boolean);
          const i = markers.indexOf(res.tag);
          if (cmd.active && i === -1) markers.push(res.tag);
          else if (!cmd.active && i !== -1) markers.splice(i, 1);
          return markers.join(",");
        });
        // active_conditions sheet attr is vestigial (conditions are derived from statusmarkers), so
        // we don't write it. Only tier-2 custom states need tracking for getCustomStates.
        if (res.tier === "custom") trackCustomState(getActiveCampaign().roll20CampaignId, res.key, res.tag, cmd.tokenId as string, !!cmd.active);
        return { ok: true, marker: res.tag, tier: res.tier };
      }
      default:
        return NOT_HANDLED;
    }
  } catch (err) {
    if (process.env.RT_DEBUG) console.error(`[rt-debug] direct write ${action} failed → Mod fallback: ${(err as Error).message}`);
    return NOT_HANDLED;
  }
}

// Drop-in replacement for roll20.ts relayCommand. Reads + side-effect-free token writes are served
// directly off the socket (no Mod, no chat); everything else (writes with side effects, un-mapped
// reads) is pushed to /chat for the Mod and awaits the AIBRIDGE_RESULT whisper. Throws on
// timeout/auth failure so callers can fall back to the browser.
//
// `assignedNonce` is an optional pre-generated nonce from the caller (roll20.ts `relayCommand`).
// When provided, the same nonce is used for the Mod chat push — this enables same-nonce retries
// and cross-transport fallback without risk of double-apply (the Mod's LRU deduplicates resends).
// Direct callers like `pingMod` omit it and get an internally-generated nonce as before.
export async function rtRelayCommand<T>(
  cmd: Record<string, unknown>,
  opts: { probe?: boolean; timeoutOverrideMs?: number; assignedNonce?: number } = {}
): Promise<T> {
  const direct = await tryDirectRead(cmd);
  if (direct !== NOT_HANDLED) return direct as T;
  const directWrite = await tryDirectWrite(cmd);
  if (directWrite !== NOT_HANDLED) return directWrite as T;

  let conn: RtConn;
  try {
    conn = await getConn();
  } catch (e) {
    if (!opts.probe) recordFailure("rt");
    throw new RtPreSendError(`rt pre-send (getConn): ${(e as Error).message}`);
  }
  // Use caller-assigned nonce when provided (enables idempotent cross-transport fallback);
  // otherwise draw from the SAME shared generator (actions.ts) as roll20.ts — two independent
  // Date.now()-seeded counters could collide, and the Mod dedupes by nonce.
  const nonce = opts.assignedNonce !== undefined ? opts.assignedNonce : newNonce();
  const content = "!ai-relay " + JSON.stringify({ ...cmd, nonce });

  const timeoutMs = opts.timeoutOverrideMs ?? (READONLY_ACTIONS.has(cmd.action as string) ? 8_000 : RELAY_TIMEOUT_MS);
  const result = new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(nonce);
      if (!opts.probe) recordFailure("rt");
      reject(new Error(`rt relay timeout after ${timeoutMs}ms for action: ${cmd.action}`));
    }, timeoutMs);
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

  return result.then((r) => { recordSuccess("rt"); return r; });
}

// Lightweight liveness probe — uses the normal relay machinery but with a short
// timeout and without recording a health failure on miss (it's a probe, not a command).
export async function pingMod(timeoutMs = 6_000): Promise<boolean> {
  try {
    await rtRelayCommand({ action: "ping" }, { probe: true, timeoutOverrideMs: timeoutMs });
    return true;
  } catch {
    return false;
  }
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
    const base = conn.databaseURL.replace(/\/+$/, "");
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

// Recon escape hatch: raw handle to the connected RTDB instance so diagnostic
// scripts (src/recon/*) can attach their own listeners to arbitrary paths.
// Production code must keep using rtGet/rtUpdate/rtRelayCommand.
export async function rtRawDb(): Promise<{ db: import("firebase/database").Database; storagePath: string }> {
  const conn = await getConn();
  return { db: conn.db, storagePath: conn.storagePath };
}

// Merge-write fields onto a node under the storage root (RTDB update = partial merge), like the
// Roll20 UI does when you edit a token. No Mod, no chat.
export async function rtUpdate(relPath: string, partial: Record<string, unknown>): Promise<void> {
  const conn = await getConn();
  const clean = relPath.replace(/^\/+|\/+$/g, "");
  await update(ref(conn.db, `${conn.storagePath}/${clean}`), stripUndefWrite(partial));
}

// Delete a node (set null), like the UI deleting an object.
export async function rtRemove(relPath: string): Promise<void> {
  const conn = await getConn();
  const clean = relPath.replace(/^\/+|\/+$/g, "");
  await remove(ref(conn.db, `${conn.storagePath}/${clean}`));
}

// Resolve which page a token is on (cached; tries hint → cache → player/initiative page). Each
// candidate is verified by an existence read, so a stale cache entry can't misdirect a write.
// Returns null if not found on those pages → caller falls back to the Mod's global getObj lookup.
const _tokenPageCache = new Map<string, string>();
export async function rtFindTokenPage(tokenId: string, hintPageId?: string): Promise<string | null> {
  if (!_campaignPageCache || Date.now() - _campaignPageCacheAt > CAMPAIGN_CACHE_TTL_MS) {
    const raw = await rtGet<Record<string, unknown>>("campaign");
    _campaignPageCache = {
      playerpageid: raw?.playerpageid as string ?? "",
      initiativepage: raw?.initiativepage as string ?? "",
    };
    _campaignPageCacheAt = Date.now();
  }
  const campaign = _campaignPageCache;
  const candidates = [hintPageId, _tokenPageCache.get(tokenId), campaign?.playerpageid as string, campaign?.initiativepage as string]
    .filter((p, i, a) => p && a.indexOf(p) === i) as string[];
  for (const pid of candidates) {
    const t = await rtGet<unknown>(`graphics/page/${pid}/${tokenId}`).catch(() => null);
    if (t) { _tokenPageCache.set(tokenId, pid); return pid; }
  }
  _tokenPageCache.delete(tokenId);
  return null;
}

// ─── RTDB Broadcast (SSE event source for the gem HUD) ───────────────────────

export interface TurnOrderEntry { id?: string; pr?: string | number; custom?: string; formula?: string }
export interface MobPlanData { name: string; shortTerm: string; mediumTerm?: string; longGoal?: string }
export interface DmInboxEntry { who: string; playerid: string; content: string; type: "query" | "intent"; timestamp: number; key: string }

export type RtdbBroadcastEvent =
  | { type: "combat-update"; turnOrder: TurnOrderEntry[]; round: number }
  | { type: "mob-plan"; tokenId: string; plan: MobPlanData }
  | { type: "inbox-item"; item: DmInboxEntry }
  | { type: "sandbox-status"; ok: boolean }
  | { type: "map-ping"; ping: MapPing };

// Latest map ping seen on the `broadcast` channel. Aged by OUR receive clock,
// not the sender's ts (client clocks skew).
let _lastPing: { ping: MapPing; receivedAt: number } | null = null;
export function getLastPing(maxAgeMs = 180_000): MapPing | null {
  if (!_lastPing || Date.now() - _lastPing.receivedAt > maxAgeMs) return null;
  return _lastPing.ping;
}

type EventCallback = (event: RtdbBroadcastEvent) => void;
const _eventSubs = new Set<EventCallback>();
export function onRtdbEvent(cb: EventCallback): () => void {
  _eventSubs.add(cb);
  return () => _eventSubs.delete(cb);
}
function _broadcast(event: RtdbBroadcastEvent): void {
  for (const cb of _eventSubs) cb(event);
}
export function broadcastSandboxStatus(ok: boolean): void {
  _broadcast({ type: "sandbox-status", ok });
}

// Round tracking for combat-update events (mirrors the Mod's B().round logic)
let _prevFirstId: string | null = null;
let _prevFirstPr: number | null = null;
let _currentRound = 0;
let _subscriptionsStarted = false;
let _subsWanted = false; // set true on first startRtdbSubscriptions() call; survives campaign switch
let _subsLastFailure = 0;
let _subsInFlight: Promise<void> | null = null;

// Reset all per-campaign in-memory state. Called on campaign switch and full reconnect.
// Does NOT reset _subsWanted (that survives switches — if subscriptions were requested once,
// we re-subscribe after the new connection is established).
function _resetPerCampaignState() {
  _clearCampaignPageCache();
  chatBuffer.length = 0;
  seenKeys.clear();
  _tokenPageCache.clear();
  _lastPing = null;
  // Round tracking is per-campaign — reset so the new campaign starts fresh.
  _prevFirstId = null;
  _prevFirstPr = null;
  _currentRound = 0;
  // Allow subscriptions to restart for the new campaign.
  _subscriptionsStarted = false;
  _subsInFlight = null;
}

export function startRtdbSubscriptions(): Promise<void> {
  _subsWanted = true;
  if (_subscriptionsStarted) return Promise.resolve();
  if (_subsInFlight) return _subsInFlight;
  if (Date.now() - _subsLastFailure < 60_000) {
    return Promise.reject(new Error("rtdb subscriptions: backing off after recent failure"));
  }
  _subsInFlight = _doStartRtdbSubscriptions().finally(() => {
    _subsInFlight = null;
  });
  return _subsInFlight;
}

async function _doStartRtdbSubscriptions(): Promise<void> {
  _subscriptionsStarted = true;
  try {
    const conn = await getConn();

    // Turn order — fires on every turn advance
    const toPath = ref(conn.db, `${conn.storagePath}/campaign/turnorder`);
    onValue(toPath, (snap) => {
      const order = parseTurnorder(snap.val()) as TurnOrderEntry[];
      const firstReal = order.find((e) => e.id && String(e.id) !== "-1") ?? null;
      const firstId = firstReal ? String(firstReal.id ?? "") : null;
      const firstPr = firstReal ? Number(firstReal.pr ?? 0) : null;

      if (firstId && firstPr !== null) {
        if (_currentRound === 0) {
          _currentRound = 1;
        } else if (_prevFirstId && firstId !== _prevFirstId && _prevFirstPr !== null && firstPr > _prevFirstPr) {
          _currentRound++; // order wrapped → new round
        }
      } else if (!firstId) {
        _currentRound = 0; // no combatants → out of combat
      }
      _prevFirstId = firstId;
      _prevFirstPr = firstPr;
      _broadcast({ type: "combat-update", turnOrder: order, round: _currentRound });
    });

    // NOTE: there are no aibridge/mobPlans or aibridge/dmInbox subscriptions here. Roll20's RTDB
    // rules deny client writes to the custom aibridge/* subtree on every shard, so those nodes are
    // never populated and a subscription would never fire. Mob plans and inbox items are delivered
    // to the HUD by direct in-process SSE broadcast instead (publishMobPlan / publishInboxItem).

    // Map pings: the `broadcast` node is a single-value channel overwritten on each
    // shift+click ping (discovered via src/recon/ping-sniff.ts). Remember the latest
    // so resolve_aoe's atPing targeting can use "fireball where I pinged".
    const broadcastPath = ref(conn.db, `${conn.storagePath}/broadcast`);
    onValue(broadcastPath, (snap) => {
      const ping = parseBroadcastPing(snap.val());
      if (ping) {
        _lastPing = { ping, receivedAt: Date.now() };
        _broadcast({ type: "map-ping", ping });
      }
    });

    console.error("[rtdb] RTDB subscriptions started");
    _subsLastFailure = 0;
  } catch (e) {
    _subscriptionsStarted = false;
    _subsLastFailure = Date.now();
    throw e;
  }
}

// Deliver a mob plan to the gem HUD. The plan is generated in the same process that hosts the
// SSE /events stream, so we broadcast it straight to connected clients. We do NOT write it to
// RTDB: Roll20's security rules deny client writes to our custom aibridge/* subtree on EVERY
// shard (verified PERMISSION_DENIED on roll20-99910 and roll20-99922), and the Mod's API sandbox
// has no Firebase access, so neither side could ever populate that node. Cross-session/reconnect
// replay, if needed, must come from the Mod via the getMobPlans relay action (servable on any
// shard) — never a client RTDB write.
export function publishMobPlan(tokenId: string, plan: MobPlanData): void {
  _broadcast({ type: "mob-plan", tokenId, plan });
}

// Deliver a DM-inbox item to the gem HUD. Same rationale as publishMobPlan: the aibridge/dmInbox
// node is write-denied on every shard, so broadcast straight to the in-process SSE stream rather
// than round-tripping through RTDB.
export function publishInboxItem(item: DmInboxEntry): void {
  _broadcast({ type: "inbox-item", item });
}
