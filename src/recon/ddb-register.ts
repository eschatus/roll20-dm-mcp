// Register Roll20 walls onto a DDB compendium map image (for maps Roll20 can't serve full-res, e.g.
// huge marketplace). Walls live in Roll20's 70px/cell page space; the DDB image has a decorative
// border, so we detect its printed grid and map cells -> DDB pixels. Renders an overlay to verify.
// tsx src/recon/ddb-register.ts <campaign-slug> "<page name substr>" <ddb-image-url>
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import path from "path";
import sharp from "sharp";
import { dataDir } from "../dataDir.js";
import { detectGridByAutocorrelation } from "../tools/vision.js";

const [slug, nameSub, url] = process.argv.slice(2);
const dir = path.join(dataDir(), "wall-dataset", "raw", slug);
const recFile = readdirSync(dir).filter(f => f.endsWith(".json") && f !== "_manifest.json")
  .map(f => ({ f, r: JSON.parse(readFileSync(path.join(dir, f), "utf-8")) }))
  .find(({ r }) => (r.pageName || "").includes(nameSub));
if (!recFile) { console.error(`no record matching "${nameSub}"`); process.exit(1); }
const rec = recFile.r;
console.error(`record: ${rec.pageName} | grid ${Math.round(rec.graphic.width)}x${Math.round(rec.graphic.height)} | walls ${rec.walls.length} | wrong-img ${rec.fileW}x${rec.fileH} scale ${rec.transform.scaleX.toFixed(3)}`);

// Recover page-pixel (70px/cell) walls from the stored image-px walls + transform.
const sx = rec.transform.scaleX || 1, sy = rec.transform.scaleY || 1;
const pageWalls: [number, number][][] = rec.walls.map((poly: [number, number][]) => poly.map(([x, y]) => [x / sx, y / sy] as [number, number]));

// Fetch DDB image.
const resp = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0", Referer: "https://www.dndbeyond.com/" } });
if (!resp.ok) { console.error(`DDB fetch ${resp.status}`); process.exit(1); }
// Normalize (apply EXIF orientation, re-encode) so decoded pixel dims == metadata dims.
const buf = await sharp(Buffer.from(await resp.arrayBuffer())).rotate().png().toBuffer();
const meta = await sharp(buf).metadata();
const ddbW = meta.width!, ddbH = meta.height!;
console.error(`DDB image: ${ddbW}x${ddbH}`);

// Detect the printed grid's bounding box. Grid lines are thin, dark, and span the full playable
// width/height, so they dominate a column/row "line-darkness" projection; the parchment border and
// the bottom legend text do NOT form full-span lines, so they're excluded → the box is the playable
// map. Map the canonical Roll20 grid (55x73 cells) onto that box, per-axis.
const gW = rec.graphic.width, gH = rec.graphic.height; // page-px extent (cells*70)
const { data: gray, info: gi } = await sharp(buf).greyscale().raw().toBuffer({ resolveWithObject: true });
const W = gi.width, H = gi.height;
const colS = new Float64Array(W), rowS = new Float64Array(H);
for (let y = 2; y < H - 2; y++) for (let x = 2; x < W - 2; x++) {
  const i = y * W + x, v = gray[i];
  const dh = Math.max(0, (gray[i - 2] + gray[i + 2]) / 2 - v);   // darker than horizontal neighbors -> vertical line
  const dv = Math.max(0, (gray[(y - 2) * W + x] + gray[(y + 2) * W + x]) / 2 - v); // -> horizontal line
  colS[x] += dh; rowS[y] += dv;
}
// Fit the KNOWN canonical grid (cols x rows cells) to the image: search (cell, offset) to maximize
// line-energy summed over ALL predicted gridline positions (offset + k*cell, k=0..count). The true
// grid is the only (cell,offset) where all count+1 lines land on real lines, so cavern art can't fool
// it. cell is bounded by image width/count so the grid never overruns the image.
const fitGrid = (s: Float64Array, n: number, count: number): { cell: number; off: number } => {
  const cHi = (n - 1) / count, cLo = cHi * 0.78;           // playable is most of the image, after border
  let best = { cell: cLo, off: 0, score: -Infinity };
  for (let c = cLo; c <= cHi; c += 0.05) {
    const oHi = Math.floor(n - 1 - count * c);
    for (let o = 0; o <= oHi; o++) {
      let v = 0; for (let k = 0; k <= count; k++) v += s[Math.round(o + k * c)];
      if (v > best.score) best = { cell: c, off: o, score: v };
    }
  }
  return best;
};
const cols = Math.round(gW / 70), rows = Math.round(gH / 70);
const fx = fitGrid(colS, W, cols), fy = fitGrid(rowS, H, rows);
const cX = fx.cell, cY = fy.cell, gx0 = fx.off, gy0 = fy.off;
console.error(`cellpx X=${cX.toFixed(3)} Y=${cY.toFixed(3)} | origin (${gx0.toFixed(1)},${gy0.toFixed(1)}) | span ${(cols * cX).toFixed(0)}x${(rows * cY).toFixed(0)} in ${W}x${H} for ${cols}x${rows} cells`);
const tw = W, th = H; const playBuf = buf; // overlay on full image
const toDdb = (px: number, py: number): [number, number] => [gx0 + (px / 70) * cX, gy0 + (py / 70) * cY];
const ddbWalls = pageWalls.map(poly => poly.map(([x, y]) => toDdb(x, y)));

// Overlay walls on the TRIMMED playable image (walls are now in trimmed-image coords).
const sw = Math.max(2, Math.round(tw / 600));
const parts = [`<svg xmlns="http://www.w3.org/2000/svg" width="${tw}" height="${th}">`];
for (const poly of ddbWalls) { if (poly.length < 2) continue; parts.push(`<polyline points="${poly.map(p => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ")}" fill="none" stroke="#0044FF" stroke-width="${sw}" stroke-opacity="0.85"/>`); }
parts.push(`</svg>`);
// Persist dataset files: the DDB image + walls in DDB-px (Phase 2 prefers .ddb.json over the
// wrong-image .json for these maps).
writeFileSync(path.join(dir, `${rec.pageId}.ddb.jpg`), await sharp(buf).jpeg({ quality: 92 }).toBuffer());
writeFileSync(path.join(dir, `${rec.pageId}.ddb.json`), JSON.stringify({ pageId: rec.pageId, pageName: rec.pageName, source: "ddb", url, fileW: ddbW, fileH: ddbH, cellPx: { x: cX, y: cY }, origin: { x: gx0, y: gy0 }, walls: ddbWalls }));
const outDir = path.join(dataDir(), "wall-dataset", "ddb-test"); mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, `${slug}__${nameSub.replace(/\W+/g, "_")}.qc.png`);
const overlay = await sharp(Buffer.from(parts.join("")), { density: 72 }).resize(tw, th, { fit: "fill" }).png().toBuffer();
const base = await sharp(playBuf).resize(tw, th, { fit: "fill" }).png().toBuffer();
const composited = await sharp(base).composite([{ input: overlay, top: 0, left: 0 }]).png().toBuffer();
let pipe = sharp(composited);
if (Math.max(tw, th) > 2000) pipe = pipe.resize({ width: tw >= th ? 2000 : undefined, height: th > tw ? 2000 : undefined });
await pipe.png().toFile(outPath);
console.error(`overlay -> ${outPath}`);
