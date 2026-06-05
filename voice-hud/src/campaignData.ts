// Per-campaign editable data for the HUD: proper-noun vocab (Whisper biasing),
// nickname→entity aliases (for the agent), and durable DM notes.
//
// Reads and writes data/campaign-context.json (same file as the MCP server's
// add_vocab/add_nickname tools) so all writers share one source of truth.
// Two processes (HUD + MCP server) write the same file; writes are infrequent
// and the last-write-wins race is acceptable for this data.

import * as fs from "fs";
import * as path from "path";

// __dirname = voice-hud/dist at compiled runtime → ../../data = repo-root/data
const CONTEXT_PATH = path.join(__dirname, "..", "..", "data", "campaign-context.json");

export interface NicknameAlias {
  nickname: string;
  target: string;
}

export interface CampaignData {
  slug: string;
  vocab: string[];
  nicknames: NicknameAlias[];
  notes: string;
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
  if (!slug) return { slug: "", vocab: [], nicknames: [], notes: "" };
  const entry = readStore()[slug] ?? {};
  return {
    slug,
    vocab: Array.isArray(entry.vocab) ? entry.vocab : [],
    nicknames: Array.isArray(entry.nicknames) ? entry.nicknames : [],
    notes: typeof entry.notes === "string" ? entry.notes : "",
  };
}

export function saveCampaignData(data: CampaignData): void {
  if (!data.slug) return;
  const store = readStore();
  store[data.slug] = { vocab: data.vocab, nicknames: data.nicknames, notes: data.notes };
  writeStore(store);
}

// Build the Whisper initial_prompt: campaign vocab + roster names + nicknames, deduped.
export function buildVocabPrompt(data: CampaignData, rosterNames: string[]): string {
  const set = new Set<string>();
  for (const v of data.vocab) if (v.trim()) set.add(v.trim());
  for (const n of rosterNames) if (n.trim()) set.add(n.trim());
  for (const a of data.nicknames) {
    if (a.nickname.trim()) set.add(a.nickname.trim());
    if (a.target.trim()) set.add(a.target.trim());
  }
  return Array.from(set).join(", ");
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
