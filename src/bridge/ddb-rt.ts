// D&D Beyond realtime transport — browserless reads over plain HTTP.
//
// Mirrors src/bridge/roll20-rt.ts: the browser is touched ONCE (cold start) to harvest the
// long-lived `CobaltSession` cookie from the persistent logged-in profile, cached to disk and
// only re-harvested on auth failure. Everything else is plain Node `fetch` — no Chromium.
//
// Auth chain (validated live, see docs/ddb-browserless-protocol.md):
//   CobaltSession cookie ──POST auth-service/v1/cobalt-token──▶ short-lived JWT (ttl 300s)
//   JWT  ──Bearer──▶  character-service / monster-service reads
//   CobaltSession cookie (raw)  ──▶  www.dndbeyond.com campaign APIs
//
// Enabled by default; force the old Playwright path with DDB_TRANSPORT=browser. Set DDB_COBALT
// in the env to skip the browser entirely (fully browserless cold start).

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import path from "path";
import { getPage, closeBrowser } from "./browser.js";

const AUTH_SVC = "https://auth-service.dndbeyond.com/v1/cobalt-token";
const CHAR_SVC = "https://character-service.dndbeyond.com/character/v5";
const MON_SVC = "https://monster-service.dndbeyond.com/v1/Monster";
const WWW = "https://www.dndbeyond.com";

const COBALT_CACHE = path.resolve("./data/ddb-cobalt.json");
// JWT lives 300s; refresh with a margin so a call never races the expiry.
const JWT_MARGIN_MS = 30_000;

// A realistic desktop-Chrome fingerprint. www.dndbeyond.com is Cloudflare-fronted but (validated)
// serves JSON to a plain fetch with this UA; the api hosts don't challenge at all.
const BASE_HEADERS: Record<string, string> = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept": "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
};

