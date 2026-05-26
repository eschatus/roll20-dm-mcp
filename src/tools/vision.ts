import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readFileSync, writeFileSync } from "fs";
import * as path from "path";
import sharp from "sharp";
import Anthropic from "@anthropic-ai/sdk";
import * as roll20 from "../bridge/roll20.js";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const VISION_MODEL = "claude-sonnet-4-6";
const DEFAULT_MAX_DIM = 1500;
const MAX_TOKENS_HARD_LIMIT = 50_000;

// ─── Types ────────────────────────────────────────────────────────────────────

type Point = [number, number];

interface Wall {
  from: Point;
  to: Point;
  color?: string;       // optional per-wall color override
  category?: "exterior" | "interior";
}

interface Opening {
  center: Point;
  widthPx: number;
  angleDeg: number;
}

interface MapAnalysis {
  gridSizePx: number;
  gridOffsetX: number;
  gridOffsetY: number;
  walls: Wall[];
  doors: Opening[];
  windows: Opening[];
  secretDoors: Opening[];
}

interface GridInfo {
  gridSizePx: number;
  gridOffsetX: number;
  gridOffsetY: number;
  cols: number;
  rows: number;
}

interface Room {
  name: string;
  cells: string[];
  function: string;
  hasEntrance: boolean;
  isDeadSpace: boolean;
}

interface ImageInfo {
  buffer: Buffer;
  mediaType: "image/png" | "image/jpeg";
  widthPx: number;
  heightPx: number;
  estimatedTokens: number;
}

// ─── Wall geometry helpers ────────────────────────────────────────────────────

