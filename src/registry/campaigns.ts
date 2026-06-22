import { readFileSync, writeFileSync, existsSync, renameSync } from "fs";
import { dataPath } from "../dataDir.js";

// Atomic write: rename over the target so a concurrent reader never observes the
// truncated window that plain writeFileSync opens (→ "Unexpected end of JSON input").
function atomicWrite(filePath: string, contents: string): void {
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, contents, "utf-8");
  renameSync(tmp, filePath);
}

// Data dir resolved by ../dataDir (ROLL20_DATA_DIR override; default ./data) so the
// per-user / relocated-install location is defined in exactly one place.
const CAMPAIGNS_PATH = dataPath("campaigns.json");
const ACTIVE_CAMPAIGN_PATH = dataPath("active-campaign.json");

export interface CampaignEntry {
  name: string;
  roll20CampaignId: string;
  ddbCampaignId: string;
  notes?: string;
}

type CampaignStore = Record<string, CampaignEntry>; // key = slug e.g. "curse-of-strahd"

let _activeCampaignSlug: string | null = null;

// Restore last active campaign from disk so restarts don't require switch_campaign
(function restoreActiveCampaign() {
  if (!existsSync(ACTIVE_CAMPAIGN_PATH)) return;
  try {
    const { slug } = JSON.parse(readFileSync(ACTIVE_CAMPAIGN_PATH, "utf-8")) as { slug: string };
    const store = load();
    if (slug && store[slug]) _activeCampaignSlug = slug;
  } catch { /* corrupt file — start fresh */ }
})();

function load(): CampaignStore {
  if (!existsSync(CAMPAIGNS_PATH)) return {};
  const raw = readFileSync(CAMPAIGNS_PATH, "utf-8");
  if (raw.trim() === "") return {}; // mid-write / never-finished → no campaigns yet
  return JSON.parse(raw) as CampaignStore;
}

function save(store: CampaignStore): void {
  atomicWrite(CAMPAIGNS_PATH, JSON.stringify(store, null, 2));
}

export function toSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export function registerCampaign(
  name: string,
  roll20CampaignId: string,
  ddbCampaignId: string,
  notes?: string
): string {
  const store = load();
  const slug = toSlug(name);
  store[slug] = { name, roll20CampaignId, ddbCampaignId, ...(notes ? { notes } : {}) };
  save(store);
  return slug;
}

/**
 * Resolve a user-supplied slug-or-name to a registered campaign slug.
 * Pure function: exact slug match first, then fuzzy match on slug overlap or
 * name substring. Returns the resolved slug, or null if nothing matches.
 * Exported for unit testing.
 */
export function resolveCampaignSlug(
  slugOrName: string,
  store: CampaignStore
): string | null {
  if (store[slugOrName]) return slugOrName;

  const lower = slugOrName.toLowerCase();
  return (
    Object.keys(store).find(
      (k) => k.includes(toSlug(lower)) || toSlug(lower).includes(k) || store[k].name.toLowerCase().includes(lower)
    ) ?? null
  );
}

export function setActiveCampaign(slugOrName: string): CampaignEntry {
  const store = load();

  // Try exact slug match first, then fuzzy on name
  const resolved = resolveCampaignSlug(slugOrName, store);

  if (!resolved) {
    const available = Object.keys(store).join(", ") || "(none registered)";
    throw new Error(`Campaign not found: "${slugOrName}". Available: ${available}`);
  }

  _activeCampaignSlug = resolved;
  atomicWrite(ACTIVE_CAMPAIGN_PATH, JSON.stringify({ slug: resolved }, null, 2));
  return store[resolved];
}

export function getActiveCampaign(): CampaignEntry & { slug: string } {
  // Fall back to env vars if no campaign set — supports single-campaign setups
  if (!_activeCampaignSlug) {
    const roll20Id = process.env.ROLL20_CAMPAIGN_ID;
    const ddbId = process.env.DDB_CAMPAIGN_ID;
    if (roll20Id && ddbId) {
      return {
        slug: "env-default",
        name: "Default (from .env)",
        roll20CampaignId: roll20Id,
        ddbCampaignId: ddbId,
      };
    }
    throw new Error(
      "No active campaign set. Use switch_campaign or set ROLL20_CAMPAIGN_ID / DDB_CAMPAIGN_ID in .env"
    );
  }

  const store = load();
  const entry = store[_activeCampaignSlug];
  if (!entry) throw new Error(`Active campaign slug "${_activeCampaignSlug}" not found in registry`);
  return { slug: _activeCampaignSlug, ...entry };
}

export function listCampaigns(): Array<{ slug: string; active: boolean } & CampaignEntry> {
  const store = load();
  return Object.entries(store).map(([slug, entry]) => ({
    slug,
    active: slug === _activeCampaignSlug,
    ...entry,
  }));
}

export function removeCampaign(slugOrName: string): boolean {
  const store = load();
  const slug = store[slugOrName] ? slugOrName : toSlug(slugOrName);
  if (!store[slug]) return false;
  delete store[slug];
  if (_activeCampaignSlug === slug) _activeCampaignSlug = null;
  save(store);
  return true;
}
