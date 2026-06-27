// Fast RTDB-only wall census: for each campaign, count walled pages + total wall objects (no
// browser navigation, no capture). Decides which campaigns have hand-placed walls worth harvesting.
// Args: "<roll20Id>:<Name>" pairs. tsx src/recon/wall-census.ts 9389015:Barbers 8358322:Trust ...
process.env.ROLL20_TRANSPORT ??= "rt";
import { rtGet } from "../bridge/roll20-rt.js";
import { registerCampaign, setActiveCampaign, toSlug } from "../registry/campaigns.js";

for (const arg of process.argv.slice(2)) {
  const [id, ...nameParts] = arg.split(":");
  const name = nameParts.join(":") || `census-${id}`;
  const slug = registerCampaign(name, id, "0", "census candidate");
  setActiveCampaign(slug);
  try {
    const pagesObj = await rtGet<Record<string, { id: string; name: string }>>("pages");
    const pages = Object.values(pagesObj ?? {});
    let walled = 0, totalWalls = 0;
    for (const p of pages) {
      const paths = await rtGet<Record<string, { layer?: string; path?: string; shape?: string; points?: unknown }>>(`paths/page/${p.id}`).catch(() => ({}));
      const w = Object.values(paths ?? {}).filter(x => x.layer === "walls" && (x.path || (x.shape === "pol" && x.points))).length;
      if (w > 0) { walled++; totalWalls += w; }
    }
    console.error(`CENSUS ${id} "${name}": ${pages.length} pages, ${walled} walled, ${totalWalls} total walls`);
  } catch (e) {
    console.error(`CENSUS ${id} "${name}": ERROR ${String(e).slice(0, 100)}`);
  }
}
process.exit(0);
