// Pure helpers for resolve_aoe (registered in combat.ts). Kept I/O-free so the
// save-bonus cascade and damage math are unit-testable without a relay.

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

// PC = controlled by an actual player id ("all" is scenery, not a PC).
export function isPcToken(t: AoeToken): boolean {
  const controllers = (t.controlledby ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return controllers.some((c) => c !== "all");
}

export function splitPcNpc(tokens: AoeToken[]): { pcs: AoeToken[]; npcs: AoeToken[] } {
  const pcs: AoeToken[] = [];
  const npcs: AoeToken[] = [];
  for (const t of tokens) (isPcToken(t) ? pcs : npcs).push(t);
  return { pcs, npcs };
}

// Already at 0 HP (with a real max) → corpse, not a target.
export function isDowned(t: AoeToken): boolean {
  const max = Number(t.bar1_max);
  return max > 0 && Number(t.bar1_value) <= 0;
}

// Resolve target names against the page token list: exact (case-insensitive)
// first, then substring. Returns misses so the caller can report them.
export function resolveNamesToTokens(
  names: string[],
  tokens: AoeToken[],
): { matched: AoeToken[]; missed: string[] } {
  const matched: AoeToken[] = [];
  const missed: string[] = [];
  for (const want of names) {
    const w = want.trim().toLowerCase();
    if (!w) continue;
    const hit =
      tokens.find((t) => (t.name || "").trim().toLowerCase() === w) ??
      tokens.find((t) => (t.name || "").toLowerCase().includes(w));
    if (hit) {
      if (!matched.some((m) => m.id === hit.id)) matched.push(hit);
    } else {
      missed.push(want);
    }
  }
  return { matched, missed };
}
