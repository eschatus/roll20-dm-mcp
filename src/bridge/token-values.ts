// Semantics-free named values on a token (#259), stored in the token's GM-only gmnotes.
//
// gmnotes rather than relay state because the value then travels with a copied token, sits beside
// the %%PCHP%% block it generalises, and is reachable over direct RTDB: like adjustPcHp's
// transaction path and map pins, this needs no relay action and no per-campaign Mod redeploy.
//
// The block is `%%VALS=<encodeURIComponent(JSON)>%%`. The encoding means no stored string can close
// the block early, and no `@{`/`[[` from a value can sit live in gmnotes.
//
// The key "hp" is the existing %%PCHP%% block, not a VALS entry: adjustPcHp, update_token_hp and
// the turn hook all read that block, so one key has one home until the gem owns HP policy (#171).
import { parsePcHpBlock, writePcHpBlock, PCHP_RE } from "./rt-helpers.js";
import { rtFindTokenPage, rtGet, rtTransact } from "./roll20-rt.js";

export class TokenValueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TokenValueError";
  }
}

export type TokenValues = Record<string, unknown>;

const VALS_RE = /%%VALS=(\S*?)%%/;
const HP_KEY = "hp";

const without = (notes: string, block: RegExp) => notes.replace(block, "").replace(/\s+$/, "");

const BLOCKS = [VALS_RE, PCHP_RE];
const MAX_LAYERS = 4;

// Takes every copy of each block out of text, recording the newest (last) copy of a kind unless an
// outer, newer layer already supplied one.
function liftBlocks(text: string, found: Map<RegExp, string>): string {
  let rest = text;
  for (const re of BLOCKS) {
    const all = rest.match(new RegExp(re.source, "g")) ?? [];
    if (all.length && !found.has(re)) found.set(re, all[all.length - 1]);
    rest = rest.replace(new RegExp(re.source, "g"), "");
  }
  return rest;
}

// Roll20 URL-encodes gmnotes when the GM edits them in the UI, blocks included, and adjustPcHp then
// appends a raw %%PCHP%% to the encoded text, which the next UI edit encodes again. So the notes are
// peeled a layer at a time: raw blocks are lifted out (a raw `%%` would make decodeURIComponent
// throw) and the rest decoded, while decoding still reveals a block. An outer layer was written
// later, so its copy of a block wins. Writing back this form drops every stale copy.
function plainNotes(gm: unknown): string {
  const raw = String(gm ?? "");
  const found = new Map<RegExp, string>();
  let rest = liftBlocks(raw, found);
  for (let layer = 0; layer < MAX_LAYERS; layer++) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(rest);
    } catch {
      break; // A stray `%`: this layer was never URL-encoded.
    }
    if (!BLOCKS.some((re) => re.test(decoded))) break;
    rest = liftBlocks(decoded, found);
  }
  if (!found.size) return raw;
  const kept = BLOCKS.flatMap((re) => found.get(re) ?? []);
  return [rest.replace(/\s+$/, ""), ...kept].filter(Boolean).join(" ");
}

function parseValues(notes: string): TokenValues {
  const m = notes.match(VALS_RE);
  if (!m) return {};
  try {
    const vals: unknown = JSON.parse(decodeURIComponent(m[1]));
    if (vals && typeof vals === "object" && !Array.isArray(vals)) return vals as TokenValues;
  } catch {
    // Reported below: a corrupt block must not read as "no values" or be overwritten as empty.
  }
  throw new TokenValueError("The token's %%VALS%% block in gmnotes is corrupt. Repair or remove it in the token's GM notes.");
}

/** Every value on a token: its VALS entries plus the PCHP block as `hp`. */
export function readTokenValues(gm: unknown): TokenValues {
  const notes = plainNotes(gm);
  const vals = parseValues(notes);
  const hp = parsePcHpBlock(notes);
  return hp ? { ...vals, [HP_KEY]: { current: hp.current, max: hp.max } } : vals;
}

/** gmnotes with one key set, or deleted when value is null. Other notes are preserved. */
export function writeTokenValue(gm: unknown, key: string, value: unknown, tokenName: string): string {
  const notes = plainNotes(gm);
  if (key === HP_KEY) {
    if (value === null) return without(notes, PCHP_RE);
    const { current, max } = (value ?? {}) as { current?: unknown; max?: unknown };
    if (typeof current !== "number" || typeof max !== "number" || !Number.isFinite(current) || !Number.isFinite(max)) {
      throw new TokenValueError(`"${HP_KEY}" is the PC HP block: its value must be {current, max} with finite numbers.`);
    }
    return writePcHpBlock(notes, { current, max, name: tokenName, updated: Date.now() });
  }
  const vals = parseValues(notes);
  if (value === null) delete vals[key];
  else vals[key] = value;
  const base = without(notes, VALS_RE);
  if (!Object.keys(vals).length) return base;
  return `${base ? `${base} ` : ""}%%VALS=${encodeURIComponent(JSON.stringify(vals))}%%`;
}

async function tokenPath(tokenId: string, pageId?: string): Promise<string> {
  const pid = await rtFindTokenPage(tokenId, pageId);
  if (!pid) {
    throw new TokenValueError(`Token not found: ${tokenId}. Only the player and initiative pages are searched; pass pageId for another page.`);
  }
  return `graphics/page/${pid}/${tokenId}`;
}

export async function rtGetTokenValues(tokenId: string, pageId?: string): Promise<TokenValues> {
  return readTokenValues(await rtGet(`${await tokenPath(tokenId, pageId)}/gmnotes`));
}

export async function rtSetTokenValue(tokenId: string, key: string, value: unknown, pageId?: string): Promise<void> {
  const path = await tokenPath(tokenId, pageId);
  // Outside the transaction: the name isn't what's being transacted on, as in adjustPcHp.
  const name = String((await rtGet(`${path}/name`)) ?? "").split("\n")[0].trim();
  await rtTransact(`${path}/gmnotes`, (current) => writeTokenValue(current, key, value, name));
}
