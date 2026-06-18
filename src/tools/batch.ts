import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readdirSync, writeFileSync } from "fs";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import * as roll20 from "../bridge/roll20.js";
import { prepareImage, analyzeImageTwoPass, detectGridByAutocorrelation, processWalls, HoughCandidate, Wall as VisionWall } from "./vision.js";
import { ASSET_BASE } from "./maps.js";

const execFileAsync = promisify(execFile);

// Python venv that has scikit-image installed — mirrors the image-analysis MCP config.
const IMAGE_ANALYSIS_DIR = path.resolve(
  process.env.IMAGE_ANALYSIS_DIR ?? path.join(process.cwd(), "..", "image-analysis-mcp")
);
const PYTHON_EXE  = process.env.IMAGE_ANALYSIS_PYTHON ?? path.join(IMAGE_ANALYSIS_DIR, ".venv", "Scripts", "python.exe");
const PYTHON_SCRIPT = path.join(IMAGE_ANALYSIS_DIR, "server.py");

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const ROLL20_CELL_PX = 70;
const WALL_OPTS = { endpointInsetPx: 5, cornerOverlapPx: 4, cornerThresholdPx: 10, maxSegmentPx: 200 };

interface CVResult {
  imageDimensions: string; // e.g. "1786×1786px"
  gridSizePx: number;
  gridOffsetX: number;
  gridOffsetY: number;
  cols: number;
  rows: number;
  candidates: HoughCandidate[];
}

type Wall = VisionWall;

function parseDimension(s: string): { w: number; h: number } {
  // "1786×1786px" — the × character may be a Unicode multiplication sign
  const m = s.replace(/[^\d]+/g, " ").trim().split(/\s+/);
  return { w: parseInt(m[0] ?? "0"), h: parseInt(m[1] ?? m[0] ?? "0") };
}

async function runCV(imagePath: string): Promise<CVResult> {
  const { stdout } = await execFileAsync(PYTHON_EXE, [PYTHON_SCRIPT, imagePath], {
    maxBuffer: 10_000_000,
    timeout: 45_000,
  });
  return JSON.parse(stdout) as CVResult;
}

