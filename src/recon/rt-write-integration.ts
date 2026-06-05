// End-to-end: drive writes through the real roll20.ts relayCommand with ROLL20_TRANSPORT=rt.
// setTokenBar/setTokenProps/setStatusMarker should go DIRECT (no chat); confirm via the Mod
// (__forceMod) that each landed and propagated. Read-only except a scratch GM-layer token.
process.env.ROLL20_TRANSPORT = "rt";

import { relayCommand } from "../bridge/roll20.js";
import { rtGet, rtRemove } from "../bridge/roll20-rt.js";

async function main() {
  const campaign = await rtGet<{ playerpageid?: string }>("campaign");
  const pid = campaign?.playerpageid!;
  const graphics = await rtGet<Record<string, { imgsrc?: string }>>(`graphics/page/${pid}`);
  const imgsrc = Object.values(graphics || {}).map((g) => g.imgsrc).find(Boolean);

  const created = await relayCommand<{ id: string }>({ action: "createToken", pageId: pid, name: "RT-INT-TEST", imgsrc, left: 35, top: 35, width: 70, height: 70, layer: "gmlayer" });
  const id = created.id;
  console.error(`scratch token: ${id}`);

  const t0 = Date.now();
  await relayCommand({ action: "setTokenBar", tokenId: id, value: 33, max: 50 });
  await relayCommand({ action: "setTokenProps", tokenId: id, props: { name: "RT-INT-EDITED" } });
  await relayCommand({ action: "setStatusMarker", tokenId: id, marker: "dead::4444317", active: true });
  console.error(`3 direct writes in ${Date.now() - t0}ms`);

  // Confirm via the Mod (independent client) that all three landed.
  const mod = await relayCommand<{ name?: string; bar1_value?: unknown; bar1_max?: unknown; statusmarkers?: string }>({ action: "getTokenById", tokenId: id, pageId: pid, __forceMod: true });
  console.error(`Mod sees: name=${JSON.stringify(mod?.name)} bar1=${JSON.stringify(mod?.bar1_value)}/${JSON.stringify(mod?.bar1_max)} markers=${JSON.stringify(mod?.statusmarkers)}`);
  const ok = mod?.name === "RT-INT-EDITED" && Number(mod?.bar1_value) === 33 && Number(mod?.bar1_max) === 50 && String(mod?.statusmarkers || "").includes("dead");
  console.error(ok ? "✅ All 3 direct writes landed + propagated (Mod confirms)" : "❌ mismatch");

  await rtRemove(`graphics/page/${pid}/${id}`);
  console.error("scratch token deleted");
  if (!ok) process.exitCode = 1;
}
main().then(() => process.exit(process.exitCode || 0), (e) => { console.error("❌ FAILED:", e); process.exit(1); });
