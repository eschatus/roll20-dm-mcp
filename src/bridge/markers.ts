// Token-marker resolution — ported from mod-scripts/ai-relay.js so the RT transport can set
// condition/state markers directly (off chat). Keep in sync with the Mod's tables.
//
// Tiers: condition = true 5e condition · pseudo = well-known fixed icon · custom = hashed ad-hoc.

export const CONDITION_MARKERS: Record<string, string> = {
  dead: "Unconscious::4444317", unconscious: "Unconscious::4444317", poisoned: "Poisoned::4444329",
  blinded: "Blinded::4444318", charmed: "Charmed::4444320", deafened: "Deafened::4444321",
  frightened: "Feared::4444323", grappled: "Grappled::4444314", incapacitated: "Incapacitated::4444325",
  invisible: "Invisible::4444344", paralyzed: "Paralyzed::4444327", petrified: "Petrified::4444328",
  prone: "Prone::4444315", restrained: "Restrained::4444316", stunned: "Stunned::4444331",
  exhaustion: "Exhausted::4444322",
};

export const PSEUDO_MARKERS: Record<string, string> = {
  bloodied: "Wounded::4444333", wounded: "Wounded::4444333", concentrating: "Concentrating::4444313",
  concentration: "Concentrating::4444313", blessed: "Blessed::4444338", bless: "Blessed::4444338",
  bane: "Bane::4444349", baned: "Bane::4444349", hasted: "Hastened::4444343", hastened: "Hastened::4444343",
  haste: "Hastened::4444343", raging: "Rage::4444347", rage: "Rage::4444347", marked: "Marked::4444350",
  hidden: "Hidden::4444335", hiding: "Hidden::4444335", dodging: "Dodging::4444334", dodge: "Dodging::4444334",
  enlarged: "Enlarged::4444340", flying: "Flying::4444342", fly: "Flying::4444342", sleeping: "Sleeping::4444330",
  asleep: "Sleeping::4444330", burning: "Burning::4444319", surprised: "Suprised::4444332",
  disguised: "Disguised::4444339", featherfall: "Featherfall::4444341", mirrorimage: "MirrorImage::4444346",
  magicweapon: "MagicWeapon::4444345", buffed: "Buffed::4444336", drowning: "Drowning::4444352",
  afflicted: "Afflicted::4444348", cursed: "Afflicted::4444348", illusion: "Illusion::4444311",
  disarmed: "Disarmed::4444324", mute: "Mute::4444326", silenced: "Mute::4444326", dismembered: "Dismembered::4444312",
};

const AD_HOC_POOL = [
  "aura", "radioactive", "cobweb", "trophy", "grenade", "stopwatch", "snail", "spanner", "fishing-net",
  "padlock", "three-leaves", "fist", "tread", "back-pain", "bolt-shield", "white-tower", "frozen-orb",
  "rolling-bomb", "screaming", "sentry-gun", "all-for-one", "angel-outfit", "archery-target", "drink-me",
  "death-zone", "edge-crack", "fluffy-wing", "interdiction", "lightning-helix", "ninja-mask", "overdrive",
  "strong", "arrowed", "black-flag", "flying-flag", "chemical-bolt", "grab", "half-haze", "pummeled",
];

// Deterministic name → ad-hoc icon (FNV-ish), matching the Mod's hashToPool exactly.
function hashToPool(name: string): string {
  const s = String(name || "").toLowerCase();
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 16777619) >>> 0; }
  return AD_HOC_POOL[h % AD_HOC_POOL.length];
}

export type MarkerTier = "condition" | "pseudo" | "custom";
export interface ResolvedMarker { tag: string; tier: MarkerTier; key: string }

export function resolveMarkerForState(name: string): ResolvedMarker {
  const lc = String(name || "").toLowerCase().trim();
  if (CONDITION_MARKERS[lc]) return { tag: CONDITION_MARKERS[lc], tier: "condition", key: lc };
  if (PSEUDO_MARKERS[lc]) return { tag: PSEUDO_MARKERS[lc], tier: "pseudo", key: lc };
  return { tag: hashToPool(lc), tier: "custom", key: lc };
}
