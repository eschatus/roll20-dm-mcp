// Roster builder — cross-references the live page's tokens with the DDB campaign
// character list to produce a "token name → character" map the agent injects into
// its system prompt. No selection needed: PCs are deployed on the page and match
// the DDB roster (the agreed approach).

import { McpRoll20 } from "./mcp";

export interface RosterEntry {
  tokenName: string;
  characterName?: string;
  represents?: string; // Roll20 character sheet id, if linked
}

interface TokenLite { id: string; name: string; layer: string; controlledby: string; represents: string; }
interface DdbChar { name?: string; characterName?: string; id?: number }

export async function buildRoster(mcp: McpRoll20): Promise<{ entries: RosterEntry[]; text: string; names: string[] }> {
  let tokens: TokenLite[] = [];
  let ddb: DdbChar[] = [];

  try { tokens = JSON.parse(await mcp.call("list_tokens", {})) as TokenLite[]; } catch { /* ignore */ }
  try {
    const raw = await mcp.call("ddb_list_campaign_characters", {});
    const parsed = JSON.parse(raw);
    ddb = Array.isArray(parsed) ? parsed : (parsed.characters ?? []);
  } catch { /* ignore */ }

  const ddbNames = ddb.map((c) => (c.name || c.characterName || "").trim()).filter(Boolean);

  // Player-controlled tokens are the PCs; match each to a DDB character by fuzzy name.
  const entries: RosterEntry[] = tokens
    .filter((t) => t.controlledby && t.controlledby.length > 0 && t.layer === "tokens")
    .map((t) => {
      const match = ddbNames.find(
        (n) => n.toLowerCase().includes(t.name.toLowerCase()) || t.name.toLowerCase().includes(n.toLowerCase())
      );
      return { tokenName: t.name, characterName: match, represents: t.represents || undefined };
    });

  const names = Array.from(new Set([
    ...entries.map((e) => e.tokenName),
    ...entries.map((e) => e.characterName || ""),
  ].filter(Boolean)));

  const text = entries.length
    ? entries.map((e) => `- ${e.tokenName}${e.characterName ? ` → ${e.characterName}` : " (no DDB match)"}`).join("\n")
    : "(no player tokens found on the current page)";

  return { entries, text, names };
}
