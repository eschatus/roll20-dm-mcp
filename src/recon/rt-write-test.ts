// Validate DIRECT RTDB writes (no Mod, no chat) against a scratch token on the GM layer.
// Creates the scratch token via the Mod once, then update/read/delete it purely over the socket.

import { rtRelayCommand, rtGet, rtUpdate, rtRemove } from "../bridge/roll20-rt.js";
import { evaluateWithArgs } from "../bridge/roll20.js";

async function main() {
  const campaign = await rtGet<{ playerpageid?: string }>("campaign");
  const pid = campaign?.playerpageid!;
  console.error(`player page: ${pid}`);

  // Borrow an existing token's imgsrc (createObj('graphic') requires one).
  const graphics = await rtGet<Record<string, { imgsrc?: string }>>(`graphics/page/${pid}`);
  const imgsrc = Object.values(graphics || {}).map((g) => g.imgsrc).find(Boolean);
  console.error(`borrowed imgsrc: ${imgsrc ? "yes" : "NONE"}`);

  // 1) Create a hidden scratch token via the Mod (one-time; goes through chat).
  const created = await rtRelayCommand<{ id: string }>({
    action: "createToken", pageId: pid, name: "RT-WRITE-TEST", imgsrc, left: 35, top: 35, width: 70, height: 70, layer: "gmlayer",
  });
  const id = created.id;
  console.error(`scratch token created: ${id}`);
  const tokPath = `graphics/page/${pid}/${id}`;

  // 2) DIRECT write: change name + bars + a status marker via RTDB.
  await rtUpdate(tokPath, { name: "RT-EDITED", bar1_value: 42, bar1_max: 99, statusmarkers: "dead::4444317" });
  console.error("direct rtUpdate sent");

  // 3) Read back via RTDB (authoritative shared store).
  const after = await rtGet<Record<string, unknown>>(tokPath);
  console.error(`readback: name=${JSON.stringify(after?.name)} bar1_value=${JSON.stringify(after?.bar1_value)} bar1_max=${JSON.stringify(after?.bar1_max)} statusmarkers=${JSON.stringify(after?.statusmarkers)}`);
  const ok = after?.name === "RT-EDITED" && Number(after?.bar1_value) === 42 && after?.statusmarkers === "dead::4444317";
  console.error(ok ? "✅ direct WRITE accepted + persisted" : "❌ write did not persist as expected");

  // PROPAGATION: read the token from the automation browser's Backbone (an independent Roll20
  // client). If it reflects our direct write, it propagated to all clients — not just our store.
  await new Promise((r) => setTimeout(r, 1500));
  const propagated = await evaluateWithArgs((tid: unknown) => {
    const C = (window as any).Campaign;
    for (const pid of [C.get("playerpageid"), C.activePage?.().id].filter(Boolean)) {
      const g = C.pages?.get?.(pid)?.thegraphics?.get?.(tid as string);
      if (g) return { name: g.get("name"), bar1_value: g.get("bar1_value"), statusmarkers: g.get("statusmarkers") };
    }
    return null;
  }, id).catch((e) => ({ err: String(e) }));
  console.error(`browser Backbone sees: ${JSON.stringify(propagated)}`);

  // Independent observer #2 (authoritative): the Mod (separate server-side Firebase client).
  // If the Mod's getObj sees our direct write, it propagated to every client.
  const modView = await rtRelayCommand<{ name?: string; bar1_value?: unknown } | null>({ action: "getTokenById", tokenId: id, pageId: pid, __forceMod: true }).catch((e) => ({ err: String(e) } as any));
  console.error(`Mod (getObj) sees: name=${JSON.stringify((modView as any)?.name)} bar1_value=${JSON.stringify((modView as any)?.bar1_value)}`);
  console.error((modView as any)?.name === "RT-EDITED" ? "✅ PROPAGATED — the Mod (independent client) sees the direct write" : "❌ Mod did NOT see the direct write");

  // 4) DIRECT delete (set null), like the UI deleting an object.
  await rtRemove(tokPath);
  const gone = await rtGet<unknown>(tokPath);
  console.error(gone == null ? "✅ direct DELETE worked (node is null)" : "❌ delete did not remove the node");

  if (!ok) process.exitCode = 1;
}
main().then(() => process.exit(process.exitCode || 0), (e) => { console.error("❌ rt-write-test FAILED:", e); process.exit(1); });