function dist(a: Point, b: Point): number {
  return Math.sqrt((b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2);
}

function dir(a: Point, b: Point): Point {
  const d = dist(a, b);
  if (d === 0) return [0, 0];
  return [(b[0] - a[0]) / d, (b[1] - a[1]) / d];
}

function ptKey(p: Point): string {
  return `${Math.round(p[0])},${Math.round(p[1])}`;
}

function classifyEndpoints(walls: Wall[], cornerThresholdPx: number): Set<string> {
  const corners = new Set<string>();
  const allPoints = walls.flatMap((w) => [w.from, w.to]);
  for (let i = 0; i < allPoints.length; i++) {
    for (let j = 0; j < allPoints.length; j++) {
      if (i === j) continue;
      if (dist(allPoints[i], allPoints[j]) <= cornerThresholdPx) {
        corners.add(ptKey(allPoints[i]));
        break;
      }
    }
  }
  return corners;
}

function adjustEndpoints(wall: Wall, corners: Set<string>, endpointInsetPx: number, cornerOverlapPx: number): Wall {
  const d = dir(wall.from, wall.to);
  const fromIsCorner = corners.has(ptKey(wall.from));
  const toIsCorner = corners.has(ptKey(wall.to));
  const fromDelta = fromIsCorner ? -cornerOverlapPx : endpointInsetPx;
  const toDelta = toIsCorner ? cornerOverlapPx : -endpointInsetPx;
  return {
    ...wall,
    from: [wall.from[0] + d[0] * fromDelta, wall.from[1] + d[1] * fromDelta],
    to: [wall.to[0] + d[0] * toDelta, wall.to[1] + d[1] * toDelta],
  };
}

function splitSegment(wall: Wall, maxLengthPx: number): Wall[] {
  const length = dist(wall.from, wall.to);
  if (length <= maxLengthPx) return [wall];
  const d = dir(wall.from, wall.to);
  const numChunks = Math.ceil(length / maxLengthPx);
  const chunkLen = length / numChunks;
  return Array.from({ length: numChunks }, (_, i) => ({
    ...wall,
    from: [wall.from[0] + d[0] * chunkLen * i, wall.from[1] + d[1] * chunkLen * i] as Point,
    to: [wall.from[0] + d[0] * chunkLen * (i + 1), wall.from[1] + d[1] * chunkLen * (i + 1)] as Point,
  }));
}

function processWalls(walls: Wall[], opts: { endpointInsetPx: number; cornerOverlapPx: number; cornerThresholdPx: number; maxSegmentPx: number }): Wall[] {
  const corners = classifyEndpoints(walls, opts.cornerThresholdPx);
  return walls
    .map((w) => adjustEndpoints(w, corners, opts.endpointInsetPx, opts.cornerOverlapPx))
    .flatMap((w) => splitSegment(w, opts.maxSegmentPx));
}

// ─── Image helpers ────────────────────────────────────────────────────────────

export async function prepareImage(imagePath: string, maxDimPx: number): Promise<ImageInfo> {
  const raw = readFileSync(imagePath);
  const ext = imagePath.split(".").pop()?.toLowerCase();
  const mediaType: "image/png" | "image/jpeg" = ext === "png" ? "image/png" : "image/jpeg";
  const meta = await sharp(raw).metadata();
  const origW = meta.width ?? 0;
  const origH = meta.height ?? 0;
  let buffer: Buffer;
  let finalW: number;
  let finalH: number;
  if (origW > maxDimPx || origH > maxDimPx) {
    const scale = maxDimPx / Math.max(origW, origH);
    finalW = Math.round(origW * scale);
    finalH = Math.round(origH * scale);
    buffer = await sharp(raw).resize(finalW, finalH, { fit: "inside" }).toBuffer();
  } else {
    buffer = raw;
    finalW = origW;
    finalH = origH;
  }
  const estimatedTokens = Math.ceil(finalW / 1092) * Math.ceil(finalH / 1092) * 1600;
  return { buffer, mediaType, widthPx: finalW, heightPx: finalH, estimatedTokens };
}

// ─── Grid overlay ─────────────────────────────────────────────────────────────

const COL_LABELS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
function colLabel(c: number): string {
  return c < 26 ? COL_LABELS[c] : `${COL_LABELS[Math.floor(c / 26) - 1]}${COL_LABELS[c % 26]}`;
}

// Preprocess for vision: isolate thick dark structural edges (walls) from mid-tone noise (furniture, rugs, floor texture).
// .linear(1.4, -40): pixels below ~107/255 crush to black (walls stay dark), above that wash out (furniture lightens).
// .blur(1.5): smooth fine texture before re-sharpening.
// .sharpen({ sigma:2, m1:0, m2:3 }): re-crisp only strong edges (structural walls), not fine texture.
async function preprocessForVision(buffer: Buffer): Promise<Buffer> {
  return sharp(buffer)
    .grayscale()
    .linear(1.4, -40)
    .blur(1.5)
    .sharpen({ sigma: 2.0, m1: 0, m2: 3 })
    .png()
    .toBuffer();
}

async function drawGridOverlay(buffer: Buffer, widthPx: number, heightPx: number, grid: GridInfo): Promise<Buffer> {
  const { gridSizePx: gs, gridOffsetX: ox, gridOffsetY: oy, cols, rows } = grid;
  const fontSize = Math.max(9, Math.min(14, Math.round(gs * 0.2)));
  const lineColor = "rgba(255,220,0,0.55)";
  const labelColor = "#FFE000";

  const parts: string[] = [];

  // Grid lines
  for (let c = 0; c <= cols; c++) {
    const x = ox + c * gs;
    parts.push(`<line x1="${x}" y1="0" x2="${x}" y2="${heightPx}" stroke="${lineColor}" stroke-width="1"/>`);
  }
  for (let r = 0; r <= rows; r++) {
    const y = oy + r * gs;
    parts.push(`<line x1="0" y1="${y}" x2="${widthPx}" y2="${y}" stroke="${lineColor}" stroke-width="1"/>`);
  }

  // Column labels (above grid)
  for (let c = 0; c < cols; c++) {
    const x = ox + (c + 0.5) * gs;
    const y = Math.max(fontSize + 1, oy - 3);
    parts.push(`<text x="${x}" y="${y}" fill="${labelColor}" font-size="${fontSize}" text-anchor="middle" font-weight="bold" font-family="monospace">${colLabel(c)}</text>`);
  }

  // Row labels (left of grid)
  for (let r = 0; r < rows; r++) {
    const x = Math.max(fontSize, ox - 4);
    const y = oy + (r + 0.5) * gs + fontSize * 0.35;
    parts.push(`<text x="${x}" y="${y}" fill="${labelColor}" font-size="${fontSize}" text-anchor="middle" font-weight="bold" font-family="monospace">${r + 1}</text>`);
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${widthPx}" height="${heightPx}">\n${parts.join("\n")}\n</svg>`;
  return sharp(buffer).composite([{ input: Buffer.from(svg), blend: "over" }]).png().toBuffer();
}

interface HoughCandidate {
  from: [number, number];
  to: [number, number];
  length?: number;
  confidence?: number;
  orientation?: string;
}

// Draw Hough candidate line segments as bright orange lines on the image.
// High-confidence candidates (≥0.8) are drawn thicker so the model can distinguish them.
async function drawCandidateOverlay(buffer: Buffer, widthPx: number, heightPx: number, candidates: HoughCandidate[]): Promise<Buffer> {
  const parts = candidates.map((c) => {
    const thick = (c.confidence ?? 0) >= 0.8 ? 3 : 2;
    return `<line x1="${c.from[0]}" y1="${c.from[1]}" x2="${c.to[0]}" y2="${c.to[1]}" stroke="#FF6600" stroke-width="${thick}" stroke-linecap="round" opacity="0.85"/>`;
  });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${widthPx}" height="${heightPx}">\n${parts.join("\n")}\n</svg>`;
  return sharp(buffer).composite([{ input: Buffer.from(svg), blend: "over" }]).png().toBuffer();
}

// ─── Grid auto-detection ──────────────────────────────────────────────────────
//
// Strategy:
//  1. Compute per-column and per-row pixel means, then their gradient magnitude.
//  2. Autocorrelate the gradient signal to find the dominant spatial periodicity — that's the grid cell size.
//  3. Scan from each image border to find the first strong edge (building wall) = grid offset.
//  4. Fall back to knownGridSizePx if autocorrelation finds no clear peak.
//
async function detectGridByAutocorrelation(
  buffer: Buffer,
  widthPx: number,
  heightPx: number,
  knownGridSizePx = 70,
): Promise<{ gridSizePx: number; gridOffsetX: number; gridOffsetY: number; cols: number; rows: number }> {
  const { data, info } = await sharp(buffer).grayscale().raw().toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height;

  const colMeans = new Float64Array(W);
  const rowMeans = new Float64Array(H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const v = data[y * W + x];
      colMeans[x] += v;
      rowMeans[y] += v;
    }
  }
  for (let x = 0; x < W; x++) colMeans[x] /= H;
  for (let y = 0; y < H; y++) rowMeans[y] /= W;

  const absGrad = (arr: Float64Array): Float64Array => {
    const g = new Float64Array(arr.length);
    for (let i = 1; i < arr.length - 1; i++) g[i] = Math.abs(arr[i + 1] - arr[i - 1]) * 0.5;
    return g;
  };

  // Autocorrelate a gradient signal and return the first prominent peak in [minLag, maxLag].
  // A peak is prominent if it's a local maximum and exceeds 20% of the zero-lag value.
  const findPeriodByAutocorrelation = (grad: Float64Array, minLag: number, maxLag: number): number | null => {
    const N = grad.length;
    const clampedMax = Math.min(maxLag, Math.floor(N / 2));
    if (clampedMax < minLag) return null;

    // Compute mean-subtracted autocorrelation
    let mean = 0;
    for (let i = 0; i < N; i++) mean += grad[i];
    mean /= N;

    const acf = new Float64Array(clampedMax + 1);
    for (let lag = 0; lag <= clampedMax; lag++) {
      let sum = 0;
      for (let i = 0; i < N - lag; i++) sum += (grad[i] - mean) * (grad[i + lag] - mean);
      acf[lag] = sum / (N - lag);
    }

    const zeroPower = acf[0];
    if (zeroPower <= 0) return null;
    const threshold = zeroPower * 0.20;

    // Find first local maximum in [minLag, clampedMax] that exceeds threshold
    for (let lag = minLag; lag < clampedMax - 1; lag++) {
      if (acf[lag] > threshold && acf[lag] >= acf[lag - 1] && acf[lag] >= acf[lag + 1]) {
        return lag;
      }
    }
    return null;
  };

  // Scan from the image border inward (max 40% of image) to find the first edge that
  // exceeds 30% of the axis maximum. This is the exterior building wall.
  const findFirstEdge = (grad: Float64Array): number => {
    const maxVal = Math.max(...grad);
    if (maxVal === 0) return 0;
    const thresh = maxVal * 0.30;
    const limit = Math.floor(grad.length * 0.40);
    for (let i = 0; i < limit; i++) {
      if (grad[i] >= thresh) return i;
    }
    return 0;
  };

  const colGrad = absGrad(colMeans);
  const rowGrad = absGrad(rowMeans);

  // Try to detect grid size from horizontal and vertical signals independently, then pick the best.
  // Search range: 20–120px to cover most battlemap scales (36px cells at 1× up to 100px at large scale).
  const detectedH = findPeriodByAutocorrelation(colGrad, 20, 120);
  const detectedV = findPeriodByAutocorrelation(rowGrad, 20, 120);

  let gridSizePx: number;
  if (detectedH !== null && detectedV !== null) {
    // Average both axes — they should agree closely
    gridSizePx = Math.round((detectedH + detectedV) / 2);
  } else if (detectedH !== null) {
    gridSizePx = detectedH;
  } else if (detectedV !== null) {
    gridSizePx = detectedV;
  } else {
    // No clear periodicity detected — fall back to known value
    gridSizePx = knownGridSizePx;
  }

  const gridOffsetX = findFirstEdge(colGrad);
  const gridOffsetY = findFirstEdge(rowGrad);
  const cols = Math.max(1, Math.floor((W - gridOffsetX) / gridSizePx));
  const rows = Math.max(1, Math.floor((H - gridOffsetY) / gridSizePx));

  return { gridSizePx, gridOffsetX, gridOffsetY, cols, rows };
}

// ─── Grid ↔ pixel conversion ──────────────────────────────────────────────────

function gridToPixel(col: number, row: number, grid: GridInfo): Point {
  return [grid.gridOffsetX + col * grid.gridSizePx, grid.gridOffsetY + row * grid.gridSizePx];
}

function gridAnalysisToPixels(
  walls: { from: Point; to: Point; category?: "exterior" | "interior" }[],
  doors: { center: Point; widthCells: number; angleDeg: number }[],
  windows: typeof doors,
  secretDoors: typeof doors,
  grid: GridInfo
): Pick<MapAnalysis, "walls" | "doors" | "windows" | "secretDoors"> {
  const g = (p: Point) => gridToPixel(p[0], p[1], grid);
  const EXTERIOR_COLOR = "#FF4444";
  const INTERIOR_COLOR = "#4488FF";
  return {
    walls: walls.map((w) => ({
      from: g(w.from),
      to: g(w.to),
      category: w.category,
      color: w.category === "exterior" ? EXTERIOR_COLOR : w.category === "interior" ? INTERIOR_COLOR : undefined,
    })),
    doors: doors.map((o) => ({ center: g(o.center), widthPx: o.widthCells * grid.gridSizePx, angleDeg: o.angleDeg })),
    windows: windows.map((o) => ({ center: g(o.center), widthPx: o.widthCells * grid.gridSizePx, angleDeg: o.angleDeg })),
    secretDoors: secretDoors.map((o) => ({ center: g(o.center), widthPx: o.widthCells * grid.gridSizePx, angleDeg: o.angleDeg })),
  };
}

// ─── Gap cutting ──────────────────────────────────────────────────────────────
// Remove the portion of each wall segment that overlaps an opening (door/window).
// Works in grid coordinates before pixel conversion.

function cutGapsInWalls(
  walls: { from: Point; to: Point; category?: "exterior" | "interior" }[],
  openings: { from: Point; to: Point }[],
  axisSnapPx = 0.05,
): typeof walls {
  const EPS = 0.05;

  function overlapCut(
    wall: { from: Point; to: Point; category?: "exterior" | "interior" },
    opening: { from: Point; to: Point },
  ): typeof walls {
    const isVertical = Math.abs(wall.from[0] - wall.to[0]) < EPS;
    const isHoriz = Math.abs(wall.from[1] - wall.to[1]) < EPS;
    const oVertical = Math.abs(opening.from[0] - opening.to[0]) < EPS;
    const oHoriz = Math.abs(opening.from[1] - opening.to[1]) < EPS;

    // Must be same orientation and same axis value (use axisSnapPx to tolerate slight misalignment)
    if (isVertical && oVertical) {
      if (Math.abs(wall.from[0] - opening.from[0]) > axisSnapPx) return [wall];
      const wMin = Math.min(wall.from[1], wall.to[1]);
      const wMax = Math.max(wall.from[1], wall.to[1]);
      const gMin = Math.max(Math.min(opening.from[1], opening.to[1]), wMin);
      const gMax = Math.min(Math.max(opening.from[1], opening.to[1]), wMax);
      if (gMax <= gMin + EPS) return [wall];
      const x = wall.from[0];
      const result: typeof walls = [];
      if (gMin - wMin > EPS) result.push({ ...wall, from: [x, wMin], to: [x, gMin] });
      if (wMax - gMax > EPS) result.push({ ...wall, from: [x, gMax], to: [x, wMax] });
      return result.length ? result : [wall];
    }
    if (isHoriz && oHoriz) {
      if (Math.abs(wall.from[1] - opening.from[1]) > axisSnapPx) return [wall];
      const wMin = Math.min(wall.from[0], wall.to[0]);
      const wMax = Math.max(wall.from[0], wall.to[0]);
      const gMin = Math.max(Math.min(opening.from[0], opening.to[0]), wMin);
      const gMax = Math.min(Math.max(opening.from[0], opening.to[0]), wMax);
      if (gMax <= gMin + EPS) return [wall];
      const y = wall.from[1];
      const result: typeof walls = [];
      if (gMin - wMin > EPS) result.push({ ...wall, from: [wMin, y], to: [gMin, y] });
      if (wMax - gMax > EPS) result.push({ ...wall, from: [gMax, y], to: [wMax, y] });
      return result.length ? result : [wall];
    }
    return [wall];
  }

  let result = [...walls];
  for (const opening of openings) {
    const next: typeof walls = [];
    for (const wall of result) next.push(...overlapCut(wall, opening));
    result = next;
  }
  return result;
}

// ─── Vision passes ────────────────────────────────────────────────────────────

async function callVision(imageBuffer: Buffer, mediaType: "image/png" | "image/jpeg", prompt: string, maxTokens = 2048): Promise<string> {
  const response = await anthropic.messages.create({
    model: VISION_MODEL,
    max_tokens: maxTokens,
    messages: [{
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: mediaType, data: imageBuffer.toString("base64") } },
        { type: "text", text: prompt },
      ],
    }],
  });
  return response.content[0].type === "text" ? response.content[0].text : "";
}

