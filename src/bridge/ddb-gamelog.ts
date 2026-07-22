// D&D Beyond game-log → live roll feed. Browserless: subscribes to the campaign's
// game-log WebSocket with the same cobalt→JWT the REST reads use, and emits each
// fulfilled dice roll. Built for the "orphaned character" case — a PC whose player
// rolls on D&D Beyond but has no Beyond20 bridge, so their rolls never reach the VTT.
//
// Transport (all verified live against game 1117568, see src/recon/ddb-gamelog-*.ts):
//   wss://game-log-api-live.dndbeyond.com/v1?gameId=&userId=&stt=<JWT>
//   → pushes {id, dateTime, gameId, userId, entityId, eventType, data:{action, rolls[]}}
//   REST backfill: game-log-rest-live.dndbeyond.com/v1/getmessages?gameId=&userId=
//
// The JWT lives ~300s, and the WS holds it for the connection's life, so we proactively
// reconnect with a fresh token before it lapses. Dedup is by message `id` (a uuid) so a
// reconnect that replays recent history never double-posts.

import WebSocket from "ws";
import { rtAuthToken, rtRawFetch } from "./ddb-rt.js";

const WS_BASE = "wss://game-log-api-live.dndbeyond.com/v1";
const REST_MESSAGES = "https://game-log-rest-live.dndbeyond.com/v1/getmessages";
const ROLL_EVENT = "dice/roll/fulfilled";

// --- payload shapes (only the fields we consume; DDB sends much more) ---
export interface DdbRollResult { constant: number; text: string; total: number; values: number[] }
export interface DdbDiceSet { count: number; dieType: string; operation?: number }
export interface DdbDiceNotation { constant?: number; set?: DdbDiceSet[] }
export interface DdbRoll {
  diceNotationStr?: string;        // sometimes present ("5d8"); often NOT — reconstruct from diceNotation
  diceNotation?: DdbDiceNotation;
  rollType: string;                // "damage" | "check" | "to hit" | "Force" | …
  rollKind?: string;
  result: DdbRollResult;           // { total, text:"6+6", values:[6] }
}
export interface DdbGameLogMessage {
  id: string;
  dateTime: string;          // epoch ms, as a string
  gameId: string;
  userId: string;
  entityId: string;          // the rolling character's DDB id — the filter key
  entityType?: string;       // "character"
  eventType: string;         // we want "dice/roll/fulfilled"
  data?: { action?: string; context?: { name?: string }; rolls?: DdbRoll[] };
}

export interface PumpOptions {
  gameId: string;
  /** DDB entityIds to relay. Empty/undefined = every character's rolls. */
  entityIds?: string[];
  onRoll: (msg: DdbGameLogMessage) => void | Promise<void>;
  onStatus?: (s: string) => void;
}

// Reconnect ~40s before the ~300s JWT expiry; clamp so a weird ttl can't busy-loop.
const REFRESH_LEAD_MS = 40_000;
const MIN_CONNECT_MS = 30_000;
const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 20_000];

export class DdbGameLogPump {
  private ws: WebSocket | null = null;
  private stopped = false;
  private refreshTimer: NodeJS.Timeout | null = null;
  private failures = 0;
  private readonly seen = new Set<string>();   // message ids already emitted (dedup)
  private readonly entityFilter: Set<string> | null;

  constructor(private opts: PumpOptions) {
    this.entityFilter = opts.entityIds?.length ? new Set(opts.entityIds) : null;
  }

  private log(s: string) { this.opts.onStatus?.(s); }

  /**
   * Seed the dedup set from REST history so a fresh connection (which replays recent
   * messages) doesn't post rolls that predate the pump. Returns the count seeded.
   */
  private async seedFromHistory(): Promise<number> {
    try {
      const { userId } = await rtAuthToken();
      const res = await rtRawFetch(`${REST_MESSAGES}?gameId=${this.opts.gameId}&userId=${userId}`, { auth: "bearer" });
      if (!res.ok) { this.log(`[ddb-pump] history seed skipped (${res.status})`); return 0; }
      const body = await res.json() as { data?: DdbGameLogMessage[] };
      for (const m of body.data ?? []) if (m.id) this.seen.add(m.id);
      return this.seen.size;
    } catch (e) {
      this.log(`[ddb-pump] history seed failed: ${(e as Error).message}`);
      return 0;
    }
  }

  async start(): Promise<void> {
    this.stopped = false;
    const seeded = await this.seedFromHistory();
    this.log(`[ddb-pump] seeded ${seeded} prior message id(s); connecting…`);
    await this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.refreshTimer) { clearTimeout(this.refreshTimer); this.refreshTimer = null; }
    this.ws?.removeAllListeners();
    try { this.ws?.close(); } catch { /* already closing */ }
    this.ws = null;
    this.log("[ddb-pump] stopped");
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    let token: string, userId: string, expiresAt: number;
    try {
      ({ token, userId, expiresAt } = await rtAuthToken());
    } catch (e) {
      return this.scheduleReconnect(`auth failed: ${(e as Error).message}`);
    }

