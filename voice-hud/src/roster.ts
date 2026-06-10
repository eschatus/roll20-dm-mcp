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

// The DDB campaign character list is fixed for the session — cache it so the
// per-turn roster rebuild only pays for list_tokens (the part that actually
// changes as tokens come and go). clearRosterCache() forces a full re-fetch
// (used by the explicit "rebuild roster" button).
let _ddbCache: DdbChar[] | null = null;
export function clearRosterCache(): void { _ddbCache = null; }

export async function buildRoster(mcp: McpRoll20): Promise<{ entries: RosterEntry[]; text: string; names: string[]; tokenById: Record<string, string> }> {
  let tokens: TokenLite[] = [];

  try { tokens = JSON.parse(await mcp.call("list_tokens", {})) as TokenLite[]; } catch { /* ignore */ }

  let ddb: DdbChar[] = _ddbCache ?? [];
  if (!_ddbCache) {
    try {
      const raw = await mcp.call("ddb_list_campaign_characters", {});
      const parsed = JSON.parse(raw);
      ddb = Array.isArray(parsed) ? parsed : (parsed.characters ?? []);
      _ddbCache = ddb;
    } catch { /* ignore — leave cache unset so we retry next turn */ }
  }

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

  const pcText = entries.length
    ? entries.map((e) => `- ${e.tokenName}${e.characterName ? ` → ${e.characterName}` : ""}`).join("\n")
    : "(no player tokens found on the current page)";

  // Also list the OTHER tokens on the page (monsters/NPCs) by name, so the agent
  // can match targets the DM narrates ("Mage the Twisted") instead of inventing
  // names. Player tokens excluded (already above); blank-named tokens skipped.
  const pcIds = new Set(entries.map((e) => e.tokenName.toLowerCase()));
  const others = Array.from(new Set(
    tokens
      .map((t) => (t.name || "").split("\n")[0].trim())
      .filter((n) => n && !pcIds.has(n.toLowerCase()))
  ));
  const othersText = others.length ? others.map((n) => `- ${n}`).join("\n") : "(none)";

  const names = Array.from(new Set([
    ...entries.map((e) => e.tokenName),
    ...entries.map((e) => e.characterName || ""),
    ...others,
  ].filter(Boolean)));

  const text = `PLAYER CHARACTERS:\n${pcText}\n\nOTHER TOKENS ON THE MAP (monsters/NPCs — exact names, match the DM's targets to these):\n${othersText}`;

  const tokenById: Record<string, string> = {};
  tokens.forEach((t) => { if (t.id) tokenById[t.id] = (t.name || "").split("\n")[0].trim(); });

  return { entries, text, names, tokenById };
}