function parseJson<T>(text: string, context: string): T {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`${context}: no JSON in response. Raw: ${text.slice(0, 400)}`);
  const cleaned = match[0]
    .replace(/\/\/[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/,(\s*[}\]])/g, "$1")
    .replace(/"([^"]+)">/g, '"$1":');
  try {
    return JSON.parse(cleaned) as T;
  } catch (e) {
    const pos = (e instanceof SyntaxError && e.message.match(/position (\d+)/)?.[1]) ?? "?";
    const n = typeof pos === "string" ? parseInt(pos) : 0;
    throw new Error(`${context}: JSON parse error at ${pos}. Near: ...${cleaned.slice(Math.max(0, n - 40), n + 40)}...`);
  }
}


// Pass 1: compute grid from pixel autocorrelation, then ask vision only for room layout.
async function discoverGridAndRooms(info: ImageInfo): Promise<{ grid: GridInfo; rooms: Room[]; overlaidBuffer: Buffer }> {
  // Grid detection via signal processing — no vision model involved.
  const grid = await detectGridByAutocorrelation(info.buffer, info.widthPx, info.heightPx);

  // Draw the overlay with the computed grid so the model sees labeled cells.
  const overlaidBuffer = await drawGridOverlay(info.buffer, info.widthPx, info.heightPx, grid);

  // Ask vision model to identify rooms only — grid dimensions are provided as ground truth.
  const prompt = `This battlemap has a yellow grid overlay. Grid cell size: ${grid.gridSizePx}px. Grid starts at pixel (${grid.gridOffsetX}, ${grid.gridOffsetY}).
Columns A–${colLabel(grid.cols - 1)} left-to-right (A is leftmost), rows 1–${grid.rows} top-to-bottom (1 is topmost).

List ALL distinct enclosed spaces inside the building. Return ONLY JSON (no markdown):
{
  "rooms": [
    {
      "name": "<short descriptive label>",
      "cells": ["A1","B1","A2","B2"],
      "function": "<inferred purpose>",
      "hasEntrance": <true if any gap, door, arch, or passage connects this space to any adjacent space>,
      "isDeadSpace": <true ONLY for clearly exterior space outside all building walls>
    }
  ]
}

Rules:
- Include EVERY enclosed interior space — small corridors, alcoves, and sub-rooms from interior partition walls all count.
- If an interior partition divides a larger area into two parts, those are TWO separate rooms.
- cells: list every grid cell the room occupies using the labeled column letters and row numbers.
- isDeadSpace: true ONLY for space outside the outermost building walls.`;

  const text = await callVision(overlaidBuffer, "image/png", prompt, 3000);
  const raw = parseJson<{ rooms?: Room[] }>(text, "Pass 1 (rooms)");

  return { grid, rooms: raw.rooms ?? [], overlaidBuffer };
}

