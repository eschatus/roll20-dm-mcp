// Locate the journal folder in RTDB and test whether a DIRECT rtUpdate persists
// where the Mod's Campaign().set("_journalfolder", …) silently no-ops on this shard.
//
// FINDING: Jumpgate stores it as `journalfolder` (NO underscore), alongside
// `jukeboxfolder`, in the campaign node. The Mod's legacy `_journalfolder`
// attribute does not exist here — so every Mod write went to a dead field.
//
// Run:  tsx src/recon/journal-folder-probe.ts            (read-only — safe)
//       tsx src/recon/journal-folder-probe.ts --write    (self-cleaning write round-trip)
process.env.ROLL20_TRANSPORT ??= "rt";
import { rtGet, rtUpdate, rtStoragePath } from "../bridge/roll20-rt.js";

const WRITE = process.argv.includes("--write");
const FIELD = "journalfolder";

function sample(v: unknown, n = 400): string {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s == null ? String(v) : s.length > n ? s.slice(0, n) + `… (${s.length} chars)` : s;
}

(async () => {
  console.log("storagePath:", await rtStoragePath());

  const camp = await rtGet<Record<string, unknown>>("campaign");
  console.log("\ncampaign node keys:", Object.keys(camp).sort().join(", "));
  const jf = camp[FIELD];
  console.log(`${FIELD} present:`, FIELD in camp, "| type:", typeof jf);
  console.log(`${FIELD} value:`, sample(jf));
  console.log("(_journalfolder present:", "_journalfolder" in camp, "— the dead Mod field)");

  if (!WRITE) {
    console.log("\nread-only probe done. Re-run with --write to test direct persistence.");
    process.exit(0);
  }

  // Write probe: append a self-identifying folder via direct rtUpdate, read back, restore.
  const raw = camp[FIELD];
  const tree: unknown[] = typeof raw === "string" && raw ? JSON.parse(raw) : Array.isArray(raw) ? raw : [];
  const marker = `__rtprobe__${Date.now()}`;
  const next = [...tree, { id: marker, n: marker, i: [] }];
  console.log(`\n[write] appending probe folder "${marker}" via rtUpdate("campaign", { ${FIELD} })…`);
  try {
    await rtUpdate("campaign", { [FIELD]: JSON.stringify(next) });
  } catch (e) {
    console.log("[write] rtUpdate THREW (likely PERMISSION_DENIED):", String(e).slice(0, 200));
    console.log(`RESULT: direct RTDB write to campaign/${FIELD} is DENIED → need the UX-diff probe.`);
    process.exit(2);
  }

  const back = await rtGet<Record<string, unknown>>("campaign");
  const persisted = back[FIELD];
  const landed = typeof persisted === "string" && persisted.includes(marker);
  console.log("[verify] read back contains the probe folder:", landed);

  // Restore the original value no matter what.
  await rtUpdate("campaign", { [FIELD]: typeof raw === "string" ? raw : JSON.stringify(tree) });
  console.log(`[cleanup] restored original ${FIELD}.`);

  console.log(
    landed
      ? `\nRESULT ✅ direct RTDB write to campaign/${FIELD} PERSISTS. Fix: route set_journal_folder through rtUpdate on "${FIELD}", not the Mod's dead "_journalfolder".`
      : `\nRESULT ❌ write returned ok but did NOT persist — format/rules differ; do the UX-diff probe.`
  );
  process.exit(landed ? 0 : 3);
})().catch((e) => { console.error("probe FAILED:", e); process.exit(1); });
