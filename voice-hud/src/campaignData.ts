// Per-campaign editable data for the HUD: proper-noun vocab (Whisper biasing),
// nickname→entity aliases (for the agent), and durable DM notes.
//
// Reads and writes data/campaign-context.json (same file as the MCP server's
// add_vocab/add_nickname tools) so all writers share one source of truth.
// Two processes (HUD + MCP server) write the same file; writes are infrequent
// and the last-write-wins race is acceptable for this data.

import * as fs from "fs";
import * as path from "path";
import { DEFAULT_BASE_VOCAB } from "./baseVocab";

// Shared with the MCP server (same campaign-context.json). DMW_DATA_DIR — set by the
// packaged gem's bootstrap to the per-user dir — drives the gem and the server to the
// SAME place; unset in dev → __dirname/../../data = repo-root/data, unchanged.
const CONTEXT_PATH = path.join(process.env.DMW_DATA_DIR || path.join(__dirname, "..", "..", "data"), "campaign-context.json");

export interface NicknameAlias {
  nickname: string;
  target: string;
}

export interface CampaignData {
  slug: string;
  vocab: string[];
  nicknames: NicknameAlias[];
  notes: string;
  // Learned STT corrections (spoken-form → canonical), fed into the corrector's
  // literal-map pass. Populated from DM-accepted After-Action-Review proposals — the
  // reinforcement loop's persisted memory. Keyed lowercased.
  corrections: Record<string, string>;
  // Optional pronoun sets for proper nouns (PCs, NPCs, deities, places). Keyed by
  // the canonical proper-noun term (exact match preferred; see lookupPronoun for
  // case-insensitive fallback). Values are free-form, e.g. "she/her", "they/them",
  // "he/him", "it/its", "xe/xem". Absent key means no pronoun annotation.
  // Back-compat: missing field on old JSON is normalised to {} by loadCampaignData.
  pronouns: Record<string, string>;
}

type ContextStore = Record<string, Omit<CampaignData, "slug">>;

function readStore(): ContextStore {
  try {
    return JSON.parse(fs.readFileSync(CONTEXT_PATH, "utf-8")) as ContextStore;
  } catch {
    return {};
  }
}

function writeStore(store: ContextStore): void {
  const dir = path.dirname(CONTEXT_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CONTEXT_PATH, JSON.stringify(store, null, 2), "utf-8");
}

export function loadCampaignData(slug: string): CampaignData {
  if (!slug) return { slug: "", vocab: [], nicknames: [], notes: "", corrections: {}, pronouns: {} };
  const entry = readStore()[slug] ?? {};
  return {
    slug,
    vocab: Array.isArray(entry.vocab) ? entry.vocab : [],
    nicknames: Array.isArray(entry.nicknames) ? entry.nicknames : [],
    notes: typeof entry.notes === "string" ? entry.notes : "",
    corrections: (entry.corrections && typeof entry.corrections === "object") ? entry.corrections : {},
    // Back-compat: old JSON has no pronouns field → default to empty map.
    pronouns: (entry.pronouns && typeof entry.pronouns === "object" && !Array.isArray(entry.pronouns))
      ? entry.pronouns as Record<string, string>
      : {},
  };
}

export function saveCampaignData(data: CampaignData): void {
  if (!data.slug) return;
  const store = readStore();
  store[data.slug] = {
    vocab: data.vocab,
    nicknames: data.nicknames,
    notes: data.notes,
    corrections: data.corrections,
    pronouns: data.pronouns ?? {},
  };
  writeStore(store);
}

// Add (or update) a learned spoken→canonical correction and persist. The
// reinforcement loop's "accept" action. Spoken key is lowercased/trimmed.
export function addCorrection(slug: string, spoken: string, canonical: string): CampaignData {
  const data = loadCampaignData(slug);
  const key = spoken.trim().toLowerCase();
  if (key && canonical.trim()) {
    data.corrections[key] = canonical.trim();
    saveCampaignData(data);
  }
  return data;
}

// The full deduped vocab set: global base vocab (common D&D terms) + campaign vocab
// + roster names + nicknames. `baseVocab` is injected (default: the built-in set)
// so it stays SEPARATE from the per-campaign data and is testable; main.ts passes
// loadBaseVocab() so a base-vocab.json override applies. Used as BOTH the Whisper
// initial_prompt and the post-STT corrector's glossary.
export function buildVocabList(
  data: CampaignData,
  rosterNames: string[],
  baseVocab: string[] = DEFAULT_BASE_VOCAB,
): string[] {
  const set = new Set<string>();
  for (const v of baseVocab) if (v.trim()) set.add(v.trim());
  for (const v of data.vocab) if (v.trim()) set.add(v.trim());
  for (const n of rosterNames) if (n.trim()) set.add(n.trim());
  for (const a of data.nicknames) {
    if (a.nickname.trim()) set.add(a.nickname.trim());
    if (a.target.trim()) set.add(a.target.trim());
  }
  return Array.from(set);
}

// Whisper initial_prompt = the vocab list, comma-joined.
export function buildVocabPrompt(
  data: CampaignData,
  rosterNames: string[],
  baseVocab: string[] = DEFAULT_BASE_VOCAB,
): string {
  return buildVocabList(data, rosterNames, baseVocab).join(", ");
}

// Look up the pronoun for a name, with case-insensitive fallback.
// Returns the pronoun string (e.g. "they/them") or undefined if not set.
export function lookupPronoun(data: CampaignData, name: string): string | undefined {
  const p = data.pronouns;
  if (!p) return undefined;
  // Exact match first, then case-insensitive.
  if (name in p) return p[name];
  const lower = name.toLowerCase();
  const key = Object.keys(p).find((k) => k.toLowerCase() === lower);
  return key !== undefined ? p[key] : undefined;
}

// Set (or clear) the pronoun for a term and persist. Pass an empty string to remove.
export function setPronoun(slug: string, term: string, pronouns: string): CampaignData {
  const data = loadCampaignData(slug);
  const t = term.trim();
  if (!t) return data;
  if (pronouns.trim()) {
    data.pronouns[t] = pronouns.trim();
  } else {
    delete data.pronouns[t];
  }
  saveCampaignData(data);
  return data;
}

// Annotate a name with its pronouns if set, e.g. "Winsome (she/her)".
// Used by roster/vocab builders to surface pronouns to the agent.
export function annotateName(data: CampaignData, name: string): string {
  const p = lookupPronoun(data, name);
  return p ? `${name} (${p})` : name;
}

// Append a corrected proper noun learned from a transcript edit (dedup).
export function addVocabTerm(slug: string, term: string): CampaignData {
  if (!slug) return loadCampaignData(slug);
  const data = loadCampaignData(slug);
  const t = term.trim();
  if (t && !data.vocab.some((v) => v.toLowerCase() === t.toLowerCase())) {
    data.vocab.push(t);
    saveCampaignData(data);
  }
  return data;
}
