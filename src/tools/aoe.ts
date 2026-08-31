// Pure helpers for resolve_aoe (registered in combat.ts). Kept I/O-free so the
// save-bonus cascade and damage math are unit-testable without a relay.

import { normalizeNameForMatch } from "./nameMatch.js";

export const SAVE_ABILITIES = [
  "strength", "dexterity", "constitution", "intelligence", "wisdom", "charisma",
] as const;
export type SaveAbility = (typeof SAVE_ABILITIES)[number];

const ABILITY_SHORT: Record<SaveAbility, string> = {
  strength: "str", dexterity: "dex", constitution: "con",
  intelligence: "int", wisdom: "wis", charisma: "cha",
};

export function abilityShort(ability: SaveAbility): string {
  return ABILITY_SHORT[ability];
}

// Attribute names to fetch for one ability's save bonus, in resolution order.
export function saveAttrNames(ability: SaveAbility): string[] {
  const short = ABILITY_SHORT[ability];
  return [
    `npc_${short}_save`,        // OGL sheet: NPC save bonus (set when proficient)
    `${ability}_save_bonus`,    // PC-style computed save bonus
    `npc_${ability}`,           // NPC ability score → fall back to its modifier
    ability,                    // PC ability score → modifier
  ];
}

// Resolve a save bonus from a fetched attribute map. Bonus attrs are used
// directly; score attrs become floor((score-10)/2). Empty/absent → next in
// cascade; nothing usable → +0 flat d20.
export function resolveSaveBonus(
  attrs: Record<string, { current: unknown }> | null | undefined,
  ability: SaveAbility,
): { bonus: number; source: string } {
  const names = saveAttrNames(ability);
  const numeric = (v: unknown): number | null => {
    if (v === undefined || v === null || String(v).trim() === "") return null;
    const n = Number(v);
    return isFinite(n) ? n : null;
  };
  for (let i = 0; i < names.length; i++) {
    const n = numeric(attrs?.[names[i]]?.current);
    if (n === null) continue;
    const isScore = i >= 2;
    return isScore
      ? { bonus: Math.floor((n - 10) / 2), source: names[i] }
      : { bonus: n, source: names[i] };
  }
  return { bonus: 0, source: "none" };
}

// Damage taken given the save outcome. halfOnSave=true → save takes half
// (floored, 5e standard); false → save negates entirely.
export function damageOnSave(saved: boolean, damage: number, halfOnSave: boolean): number {
  if (!saved) return damage;
  return halfOnSave ? Math.floor(damage / 2) : 0;
}

export interface AoeToken {
  id: string;
  name: string;
  layer?: string;
  controlledby?: string;
  represents?: string;
  bar1_value?: number | string;
  bar1_max?: number | string;
}

// Token classing is THREE-way (issue #132): PC (Beyond20-owned bar, tracked
// shadow HP), NPC (bar1), and SIDEKICK — a player-controlled token (Tua,
// Salros Eventide, Amri in the Firebirds campaign) whose HP nonetheless lives
// in bar1 and who dies like an NPC (no dying state). `controlledby` alone
// cannot tell PC from sidekick apart — both are player-controlled — so
// callers pass a `sidekickNames` set (built from the characters registry's
// `sidekick: true` entries, see registry/characters.ts `listSidekickNames`)
// to disambiguate. Matching is case-insensitive and bidirectional-substring,
// same tolerance as resolveNamesToTokens, so epithets ("Tua the Bold") still
// match the bare registry name ("tua").
export type TokenClass = "pc" | "npc" | "sidekick";

