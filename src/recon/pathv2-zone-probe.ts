// ─────────────────────────────────────────────────────────────────────────────
// Spike probe (issue #208): is `pathv2` a better zone drawing primitive than the
// legacy `path` object ACTIONS["createZone"] uses today?
//
// Draws one pathv2 per variant in a row on a real page, reports what Roll20
// STORED for each (via the Mod) and what it PERSISTED (via a direct RTDB read,
// bypassing the Mod's accessors), then scores the two questions that data alone
// can answer. The third — does it actually LOOK right — needs a human on the page,
// so the shapes are left there and the script prints the cleanup command.
//
// Needs relay >= 2.9.0 deployed in the campaign (pathv2ZoneProbe is new).
//
// Run:  tsx src/recon/pathv2-zone-probe.ts <pageId> [--campaign slug] [--x N --y N] [--radius PX]
// Clean up afterwards:  tsx src/recon/pathv2-zone-probe.ts --rm <id,id,...> [--campaign slug]
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
  created: boolean;
  error?: string;
  stored?: Record<string, unknown>;
  missing?: string[];
  wrote?: { atCreate: { name: string; gmnotes: string }; afterSet: { name: string; gmnotes: string } };
  storedAfterSet?: { name?: unknown; gmnotes?: unknown };
  missingAfterSet?: string[];
}
interface ProbeResult {
  pageId: string;
  hex6: string;
  hex8: string;
  radiusPx: number;
  rowY: number;
  variants: ProbeVariant[];
  note: string;
}

const flag = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

async function removeIds(ids: string[]): Promise<number> {
  for (const id of ids) {
    try {
      await relayCommand({ action: "removeObject", objectType: "pathv2", objectId: id });
      console.error(`  removed ${id}`);
    } catch (e) {
      console.error(`  FAILED ${id}: ${String(e).slice(0, 120)}`);
    }
  }
  return 0;
}

