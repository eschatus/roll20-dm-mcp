// ─────────────────────────────────────────────────────────────────────────────
// Spike probe (issue #208): is `pathv2` a better zone drawing primitive than the
// legacy `path` object ACTIONS["createZone"] uses today?
//
// Draws one pathv2 per variant (wrapping into rows to stay on the page) on a real
// page, reports what Roll20 STORED for each (via the Mod) and what it PERSISTED (via
// a direct RTDB read, bypassing the Mod's accessors), then scores the two questions
// that data alone can answer — from the RTDB record, not the Mod echo. The third —
// does it actually LOOK right — needs a human on the page, so the shapes are left
// there and the script prints the cleanup command.
//
// Needs relay >= 2.9.0 deployed in the campaign (pathv2ZoneProbe is new). Use a
// scratch CAMPAIGN, not just a scratch page: see docs/pathv2-zone-spike.md.
//
// Run:  tsx src/recon/pathv2-zone-probe.ts <pageId> [--campaign slug] [--x N --y N] [--radius PX]
// Clean up afterwards:  tsx src/recon/pathv2-zone-probe.ts --rm-last [--campaign slug]
//   (removes every id the relay stashed in state.GM_AI_Bridge.pathv2Probe — works even
//    if this terminal's output is gone), or by hand:  --rm <id,id,...>
// Exit code is non-zero if any removal failed.
// ─────────────────────────────────────────────────────────────────────────────
process.env.ROLL20_TRANSPORT ??= "rt";

import { pathToFileURL } from "url";
import { relayCommand } from "../bridge/roll20.js";
import { rtGet } from "../bridge/roll20-rt.js";
import { setActiveCampaign } from "../registry/campaigns.js";

interface ProbeVariant {
  key: string;
  asks: string;
  id?: string;
  shape: string;
  layer: string;
  sentFill: string;
  sentFillOpacity?: number;
  centerX?: number;
  centerY?: number;
  pointCount?: number;
  offPage?: boolean;
  created: boolean;
  error?: string;
  stored?: Record<string, unknown>;
  missing?: string[];
  wrote?: { atCreate: { name: string; gmnotes: string }; afterSet: { name: string; gmnotes: string } };
  storedAfterSet?: { name?: unknown; gmnotes?: unknown };
  missingAfterSet?: string[];
}
export interface ProbeResult {
  pageId: string;
  hex6: string;
  hex8: string;
  radiusPx: number;
  rowY: number;
  rowYs?: number[];
  pageWidthPx?: number;
  pageHeightPx?: number;
  variants: ProbeVariant[];
  stashedIds?: string[];
  note: string;
}
interface ClearLastResult {
  cleared: boolean;
  stash: { pageId: string; ids: string[]; at: number } | null;
  removed: string[];
  alreadyGone: string[];
  failed: Array<{ id: string; error: string }>;
}
/** A direct RTDB record, or null when the read came back empty or failed. */
export type RawRecord = Record<string, unknown> | null;

const USAGE = [
  "usage: tsx src/recon/pathv2-zone-probe.ts <pageId> [--campaign slug] [--x N --y N] [--radius PX]",
  "       tsx src/recon/pathv2-zone-probe.ts --rm-last [--campaign slug]",
  "       tsx src/recon/pathv2-zone-probe.ts --rm <id,id,...> [--campaign slug]",
];

/** Returns the number of ids that could NOT be removed. */
async function removeIds(ids: string[]): Promise<number> {
  let failed = 0;
  for (const id of ids) {
    try {
      await relayCommand({ action: "removeObject", objectType: "pathv2", objectId: id });
      console.error(`  removed ${id}`);
    } catch (e) {
      failed++;
      console.error(`  FAILED ${id}: ${String(e).slice(0, 120)}`);
    }
  }
  if (failed) console.error(`${failed}/${ids.length} removal(s) FAILED — those shapes are still on the page.`);
  return failed;
}

/** Removes everything the relay stashed; returns the number of ids that could NOT be removed. */
async function removeLast(): Promise<number> {
  const r = await relayCommand<ClearLastResult>({ action: "pathv2ZoneProbe", clearLast: true });
  if (!r.stash) {
    console.error("nothing stashed — no un-cleared probe shapes recorded in this campaign.");
    return 0;
  }
  console.error(`stashed probe on page ${r.stash.pageId} (${new Date(r.stash.at).toISOString()}), ${r.stash.ids.length} id(s):`);
  for (const id of r.removed) console.error(`  removed ${id}`);
  for (const id of r.alreadyGone) console.error(`  already gone ${id}`);
  for (const f of r.failed) console.error(`  FAILED ${f.id}: ${f.error}`);
  if (r.failed.length) console.error(`${r.failed.length} removal(s) FAILED — kept in the stash; re-run --rm-last to retry.`);
  return r.failed.length;
}

