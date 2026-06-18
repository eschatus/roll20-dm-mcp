import { readFileSync, writeFileSync, existsSync, renameSync } from "fs";
import path from "path";
import { getActiveCampaign } from "./campaigns.js";

// Data dir is overridable via ROLL20_DATA_DIR so tests (and relocated installs)
// don't read/write the real ./data files.
const REGISTRY_PATH = path.resolve(process.env.ROLL20_DATA_DIR ?? "./data", "characters.json");

export interface CharacterEntry {
  roll20TokenId: string;
  ddbCharId: number;
  ddbCharacterUrl?: string;
}

// Top-level structure: { [campaignSlug]: { [characterName]: CharacterEntry } }
type FullRegistry = Record<string, Record<string, CharacterEntry>>;

function load(): FullRegistry {
  if (!existsSync(REGISTRY_PATH)) return {};
  const raw = readFileSync(REGISTRY_PATH, "utf-8");
  // An empty/whitespace file means a write is mid-flight or the file was never
  // finished — treat as "no registry yet" rather than crashing on JSON.parse("").
  // With save()'s atomic rename this window shouldn't occur, but stay defensive.
  if (raw.trim() === "") return {};
  return JSON.parse(raw) as FullRegistry;
}

function save(registry: FullRegistry): void {
  // Atomic write: plain writeFileSync truncates the file and then streams the new
  // contents, so a concurrent reader (parallel test workers, concurrent relay
  // calls) can observe an empty file and fail with "Unexpected end of JSON input".
  // Write to a per-process temp file, then rename over the target — rename is
  // atomic on the same filesystem, so readers always see a complete file.
  const tmp = `${REGISTRY_PATH}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(registry, null, 2), "utf-8");
  renameSync(tmp, REGISTRY_PATH);
}

function campaignSlug(): string {
  return getActiveCampaign().slug;
}

function getCampaignRegistry(full: FullRegistry): Record<string, CharacterEntry> {
  const slug = campaignSlug();
  if (!full[slug]) full[slug] = {};
  return full[slug];
}

export function register(
  name: string,
  roll20TokenId: string,
  ddbCharId: number,
  ddbCharacterUrl?: string
): void {
  const full = load();
  const reg = getCampaignRegistry(full);
  reg[name.toLowerCase()] = { roll20TokenId, ddbCharId, ...(ddbCharacterUrl ? { ddbCharacterUrl } : {}) };
  save(full);
}

/**
 * Resolve a character name to its registry key within one campaign's registry.
 * Pure: exact (case-insensitive) match first, then bidirectional substring
 * fuzzy match. Returns the matched key, or null. Exported for unit testing.
 */
export function resolveCharacterKey(
  name: string,
  reg: Record<string, CharacterEntry>
): string | null {
  const key = name.toLowerCase();
  if (reg[key]) return key;
  return Object.keys(reg).find((k) => k.includes(key) || key.includes(k)) ?? null;
}

export function lookup(name: string): CharacterEntry | null {
  const full = load();
  const reg = getCampaignRegistry(full);

  const matched = resolveCharacterKey(name, reg);
  return matched ? reg[matched] : null;
}

export function listAll(): Array<{ name: string } & CharacterEntry> {
  const full = load();
  const reg = getCampaignRegistry(full);
  return Object.entries(reg).map(([name, entry]) => ({ name, ...entry }));
}

export function remove(name: string): boolean {
  const full = load();
  const reg = getCampaignRegistry(full);
  const key = name.toLowerCase();
  if (!reg[key]) return false;
  delete reg[key];
  save(full);
  return true;
}
