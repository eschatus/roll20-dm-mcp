// Probe: do Roll20 map pings (shift+click) transit the campaign RTDB where our
// rt client can see them? If yes, "fireball where I pinged" becomes a resolve_aoe
// targeting mode. Read-only — attaches listeners, writes nothing.
//
// Note: a shallow GET of the storage ROOT is permission-denied (Roll20's rules
// grant per-child reads only), so we can't enumerate node names — we attach
// listeners to candidate paths and let the per-path allow/deny be part of the
// signal: DENIED = path exists in the rules but isn't ours to read; silence on
// an allowed path = pings just don't go there.
//
// Run: npx tsx src/recon/ping-probe.ts   (then shift-ping the map in Roll20)
import "dotenv/config";
import { ref, onChildAdded, onChildChanged, onChildRemoved, onValue } from "firebase/database";
import { rtGet, rtRawDb } from "../bridge/roll20-rt.js";

const WINDOW_MS = Number(process.env.PING_PROBE_WINDOW_MS || 120_000);

async function main() {
  const t0 = Date.now();
  const stamp = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;
  const show = (v: unknown) => {
    const s = JSON.stringify(v);
    return s && s.length > 500 ? s.slice(0, 500) + "…" : String(s);
  };

  // Known-readable node → also gives us the player page id for page-scoped guesses.
  const campaign = await rtGet<Record<string, unknown>>("campaign");
  const pid = String(campaign?.playerpageid ?? "");
  console.error(`connected. playerpageid=${pid}; campaign keys: ${Object.keys(campaign ?? {}).sort().join(", ")}`);

  const GUESSES = [
    "pings", "ping", "lastping", "cursors", "cursor", "presence", "volume",
    "measurements", "radar", "ephemeral",
    ...(pid ? [
      `pings/page/${pid}`, `pings/${pid}`, `ping/${pid}`,
      `cursors/page/${pid}`, `cursors/${pid}`,
      `measurements/page/${pid}`, `measurements/${pid}`,
    ] : []),
  ];

  const { db, storagePath } = await rtRawDb();
  for (const p of GUESSES) {
    const r = ref(db, `${storagePath}/${p}`);
    const denied = (err: Error) => console.error(`[${stamp()}] DENIED  ${p} (${err.message.split("\n")[0]})`);
    onChildAdded(r, (s) => console.error(`[${stamp()}] ADDED   ${p}/${s.key}: ${show(s.val())}`), denied);
    onChildChanged(r, (s) => console.error(`[${stamp()}] CHANGED ${p}/${s.key}: ${show(s.val())}`), denied);
    onChildRemoved(r, (s) => console.error(`[${stamp()}] REMOVED ${p}/${s.key}`), () => {});
    // Scalar-valued nodes (e.g. lastping) won't fire child events — watch value too.
    onValue(r, (s) => { if (s.exists()) console.error(`[${stamp()}] VALUE   ${p}: ${show(s.val())}`); }, () => {});
  }

  console.error(`\n>>> Listening ${WINDOW_MS / 1000}s on ${GUESSES.length} candidate paths.`);
  console.error(">>> In Roll20 NOW: shift+click-drag pings at a few different spots; also a plain click-hold ping.\n");

  await new Promise((r) => setTimeout(r, WINDOW_MS));
  console.error(`\n[${stamp()}] window closed. Anything not marked ADDED/CHANGED/VALUE above never fired — if all candidates stayed silent while you pinged, pings don't transit this RTDB root (next step: sniff the browser websocket).`);
  process.exit(0);
}

main().catch((e) => { console.error("ping-probe FAILED:", e); process.exit(1); });
