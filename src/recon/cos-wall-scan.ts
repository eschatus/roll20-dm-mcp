// Read-only wall-count scan of the ACTIVE campaign's pages. No harvest, no image capture, no writes.
// Mirrors harvest-walls.ts's two wall sources: legacy DL `path` objects (RTDB paths/page/<id>,
// layer==="walls") + UDL pathv2 (getWalls). Prints per-page counts and writes a JSON join file.
//   tsx src/recon/cos-wall-scan.ts
process.env.ROLL20_TRANSPORT ??= "rt";

import { writeFileSync } from "fs";
import { relayCommand } from "../bridge/roll20.js";
import { rtGet } from "../bridge/roll20-rt.js";
import { getActiveCampaign } from "../registry/campaigns.js";
import { dataPath } from "../dataDir.js";

interface PageInfo { id: string; name: string; width?: number; height?: number }
interface RtPath { layer?: string; path?: string }
interface Pathv2Wall { id: string; kind: string }

const r = <T>(cmd: Record<string, unknown>) => relayCommand<T>(cmd);

(async () => {
  const camp = getActiveCampaign();
  console.error(`scanning campaign: ${camp?.slug ?? "?"} (${camp?.roll20CampaignId ?? "?"})`);
  const pages = (await r<PageInfo[]>({ action: "listPages" })) ?? [];
  console.error(`${pages.length} pages`);

  const out: { id: string; name: string; legacy: number; pathv2: number; total: number; w?: number; h?: number }[] = [];
  for (const p of pages) {
    let legacy = 0, v2 = 0;
    try {
      const rtPaths = await rtGet<Record<string, RtPath>>(`paths/page/${p.id}`);
      legacy = Object.values(rtPaths ?? {}).filter(x => x.layer === "walls" && x.path).length;
    } catch { /* page may have no paths node */ }
    try {
      const ws = (await r<Pathv2Wall[]>({ action: "getWalls", pageId: p.id })) ?? [];
      v2 = ws.filter(w => w.kind === "pathv2").length;
    } catch { /* no UDL */ }
    const total = legacy + v2;
    out.push({ id: p.id, name: p.name, legacy, pathv2: v2, total, w: p.width, h: p.height });
    process.stderr.write(`  ${total > 0 ? "✓" : "·"} ${String(total).padStart(4)}  ${p.name}\n`);
  }

  const lined = out.filter(v => v.total > 0).length;
  console.error(`\n${lined}/${pages.length} pages have walls`);
  const fp = dataPath("wall-dataset", "cos-wall-scan.json");
  writeFileSync(fp, JSON.stringify(out, null, 1));
  console.error(`wrote ${fp}`);
})();
