// replace_page_walls (#280): swap a page's DL walls and openings in one call.
//
// Order matters. New walls go down FIRST, the openings are swapped, and only then do the old walls
// come off, so at no point is the page left wall-less for a player looking at it. There is no
// transaction across relay calls, so every failure re-reads the page and reports what is really
// there, plus the `prior` block that puts it back.
//
// Why each write takes the route it does (see docs/roll20-api-coverage.md, "Replacing a page's
// walls", for the evidence):
//   - Which relay action restores a wall depends on how its record is anchored. createWalls writes
//     x,y = midpoint; createPolylines writes x,y = first vertex. Sending a midpoint-anchored wall
//     through createPolylines builds a different record, which renders somewhere else. Matching
//     the anchor reproduces the record, so a restored wall lands where it was however Roll20
//     interprets x,y.
//   - Open/locked/secret are written straight to RTDB afterwards (see openings.ts).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createHash } from "node:crypto";
import * as roll20 from "../bridge/roll20.js";
import { fail, json } from "./combatHelpers.js";
import { prepareWallSegments, toDLOpening, type Opening, type PageScaleArgs, type Point } from "./vision.js";
import {
  OPENING_COLORS as COLORS, WRITE_BATCH, openingLine, placeOpenings, planFromPriorOpening, priorOpeningSchema, readOpenings,
  type OpeningPlan, type PriorOpening,
} from "./openings.js";

const WALL_COLOR = "#0044FF";
const REMOVE_CONCURRENCY = 10;
const ANCHOR_TOLERANCE_PX = 1; // getWalls rounds vertices to whole pixels; it does not round x,y

// ─── Reading the page ─────────────────────────────────────────────────────────

export interface LiveWall {
  id: string;
  kind: string;
  x?: number; y?: number;
  barrierType?: string;
  shape?: string;
  pointCount?: number;
  points?: unknown[][];
  left?: number; top?: number; width?: number; height?: number; stroke?: string;
}

export type WallAnchor = "center" | "first";
export interface PriorWall { points: Point[]; anchor: WallAnchor }
interface HeldWall extends PriorWall { id: string }
interface KeptWall { id: string; kind: string; reason: string }

