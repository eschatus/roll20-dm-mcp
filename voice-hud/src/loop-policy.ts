// Agent-loop terminal policy — the single authority on "is this turn finished?".
//
// The legacy loop equates DONE with "the model emitted zero tool calls this step".
// That conflates two very different situations:
//   Failure A (prose-stop): the DM stated an outcome ("Thorne's poisoned") and the
//     model ACKNOWLEDGED it in prose without calling the tool — nothing changed on
//     the table, yet the turn ends. The dangerous one.
//   Failure B (partial):    a COMPOUND instruction ("fireball clears the web AND
//     drops two skeletons") got one effect applied and the rest dropped.
//
// This module turns "done" into a structural decision instead of mere silence, with
// BOUNDED persistence so a live table never spins:
//   "nudge" mode → at most ONE re-prompt when an outcome was stated but nothing was
//                  applied (kills Failure A).
//   "full"  mode → ALSO at most one completeness check on a compound turn that did
//                  act (catches Failure B).
//
// It is pure logic with no I/O so both the live agent (agent.ts) and the eval harness
// (scripts/eval-arc.ts) share ONE terminal decision and can't drift apart.

export type LoopMode = "off" | "nudge" | "full";

// Re-prompts pushed back to the model when the turn looks unfinished. Kept here (not
// inline at the call sites) so the agent and the eval issue byte-identical nudges.
export const PERSISTENCE_NUDGE =
  "You replied without changing the table. If the DM stated a result — damage, a " +
  "condition, a death, a zone, a turn change — call the tool that makes it true NOW. " +
  "If genuinely nothing needs to change on the table, reply NOACTION.";

export const COMPLETENESS_CHECK =
  "Re-read the DM's last instruction and the tool results above. Is EVERY stated " +
  "effect now applied to the table? If something is still missing, call the tool(s) " +
  "for it now. If everything is done, reply DONE.";

// Reads never change the table, so a turn that only ran reads has not "acted" on a
// stated outcome — it can still be a Failure-A flake. Everything not in this set is
// treated as a mutation for the "did it act?" test. (Superset across phases; harmless
// to list tools that aren't in a given phase's allowlist.)
export const READ_ONLY_TOOLS = new Set<string>([
  "list_tokens", "get_token", "get_turn_order", "find_tokens_in_range", "get_recent_chat",
  "get_token_markers", "list_zones", "get_mob_plans", "get_dm_inbox", "list_custom_states",
  "ddb_get_character", "ddb_get_monster", "ddb_list_campaign_characters", "ddb_list_campaigns",
  "list_campaigns", "active_campaign", "get_current_page", "check_turn_hook", "get_selection",
  "get_campaign_context", "get_tactic_memory", "debug_turn_order",
]);

export const isMutatingTool = (name: string): boolean => !READ_ONLY_TOOLS.has(name);

// A bare acknowledgement the model emits to END a turn after a nudge — suppress it
// from the gem rather than show the DM "DONE" / "NOACTION" as if it were a reply.
export function isSentinel(text: string): boolean {
  return /^(done|noaction|no action|nothing to do|nothing needed|n\/?a)\.?$/i.test(text.trim());
}

// Does the utterance STATE an actionable outcome (so a flaked turn deserves a nudge)?
// Deliberately conservative: a false positive adds a ~2.4s round-trip to a chit-chat
// turn, so questions/lookups are excluded outright and only clear state-change cues
// count. Missing a flake is cheaper than taxing every idle turn.
const OUTCOME_RE = new RegExp([
  /\btakes?\s+\d+/, /\bdeals?\s+\d+/, /\b\d+\s*(points?|pts?|dmg|damage|hp)\b/,
  /\bheals?\b/, /\bdrops?\b/, /\b(dies|died|is dead|is down|goes down|falls unconscious|unconscious|killed|slain)\b/,
  /\b(poisoned|prone|stunned|frightened|restrained|grappled|blinded|paraly[sz]ed|charmed|deafened|incapacitated|petrified|exhausted|bloodied|burning|asleep)\b/,
  /\bis\s+no\s+longer\b/, /\bno\s+longer\b/,
  /\b(web|cloud ?kill|wall of \w+|spike growth|grease|spirit guardians|fog cloud|fills the|emanation)\b/,
  /\b(next turn|advance the turn|end (the )?turn|new round|round (one|two|three|four|five|\d+))\b/,
  /\bcasts?\b/,
].map((r) => r.source).join("|"), "i");

export function statesOutcome(transcript: string): boolean {
  const s = transcript.toLowerCase().trim();
  if (!s) return false;
  // Questions and lookups expect an ANSWER, not a table change — never nudge them.
  if (/\?\s*$/.test(s)) return false;
  if (/^(who|what|where|when|why|how|which|is|are|does|do|did|can|could|should|would|will|has|have|list|show|tell me|give me|read|check)\b/.test(s)) return false;
  return OUTCOME_RE.test(s);
}

// Is this a COMPOUND turn (multiple targets / several effects in one breath)? Such
// turns are the ones that partially complete, so "full" mode runs a completeness
// check on them. (Moved here from agent.ts so the escalation heuristic and the
// completeness gate share one definition.)
export function looksComplex(t: string): boolean {
  const s = t.toLowerCase();
  if (t.length > 90) return true;
  if (/\b(all|each|every|both|the (party|skeletons|goblins|group))\b/.test(s)) return true;
  const verbs = (s.match(/\b(takes?|deals?|damage|heal|save|casts?|hits?|misses?|drops?|falls?|burns?|marks?|poison|prone|stun|frighten)\b/g) || []).length;
  return verbs >= 3; // multiple distinct effects in one breath
}

export interface TerminalState {
  transcript: string;
  mutationsThisTurn: number;        // count of MUTATING tool calls attempted this turn
  nudgedAlready: boolean;           // has the persistence nudge fired this turn?
  completenessCheckedAlready: boolean;
  mode: LoopMode;
}

export type TerminalAction =
  | { kind: "done" }
  | { kind: "nudge"; tag: "persist" | "complete"; text: string };

// Called ONLY when the model emitted zero tool calls this step. Decides whether the
// turn is genuinely finished or should get one bounded re-prompt. Each nudge is
// one-shot (guarded by its flag), so a turn can re-prompt at most twice total.
export function decideTerminal(s: TerminalState): TerminalAction {
  if (s.mode === "off") return { kind: "done" };

  // Failure A — an outcome was stated but nothing changed: persist once.
  if (!s.nudgedAlready && s.mutationsThisTurn === 0 && statesOutcome(s.transcript)) {
    return { kind: "nudge", tag: "persist", text: PERSISTENCE_NUDGE };
  }

  // Failure B — a compound turn that DID act: verify completeness once ("full" only).
  if (s.mode === "full" && !s.completenessCheckedAlready && s.mutationsThisTurn > 0 && looksComplex(s.transcript)) {
    return { kind: "nudge", tag: "complete", text: COMPLETENESS_CHECK };
  }

  return { kind: "done" };
}
