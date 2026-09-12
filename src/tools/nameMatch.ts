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
//
// PR #198 review (Devin) — two follow-up fixes on top of the original #195 fix:
//  - Replace-with-"" collapsed adjacent words across a stripped separator
//    ("Rigan,Stormcrow" -> "riganstormcrow", which can no longer match
//    "Rigan Stormcrow"). Replace with " " instead and let the existing
//    whitespace-collapse below tidy up the result — "Bandit Captain, the
//    Scarred" still folds to "bandit captain the scarred" either way, and a
//    hyphen (not in PUNCT_RE) is still untouched either way.
//  - A PUNCTUATION-ONLY input (e.g. "," or "...") normalizes to "". Every
//    caller that feeds a normalized value into String.prototype.includes()
//    as a "needle" must NOT treat that empty string as a real search term —
//    "".includes("") and anyName.includes("") are both true, so an unguarded
//    caller would silently match (or resolve to) EVERY token/name. See
//    isPunctuationOnlyInput below; every by-name matcher in this codebase
//    must check it before using a normalized value as a substring needle.
const PUNCT_RE = /[,.;:]/g;

export function normalizeNameForMatch(s: string | undefined | null): string {
  return (s ?? "")
    .toLowerCase()
    .replace(PUNCT_RE, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// True iff `s` has real (non-whitespace) content but normalizes away to
// nothing — i.e. it is made up ENTIRELY of the punctuation PUNCT_RE strips
// (and/or whitespace), like "," or "..." or ";;". This is the case every
// by-name matcher must refuse or explicitly skip rather than treat as an
// empty-string wildcard. Deliberately distinct from a genuinely empty/
// whitespace-only or undefined input, which legitimately means "no
// selector" and must keep working exactly as before — callers already gate
// that with their own `if (raw)` truthiness check before reaching a matcher,
// so this only needs to flag the case that WOULD have looked like real input.
export function isPunctuationOnlyInput(s: string | undefined | null): boolean {
  const raw = (s ?? "");
  return raw.trim() !== "" && normalizeNameForMatch(raw) === "";
}