// Pass 2: directly trace all walls from the grid-overlaid image.
// No pre-determined room list — the model identifies spatial regions itself via sideA/sideB labels.
// This avoids the "missed sub-room" failure mode where room detection merges distinct spaces.
async function traceWallsDirect(
  overlaidBuffer: Buffer,
  grid: GridInfo,
  houghCandidates?: HoughCandidate[],
): Promise<MapAnalysis & { validation: { isolatedRooms: string[]; notes: string } }> {
  const candidateHint = houghCandidates && houghCandidates.length > 0
    ? `\nORANGE LINES on the image are algorithmically-detected structural edge candidates (Hough transform). Use them as a starting point — they mark where the signal-processing found dark, axis-aligned line segments. You MUST still:
  - Add any structural walls that are missing (especially perimeter walls not covered by orange lines)
  - Reject any orange candidate that is clearly furniture, a rug edge, or floor texture rather than a load-bearing wall
  - Add all doors and windows in their correct positions\n`
    : "";

  const prompt = `This battlemap has a yellow grid overlay. Grid cell size: ${grid.gridSizePx}px.
Columns A–${colLabel(grid.cols - 1)} left-to-right (A=leftmost), rows 1–${grid.rows} top-to-bottom (1=topmost).
Grid corners: [col,row] where [0,0]=top-left of cell A1. Valid range: col 0–${grid.cols}, row 0–${grid.rows}.
${candidateHint}
WALLS ARE: thick continuous black or dark lines forming room boundaries and the building perimeter. A wall must span at least half a grid cell and have a solid, unbroken dark line. When in doubt, omit it — a missing wall is better than a phantom one.

DO NOT TRACE: furniture, tables, chairs, rugs, carpet edges, floor planks, stairs, pillars, bookshelves, decorative borders, shadows, or any object sitting on the floor. These are NOT walls. If a dark line is shorter than half a grid cell or clearly part of an object, skip it.

Trace ALL structural walls — all exterior building walls AND every interior partition (room dividers, corridor walls, alcoves). Leave a gap at every door or window opening.

CRITICAL — gaps: wherever you see a door or window, you MUST leave a physical gap in the wall. Do NOT draw a continuous wall through a doorway. Instead:
  - Emit two separate wall segments: one ending at the near edge of the opening, one starting at the far edge.
  - Also add the opening to the "openings" array with its from/to span.
  Example: wall runs col 0→3 row 2, door at col 1→2 row 2 → emit walls [0,2]→[1,2] and [2,2]→[3,2], opening from [1,2] to [2,2].

Return ONLY JSON (no markdown):
{
  "walls": [
    {"from":[col,row],"to":[col,row],"sideA":"label for space on this side","sideB":"label or 'exterior'"}
  ],
  "openings": [
    {"type":"door"|"window","from":[col,row],"to":[col,row]}
  ],
  "secretDoors": [],
  "validation": {
    "notes": "<brief topology summary: list every distinct enclosed space you found>"
  }
}

Rules:
- sideA/sideB: free-form labels (e.g. "upper-left room", "corridor", "exterior"). sideB="exterior" marks outer walls.
- Every door/window MUST appear in openings[] AND the adjacent wall segments must stop at the opening edges.
- Fractional coords (e.g. [2.5, 3]) are fine for opening endpoints.
- All coords: col ∈ [0, ${grid.cols}], row ∈ [0, ${grid.rows}].`;

  const visionBuffer = await preprocessForVision(overlaidBuffer);
  const text = await callVision(visionBuffer, "image/png", prompt, 8192);

  type RawOpening = { type: "door" | "window"; from: Point; to: Point };
  type RawWall = { from: Point; to: Point; sideA?: string; sideB?: string };
  type RawPass2 = {
    walls?: RawWall[];
    openings?: RawOpening[];
    secretDoors?: { center: Point; widthCells: number; angleDeg: number }[];
    validation?: { notes?: string };
  };
  const raw = parseJson<RawPass2>(text, "Wall tracing");

  // Clamp all grid coords to valid bounds before pixel conversion
  const clampCol = (c: number) => Math.max(0, Math.min(grid.cols, c));
  const clampRow = (r: number) => Math.max(0, Math.min(grid.rows, r));
  const clampPt = (p: Point): Point => [clampCol(p[0]), clampRow(p[1])];

  const rawWalls = (raw.walls ?? [])
    .map((w) => {
      const isExterior = w.sideA === "exterior" || w.sideB === "exterior";
      return {
        from: clampPt(w.from),
        to: clampPt(w.to),
        category: (isExterior ? "exterior" : "interior") as "exterior" | "interior",
      };
    })
    .filter((w) => w.from[0] !== w.to[0] || w.from[1] !== w.to[1]); // drop zero-length

  // Parse openings as from/to grid segments, then derive center+width+angle markers
  type ClampedOpening = { from: Point; to: Point };
  const clampedOpenings: ClampedOpening[] = [];
  const rawDoors: { center: Point; widthCells: number; angleDeg: number }[] = [];
  const rawWindows: typeof rawDoors = [];
  for (const o of raw.openings ?? []) {
    const f = clampPt(o.from);
    const t = clampPt(o.to);
    clampedOpenings.push({ from: f, to: t });
    const dx = t[0] - f[0], dy = t[1] - f[1];
    const widthCells = Math.sqrt(dx * dx + dy * dy);
    const center: Point = [(f[0] + t[0]) / 2, (f[1] + t[1]) / 2];
    const angleDeg = Math.abs(dy) > Math.abs(dx) ? 0 : 90;
    const entry = { center, widthCells: Math.max(0.5, widthCells), angleDeg };
    if (o.type === "window") rawWindows.push(entry); else rawDoors.push(entry);
  }

  // Cut gaps in any wall segments that still run through an opening
  const gappedWalls = cutGapsInWalls(rawWalls, clampedOpenings);

  const converted = gridAnalysisToPixels(gappedWalls, rawDoors, rawWindows, raw.secretDoors ?? [], grid);

  return {
    gridSizePx: grid.gridSizePx,
    gridOffsetX: grid.gridOffsetX,
    gridOffsetY: grid.gridOffsetY,
    ...converted,
    validation: {
      isolatedRooms: [],
      notes: raw.validation?.notes ?? "",
    },
  };
}

