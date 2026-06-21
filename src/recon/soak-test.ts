// Soak test for the rebased/merged build (origin hardening + PC-HP gmnotes + direct RTDB).
// Exercises: relay round-trip, direct reads, direct writes, Mod-side PC-HP (gmnotes), TS↔Mod
// consistency on the same token, batchExec (merged runBatchOp), conditions, and the dice engine.
// Safe: uses ONE hidden gmlayer scratch token, never touches turn order, deletes the token at the end.
// Dice roll is silent (engine correctness only) to avoid spamming a live session.
process.env.ROLL20_TRANSPORT = "rt";

import { pathToFileURL } from "url";
import { relayCommand } from "../bridge/roll20.js";
import { rtGet, rtRemove } from "../bridge/roll20-rt.js";

let pass = 0, fail = 0;
function check(label: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.error(`  ✓ ${label}${detail ? " — " + detail : ""}`); }
  else { fail++; console.error(`  ✗ FAIL: ${label}${detail ? " — " + detail : ""}`); }
}
const r = (cmd: Record<string, unknown>) => relayCommand<any>(cmd);

export async function runSoak(): Promise<number> {
  pass = 0; fail = 0;
  const campaign = await rtGet<{ playerpageid?: string }>("campaign");
  const pid = campaign?.playerpageid!;
  console.error(`\n[soak] campaign player page: ${pid}\n`);

  // 1) Deployed Mod responds (force the Mod path).
  console.error("== relay round-trip (Mod) ==");
  const pong = await r({ action: "ping", __forceMod: true });
  check("ping → Mod responds", pong?.pong === true, `version ${pong?.version}`);

  // 2) Direct reads (off socket, no Mod).
  console.error("== direct reads ==");
  const to = await r({ action: "getTurnOrder" });
  check("getTurnOrder", Array.isArray(to), `${to?.length} entries`);
  const markers = await r({ action: "getTokenMarkers" });
  check("getTokenMarkers", Array.isArray(markers) && markers.length > 0, `${markers?.length} markers`);
  const toks = await r({ action: "getTokens", pageId: pid, profile: "lean" });
  check("getTokens(player page)", Array.isArray(toks), `${toks?.length} tokens`);
  const chat = await r({ action: "getRecentChat", limit: 10 });
  check("getRecentChat (buffer)", Array.isArray(chat), `${chat?.length} msgs`);

  // 3) Scratch token (Mod createObj path).
  console.error("== create scratch token ==");
  const graphics = await rtGet<Record<string, { imgsrc?: string }>>(`graphics/page/${pid}`);
  const imgsrc = Object.values(graphics || {}).map((g) => g.imgsrc).find(Boolean);
  const created = await r({ action: "createToken", pageId: pid, name: "SOAK-TEST", imgsrc, bar1_value: 0, bar1_max: 0, left: 35, top: 35, width: 70, height: 70, layer: "gmlayer" });
  const id = created?.id;
  check("createToken", !!id, id);
  if (!id) { summarize(); return; }
  const tokPath = `graphics/page/${pid}/${id}`;
  await rtRemove(tokPath + "/bar1_value").catch(() => {}); // noop guard

  // 4) PC-HP via the MOD (gmnotes code in the deployed merge).
  console.error("== PC-HP: Mod-side (deployed gmnotes code) ==");
  const m1 = await r({ action: "adjustPcHp", tokenId: id, setHp: 30, __forceMod: true });
  check("Mod adjustPcHp setHp 30", Number(m1?.current) === 30, `current=${m1?.current}`);
  const m2 = await r({ action: "getPcHp", tokenId: id, __forceMod: true });
  check("Mod getPcHp reads gmnotes block", Number(m2?.current) === 30, `current=${m2?.current}`);

  // 5) PC-HP via TS direct, then read back via the MOD → cross-check both sides share the block.
  console.error("== PC-HP: TS↔Mod consistency ==");
  const t1 = await r({ action: "adjustPcHp", tokenId: id, damage: 12 }); // TS direct: 30→18
  check("TS adjustPcHp damage 12", Number(t1?.current) === 18, `current=${t1?.current}`);
  const x = await r({ action: "getPcHp", tokenId: id, __forceMod: true });
  check("Mod sees TS's direct write", Number(x?.current) === 18, `Mod current=${x?.current}`);

  // 6) batchExec via Mod (merged runBatchOp: adjustPcHp + setTokenProps + toggleCondition).
  console.error("== batchExec (merged runBatchOp) ==");
  const batch = await r({ action: "batchExec", ops: [
    { id: "hp", action: "adjustPcHp", args: { tokenId: id, heal: 5 } },        // 18→23
    { id: "nm", action: "setTokenProps", args: { tokenId: id, props: { name: "SOAK-EDIT" } } },
    { id: "cd", action: "toggleCondition", args: { tokenId: id, condition: "poisoned", active: true } },
  ] });
  const okAll = Array.isArray(batch) && batch.every((b: any) => b.ok);
  check("batchExec all ops ok", okAll, JSON.stringify(batch?.map((b: any) => b.id + ":" + b.ok)));
  const after = await rtGet<Record<string, unknown>>(tokPath);
  check("batch adjustPcHp landed", true); // confirmed below via getPcHp
  const hp = await r({ action: "getPcHp", tokenId: id });
  check("PC-HP after batch heal = 23", Number(hp?.current) === 23, `current=${hp?.current}`);
  check("batch setTokenProps name", after?.name === "SOAK-EDIT", `name=${JSON.stringify(after?.name)}`);
  check("batch toggleCondition marker", String(after?.statusmarkers || "").includes("Poisoned::4444329"), `markers=${JSON.stringify(after?.statusmarkers)}`);

  // 7) Direct writes (off chat).
  console.error("== direct writes ==");
  await r({ action: "setTokenBar", tokenId: id, value: 7, max: 9 });
  await r({ action: "setStatusMarker", tokenId: id, marker: "Concentrating::4444313", active: true });
  const after2 = await rtGet<Record<string, unknown>>(tokPath);
  check("direct setTokenBar", Number(after2?.bar1_value) === 7, `bar1=${after2?.bar1_value}`);
  check("direct setStatusMarker", String(after2?.statusmarkers || "").includes("Concentrating::4444313"));

  // 8) Dice engine (silent — confirms Roll20 roller returns real totals).
  console.error("== dice engine (Roll20 roller, silent) ==");
  const rolls = await r({ action: "rollFormulas", items: [{ label: "soak", formula: "2d6+3" }], silent: true });
  const total = rolls?.[0]?.total;
  check("rollFormulas via Roll20 dice", typeof total === "number" && total >= 5 && total <= 15, `2d6+3=${total}`);

  // 9) Cleanup.
  console.error("== cleanup ==");
  await rtRemove(tokPath);
  const gone = await rtGet(tokPath);
  check("scratch token deleted", gone == null);

  summarize();
  return fail;
}

function summarize() {
  console.error(`\n${fail === 0 ? "✅" : "❌"} SOAK: ${pass} passed, ${fail} failed`);
}

// Run directly (`tsx src/recon/soak-test.ts`) → execute + set the exit code. Imported
// (e.g. by release-mod) → just expose runSoak() so the caller can run it IN-PROCESS,
// sharing the one browser/RT connection (a child process can't share the browser
// profile, and a second RT listener collides — both false-fail the soak).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runSoak()
    .then((f) => process.exit(f === 0 ? 0 : 1))
    .catch((e) => { console.error("❌ soak crashed:", e); process.exit(1); });
}