interface PageState {
  totalWalls: number;
  walls: HeldWall[];
  kept: KeptWall[];
  doors: PriorOpening[];
  windows: PriorOpening[];
  unreadableOpenings: number;
  fingerprint: string;
  /** The fingerprint with isOpen included. Internal: decides whether a failed call left repair work. */
  exactFingerprint: string;
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const near = (a: number, b: number) => Math.abs(a - b) <= ANCHOR_TOLERANCE_PX;

// A barrier with a recreatable record, or the reason it stays on the page. Only a `pol` barrier of
// plain wall type qualifies: the relay's wall creators cannot write a one-way direction, a
// transparent type on a polyline, or a rec/eli shape, so removing one could not be undone. Roll20
// does not store a plain wall's barrierType (the Mod reads it back as "wall"), so empty counts too.
export function classifyWall(w: LiveWall): { wall: HeldWall } | { kept: KeptWall } {
  const keep = (reason: string) => ({ kept: { id: w.id, kind: w.kind, reason } });
  if (w.kind !== "pathv2") return keep("not a pathv2 barrier");
  if (w.barrierType && w.barrierType !== "wall") return keep(`barrierType "${w.barrierType}" cannot be recreated`);
  if (w.shape && w.shape !== "pol") return keep(`shape "${w.shape}" cannot be recreated`);
  const pts = w.points;
  if (!Array.isArray(pts) || pts.length < 2 || !pts.every((p) => isNum(p?.[0]) && isNum(p?.[1])) || !isNum(w.x) || !isNum(w.y)) {
    return keep("points are unreadable");
  }
  const points = pts.map((p) => [p[0], p[1]] as Point);
  const [a, b] = points;
  const isCentered = points.length === 2 && near((a[0] + b[0]) / 2, w.x) && near((a[1] + b[1]) / 2, w.y);
  if (isCentered) return { wall: { id: w.id, points, anchor: "center" } };
  if (near(a[0], w.x) && near(a[1], w.y)) return { wall: { id: w.id, points, anchor: "first" } };
  return keep("anchored neither at its midpoint nor its first vertex, so it cannot be recreated in place");
}

// Order-independent and id-free, so a restore that really reproduced the page gets the same value
// back. isOpen is left out on purpose: a door opened in play is not an edit to the map. Wall stroke
// is out because getWalls does not report it. withOpen adds isOpen back for the failure report, where
// a door left shut by a failed state write is real damage and not play.
function fingerprintOf(walls: HeldWall[], kept: LiveWall[], doors: PriorOpening[], windows: PriorOpening[], withOpen = false): string {
  const lines = [
    ...walls.map((w) => JSON.stringify(["wall", w.points])),
    ...kept.map(({ id: _id, ...rest }) =>
      JSON.stringify(["kept", Object.entries(rest).sort(([k1], [k2]) => k1.localeCompare(k2))])),
    ...doors.map((o) => openingLine("door", o, withOpen)),
    ...windows.map((o) => openingLine("window", o, withOpen)),
  ].sort();
  return createHash("sha256").update(lines.join("\n")).digest("hex").slice(0, 16);
}

async function readPage(pageId: string): Promise<PageState> {
  const raw = await roll20.relayCommand<LiveWall[]>({ action: "getWalls", pageId, includePoints: true });
  const { doors, windows, unreadable } = await readOpenings(pageId);
  const walls: HeldWall[] = [];
  const kept: KeptWall[] = [];
  const keptRaw: LiveWall[] = [];
  for (const w of raw) {
    const c = classifyWall(w);
    if ("wall" in c) walls.push(c.wall);
    else { kept.push(c.kept); keptRaw.push(w); }
  }
  return {
    totalWalls: raw.length, walls, kept, doors, windows,
    unreadableOpenings: unreadable,
    fingerprint: fingerprintOf(walls, keptRaw, doors, windows),
    exactFingerprint: fingerprintOf(walls, keptRaw, doors, windows, true),
  };
}

const priorOf = (s: PageState) => ({
  fingerprint: s.fingerprint,
  walls: s.walls.map(({ points, anchor }) => ({ points, anchor })),
  doors: s.doors,
  windows: s.windows,
});

// ─── The write plan ───────────────────────────────────────────────────────────

interface SegmentDef { x1: number; y1: number; x2: number; y2: number; stroke: string }
interface WritePlan { segments: SegmentDef[]; polylines: Point[][]; doors: OpeningPlan[]; windows: OpeningPlan[] }

function planFromPrior(prior: { walls: PriorWall[]; doors: PriorOpening[]; windows: PriorOpening[] }): WritePlan {
  return {
    segments: prior.walls.filter((w) => w.anchor === "center")
      .map(({ points: [a, b] }) => ({ x1: a[0], y1: a[1], x2: b[0], y2: b[1], stroke: WALL_COLOR })),
    polylines: prior.walls.filter((w) => w.anchor === "first").map((w) => w.points),
    doors: prior.doors.map((o) => planFromPriorOpening(o, COLORS.door)),
    windows: prior.windows.map((o) => planFromPriorOpening(o, COLORS.window)),
  };
}

interface NewContent extends PageScaleArgs {
  walls: { from: Point; to: Point; color?: string; category?: "exterior" | "interior" }[];
  doors: Opening[];
  windows: Opening[];
  secretDoors: Opening[];
  endpointInsetPx: number; cornerOverlapPx: number; cornerThresholdPx: number; maxSegmentPx: number;
  strokeColor: string;
}

function planFromContent(c: NewContent): WritePlan {
  const scale: PageScaleArgs = c;
  const processed = prepareWallSegments(c.walls, [...c.doors, ...c.windows, ...c.secretDoors], scale, c);
  const opening = (o: Opening, color: string, secret: boolean): OpeningPlan => ({
    def: { ...toDLOpening(o, scale), color }, state: secret ? { isSecret: true } : {}, secret,
  });
  return {
    segments: processed.map((w) => ({ x1: w.from[0], y1: w.from[1], x2: w.to[0], y2: w.to[1], stroke: w.color ?? c.strokeColor })),
    polylines: [],
    doors: [...c.doors.map((o) => opening(o, COLORS.door, false)), ...c.secretDoors.map((o) => opening(o, COLORS.secretDoor, true))],
    windows: c.windows.map((o) => opening(o, COLORS.window, false)),
  };
}

// ─── The writes ───────────────────────────────────────────────────────────────

type Stage = "place-walls" | "swap-openings" | "set-opening-state" | "remove-old-walls";

// What this call has done so far, filled as each write lands, so a failure reports facts.
interface Ledger {
  stage: Stage;
  newWallIds: string[];
  openingsCleared: boolean;
  placed: { doors: number; windows: number; secretDoors: number };
  removedOldWalls: number;
}

function* chunks<T>(items: T[], size: number): Generator<T[]> {
  for (let i = 0; i < items.length; i += size) yield items.slice(i, i + size);
}

async function createWallBatch(pageId: string, cmd: Record<string, unknown>, ledger: Ledger): Promise<void> {
  const results = await roll20.relayCommand<{ id?: string; error?: string }[]>({ pageId, ...cmd });
  for (const r of results) {
    if (!r.id) throw new Error(r.error ?? `${String(cmd.action)} returned no id`);
    ledger.newWallIds.push(r.id);
  }
}

async function placeWalls(pageId: string, plan: WritePlan, ledger: Ledger): Promise<void> {
  for (const walls of chunks(plan.segments, WRITE_BATCH)) {
    await createWallBatch(pageId, { action: "createWalls", walls }, ledger);
  }
  for (const batch of chunks(plan.polylines, WRITE_BATCH)) {
    const polylines = batch.map((points) => ({ points, closed: false, stroke: WALL_COLOR }));
    await createWallBatch(pageId, { action: "createPolylines", polylines }, ledger);
  }
}

// Removes until a batch fails, returning how many went and the first error. Never throws, so the
// rollback path can report a failed cleanup instead of losing the original error.
async function removeWalls(ids: string[]): Promise<{ removed: number; error?: string }> {
  let removed = 0;
  for (const batch of chunks(ids, REMOVE_CONCURRENCY)) {
    const settled = await Promise.allSettled(batch.map((objectId) =>
      roll20.relayCommand({ action: "removeObject", objectType: "pathv2", objectId })));
    removed += settled.filter((r) => r.status === "fulfilled").length;
    const miss = settled.find((r): r is PromiseRejectedResult => r.status === "rejected");
    if (miss) return { removed, error: String(miss.reason) };
  }
  return { removed };
}

async function applyPlan(pageId: string, plan: WritePlan, oldWallIds: string[], ledger: Ledger): Promise<void> {
  await placeWalls(pageId, plan, ledger);

  ledger.stage = "swap-openings";
  await roll20.relayCommand({ action: "clearDLOpenings", pageId });
  ledger.openingsCleared = true;
  await placeOpenings(pageId, "door", plan.doors, ledger);
  await placeOpenings(pageId, "window", plan.windows, ledger);

  ledger.stage = "remove-old-walls";
  const res = await removeWalls(oldWallIds);
  ledger.removedOldWalls = res.removed;
  if (res.error) throw new Error(res.error);
}

// ─── Failure report ───────────────────────────────────────────────────────────

async function reportFailure(pageId: string, before: PageState, ledger: Ledger, cause: unknown) {
  // New walls that went down before a wall failure are this call's own mess. Removing them puts the
  // page back without touching the originals, which a restore would rebuild without their colour.
  let cleanup: { removed: number; error?: string } | undefined;
  if (ledger.stage === "place-walls" && ledger.newWallIds.length) cleanup = await removeWalls(ledger.newWallIds);

  let after: PageState | undefined;
  let readError: string | undefined;
  try { after = await readPage(pageId); } catch (e) { readError = String(e); }

  const liveIds = new Set(after?.walls.map((w) => w.id));
  const oldLeft = before.walls.filter((w) => liveIds.has(w.id)).length;
  const newLeft = ledger.newWallIds.filter((id) => liveIds.has(id));
  const unchanged = after?.exactFingerprint === before.exactFingerprint;

  const where = after
    ? `Left on the page: ${after.totalWalls} walls (${oldLeft} of the ${before.walls.length} prior, ` +
      `${newLeft.length} new, ${after.kept.length} kept), ${after.doors.length} doors, ${after.windows.length} windows.`
    : `The page could not be re-read (${readError}), so what is left on it is unknown.`;
  const next = unchanged
    ? "The page matches its prior state, so nothing needs restoring."
    : "To restore it, call replace_page_walls with { pageId, restore: prior } using the prior block in this result. That removes what is there now and rebuilds the prior walls and openings.";

  return fail(JSON.stringify({
    error: `replace_page_walls failed at ${ledger.stage}: ${String(cause)}. ${where} ${next}`,
    stage: ledger.stage,
    pageId,
    placed: { walls: ledger.newWallIds.length - (cleanup?.removed ?? 0), ...ledger.placed },
    removed: { oldWalls: ledger.removedOldWalls, openingsCleared: ledger.openingsCleared },
    ...(cleanup ? { rolledBackNewWalls: cleanup.removed, ...(cleanup.error ? { rollbackError: cleanup.error } : {}) } : {}),
    leftOnPage: after ? {
      walls: after.totalWalls, oldWalls: oldLeft, newWallIds: newLeft, keptWalls: after.kept.length,
      doors: after.doors.length, windows: after.windows.length,
      fingerprint: after.fingerprint, matchesPrior: unchanged,
    } : { unknown: true, readError },
    prior: priorOf(before),
  }));
}

// ─── Tool ─────────────────────────────────────────────────────────────────────

const coord = z.number().finite();
const point = z.tuple([coord, coord]);
const openingSchema = z.object({ center: point, widthPx: coord, angleDeg: coord });

export function registerWallReplaceTools(server: McpServer): void {
  server.tool(
    "replace_page_walls",
    "Replace a page's DL walls, doors and windows in one call. Places the new walls first, swaps the openings, then removes the old walls, and returns the prior state as `prior`. To undo, call again with { pageId, restore: prior }. Call { pageId, dryRun: true } first to get the current fingerprint and prior state without writing, then pass expectedFingerprint so the replacement refuses if the page was edited in between. Removes only plain `pol` wall barriers: other paths, graphics, one-way or transparent barriers and rec/eli shapes stay and are listed under `kept`. Every door and window on the page is replaced. A restore rebuilds wall geometry and door state but not a wall's custom colour (restored walls are blue). On partial failure the result is an error naming what is left on the page and carrying `prior`.",
    {
      pageId: z.string().describe("The page to change. Required: this tool removes objects, so it never defaults to the player page."),
      walls: z.array(z.object({
        from: point, to: point,
        color: z.string().optional().describe("Per-wall color override. Takes precedence over strokeColor."),
        category: z.enum(["exterior", "interior"]).optional(),
      })).optional().describe("New wall centerlines, as for auto_place_dl_walls. Required unless restore or dryRun is given; [] means no walls."),
      doors: z.array(openingSchema).optional().describe("New doors, as for decorate_openings. Required unless restore or dryRun is given; [] means no doors."),
      windows: z.array(openingSchema).optional().describe("New windows, as for decorate_openings. Required unless restore or dryRun is given; [] means no windows."),
      secretDoors: z.array(openingSchema).default([]).describe("New secret doors. Placed purple with isSecret set."),
      restore: z.object({
        fingerprint: z.string().optional(),
        walls: z.array(z.object({ points: z.array(point).min(2), anchor: z.enum(["center", "first"]) })),
        doors: z.array(priorOpeningSchema),
        windows: z.array(priorOpeningSchema),
      }).optional().describe("The `prior` block from an earlier result, passed back unchanged. Used instead of walls, doors and windows."),
      expectedFingerprint: z.string().optional().describe("Refuse with no writes unless the live page still has this fingerprint, from a dryRun or an earlier result's after.fingerprint. Leave it off when restoring after a partial failure."),
      dryRun: z.boolean().default(false).describe("Read only: return the fingerprint, prior state and what would be placed."),
      sourceImageWidth: z.number().optional(),
      sourceImageHeight: z.number().optional(),
      pageWidthSquares: z.number().optional(),
      pageHeightSquares: z.number().optional(),
      endpointInsetPx: z.number().default(5),
      cornerOverlapPx: z.number().default(4),
      cornerThresholdPx: z.number().default(10),
      maxSegmentPx: z.number().default(200),
      strokeColor: z.string().default(WALL_COLOR).describe("DL wall stroke colour. Project convention is blue #0044FF."),
    },
    async ({ pageId, walls, doors, windows, secretDoors, restore, expectedFingerprint, dryRun, ...settings }) => {
      const hasContent = walls !== undefined || doors !== undefined || windows !== undefined;
      if (restore && (hasContent || secretDoors.length)) {
        return fail("Pass either restore or new walls, doors and windows, not both. Nothing was changed.");
      }
      if (hasContent && !(walls && doors && windows)) {
        return fail("walls, doors and windows are all required, because every door and window on the page is replaced. Pass [] to mean none. Nothing was changed.");
      }
      if (!restore && !hasContent && !dryRun) {
        return fail("Nothing to do: pass walls, doors and windows, or restore, or dryRun. Nothing was changed.");
      }

      const before = await readPage(pageId);
      const live = { walls: before.walls.length, keptWalls: before.kept.length, doors: before.doors.length, windows: before.windows.length };

      if (expectedFingerprint && expectedFingerprint !== before.fingerprint) {
        return fail(JSON.stringify({
          error: "Refused: the live walls or openings no longer match expectedFingerprint, so they changed since that read. Nothing was changed. Call again with dryRun to see the page as it is now.",
          pageId, expectedFingerprint, liveFingerprint: before.fingerprint, live,
        }));
      }
      if (before.unreadableOpenings) {
        return fail(`Refused: ${before.unreadableOpenings} door or window on this page has unreadable geometry, so it could not be restored after being replaced. Nothing was changed.`);
      }

      const plan = restore ? planFromPrior(restore)
        : walls && doors && windows ? planFromContent({ walls, doors, windows, secretDoors, ...settings })
        : null;

      if (dryRun || !plan) {
        const wouldPlace = plan && {
          walls: plan.segments.length + plan.polylines.length,
          doors: plan.doors.filter((p) => !p.secret).length,
          secretDoors: plan.doors.filter((p) => p.secret).length,
          windows: plan.windows.length,
        };
        return json({ dryRun: true, pageId, fingerprint: before.fingerprint, live, kept: before.kept, ...(wouldPlace ? { wouldPlace } : {}), prior: priorOf(before) }, false);
      }

      const ledger: Ledger = {
        stage: "place-walls", newWallIds: [], openingsCleared: false,
        placed: { doors: 0, windows: 0, secretDoors: 0 }, removedOldWalls: 0,
      };
      try {
        await applyPlan(pageId, plan, before.walls.map((w) => w.id), ledger);
      } catch (err) {
        return reportFailure(pageId, before, ledger, err);
      }

      // Every write reported success. Read back so the result carries observed counts.
      let after: Record<string, unknown>;
      try {
        const state = await readPage(pageId);
        const expectedWalls = before.totalWalls - ledger.removedOldWalls + ledger.newWallIds.length;
        const expectedOpenings = plan.doors.length + plan.windows.length;
        after = {
          walls: state.totalWalls, doors: state.doors.length, windows: state.windows.length, fingerprint: state.fingerprint,
          verified: state.totalWalls === expectedWalls && state.doors.length + state.windows.length === expectedOpenings,
          ...(restore?.fingerprint ? { matchesRestoredFingerprint: state.fingerprint === restore.fingerprint } : {}),
        };
      } catch (err) {
        after = { verified: false, readError: String(err) };
      }

      return json({
        pageId,
        placed: { walls: ledger.newWallIds.length, ...ledger.placed },
        removed: { walls: ledger.removedOldWalls, doors: before.doors.length, windows: before.windows.length },
        kept: before.kept,
        after,
        prior: priorOf(before),
      }, false);
    }
  );
}
