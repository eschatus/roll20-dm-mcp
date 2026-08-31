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
// during operation — all traffic is the socket. RT is the only transport (#122/#179) — there is
// no runtime switch for it.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import path from "path";
import { dataPath } from "../dataDir.js";
import { initializeApp, deleteApp, type FirebaseApp } from "firebase/app";
import { getAuth, signInWithCustomToken, type User } from "firebase/auth";
import {
  getDatabase, ref, get, push, set, update, remove, runTransaction, serverTimestamp, query, limitToLast, onChildAdded, onValue,
  type Database, type DatabaseReference,
} from "firebase/database";
import { getActiveCampaign } from "../registry/campaigns.js";
import { READONLY_ACTIONS, newNonce } from "./actions.js";
import { recordSuccess, recordFailure } from "./transport-health.js";
import { resolveMarkerForState, computeHpThresholds, WOUNDED_MARKER, DEAD_MARKER } from "./markers.js";
import { trackCustomState, getCustomStates as getCustomStatesStore } from "./relayState.js";
import {
  AIBRIDGE_MARKER as MARKER, parseAibridge, cleanChat, resolveInlineRolls,
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
interface RtCredential { customToken: string; databaseURL: string }

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

/**
 * Raised when no usable Roll20 realtime credential is available. The server READS this
 * credential; it never mints one. Harvesting is a first-party, human-attended act that
 * belongs in the gem's own Electron session (issue #177, sibling of #175) — an MCP server
 * must not be able to open a browser against a live account on its own initiative.
 *
 * Deliberately loud: a silent browser harvest is exactly the failure mode #83 closed on the
 * relay path, and the same reasoning applies to the credential the relay runs on.
 */
export class Roll20TokenUnavailableError extends Error {
  constructor(readonly campaignId: string, reason: string) {
    super(
      `No usable Roll20 realtime token for campaign ${campaignId} (${reason}). ` +
      `This server reads the token but never harvests one — reconnect Roll20 in the gem to ` +
      `re-harvest, or point ROLL20_DATA_DIR at the data dir holding a current ` +
      `roll20-rt-token.json for THIS campaign (the token is campaign-scoped).`
    );
    this.name = "Roll20TokenUnavailableError";
  }
}

async function getCustomToken(campaignId: string, forceFresh = false): Promise<RtCredential> {
  if (!forceFresh) {
    const c = readTokenCache();
    // Require databaseURL too: a pre-shard-fix cache entry lacks it, so treat that as a miss and
    // re-harvest to capture the namespace (otherwise we'd reconnect to the wrong shard).
    if (c && c.campaignId === campaignId && c.databaseURL && Date.now() - c.harvestedAt < TOKEN_MAX_AGE_MS) {
      return { customToken: c.customToken, databaseURL: c.databaseURL };
    }
  }
  // No harvest fallback by design (#177): read it or fail loudly.
  const c = readTokenCache();
  if (!c) throw new Roll20TokenUnavailableError(campaignId, "no token file — nothing has harvested one");
  if (c.campaignId !== campaignId) {
    throw new Roll20TokenUnavailableError(
      campaignId,
      `the cached token belongs to campaign ${c.campaignId}; tokens are campaign-scoped`,
    );
  }
  if (!c.databaseURL) throw new Roll20TokenUnavailableError(campaignId, "cached token predates shard capture and has no databaseURL");
  throw new Roll20TokenUnavailableError(
    campaignId,
    `cached token is ${Math.round((Date.now() - c.harvestedAt) / 60000)}m old (max ${Math.round(TOKEN_MAX_AGE_MS / 60000)}m)`,
  );
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

// Parse a /chat child into the cleaned table-chat shape shared by the buffer
// (get_recent_chat) and the SSE forwarder (forwardChat) — ONE place decides what
// counts as table chat, so the two views can't drift. Returns null for the
// bridge's own traffic: !ai-relay commands and API-origin Mod output (incl.
// AIBRIDGE whispers).
function parseTableChat(val: unknown): { who: string; playerid: string; type: string; content: string; contentRaw: string; inlinerolls: { expression: string; total: number | null }[] } | null {
  const m = val as { content?: unknown; who?: unknown; type?: unknown; playerid?: unknown; inlinerolls?: unknown };
  const content = m?.content;
  if (typeof content !== "string") return null;
  if (content.startsWith("!ai-relay")) return null;     // our own commands
  if (m.playerid === "API") return null;                // bridge/Mod output (incl. AIBRIDGE whispers)
  const rolls = Array.isArray(m.inlinerolls) ? m.inlinerolls : [];
  const inlinerolls = rolls.map((r) => {
    const rr = r as { expression?: string; results?: { total?: number } };
    return { expression: String(rr?.expression ?? ""), total: rr?.results?.total ?? null };
  });
  return {
    who: String(m.who || ""),
    playerid: String(m.playerid || ""),
    type: String(m.type || ""),
    // Resolve $[[n]] roll pointers against inlinerolls BEFORE cleanChat truncates (#187), so
    // `content` carries the actual totals instead of indices into a sibling array.
    content: cleanChat(resolveInlineRolls(content, inlinerolls)),
    contentRaw: content,
    inlinerolls,
  };
}

function bufferChat(val: unknown): void {
  const entry = parseTableChat(val);
  if (!entry) return;
  chatBuffer.push({
    who: entry.who,
    type: entry.type,
    content: entry.content,
    inlinerolls: entry.inlinerolls,
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
  // An AIBRIDGE result resolves a pending relay; anything else is real table chat →
  // buffer it (get_recent_chat) and forward it over the SSE stream (external brain).
  if (!tryResolveContent(content)) {
    bufferChat(val);
    forwardChat(val, key, live);
  }
}

// Forward live table chat — players' messages, !-commands, !dm — over the in-process
// SSE stream so an external subscriber (the gem) can run its own player-command
// handling without a relay round-trip (#171: the transport stays here, the brain moves
// out). What counts as table chat is decided by parseTableChat, shared with the chat
// buffer; live-only so the connect-time replay burst can't re-fire a subscriber's
// handlers.
function forwardChat(val: unknown, key: string | null, live: boolean): void {
  if (!live) return;
  const entry = parseTableChat(val);
  if (!entry) return;
  _broadcast({
    type: "chat-message",
    message: {
      who: entry.who,
      playerid: entry.playerid,
      type: entry.type,
      content: entry.content,
      isCommand: entry.contentRaw.startsWith("!"),
      inlinerolls: entry.inlinerolls,
      timestamp: Date.now(),
      key,
    },
  });
}

// Narrow test seam: drive the chat-child handler directly (src/bridge/roll20-rt.chat.test.ts)
// without a live RTDB connection. Same pattern as __setAnthropicForTest elsewhere.
export const __handleChatChildForTest = handleChatChild;

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
// Reads answered wholly from in-memory state — the live chat buffer, the custom-states store —
// instead of from RTDB. Because they touch no socket, nothing in them can surface a dead
// credential: they hand back a confident EMPTY answer at the same moment every other read is
// erroring on the expired token (#186). A caller then cannot tell "quiet table" from "not
// connected", which is worst exactly where get_recent_chat earns its keep — reading Beyond20
// save-DC and attack cards. An agent sees [], concludes nothing was rolled, and invents a number.
//
// So gate them on the connection first. That is sufficient on its own, and no separate
// subscription-liveness flag is needed, because connect() is what installs the /chat
// onChildAdded listener that fills the buffer: if getConn() resolves, the buffer is being fed,
// and an empty result afterwards is a real answer ("connected, nothing there") rather than a
// failure wearing the same clothes.
const MEMORY_SERVED_READS = new Set(["getRecentChat", "getCustomStates"]);

async function tryDirectRead(cmd: Record<string, unknown>): Promise<unknown | typeof NOT_HANDLED> {
  const action = cmd.action as string;
  if (cmd.__forceMod) return NOT_HANDLED; // debug/escape hatch: force the Mod path
  try {
    // Liveness gate for the in-memory reads above. A dead credential throws here, falls through
    // to the Mod path, and surfaces as the same RtPreSendError every other read gives — one
    // error for one broken thing, instead of two reads disagreeing about whether we're connected.
    if (MEMORY_SERVED_READS.has(action)) await getConn();
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
        // No .catch (#192): rtGet returns snap.val(), which is null for a MISSING node — it
        // does not throw — and the Object.values(x || {}) below already covers that. A catch
        // here could therefore only mask a REAL failure (auth expiry, permission denied,
        // transport down) and report "no doors on this page" for a read that never landed.
        const doors = await rtGet<Record<string, Record<string, unknown>>>(`doors/page/${cmd.pageId}`);
        const windows = await rtGet<Record<string, Record<string, unknown>>>(`windows/page/${cmd.pageId}`);
        return {
          doors: Object.values(doors || {}).map((d) => mapOpening(d, "door")),
          windows: Object.values(windows || {}).map((w) => mapOpening(w, "window")),
        };
      }
      case "getPaths": {
        const layer = cmd.layer as string | undefined;
        const includePath = cmd.includePath === true;
        // Same reasoning as getDoors (#192): a missing node is null, already handled below,
        // so this catch could only hide a real failure — and an empty wall list reads as
        // "no walls placed", which is exactly what a wall-placement QC pass checks for.
        const paths = await rtGet<Record<string, Record<string, unknown>>>(`paths/page/${cmd.pageId}`);
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
      case "getJournalFolder": {
        // Jumpgate stores the journal tree as a JSON string at campaign/journalfolder.
        // (The Mod's legacy "_journalfolder" attribute does NOT exist on this backend —
        // it's a dead field, so the Mod read/write path silently no-ops. See the
        // journal-folder-probe recon.)
        const campaign = await rtGet<Record<string, unknown>>("campaign");
        const raw = campaign?.journalfolder;
        return typeof raw === "string" && raw ? JSON.parse(raw) : Array.isArray(raw) ? raw : [];
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
      case "setJournalFolder": {
        // Jumpgate stores the journal tree as a JSON STRING at campaign/journalfolder
        // (NOT the Mod's legacy "_journalfolder", a dead field that silently no-ops here —
        // that masked-as-success write left every object unfiled at the root). Append mode
        // read-modify-writes under a transaction so a concurrent journal edit can't clobber.
        const json = cmd.json;
        const isAppend = !!(json && typeof json === "object" && !Array.isArray(json) &&
          (json as { __append__?: unknown }).__append__);
        const conn = await getConn();
        const jfRef = ref(conn.db, `${conn.storagePath}/campaign/journalfolder`);
        if (isAppend) {
          const additions = (json as { __append__: unknown[] }).__append__;
          if (!Array.isArray(additions)) return NOT_HANDLED; // malformed → let the Mod throw
          let total = 0;
          await runTransaction(jfRef, (current: unknown) => {
            const tree = typeof current === "string" && current ? JSON.parse(current)
              : Array.isArray(current) ? current : [];
            for (const f of additions) tree.push(f);
            total = tree.length;
            return JSON.stringify(tree);
          });
          return { ok: true, appended: additions.length, total };
        }
        const tree = Array.isArray(json) ? json : [];
        await set(jfRef, JSON.stringify(tree));
        return { ok: true, total: tree.length };
      }
      case "setTokenBar": {
        const v = Number(cmd.value);
        if (!Number.isFinite(v)) return NOT_HANDLED; // let the Mod throw its descriptive error
        const pid = await rtFindTokenPage(cmd.tokenId as string, cmd.pageId as string | undefined);
        if (!pid) return NOT_HANDLED;
        const tokPath = `graphics/page/${pid}/${cmd.tokenId}`;
        const conn = await getConn();
        let max: number | undefined = cmd.max !== undefined && Number.isFinite(Number(cmd.max)) ? Number(cmd.max) : undefined;
        if (max === undefined) {
          // Caller didn't pass max (e.g. a plain HP set) — read the token's own bar1_max so the
          // threshold automation below still has a real max to compare against.
          const maxSnap = await get(ref(conn.db, `${conn.storagePath}/${tokPath}/bar1_max`));
          const existingMax = Number(maxSnap.val());
          if (Number.isFinite(existingMax)) max = existingMax;
        }
        const props: Record<string, unknown> = { bar1_value: v };
        if (max !== undefined) props.bar1_max = max;
        // Bloodied/wounded + auto-death threshold automation (issue #141) — SYMMETRIC,
        // arithmetic-only (computeHpThresholds, unit-tested), applied server-side so the
        // model's working memory is never the source of truth. This is the RT-default
        // direct-write path — it bypasses mod-scripts/ai-relay.js entirely for a single
        // setTokenBar call, so ai-relay.js's ACTIONS["setTokenBar"] + runBatchOp carry a
        // hand-synced copy of this same arithmetic for the batchExec/browser-transport path.
        const { wounded, dead } = computeHpThresholds(v, max ?? 0);
        if (dead) props.layer = "map";
        await rtUpdate(tokPath, props);
        if (max) {
          const smRef = ref(conn.db, `${conn.storagePath}/${tokPath}/statusmarkers`);
          await runTransaction(smRef, (current: unknown) => {
            const markers = String(current ?? "").split(",").filter(Boolean);
            const dropWounded = () => {
              const i = markers.indexOf(WOUNDED_MARKER);
              if (i !== -1) markers.splice(i, 1);
            };
            if (dead) {
              dropWounded();
              if (markers.indexOf(DEAD_MARKER) === -1) markers.push(DEAD_MARKER);
            } else if (wounded) {
              if (markers.indexOf(WOUNDED_MARKER) === -1) markers.push(WOUNDED_MARKER);
            } else {
              dropWounded();
            }
            return markers.join(",");
          });
        }
        return { ok: true, wounded, dead };
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
  try {
    await set(msgRef, {
      avatar: conn.avatar,
      content,
      messageId,
      playerid: conn.playerid,
      type: "api",
      who: "DM (GM)",
      ".priority": serverTimestamp(),
    } as Record<string, unknown>);
  } catch (e) {
    // The send failed, so `result` will never be resolved by an AIBRIDGE_RESULT. Its timeout
    // timer is still armed, though — left alone it fires ~timeoutMs later and rejects a promise
    // NOBODY is awaiting (we throw below, before `return result.then(...)`), which surfaces as an
    // unhandled rejection and crashes the process (observed: "rt relay timeout … action: ping"
    // after an RTDB write hiccup). Cancel the timer + drop the pending entry so nothing dangles.
    const p = pending.get(nonce);
    if (p) { clearTimeout(p.timer); pending.delete(nonce); }
    if (!opts.probe) recordFailure("rt");
    throw new RtPreSendError(`rt send (set): ${(e as Error).message}`);
  }

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

// Create a Roll20 PAGE by writing the campaign's RTDB `pages` node directly (#178).
//
// CLAUDE.md's "`createObj("page")` is unsupported" is a MOD SANDBOX limitation and says nothing
// about RTDB. Verified live against a throwaway campaign: push() + set() is accepted, all fields
// read back, and the page opens and edits normally in the editor. This replaces the Playwright
// `createPageViaUI`, which was a workaround for a restriction that never applied to this path.
//
// UNITS — the thing that will bite you: `width`/`height` are 70px UNITS, not cells. The rendered
// cell size is `70 * snapping_increment`, so cells = (width * 70) / (70 * snapping_increment).
// With the default snapping_increment of 1 the page is `widthSquares` standard 70px squares, which
// is what every caller means. Writing width as a cell count with a fractional increment silently
// produces a page 1/increment too big.
//
// NOTE the RTDB page carries only 16 fields — no scale_number/scale_units/showgrid/background_color.
// Those live on the MOD's page object, so callers finish the job with a setPageProps relay call.
export async function rtCreatePage(opts: {
  name: string;
  widthSquares: number;
  heightSquares: number;
  snappingIncrement?: number;
}): Promise<string> {
  const { db, storagePath } = await rtRawDb();

  // Mirror an existing page: it is the only trustworthy source for the client-filled fields, and
  // guessing a minimal object is how you get a page that lists but will not open.
  const pages = await rtGet<Record<string, Record<string, unknown>>>("pages");
  const template = Object.values(pages ?? {})[0];
  if (!template) throw new Error("rtCreatePage: campaign has no existing page to mirror a schema from");

  const page: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(template)) {
    if (typeof v === "object" && v !== null) continue;   // subcollections are separate nodes
    page[k] = v;
  }

  // Per-page CONTENT must be reset, never inherited: zorder is the template's own object stacking
  // list, thumbnail is its map art, and placement is its slot in the page list.
  const placements = Object.values(pages ?? {})
    .map((p) => Number(p?.placement))
    .filter((n) => Number.isFinite(n));
  page.zorder = "";
  page.thumbnail = "";
  page.placement = (placements.length ? Math.max(...placements) : 0) + 10;
  page.name = opts.name;
  page.width = opts.widthSquares;
  page.height = opts.heightSquares;
  page.snapping_increment = opts.snappingIncrement ?? 1;

  const newRef = push(ref(db, `${storagePath}/pages`));
  page.id = newRef.key;                     // Roll20 objects carry their own id
  await set(newRef, stripUndefWrite(page));
  return newRef.key!;
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

// Live table chat forwarded raw over SSE (see forwardChat): every player message,
// !-command, and !dm — never the bridge's own traffic. `key` is the RTDB child key
// (subscriber-side dedup); `isCommand` flags !-prefixed messages.
export interface ChatMessageEvent {
  who: string;
  playerid: string;
  type: string;
  content: string;
  isCommand: boolean;
  inlinerolls: { expression: string; total: number | null }[];
  timestamp: number;
  key: string | null;
}

export type RtdbBroadcastEvent =
  | { type: "combat-update"; turnOrder: TurnOrderEntry[]; round: number }
  // plan:null = the plan was CLEARED — subscribers must drop the token's card.
  | { type: "mob-plan"; tokenId: string; plan: MobPlanData | null }
  | { type: "inbox-item"; item: DmInboxEntry }
  | { type: "sandbox-status"; ok: boolean }
  | { type: "map-ping"; ping: MapPing }
  | { type: "chat-message"; message: ChatMessageEvent };

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
// plan:null broadcasts a CLEAR — the HUD drops the token's card.
export function publishMobPlan(tokenId: string, plan: MobPlanData | null): void {
  _broadcast({ type: "mob-plan", tokenId, plan });
}

// Deliver a DM-inbox item to the gem HUD. Same rationale as publishMobPlan: the aibridge/dmInbox
// node is write-denied on every shard, so broadcast straight to the in-process SSE stream rather
// than round-tripping through RTDB.
export function publishInboxItem(item: DmInboxEntry): void {
  _broadcast({ type: "inbox-item", item });
}
