// Ping RECON, phase 2 (read-only). The RTDB name-guess probe came back uniformly
// permission-denied, so we sniff the live wire instead: open a second GM session
// via Playwright, capture every websocket frame, and have the DM shift-ping the
// map from their own browser. Whatever transports the ping broadcast — main RTDB
// socket, a separate firebase host, or something else — shows up in the frames,
// including the exact node path our rt client would need to subscribe to.
//
// Run: npx tsx src/recon/ping-sniff.ts   (then shift-ping in YOUR Roll20 window)
// Output: ping-tagged frames to stderr + full dump in .tmp-test-data/.

import { mkdirSync, writeFileSync } from "fs";
import path from "path";
import type { Page, WebSocket as PWWebSocket } from "playwright";
import { getPage } from "../bridge/browser.js";
import { getActiveCampaign } from "../registry/campaigns.js";

const WINDOW_MS = Number(process.env.PING_SNIFF_WINDOW_MS || 90_000);
const FRAME_CAP = 4000;

interface FrameRec { dir: "sent" | "recv"; t: number; len: number; payload: string }
interface SocketRec { url: string; openedAt: number; frames: FrameRec[] }

async function main() {
  const camp = getActiveCampaign();
  const t0 = Date.now();
  console.error(`[ping-sniff] campaign: ${camp.name} (roll20 ${camp.roll20CampaignId})`);

  const seed = await getPage("roll20");
  const ctx = seed.context();
  const page: Page = await ctx.newPage();

  const sockets: SocketRec[] = [];
  page.on("websocket", (ws: PWWebSocket) => {
    const rec: SocketRec = { url: ws.url(), openedAt: Date.now() - t0, frames: [] };
    sockets.push(rec);
    console.error(`[ping-sniff] websocket: ${ws.url()}`);
    const push = (dir: "sent" | "recv", data: string | Buffer) => {
      const s = typeof data === "string" ? data : `<binary ${data.length}b>`;
      rec.frames.push({ dir, t: Date.now() - t0, len: s.length, payload: s.slice(0, FRAME_CAP) });
    };
    ws.on("framesent", (d) => push("sent", d.payload));
    ws.on("framereceived", (d) => push("recv", d.payload));
  });

  const editorUrl = `https://app.roll20.net/editor/setcampaign/${camp.roll20CampaignId}/`;
  await page.goto(editorUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForFunction(
    () => typeof (window as any).Campaign !== "undefined" && typeof (window as any).Campaign.get === "function",
    undefined,
    { timeout: 60_000, polling: 500 },
  );
  const settleAt = Date.now() - t0;
  console.error(`[ping-sniff] editor ready at +${(settleAt / 1000).toFixed(1)}s.`);
  console.error(`\n>>> PING NOW in your own Roll20 window: shift+click a few different spots over the next ${WINDOW_MS / 1000}s.`);
  console.error(">>> Please don't move tokens or type chat during the window (keeps the capture clean).\n");

  await new Promise((r) => setTimeout(r, WINDOW_MS));

  // Summary: ping-ish frames first, then per-socket activity AFTER editor settle
  // (the load burst itself is thousands of frames — not what we're hunting).
  const PINGISH = /ping|cursor|radar/i;
  let tagged = 0;
  for (const s of sockets) {
    for (const f of s.frames) {
      if (f.t > settleAt + 2000 && PINGISH.test(f.payload)) {
        tagged++;
        console.error(`[PING?] ${f.dir} +${(f.t / 1000).toFixed(1)}s ${s.url.slice(0, 60)}\n        ${f.payload.slice(0, 500)}`);
      }
    }
  }
  if (!tagged) console.error("[ping-sniff] no /ping|cursor|radar/ frames after settle — check the post-settle traffic below / the dump.");

  for (const s of sockets) {
    const after = s.frames.filter((f) => f.t > settleAt + 2000);
    console.error(`socket ${s.url.slice(0, 80)} — total ${s.frames.length} frames, ${after.length} after settle`);
    // Show a sample of post-settle received traffic so an unexpected transport still surfaces.
    for (const f of after.filter((x) => x.dir === "recv").slice(0, 12)) {
      console.error(`   recv +${(f.t / 1000).toFixed(1)}s len=${f.len}: ${f.payload.slice(0, 220).replace(/\s+/g, " ")}`);
    }
  }

  const dumpDir = path.resolve("./.tmp-test-data");
  mkdirSync(dumpDir, { recursive: true });
  const file = path.join(dumpDir, `ping-sniff-${Date.now()}.json`);
  writeFileSync(file, JSON.stringify({ campaign: camp.roll20CampaignId, settleAt, sockets }, null, 2), "utf-8");
  console.error(`\n[ping-sniff] full dump → ${file}`);
  await page.close().catch(() => {});
  process.exit(0);
}

main().catch((e) => { console.error("ping-sniff FAILED:", e); process.exit(1); });
