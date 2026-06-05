// Is a token's gmnotes (GM-only field) directly writable over the socket AND readable by the Mod?
// If yes, it can carry tracked PC HP silently. If it's a permission-gated blob, this approach is out.
process.env.ROLL20_TRANSPORT = "rt";
import { relayCommand } from "../bridge/roll20.js";
import { rtGet, rtUpdate, rtRemove } from "../bridge/roll20-rt.js";

async function main() {
  const campaign = await rtGet<{ playerpageid?: string }>("campaign");
  const pid = campaign?.playerpageid!;
  const graphics = await rtGet<Record<string, { imgsrc?: string }>>(`graphics/page/${pid}`);
  const imgsrc = Object.values(graphics || {}).map((g) => g.imgsrc).find(Boolean);
  const { id } = await relayCommand<{ id: string }>({ action: "createToken", pageId: pid, name: "RT-GMNOTES-TEST", imgsrc, left: 35, top: 35, width: 70, height: 70, layer: "gmlayer" });
  console.error(`scratch token: ${id}`);
  const tokPath = `graphics/page/${pid}/${id}`;

  const payload = JSON.stringify({ pchp: { current: 17, max: 23 } });
  try {
    await rtUpdate(tokPath, { gmnotes: payload });
    console.error("direct gmnotes write: sent (no permission error)");
  } catch (e) {
    console.error(`❌ direct gmnotes write REJECTED: ${(e as Error).message}`);
    await rtRemove(tokPath).catch(() => {});
    process.exit(1);
  }

  await new Promise((r) => setTimeout(r, 800));
  const rt = await rtGet<Record<string, unknown>>(tokPath);
  console.error(`RTDB readback gmnotes: ${JSON.stringify(rt?.gmnotes)}`);

  const mod = await relayCommand<{ gmnotes?: string }>({ action: "getTokenById", tokenId: id, pageId: pid, __forceMod: true });
  console.error(`Mod readback gmnotes: ${JSON.stringify(mod?.gmnotes)}`);

  const rtOk = rt?.gmnotes === payload;
  const modOk = mod?.gmnotes === payload;
  console.error(rtOk && modOk
    ? "✅ gmnotes is directly writable AND Mod-readable — viable PC-HP carrier"
    : `⚠️ rtOk=${rtOk} modOk=${modOk} — gmnotes may be encoded/blobbed (Mod sees: ${JSON.stringify(mod?.gmnotes)})`);

  await rtRemove(tokPath);
  console.error("cleaned up");
  if (!(rtOk && modOk)) process.exitCode = 2;
}
main().then(() => process.exit(process.exitCode || 0), (e) => { console.error("❌ FAILED:", e); process.exit(1); });
