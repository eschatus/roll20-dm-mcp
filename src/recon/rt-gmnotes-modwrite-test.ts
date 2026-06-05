// Does the Mod writing gmnotes (t.set) round-trip RAW to RTDB, or does Roll20 HTML-encode it?
// Critical: if the Mod encodes gmnotes, TS can't parse the PC-HP block written by the Mod's
// adjustPcHp (batchExec path). Forces the Mod write path, then reads back over the socket.
process.env.ROLL20_TRANSPORT = "rt";
import { relayCommand } from "../bridge/roll20.js";
import { rtGet, rtRemove } from "../bridge/roll20-rt.js";

async function main() {
  const campaign = await rtGet<{ playerpageid?: string }>("campaign");
  const pid = campaign?.playerpageid!;
  const graphics = await rtGet<Record<string, { imgsrc?: string }>>(`graphics/page/${pid}`);
  const imgsrc = Object.values(graphics || {}).map((g) => g.imgsrc).find(Boolean);
  const { id } = await relayCommand<{ id: string }>({ action: "createToken", pageId: pid, name: "RT-GMW-TEST", imgsrc, left: 35, top: 35, width: 70, height: 70, layer: "gmlayer" });
  console.error(`scratch token: ${id}`);

  const payload = `notes here %%PCHP=${JSON.stringify({ current: 12, max: 20, name: "Foo" })}%%`;
  // Force the MOD write path (setTokenProps via the Mod, not direct).
  await relayCommand({ action: "setTokenProps", tokenId: id, props: { gmnotes: payload }, __forceMod: true });
  await new Promise((r) => setTimeout(r, 900));

  const rt = await rtGet<Record<string, unknown>>(`graphics/page/${pid}/${id}`);
  const got = String(rt?.gmnotes ?? "");
  console.error(`RTDB readback after Mod write:\n  ${JSON.stringify(got).slice(0, 240)}`);

  const m = got.match(/%%PCHP=({[\s\S]*?})%%/);
  let parsed: unknown = null;
  if (m) { try { parsed = JSON.parse(m[1]); } catch { /* */ } }
  console.error(`PCHP block parseable from Mod-written gmnotes: ${parsed ? "YES ✅ " + JSON.stringify(parsed) : "NO ❌ (encoded?)"}`);

  await rtRemove(`graphics/page/${pid}/${id}`);
  if (!parsed) process.exitCode = 1;
}
main().then(() => process.exit(process.exitCode || 0), (e) => { console.error("❌ FAILED:", e); process.exit(1); });
