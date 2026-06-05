// Validate the direct RTDB reads (served off the socket, never touching /chat). Read-only.
import { rtRelayCommand, rtGet } from "../bridge/roll20-rt.js";

async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const t = Date.now(); const r = await fn();
  const n = Array.isArray(r) ? `${r.length} items` : (r && typeof r === "object" ? `${Object.keys(r).length} keys` : String(r));
  console.error(`  ✓ ${label} — ${Date.now() - t}ms (${n})`);
  return r;
}

async function main() {
  const campaign = await rtGet<{ playerpageid?: string }>("campaign");
  const pid = campaign?.playerpageid;
  console.error(`player page: ${pid}`);

  await timed("getTurnOrder", () => rtRelayCommand<unknown[]>({ action: "getTurnOrder" }));
  await timed("getTokenMarkers", () => rtRelayCommand<unknown[]>({ action: "getTokenMarkers" }));
  const tokens = await timed("getTokens", () => rtRelayCommand<{ id: string; name: string; represents: string }[]>({ action: "getTokens", pageId: pid, profile: "full" }));
  const withChar = tokens.find((t) => t.represents) || tokens[0];
  if (withChar) {
    await timed(`getTokenById(${withChar.name || withChar.id})`, () => rtRelayCommand({ action: "getTokenById", tokenId: withChar.id, pageId: pid }));
  }
  await timed("getDoors", () => rtRelayCommand<{ doors: unknown[]; windows: unknown[] }>({ action: "getDoors", pageId: pid }));
  await timed("getPaths", () => rtRelayCommand<unknown[]>({ action: "getPaths", pageId: pid }));
  await timed("getRecentChat", () => rtRelayCommand<unknown[]>({ action: "getRecentChat", limit: 20 }));

  console.error("\n✅ Direct RTDB reads working — served off the socket, no Mod round-trip, no /chat traffic.");
}

main().then(() => process.exit(0), (e) => { console.error("❌ rt-reads FAILED:", e); process.exit(1); });
