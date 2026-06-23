// One-page deep probe: where does this page's line-of-sight geometry actually live?
// Dumps path/pathv2 objects by layer, plus door/window counts and a few endpoint samples.
// Read-only. Run: tsx src/recon/page-probe.ts <pageId> [--campaign slug]
process.env.ROLL20_TRANSPORT ??= "rt";

import { pathToFileURL } from "url";
import { relayCommand } from "../bridge/roll20.js";
import { rtGet } from "../bridge/roll20-rt.js";
import { setActiveCampaign } from "../registry/campaigns.js";

const r = <T>(cmd: Record<string, unknown>) => relayCommand<T>(cmd);

async function main(): Promise<number> {
  const ci = process.argv.indexOf("--campaign");
  if (ci >= 0) setActiveCampaign(process.argv[ci + 1]!);
  const pageId = process.argv[2];
  if (!pageId || pageId.startsWith("--")) { console.error("usage: tsx src/recon/page-probe.ts <pageId> [--campaign slug]"); return 0; }

  // All paths on the page, every layer (getPaths without a layer filter), WITH geometry.
  const paths = await r<{ id: string; layer?: string; left?: number; top?: number; width?: number; height?: number; rotation?: number; path?: string }[]>({ action: "getPaths", pageId, includePath: true });
  const byLayer: Record<string, number> = {};
  for (const p of paths) byLayer[p.layer ?? "(none)"] = (byLayer[p.layer ?? "(none)"] ?? 0) + 1;
  console.error(`\n[page-probe] ${pageId}`);
  console.error(`getPaths: ${paths.length} path objects by layer: ${JSON.stringify(byLayer)}`);
  for (const p of paths.slice(0, 3)) {
    console.error(`  path ${p.id} layer=${p.layer} left=${p.left} top=${p.top} w=${p.width} h=${p.height} rot=${p.rotation}`);
    console.error(`    data=${(p.path ?? "").slice(0, 200)}`);
  }

  const walls = await r<{ kind: string }[]>({ action: "getWalls", pageId, includePoints: true });
  console.error(`getWalls: ${walls.length} (pathv2=${walls.filter(w => w.kind === "pathv2").length}, path=${walls.filter(w => w.kind === "path").length})`);

  // Direct RTDB read — bypass the Mod entirely.
  try {
    const rtPaths = await rtGet<Record<string, any>>(`paths/page/${pageId}`);
    const entries = Object.entries(rtPaths ?? {});
    console.error(`\nrtGet paths/page: ${entries.length} entries (direct RTDB, no Mod)`);
    for (const [id, p] of entries.slice(0, 3)) {
      console.error(`  ${id} layer=${p?.layer} left=${p?.left} top=${p?.top} w=${p?.width} h=${p?.height} rot=${p?.rotation}`);
      console.error(`    path=${JSON.stringify(p?.path)?.slice(0, 200)}`);
    }
  } catch (err) {
    console.error(`\nrtGet paths/page FAILED: ${String(err).slice(0, 120)}`);
  }

  // Graphics on the page — what's on the map layer, and is the imgsrc fetchable?
  const toks = await r<{ id: string; layer?: string; width?: number; height?: number; imgsrc?: string }[]>({ action: "getTokens", pageId });
  const withImg = toks.filter(t => t.imgsrc).sort((a, b) => ((b.width ?? 0) * (b.height ?? 0)) - ((a.width ?? 0) * (a.height ?? 0)));
  console.error(`\ngetTokens: ${toks.length} graphics, ${withImg.length} with imgsrc`);
  for (const t of withImg.slice(0, 5)) console.error(`  layer=${t.layer} ${t.width}x${t.height}  ${t.imgsrc}`);
  if (withImg[0]?.imgsrc) {
    const url = withImg[0].imgsrc;
    for (const u of [url, url.replace(/\/(thumb|med|min|max|original)\./, "/max.")]) {
      try { const resp = await fetch(u, { headers: { "User-Agent": "Mozilla/5.0", Referer: "https://app.roll20.net/" } }); console.error(`  fetch ${resp.status} ${resp.headers.get("content-type")}  ${u.slice(0, 90)}`); }
      catch (e) { console.error(`  fetch ERR ${String(e).slice(0, 60)}  ${u.slice(0, 90)}`); }
    }
  }

  const od = await r<{ doors: any[]; windows: any[] }>({ action: "getDoors", pageId });
  console.error(`getDoors: ${od.doors?.length ?? 0} doors, ${od.windows?.length ?? 0} windows`);
  const sample = (od.windows ?? []).slice(0, 3).concat((od.doors ?? []).slice(0, 2));
  for (const s of sample) {
    console.error(`  ${s.type}  x=${s.x} y=${s.y}  h0=(${s.handle0?.x},${s.handle0?.y})  h1=(${s.handle1?.x},${s.handle1?.y})  secret=${s.isSecret}`);
  }
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(n => process.exit(n)).catch(e => { console.error("❌ probe crashed:", e); process.exit(1); });
}
