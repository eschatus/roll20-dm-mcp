// D&D Beyond monster-service v1 id→name lookup tables.
//
// monster-service returns numeric ids for challenge rating, alignment, size, movement type,
// damage adjustments and condition immunities rather than display strings. These tables decode
// them. They are a verbatim capture of the fixed 5e ruleset data served at
//   GET https://www.dndbeyond.com/api/config/json   (keys: challengeRatings, alignments,
//   creatureSizes, movements, damageAdjustments, conditions)
// captured 2026-06-20 and validated against the live Horned Devil (id 16927) statblock. This is
// stable ruleset data — re-capture only if DDB adds new content (new homebrew damage adjustments
// occasionally appear; unknown ids fall through to a raw label, never crash).

// challengeRatingId → CR display string. Fractions render as "1/8" etc.; whole numbers as-is.
const CR_VALUES: Record<number, number> = {
  1: 0, 2: 0.125, 3: 0.25, 4: 0.5, 5: 1, 6: 2, 7: 3, 8: 4, 9: 5, 10: 6, 11: 7, 12: 8,
  13: 9, 14: 10, 15: 11, 16: 12, 17: 13, 18: 14, 19: 15, 20: 16, 21: 17, 22: 18, 23: 19,
  24: 20, 25: 21, 26: 22, 27: 23, 29: 24, 30: 25, 31: 26, 32: 27, 33: 28, 34: 29, 35: 30,
};

export function challengeRatingLabel(id: number | null | undefined): string {
  if (id == null) return "?";
  const v = CR_VALUES[id];
  if (v == null) return "?";
  if (v === 0.125) return "1/8";
  if (v === 0.25) return "1/4";
  if (v === 0.5) return "1/2";
  return String(v);
}

export const ALIGNMENTS: Record<number, string> = {
  1: "Lawful Good", 2: "Neutral Good", 3: "Chaotic Good", 4: "Lawful Neutral", 5: "Neutral",
  6: "Chaotic Neutral", 7: "Lawful Evil", 8: "Neutral Evil", 9: "Chaotic Evil", 10: "Unaligned",
  11: "Any Alignment", 13: "Any Evil Alignment", 14: "Any Good Alignment", 15: "Any Chaotic Alignment",
  16: "Any Lawful Alignment", 18: "Any Non-Good Alignment", 19: "Any Non-Lawful Alignment",
  20: "Typically Chaotic Neutral", 21: "Typically Neutral Good", 22: "Typically Lawful Good",
  23: "Typically Chaotic Evil", 24: "Typically Neutral Evil", 25: "Typically Chaotic Good",
  26: "Typically Neutral", 27: "Typically Lawful Evil", 28: "Typically Lawful Neutral",
  29: "Any Neutral Alignment", 30: "Any Non-Chaotic Alignment",
};

export const SIZES: Record<number, string> = {
  2: "Tiny", 3: "Small", 4: "Medium", 5: "Large", 6: "Huge", 7: "Gargantuan", 10: "Medium or Small",
};

// movementId → DdbMonsterSpeed key.
export const MOVEMENTS: Record<number, "walk" | "burrow" | "climb" | "fly" | "swim"> = {
  1: "walk", 2: "burrow", 3: "climb", 4: "fly", 5: "swim",
};

export const CONDITIONS: Record<number, string> = {
  1: "Blinded", 2: "Charmed", 3: "Deafened", 4: "Exhaustion", 5: "Frightened", 6: "Grappled",
  7: "Incapacitated", 8: "Invisible", 9: "Paralyzed", 10: "Petrified", 11: "Poisoned", 12: "Prone",
  13: "Restrained", 14: "Stunned", 15: "Unconscious",
};