// ── Verdicts ──────────────────────────────────────────────────────────────────
// Scored from the RTDB record, NOT the Mod's obj.get() echo: a property the sandbox
// accepts on the live object can still be missing from what Roll20 persists, and the
// echo would then report a write that never landed (the #162/#164 failure shape).
// When the echo and the record disagree, the verdict says MISMATCH explicitly.
const j = (v: unknown) => (v === undefined ? "undefined" : JSON.stringify(v));

function mismatch(field: string, modEcho: unknown, raw: Record<string, unknown>): string {
  return modEcho !== raw[field]
    ? ` — MISMATCH: Mod echoes ${field}=${j(modEcho)} but RTDB has ${j(raw[field])}`
    : "";
}

export interface Verdicts { q1a: string; q1b: string; q3: string }

export function scoreVerdicts(res: ProbeResult, raws: Map<string, RawRecord>): Verdicts {
  const byKey = (k: string) => res.variants.find(v => v.key === k);
  const rawOf = (v: ProbeVariant): RawRecord => (v.id ? raws.get(v.id) ?? null : null);
  const noRaw = (v: ProbeVariant, field: string, echo: unknown) =>
    `UNKNOWN — no RTDB record for ${v.id} (Mod echoed ${field}=${j(echo)}; not trusted on its own)`;

  const fill8 = byKey("eli-fill8");
  const fillOp = byKey("eli-fillopacity");
  const meta = byKey("eli-meta");

  let q1a = "n/a — object not created";
  if (fill8?.created) {
    const raw = rawOf(fill8);
    q1a = !raw ? noRaw(fill8, "fill", fill8.stored?.fill)
      : (raw.fill === res.hex8
        ? `PERSISTED (${res.hex8}) — look at the shape to see if the renderer honours it`
        : `NOT PERSISTED — RTDB has fill=${j(raw.fill)}`) + mismatch("fill", fill8.stored?.fill, raw);
  }

  let q1b = "n/a — object not created";
  if (fillOp?.created) {
    const raw = rawOf(fillOp);
    q1b = !raw ? noRaw(fillOp, "fill_opacity", fillOp.stored?.fill_opacity)
      : (raw.fill_opacity !== undefined && raw.fill_opacity !== null &&
         Number(raw.fill_opacity) === fillOp.sentFillOpacity
        ? `fill_opacity PERSISTED as ${j(raw.fill_opacity)} — pathv2 HAS it, unlike legacy path`
        : `fill_opacity did NOT persist (sent ${fillOp.sentFillOpacity}, RTDB has ${j(raw.fill_opacity)})` +
          " — dropped, same as legacy path (#162)") +
        mismatch("fill_opacity", fillOp.stored?.fill_opacity, raw);
  }

  // The RTDB read happens after the whole action ran, so it sees the FINAL state: the
  // after-set() strings if set() landed, else the at-create strings if only create did.
  // Exact-string comparison — a dropped write can come back as "" rather than undefined (#164).
  let q3 = "n/a — object not created";
  if (meta?.created) {
    const raw = rawOf(meta);
    const echo = meta.storedAfterSet ?? { name: meta.stored?.name, gmnotes: meta.stored?.gmnotes };
    if (!raw) {
      q3 = noRaw(meta, "name", echo.name);
    } else {
      const is = (want?: { name: string; gmnotes: string }) =>
        want !== undefined && raw.name === want.name && raw.gmnotes === want.gmnotes;
      q3 = (is(meta.wrote?.afterSet)
        ? "name/gmnotes ARE carried (the later set() persisted; at-create is not separately provable from RTDB)"
        : is(meta.wrote?.atCreate)
          ? "name/gmnotes carried AT CREATE only — the later set() did not persist"
          : `name/gmnotes did NOT persist (RTDB has ${j(raw.name)} / ${j(raw.gmnotes)}) — pathv2 drops them like legacy path (#164)`) +
        mismatch("name", echo.name, raw) + mismatch("gmnotes", echo.gmnotes, raw);
    }
  }
  return { q1a, q1b, q3 };
}

