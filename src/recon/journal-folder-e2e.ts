// End-to-end proof that the set_journal_folder / get_journal_folder TOOL PATH now
// files + reads back through the RT direct write (campaign/journalfolder), bypassing
// the Mod's dead "_journalfolder". Goes through roll20.relayCommand — the exact path
// the MCP tools use. Self-cleaning: appends a test folder, verifies, restores.
//
// Run:  tsx src/recon/journal-folder-e2e.ts
process.env.ROLL20_TRANSPORT ??= "rt";
import * as roll20 from "../bridge/roll20.js";

const NAME = "__e2e_verify__";

(async () => {
  const before = await roll20.relayCommand<unknown[]>({ action: "getJournalFolder" });
  const beforeLen = Array.isArray(before) ? before.length : -1;
  console.log("before: top-level entries =", beforeLen);

  const setRes = await roll20.relayCommand<{ ok?: boolean; appended?: number; total?: number }>({
    action: "setJournalFolder",
    json: { __append__: [{ id: NAME, n: NAME, i: [] }] },
  });
  console.log("set result:", JSON.stringify(setRes));

  const after = await roll20.relayCommand<unknown[]>({ action: "getJournalFolder" });
  const present = Array.isArray(after) &&
    after.some((e) => e && typeof e === "object" && (e as { n?: string }).n === NAME);
  console.log("after: top-level entries =", Array.isArray(after) ? after.length : -1, "| test folder present:", present);

  // Cleanup: restore the exact original tree (replace mode).
  await roll20.relayCommand({ action: "setJournalFolder", json: Array.isArray(before) ? before : [] });
  const restored = await roll20.relayCommand<unknown[]>({ action: "getJournalFolder" });
  const restoredLen = Array.isArray(restored) ? restored.length : -1;
  console.log("restored: top-level entries =", restoredLen, restoredLen === beforeLen ? "(matches)" : "(MISMATCH!)");

  console.log(present
    ? "\nE2E ✅ set_journal_folder files + reads back through the RT direct write (campaign/journalfolder)."
    : "\nE2E ❌ did not persist via the tool path.");
  process.exit(present && restoredLen === beforeLen ? 0 : 1);
})().catch((e) => { console.error("e2e FAILED:", e); process.exit(1); });
