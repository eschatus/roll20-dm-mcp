import { getPage } from "./browser.js";
import { ddbRtEnabled, rtGetRawCharacter, rtListCampaigns, rtGetCampaignCharacters } from "./ddb-rt.js";

const DDB_CHARACTER_SERVICE = "https://character-service.dndbeyond.com/character/v5";
const DDB_MONSTER_API = "https://www.dndbeyond.com/api/v5";

// Get the CobaltSession cookie from the logged-in DDB browser page and use it as a Bearer token,
// matching Avrae's auth approach (https://github.com/avrae/avrae).
async function getCobaltToken(): Promise<string> {
  const page = await getPage("ddb");
  const cookies = await page.context().cookies();
  const cobalt = cookies.find((c) => c.name === "CobaltSession" && c.domain.includes("dndbeyond"));
  if (!cobalt?.value) throw new Error("CobaltSession cookie not found — make sure you're logged into DnD Beyond");
  return cobalt.value;
}

async function ddbFetch<T>(url: string, options: { method?: string; body?: string } = {}): Promise<T> {
  const page = await getPage("ddb");
  const token = await getCobaltToken();

  const response = await page.request.fetch(url, {
    method: options.method ?? "GET",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`,
    },
    ...(options.body ? { data: options.body } : {}),
  });

  if (!response.ok()) {
    const text = await response.text();
    throw new Error(`DDB API ${response.status()} ${response.statusText()}: ${text}`);
  }

  return response.json() as Promise<T>;
}

export interface DdbCharacter {
  id: number;
  name: string;
  // HP fields as returned by character-service API (Avrae-compatible naming)
  baseHitPoints: number;        // hit dice sum only — Con modifier NOT included
  bonusHitPoints: number | null;
  overrideHitPoints: number | null;
  removedHitPoints: number;
  temporaryHitPoints: number;
  conditions: { id: number; level: number | null }[];
  avatarUrl: string | null;
  armorClass: number;
  passivePerception: number;
  // Present in raw API response — used to compute Con-modifier HP contribution
  classes: Array<{ level: number }>;
  stats: Array<{ id: number; value: number | null }>;  // id 3 = Constitution
}

export function getMaxHp(char: DdbCharacter): number {
  const totalLevel = (char.classes ?? []).reduce((s, c) => s + c.level, 0);
  const conScore = (char.stats ?? []).find(s => s.id === 3)?.value ?? 10;
  const conMod = Math.floor((conScore - 10) / 2);
  return char.overrideHitPoints ?? (char.baseHitPoints + (char.bonusHitPoints ?? 0) + conMod * totalLevel);
}

export function getCurrentHp(char: DdbCharacter): number {
  return getMaxHp(char) - char.removedHitPoints;
}

const DDB_CONDITION_NAMES: Record<number, string> = {
  1:"blinded", 2:"charmed", 3:"deafened", 4:"exhaustion", 5:"frightened",
  6:"grappled", 7:"incapacitated", 8:"invisible", 9:"paralyzed", 10:"petrified",
  11:"poisoned", 12:"prone", 13:"restrained", 14:"stunned", 15:"unconscious",
};

const ABILITY_IDS: Record<number, string> = { 1:"strength",2:"dexterity",3:"constitution",4:"intelligence",5:"wisdom",6:"charisma" };
const SKILL_TO_ABILITY: Record<string, number> = {
  "acrobatics":2,"animal-handling":5,"arcana":4,"athletics":1,"deception":6,
  "history":4,"insight":5,"intimidation":6,"investigation":4,"medicine":5,
  "nature":4,"perception":5,"performance":6,"persuasion":6,"religion":4,
  "sleight-of-hand":2,"stealth":2,"survival":5,
};

export interface DdbCharacterStats {
  name: string; level: number; classes: string; proficiencyBonus: number;
  abilityScores: Record<string, number>;
  abilityMods: Record<string, number>;
  savingThrows: Record<string, { bonus: number; proficient: boolean }>;
  skills: Record<string, { bonus: number; proficient: boolean; expertise: boolean }>;
  initiativeBonus: number; passivePerception: number; walkSpeed: number;
  armorClass: number;
  hp: { max: number; current: number; temp: number };
  conditions: string[];  // active condition names, lowercased
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function parseStats(raw: any): DdbCharacterStats {
  // Final ability scores: override > base + modifier bonuses
  const scores: Record<string, number> = {};
  for (const stat of (raw.stats ?? [])) {
    scores[ABILITY_IDS[stat.id as number]] = stat.value as number;
  }
  const overrides: Record<number, number | null> = {};
  for (const s of (raw.overrideStats ?? [])) overrides[s.id] = s.value;

  const allMods: { type: string; subType: string; value: number | null }[] =
    [...(raw.modifiers?.race ?? []), ...(raw.modifiers?.class ?? []),
     ...(raw.modifiers?.background ?? []), ...(raw.modifiers?.item ?? []),
     ...(raw.modifiers?.feat ?? []), ...(raw.modifiers?.condition ?? [])];

  const finalScores: Record<string, number> = {};
  for (const [idStr, ability] of Object.entries(ABILITY_IDS)) {
    const id = parseInt(idStr);
    if (overrides[id] != null) { finalScores[ability] = overrides[id]!; continue; }
    let score = scores[ability] ?? 10;
    for (const m of allMods) {
      if (m.type === "bonus" && m.subType === `${ability}-score` && m.value != null) score += m.value;
    }
    finalScores[ability] = score;
  }

  const abilityMods: Record<string, number> = {};
  for (const [a, s] of Object.entries(finalScores)) abilityMods[a] = Math.floor((s - 10) / 2);

  const totalLevel = (raw.classes ?? []).reduce((sum: number, c: { level: number }) => sum + c.level, 0);
  const pb = Math.floor((Math.max(totalLevel, 1) - 1) / 4) + 2;

  const profSet = new Set<string>(), expertSet = new Set<string>(), halfSet = new Set<string>();
  for (const m of allMods) {
    if (m.subType) {
      if (m.type === "proficiency") profSet.add(m.subType);
      else if (m.type === "expertise") expertSet.add(m.subType);
      else if (m.type === "half-proficiency") halfSet.add(m.subType);
    }
  }

  const savingThrows: Record<string, { bonus: number; proficient: boolean }> = {};
  for (const ability of Object.values(ABILITY_IDS)) {
    const prof = profSet.has(`${ability}-saving-throws`);
    savingThrows[ability] = { bonus: abilityMods[ability] + (prof ? pb : 0), proficient: prof };
  }

  const skills: Record<string, { bonus: number; proficient: boolean; expertise: boolean }> = {};
  for (const [skill, abilityId] of Object.entries(SKILL_TO_ABILITY)) {
    const ability = ABILITY_IDS[abilityId];
    const prof = profSet.has(skill), exp = expertSet.has(skill), half = halfSet.has(skill);
    const bonus = abilityMods[ability] + (exp ? pb * 2 : prof ? pb : half ? Math.floor(pb / 2) : 0);
    skills[skill] = { bonus, proficient: prof, expertise: exp };
  }

  let initiativeBonus = abilityMods["dexterity"];
  for (const m of allMods) {
    if (m.type === "bonus" && m.subType === "initiative" && m.value != null) initiativeBonus += m.value;
  }

  const percBonus = skills["perception"]?.bonus ?? abilityMods["wisdom"];
  const walkSpeed = raw.race?.weightSpeeds?.normal?.walk ?? 30;
  const conMod = abilityMods["constitution"] ?? 0;
  const maxHp = raw.overrideHitPoints ?? ((raw.baseHitPoints ?? 0) + (raw.bonusHitPoints ?? 0) + conMod * totalLevel);

  return {
    name: raw.name as string,
    level: totalLevel,
    classes: (raw.classes ?? []).map((c: { level: number; definition: { name: string } }) => `${c.definition?.name ?? "?"}${c.level}`).join(" / "),
    proficiencyBonus: pb,
    abilityScores: finalScores,
    abilityMods,
    savingThrows,
    skills,
    initiativeBonus,
    passivePerception: 10 + percBonus,
    walkSpeed,
    armorClass: raw.armorClass ?? 10,
    hp: { max: maxHp, current: maxHp - (raw.removedHitPoints ?? 0), temp: raw.temporaryHitPoints ?? 0 },
    conditions: (raw.conditions ?? [])
      .map((c: { id: number }) => DDB_CONDITION_NAMES[c.id])
      .filter(Boolean),
  };
}

export async function getCharacterStats(ddbCharId: number): Promise<DdbCharacterStats> {
  const raw = await getRawCharacter(ddbCharId);
  return parseStats(raw);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function getRawCharacter(ddbCharId: number): Promise<any> {
  if (ddbRtEnabled()) return rtGetRawCharacter(ddbCharId);
  const data = await ddbFetch<{ data: unknown }>(`${DDB_CHARACTER_SERVICE}/character/${ddbCharId}`);
  return data.data;
}

export async function getCharacter(ddbCharId: number): Promise<DdbCharacter> {
  if (ddbRtEnabled()) return rtGetRawCharacter(ddbCharId) as Promise<DdbCharacter>;

  // Try direct API first (works for own characters and public sheets).
  // Fall back to browser page interception for DM-accessible sheets that reject direct API auth.
  try {
    const data = await ddbFetch<{ data: DdbCharacter }>(`${DDB_CHARACTER_SERVICE}/character/${ddbCharId}`);
    return data.data;
  } catch (err) {
    if (!String(err).includes("403")) throw err;
  }

  const page = await getPage("ddb");
  const responsePromise = page.waitForResponse(
    (resp) => resp.url().includes(`/character/${ddbCharId}`) && resp.request().method() === "GET" && resp.status() === 200,
    { timeout: 20_000 }
  );
  await page.goto(`https://www.dndbeyond.com/characters/${ddbCharId}`, { waitUntil: "domcontentloaded", timeout: 20_000 });
  const response = await responsePromise;
  const json = await response.json() as { data: DdbCharacter };
  return json.data;
}

export interface DdbCampaignCharacter {
  id: number;
  characterName: string;
  characterAvatarUrl: string | null;
}

export async function getCampaignCharacters(campaignId: string): Promise<DdbCampaignCharacter[]> {
  if (ddbRtEnabled()) return rtGetCampaignCharacters(campaignId);

  const page = await getPage("ddb");
  await page.goto(`https://www.dndbeyond.com/campaigns/${campaignId}`, { waitUntil: "networkidle", timeout: 30_000 });
  return page.evaluate(() => {
    const results: { id: number; characterName: string; characterAvatarUrl: string | null }[] = [];
    document.querySelectorAll("a[href*='/characters/']").forEach((el) => {
      const href = (el as HTMLAnchorElement).href;
      const match = href.match(/\/characters\/(\d+)/);
      if (!match) return;
      const id = parseInt(match[1]);
      if (results.some((r) => r.id === id)) return;
      const nameEl = el.querySelector("[class*='name'], [class*='title'], h2, h3, span");
      const img = el.querySelector("img");
      results.push({ id, characterName: nameEl?.textContent?.trim() || el.textContent?.trim() || `Character ${id}`, characterAvatarUrl: img?.src ?? null });
    });
    return results;
  });
}

export async function listCampaigns(): Promise<{ id: string; name: string }[]> {
  if (ddbRtEnabled()) return rtListCampaigns();

  const page = await getPage("ddb");
  await page.goto("https://www.dndbeyond.com/my-campaigns", { waitUntil: "networkidle", timeout: 30_000 });
  return page.evaluate(() => {
    const campaigns: { id: string; name: string; playerCount: number }[] = [];
    document.querySelectorAll(".ddb-campaigns-list-item").forEach((card) => {
      const link = card.querySelector<HTMLAnchorElement>("a.ddb-campaigns-list-item-footer-buttons-item[href*='/campaigns/']");
      if (!link) return;
      const match = link.href.match(/\/campaigns\/(\d+)/);
      if (!match) return;
      const id = match[1];
      if (campaigns.some((c) => c.id === id)) return;
      const name = card.querySelector(".ddb-campaigns-list-item-body-title")?.textContent?.trim() ?? `Campaign ${id}`;
      const playerCount = parseInt(card.querySelector(".player-count .count")?.textContent?.trim() ?? "0");
      campaigns.push({ id, name, playerCount });
    });
    return campaigns;
  });
}

export interface DdbMonsterAbility {
  name: string;
  description: string;
}

export interface DdbMonsterSpeed {
  walk?: number;
  fly?: number;
  swim?: number;
  burrow?: number;
  climb?: number;
  canHover?: boolean;
}

export interface DdbMonster {
  id: number;
  name: string;
  averageHitPoints: number;
  armorClass: number;
  challengeRating: string;
  largeAvatarUrl: string | null;
  stats?: Array<{ id: number; value: number | null }>;  // id 1-6: STR DEX CON INT WIS CHA
  speed?: DdbMonsterSpeed;
  alignment?: string;
  size?: string;
  specialTraits?: DdbMonsterAbility[];
  actions?: DdbMonsterAbility[];
  reactions?: DdbMonsterAbility[];
  legendaryActions?: DdbMonsterAbility[];
  bonusActions?: DdbMonsterAbility[];
  damageImmunities?: string[];
  damageResistances?: string[];
  conditionImmunities?: string[];
}

export async function getMonster(nameOrId: string | number): Promise<DdbMonster> {
  const endpoint =
    typeof nameOrId === "number"
      ? `${DDB_MONSTER_API}/monster/${nameOrId}`
      : `${DDB_MONSTER_API}/monster?name=${encodeURIComponent(String(nameOrId))}`;

  const data = await ddbFetch<{ data: DdbMonster | DdbMonster[] }>(endpoint);
  const monster = Array.isArray(data.data) ? data.data[0] : data.data;
  if (!monster) throw new Error(`Monster not found: ${nameOrId}`);
  return monster;
}

export function getMonsterAbilityScores(monster: DdbMonster): Record<string, number> {
  const scores: Record<string, number> = { strength:10, dexterity:10, constitution:10, intelligence:10, wisdom:10, charisma:10 };
  for (const stat of (monster.stats ?? [])) {
    const ability = ABILITY_IDS[stat.id];
    if (ability && stat.value != null) scores[ability] = stat.value;
  }
  return scores;
}

export function getMonsterAbilities(monster: DdbMonster): string {
  const lines: string[] = [];

  if (monster.speed) {
    const parts: string[] = [];
    if (monster.speed.walk) parts.push(`${monster.speed.walk}ft walk`);
    if (monster.speed.fly) parts.push(`${monster.speed.fly}ft fly${monster.speed.canHover ? " (hover)" : ""}`);
    if (monster.speed.swim) parts.push(`${monster.speed.swim}ft swim`);
    if (monster.speed.burrow) parts.push(`${monster.speed.burrow}ft burrow`);
    if (monster.speed.climb) parts.push(`${monster.speed.climb}ft climb`);
    if (parts.length > 0) lines.push(`Speed: ${parts.join(", ")}`);
  }

  if (monster.alignment) lines.push(`Alignment: ${monster.alignment}`);

  const formatAbilities = (label: string, items: DdbMonsterAbility[] | undefined) => {
    if (!items || items.length === 0) return;
    lines.push(`${label}:`);
    for (const item of items) {
      lines.push(`  ${item.name}: ${item.description}`);
    }
  };

  formatAbilities("Special Traits", monster.specialTraits);
  formatAbilities("Actions", monster.actions);
  formatAbilities("Bonus Actions", monster.bonusActions);
  formatAbilities("Reactions", monster.reactions);
  formatAbilities("Legendary Actions", monster.legendaryActions);

  const resistances: string[] = [];
  if (monster.damageImmunities?.length) resistances.push(`Immune: ${monster.damageImmunities.join(", ")}`);
  if (monster.damageResistances?.length) resistances.push(`Resistant: ${monster.damageResistances.join(", ")}`);
  if (monster.conditionImmunities?.length) resistances.push(`Condition immune: ${monster.conditionImmunities.join(", ")}`);
  if (resistances.length > 0) lines.push(resistances.join("  "));

  return lines.join("\n");
}

// D&D Beyond is READ-ONLY in this integration. All write paths (HP patch,
// condition apply/remove) have been removed; HP and condition mutations happen
// on the Roll20 side only.
