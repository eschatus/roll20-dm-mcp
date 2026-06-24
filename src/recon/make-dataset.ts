// Phase 2 — dataset materialization. For every harvested map: pick the right source (prefer the
// DDB-registered .ddb.json/.ddb.jpg over the original capture when present), DEDUP near-duplicates
// (cloned campaigns), NORMALIZE to 70px/cell canonical (page cols*70 x rows*70 — "page size is
// canonical"), rasterize walls into a binary MASK (direct thick-line raster, no SVG), TILE both
// image+mask to 512 with overlap, and SPLIT by MAP (no tile leakage). Skullport/junk Mad Mage pages
// are skipped (cropped, no clean reference). Writes tiles/{train,val,test}/{images,masks} + meta.jsonl.
//   tsx src/recon/make-dataset.ts [--dry]
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "fs";
import path from "path";
import sharp from "sharp";
import { dataDir } from "../dataDir.js";

const DRY = process.argv.includes("--dry");
const CELL = 70;            // canonical px per grid cell
const MAXLONG = 8192;       // cap canonical long side (memory guard)
const TILE = 512, OVERLAP = 64, STRIDE = TILE - OVERLAP;
const STROKE = 6;           // wall mask line thickness (px @ 70px/cell)
const raw = path.join(dataDir(), "wall-dataset", "raw");
const OUT = path.join(dataDir(), "wall-dataset", "tiles");

interface MapRec {
  campaign: string; pageId: string; pageName: string; source: "ddb" | "capture";
  imagePath: string; walls: [number, number][][]; fileW: number; fileH: number;
  cols: number; rows: number; segs: number; hash?: bigint;
}

const segsOf = (walls: any[]) => walls.reduce((s, p) => s + Math.max(0, p.length - 1), 0);

// Human GT verdicts (from the labeling app): keep only good+partial; exclude wrong-image/misplaced
// and anything unlabeled (user: "unlabeled = doesn't belong"). null when no verdicts file yet.
const verdictsPath = path.join(dataDir(), "wall-dataset", "qc-app", "qc-verdicts.json");
const KEEP: Set<string> | null = existsSync(verdictsPath)
  ? new Set(Object.entries(JSON.parse(readFileSync(verdictsPath, "utf-8")) as Record<string, string>)
      .filter(([, v]) => v === "good" || v === "partial").map(([k]) => k))
  : null;
if (KEEP) console.error(`GT verdicts: keeping ${KEEP.size} good+partial maps`);

// ---- 1. Enumerate, choosing the best source per page ----------------------------------------
const maps: MapRec[] = [];
for (const camp of readdirSync(raw)) {
  const dir = path.join(raw, camp);
  let files: string[]; try { files = readdirSync(dir).filter(f => f.endsWith(".json") && !f.endsWith(".ddb.json") && f !== "_manifest.json"); } catch { continue; }
  for (const f of files) {
    let rec: any; try { rec = JSON.parse(readFileSync(path.join(dir, f), "utf-8")); } catch { continue; }
    if (!rec.graphic?.width) continue;
    if (KEEP && !KEEP.has(rec.pageId)) continue; // drop human-flagged bad GT (wrong-image/misplaced) + unlabeled
    const cols = Math.round(rec.graphic.width / CELL), rows = Math.round(rec.graphic.height / CELL);
    if (cols < 2 || rows < 2) continue;
    const ddbPath = path.join(dir, `${rec.pageId}.ddb.json`);
    if (existsSync(ddbPath)) {
      const ddb = JSON.parse(readFileSync(ddbPath, "utf-8"));
      const img = path.join(dir, `${rec.pageId}.ddb.jpg`);
      if (!existsSync(img)) continue;
      maps.push({ campaign: camp, pageId: rec.pageId, pageName: rec.pageName, source: "ddb", imagePath: img, walls: ddb.walls, fileW: ddb.fileW, fileH: ddb.fileH, cols, rows, segs: segsOf(ddb.walls) });
    } else if (camp === "mules-and-the-mad-mage") {
      continue; // Skullport / Random Battle Map — wrong/cropped image, no clean reference
    } else {
      const img = path.join(dir, rec.imageFile || "");
      if (!rec.imageFile || !existsSync(img)) continue;
      maps.push({ campaign: camp, pageId: rec.pageId, pageName: rec.pageName, source: "capture", imagePath: img, walls: rec.walls, fileW: rec.fileW, fileH: rec.fileH, cols, rows, segs: segsOf(rec.walls) });
    }
  }
}
console.error(`enumerated ${maps.length} maps (${maps.filter(m => m.source === "ddb").length} via DDB)`);

