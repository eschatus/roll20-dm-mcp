import * as roll20 from "../bridge/roll20.js";
import { getPcSheetHp } from "../registry/campaigns.js";

// ─────────────────────────────────────────────────────────────────────────────
// Where a TRUE PC's HP lives — the one seam every PC HP write goes through.
//
// Default ("tracked"): a %%PCHP%% block in the token's gmnotes, because Beyond20 owns the token
// bar and the real sheet is somewhere else. Opt-in per campaign ("sheet", set_pc_hp_source): the
// table plays on Roll20's own character sheets, so the sheet IS the truth and we read-modify-write
// it. The token bar is still never written: a bar linked to the sheet follows it on its own.
//
// This is deliberately built from getSheetItem/setSheetItem, which are version-agnostic, rather
// than a new relay action: no Mod redeploy, and a Beacon sheet that holds HP in a computed
// property works the same way. The price is that the read and the write are separate relay calls,
// so a player editing their own HP in the same instant can be overwritten. adjustPcHp's gmnotes
// transaction has no such window; a sheet the player also edits cannot.
// ─────────────────────────────────────────────────────────────────────────────

export type PcHpOp = { damage?: number; heal?: number; setHp?: number };
export type PcHpResult = { current: number; max: number; carrier: "tracked" | "sheet" };
type PcToken = { id: string; name?: string; represents?: string };

type SheetRead = { values: Record<string, unknown>; failed: string[]; reasons: Record<string, string> };
type SheetWrite = { written: string[]; failed: string[]; reasons: Record<string, string> };

/** A sheet-mode HP write that did not happen. HP is unchanged when this throws. */
export class PcSheetHpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PcSheetHpError";
  }
}

const isBlank = (v: unknown) => v === undefined || v === null || (typeof v === "string" && v.trim() === "");

// A sheet field is free text. Refuse what isn't a number: 0 for "2d6+3" would look like a downed PC.
function sheetNumber(v: unknown, what: string): number {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  if (!Number.isFinite(n)) {
    throw new PcSheetHpError(`${what} is ${JSON.stringify(v)}, which is not a number — no HP was changed.`);
  }
  return n;
}

async function readField(charId: string, attr: string, valtype: "current" | "max", who: string): Promise<unknown> {
  const r = await roll20.relayCommand<SheetRead>({ action: "getSheetItem", charId, names: [attr], valtype });
  if (r.failed.includes(attr)) {
    throw new PcSheetHpError(
      `${who}: could not read '${attr}' (${valtype}) from the character sheet: ${r.reasons[attr]}. ` +
      "No HP was changed; get_sheet_summary lists what this sheet offers."
    );
  }
  return r.values[attr];
}

/** The new HP from a sheet's current and max, with the same clamps as the other HP paths. */
export function applyHpOp(op: PcHpOp, current: number, max: number): number {
  if (op.setHp !== undefined) return op.setHp;
  if (op.damage !== undefined) return Math.max(0, current - op.damage);
  return max ? Math.min(max, current + op.heal!) : current + op.heal!;
}

export async function adjustSheetHp(token: PcToken, attr: string, op: PcHpOp): Promise<PcHpResult> {
  const who = (token.name || token.id).split("\n")[0].trim();
  const charId = token.represents;
  if (!charId) {
    throw new PcSheetHpError(
      `${who}: this campaign keeps PC HP on the character sheet, but the token represents no character — ` +
      "no HP was changed. Link the token to its sheet."
    );
  }
  const rawCurrent = await readField(charId, attr, "current", who);
  const rawMax = await readField(charId, attr, "max", who);
  const max = isBlank(rawMax) ? 0 : sheetNumber(rawMax, `${who}: '${attr}' max`);
  // setHp establishes a value, so a blank current is fine for it and only for it.
  const current = op.setHp !== undefined && isBlank(rawCurrent) ? 0 : sheetNumber(rawCurrent, `${who}: '${attr}'`);
  const next = applyHpOp(op, current, max);

  const w = await roll20.relayCommand<SheetWrite>({
    action: "setSheetItem", charId, attributes: { [attr]: next }, createAttr: false,
  });
  if (!w.written.includes(attr)) {
    throw new PcSheetHpError(`${who}: the sheet refused the write to '${attr}': ${w.reasons[attr] ?? "no reason given"}.`);
  }
  // `written` is not evidence. Live on an ogl5e Beacon sheet, setSheetItem reports a field with no
  // attribute record as written and stores nothing, createAttr:false and allowThrow notwithstanding.
  const landed = await readField(charId, attr, "current", who);
  if (Number(landed) !== next) {
    throw new PcSheetHpError(
      `${who}: the write to '${attr}' reported success but the sheet now holds ${JSON.stringify(landed)}, not ${next}. ` +
      "HP did not change. The sheet has no stored value for that field: a player opening the sheet, or " +
      "set_character_attribute with withWorker:true, creates one."
    );
  }
  return { current: next, max, carrier: "sheet" };
}

/** Apply an HP change to a TRUE PC, on whichever carrier the active campaign uses. */
export async function adjustPcHp(token: PcToken, op: PcHpOp): Promise<PcHpResult> {
  const sheet = getPcSheetHp();
  if (sheet) return adjustSheetHp(token, sheet.attribute, op);
  const res = await roll20.relayCommand<{ current: number; max: number }>({ action: "adjustPcHp", tokenId: token.id, ...op });
  return { current: res.current, max: res.max, carrier: "tracked" };
}

/** The suffix a report puts on a PC's HP, naming the carrier. */
export const pcHpTag = (carrier: PcHpResult["carrier"]) => (carrier === "sheet" ? " (sheet)" : " (tracked)");
