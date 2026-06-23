// Classify every page of the active campaign by (wall count) × (image source), reading
// straight from the RTDB. Image source decides if pixels are fetchable:
//   files.d20.io/images/…       → user-uploaded, PUBLIC (fetchable)
//   files.d20.io/marketplace/…  → purchased module art, GATED (403 — needs screenshot/PDF)
// Read-only. Run: tsx src/recon/map-source-audit.ts [--campaign slug]
process.env.ROLL20_TRANSPORT ??= "rt";

import { pathToFileURL } from "url";
import { relayCommand } from "../bridge/roll20.js";
import { rtGet } from "../bridge/roll20-rt.js";
import { getActiveCampaign, setActiveCampaign } from "../registry/campaigns.js";

const r = <T>(cmd: Record<string, unknown>) => relayCommand<T>(cmd);
interface PageInfo { id: string; name: string; width: number; height: number }
interface RtPath { layer?: string; path?: string }
interface RtGraphic { layer?: string; imgsrc?: string; width?: number; height?: number }

function sourceClass(imgsrc?: string): "uploaded" | "marketplace" | "external" | "none" {
  if (!imgsrc) return "none";
  if (/files\.d20\.io\/images\//.test(imgsrc)) return "uploaded";
  if (/files\.d20\.io\/marketplace\//.test(imgsrc)) return "marketplace";
  return "external";
}

async function main(): Promise<number> {
  const ci = process.argv.indexOf("--campaign");
  if (ci >= 0) setActiveCampaign(process.argv[ci + 1]!);
  const campaign = getActiveCampaign();
  console.error(`\n[map-source-audit] ${campaign.name} (${campaign.roll20CampaignId})\n`);

  const pages = await r<PageInfo[]>({ action: "listPages" });
  const rows: { name: string; pageId: string; walls: number; cls: string; size: string }[] = [];
  for (const p of pages) {
    try {
      const paths = await rtGet<Record<string, RtPath>>(`paths/page/${p.id}`);
      const walls = Object.values(paths ?? {}).filter(x => x.layer === "walls" && x.path).length;
      const graphics = await rtGet<Record<string, RtGraphic>>(`graphics/page/${p.id}`);
      const map = Object.values(graphics ?? {})
        .filter(g => g.imgsrc && (g.layer === "map" || g.layer === undefined))
        .sort((a, b) => ((b.width ?? 0) * (b.height ?? 0)) - ((a.width ?? 0) * (a.height ?? 0)))[0];
      rows.push({ name: p.name, pageId: p.id, walls, cls: sourceClass(map?.imgsrc), size: map ? `${Math.round(map.width ?? 0)}x${Math.round(map.height ?? 0)}` : "-" });
    } catch (err) { console.error(`  ✗ ${p.name} — ${String(err).slice(0, 80)}`); }
  }

  const walled = rows.filter(r => r.walls > 0).sort((a, b) => b.walls - a.walls);
  console.error("walled pages (walls | image-source | size — name [pageId]):");
  for (const r of walled) console.error(`  ${String(r.walls).padStart(4)} | ${r.cls.padEnd(11)} | ${r.size.padStart(11)} — ${r.name}  [${r.pageId}]`);

  const by = (cls: string) => walled.filter(r => r.cls === cls);
  console.error(`\nwalled pages: ${walled.length} | uploaded(fetchable)=${by("uploaded").length} marketplace(gated)=${by("marketplace").length} external=${by("external").length} none=${by("none").length}`);
  const firstUploaded = by("uploaded")[0];
  if (firstUploaded) console.error(`\n→ verification candidate (fetchable + walls): ${firstUploaded.name}  --page ${firstUploaded.pageId}`);
  return walled.length;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(n => process.exit(n > 0 ? 0 : 1)).catch(e => { console.error("❌ audit crashed:", e); process.exit(1); });
}
