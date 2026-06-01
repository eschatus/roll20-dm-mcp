// Per-campaign editable data for the HUD: proper-noun vocab (Whisper biasing),
// nickname→entity aliases (for the agent), and durable DM notes. Persisted under
// voice-hud/data/<slug>.json so it survives restarts. The wizard panel edits this.
//
// Token↔character↔DDB mappings remain authoritative in the main project's
// data/characters.json (read via the MCP server); this store layers the
// voice-specific extras on top.

import * as fs from "fs";
import * as path from "path";
import { CONFIG } from "./config";

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

function fileFor(slug: string): string {
  return path.join(CONFIG.dataDir, `${slug}.json`);
}

function empty(slug: string): CampaignData {
  return { slug, vocab: [], nicknames: [], notes: "" };
}

export function loadCampaignData(slug: string): CampaignData {
  try {
    const raw = fs.readFileSync(fileFor(slug), "utf-8");
    const parsed = JSON.parse(raw) as Partial<CampaignData>;
    return {
      slug,
      vocab: parsed.vocab ?? [],
      nicknames: parsed.nicknames ?? [],
      notes: parsed.notes ?? "",
    };
  } catch {
    return empty(slug);
  }
}

export function saveCampaignData(data: CampaignData): void {
  if (!fs.existsSync(CONFIG.dataDir)) fs.mkdirSync(CONFIG.dataDir, { recursive: true });
  fs.writeFileSync(fileFor(data.slug), JSON.stringify(data, null, 2), "utf-8");
}

// Build the Whisper initial_prompt: campaign vocab + roster names + nicknames,
// de-duplicated and comma-joined. rosterNames come from the live roster build.
export function buildVocabPrompt(data: CampaignData, rosterNames: string[]): string {
  const set = new Set<string>();
  for (const v of data.vocab) if (v.trim()) set.add(v.trim());
  for (const n of rosterNames) if (n.trim()) set.add(n.trim());
  for (const a of data.nicknames) { if (a.nickname.trim()) set.add(a.nickname.trim()); if (a.target.trim()) set.add(a.target.trim()); }
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
