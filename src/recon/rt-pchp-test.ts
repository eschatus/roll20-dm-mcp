// Validate the TS-side direct PC-HP path (gmnotes carrier). Mod-side reads apply after redeploy;
// this confirms the TS writes/reads the %%PCHP%% block correctly. Read-only except a scratch token.
process.env.ROLL20_TRANSPORT = "rt";
import { relayCommand } from "../bridge/roll20.js";
import { rtGet, rtRemove } from "../bridge/roll20-rt.js";

async function main() {
  const campaign = await rtGet<{ playerpageid?: string }>("campaign");
  const pid = campaign?.playerpageid!;
  const graphics = await rtGet<Record<string, { imgsrc?: string }>>(`graphics/page/${pid}`);
  const imgsrc = Object.values(graphics || {}).map((g) => g.imgsrc).find(Boolean);
  const { id } = await relayCommand<{ id: string }>({ action: "createToken", pageId: pid, name: "RT-PCHP-TEST", imgsrc, bar1_value: 25, bar1_max: 25, left: 35, top: 35, width: 70, height: 70, layer: "gmlayer" });
  // seed bar1 via direct write (createToken default may be 0)
  const { rtUpdate } = await import("../bridge/roll20-rt.js");
  await rtUpdate(`graphics/page/${pid}/${id}`, { bar1_value: 25, bar1_max: 25 });
  console.error(`scratch token: ${id} (bar1 seeded 25/25)`);

  const a = await relayCommand<{ current: number; max: number }>({ action: "adjustPcHp", tokenId: id, damage: 7 });
  console.error(`damage 7 → current=${a.current} max=${a.max} (expect 18/25)`);
  const b = await relayCommand<{ current: number }>({ action: "adjustPcHp", tokenId: id, heal: 3 });
  console.error(`heal 3 → current=${b.current} (expect 21)`);
  const c = await relayCommand<{ current: number }>({ action: "adjustPcHp", tokenId: id, setHp: 10 });
  console.error(`setHp 10 → current=${c.current} (expect 10)`);
  const g = await relayCommand<{ current: number; max: number } | null>({ action: "getPcHp", tokenId: id });
  console.error(`getPcHp → ${JSON.stringify(g)}`);

  const tok = await rtGet<{ gmnotes?: string }>(`graphics/page/${pid}/${id}`);
  console.error(`raw gmnotes: ${JSON.stringify(tok?.gmnotes)}`);

  const ok = a.current === 18 && b.current === 21 && c.current === 10 && g?.current === 10;
  console.error(ok ? "✅ TS PC-HP via gmnotes works (math + read; Mod-side applies after redeploy)" : "❌ mismatch");
  await rtRemove(`graphics/page/${pid}/${id}`);
  if (!ok) process.exitCode = 1;
}
main().then(() => process.exit(process.exitCode || 0), (e) => { console.error("❌ FAILED:", e); process.exit(1); });