// Two-pass pipeline: autocorrelation grid detection → overlay → direct wall tracing.
export async function analyzeImageTwoPass(
  info: ImageInfo,
  knownGridSizePx?: number,
  houghCandidates?: HoughCandidate[],
): Promise<MapAnalysis & {
  rooms: Room[];
  validation: { isolatedRooms: string[]; notes: string };
}> {
  const grid = await detectGridByAutocorrelation(info.buffer, info.widthPx, info.heightPx, knownGridSizePx);
  let overlaidBuffer = await drawGridOverlay(info.buffer, info.widthPx, info.heightPx, grid);
  if (houghCandidates && houghCandidates.length > 0) {
    overlaidBuffer = await drawCandidateOverlay(overlaidBuffer, info.widthPx, info.heightPx, houghCandidates);
  }
  const result = await traceWallsDirect(overlaidBuffer, grid, houghCandidates);
  return { ...result, rooms: [] };
}

// Single-pass legacy pipeline (pixel coordinates, no grid overlay).
async function analyzeImageSinglePass(info: ImageInfo): Promise<MapAnalysis> {
  const prompt = `This image is exactly ${info.widthPx}×${info.heightPx} pixels. All coordinates you return MUST satisfy: 0 ≤ x ≤ ${info.widthPx} and 0 ≤ y ≤ ${info.heightPx}. Do not return any coordinate outside these bounds.

Analyze this battlemap image and return ONLY a JSON object (no markdown, no explanation):
{
  "gridSizePx": <integer>,
  "gridOffsetX": <integer>,
  "gridOffsetY": <integer>,
  "walls": [{"from":[x1,y1],"to":[x2,y2]}],
  "doors": [{"center":[cx,cy],"widthPx":<integer>,"angleDeg":<0|90>}],
  "windows": [{"center":[cx,cy],"widthPx":<integer>,"angleDeg":<0|90>}],
  "secretDoors": []
}

Rules:
- walls: Trace ALL load-bearing walls including diagonals. Leave gaps at openings. 20–80 segments.
- doors: gaps with arc/rectangle/crossbar symbol; err toward detection.
- windows: colored highlights, cutouts, arrow-slits on exterior walls; err toward detection.
- Every coordinate must be within 0–${info.widthPx} (x) and 0–${info.heightPx} (y).`;

  const text = await callVision(info.buffer, info.mediaType, prompt, 4096);
  const raw = parseJson<Partial<MapAnalysis>>(text, "Single-pass analysis");
  return {
    gridSizePx: raw.gridSizePx ?? 140,
    gridOffsetX: raw.gridOffsetX ?? 0,
    gridOffsetY: raw.gridOffsetY ?? 0,
    walls: raw.walls ?? [],
    doors: raw.doors ?? [],
    windows: raw.windows ?? [],
    secretDoors: raw.secretDoors ?? [],
  };
}

