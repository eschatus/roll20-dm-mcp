// Doors and windows as records that can be read, recreated and put back. Shared by
// replace_page_walls and decorate_openings, which both clear a page's openings before placing new
// ones: the clear is a direct RTDB write and the creates need the Mod, so the two can come apart.
//
// Open/locked/secret are written straight to RTDB after creation. The Mod's create actions hardcode
// them, and carrying them there would need a Mod redeploy.
import { z } from "zod";
import * as roll20 from "../bridge/roll20.js";
import { rtUpdate } from "../bridge/roll20-rt.js";
import type { DLOpeningDef } from "./vision.js";

export const OPENING_COLORS = { door: "#FF0000", window: "#00FFFF", secretDoor: "#9932CC" };
export const WRITE_BATCH = 20;

interface LiveOpening {
  x?: number; y?: number;
  handle0?: { x?: number; y?: number };
  handle1?: { x?: number; y?: number };
  color?: string;
  isOpen?: boolean; isLocked?: boolean; isSecret?: boolean;
}

export interface PriorOpening {
  x: number; y: number;
  handle0: { x: number; y: number };
  handle1: { x: number; y: number };
  color?: string;
  isOpen: boolean; isLocked: boolean; isSecret: boolean;
}

export interface PageOpenings {
  doors: PriorOpening[];
  windows: PriorOpening[];
  /** Records with geometry too broken to recreate, so they could not be put back once removed. */
  unreadable: number;
}

interface OpeningState { isOpen?: boolean; isLocked?: boolean; isSecret?: boolean }
export interface OpeningPlan { def: DLOpeningDef & { color: string }; state: OpeningState; secret: boolean }

const coord = z.number().finite();
const handle = z.object({ x: coord, y: coord });
export const priorOpeningSchema = z.object({
  x: coord, y: coord, handle0: handle, handle1: handle, color: z.string().optional(),
  isOpen: z.boolean(), isLocked: z.boolean(), isSecret: z.boolean(),
});

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function captureOpening(o: LiveOpening): PriorOpening | null {
  const { x, y, handle0: h0, handle1: h1 } = o;
  if (!isNum(x) || !isNum(y) || !isNum(h0?.x) || !isNum(h0?.y) || !isNum(h1?.x) || !isNum(h1?.y)) return null;
  return {
    x, y,
    handle0: { x: h0.x, y: h0.y },
    handle1: { x: h1.x, y: h1.y },
    ...(o.color ? { color: o.color } : {}),
    isOpen: o.isOpen === true, isLocked: o.isLocked === true, isSecret: o.isSecret === true,
  };
}

export async function readOpenings(pageId: string): Promise<PageOpenings> {
  const live = await roll20.relayCommand<{ doors: LiveOpening[]; windows: LiveOpening[] }>({ action: "getDoors", pageId });
  const readable = (o: PriorOpening | null): o is PriorOpening => o !== null;
  const doors = live.doors.map(captureOpening).filter(readable);
  const windows = live.windows.map(captureOpening).filter(readable);
  return { doors, windows, unreadable: live.doors.length + live.windows.length - doors.length - windows.length };
}

/** One opening as a comparable line, rounded so a round trip's last digits don't read as a change. */
export function openingLine(type: string, o: PriorOpening, withOpen: boolean): string {
  const r2 = (n: number) => Math.round(n * 100) / 100;
  return JSON.stringify([
    type, r2(o.x), r2(o.y), r2(o.handle0.x), r2(o.handle0.y), r2(o.handle1.x), r2(o.handle1.y),
    o.color ?? "", o.isLocked, o.isSecret, ...(withOpen ? [o.isOpen] : []),
  ]);
}

function sameOpenings(a: PageOpenings, b: PageOpenings): boolean {
  const lines = (p: PageOpenings) => [
    ...p.doors.map((o) => openingLine("door", o, true)),
    ...p.windows.map((o) => openingLine("window", o, true)),
  ].sort().join("\n");
  return lines(a) === lines(b);
}

export function planFromPriorOpening(o: PriorOpening, fallbackColor: string): OpeningPlan {
  const state: OpeningState = {};
  if (o.isOpen) state.isOpen = true;
  if (o.isLocked) state.isLocked = true;
  if (o.isSecret) state.isSecret = true;
  return {
    // getDoors returns page coordinates; the create actions take y negated.
    def: { x: o.x, y: -o.y, x0: o.handle0.x, y0: -o.handle0.y, x1: o.handle1.x, y1: -o.handle1.y, color: o.color ?? fallbackColor },
    state,
    secret: o.isSecret,
  };
}

function* chunks<T>(items: T[], size: number): Generator<T[]> {
  for (let i = 0; i < items.length; i += size) yield items.slice(i, i + size);
}

/** Filled as each create lands, so a failure part-way reports facts. */
export interface OpeningLedger {
  stage: string;
  placed: { doors: number; windows: number; secretDoors: number };
}

export async function placeOpenings(pageId: string, kind: "door" | "window", plans: OpeningPlan[], ledger: OpeningLedger): Promise<void> {
  const [action, key] = kind === "door" ? ["createDLDoors", "doors"] : ["createDLWindows", "windows"];
  const stage = ledger.stage;
  const withState: { id: string; state: OpeningState }[] = [];
  for (const batch of chunks(plans, WRITE_BATCH)) {
    const results = await roll20.relayCommand<{ id?: string; error?: string }[]>({
      action, pageId, [key]: batch.map((p) => p.def),
    });
    let miss: string | undefined;
    results.forEach((r, i) => {
      if (!r.id) { miss ??= r.error ?? `${action} returned no id`; return; }
      const plan = batch[i];
      if (kind === "window") ledger.placed.windows++;
      else if (plan.secret) ledger.placed.secretDoors++;
      else ledger.placed.doors++;
      if (Object.keys(plan.state).length) withState.push({ id: r.id, state: plan.state });
    });
    if (miss) throw new Error(miss);
  }
  ledger.stage = "set-opening-state";
  for (const { id, state } of withState) await rtUpdate(`${key}/page/${pageId}/${id}`, { ...state });
  ledger.stage = stage;
}

export interface OpeningsRollback {
  /** The page holds what it held before, confirmed by reading it back. */
  restored: boolean;
  restoreError?: string;
  left: { doors: number; windows: number } | { unknown: true; readError: string };
}

/** Puts `before` back after a failed swap. Never throws, so the original error is not lost. */
export async function rollBackOpenings(pageId: string, before: PageOpenings): Promise<OpeningsRollback> {
  let restoreError: string | undefined;
  try {
    // A failure before the clear landed leaves nothing to repair, and recreating would change ids.
    if (!sameOpenings(await readOpenings(pageId), before)) {
      await roll20.relayCommand({ action: "clearDLOpenings", pageId });
      const ledger: OpeningLedger = { stage: "rollback", placed: { doors: 0, windows: 0, secretDoors: 0 } };
      await placeOpenings(pageId, "door", before.doors.map((o) => planFromPriorOpening(o, OPENING_COLORS.door)), ledger);
      await placeOpenings(pageId, "window", before.windows.map((o) => planFromPriorOpening(o, OPENING_COLORS.window)), ledger);
    }
  } catch (err) {
    restoreError = String(err);
  }
  try {
    const after = await readOpenings(pageId);
    return {
      restored: sameOpenings(after, before),
      ...(restoreError ? { restoreError } : {}),
      left: { doors: after.doors.length, windows: after.windows.length },
    };
  } catch (err) {
    return { restored: false, ...(restoreError ? { restoreError } : {}), left: { unknown: true, readError: String(err) } };
  }
}
