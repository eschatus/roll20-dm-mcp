// Global STT base vocabulary — the common D&D 5e terms spoken every session,
// independent of campaign. Biasing Whisper with these fixes the constant mishears
// ("init" / "initiative", "saving throw", "advantage", ability/skill/condition
// names, damage types, dice). This set is deliberately SEPARATE from the
// per-campaign proper nouns in campaignData (those are names/places that change
// campaign to campaign) — it ships by default and applies everywhere.
//
// Extend it without touching code: drop a JSON array of extra terms at
// `<dataDir>/base-vocab.json` (DMW_DATA_DIR). They're unioned with the defaults.
import * as fs from "fs";
import * as path from "path";
import { CONFIG } from "./config";

export const DEFAULT_BASE_VOCAB: string[] = [
  // core combat loop
  "initiative", "saving throw", "saving throws", "death save", "death saving throw",
  "advantage", "disadvantage", "armor class", "hit points", "temporary hit points",
  "bonus action", "reaction", "concentration", "proficiency", "passive perception",
  "difficult terrain", "opportunity attack", "long rest", "short rest", "inspiration",
  // abilities
  "Strength", "Dexterity", "Constitution", "Intelligence", "Wisdom", "Charisma",
  // skills
  "Acrobatics", "Arcana", "Athletics", "Deception", "History", "Insight",
  "Intimidation", "Investigation", "Medicine", "Nature", "Perception", "Performance",
  "Persuasion", "Religion", "Sleight of Hand", "Stealth", "Survival",
  // conditions
  "blinded", "charmed", "deafened", "exhaustion", "frightened", "grappled",
  "incapacitated", "invisible", "paralyzed", "petrified", "poisoned", "prone",
  "restrained", "stunned", "unconscious", "bloodied",
  // damage types
  "acid", "bludgeoning", "cold", "fire", "force", "lightning", "necrotic",
  "piercing", "psychic", "radiant", "slashing", "thunder",
  // dice + actions
  "d4", "d6", "d8", "d10", "d12", "d20", "d100", "cantrip", "spell slot",
  "attack roll", "ability check", "skill check", "critical hit", "natural twenty",
];

// The base set = defaults ∪ any terms in <dataDir>/base-vocab.json (a JSON string
// array). Malformed/missing file → just the defaults. Deduped, order-preserving.
export function loadBaseVocab(): string[] {
  let extra: string[] = [];
  try {
    const file = path.join(CONFIG.dataDir, "base-vocab.json");
    if (fs.existsSync(file)) {
      const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
      if (Array.isArray(raw)) extra = raw.filter((t): t is string => typeof t === "string");
    }
  } catch {
    /* malformed override — fall back to defaults */
  }
  const set = new Set<string>();
  for (const t of [...DEFAULT_BASE_VOCAB, ...extra]) {
    const v = t.trim();
    if (v) set.add(v);
  }
  return Array.from(set);
}
