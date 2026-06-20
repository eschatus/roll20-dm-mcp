// Structural checkers for narration-rule evals (N2/N7/N8 in TEST-PLAN.md).
//
// These are PURE functions over a recorded tool-call log — no model, no network.
// That split is deliberate: the checkers are hermetic and unit-tested per-PR
// (structural.test.ts), while the live-model eval that FEEDS them real output is
// opt-in (narration-live-eval.test.ts). So the assertion logic is always gated in
// CI even though the model behavior it grades is not.

/** One recorded MCP invocation (shape matches FakeMcp's RecordedCall). */
export interface ToolCallLog {
  name: string;
  args: Record<string, unknown>;
}

const HP_TOOLS = new Set(["update_token_hp", "update_hp_many"]);

/** All HP-mutating calls in the log. */
export function hpCalls(calls: ToolCallLog[]): ToolCallLog[] {
  return calls.filter((c) => HP_TOOLS.has(c.name));
}

/** Count of calls to a given tool. */
export function countTool(calls: ToolCallLog[], name: string): number {
  return calls.filter((c) => c.name === name).length;
}

/**
 * N2 — multi-target damage must be ONE batched call, not a loop of single-target
 * updates. Pass if a batched primitive was used and single-target HP wasn't looped.
 */
export function isBatchedMultiTarget(calls: ToolCallLog[]): boolean {
  const batched = countTool(calls, "update_hp_many") + countTool(calls, "batch_exec");
  const singles = countTool(calls, "update_token_hp");
  return batched >= 1 && singles <= 1;
}

/** Player-facing narration strings (send_narration text args). */
export function playerNarrations(calls: ToolCallLog[]): string[] {
  return calls
    .filter((c) => c.name === "send_narration")
    .map((c) => String(c.args.text ?? ""))
    .filter((t) => t.length > 0);
}

/**
 * N7 — does any digit appear in this player-facing text? In a damage/heal scenario
 * any number is an HP/total leak (the rule: players see bars/words, never figures).
 * Note: this is intentionally strict — apply it only to combat-math narrations,
 * where a stray "30 feet" isn't expected.
 */
export function containsDigit(text: string): boolean {
  return /\d/.test(text);
}

/** N7 over a whole log: no player-facing narration may contain a digit. */
export function playerNarrationsAreRedacted(calls: ToolCallLog[]): boolean {
  return playerNarrations(calls).every((t) => !containsDigit(t));
}

/**
 * Does any call target the named token? Matches characterName / tokenName exactly
 * or by substring, and names[]/nameMatch for batch tools. Case-insensitive.
 * Used by N8 (a claimed effect on X must have a real call referencing X).
 */
export function callsTargeting(calls: ToolCallLog[], name: string): ToolCallLog[] {
  const needle = name.toLowerCase();
  const hit = (v: unknown): boolean =>
    typeof v === "string" && v.toLowerCase().includes(needle);
  return calls.filter((c) => {
    const a = c.args;
    if (hit(a.characterName) || hit(a.tokenName) || hit(a.nameMatch)) return true;
    if (Array.isArray(a.names) && a.names.some(hit)) return true;
    return false;
  });
}

/** N8 — a claimed effect on `name` is backed iff an HP call references it. */
export function hpClaimIsBacked(calls: ToolCallLog[], name: string): boolean {
  return callsTargeting(hpCalls(calls), name).length >= 1;
}
