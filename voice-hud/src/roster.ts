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

  // A token is a PC iff a PLAYER controls it (controlledby set, not "all").
  // NOT layer (PCs sit on "objects" here, not "tokens" — the old bug) and NOT
  // represents (monsters also link stat-block sheets, so represents sweeps in
  // every Mage/Skeleton). controlledby is the only reliable PC discriminator.
  // Names may have stray whitespace, so trim before matching.
  const entries: RosterEntry[] = tokens
    .filter((t) => {
      const controlled = (t.controlledby || "").trim();
      return controlled.length > 0 && controlled !== "all";
    })
    .map((t) => {
      const name = (t.name || "").trim();
      const lower = name.toLowerCase();
      const match = ddbNames.find(
        (n) => n.toLowerCase().includes(lower) || lower.includes(n.toLowerCase())
      );
      return { tokenName: name, characterName: match, represents: t.represents || undefined };
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