export function registerBatchTools(server: McpServer): void {
  server.tool(
    "batch_import_maps",
    "Process a folder of battlemap images into Roll20 pages: CV grid detection → wall placement → page creation → image upload. One Roll20 page per image. wallMode controls how walls are placed.",
    {
      folderPath: z.string().default(".").describe("Subfolder within the asset base (data/maps). Use '.' for the root, or a relative subfolder like 'CoS'."),
      pageNamePrefix: z.string().optional().describe("Optional prefix for page names, e.g. 'CoS' → 'CoS - Tavern'."),
      wallMode: z.enum(["none", "hough", "llm"]).default("hough").describe("none: import image only, no walls. hough: place Python CV Hough candidates as walls (fast, free, rough). llm: full LLM wall tracing (slow, paid, best quality)."),
      skipExisting: z.boolean().default(true).describe("Skip images where a Roll20 page with that name already exists."),
      reuseExisting: z.boolean().default(false).describe("If a page with this name already exists, reuse it (skip page creation) but still upload the image and place walls. Useful for resuming a batch where pages were created but uploads failed."),
      dryRun: z.boolean().default(false).describe("Analyse images but skip page creation, upload, and wall placement. Returns what would be created."),
      fileFilter: z.string().optional().describe("Case-insensitive substring filter on filenames, e.g. 'tavern'."),
      excludeFilter: z.string().optional().describe("Case-insensitive substring exclusion — skip any filename containing this string, e.g. 'clank'."),
      sampleSize: z.number().int().positive().optional().describe("Randomly sample N images from the matched list instead of processing all of them."),
    },
    async ({ folderPath, pageNamePrefix, wallMode, skipExisting, reuseExisting, dryRun, fileFilter, excludeFilter, sampleSize }) => {
      // Confine to asset base
      const absFolder = path.resolve(ASSET_BASE, folderPath);
      if (absFolder !== ASSET_BASE && !absFolder.startsWith(ASSET_BASE + path.sep)) {
        return { content: [{ type: "text", text: JSON.stringify({ error: `Folder escapes asset base: ${absFolder}` }) }] };
      }

      let entries: string[];
      try {
        entries = readdirSync(absFolder)
          .filter(f => IMAGE_EXTS.has(path.extname(f).toLowerCase()))
          .filter(f => !fileFilter    || f.toLowerCase().includes(fileFilter.toLowerCase()))
          .filter(f => !excludeFilter || !f.toLowerCase().includes(excludeFilter.toLowerCase()))
          .sort();
        if (sampleSize && sampleSize < entries.length) {
          for (let i = entries.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [entries[i], entries[j]] = [entries[j]!, entries[i]!];
          }
          entries = entries.slice(0, sampleSize).sort();
        }
      } catch (err) {
        return { content: [{ type: "text", text: JSON.stringify({ error: `Cannot read folder: ${String(err)}` }) }] };
      }

      if (entries.length === 0) {
        return { content: [{ type: "text", text: JSON.stringify({ error: "No image files found", folder: absFolder, filter: fileFilter }) }] };
      }

      // Pre-load existing pages for skip/reuse checks
      let existingPages: { id: string; name: string }[] = [];
      let existingPageNames = new Set<string>();
      if ((skipExisting || reuseExisting) && !dryRun) {
        try {
          existingPages = await roll20.relayCommand<{ id: string; name: string }[]>({ action: "listPages" });
          existingPageNames = new Set(existingPages.map(p => p.name.toLowerCase()));
        } catch { /* non-fatal */ }
      }

      const results: object[] = [];
      let successCount = 0, skipCount = 0, failCount = 0;
      const progressPath = path.join(process.cwd(), "data", "batch-progress.json");
      const writeProgress = (current: string, phase: string) => {
        try {
          writeFileSync(progressPath, JSON.stringify({
            current, phase, done: results.length, total: entries.length,
            success: successCount, failed: failCount, skipped: skipCount,
            updatedAt: new Date().toISOString(), results,
          }, null, 2));
        } catch { /* non-fatal */ }
      };

      const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

      for (const filename of entries) {
        const imagePath = path.join(absFolder, filename);
        const baseName = path.basename(filename, path.extname(filename));
        const pageName = pageNamePrefix ? `${pageNamePrefix} - ${baseName}` : baseName;

        if (!dryRun && skipExisting && existingPageNames.has(pageName.toLowerCase())) {
          results.push({ image: filename, pageName, status: "skipped", reason: "page already exists" });
          skipCount++;
          continue;
        }

        try {
          // ── 1. CV: FFT grid detection + Hough wall candidates ──────────────────
          writeProgress(filename, "cv-analysis");
          const cv = await runCV(imagePath);
          const { w: origW, h: origH } = parseDimension(cv.imageDimensions);

          // ── 2. Wall analysis (mode-dependent) ──────────────────────────────────
          let wSq: number;
          let hSq: number;
          let walls: Wall[] = [];  // already in Roll20 canvas-pixel space

          if (wallMode === "llm") {
            writeProgress(filename, "llm-wall-trace");
            // TS autocorrelation is more reliable than Python FFT for artistic maps;
            // scale candidates to analysis-image space for the LLM overlay but don't
            // pass cv.gridSizePx as override.
            const info = await prepareImage(imagePath, 1500);
            const candScaleX = origW > 0 ? info.widthPx  / origW : 1;
            const candScaleY = origH > 0 ? info.heightPx / origH : 1;
            const scaledCandidates: HoughCandidate[] = cv.candidates.map(c => ({
              from:        [c.from[0] * candScaleX, c.from[1] * candScaleY] as [number, number],
              to:          [c.to[0]   * candScaleX, c.to[1]   * candScaleY] as [number, number],
              length:      (c.length ?? 0) * ((candScaleX + candScaleY) / 2),
              confidence:  c.confidence,
              orientation: c.orientation,
            }));
            const analysis = await analyzeImageTwoPass(info, undefined, scaledCandidates);
            wSq = Math.max(1, Math.round((info.widthPx  - analysis.gridOffsetX) / analysis.gridSizePx));
            hSq = Math.max(1, Math.round((info.heightPx - analysis.gridOffsetY) / analysis.gridSizePx));
            const maxX = wSq * ROLL20_CELL_PX, maxY = hSq * ROLL20_CELL_PX;
            const sx = (wSq * ROLL20_CELL_PX) / info.widthPx;
            const sy = (hSq * ROLL20_CELL_PX) / info.heightPx;
            walls = analysis.walls.map(w => ({
              from:     [clamp(w.from[0] * sx, 0, maxX), clamp(w.from[1] * sy, 0, maxY)] as [number, number],
              to:       [clamp(w.to[0]   * sx, 0, maxX), clamp(w.to[1]   * sy, 0, maxY)] as [number, number],
              color:    w.color,
              category: w.category,
            }));
          } else {
            // hough or none — run TS autocorrelation for reliable grid sizing (no LLM, no cost)
            const info = await prepareImage(imagePath, 1500);
            const grid = await detectGridByAutocorrelation(info.buffer);
            wSq = Math.max(1, Math.round((info.widthPx  - grid.gridOffsetX) / grid.gridSizePx));
            hSq = Math.max(1, Math.round((info.heightPx - grid.gridOffsetY) / grid.gridSizePx));
            if (wallMode === "hough" && cv.candidates.length > 0) {
              const maxX = wSq * ROLL20_CELL_PX, maxY = hSq * ROLL20_CELL_PX;
              // Candidates are in original-image pixels; scale to Roll20 canvas
              const sx = origW > 0 ? (wSq * ROLL20_CELL_PX) / origW : 1;
              const sy = origH > 0 ? (hSq * ROLL20_CELL_PX) / origH : 1;
              walls = cv.candidates.map(c => ({
                from: [clamp(c.from[0] * sx, 0, maxX), clamp(c.from[1] * sy, 0, maxY)] as [number, number],
                to:   [clamp(c.to[0]   * sx, 0, maxX), clamp(c.to[1]   * sy, 0, maxY)] as [number, number],
              }));
            }
          }

          if (dryRun) {
            results.push({ image: filename, pageName, status: "dry-run", wallMode, pageWidthSquares: wSq, pageHeightSquares: hSq, wallCount: walls.length });
            successCount++;
            continue;
          }

          // ── 3. Create Roll20 page (or reuse existing one) ──────────────────────
          writeProgress(filename, "creating-page");
          let pageId: string;
          const existingPage = reuseExisting
            ? existingPages.find(p => p.name.toLowerCase() === pageName.toLowerCase())
            : undefined;
          if (existingPage) {
            pageId = existingPage.id;
          } else {
            pageId = await roll20.createPageViaUI(pageName, wSq, hSq, 5, "ft");
          }
          await roll20.relayCommand({
            action: "setPageProps", pageId,
            width: wSq, height: hSq,
            scale_number: 5, scale_units: "ft", showgrid: true,
          });

          // ── 4. Upload image + place as full-page map graphic ───────────────────
          // Brief pause so Roll20's UI finishes transitioning to the new page before
          // we open the art library — without this the file input isn't ready and the
          // upload silently never fires (no reqimage request in the debug log).
          await new Promise(r => setTimeout(r, 2500));
          writeProgress(filename, "uploading-art");
          const imgsrc = await roll20.uploadArt(imagePath);
          await roll20.relayCommand({
            action: "createGraphic", pageId, imgsrc, layer: "map",
            left:   (wSq * ROLL20_CELL_PX) / 2,
            top:    (hSq * ROLL20_CELL_PX) / 2,
            width:   wSq * ROLL20_CELL_PX,
            height:  hSq * ROLL20_CELL_PX,
          });

          // ── 5. Process + place DL walls ────────────────────────────────────────
          let placed = 0;
          if (walls.length > 0) {
            writeProgress(filename, "placing-walls");
            const processed = processWalls(walls, WALL_OPTS);
            const BATCH = 20;
            for (let i = 0; i < processed.length; i += BATCH) {
              const chunk = processed.slice(i, i + BATCH);
              const wallDefs = chunk.map(w => ({ x1: w.from[0], y1: w.from[1], x2: w.to[0], y2: w.to[1], stroke: "#0044FF" }));
              const r = await roll20.relayCommand<{ id?: string }[]>({ action: "createWalls", pageId, walls: wallDefs });
              placed += r.filter(x => x.id).length;
            }
          }

          existingPageNames.add(pageName.toLowerCase());
          results.push({ image: filename, pageName, pageId, status: "success", wallMode, pageWidthSquares: wSq, pageHeightSquares: hSq, wallsPlaced: placed });
          successCount++;
        } catch (err) {
          results.push({ image: filename, pageName, status: "failed", error: String(err) });
          failCount++;
        }
      }

      writeProgress("done", "complete");
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ summary: { total: entries.length, success: successCount, skipped: skipCount, failed: failCount, wallMode }, results }, null, 2),
        }],
      };
    }
  );
}
