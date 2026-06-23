// Batch: for each Mad Mage record, construct the DDB compendium map URL from the level name, fetch,
// register the Roll20 walls onto it via canonical grid-fit (maximize line-energy over the known
// cols x rows gridlines), and save {ddb image + walls in DDB-px + QC overlay}. Replaces the
// (low-res/shared) Roll20-captured image for these huge-marketplace maps. Reports per-map fit; an
// X/Y cell-size disagreement flags a misfit to review.
// tsx src/recon/ddb-batch.ts <campaign-slug> <ddb-base-url-prefix>
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import path from "path";
import sharp from "sharp";
import { dataDir } from "../dataDir.js";

const slug = process.argv[2] ?? "mules-and-the-mad-mage";
const PREFIX = process.argv[3] ?? "https://media.dndbeyond.com/compendium-images/wddotmm/isfkvgmVUs6DAn9f";
const dir = path.join(dataDir(), "wall-dataset", "raw", slug);
const outDir = path.join(dataDir(), "wall-dataset", "ddb-test"); mkdirSync(outDir, { recursive: true });

function urlFor(name: string): string | null {
  const m = name.match(/Level\s+(\d+)\s*:\s*(.+)/i);
  if (!m) return null; // Skullport etc. handled separately
  const nn = m[1].padStart(2, "0");
  const sl = m[2].toLowerCase().replace(/'/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `${PREFIX}/map-${nn}.01-${sl}-player.jpg`;
}

// Fit the known canonical grid (cols x rows cells) to the image; return per-axis cell px + origin.
function fitGrid(s: Float64Array, n: number, count: number): { cell: number; off: number } {
  const cHi = (n - 1) / count, cLo = cHi * 0.78;
  let best = { cell: cLo, off: 0, score: -Infinity };
  for (let c = cLo; c <= cHi; c += 0.05) {
    const oHi = Math.floor(n - 1 - count * c);
    for (let o = 0; o <= oHi; o++) { let v = 0; for (let k = 0; k <= count; k++) v += s[Math.round(o + k * c)]; if (v > best.score) best = { cell: c, off: o, score: v }; }
  }
  return best;
}

async function register(buf: Buffer, rec: any) {
  const { data: gray, info } = await sharp(buf).greyscale().raw().toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height;
  const colS = new Float64Array(W), rowS = new Float64Array(H);
  for (let y = 2; y < H - 2; y++) for (let x = 2; x < W - 2; x++) {
    const i = y * W + x, v = gray[i];
    colS[x] += Math.max(0, (gray[i - 2] + gray[i + 2]) / 2 - v);
    rowS[y] += Math.max(0, (gray[(y - 2) * W + x] + gray[(y + 2) * W + x]) / 2 - v);
  }
  const cols = Math.round(rec.graphic.width / 70), rows = Math.round(rec.graphic.height / 70);
  const fx = fitGrid(colS, W, cols), fy = fitGrid(rowS, H, rows);
  const sx = rec.transform.scaleX || 1, sy = rec.transform.scaleY || 1;
  const ddbWalls = rec.walls.map((poly: [number, number][]) => poly.map(([x, y]) => [fx.off + (x / sx / 70) * fx.cell, fy.off + (y / sy / 70) * fy.cell] as [number, number]));
  return { W, H, cX: fx.cell, cY: fy.cell, gx0: fx.off, gy0: fy.off, cols, rows, ddbWalls };
}

const files = readdirSync(dir).filter(f => f.endsWith(".json") && !f.endsWith(".ddb.json") && f !== "_manifest.json");
const results: string[] = [];
for (const f of files) {
  const rec = JSON.parse(readFileSync(path.join(dir, f), "utf-8"));
  const url = urlFor(rec.pageName);
  if (!url) { results.push(`SKIP (no level#)   ${rec.pageName}`); continue; }
  try {
    const resp = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0", Referer: "https://www.dndbeyond.com/" } });
    if (!resp.ok) { results.push(`${resp.status}              ${rec.pageName}   ${url.split("/").pop()}`); continue; }
    const buf = await sharp(Buffer.from(await resp.arrayBuffer())).rotate().png().toBuffer();
    const r = await register(buf, rec);
    const base = `${rec.pageId}`;
    writeFileSync(path.join(dir, `${base}.ddb.jpg`), await sharp(buf).jpeg({ quality: 92 }).toBuffer());
    writeFileSync(path.join(dir, `${base}.ddb.json`), JSON.stringify({ pageId: rec.pageId, pageName: rec.pageName, source: "ddb", url, fileW: r.W, fileH: r.H, cellPx: { x: r.cX, y: r.cY }, origin: { x: r.gx0, y: r.gy0 }, walls: r.ddbWalls }));
    // QC overlay
    const sw = Math.max(2, Math.round(r.W / 600));
    const parts = [`<svg xmlns="http://www.w3.org/2000/svg" width="${r.W}" height="${r.H}">`];
    for (const poly of r.ddbWalls) { if (poly.length < 2) continue; parts.push(`<polyline points="${poly.map((p: number[]) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ")}" fill="none" stroke="#0044FF" stroke-width="${sw}" stroke-opacity="0.85"/>`); }
    parts.push(`</svg>`);
    const overlay = await sharp(Buffer.from(parts.join("")), { density: 72 }).resize(r.W, r.H, { fit: "fill" }).png().toBuffer();
    const baseImg = await sharp(buf).resize(r.W, r.H, { fit: "fill" }).png().toBuffer();
    let pipe = sharp(await sharp(baseImg).composite([{ input: overlay }]).png().toBuffer());
    if (Math.max(r.W, r.H) > 1500) pipe = pipe.resize({ width: r.W >= r.H ? 1500 : undefined, height: r.H > r.W ? 1500 : undefined });
    await pipe.png().toFile(path.join(outDir, `${slug}__${base}.qc.png`));
    const skew = Math.abs(r.cX - r.cY) / r.cX;
    results.push(`${skew > 0.03 ? "OK?MISFIT" : "OK       "}  ${rec.pageName}   cell ${r.cX.toFixed(1)}/${r.cY.toFixed(1)}  ${r.W}x${r.H}`);
  } catch (e) { results.push(`ERR              ${rec.pageName}: ${String(e).slice(0, 70)}`); }
}
for (const r of results) console.error("  " + r);
console.error(`\nregistered OK: ${results.filter(r => r.startsWith("OK")).length} / ${files.length}  (MISFIT/404/ERR need attention)`);
