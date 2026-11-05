// One stored Roll20 realtime token per campaign (#279): <data dir>/rt-tokens/<campaignId>.json.
//
// Tokens are campaign-scoped, so a single shared file meant furnishing one game locked out every
// other. A slot is only ever written for the campaign it is named after.
//
// roll20-rt-token.json is the old single file, and it is still LIVE: the gem writes every harvest
// there. So it is an inbox rather than a one-off migration:
//
//   - Every read files it under the campaign IT holds, which may not be the campaign being read.
//     That is what keeps the token alive when the gem's next harvest overwrites the file.
//   - It is copied, never moved. The gem's keeper reads a missing file as "no cached token" and
//     force-harvests, so deleting it would mean a new harvest on every keeper tick.
//   - The file is not trusted just for existing. See supersedes().
//
// These are logins. Nothing in this module may log a token value, and the error text carries paths
// and file-level problems only.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import path from "path";
import { dataPath } from "../dataDir.js";

export const LEGACY_TOKEN_FILE = "roll20-rt-token.json";

export interface StoredRtToken {
  campaignId: string;
  customToken?: string;
  refreshToken?: string;
  databaseURL: string;
  harvestedAt: number;
  /** When Firebase refused this slot's refresh token. Absent until it does. See supersedes(). */
  refusedAt?: number;
}

const legacyPath = (): string => dataPath(LEGACY_TOKEN_FILE);

// Display and read path. The id is checked at the read and write seams, not here, so an error
// message can name the path for a campaign id that turned out to be unusable.
export const rtTokenSlotPath = (campaignId: string): string => dataPath("rt-tokens", `${campaignId}.json`);

// The id becomes a filename, and the registry takes it as a free-form string.
function assertCampaignId(campaignId: string): void {
  if (!/^\d+$/.test(campaignId)) {
    throw new Error(`campaign id ${JSON.stringify(campaignId)} is not numeric, so it has no token slot`);
  }
}

function readJsonObject(file: string): Partial<StoredRtToken> | null {
  let raw: string;
  try {
    raw = readFileSync(file, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // The parser's own message can quote the file's content, which is a login.
    throw new Error(`${file} is not valid JSON`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${file} is not a JSON object`);
  return parsed as Partial<StoredRtToken>;
}

function readSlot(campaignId: string): StoredRtToken | null {
  assertCampaignId(campaignId);
  return readJsonObject(rtTokenSlotPath(campaignId)) as StoredRtToken | null;
}

/** Store a token in its own campaign's slot, atomically and owner-only. No other slot is touched. */
export function writeRtTokenSlot(token: StoredRtToken): string {
  assertCampaignId(token.campaignId);
  const file = rtTokenSlotPath(token.campaignId);
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(token), { encoding: "utf-8", mode: 0o600 });
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true }); // A credential-bearing temp file must not outlive the failure.
    throw err;
  }
  return file;
}

const stamp = (t: Partial<StoredRtToken>): number => (typeof t.harvestedAt === "number" ? t.harvestedAt : 0);

// Should the old file's record replace this slot?
//
// Newest harvest wins, with one exception that matches the gem's own rule: a one-shot custom token
// never displaces a refresh token, because the gem re-harvests every 40 minutes and would otherwise
// erase a durable login with an hour-long one.
//
// That exception needs an exit. When a refresh token dies, the gem's recovery deletes the old file
// and harvests a custom token into it, and if the dead refresh token still outranked that, recovery
// would be a no-op forever. So connect() records the refusal (markRtTokenRefused), and a custom
// token harvested after it does take the slot.
function supersedes(held: Partial<StoredRtToken>, slot: StoredRtToken | null): boolean {
  if (!slot) return true;
  if (!held.databaseURL || !(held.customToken || held.refreshToken)) return false;
  if (slot.refreshToken && !held.refreshToken) {
    return slot.refusedAt !== undefined && stamp(held) > slot.refusedAt;
  }
  return stamp(held) > stamp(slot);
}

// File the old single-file token under the campaign it holds. Returns why that could not be done,
// or null. The problem is returned rather than thrown because it belongs to one file and possibly
// to another campaign: it must not refuse a campaign whose own slot is fine, and the caller reports
// it wherever it does matter.
export function importLegacyRtToken(): string | null {
  try {
    const held = readJsonObject(legacyPath());
    if (!held) return null;
    const campaignId = String(held.campaignId ?? "");
    if (!campaignId) return `${legacyPath()} names no campaign`;
    if (supersedes(held, readSlot(campaignId))) writeRtTokenSlot({ ...held, campaignId } as StoredRtToken);
    return null;
  } catch (err) {
    return `${LEGACY_TOKEN_FILE} could not be filed under its campaign: ${(err as Error).message}`;
  }
}

/**
 * Read one campaign's slot, importing the old single file first. Never returns another campaign's
 * token. `legacyProblem` says why the old file could not be imported, if it could not. A slot that
 * cannot be read throws.
 */
export function readRtTokenSlot(campaignId: string): { token: StoredRtToken | null; legacyProblem: string | null } {
  const legacyProblem = importLegacyRtToken();
  return { token: readSlot(campaignId), legacyProblem };
}

/**
 * Record that Firebase refused this slot's refresh token. The token stays in place: the only effect
 * is to let a custom token harvested after this moment take the slot. A slot that has since been
 * re-furnished holds a different token, and is left alone.
 */
export function markRtTokenRefused(campaignId: string, refreshToken: string, at: number): void {
  const slot = readSlot(campaignId);
  if (slot?.refreshToken === refreshToken) writeRtTokenSlot({ ...slot, refusedAt: at });
}
