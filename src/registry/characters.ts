import { readFileSync, writeFileSync, existsSync, renameSync } from "fs";
import { dataPath } from "../dataDir.js";
import { getActiveCampaign } from "./campaigns.js";

// Data dir resolved by ../dataDir (ROLL20_DATA_DIR override; default ./data).
const REGISTRY_PATH = dataPath("characters.json");

export interface CharacterEntry {
  roll20TokenId?: string;
  ddbCharId?: number;
  ddbCharacterUrl?: string;
  // Per-token override (issue #132): true for a player-controlled token whose
  // HP nonetheless lives in Roll20 bar1 and who dies like an NPC (Tua, Salros
  // Eventide, Amri in the Firebirds campaign) — `controlledby` alone can't
  // tell a sidekick from a true PC. Settable via set_token_class (voice: "Tua
  // is a sidekick"); read by isPcToken/splitPcNpc wherever HP/death routing
  // decides (update_token_hp, update_hp_many, resolve_aoe, roll_initiative).
  sidekick?: boolean;
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
  const key = name.toLowerCase();
  // Merge over any existing entry (e.g. a prior set_token_class sidekick
  // override) rather than overwriting it — re-registering a character (token
  // recreate, DDB relink) must not silently un-flag a sidekick.
  const existing = reg[key];
  reg[key] = { ...existing, roll20TokenId, ddbCharId, ...(ddbCharacterUrl ? { ddbCharacterUrl } : {}) };
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

/**
 * Set (or clear) the sidekick override for a character/token name. Upserts a
 * minimal registry entry when the name isn't registered yet — a sidekick can
 * be flagged by voice ("Tua is a sidekick") before any DDB/token registration
 * exists. Resolves against existing keys fuzzily (resolveCharacterKey) first
 * so this doesn't create a duplicate entry for an already-registered name.
 */
export function setSidekick(name: string, sidekick: boolean): CharacterEntry {
  const full = load();
  const reg = getCampaignRegistry(full);
  const key = resolveCharacterKey(name, reg) ?? name.toLowerCase();
  const existing = reg[key] ?? {};
  reg[key] = { ...existing, sidekick };
  save(full);
  return reg[key];
}

/** True iff `name` resolves to a registry entry flagged sidekick:true. */
export function isSidekick(name: string): boolean {
  const full = load();
  const reg = getCampaignRegistry(full);
  const key = resolveCharacterKey(name, reg);
  return key ? !!reg[key].sidekick : false;
}

/**
 * The active campaign's sidekick names (registry keys, already lowercased) —
 * the set aoe.ts's classifyToken/isPcToken/splitPcNpc need to route a
 * player-controlled token as a sidekick instead of a PC.
 */
export function listSidekickNames(): Set<string> {
  const full = load();
  const reg = getCampaignRegistry(full);
  return new Set(Object.entries(reg).filter(([, e]) => e.sidekick).map(([key]) => key));
}
