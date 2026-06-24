// Harvest (map image, hand-placed DL walls) training pairs from Roll20.
//
// Phase 0 of the wall-segmentation training pipeline (see
// C:\Users\escha\.claude\plans\i-have-a-large-shiny-zephyr.md). Walks the ACTIVE
// campaign's pages, reads the human/professional walls back off the walls layer, pairs
// each page with its map-layer image, and transforms wall geometry from Roll20 page
// pixels into image-file pixels so the labels line up with the art.
//
// READ-ONLY against Roll20 (getWalls / getTokens / getDoors are read paths; no writes),
// so it will not disturb a live session. Run with tsx:
//
//   tsx src/recon/harvest-walls.ts                 # active campaign, all pages
//   tsx src/recon/harvest-walls.ts --campaign cos  # switch first, then harvest
//   tsx src/recon/harvest-walls.ts --page -ABC123  # single page (alignment check)
//   tsx src/recon/harvest-walls.ts --limit 5       # first N walled pages only
//
// Output (gitignored): data/wall-dataset/raw/<campaign-slug>/
//   <pageId>.json   — the harvest record (walls/doors in IMAGE-pixel coords)
//   <pageId>.<ext>  — the map image bytes (max-res variant of imgsrc)
//   _manifest.json  — index of every record emitted this run
process.env.ROLL20_TRANSPORT ??= "rt";

import { pathToFileURL } from "url";
import { writeFileSync, mkdirSync } from "fs";
import path from "path";
import sharp from "sharp";
import { getEditorPage, reconnectRoll20 } from "../bridge/roll20.js";
import { rtGet } from "../bridge/roll20-rt.js";
import { dataPath } from "../dataDir.js";
import { getActiveCampaign, setActiveCampaign, toSlug } from "../registry/campaigns.js";
import { captureMapImage } from "./capture-map.js";
import type { Page } from "playwright";

const ROLL20_CELL_PX = 70;

// ── Relay / RTDB response shapes (mirror ai-relay.js + Firebase storage) ─────
interface PageInfo { id: string; name: string; width: number; height: number } // width/height in grid squares
interface GraphicInfo { id: string; layer?: string; imgsrc?: string; left?: number; top?: number; width?: number; height?: number }
// Legacy DL wall as stored in RTDB paths/page/<pageId>. left/top = CENTER (normal,
// un-negated coords). `path` is a JSON string of SVG-ish commands in canvas-px local space.
// A walls-layer object in RTDB paths/page/<id>. Legacy DL = `path` (SVG-string, left/top center).
// UDL pathv2 = `shape:"pol"` + `points` (array of [dx,dy] relative to the x,y anchor; first point [0,0]).
interface RtPath { layer?: string; left?: number; top?: number; width?: number; height?: number; rotation?: number; path?: string; shape?: string; points?: [number, number][] | string; x?: number; y?: number }

// pathv2 (UDL) wall → absolute page-pixel polyline: anchor (x,y) + each relative point. No Mod needed.
function pathv2RtToPage(p: RtPath): [number, number][] {
  let pts: unknown = p.points;
  if (typeof pts === "string") { try { pts = JSON.parse(pts); } catch { return []; } }
  if (!Array.isArray(pts)) return [];
  const x = p.x ?? 0, y = p.y ?? 0;
  const out = pts
    .filter((q): q is [number, number] => Array.isArray(q) && typeof q[0] === "number" && typeof q[1] === "number")
    .map(([dx, dy]) => [x + dx, y + dy] as [number, number]);
  return out.length >= 2 ? out : [];
}
// Door/window as stored in RTDB: x normal, y NEGATED; handles under path.{handle0,handle1},
// relative to (x,y), y also negated.
interface RtOpening { x: number; y: number; path?: { handle0?: { x?: number; y?: number }; handle1?: { x?: number; y?: number } }; isSecret?: boolean }