const flagIn = (argv: string[], name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

// Exported, with argv injectable, so the reporting/verdict/cleanup paths are driven
// offline against the emulator (test/pathv2-zone-probe-script.test.ts) — no live campaign.
export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const flag = (name: string) => flagIn(argv, name);
  const campaign = flag("--campaign");
  if (campaign) setActiveCampaign(campaign);

  if (argv.includes("--rm-last")) return (await removeLast()) ? 1 : 0;
  const rm = flag("--rm");
  if (rm) return (await removeIds(rm.split(",").map(s => s.trim()).filter(Boolean))) ? 1 : 0;

  const pageId = argv[0];
  if (!pageId || pageId.startsWith("--")) {
    for (const line of USAGE) console.error(line);
    return 1;
  }

  const ping = await relayCommand<{ version?: string }>({ action: "ping" });
  console.error(`\n[pathv2-zone-probe] page ${pageId} — deployed relay v${ping?.version ?? "?"}`);

  const res = await relayCommand<ProbeResult>({
    action: "pathv2ZoneProbe",
    pageId,
    centerX: flag("--x") ? Number(flag("--x")) : undefined,
    centerY: flag("--y") ? Number(flag("--y")) : undefined,
    radiusPx: flag("--radius") ? Number(flag("--radius")) : undefined,
  });

  const rows = (res.rowYs ?? [res.rowY]).join(",");
  console.error(`colours: opaque ${res.hex6}, translucent ${res.hex8} | radius ${res.radiusPx}px | ` +
    `row(s) at y=${rows} | page ${res.pageWidthPx}x${res.pageHeightPx}px\n`);
  for (const v of res.variants) {
    if (!v.created) {
      console.error(`  ✗ ${v.key.padEnd(16)} NOT CREATED — ${v.error}`);
      console.error(`      (${v.asks})`);
      continue;
    }
    const s = v.stored ?? {};
    console.error(`  ✓ ${v.key.padEnd(16)} ${v.id}  @(${v.centerX},${v.centerY})` +
      (v.offPage ? "  ⚠ OFF THE PAGE EDGE — use a smaller --radius or a bigger page" : ""));
    console.error(`      (${v.asks})`);
    console.error(`      sent   shape=${v.shape} layer=${v.layer} fill=${v.sentFill}` +
      (v.sentFillOpacity !== undefined ? ` fill_opacity=${v.sentFillOpacity}` : ""));
    console.error(`      stored shape=${JSON.stringify(s.shape)} layer=${JSON.stringify(s.layer)} ` +
      `fill=${JSON.stringify(s.fill)} fill_opacity=${JSON.stringify(s.fill_opacity)} ` +
      `x=${s.x} y=${s.y} w=${s.width} h=${s.height}`);
    if (v.missing?.length) console.error(`      undefined props: ${v.missing.join(", ")}`);
    if (v.storedAfterSet) {
      console.error(`      name/gmnotes at create: ${JSON.stringify(s.name)} / ${JSON.stringify(s.gmnotes)}`);
      console.error(`      name/gmnotes after set: ${JSON.stringify(v.storedAfterSet.name)} / ${JSON.stringify(v.storedAfterSet.gmnotes)}`);
    }
  }

  // Direct RTDB read — what Roll20 actually persisted, with no Mod accessor in the way.
  // The same trick page-probe.ts uses; the verdicts below are scored from these records.
  console.error(`\nRTDB pathv2/page/${pageId} (direct, no Mod):`);
  const raws = new Map<string, RawRecord>();
  for (const v of res.variants) {
    if (!v.id) continue;
    try {
      const raw = await rtGet<Record<string, unknown> | null>(`pathv2/page/${pageId}/${v.id}`);
      raws.set(v.id, raw ?? null);
      if (!raw) { console.error(`  ${v.key.padEnd(16)} (absent from pathv2/page — wrong node?)`); continue; }
      console.error(`  ${v.key.padEnd(16)} shape=${JSON.stringify(raw.shape)} fill=${JSON.stringify(raw.fill)} ` +
        `fill_opacity=${JSON.stringify(raw.fill_opacity)} layer=${JSON.stringify(raw.layer)} ` +
        `name=${JSON.stringify(raw.name)} gmnotes=${JSON.stringify(raw.gmnotes)}`);
      console.error(`      keys: ${Object.keys(raw).sort().join(",")}`);
    } catch (e) {
      raws.set(v.id, null);
      console.error(`  ${v.key.padEnd(16)} rtGet FAILED: ${String(e).slice(0, 120)}`);
    }
  }

  const { q1a, q1b, q3 } = scoreVerdicts(res, raws);
  const eliOk = res.variants.filter(v => v.shape === "eli" && v.created).length;

  console.error(`\n── verdicts (from the RTDB record) ─────────────────────────`);
  console.error(`Q1 8-digit #RRGGBBAA fill : ${q1a}`);
  console.error(`Q1 fill_opacity           : ${q1b}`);
  console.error(`Q2 shape eli/rec          : ${eliOk}/${res.variants.filter(v => v.shape === "eli").length} ellipses created` +
    ` — RENDERING NEEDS YOUR EYES: open page ${pageId} and look at the row(s) at y=${rows}.`);
  console.error(`   Left to right, top to bottom: ${res.variants.map(v => v.key).join(" | ")}`);
  console.error(`Q3 name/gmnotes           : ${q3}`);
  console.error(`\nWrite what you see into docs/pathv2-zone-spike.md, then clean up:`);
  console.error(`  tsx src/recon/pathv2-zone-probe.ts --rm-last` + (campaign ? ` --campaign ${campaign}` : ""));
  console.error(`  (the relay stashed ${res.stashedIds?.length ?? 0} id(s); by hand: --rm ` +
    `${res.variants.filter(v => v.id).map(v => v.id).join(",")})`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(n => process.exit(n)).catch(e => { console.error("❌ probe crashed:", e); process.exit(1); });
}
