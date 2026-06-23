// Diagnostic: what DL wall objects actually exist on each page of the active campaign?
// Answers "are walls pathv2 (UDL, harvestable) or legacy path (geometry not returned by
// getWalls), or absent?" — read-only. Run: tsx src/recon/wall-audit.ts [--campaign slug]
process.env.ROLL20_TRANSPORT ??= "rt";

import { pathToFileURL } from "url";
import { relayCommand } from "../bridge/roll20.js";
import { getActiveCampaign, setActiveCampaign } from "../registry/campaigns.js";

const r = <T>(cmd: Record<string, unknown>) => relayCommand<T>(cmd);

interface PageInfo { id: string; name: string; width: number; height: number }
interface DebugSummary { [type: string]: { count: number; sample?: { layer?: string; barrierType?: string; shape?: string }[] } }

async function main(): Promise<number> {
  const ci = process.argv.indexOf("--campaign");
  if (ci >= 0) setActiveCampaign(process.argv[ci + 1]!);
  const campaign = getActiveCampaign();
  console.error(`\n[wall-audit] ${campaign.name} (${campaign.roll20CampaignId})\n`);

  const pages = await r<PageInfo[]>({ action: "listPages" });
  const rows: { name: string; pageId: string; pathv2: number; pathWallLayer: number; pathOther: number; doors: number; windows: number }[] = [];

  for (const p of pages) {
    try {
      const dbg = await r<DebugSummary>({ action: "debugPage", pageId: p.id });
      // debugPage samples include layer; count path objects on the walls layer vs elsewhere.
      const walls = await r<{ kind: string }[]>({ action: "getWalls", pageId: p.id });
      const pathv2 = walls.filter(w => w.kind === "pathv2").length;
      const pathWall = walls.filter(w => w.kind === "path").length;
      rows.push({
        name: p.name, pageId: p.id,
        pathv2,
        pathWallLayer: pathWall,
        pathOther: (dbg.path?.count ?? 0) - pathWall,
        doors: dbg.door?.count ?? 0,
        windows: dbg.window?.count ?? 0,
      });
    } catch (err) {
      console.error(`  ✗ ${p.name} — ${String(err).slice(0, 100)}`);
    }
  }

  // Print only pages that have ANY wall-ish objects, then a summary.
  const walled = rows.filter(r => r.pathv2 || r.pathWallLayer || r.doors || r.windows);
  console.error("pages with wall/door/window objects:");
  for (const r of walled.sort((a, b) => (b.pathv2 + b.pathWallLayer) - (a.pathv2 + a.pathWallLayer))) {
    console.error(`  ${r.pathv2.toString().padStart(4)} pathv2 | ${r.pathWallLayer.toString().padStart(4)} path(walls) | ${r.doors}d ${r.windows}w  — ${r.name}  [${r.pageId}]`);
  }
  const tot = (k: keyof typeof rows[0]) => rows.reduce((s, r) => s + (r[k] as number), 0);
  console.error(`\n[wall-audit] ${pages.length} pages | totals: pathv2=${tot("pathv2")} path(walls)=${tot("pathWallLayer")} doors=${tot("doors")} windows=${tot("windows")} | ${walled.length} pages have any`);
  return walled.length;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(n => process.exit(n > 0 ? 0 : 1)).catch(e => { console.error("❌ audit crashed:", e); process.exit(1); });
}
