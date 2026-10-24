// Chat-free character attribute read (#230).
//
// Attributes live at `<storagePath>/char-attribs/char/<characterId>/<attributeId>` as
// `{ id, name, current?, max? }` (current/max omitted when empty; ids and repeating-row ids can
// contain `_` and `-`). Reading them here never touches chat, so a `rollbase`-style value holding
// `@{`/`[[` comes back as a plain string and cannot disable the Mod sandbox the way the relay's
// getCharacterAttributes echo can. There is NO fallback to the relay: a failed read throws.
import { rtGet } from "./roll20-rt.js";

export class AttributeReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttributeReadError";
  }
}

interface AttrRecord { id?: string; name?: string; current?: unknown; max?: unknown }
export type AttributeValue = unknown;

const CHAR_ID = /^[-_A-Za-z0-9]+$/;

/** RTDB record map -> the relay-shaped result: name -> flat current, or {current,max} when max is set. */
export function mapAttributeRecords(
  records: Record<string, AttrRecord> | null | undefined,
  names?: string[],
): Record<string, AttributeValue> {
  const out: Record<string, AttributeValue> = {};
  if (!records) return out;
  const wanted = names ? new Set(names) : null;
  for (const rec of Object.values(records)) {
    if (!rec || typeof rec.name !== "string") continue;
    if (wanted && !wanted.has(rec.name)) continue;
    const current = rec.current ?? "";
    const hasMax = rec.max !== undefined && rec.max !== null && rec.max !== "";
    out[rec.name] = hasMax ? { current, max: rec.max } : current;
  }
  return out;
}

export async function readCharacterAttributesRt(
  charId: string,
  names?: string[],
): Promise<Record<string, AttributeValue>> {
  // Ids are interpolated into an RTDB path; an empty or slash-bearing one would address a parent node.
  if (!CHAR_ID.test(charId)) {
    throw new AttributeReadError(`Refusing to read attributes: "${charId}" is not a valid Roll20 character id.`);
  }
  let node: unknown;
  try {
    node = await rtGet(`char-attribs/char/${charId}`);
  } catch (e) {
    throw new AttributeReadError(
      `RTDB read of char-attribs/char/${charId} failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (node !== null && node !== undefined && (typeof node !== "object" || Array.isArray(node))) {
    throw new AttributeReadError(
      `char-attribs/char/${charId} held ${Array.isArray(node) ? "an array" : `a ${typeof node}`}, expected an object of attribute records.`,
    );
  }
  return mapAttributeRecords(node as Record<string, AttrRecord> | null, names);
}