// damageAdjustmentId → {name, type}. type 1=resistance, 2=immunity, 3=vulnerability. The list runs
// to homebrew/published entries with long conditional names; only the id, name and type matter here.
export interface DamageAdjustment { name: string; type: 1 | 2 | 3 }
export const DAMAGE_ADJUSTMENTS: Record<number, DamageAdjustment> = {
  1: { name: "Bludgeoning", type: 1 }, 2: { name: "Piercing", type: 1 }, 3: { name: "Slashing", type: 1 },
  4: { name: "Lightning", type: 1 }, 5: { name: "Thunder", type: 1 }, 6: { name: "Poison", type: 1 },
  7: { name: "Cold", type: 1 }, 8: { name: "Radiant", type: 1 }, 9: { name: "Fire", type: 1 },
  10: { name: "Necrotic", type: 1 }, 11: { name: "Acid", type: 1 }, 12: { name: "Psychic", type: 1 },
  13: { name: "Bludgeoning, Piercing, and Slashing from Nonmagical Attacks", type: 1 },
  14: { name: "Bludgeoning, Piercing, and Slashing from Nonmagical Attacks that aren't Silvered", type: 1 },
  15: { name: "Bludgeoning, Piercing, and Slashing from Nonmagical Attacks that aren't Adamantine", type: 1 },
  16: { name: "Piercing and Slashing from Nonmagical Attacks that aren't Adamantine", type: 1 },
  17: { name: "Bludgeoning", type: 2 }, 18: { name: "Piercing", type: 2 }, 19: { name: "Slashing", type: 2 },
  20: { name: "Lightning", type: 2 }, 21: { name: "Thunder", type: 2 }, 22: { name: "Poison", type: 2 },
  23: { name: "Cold", type: 2 }, 24: { name: "Radiant", type: 2 }, 25: { name: "Fire", type: 2 },
  26: { name: "Necrotic", type: 2 }, 27: { name: "Acid", type: 2 }, 28: { name: "Psychic", type: 2 },
  29: { name: "Bludgeoning, Piercing, and Slashing from Nonmagical Attacks", type: 2 },
  30: { name: "Bludgeoning, Piercing, and Slashing from Nonmagical Attacks that aren't Silvered", type: 2 },
  31: { name: "Bludgeoning, Piercing, and Slashing from Nonmagical Attacks that aren't Adamantine", type: 2 },
  32: { name: "Piercing and Slashing from Nonmagical Attacks that aren't Adamantine", type: 2 },
  33: { name: "Bludgeoning", type: 3 }, 34: { name: "Piercing", type: 3 }, 35: { name: "Slashing", type: 3 },
  36: { name: "Lightning", type: 3 }, 37: { name: "Thunder", type: 3 }, 38: { name: "Poison", type: 3 },
  39: { name: "Cold", type: 3 }, 40: { name: "Radiant", type: 3 }, 41: { name: "Fire", type: 3 },
  42: { name: "Necrotic", type: 3 }, 43: { name: "Acid", type: 3 }, 44: { name: "Psychic", type: 3 },
  45: { name: "Piercing from Magic Weapons Wielded by Good Creatures", type: 3 },
  46: { name: "Bludgeoning, Piercing, and Slashing from Magic Weapons", type: 1 },
  47: { name: "Force", type: 1 }, 48: { name: "Force", type: 2 }, 49: { name: "Force", type: 3 },
  50: { name: "Bludgeoning, Piercing, and Slashing from Nonmagical Attacks while in Dim Light or Darkness", type: 1 },
  51: { name: "Ranged Attacks", type: 1 }, 52: { name: "Damage Dealt By Traps", type: 1 }, 53: { name: "All", type: 1 },
  54: { name: "Bludgeoning from non magical attacks", type: 1 },
  55: { name: "Bludgeoning, Piercing, and Slashing from Metal Weapons", type: 2 },
  56: { name: "Bludgeoning, Piercing, and Slashing while in Dim Light or Darkness", type: 1 },
  57: { name: "Damage from Spells", type: 1 },
  60: { name: "Bludgeoning, Piercing, and Slashing from Nonmagical Attacks that aren't Adamantine or Silvered", type: 2 },
  61: { name: "Nonmagical Bludgeoning, Piercing, and Slashing (from Stoneskin)", type: 1 },
  62: { name: "All damage but Force, Radiant, and Psychic", type: 1 },
  63: { name: "Petrified (Aberrant Armor Only)", type: 2 },
  64: { name: "Slashing from a Vorpal Sword", type: 3 },
  65: { name: "Damage of the type matching the animated breath's form (acid, cold, fire, lightning, or poison)", type: 1 },
  66: { name: "Psychic (granted by Ruidium Armor)", type: 1 },
  67: { name: "Bludgeoning, Piercing, and Slashing that is Nonmagical", type: 2 },
  68: { name: "One of the following: acid, cold, fire, lightning, or poison", type: 1 },
  69: { name: "Lightning (granted by darksteel greataxe)", type: 1 },
  70: { name: "Slashing and Piercing from Nonmagical Attacks", type: 1 },
  71: { name: "Bludgeoning, Piercing, and Slashing from Magical Weapons", type: 2 },
  72: { name: "All damage from spells", type: 2 },
  73: { name: "Bludgeoning, Piercing, and Slashing by Silvered Weapons", type: 3 },
  74: { name: "Bludgeoning from nonmagical attacks", type: 2 },
  75: { name: "Bludgeoning, Slashing, and Piercing from Nonmagical Attacks not made with Cold Iron Weapons", type: 2 },
  76: { name: "Piercing and Slashing from nonmagical attacks", type: 1 },
  77: { name: "Slashing from Nonmagical Attacks", type: 1 }, 78: { name: "Piercing from nonmagical attacks", type: 1 },
  79: { name: "Bludgeoning, Piercing, and Slashing from attacks not made with Cold Iron Weapons", type: 1 },
  80: { name: "Bludgeoning, Piercing, and Slashing from Nonmagical Attacks not made with Cold Iron Weapons", type: 1 },
  81: { name: "Bludgeoning from nonmagical attacks", type: 1 }, 82: { name: "Bludgeoning and Piercing from nonmagical attacks", type: 1 },
  83: { name: "Bludgeoning, Piercing, and Slashing from Mundane Attacks", type: 1 },
  84: { name: "Bludgeoning damage from falling", type: 2 },
  85: { name: "Bludgeoning, Piercing, and Slashing from Mundane Attacks", type: 2 },
  86: { name: "Bludgeoning, Piercing, and Slashing from weapons that aren’t enchanted with spells for the Bane of the Undead", type: 1 },
  87: { name: "Piercing damage from weapons wielded by creatures under the effect of a Bless spell", type: 3 },
  88: { name: "Bludgeoning and Slashing from nonmagical attacks", type: 1 },
  89: { name: "All", type: 2 },
  90: { name: "Bludgeoning, Piercing, and Slashing from Magical Attacks", type: 1 },
  91: { name: "All damage from spells except Thunder damage", type: 1 },
  92: { name: "Necrotic (with Emerald Fulcrum Lens)", type: 1 },
  93: { name: "Extra damage caused by Sneak Attack and Critical Hits", type: 1 },
};
