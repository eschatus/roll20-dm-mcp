// Validate toggleCondition direct (marker write off chat) + custom-state tracking via local store.
process.env.ROLL20_TRANSPORT = "rt";
import { relayCommand } from "../bridge/roll20.js";
import { rtGet, rtRemove } from "../bridge/roll20-rt.js";

async function main() {
  const campaign = await rtGet<{ playerpageid?: string }>("campaign");
  const pid = campaign?.playerpageid!;
  const graphics = await rtGet<Record<string, { imgsrc?: string }>>(`graphics/page/${pid}`);
  const imgsrc = Object.values(graphics || {}).map((g) => g.imgsrc).find(Boolean);
  const { id } = await relayCommand<{ id: string }>({ action: "createToken", pageId: pid, name: "RT-COND-TEST", imgsrc, left: 35, top: 35, width: 70, height: 70, layer: "gmlayer" });
  console.error(`scratch token: ${id}`);

  // Tier-1 condition (poisoned) + tier-2 custom (hexed) — both DIRECT, no chat.
  await relayCommand({ action: "toggleCondition", tokenId: id, condition: "poisoned", active: true });
  const r2 = await relayCommand<{ tier: string; marker: string }>({ action: "toggleCondition", tokenId: id, condition: "hexed", active: true });
  console.error(`hexed resolved tier=${r2.tier} marker=${r2.marker}`);

  // Confirm markers landed (via the Mod, independent client).
  const mod = await relayCommand<{ statusmarkers?: string }>({ action: "getTokenById", tokenId: id, pageId: pid, __forceMod: true });
  console.error(`Mod sees statusmarkers: ${JSON.stringify(mod?.statusmarkers)}`);
  const markersOk = String(mod?.statusmarkers || "").includes("Poisoned::4444329") && r2.tier === "custom";

  // Confirm custom-state tracking via getCustomStates (served from local store).
  const states = await relayCommand<{ state: string; tokens: { id: string }[] }[]>({ action: "getCustomStates" });
  const hexed = states.find((s) => s.state === "hexed");
  console.error(`getCustomStates → hexed tracked on ${hexed ? hexed.tokens.length : 0} token(s)`);
  const trackOk = !!hexed && hexed.tokens.some((t) => t.id === id);

  // Toggle off + cleanup.
  await relayCommand({ action: "toggleCondition", tokenId: id, condition: "hexed", active: false });
  const after = await relayCommand<{ state: string }[]>({ action: "getCustomStates" });
  const cleared = !after.find((s) => s.state === "hexed");
  await rtRemove(`graphics/page/${pid}/${id}`);

  console.error(markersOk && trackOk && cleared
    ? "✅ toggleCondition DIRECT works (marker off chat) + custom-state tracking + cleanup"
    : `❌ markersOk=${markersOk} trackOk=${trackOk} cleared=${cleared}`);
  if (!(markersOk && trackOk && cleared)) process.exitCode = 1;
}
main().then(() => process.exit(process.exitCode || 0), (e) => { console.error("❌ FAILED:", e); process.exit(1); });