    const url = `${WS_BASE}?gameId=${this.opts.gameId}&userId=${userId}&stt=${token}`;
    const ws = new WebSocket(url, {
      headers: { Origin: "https://www.dndbeyond.com", "User-Agent": "Mozilla/5.0" },
    });
    this.ws = ws;

    ws.on("open", () => {
      this.failures = 0;
      this.log(`[ddb-pump] connected to game ${this.opts.gameId}`);
      // Proactively cycle the connection before the JWT lapses.
      const lifetime = Math.max(MIN_CONNECT_MS, expiresAt - Date.now() - REFRESH_LEAD_MS);
      this.refreshTimer = setTimeout(() => { this.log("[ddb-pump] refreshing JWT"); this.cycle(); }, lifetime);
    });
    ws.on("message", (buf: WebSocket.RawData) => this.onFrame(String(buf)));
    ws.on("error", (e) => this.log(`[ddb-pump] ws error: ${(e as Error).message}`));
    ws.on("close", (code) => { if (!this.stopped) this.scheduleReconnect(`closed (${code})`); });
  }

  /** Tear down the current socket and immediately reconnect with a fresh token. */
  private cycle(): void {
    if (this.refreshTimer) { clearTimeout(this.refreshTimer); this.refreshTimer = null; }
    const old = this.ws;
    this.ws = null;
    old?.removeAllListeners();
    try { old?.close(); } catch { /* ignore */ }
    void this.connect();
  }

  private scheduleReconnect(why: string): void {
    if (this.stopped) return;
    if (this.refreshTimer) { clearTimeout(this.refreshTimer); this.refreshTimer = null; }
    const delay = BACKOFF_MS[Math.min(this.failures, BACKOFF_MS.length - 1)];
    this.failures++;
    this.log(`[ddb-pump] ${why} — reconnecting in ${delay}ms`);
    this.refreshTimer = setTimeout(() => void this.connect(), delay);
  }

  private onFrame(raw: string): void {
    let m: DdbGameLogMessage;
    try { m = JSON.parse(raw); } catch { return; }           // keepalive / non-json
    if (m.eventType !== ROLL_EVENT || !m.id) return;
    if (this.entityFilter && !this.entityFilter.has(m.entityId)) return;
    if (this.seen.has(m.id)) return;                          // dedup (reconnect replays)
    this.seen.add(m.id);
    if (this.seen.size > 2000) {                             // bound memory on a long session
      for (const id of this.seen) { this.seen.delete(id); if (this.seen.size <= 1500) break; }
    }
    Promise.resolve(this.opts.onRoll(m)).catch((e) => this.log(`[ddb-pump] onRoll failed: ${(e as Error).message}`));
  }
}

// ---------------------------------------------------------------------------
// Render — mirror DDB's ACTUAL rolled values into Roll20 (never re-roll)
// ---------------------------------------------------------------------------

// DDB has already determined the dice; a fresh Roll20 /roll would invent different
// numbers. So we render the real values as a Roll20 default-template card, spoken as
// the character — it reads like a native roll but shows exactly what the player saw.
// (Plain text/numbers only — no [[…]] inline-roll syntax, which Roll20 WOULD re-roll.)

const escapeRoll = (s: string) => String(s).replace(/[{}|]/g, "");   // strip chars that break template syntax
const titleCase = (s: string) => s.replace(/\b\w/g, (c) => c.toUpperCase());

// Reconstruct "1d8+6" from the structured diceNotation (diceNotationStr is often absent).
function notationOf(r: DdbRoll): string {
  if (r.diceNotationStr) return r.diceNotationStr;
  const sets = (r.diceNotation?.set ?? []).map((s) => `${s.count}${s.dieType}`).filter(Boolean);
  const k = r.diceNotation?.constant ?? 0;
  const dice = sets.join(" + ");
  if (!dice) return k ? String(k) : "";
  return k ? `${dice}${k > 0 ? " + " : " - "}${Math.abs(k)}` : dice;
}

export function renderRollForRoll20(m: DdbGameLogMessage): { speakAs: string; message: string } {
  const name = m.data?.context?.name?.trim() || "D&D Beyond";
  const action = m.data?.action?.trim();
  const rolls = m.data?.rolls ?? [];

  const rows = rolls.map((r) => {
    const label = escapeRoll(titleCase([r.rollType, r.rollKind].filter(Boolean).join(" ").trim() || "Roll"));
    const notation = escapeRoll(notationOf(r));
    const total = r.result?.total ?? "";
    // result.text is the real breakdown ("6+6", "2+2+5+4+5"); show it when it's more than the bare total.
    const breakdown = escapeRoll(r.result?.text ?? "");
    const detail = breakdown && breakdown !== String(total) ? ` (${breakdown})` : "";
    const notePart = notation ? ` ${notation}` : "";
    return `{{${label}${notePart} = ${total}${detail}}}`;
  });

  const header = escapeRoll(titleCase(action || "Dice roll"));
  const message = `&{template:default} {{name=${header} — via D&D Beyond}} ${rows.join(" ")}`;
  return { speakAs: name, message };
}