// ---- 2. Dedup (256-bit dHash, keep richest-walled) -------------------------------------------
async function dHash(p: string): Promise<bigint> {
  const buf = await sharp(p).grayscale().resize(17, 16, { fit: "fill" }).raw().toBuffer();
  let h = 0n, bit = 0; for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) { if (buf[y * 17 + x] < buf[y * 17 + x + 1]) h |= (1n << BigInt(bit)); bit++; }
  return h;
}
const hamming = (a: bigint, b: bigint) => { let x = a ^ b, c = 0; while (x) { c += Number(x & 1n); x >>= 1n; } return c; };
for (const m of maps) { try { m.hash = await dHash(m.imagePath); } catch { m.hash = 0n; } }
maps.sort((a, b) => b.segs - a.segs);
const canonical: MapRec[] = []; let dropped = 0;
const dimsMatch = (a: MapRec, b: MapRec) => a.fileW && b.fileW && Math.abs(a.fileW - b.fileW) <= a.fileW * 0.02 && Math.abs(a.fileH - b.fileH) <= a.fileH * 0.02;
for (const m of maps) {
  if (canonical.some(c => dimsMatch(c, m) && hamming(c.hash!, m.hash!) <= 10)) dropped++;
  else canonical.push(m);
}
console.error(`canonical ${canonical.length} (dropped ${dropped} dupes)`);

// ---- 3. Split by map (Skullport already excluded; deterministic bucket) ----------------------
const bucket = (id: string) => { let h = 0; for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h % 10; };
const splitOf = (id: string) => { const b = bucket(id); return b < 8 ? "train" : b === 8 ? "val" : "test"; };

// ---- 4. Materialize -------------------------------------------------------------------------
function stampLine(mask: Uint8Array, W: number, H: number, x0: number, y0: number, x1: number, y1: number, r: number) {
  const dx = x1 - x0, dy = y1 - y0, len = Math.hypot(dx, dy), steps = Math.max(1, Math.ceil(len));
  for (let i = 0; i <= steps; i++) {
    const px = Math.round(x0 + dx * i / steps), py = Math.round(y0 + dy * i / steps);
    for (let oy = -r; oy <= r; oy++) for (let ox = -r; ox <= r; ox++) {
      if (ox * ox + oy * oy > r * r) continue;
      const xx = px + ox, yy = py + oy; if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
      mask[yy * W + xx] = 255;
    }
  }
}

if (!DRY) { try { rmSync(OUT, { recursive: true }); } catch {} for (const s of ["train", "val", "test"]) for (const k of ["images", "masks"]) mkdirSync(path.join(OUT, s, k), { recursive: true }); }