// Exported so the reporting/verdict path can be driven offline against the emulator
// (wire roll20.__setBridgeTestTransport, then call main()) without a live campaign.
export async function main(): Promise<number> {
  const campaign = flag("--campaign");
  if (campaign) setActiveCampaign(campaign);

  const rm = flag("--rm");
  if (rm) return removeIds(rm.split(",").map(s => s.trim()).filter(Boolean));

  const pageId = process.argv[2];
  if (!pageId || pageId.startsWith("--")) {
    console.error("usage: tsx src/recon/pathv2-zone-probe.ts <pageId> [--campaign slug] [--x N --y N] [--radius PX]");
    console.error("       tsx src/recon/pathv2-zone-probe.ts --rm <id,id,...> [--campaign slug]");
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

  console.error(`colours: opaque ${res.hex6}, translucent ${res.hex8} | radius ${res.radiusPx}px | row at y=${res.rowY}\n`);
  for (const v of res.variants) {
    if (!v.created) {
      console.error(`  ✗ ${v.key.padEnd(16)} NOT CREATED — ${v.error}`);
      console.error(`      (${v.asks})`);
      continue;
    }
    const s = v.stored ?? {};
    console.error(`  ✓ ${v.key.padEnd(16)} ${v.id}  @(${v.centerX},${v.centerY})`);
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
  // The same trick page-probe.ts uses; it is the check that catches "the Mod echoes the
  // value back but the record on the wire never got it".
  console.error(`\nRTDB pathv2/page/${pageId} (direct, no Mod):`);
  for (const v of res.variants) {
    if (!v.id) continue;
    try {
      const raw = await rtGet<Record<string, unknown> | null>(`pathv2/page/${pageId}/${v.id}`);
      if (!raw) { console.error(`  ${v.key.padEnd(16)} (absent from pathv2/page — wrong node?)`); continue; }
      console.error(`  ${v.key.padEnd(16)} shape=${JSON.stringify(raw.shape)} fill=${JSON.stringify(raw.fill)} ` +
        `fill_opacity=${JSON.stringify(raw.fill_opacity)} layer=${JSON.stringify(raw.layer)} ` +
        `name=${JSON.stringify(raw.name)} gmnotes=${JSON.stringify(raw.gmnotes)}`);
      console.error(`      keys: ${Object.keys(raw).sort().join(",")}`);
    } catch (e) {
      console.error(`  ${v.key.padEnd(16)} rtGet FAILED: ${String(e).slice(0, 120)}`);
    }
  }

  // ── Verdicts ────────────────────────────────────────────────────────────────
  const byKey = (k: string) => res.variants.find(v => v.key === k);
  const fill8 = byKey("eli-fill8");
  const fillOp = byKey("eli-fillopacity");
  const meta = byKey("eli-meta");

  const q1a = fill8?.created
    ? (fill8.stored?.fill === res.hex8 ? `STORED (${res.hex8}) — look at the shape to see if the renderer honours it`
      : `NOT STORED — Roll20 kept ${JSON.stringify(fill8.stored?.fill)}`)
    : "n/a — object not created";
  const q1b = fillOp?.created
    ? (Number(fillOp.stored?.fill_opacity) === fillOp.sentFillOpacity
      ? `fill_opacity round-tripped as ${JSON.stringify(fillOp.stored?.fill_opacity)} — pathv2 HAS it, unlike legacy path`
      : `fill_opacity did NOT round-trip (sent ${fillOp.sentFillOpacity}, got ${JSON.stringify(fillOp.stored?.fill_opacity)}` +
        `${fillOp.missing?.includes("fill_opacity") ? ", undefined" : ""}) — dropped, same as legacy path (#162)`)
    : "n/a — object not created";
  const eliOk = res.variants.filter(v => v.shape === "eli" && v.created).length;
  // Compare against the exact strings the relay says it wrote: a sandbox that drops the
  // write can hand back "" instead of undefined, so presence alone proves nothing (#164).
  const metaCarried = (got: unknown, want?: string) => want !== undefined && got === want;
  const q3create = metaCarried(meta?.stored?.name, meta?.wrote?.atCreate.name) &&
    metaCarried(meta?.stored?.gmnotes, meta?.wrote?.atCreate.gmnotes);
  const q3set = metaCarried(meta?.storedAfterSet?.name, meta?.wrote?.afterSet.name) &&
    metaCarried(meta?.storedAfterSet?.gmnotes, meta?.wrote?.afterSet.gmnotes);
  const q3 = meta?.created
    ? (q3create || q3set
      ? `name/gmnotes ARE carried (at create: ${q3create ? "yes" : "no"}, via later set(): ${q3set ? "yes" : "no"})`
      : `name/gmnotes did NOT survive (got ${JSON.stringify(meta.stored?.name)} / ` +
        `${JSON.stringify(meta.storedAfterSet?.name)}) — pathv2 drops them like legacy path (#164)`)
    : "n/a — object not created";

  console.error(`\n── verdicts ────────────────────────────────────────────────`);
  console.error(`Q1 8-digit #RRGGBBAA fill : ${q1a}`);
  console.error(`Q1 fill_opacity           : ${q1b}`);
  console.error(`Q2 shape eli/rec          : ${eliOk}/${res.variants.filter(v => v.shape === "eli").length} ellipses created` +
    ` — RENDERING NEEDS YOUR EYES: open page ${pageId} and look at the row at y=${res.rowY}.`);
  console.error(`   Left to right: ${res.variants.map(v => v.key).join(" | ")}`);
  console.error(`Q3 name/gmnotes           : ${q3}`);
  console.error(`\nWrite what you see into docs/pathv2-zone-spike.md, then clean up:`);
  console.error(`  tsx src/recon/pathv2-zone-probe.ts --rm ${res.variants.filter(v => v.id).map(v => v.id).join(",")}` +
    (campaign ? ` --campaign ${campaign}` : ""));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(n => process.exit(n)).catch(e => { console.error("❌ probe crashed:", e); process.exit(1); });
}
