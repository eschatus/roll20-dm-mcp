// Convert Universal-VTT files (.dd2vtt/.uvtt — Dungeondraft, Dungeon Alchemist, etc.) into training
// tiles, APPENDING to the existing tiles/ dataset. UVTT is ideal ground truth: line_of_sight walls
// come in GRID coordinates, so they register to the embedded image with ZERO grid-fit — multiply by
// pixels_per_grid. We normalize to the same 70px/cell canonical, rasterize the same binary mask
// (direct thick-line raster), tile 512/overlap-64, and split by MAP. IDs are prefixed `uvtt-` and a
// per-source tag so they never collide with the Roll20-harvested tiles.
//   tsx src/recon/uvtt-to-tiles.ts <src-folder> [--tag mbround18] [--dry]
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, statSync } from "fs";
import path from "path";
import sharp from "sharp";
import { dataDir } from "../dataDir.js";

const SRC = process.argv[2];
const TAG = (process.argv.includes("--tag") ? process.argv[process.argv.indexOf("--tag") + 1] : "uvtt").replace(/[^a-z0-9]/gi, "");
const DRY = process.argv.includes("--dry");
if (!SRC) { console.error("usage: uvtt-to-tiles.ts <src-folder> [--tag NAME] [--dry]"); process.exit(1); }

const CELL = 70, MAXLONG = 8192, TILE = 512, OVERLAP = 64, STRIDE = TILE - OVERLAP, STROKE = 6;
const OUT = path.join(dataDir(), "wall-dataset", "tiles");

// Recursively list .dd2vtt/.uvtt files.
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = path.join(dir, e);
    let st; try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) out.push(...walk(p));
    else if (/\.(dd2vtt|uvtt|df2vtt)$/i.test(e)) out.push(p);
  }
  return out;
}

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

const bucket = (id: string) => { let h = 0; for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h % 10; };
const splitOf = (id: string) => { const b = bucket(id); return b < 8 ? "train" : b === 8 ? "val" : "test"; };

if (!DRY) for (const s of ["train", "val", "test"]) for (const k of ["images", "masks"]) mkdirSync(path.join(OUT, s, k), { recursive: true });

const files = walk(SRC);
console.error(`found ${files.length} UVTT files under ${SRC}`);
let totalTiles = 0, wallTiles = 0, maps = 0, skipped = 0;
const metaLines: string[] = [];

for (const f of files) {
  let j: any; try { j = JSON.parse(readFileSync(f, "utf-8")); } catch { skipped++; continue; }
  const res = j.resolution || {};
  const ppg = res.pixels_per_grid || res.pixelsPerGrid;
  const ms = res.map_size || res.mapSize;
  const origin = res.map_origin || res.mapOrigin || { x: 0, y: 0 };
  const b64 = j.image;
  // walls: line_of_sight + objects_line_of_sight (each a polyline of grid-coord points)
  const segs: any[] = ([] as any[]).concat(j.line_of_sight || [], j.objects_line_of_sight || []);
  if (!ppg || !ms || !b64 || !segs.length) { skipped++; continue; }
  const cols = Math.round(ms.x), rows = Math.round(ms.y);
  if (cols < 2 || rows < 2) { skipped++; continue; }
  // canonical 70px/cell (cap long side)
  let canonW = cols * CELL, canonH = rows * CELL, scale = 1;
  const long = Math.max(canonW, canonH);
  if (long > MAXLONG) { scale = MAXLONG / long; canonW = Math.round(canonW * scale); canonH = Math.round(canonH * scale); }
  const id0 = `${TAG}-${path.basename(f).replace(/\.(dd2vtt|uvtt|df2vtt)$/i, "").replace(/[^a-z0-9]/gi, "_")}`;
  const split = splitOf(id0);
  const tilesX = Math.max(1, Math.ceil((canonW - TILE) / STRIDE) + 1), tilesY = Math.max(1, Math.ceil((canonH - TILE) / STRIDE) + 1);
  maps++;
  if (DRY) { totalTiles += tilesX * tilesY; continue; }

  // image (grid->canonical: scale embedded image to canonW x canonH)
  let imgBuf: Buffer;
  try { imgBuf = await sharp(Buffer.from(b64, "base64")).resize(canonW, canonH, { fit: "fill" }).removeAlpha().raw().toBuffer(); }
  catch (e) { console.error(`  img decode fail ${id0}: ${String(e).slice(0, 60)}`); skipped++; continue; }
  // walls: grid coord -> canonical px = (p - origin) * CELL * scale
  const k = CELL * scale;
  const mask = new Uint8Array(canonW * canonH);
  for (const poly of segs) {
    if (!Array.isArray(poly) || poly.length < 2) continue;
    for (let i = 1; i < poly.length; i++) {
      const a = poly[i - 1], b = poly[i];
      if (!a || !b) continue;
      stampLine(mask, canonW, canonH, (a.x - origin.x) * k, (a.y - origin.y) * k, (b.x - origin.x) * k, (b.y - origin.y) * k, STROKE);
    }
  }

  for (let tyI = 0; tyI < tilesY; tyI++) for (let txI = 0; txI < tilesX; txI++) {
    const tx = Math.min(txI * STRIDE, Math.max(0, canonW - TILE)), ty = Math.min(tyI * STRIDE, Math.max(0, canonH - TILE));
    const tw = Math.min(TILE, canonW), th = Math.min(TILE, canonH);
    const tImg = Buffer.alloc(TILE * TILE * 3), tMask = Buffer.alloc(TILE * TILE); let wpx = 0;
    for (let ry = 0; ry < th; ry++) {
      const srcRow = (ty + ry) * canonW + tx;
      for (let rx = 0; rx < tw; rx++) {
        const s3 = (srcRow + rx) * 3, d3 = (ry * TILE + rx) * 3;
        tImg[d3] = imgBuf[s3]; tImg[d3 + 1] = imgBuf[s3 + 1]; tImg[d3 + 2] = imgBuf[s3 + 2];
        const mv = mask[srcRow + rx]; tMask[ry * TILE + rx] = mv; if (mv > 127) wpx++;
      }
    }
    const id = `${id0}_${tyI}_${txI}`;
    await sharp(tImg, { raw: { width: TILE, height: TILE, channels: 3 } }).jpeg({ quality: 88 }).toFile(path.join(OUT, split, "images", `${id}.jpg`));
    await sharp(tMask, { raw: { width: TILE, height: TILE, channels: 1 } }).png().toFile(path.join(OUT, split, "masks", `${id}.png`));
    metaLines.push(JSON.stringify({ id, split, campaign: `uvtt:${TAG}`, source: "uvtt", tile: [tyI, txI], wallPx: wpx }));
    totalTiles++; if (wpx > 0) wallTiles++;
  }
  if (maps % 10 === 0) console.error(`  ...${maps} maps, ${totalTiles} tiles`);
}

if (!DRY && metaLines.length) appendFileSync(path.join(OUT, "meta.jsonl"), metaLines.join("\n") + "\n");
console.error(`\n${DRY ? "DRY: " : ""}${maps} maps -> ${totalTiles} tiles (${wallTiles} with walls), ${skipped} skipped`);