function controlledByPlayer(t: AoeToken): boolean {
  const controllers = (t.controlledby ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return controllers.some((c) => c !== "all");
}

function tokenBaseName(t: AoeToken): string {
  // Issue #195: fold punctuation the same way resolveToken does, alongside the
  // existing case fold, so an epithet spoken/transcribed with a comma
  // ("Tua, the Bold") still matches the bare registry name.
  return normalizeNameForMatch((t.name || "").split("\n")[0].trim());
}

// True iff the token's (pre-epithet) name matches an entry in the
// sidekick-name set.
export function isSidekickToken(t: AoeToken, sidekickNames: Set<string> | undefined): boolean {
  if (!sidekickNames || sidekickNames.size === 0) return false;
  const name = tokenBaseName(t);
  if (!name) return false;
  for (const s of sidekickNames) {
    if (!s) continue;
    const ns = normalizeNameForMatch(s);
    // PR #198 review (Devin, finding 1): a punctuation-only registry key
    // would fold to "" and wildcard-match every token via name.includes("").
    // Registry keys realistically won't be punctuation-only, but this is the
    // same guard every other by-name matcher touched by #195 needs.
    if (!ns) continue;
    if (name === ns || name.includes(ns) || ns.includes(name)) return true;
  }
  return false;
}

// Full three-way classification. sidekickNames omitted → no sidekick override
// applies (every player-controlled token classes as "pc" — pre-#132 behavior).
export function classifyToken(t: AoeToken, sidekickNames?: Set<string>): TokenClass {
  if (!controlledByPlayer(t)) return "npc";
  return isSidekickToken(t, sidekickNames) ? "sidekick" : "pc";
}

// PC = controlled by an actual player id ("all" is scenery, not a PC) AND not
// overridden as a sidekick. Pass the campaign's sidekick-name set so sidekick
// tokens route as NPCs (bar1 HP, NPC death semantics) instead of PCs.
export function isPcToken(t: AoeToken, sidekickNames?: Set<string>): boolean {
  return classifyToken(t, sidekickNames) === "pc";
}

// Sidekicks bucket with npcs — bar1 HP, bloodied-threshold automation, and
// NPC save-rolling/death semantics all apply identically to sidekicks and NPCs.
export function splitPcNpc(
  tokens: AoeToken[],
  sidekickNames?: Set<string>,
): { pcs: AoeToken[]; npcs: AoeToken[] } {
  const pcs: AoeToken[] = [];
  const npcs: AoeToken[] = [];
  for (const t of tokens) (isPcToken(t, sidekickNames) ? pcs : npcs).push(t);
  return { pcs, npcs };
}

// Already at 0 HP (with a real max) → corpse, not a target.
export function isDowned(t: AoeToken): boolean {
  const max = Number(t.bar1_max);
  return max > 0 && Number(t.bar1_value) <= 0;
}

// A token has a usable HP bar iff bar1_max is a positive number — the same test
// list_tokens uses to decide hp is null. NPCs dropped on the map without bar1
// configured have no bar to write, so damage/healing silently no-ops; callers
// should surface "no HP bar" instead of pretending a 0 was applied.
export function hasHpBar(t: { bar1_max?: number | string }): boolean {
  const max = Number(t.bar1_max);
  return isFinite(max) && max > 0;
}

// Resolve target names against the page token list: exact (case-insensitive)
// first, then substring. Returns misses so the caller can report them.
//
// PR #198 review (Devin) fixed two gaps on top of the original #195 fix:
//  - finding 1 (wildcard): a punctuation-only `want` ("," / "...") folds to
//    "" via normalizeNameForMatch, and every non-empty token name
//    ".includes("")" — an unguarded lookup would "match" the entire board.
//    The pre-existing `if (!w) continue` guard already prevented a wildcard
//    here, but it silently DROPPED the name without reporting it; changed
//    to report it via `missed` instead (loud, not a silent no-op — the
//    project's stated preference).
//  - finding 2 (collision consistency): both the exact and substring passes
//    used to be `tokens.find(...)`, silently picking the FIRST token that
//    collided when two DIFFERENT names folded to the same comparison form
//    ("Iron, Golem" / "Iron Golem") — resolveToken already refuses that case
//    via candidates; this now does too, via `missed` (every existing caller
//    — resolve_aoe's targetNames/centerTokenName, update_hp_many's names[] —
//    already treats a missed name as "don't guess": resolve_aoe throws on
//    any non-empty `missed`, update_hp_many drops that one name from the
//    batch rather than writing to an arbitrary match, same as it already
//    does for a genuinely not-found name).
export function resolveNamesToTokens(
  names: string[],
  tokens: AoeToken[],
): { matched: AoeToken[]; missed: string[] } {
  const matched: AoeToken[] = [];
  const missed: string[] = [];
  for (const want of names) {
    const w = normalizeNameForMatch(want);
    if (!w) { missed.push(want); continue; }
    const exact = tokens.filter((t) => normalizeNameForMatch(t.name) === w);
    const hits = exact.length > 0 ? exact : tokens.filter((t) => normalizeNameForMatch(t.name).includes(w));
    if (hits.length === 1) {
      const hit = hits[0];
      if (!matched.some((m) => m.id === hit.id)) matched.push(hit);
    } else {
      // 0 hits (genuinely not found) or 2+ hits (ambiguous collision) both
      // refuse to guess — reported identically via `missed`.
      missed.push(want);
    }
  }
  return { matched, missed };
}