let totalTiles = 0, wallTiles = 0;
const meta: string[] = [];
const perMap: { name: string; split: string; canon: string; tiles: number }[] = [];
for (const m of canonical) {
  const split = splitOf(m.pageId);
  let canonW = m.cols * CELL, canonH = m.rows * CELL;
  let scale = 1; const long = Math.max(canonW, canonH);
  if (long > MAXLONG) { scale = MAXLONG / long; canonW = Math.round(canonW * scale); canonH = Math.round(canonH * scale); }
  const tilesX = Math.max(1, Math.ceil((canonW - TILE) / STRIDE) + 1), tilesY = Math.max(1, Math.ceil((canonH - TILE) / STRIDE) + 1);
  perMap.push({ name: `${m.campaign}/${m.pageName}`, split, canon: `${canonW}x${canonH}`, tiles: tilesX * tilesY });
  if (DRY) { totalTiles += tilesX * tilesY; continue; }

  // canonical image (RGB) + wall mask
  const img = await sharp(m.imagePath).resize(canonW, canonH, { fit: "fill" }).removeAlpha().raw().toBuffer();
  const mask = new Uint8Array(canonW * canonH);
  const sx = canonW / m.fileW, sy = canonH / m.fileH;
  for (const poly of m.walls) for (let i = 1; i < poly.length; i++)
    stampLine(mask, canonW, canonH, poly[i - 1][0] * sx, poly[i - 1][1] * sy, poly[i][0] * sx, poly[i][1] * sy, STROKE);

  for (let tyI = 0; tyI < tilesY; tyI++) for (let txI = 0; txI < tilesX; txI++) {
    const tx = Math.min(txI * STRIDE, Math.max(0, canonW - TILE)), ty = Math.min(tyI * STRIDE, Math.max(0, canonH - TILE));
    const tw = Math.min(TILE, canonW), th = Math.min(TILE, canonH);
    const tImg = Buffer.alloc(TILE * TILE * 3), tMask = Buffer.alloc(TILE * TILE); let wpx = 0;
    for (let ry = 0; ry < th; ry++) {
      const srcRow = (ty + ry) * canonW + tx;
      for (let rx = 0; rx < tw; rx++) {
        const s3 = (srcRow + rx) * 3, d3 = (ry * TILE + rx) * 3;
        tImg[d3] = img[s3]; tImg[d3 + 1] = img[s3 + 1]; tImg[d3 + 2] = img[s3 + 2];
        const mv = mask[srcRow + rx]; tMask[ry * TILE + rx] = mv; if (mv > 127) wpx++;
      }
    }
    const id = `${m.pageId}_${tyI}_${txI}`;
    await sharp(tImg, { raw: { width: TILE, height: TILE, channels: 3 } }).jpeg({ quality: 88 }).toFile(path.join(OUT, split, "images", `${id}.jpg`));
    await sharp(tMask, { raw: { width: TILE, height: TILE, channels: 1 } }).png().toFile(path.join(OUT, split, "masks", `${id}.png`));
    meta.push(JSON.stringify({ id, split, campaign: m.campaign, pageId: m.pageId, source: m.source, tile: [tyI, txI], wallPx: wpx }));
    totalTiles++; if (wpx > 0) wallTiles++;
  }
}

if (DRY) {
  perMap.sort((a, b) => b.tiles - a.tiles);
  for (const p of perMap.slice(0, 8)) console.error(`  ${String(p.tiles).padStart(4)} tiles  ${p.canon.padEnd(11)} ${p.split}  ${p.name}`);
  const bySplit = (s: string) => perMap.filter(p => p.split === s).reduce((a, p) => a + p.tiles, 0);
  console.error(`\nDRY: ${canonical.length} maps -> ~${totalTiles} tiles  (train ${bySplit("train")} / val ${bySplit("val")} / test ${bySplit("test")})`);
} else {
  writeFileSync(path.join(OUT, "meta.jsonl"), meta.join("\n") + "\n");
  const c = (s: string) => canonical.filter(m => splitOf(m.pageId) === s).length;
  writeFileSync(path.join(OUT, "manifest.json"), JSON.stringify({ maps: canonical.length, tiles: totalTiles, wallTiles, splitMaps: { train: c("train"), val: c("val"), test: c("test") }, cell: CELL, tile: TILE, overlap: OVERLAP, stroke: STROKE }, null, 2));
  console.error(`\nwrote ${totalTiles} tiles (${wallTiles} with walls, ${(100 * wallTiles / totalTiles).toFixed(0)}%) -> ${OUT}`);
}
