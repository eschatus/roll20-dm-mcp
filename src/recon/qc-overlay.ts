// Render harvested walls on top of the map image for label QC.
//
// Phase 1 of the wall-segmentation pipeline. Reads harvest records emitted by
// harvest-walls.ts and composites the walls (blue), doors (red), and windows (cyan)
// over the art so misalignment, missing walls, or bad grids are obvious by eye.
// Pure local image work — no Roll20 connection. Run with tsx:
//
//   tsx src/recon/qc-overlay.ts <campaign-slug>           # all records in that dir
//   tsx src/recon/qc-overlay.ts <path/to/record.json>     # a single record
//
// Output: <record-dir>/qc/<pageId>.qc.png  (long side capped for quick scanning)
import { pathToFileURL } from "url";
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from "fs";
import path from "path";
import sharp from "sharp";
import { dataPath } from "../dataDir.js";

const QC_MAX_PX = 2000; // cap output long-side so a folder of QC sheets stays scannable

interface HarvestRecord {
  pageId: string; pageName: string; imageFile: string;
  fileW: number; fileH: number;
  walls: [number, number][][];
  doors: { from: [number, number]; to: [number, number]; isSecret?: boolean }[];
  windows: { from: [number, number]; to: [number, number] }[];
  flags: string[];
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function buildSvg(rec: HarvestRecord, W: number, H: number): Buffer {
  const sw = Math.max(2, Math.round(W / 600)); // stroke scales with image size
  const parts: string[] = [`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">`];

  for (const poly of rec.walls) {
    if (poly.length < 2) continue;
    const pts = poly.map(([x, y]) => `${x},${y}`).join(" ");
    parts.push(`<polyline points="${pts}" fill="none" stroke="#0044FF" stroke-width="${sw}" stroke-opacity="0.85" stroke-linecap="round" stroke-linejoin="round"/>`);
    // endpoint dots make over/under-shoot and anchor bugs visible
    for (const [x, y] of poly) parts.push(`<circle cx="${x}" cy="${y}" r="${sw * 1.4}" fill="#FF8800" fill-opacity="0.9"/>`);
  }
  for (const d of rec.doors) {
    parts.push(`<line x1="${d.from[0]}" y1="${d.from[1]}" x2="${d.to[0]}" y2="${d.to[1]}" stroke="${d.isSecret ? "#9932CC" : "#FF0000"}" stroke-width="${sw * 1.5}" stroke-opacity="0.9"/>`);
  }
  for (const w of rec.windows) {
    parts.push(`<line x1="${w.from[0]}" y1="${w.from[1]}" x2="${w.to[0]}" y2="${w.to[1]}" stroke="#00FFFF" stroke-width="${sw * 1.5}" stroke-opacity="0.9"/>`);
  }

  const label = `${esc(rec.pageName)} — ${rec.walls.length} walls${rec.flags.length ? "  ⚑ " + esc(rec.flags.join(", ")) : ""}`;
  const fs = Math.max(16, Math.round(W / 70));
  parts.push(`<rect x="0" y="0" width="${W}" height="${fs * 1.8}" fill="#000000" fill-opacity="0.55"/>`);
  parts.push(`<text x="${fs * 0.4}" y="${fs * 1.25}" font-family="sans-serif" font-size="${fs}" fill="#FFFFFF">${label}</text>`);
  parts.push(`</svg>`);
  return Buffer.from(parts.join(""));
}

async function renderRecord(recordPath: string): Promise<void> {
  const rec = JSON.parse(readFileSync(recordPath, "utf-8")) as HarvestRecord;
  const dir = path.dirname(recordPath);
  const imgPath = path.join(dir, rec.imageFile);
  if (!existsSync(imgPath)) { console.error(`  · ${rec.pageName} — image missing (${rec.imageFile})`); return; }

  const overlay = buildSvg(rec, rec.fileW, rec.fileH);
  const composited = await sharp(imgPath)
    .composite([{ input: overlay, top: 0, left: 0 }])
    .toBuffer();

  const qcDir = path.join(dir, "qc");
  mkdirSync(qcDir, { recursive: true });
  const outPath = path.join(qcDir, `${rec.pageId}.qc.png`);
  const long = Math.max(rec.fileW, rec.fileH);
  const pipeline = sharp(composited);
  if (long > QC_MAX_PX) pipeline.resize({ width: rec.fileW >= rec.fileH ? QC_MAX_PX : undefined, height: rec.fileH > rec.fileW ? QC_MAX_PX : undefined });
  await pipeline.png().toFile(outPath);
  console.error(`  ✓ ${rec.pageName} → ${path.relative(process.cwd(), outPath)}`);
}

export async function qcOverlay(target: string): Promise<void> {
  // target: a record.json, a raw/<slug> dir, or a bare campaign slug under data/wall-dataset/raw.
  let recordPaths: string[];
  if (target.endsWith(".json")) {
    recordPaths = [target];
  } else {
    const dir = existsSync(target) ? target : dataPath(path.join("wall-dataset", "raw", target));
    recordPaths = readdirSync(dir)
      .filter(f => f.endsWith(".json") && f !== "_manifest.json")
      .map(f => path.join(dir, f));
  }
  console.error(`\n[qc] ${recordPaths.length} record(s)\n`);
  for (const rp of recordPaths) {
    try { await renderRecord(rp); }
    catch (err) { console.error(`  ✗ ${rp} — ${String(err).slice(0, 120)}`); }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const target = process.argv[2];
  if (!target) { console.error("usage: tsx src/recon/qc-overlay.ts <campaign-slug | record.json>"); process.exit(2); }
  qcOverlay(target).then(() => process.exit(0)).catch(e => { console.error("❌ qc crashed:", e); process.exit(1); });
}
