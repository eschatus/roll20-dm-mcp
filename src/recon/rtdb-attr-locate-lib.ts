// Pure helpers for src/recon/rtdb-attr-locate.ts (#230 / #225). Kept separate from the script so
// they can be unit-tested without opening a live Roll20 connection — importing the script runs it.

/** Root-level RTDB keys worth drilling into when hunting for character sheet data. */
export const CHAR_KEY_HINT = /char|attr|abil|sheet|comput|beacon|journal/i;

/**
 * Candidate paths (relative to the campaign storage root) that might hold one character's
 * attributes, most likely first. `char-attribs/char/<id>` is the shape Roll20's own client
 * subscribes to for `character.attribs`; the rest are fallbacks the survey should rule in or out.
 * `char-blobs/<id>` is included on purpose: the repo's earlier probes found only `defaulttoken`
 * there, and the survey should record that again rather than assume it.
 */
export function candidatePaths(charId: string): string[] {
  return [
    `char-attribs/char/${charId}`,
    `char-abils/char/${charId}`,
    `char-attribs/${charId}`,
    `char-abils/${charId}`,
    `char-blobs/${charId}`,
    `characters/${charId}`,
    `attribs/char/${charId}`,
    `attributes/char/${charId}`,
    `char-computed/char/${charId}`,
    `computed/char/${charId}`,
  ];
}

export interface Hit {
  /** Slash-joined path from the searched root to the node whose value matched. */
  path: string;
  /** The matching leaf's full string value. */
  value: string;
  /** The key of the matching leaf's parent object, when it looks like an attribute record. */
  record?: Record<string, unknown>;
}

/**
 * Depth-first search for every leaf whose string value CONTAINS `needle`. Returns the path to
 * each hit plus the enclosing object when it looks like an attribute record ({name, current…}),
 * so the caller learns both where the value lives and what the record shape is.
 * Depth-bounded so a pathological subtree can't recurse forever.
 */
export function findValuePaths(tree: unknown, needle: string, maxDepth = 8): Hit[] {
  const hits: Hit[] = [];
  const walk = (node: unknown, trail: string[], parent: Record<string, unknown> | undefined) => {
    if (trail.length > maxDepth) return;
    if (typeof node === "string") {
      if (node.includes(needle)) {
        hits.push({ path: trail.join("/"), value: node, record: parent && looksLikeRecord(parent) ? parent : undefined });
      }
      return;
    }
    if (node && typeof node === "object") {
      const obj = node as Record<string, unknown>;
      for (const [k, v] of Object.entries(obj)) walk(v, [...trail, k], obj);
    }
  };
  walk(tree, [], undefined);
  return hits;
}

function looksLikeRecord(o: Record<string, unknown>): boolean {
  return "name" in o || "current" in o;
}

/**
 * Collapse a hit path into a reusable template by replacing the character id and any
 * Firebase push-id-shaped segment (20 chars, `-` or letter first) with placeholders, e.g.
 *   char-attribs/char/-Nabc…/-Nxyz…/current  →  char-attribs/char/<charId>/<attrId>/current
 */
export function templatize(path: string, charId: string): string {
  return path
    .split("/")
    .map((seg) => {
      if (seg === charId) return "<charId>";
      if (/^[-A-Za-z0-9_]{20}$/.test(seg) && /^[-A-Z]/.test(seg)) return "<pushId>";
      return seg;
    })
    .join("/");
}

/** Count children of a shallow listing (RTDB shallow returns {key: true|scalar}). */
export function childCount(shallow: unknown): number | null {
  return shallow && typeof shallow === "object" ? Object.keys(shallow as object).length : null;
}
