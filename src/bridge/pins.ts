// Roll20 map pins over direct RTDB (#203).
//
// A pin is a plain RTDB node at `<storagePath>/pins/page/<pageId>/<pinId>` — the same
// `…/page/<pageId>/…` shape as graphics, doors and windows — so the four pin tools read and write
// it the way `getDoors`/`createDLDoors` already do, with no relay action and therefore no
// per-campaign Mod redeploy. Verified live on Three Families (#203): `push()` mints the id,
// `update()` merges, `rtGet` reads back byte-identical, `x`/`y` are page pixels (70 per square),
// and the page comes from the path — no `_pageid` in the payload.
//
// Property names are camelCase (`gmNotes`, `bgColor`, `pinImage`, `visibleTo`), unlike the
// `gmnotes` used by every other Roll20 object. `imageDesynced`/`notesDesynced`/`gmNotesDesynced`
// are one flag wearing three names — setting any one sets all three — so callers pass a single
// `desynced` and it is expanded here.
import { rtGet, rtPushObject, rtUpdate, rtRemove } from "./roll20-rt.js";

export const PINS_ROOT = "pins/page";
// Ids are interpolated straight into RTDB paths, and every rt helper strips trailing slashes — so
// an EMPTY or slash-bearing id silently addresses the PARENT node. `delete_map_pin {pinId:""}` used
// to read the whole page node as "found" and remove every pin on the page. Firebase push keys (and
// Roll20 page ids) are [-_A-Za-z0-9]; anything else is refused before a path is built.
const RTDB_KEY = /^[-_A-Za-z0-9]+$/;
function key(label: string, v: string): string {
  if (typeof v !== "string" || !RTDB_KEY.test(v)) {
    throw new Error(`${label} ${JSON.stringify(v)} is not a Roll20 id (expected [-_A-Za-z0-9]+, non-empty)`);
  }
  return v;
}
const pagePath = (pageId: string) => `${PINS_ROOT}/${key("pageId", pageId)}`;
const pinPath = (pageId: string, pinId: string) => `${pagePath(pageId)}/${key("pinId", pinId)}`;

export type PinProps = Record<string, unknown>;
export interface PinRecord extends PinProps { id: string; pageId: string }

const DESYNC_KEYS = ["imageDesynced", "notesDesynced", "gmNotesDesynced"] as const;

// Tool args → RTDB pin fields: drop undefined, expand `desynced` into the coupled triple.
export function toPinFields(args: Record<string, unknown>): PinProps {
  const out: PinProps = {};
  for (const [k, v] of Object.entries(args)) {
    if (v === undefined || k === "desynced") continue;
    out[k] = v;
  }
  if (args.desynced !== undefined) for (const k of DESYNC_KEYS) out[k] = args.desynced;
  return out;
}

// The id is the node's KEY, never the stored `id` field: every write addresses the key, so a record
// whose stored id disagreed with it would be found by one and written through the other.
function toRecord(pageId: string, pinId: string, raw: Record<string, unknown>): PinRecord {
  return { ...raw, id: pinId, pageId };
}

// Every pin on a page, or every pin in the campaign when pageId is omitted. A missing node reads
// as null (not an error) and yields [] — a real failure (auth expiry, permission denied) throws.
export async function listPins(pageId?: string): Promise<PinRecord[]> {
  if (pageId) {
    const node = await rtGet<Record<string, Record<string, unknown>> | null>(pagePath(pageId));
    return Object.entries(node ?? {}).map(([pinId, raw]) => toRecord(pageId, pinId, raw));
  }
  const all = await rtGet<Record<string, Record<string, Record<string, unknown>>> | null>(PINS_ROOT);
  const out: PinRecord[] = [];
  for (const [pid, node] of Object.entries(all ?? {})) {
    for (const [pinId, raw] of Object.entries(node ?? {})) out.push(toRecord(pid, pinId, raw));
  }
  return out;
}

export async function createPin(pageId: string, fields: PinProps): Promise<PinRecord> {
  const id = await rtPushObject(pagePath(pageId), fields);
  return { ...fields, id, pageId };
}

// Locate a pin by id. With a pageId hint this is one read; without it, every page's pins are read
// once and scanned — Roll20's rules deny a shallow read at the root, so there is no cheaper index.
export async function findPin(pinId: string, pageId?: string): Promise<PinRecord | null> {
  key("pinId", pinId);
  if (pageId) {
    const raw = await rtGet<Record<string, unknown> | null>(pinPath(pageId, pinId));
    return raw ? toRecord(pageId, pinId, raw) : null;
  }
  return (await listPins()).find((p) => p.id === pinId) ?? null;
}

export async function updatePin(
  pinId: string,
  fields: PinProps,
  pageId?: string,
): Promise<{ id: string; pageId: string; updated: string[] }> {
  const updated = Object.keys(fields);
  if (updated.length === 0) throw new Error("update_map_pin: nothing to write — pass at least one pin field");
  const existing = await findPin(pinId, pageId);
  if (!existing) throw new Error(`Pin not found: ${pinId}${pageId ? ` on page ${pageId}` : ""}`);
  await rtUpdate(pinPath(existing.pageId, pinId), fields);
  return { id: pinId, pageId: existing.pageId, updated };
}

export async function deletePin(pinId: string, pageId?: string): Promise<{ id: string; pageId: string }> {
  const existing = await findPin(pinId, pageId);
  if (!existing) throw new Error(`Pin not found: ${pinId}${pageId ? ` on page ${pageId}` : ""}`);
  await rtRemove(pinPath(existing.pageId, pinId));
  return { id: pinId, pageId: existing.pageId };
}