// ─── MCP tools ────────────────────────────────────────────────────────────────

export function registerVisionTools(server: McpServer): void {
  server.tool(
    "analyze_battlemap",
    "Analyze a battlemap image using a two-pass vision pipeline: Pass 1 detects the grid and identifies rooms (with entrance validation); Pass 2 extracts walls and openings in grid-snapped coordinates for pixel-perfect placement. Falls back to single-pass pixel-coordinate analysis if pipeline='single'.",
    {
      imagePath: z.string(),
      pipeline: z.enum(["two-pass", "single"]).default("two-pass")
        .describe("'two-pass' (default): grid overlay + room-by-room extraction with entrance validation. 'single': legacy single-call pixel-coordinate analysis."),
      maxDimensionPx: z.number().int().min(500).max(3000).default(DEFAULT_MAX_DIM)
        .describe(`Resize the long side to this many pixels before sending. Default ${DEFAULT_MAX_DIM}.`),
      abortIfTokensExceed: z.number().int().default(MAX_TOKENS_HARD_LIMIT)
        .describe("Refuse to call Vision API if estimated token cost exceeds this. Default 50,000."),
      knownGridSizePx: z.number().int().min(20).max(200).optional()
        .describe("Override grid cell size in source image pixels. Use when autocorrelation detects the wrong size (e.g. pass 36 for a 36px-cell map)."),
      houghAnalysis: z.string().optional()
        .describe("JSON string returned by image-analysis::analyze_image. Candidates are drawn as orange overlay lines before the vision model traces walls — significantly improves accuracy by giving the model geometric hints."),
    },
    async ({ imagePath, pipeline, maxDimensionPx, abortIfTokensExceed, knownGridSizePx, houghAnalysis }) => {
      const info = await prepareImage(imagePath, maxDimensionPx);

      if (info.estimatedTokens > abortIfTokensExceed) {
        return {
          content: [{ type: "text", text: JSON.stringify({
            error: "Image exceeds token limit — aborted",
            imageDimensions: `${info.widthPx}×${info.heightPx}px`,
            estimatedTokens: info.estimatedTokens,
            suggestion: `Lower maxDimensionPx (currently ${maxDimensionPx}) or raise abortIfTokensExceed`,
          }) }],
        };
      }

      if (pipeline === "single") {
        const analysis = await analyzeImageSinglePass(info);
        return {
          content: [{ type: "text", text: JSON.stringify({
            pipeline: "single",
            imageDimensions: `${info.widthPx}×${info.heightPx}px`,
            estimatedTokens: info.estimatedTokens,
            model: VISION_MODEL,
            ...analysis,
            wallCount: analysis.walls.length,
          }) }],
        };
      }

      // Parse Hough candidates from Python MCP if provided
      let houghCandidates: HoughCandidate[] | undefined;
      if (houghAnalysis) {
        try {
          const parsed = JSON.parse(houghAnalysis) as { candidates?: HoughCandidate[] };
          houghCandidates = parsed.candidates;
          // Use grid info from Python MCP if no explicit override
          if (!knownGridSizePx && parsed && typeof (parsed as Record<string, unknown>).gridSizePx === "number") {
            knownGridSizePx = (parsed as Record<string, unknown>).gridSizePx as number;
          }
        } catch { /* ignore malformed input */ }
      }

      // Two-pass
      const analysis = await analyzeImageTwoPass(info, knownGridSizePx, houghCandidates);

      // Auto-save analysis to data/maps/<basename>.analysis.json alongside the image
      try {
        const basename = path.basename(imagePath, path.extname(imagePath));
        const dir = path.dirname(imagePath);
        const savePath = path.join(dir, `${basename}.analysis.json`);
        const saveData = {
          imageDimensions: `${info.widthPx}×${info.heightPx}px`,
          gridSizePx: analysis.gridSizePx,
          gridOffsetX: analysis.gridOffsetX,
          gridOffsetY: analysis.gridOffsetY,
          pageWidthSquares: Math.round((info.widthPx - analysis.gridOffsetX) / analysis.gridSizePx),
          pageHeightSquares: Math.round((info.heightPx - analysis.gridOffsetY) / analysis.gridSizePx),
          wallCount: analysis.walls.length,
          walls: analysis.walls,
          doors: analysis.doors,
          windows: analysis.windows,
          secretDoors: analysis.secretDoors,
        };
        writeFileSync(savePath, JSON.stringify(saveData, null, 2));
      } catch (_) { /* non-fatal */ }

      return {
        content: [{ type: "text", text: JSON.stringify({
          pipeline: "two-pass",
          imageDimensions: `${info.widthPx}×${info.heightPx}px`,
          estimatedTokens: info.estimatedTokens,
          model: VISION_MODEL,
          gridSizePx: analysis.gridSizePx,
          gridOffsetX: analysis.gridOffsetX,
          gridOffsetY: analysis.gridOffsetY,
          rooms: analysis.rooms,
          wallCount: analysis.walls.length,
          walls: analysis.walls,
          doors: analysis.doors,
          windows: analysis.windows,
          secretDoors: analysis.secretDoors,
          validation: analysis.validation,
        }) }],
      };
    }
  );

  server.tool(
    "decorate_openings",
    "Second-pass tool: place colored markers on the Roll20 map layer at door, window, and secret door positions returned by analyze_battlemap. Markers are sized to the opening width. Secret door markers go on the GM layer.",
    {
      pageId: z.string().optional(),
      doors: z.array(z.object({
        center: z.tuple([z.number(), z.number()]),
        widthPx: z.number(),
        angleDeg: z.number(),
      })).default([]),
      windows: z.array(z.object({
        center: z.tuple([z.number(), z.number()]),
        widthPx: z.number(),
        angleDeg: z.number(),
      })).default([]),
      secretDoors: z.array(z.object({
        center: z.tuple([z.number(), z.number()]),
        widthPx: z.number(),
        angleDeg: z.number(),
      })).default([]),
      markerThicknessPx: z.number().default(8),
      sourceImageWidth: z.number().optional(),
      sourceImageHeight: z.number().optional(),
      pageWidthSquares: z.number().optional(),
      pageHeightSquares: z.number().optional(),
    },
    async ({ pageId, doors, windows, secretDoors, sourceImageWidth, sourceImageHeight, pageWidthSquares, pageHeightSquares }) => {
      const activePage = pageId ?? (await roll20.getCurrentPageId());
      const ROLL20_CELL_PX = 70;
      const scaleX = (sourceImageWidth && pageWidthSquares) ? (pageWidthSquares * ROLL20_CELL_PX) / sourceImageWidth : 1;
      const scaleY = (sourceImageHeight && pageHeightSquares) ? (pageHeightSquares * ROLL20_CELL_PX) / sourceImageHeight : 1;
      const maxX = pageWidthSquares ? pageWidthSquares * ROLL20_CELL_PX : Infinity;
      const maxY = pageHeightSquares ? pageHeightSquares * ROLL20_CELL_PX : Infinity;
      const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

      function toDLOpening(o: Opening): { x: number; y: number; x0: number; y0: number; x1: number; y1: number } {
        const cx = clamp(o.center[0] * scaleX, 0, maxX);
        const cy = clamp(o.center[1] * scaleY, 0, maxY);
        const hw = (o.widthPx * scaleX) / 2;
        const rad = (o.angleDeg * Math.PI) / 180;
        const dx = Math.cos(rad) * hw;
        const dy = Math.sin(rad) * hw;
        // Roll20 door/window objects: center at (x, -cy), handles are CENTER-RELATIVE offsets
        // with y negated (Roll20 inverts y-axis)
        return { x: cx, y: -cy, x0: -dx, y0: dy, x1: dx, y1: -dy };
      }

      async function placeDL(openings: Opening[], action: "createDLDoors" | "createDLWindows", color: string): Promise<number> {
        if (!openings.length) return 0;
        const key = action === "createDLDoors" ? "doors" : "windows";
        const defs = openings.map((o) => ({ ...toDLOpening(o), color }));
        const results = await roll20.relayCommand<{ id?: string; error?: string }[]>({
          action, pageId: activePage, [key]: defs,
        });
        return results.filter((r) => r.id).length;
      }

      // Clear any previously placed DL door/window objects before re-placing
      await roll20.relayCommand<{ removed: number }>({ action: "clearDLOpenings", pageId: activePage });

      const placedDoors   = await placeDL(doors,       "createDLDoors",   "#FF0000");
      const placedWindows = await placeDL(windows,     "createDLWindows", "#00FFFF");
      const placedSecrets = await placeDL(secretDoors, "createDLDoors",   "#9932CC");

      return {
        content: [{ type: "text", text: JSON.stringify({
          placed: { doors: placedDoors, windows: placedWindows, secretDoors: placedSecrets },
          failed: { doors: doors.length - placedDoors, windows: windows.length - placedWindows, secretDoors: secretDoors.length - placedSecrets },
        }) }],
      };
    }
  );

  server.tool(
    "auto_place_dl_walls",
    "Place dynamic lighting walls in Roll20 from wall centerlines. Applies endpoint adjustments: dead ends retract, corners overlap. Long walls are split into editable chunks.",
    {
      walls: z.array(z.object({
        from: z.tuple([z.number(), z.number()]),
        to: z.tuple([z.number(), z.number()]),
        color: z.string().optional().describe("Per-wall color override. Takes precedence over strokeColor."),
        category: z.enum(["exterior", "interior"]).optional(),
      })),
      pageId: z.string().optional(),
      sourceImageWidth: z.number().optional(),
      sourceImageHeight: z.number().optional(),
      pageWidthSquares: z.number().optional(),
      pageHeightSquares: z.number().optional(),
      doors: z.array(z.object({
        center: z.tuple([z.number(), z.number()]),
        widthPx: z.number(),
        angleDeg: z.number(),
      })).default([]).describe("Door positions in source image pixels — gaps will be cut in walls at these positions"),
      windows: z.array(z.object({
        center: z.tuple([z.number(), z.number()]),
        widthPx: z.number(),
        angleDeg: z.number(),
      })).default([]).describe("Window positions in source image pixels — gaps will be cut in walls at these positions"),
      endpointInsetPx: z.number().default(5),
      cornerOverlapPx: z.number().default(4),
      cornerThresholdPx: z.number().default(10),
      maxSegmentPx: z.number().default(200),
      strokeColor: z.string().default("#FFFF00"),
    },
    async ({ walls, doors, windows, pageId, sourceImageWidth, sourceImageHeight, pageWidthSquares, pageHeightSquares, endpointInsetPx, cornerOverlapPx, cornerThresholdPx, maxSegmentPx, strokeColor }) => {
      const activePage = pageId ?? (await roll20.getCurrentPageId());
      const ROLL20_CELL_PX = 70;
      const scaleX = (sourceImageWidth && pageWidthSquares) ? (pageWidthSquares * ROLL20_CELL_PX) / sourceImageWidth : 1;
      const scaleY = (sourceImageHeight && pageHeightSquares) ? (pageHeightSquares * ROLL20_CELL_PX) / sourceImageHeight : 1;
      const maxX = pageWidthSquares ? pageWidthSquares * ROLL20_CELL_PX : Infinity;
      const maxY = pageHeightSquares ? pageHeightSquares * ROLL20_CELL_PX : Infinity;
      const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
      const scaleWalls = (ws: typeof walls) => ws.map((w) => ({
        from: [clamp(w.from[0] * scaleX, 0, maxX), clamp(w.from[1] * scaleY, 0, maxY)] as Point,
        to: [clamp(w.to[0] * scaleX, 0, maxX), clamp(w.to[1] * scaleY, 0, maxY)] as Point,
        color: w.color,
        category: w.category,
      }));

      // Convert openings to gap segments in page coords, then cut gaps with snap tolerance
      const toGap = (o: Opening): { from: Point; to: Point } => {
        const cx = o.center[0] * scaleX, cy = o.center[1] * scaleY;
        const hw = (o.widthPx * scaleX) / 2;
        const rad = (o.angleDeg * Math.PI) / 180;
        return { from: [cx - Math.cos(rad) * hw, cy - Math.sin(rad) * hw] as Point,
                 to:   [cx + Math.cos(rad) * hw, cy + Math.sin(rad) * hw] as Point };
      };
      const gaps = [...doors.map(toGap), ...windows.map(toGap)];
      const scaled = scaleWalls(walls);
      const gapped = gaps.length > 0 ? cutGapsInWalls(scaled, gaps, 10) : scaled;

      const processed = processWalls(gapped, { endpointInsetPx, cornerOverlapPx, cornerThresholdPx, maxSegmentPx });

      const BATCH_SIZE = 20;
      let placed = 0;
      const errors: string[] = [];

      for (let i = 0; i < processed.length; i += BATCH_SIZE) {
        const batch = processed.slice(i, i + BATCH_SIZE);
        const wallDefs = batch.map((wall) => ({
          x1: wall.from[0], y1: wall.from[1],
          x2: wall.to[0],   y2: wall.to[1],
          stroke: wall.color ?? strokeColor,
        }));
        try {
          const results = await roll20.relayCommand<{ id?: string; error?: string }[]>({
            action: "createWalls", pageId: activePage, walls: wallDefs,
          });
          for (const r of results) r.id ? placed++ : errors.push(r.error ?? "unknown");
        } catch (err) {
          errors.push(String(err));
        }
      }

      return {
        content: [{ type: "text", text: JSON.stringify({
          inputSegments: walls.length,
          outputSegments: processed.length,
          placed, failed: errors.length, pageId: activePage,
          settings: { endpointInsetPx, cornerOverlapPx, cornerThresholdPx, maxSegmentPx },
          ...(errors.length ? { errors: errors.slice(0, 5) } : {}),
        }) }],
      };
    }
  );

  server.tool(
    "place_polyline_walls",
    "Place an irregular building perimeter as a single multi-vertex DL wall path. Takes an ordered list of polygon vertices (e.g. from detect_exterior polygonPoints) and creates one continuous Roll20 path — ideal for non-rectilinear shapes that would lose fidelity as individual segments.",
    {
      points: z.array(z.tuple([z.number(), z.number()])).describe("Ordered [x, y] vertices in source image pixels. From detect_exterior's polygonPoints field."),
      closed: z.boolean().default(true).describe("Close the path back to the first point"),
      pageId: z.string().optional(),
      sourceImageWidth: z.number().optional(),
      sourceImageHeight: z.number().optional(),
      pageWidthSquares: z.number().optional(),
      pageHeightSquares: z.number().optional(),
      strokeColor: z.string().default("#FFFF00"),
    },
    async ({ points, closed, pageId, sourceImageWidth, sourceImageHeight, pageWidthSquares, pageHeightSquares, strokeColor }) => {
      if (points.length < 2) throw new Error("Need at least 2 points");
      const activePage = pageId ?? (await roll20.getCurrentPageId());
      const ROLL20_CELL_PX = 70;
      const scaleX = (sourceImageWidth && pageWidthSquares) ? (pageWidthSquares * ROLL20_CELL_PX) / sourceImageWidth : 1;
      const scaleY = (sourceImageHeight && pageHeightSquares) ? (pageHeightSquares * ROLL20_CELL_PX) / sourceImageHeight : 1;
      const scaledPoints = points.map(([x, y]) => [x * scaleX, y * scaleY] as Point);

      const result = await roll20.relayCommand<{ id?: string; error?: string; pointCount?: number }[]>({
        action: "createPolylines",
        pageId: activePage,
        polylines: [{ points: scaledPoints, closed, stroke: strokeColor }],
      });

      return {
        content: [{ type: "text", text: JSON.stringify({
          id: result[0]?.id,
          pointCount: points.length,
          closed,
          pageId: activePage,
          ...(result[0]?.error ? { error: result[0].error } : {}),
        }) }],
      };
    }
  );

  server.tool(
    "screenshot_roll20",
    "Take a screenshot of the current Roll20 editor view and save it to a local file path.",
    { outputPath: z.string().describe("Absolute path to save the PNG screenshot") },
    async ({ outputPath }) => {
      await roll20.takeScreenshot(outputPath);
      return { content: [{ type: "text", text: JSON.stringify({ saved: outputPath }) }] };
    }
  );
}
