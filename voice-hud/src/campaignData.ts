// Per-campaign editable data for the HUD: proper-noun vocab (Whisper biasing),
// nickname→entity aliases (for the agent), and durable DM notes.
//
// Reads and writes the SHARED data/campaign-context.json (same file the MCP server
// tools add_vocab/add_nickname/set_campaign_notes write). This guarantees the STT
// biasing vocab and the agent's alias map stay in sync — the HUD, Claude Code, and
// the agent all write one place.

import * as fs from "fs";
import * as path from "path";

// Shared file is at repo-root/data/campaign-context.json.
// __dirname = voice-hud/dist at runtime → go up two levels.
const CONTEXT_PATH = path.join(__dirname, "..", "..", "data", "campaign-context.json");

export interface NicknameAlias {
  nickname: string;       // what the DM says, e.g. "the big guy", "Z"
  target: string;         // canonical token/character name it resolves to
}

export interface CampaignData {
  slug: string;
  vocab: string[];            // proper nouns for Whisper initial_prompt
  nicknames: NicknameAlias[]; // spoken alias → canonical name
  notes: string;              // durable free-text DM notebook
}

type ContextStore = Record<string, Omit<CampaignData, "slug">>;

function readStore(): ContextStore {
  try {
    return fs.existsSync(CONTEXT_PATH)
      ? (JSON.parse(fs.readFileSync(CONTEXT_PATH, "utf-8")) as ContextStore)
      : {};
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
  const entry = readStore()[slug] ?? {};
  return {
    slug,
    vocab: Array.isArray(entry.vocab) ? entry.vocab : [],
    nicknames: Array.isArray(entry.nicknames) ? entry.nicknames : [],
    notes: typeof entry.notes === "string" ? entry.notes : "",
  };
}

export function saveCampaignData(data: CampaignData): void {
  const store = readStore();
  store[data.slug] = { vocab: data.vocab, nicknames: data.nicknames, notes: data.notes };
  writeStore(store);
}

// Build the Whisper initial_prompt: campaign vocab + roster names + nicknames,
// de-duplicated and comma-joined. rosterNames come from the live roster build.
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
  const data = loadCampaignData(slug);
  const t = term.trim();
  if (t && !data.vocab.some((v) => v.toLowerCase() === t.toLowerCase())) {
    data.vocab.push(t);
    saveCampaignData(data);
  }
  return data;
}