// Parse a legacy `path` object into a page-pixel polyline. Roll20 stores path data in a
// local canvas-px frame whose bounding box is centered on (left, top); map each axis from
// the local bbox onto [center ± size/2], which is correct whether or not the path was scaled.
function legacyPathToPage(p: RtPath): [number, number][] {
  let cmds: unknown;
  try { cmds = JSON.parse(p.path ?? "[]"); } catch { return []; }
  if (!Array.isArray(cmds)) return [];
  const pts: [number, number][] = [];
  for (const c of cmds) {
    if (Array.isArray(c) && (c[0] === "M" || c[0] === "L") && typeof c[1] === "number" && typeof c[2] === "number") {
      pts.push([c[1], c[2]]);
    }
  }
  if (pts.length < 2) return []; // dots / degenerate ("[M,L same point,Z]")
  const xs = pts.map(q => q[0]), ys = pts.map(q => q[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const spanX = maxX - minX, spanY = maxY - minY;
  if (spanX < 1e-6 && spanY < 1e-6) return []; // zero-length
  const left = p.left ?? 0, top = p.top ?? 0;
  const w = typeof p.width === "number" ? p.width : spanX;
  const h = typeof p.height === "number" ? p.height : spanY;
  const mapX = (x: number) => spanX > 1e-6 ? (left - w / 2) + (x - minX) / spanX * w : left;
  const mapY = (y: number) => spanY > 1e-6 ? (top - h / 2) + (y - minY) / spanY * h : top;
  let page: [number, number][] = pts.map(([x, y]) => [mapX(x), mapY(y)]);
  const rot = (p.rotation ?? 0) * Math.PI / 180;
  if (Math.abs(rot) > 1e-6) {
    const cos = Math.cos(rot), sin = Math.sin(rot);
    page = page.map(([x, y]) => { const dx = x - left, dy = y - top; return [left + dx * cos - dy * sin, top + dx * sin + dy * cos]; });
  }
  return page;
}

// ── Harvest record written to disk (coords are IMAGE-FILE pixels) ───────────
interface HarvestRecord {
  campaignSlug: string;
  campaignName: string;
  roll20CampaignId: string;
  pageId: string;
  pageName: string;
  pageWidthSquares: number;
  pageHeightSquares: number;
  imageFile: string;            // basename, sits beside the record
  imgsrc: string;               // source CDN url (max variant)
  assetId: string | null;       // Roll20 art-library asset id — the dedup key
  fileW: number;                // image natural pixel dims
  fileH: number;
  graphic: { left: number; top: number; width: number; height: number }; // map graphic, page px (center-based)
  transform: { originX: number; originY: number; scaleX: number; scaleY: number }; // page px → image px
  walls: [number, number][][];  // polylines, image-pixel coords
  doors: { from: [number, number]; to: [number, number]; isSecret?: boolean }[];
  windows: { from: [number, number]; to: [number, number] }[];
  flags: string[];              // QC hints surfaced at harvest time
}

function parseArgs(argv: string[]) {
  const out: { campaign?: string; page?: string; pageIds?: string[]; limit?: number; imageUrl?: string; capture?: boolean; source?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--campaign") out.campaign = argv[++i];
    else if (argv[i] === "--page") out.page = argv[++i];
    else if (argv[i] === "--pageIds") out.pageIds = (argv[++i] ?? "").split(",").map(s => s.trim()).filter(Boolean); // harvest an explicit set of pages
    else if (argv[i] === "--limit") out.limit = parseInt(argv[++i] ?? "", 10);
    else if (argv[i] === "--imageUrl") out.imageUrl = argv[++i]; // override gated Roll20 art with a public URL (e.g. DDB compendium)
    else if (argv[i] === "--capture") out.capture = true; // render-capture the image from Roll20 (handles gated art); navigates the GM page
    else if (argv[i] === "--source") out.source = argv[++i]; // only harvest pages whose map is "marketplace" or "uploaded" (filters out generated maps)
  }
  return out;
}

// Classify the map image's origin. In CoS, "marketplace" = genuine module art (real human walls),
// "uploaded" = maps WE generated — so --source marketplace keeps the ground truth and drops our output.
function sourceClass(imgsrc?: string): "uploaded" | "marketplace" | "external" | "none" {
  if (!imgsrc) return "none";
  if (/files\.d20\.io\/(images|marketplace)\//.test(imgsrc)) return imgsrc.includes("/marketplace/") ? "marketplace" : "uploaded";
  return "external";
}

// Roll20 imgsrc points at one sized variant (thumb/med/min/max/original). For training we
// want the largest available, but not every asset has every variant (a missing one 403s on
// S3). Build candidates best-first, preserving the query string, and the fetch loop takes the
// first that returns 200 — starting with the exact url Roll20 served (guaranteed to exist).
function imageCandidates(imgsrc: string): string[] {
  const swap = (v: string) => imgsrc.replace(/\/(thumb|med|min|max|original)\.(png|jpg|jpeg|webp)/i, `/${v}.$2`);
  const seen = new Set<string>();
  return ["max", "original", "med", "min", "thumb"].map(swap).concat(imgsrc)
    .filter(u => (seen.has(u) ? false : (seen.add(u), true)));
}
function assetIdOf(imgsrc: string): string | null {
  const m = imgsrc.match(/\/images\/([^/]+)\//);
  return m ? m[1]! : null;
}

// Pick THE background map graphic: map-layer, has imgsrc, largest area. Returns the
// graphic plus a flag if several plausible full-size map images exist on the page.
function pickMapGraphic(graphics: GraphicInfo[]): { g: GraphicInfo | null; multiMap: boolean } {
  const candidates = graphics
    .filter(g => g.imgsrc && (g.layer === "map" || g.layer === undefined))
    .map(g => ({ g, area: (g.width ?? 0) * (g.height ?? 0) }))
    .sort((a, b) => b.area - a.area);
  if (candidates.length === 0) return { g: null, multiMap: false };
  const top = candidates[0]!;
  const multiMap = candidates.filter(c => c.area >= top.area * 0.6).length > 1;
  return { g: top.g, multiMap };
}

async function harvestPage(
  page: PageInfo,
  campaign: { slug: string; name: string; roll20CampaignId: string },
  outDir: string,
  imageUrlOverride?: string,
  editorPage?: Page,
  sourceFilter?: string,
): Promise<HarvestRecord | { pageId: string; pageName: string; skipped: string }> {
  const flags: string[] = [];

  // 1. Walls — read straight from the RTDB walls layer (NO Mod, no relay). Two DL formats coexist:
  //    legacy `path` (SVG string) and UDL `pathv2` (shape:"pol" + points). Both are in paths/page.
  const rtPaths = await rtGet<Record<string, RtPath>>(`paths/page/${page.id}`);
  const wallObjs = Object.values(rtPaths ?? {}).filter(p => p.layer === "walls");
  const legacyPolys = wallObjs.filter(p => p.path).map(legacyPathToPage).filter(poly => poly.length >= 2);
  const pathv2Polys = wallObjs.filter(p => p.shape === "pol" && p.points).map(pathv2RtToPage).filter(poly => poly.length >= 2);

  const wallPolysPage = [...legacyPolys, ...pathv2Polys];
  if (legacyPolys.length) flags.push(`legacy:${legacyPolys.length}`);
  if (pathv2Polys.length) flags.push(`pathv2:${pathv2Polys.length}`);
  if (wallPolysPage.length === 0) return { pageId: page.id, pageName: page.name, skipped: "no-walls" };

  // 2. Map graphic — page-pixel geometry of the background image. Read straight from the RTDB
  //    (graphics store left/top un-negated, verified == getTokens) so the harvest needs no Mod.
  const graphicsObj = await rtGet<Record<string, GraphicInfo>>(`graphics/page/${page.id}`);
  const graphics = Object.values(graphicsObj ?? {});
  const { g, multiMap } = pickMapGraphic(graphics);
  if (!g || !g.imgsrc) return { pageId: page.id, pageName: page.name, skipped: "no-map-graphic" };
  if (sourceFilter && sourceClass(g.imgsrc) !== sourceFilter) {
    return { pageId: page.id, pageName: page.name, skipped: `source-${sourceClass(g.imgsrc)}!=${sourceFilter}` };
  }
  if (multiMap) flags.push("multipleMapGraphics");
  const gLeft = g.left ?? 0, gTop = g.top ?? 0;
  const gW = g.width ?? page.width * ROLL20_CELL_PX, gH = g.height ?? page.height * ROLL20_CELL_PX;
  if (gW <= 0 || gH <= 0) return { pageId: page.id, pageName: page.name, skipped: "degenerate-graphic" };

  // Map graphic covers ~the whole page? If not, walls may extend past the image → flag.
  const pageWpx = page.width * ROLL20_CELL_PX, pageHpx = page.height * ROLL20_CELL_PX;
  if (Math.abs(gW - pageWpx) > pageWpx * 0.1 || Math.abs(gH - pageHpx) > pageHpx * 0.1) {
    flags.push("graphic-not-full-page");
  }

  // 3. Acquire the image bytes + natural dimensions. Three sources, in priority:
  //    (a) render-capture from Roll20 (editorPage) — handles gated marketplace art, exact framing;
  //    (b) imageUrlOverride — a public URL (e.g. DDB compendium) when capture isn't used;
  //    (c) direct fetch of the Roll20 imgsrc variants — only works for ungated assets.
  let fileW = 0, fileH = 0, buf: Buffer | null = null, imgsrc = g.imgsrc, lastStatus = 0;
  if (editorPage) {
    const cap = await captureMapImage(editorPage, page.id, page.name, g.imgsrc, { w: gW, h: gH });
    if (!cap) return { pageId: page.id, pageName: page.name, skipped: "capture-failed" };
    buf = cap.buf; fileW = cap.w; fileH = cap.h; imgsrc = cap.url; flags.push("captured");
  } else {
    const urls = imageUrlOverride ? [imageUrlOverride] : imageCandidates(g.imgsrc);
    if (imageUrlOverride) flags.push("imageOverride");
    for (const url of urls) {
      try {
        const resp = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0", "Referer": "https://app.roll20.net/" } });
        if (!resp.ok) { lastStatus = resp.status; continue; }
        const b = Buffer.from(await resp.arrayBuffer());
        const meta = await sharp(b).metadata();
        if (!meta.width || !meta.height) continue;
        buf = b; fileW = meta.width; fileH = meta.height; imgsrc = url; break;
      } catch { /* try next variant */ }
    }
    if (!buf) return { pageId: page.id, pageName: page.name, skipped: `image-fetch-${lastStatus || "err"}` };
  }
  // Canvas-readback always yields PNG bytes; otherwise derive the extension from the source URL.
  const ext = editorPage ? "jpg" : (imgsrc.match(/\.(png|jpg|jpeg|webp)/i)?.[1] ?? "png").toLowerCase();
  const imageFile = `${page.id}.${ext}`;

  // 4. The alignment transform: page px → image-file px.
  //    Map graphic is center-based; its top-left in page px is (left - w/2, top - h/2).
  const originX = gLeft - gW / 2, originY = gTop - gH / 2;
  const scaleX = fileW / gW, scaleY = fileH / gH;
  const toImg = (px: number, py: number): [number, number] => [
    Math.round((px - originX) * scaleX),
    Math.round((py - originY) * scaleY),
  ];

  const walls = wallPolysPage.map(poly => poly.map(([px, py]) => toImg(px, py)));

  // 5. Doors / windows (best-effort, from RTDB — no Mod). In RTDB the object x is normal but y is
  //    NEGATED, and handles live under path.{handle0,handle1} RELATIVE to (x,y), y also negated.
  //    Absolute normal coords: x = o.x + h.x ; y = -(o.y) + -(h.y) = -(o.y + h.y).
  let doors: HarvestRecord["doors"] = [];
  let windows: HarvestRecord["windows"] = [];
  try {
    const seg = (o: RtOpening, h: "handle0" | "handle1") => {
      const hh = o.path?.[h] ?? {};
      return toImg(o.x + (hh.x ?? 0), -((o.y ?? 0) + (hh.y ?? 0)));
    };
    const read = async (kind: "doors" | "windows") => Object.values(await rtGet<Record<string, RtOpening>>(`${kind}/page/${page.id}`) ?? {});
    doors = (await read("doors")).map(o => ({ from: seg(o, "handle0"), to: seg(o, "handle1"), isSecret: o.isSecret }));
    windows = (await read("windows")).map(o => ({ from: seg(o, "handle0"), to: seg(o, "handle1") }));
  } catch { flags.push("doors-failed"); }

  // 6. Persist image + record.
  const imgPath = path.join(outDir, imageFile);
  writeFileSync(imgPath, buf);
  const rec: HarvestRecord = {
    campaignSlug: campaign.slug, campaignName: campaign.name, roll20CampaignId: campaign.roll20CampaignId,
    pageId: page.id, pageName: page.name,
    pageWidthSquares: page.width, pageHeightSquares: page.height,
    imageFile, imgsrc, assetId: assetIdOf(imgsrc),
    fileW, fileH,
    graphic: { left: gLeft, top: gTop, width: gW, height: gH },
    transform: { originX, originY, scaleX, scaleY },
    walls, doors, windows, flags,
  };
  writeFileSync(path.join(outDir, `${page.id}.json`), JSON.stringify(rec, null, 2));
  return rec;
}

export async function harvest(opts: { campaign?: string; page?: string; limit?: number; imageUrl?: string; capture?: boolean; source?: string } = {}): Promise<number> {
  if (opts.campaign) {
    setActiveCampaign(opts.campaign);
    // Rebind the editor (and lazily the RT connection) to the newly-active campaign — otherwise a
    // stale editor/RT bound to the previous campaign desyncs listPages from the editor we navigate.
    await reconnectRoll20({ hard: false }).catch(() => {});
  }
  const campaign = getActiveCampaign();
  const outDir = dataPath(path.join("wall-dataset", "raw", toSlug(campaign.name)));
  mkdirSync(outDir, { recursive: true });
  console.error(`\n[harvest] campaign "${campaign.name}" (${campaign.roll20CampaignId})${opts.capture ? " [render-capture]" : ""} → ${outDir}\n`);

  // Pages straight from RTDB (no relay/Mod) — zero relay calls, works on any campaign with/without
  // the Mod. IMPORTANT: do this RTDB read FIRST so the RT custom-token harvest (which calls
  // closeBrowser() once per campaign) happens BEFORE we acquire the editor page — otherwise it
  // closes the very browser the capture needs ("Target closed"). Token is cached after this, so the
  // editor page acquired next stays alive for all captures this campaign.
  const pagesObj = await rtGet<Record<string, { id: string; name: string; width: number; height: number }>>("pages");
  let pages: PageInfo[] = Object.values(pagesObj ?? {}).map(p => ({ id: p.id, name: p.name, width: p.width, height: p.height }));
  if (opts.page) pages = pages.filter(p => p.id === opts.page);
  if (opts.pageIds?.length) pages = pages.filter(p => opts.pageIds!.includes(p.id));
  console.error(`[harvest] ${pages.length} page(s) to scan\n`);

  // Now acquire the editor page (token cached → no further closeBrowser this campaign).
  let editorPage: Page | undefined;
  if (opts.capture) {
    try { editorPage = await getEditorPage(); }
    catch { await reconnectRoll20({ hard: true }).catch(() => {}); editorPage = await getEditorPage(); }
  }

  const emitted: HarvestRecord[] = [];
  const skipped: { pageId: string; pageName: string; skipped: string }[] = [];
  for (const page of pages) {
    try {
      const res = await harvestPage(page, campaign, outDir, opts.imageUrl, editorPage, opts.source);
      if ("skipped" in res) {
        skipped.push(res);
        console.error(`  · ${page.name} — skip (${res.skipped})`);
      } else {
        emitted.push(res);
        const fl = res.flags.length ? ` [${res.flags.join(", ")}]` : "";
        console.error(`  ✓ ${page.name} — ${res.walls.length} walls, ${res.doors.length}d/${res.windows.length}w${fl}`);
      }
    } catch (err) {
      skipped.push({ pageId: page.id, pageName: page.name, skipped: `error:${String(err).slice(0, 80)}` });
      console.error(`  ✗ ${page.name} — ERROR ${String(err).slice(0, 120)}`);
    }
    if (opts.limit && emitted.length >= opts.limit) break;
  }

  writeFileSync(path.join(outDir, "_manifest.json"), JSON.stringify({
    campaign: { slug: campaign.slug, name: campaign.name, roll20CampaignId: campaign.roll20CampaignId },
    harvestedAt: new Date().toISOString(),
    emitted: emitted.map(e => ({ pageId: e.pageId, pageName: e.pageName, imageFile: e.imageFile, assetId: e.assetId, walls: e.walls.length, flags: e.flags })),
    skipped,
  }, null, 2));

  console.error(`\n[harvest] done: ${emitted.length} emitted, ${skipped.length} skipped → ${outDir}`);
  return emitted.length;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  harvest(parseArgs(process.argv.slice(2)))
    .then(n => process.exit(n > 0 ? 0 : 1))
    .catch(e => { console.error("❌ harvest crashed:", e); process.exit(1); });
}
