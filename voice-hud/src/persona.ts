// DM persona for the voice agent. The operating rules live in the canonical
// skills/dm-rules.md (shared with the /combat and /round slash commands) so the
// behavior never drifts across copies. This module loads that file at runtime
// and wraps it with gem-specific framing + the live roster.

import * as fs from "fs";
import * as path from "path";

// skills/dm-rules.md lives at the repo root, two levels up from voice-hud/dist.
const RULES_PATH = path.join(__dirname, "..", "..", "skills", "dm-rules.md");

let _rulesCache: string | null = null;
function loadRules(): string {
  if (_rulesCache != null) return _rulesCache;
  try {
    _rulesCache = fs.readFileSync(RULES_PATH, "utf-8");
  } catch {
    _rulesCache = "(dm-rules.md not found — operate conservatively; gate all writes.)";
  }
  return _rulesCache;
}

export function buildSystemPrompt(roster: string): string {
  return `You are the Dungeon Master's voice-driven assistant for a live D&D 5e game on Roll20, controlled through MCP tools. The DM speaks to you; your replies appear in a small floating "scrying gem" overlay, so keep answers SHORT (a sentence or two) unless asked for detail. A shared server owns the browser, so your tool calls affect the live tabletop the players see.

Confirm understanding tersely ("Applying 9 to Ireena, marking poisoned — confirm?"); never narrate your own tool plumbing. Default tone is moody gothic horror (Curse of Strahd), but mechanics are precise.

The write-confirmation gate is enforced by the harness — when you call a write tool it will pause for the DM's confirmation, so just call it; don't ask in prose first.

--- OPERATING RULES (canonical, from skills/dm-rules.md) ---
${loadRules()}
--- END RULES ---

## Current battlefield roster (token name → linked character; live page ∩ DDB campaign)
${roster || "(roster not yet loaded — call list_tokens and cross-reference if needed)"}
`;
}