export function ddbRtEnabled(): boolean {
  return (process.env.DDB_TRANSPORT || "rt").toLowerCase() !== "browser";
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- CobaltSession cookie (env → disk → browser harvest) ---

interface CobaltCache { cookie: string; harvestedAt: number }
let _cobaltMem: string | null = null;

function readCobaltCache(): string | null {
  try { return existsSync(COBALT_CACHE) ? (JSON.parse(readFileSync(COBALT_CACHE, "utf-8")) as CobaltCache).cookie : null; }
  catch { return null; }
}

function writeCobaltCache(cookie: string): void {
  mkdirSync(path.dirname(COBALT_CACHE), { recursive: true });
  writeFileSync(COBALT_CACHE, JSON.stringify({ cookie, harvestedAt: Date.now() } as CobaltCache), "utf-8");
}

async function harvestCobalt(): Promise<string> {
  const page = await getPage("ddb");
  const cookies = await page.context().cookies();
  const cobalt = cookies.find((c) => c.name === "CobaltSession" && c.domain.includes("dndbeyond"))?.value;
  if (!cobalt) throw new Error("ddb-rt: CobaltSession cookie not found — log into D&D Beyond in the browser");
  writeCobaltCache(cobalt);
  _cobaltMem = cobalt;
  // Cookie cached — close the browser now; it reopens on demand for any Mod-relay writes.
  closeBrowser().catch(() => {});
  return cobalt;
}

async function getCobalt(forceFresh = false): Promise<string> {
  if (!forceFresh) {
    if (process.env.DDB_COBALT) return process.env.DDB_COBALT;
    if (_cobaltMem) return _cobaltMem;
    const disk = readCobaltCache();
    if (disk) { _cobaltMem = disk; return disk; }
  }
  return harvestCobalt();
}

// --- cobalt → short-lived JWT (in-memory cache, re-harvest cobalt on 401) ---

interface JwtCache { token: string; expiresAt: number }
let _jwt: JwtCache | null = null;

async function exchangeForJwt(cobalt: string): Promise<{ token: string; ttl: number }> {
  const res = await fetch(AUTH_SVC, {
    method: "POST",
    headers: { ...BASE_HEADERS, "Content-Type": "application/json", Cookie: `CobaltSession=${cobalt}` },
    body: "{}",
  });
  if (!res.ok) {
    const err = new Error(`ddb-rt cobalt-token ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
    (err as { status?: number }).status = res.status;
    throw err;
  }
  return res.json() as Promise<{ token: string; ttl: number }>;
}

async function getJwt(forceFresh = false): Promise<string> {
  if (!forceFresh && _jwt && Date.now() < _jwt.expiresAt) return _jwt.token;
  // Two attempts: a fresh exchange, then (on 401/403) a re-harvested cobalt in case the cached one expired.
  for (let attempt = 0; attempt < 2; attempt++) {
    const cobalt = await getCobalt(attempt > 0);
    try {
      const { token, ttl } = await exchangeForJwt(cobalt);
      _jwt = { token, expiresAt: Date.now() + ttl * 1000 - JWT_MARGIN_MS };
      _cobaltMem = cobalt; // exchange succeeded → this cobalt is good; keep it hot
      return token;
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (attempt === 0 && (status === 401 || status === 403)) { _jwt = null; continue; }
      throw err;
    }
  }
  throw new Error("ddb-rt: JWT exchange failed after re-harvest");
}

// --- plain-fetch core, with jwt-refresh on 401 and a retry on undici connection blips ---

// `cookie:true` attaches the raw CobaltSession alongside whatever `auth` mode is in play. The
// www.dndbeyond.com campaign APIs need BOTH the JWT bearer (for authorization) and the session
// cookie — cookie alone returns the SPA login HTML, bearer alone is rejected.
interface RtFetchOpts { auth?: "bearer" | "cookie" | "none"; cookie?: boolean; method?: string; body?: string }

async function rtFetch(url: string, opts: RtFetchOpts = {}): Promise<Response> {
  const auth = opts.auth ?? "bearer";
  for (let attempt = 0; attempt < 2; attempt++) {
    const headers: Record<string, string> = { ...BASE_HEADERS };
    if (opts.body) headers["Content-Type"] = "application/json";
    if (auth === "bearer") headers["Authorization"] = `Bearer ${await getJwt(attempt > 0)}`;
    if (auth === "cookie" || opts.cookie) headers["Cookie"] = `CobaltSession=${await getCobalt()}`;
    try {
      const res = await fetch(url, { method: opts.method ?? "GET", headers, ...(opts.body ? { body: opts.body } : {}) });
      // A 401 on a bearer call usually means the JWT lapsed mid-flight — refresh once and retry.
      if (res.status === 401 && auth === "bearer" && attempt === 0) { _jwt = null; continue; }
      return res;
    } catch (err) {
      // character-service intermittently throws undici "fetch failed" at connect time; one retry clears it.
      if (attempt === 0 && /fetch failed/i.test(String(err))) { await sleep(300); continue; }
      throw err;
    }
  }
  throw new Error(`ddb-rt: ${url} retries exhausted`);
}

async function rtJson<T>(url: string, opts?: RtFetchOpts): Promise<T> {
  const res = await rtFetch(url, opts);
  if (!res.ok) throw new Error(`ddb-rt ${url} → ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
  return res.json() as Promise<T>;
}

// --- typed reads (raw payloads; domain mapping stays in dndbeyond.ts) ---

// Full character-service v5 sheet `.data` — identical shape to the Playwright path, so the existing
// parseStats / getMaxHp / getCurrentHp work unchanged on top of this.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function rtGetRawCharacter(ddbCharId: number): Promise<any> {
  const data = await rtJson<{ data: unknown }>(`${CHAR_SVC}/character/${ddbCharId}`);
  return data.data;
}

// Raw monster-service v1 record (by id) or the best name match (search). NOTE: monster-service uses
// a different shape than the dead www/api/v5/monster endpoint (statId, challengeRatingId, HTML
// *Description blobs, movements/damageAdjustment id arrays) — dndbeyond.ts maps it to DdbMonster.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function rtGetMonster(nameOrId: string | number): Promise<any> {
  const url = typeof nameOrId === "number"
    ? `${MON_SVC}?ids=${nameOrId}`
    : `${MON_SVC}?search=${encodeURIComponent(String(nameOrId))}&skip=0&take=10`;
  const data = await rtJson<{ data: unknown[] }>(url);
  const list = Array.isArray(data.data) ? data.data : [];
  if (list.length === 0) throw new Error(`ddb-rt: monster not found: ${nameOrId}`);
  if (typeof nameOrId === "number") return list[0];
  // Prefer an exact (case-insensitive) name match over search-rank order.
  const want = String(nameOrId).toLowerCase();
  return list.find((m) => String((m as { name?: string }).name ?? "").toLowerCase() === want) ?? list[0];
}

// The campaign/character APIs return HTML-escaped display names (e.g. "Wizards 3&amp;4").
function decodeEntities(s: string): string {
  return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'").replace(/&rsquo;/g, "'").replace(/&quot;/g, '"');
}

export interface RtCampaign { id: string; name: string; playerCount?: number }

// The "campaign set" — every campaign the user is in (as DM or player). Same endpoint Avrae's
// WaterdeepClient uses (ddb/waterdeep.py); needs bearer + cookie (cookie alone = SPA login HTML).
export async function rtListCampaigns(): Promise<RtCampaign[]> {
  const data = await rtJson<{ data: Array<{ id: number; name: string; playerCount?: number }> }>(
    `${WWW}/api/campaign/stt/active-campaigns`,
    { auth: "bearer", cookie: true },
  );
  return (data.data ?? []).map((c) => ({ id: String(c.id), name: decodeEntities(c.name), playerCount: c.playerCount }));
}

export interface RtCampaignCharacter { id: number; characterName: string; characterAvatarUrl: string | null }

export async function rtGetCampaignCharacters(campaignId: string): Promise<RtCampaignCharacter[]> {
  const data = await rtJson<{ data: Array<{ id: number; name: string; avatarUrl: string | null }> }>(
    `${WWW}/api/campaign/stt/active-short-characters/${campaignId}`,
    { auth: "bearer", cookie: true },
  );
  return (data.data ?? []).map((c) => ({ id: c.id, characterName: decodeEntities(c.name), characterAvatarUrl: c.avatarUrl ?? null }));
}

// Exposed for the write-path investigation (PoC). Returns the raw Response so callers can inspect
// status/body without this module deciding what a "successful" write looks like.
export function rtRawFetch(url: string, opts: RtFetchOpts = {}): Promise<Response> {
  return rtFetch(url, opts);
}

// --- live damageAdjustments overlay (the one monster table that drifts as DDB adds content) ---
//
// The id→name tables in ddb-monster-tables.ts are baked from config/json. The stable ones (CR,
// alignment, size, movement, condition) never change. `damageAdjustments` accretes new ids over
// time, so we overlay it from the live config and disk-cache it with a 7-day TTL. config/json is
// ~57KB of mostly-irrelevant data, so we extract only the damageAdjustments slice into the cache.
// Best-effort: a fetch failure leaves the baked table in charge — this never throws.

const DDB_CONFIG_URL = `${WWW}/api/config/json`;
const MON_CONFIG_CACHE = path.resolve("./data/ddb-monster-config.json");
const MON_CONFIG_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface DamageAdjustmentEntry { name: string; type: 1 | 2 | 3 }
interface MonConfigCache { fetchedAt: number; damageAdjustments: Record<string, DamageAdjustmentEntry> }

let _monConfigMem: Record<number, DamageAdjustmentEntry> | null = null;
let _monConfigRefreshing = false;

function keyById(rows: Array<{ id: number; name: string; type: number }>): Record<number, DamageAdjustmentEntry> {
  const out: Record<number, DamageAdjustmentEntry> = {};
  for (const r of rows) if (r && typeof r.id === "number") out[r.id] = { name: r.name, type: (r.type as 1 | 2 | 3) };
  return out;
}

async function fetchDamageAdjustments(): Promise<Record<number, DamageAdjustmentEntry>> {
  // config/json is served to a plain cookie'd fetch (validated); cookie alone is enough here.
  const data = await rtJson<{ data?: { damageAdjustments?: Array<{ id: number; name: string; type: number }> } } & { damageAdjustments?: Array<{ id: number; name: string; type: number }> }>(
    DDB_CONFIG_URL,
    { auth: "cookie" },
  );
  const rows = (data.data?.damageAdjustments ?? data.damageAdjustments ?? []);
  const map = keyById(rows);
  if (Object.keys(map).length === 0) throw new Error("ddb-rt: config/json had no damageAdjustments");
  mkdirSync(path.dirname(MON_CONFIG_CACHE), { recursive: true });
  writeFileSync(MON_CONFIG_CACHE, JSON.stringify({ fetchedAt: Date.now(), damageAdjustments: map } as MonConfigCache), "utf-8");
  _monConfigMem = map;
  return map;
}

// Returns the live damageAdjustments overlay, or null if it can never be obtained (offline cold
// start with no cache). Loads from memory → disk → live fetch; refreshes a stale disk cache in the
// background so the calling monster lookup is never blocked on a refresh.
export async function rtGetDamageAdjustments(): Promise<Record<number, DamageAdjustmentEntry> | null> {
  if (_monConfigMem) return _monConfigMem;
  if (existsSync(MON_CONFIG_CACHE)) {
    try {
      const c = JSON.parse(readFileSync(MON_CONFIG_CACHE, "utf-8")) as MonConfigCache;
      _monConfigMem = keyById(Object.entries(c.damageAdjustments).map(([id, v]) => ({ id: Number(id), name: v.name, type: v.type })));
      if (Date.now() - c.fetchedAt > MON_CONFIG_TTL_MS && !_monConfigRefreshing) {
        _monConfigRefreshing = true;
        fetchDamageAdjustments().catch(() => {}).finally(() => { _monConfigRefreshing = false; });
      }
      return _monConfigMem;
    } catch { /* corrupt cache → fall through to a background refresh */ }
  }
  // No cache yet — refresh in the BACKGROUND and return null so the caller uses the baked table.
  // A monster lookup must never block on the optional overlay: in test/offline environments the
  // live config fetch drags in the cobalt→browser auth path and can hang, and getMonster awaits
  // this concurrently with the monster fetch. Fire-and-forget keeps the lookup fast and offline-safe.
  if (!_monConfigRefreshing) {
    _monConfigRefreshing = true;
    fetchDamageAdjustments().catch(() => {}).finally(() => { _monConfigRefreshing = false; });
  }
  return null;
}
