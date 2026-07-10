// Disk-only QC scan of the harvested corpus: flag likely-BS records — AI test-artifact names,
// trivially-walled pages, and the legacy-vs-pathv2 split (pathv2 on uploaded art was the tell for
// AI-generated walls). No browser. tsx src/recon/qc-scan.ts
import { readdirSync, readFileSync, existsSync } from "fs";
import path from "path";
import { dataDir } from "../dataDir.js";

const raw = path.join(dataDir(), "wall-dataset", "raw");
const TEST_NAME = /\btest\b|clank|copy|scratch|tmp|temp|\bwrong\b|singlepass|perimeter\d|screenshot|^p\d+ -|delete|asdf|untitled|new page/i;

interface Row { campaign: string; name: string; walls: number; segs: number; len: number; cells: number; type: string; suspicious: string[] }
const rows: Row[] = [];

for (const camp of readdirSync(raw)) {
  const dir = path.join(raw, camp);
  let files: string[]; try { files = readdirSync(dir).filter(f => f.endsWith(".json") && f !== "_manifest.json"); } catch { continue; }
  for (const f of files) {
    let rec: any; try { rec = JSON.parse(readFileSync(path.join(dir, f), "utf-8")); } catch { continue; }
    const flags: string[] = rec.flags ?? [];
    const legacy = flags.find((x: string) => x.startsWith("legacy:")) ? parseInt(flags.find((x: string) => x.startsWith("legacy:"))!.split(":")[1]) : 0;
    const pathv2 = flags.find((x: string) => x.startsWith("pathv2:")) ? parseInt(flags.find((x: string) => x.startsWith("pathv2:"))!.split(":")[1]) : 0;
    const type = legacy && pathv2 ? "mixed" : pathv2 ? "pathv2" : "legacy";
    // Measure actual wall content: segments (points-1 per polyline) + total length in image px.
    const wallsArr: [number, number][][] = rec.walls ?? [];
    let segs = 0, len = 0;
    for (const poly of wallsArr) {
      segs += Math.max(0, poly.length - 1);
      for (let i = 1; i < poly.length; i++) { const dx = poly[i][0] - poly[i - 1][0], dy = poly[i][1] - poly[i - 1][1]; len += Math.hypot(dx, dy); }
    }
    // Normalise length to grid cells: imageDims / pageSquares ≈ px per cell.
    const pxPerCell = rec.fileW && rec.pageWidthSquares ? rec.fileW / rec.pageWidthSquares : 70;
    const cells = pxPerCell ? len / pxPerCell : 0;
    const suspicious: string[] = [];
    if (TEST_NAME.test(rec.pageName || "")) suspicious.push("test-name");
    if (cells < 4) suspicious.push("low-wall-length"); // < ~4 grid cells of total wall = negligible
    rows.push({ campaign: camp, name: rec.pageName, walls: wallsArr.length, segs, len: Math.round(len), cells: Math.round(cells), type, suspicious });
  }
}

// Per-campaign summary.
const camps = Array.from(new Set(rows.map(r => r.campaign))).sort();
console.error("=== per-campaign (n | type | low-wall-length(<4 cells)) ===");
for (const c of camps) {
  const cr = rows.filter(r => r.campaign === c);
  const leg = cr.filter(r => r.type === "legacy").length, pv2 = cr.filter(r => r.type === "pathv2").length, mix = cr.filter(r => r.type === "mixed").length;
  const low = cr.filter(r => r.suspicious.includes("low-wall-length")).length;
  console.error(`  ${c.padEnd(30)} ${String(cr.length).padStart(3)} | ${leg}L/${pv2}P/${mix}M | low ${low}`);
}

// Only LOW-WALL-LENGTH is a real drop signal (test-name is noisy: "temp" in "Temple"). Show by length.
const low = rows.filter(r => r.suspicious.includes("low-wall-length")).sort((a, b) => a.cells - b.cells);
console.error(`\n=== ${low.length} low-wall-length records (walls / segments / length-px / ~cells) ===`);
for (const r of low) {
  console.error(`  ${r.campaign} :: ${r.name}  — ${r.walls}w / ${r.segs}seg / ${r.len}px / ~${r.cells} cells`);
}
console.error(`\ntotal: ${rows.length} | low-wall-length (<4 cells): ${low.length} | substantive: ${rows.length - low.length}`);
console.error(`segment totals — min/median/max across corpus: ${Math.min(...rows.map(r => r.segs))} / ${rows.map(r => r.segs).sort((a, b) => a - b)[Math.floor(rows.length / 2)]} / ${Math.max(...rows.map(r => r.segs))}`);
