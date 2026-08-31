// Shared name-normalization for every by-name lookup in the combat/maps
// suites: resolveToken/resolveTokenOrThrow (combatHelpers.ts), the registry's
// resolveCharacterKey (registry/characters.ts), resolve_aoe's
// resolveNamesToTokens/isSidekickToken (aoe.ts), and roll_initiative /
// update_hp_many's inline matchers (combat.ts). Kept dependency-free so it can
// be imported from all of them without creating an import cycle.
//
// Issue #195: a spoken/transcribed name carries natural punctuation a board
// token's name doesn't ("Bandit Captain, the Scarred" vs "Bandit Captain the
// Scarred") — every comparison here already case-folds, so punctuation is the
// same class of difference and gets folded too. This ONLY WIDENS what
// compares equal (strip a few punctuation marks, collapse whitespace runs) —
// callers that also do ambiguity handling (resolveToken's candidates) still
// see any newly-created collision and refuse rather than guess.
const PUNCT_RE = /[,.;:]/g;

export function normalizeNameForMatch(s: string | undefined | null): string {
  return (s ?? "")
    .toLowerCase()
    .replace(PUNCT_RE, "")
    .replace(/\s+/g, " ")
    .trim();
}
