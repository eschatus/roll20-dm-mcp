// Determine the REAL chat-send channel: when the UI sends a chat message, does it go out over the
// Firebase socket (a:"p" to /chat) or the signal2.roll20.net Phoenix socket? A raw Firebase /chat
// write was accepted but did NOT trigger the Mod — so the command-processing path is elsewhere.
//
// Sends a uniquely-marked plain chat message via the full UI path (synthetic keydown like the
// working relay) and reports which socket carried the outbound frame containing our marker.

import { writeFileSync, mkdirSync } from "fs";
import path from "path";
import type { Page, WebSocket as PWWebSocket } from "playwright";
import { getPage } from "../bridge/browser.js";
import { getActiveCampaign } from "../registry/campaigns.js";

async function main() {
  const camp = getActiveCampaign();
  const marker = "RECONSEND" + Date.now();
  const seed = await getPage("roll20");
  const ctx = seed.context();
  const page: Page = await ctx.newPage();

  interface Frame { socket: string; dir: "sent" | "recv"; t: number; payload: string }
  const frames: Frame[] = [];
  const t0 = Date.now();

  page.on("websocket", (ws: PWWebSocket) => {
    const url = ws.url();
    const tag = url.includes("firebaseio") ? "FIREBASE" : url.includes("signal2") ? "SIGNAL2" : url;
    ws.on("framesent", (d) => frames.push({ socket: tag, dir: "sent", t: Date.now() - t0, payload: String(d.payload).slice(0, 3000) }));
    ws.on("framereceived", (d) => frames.push({ socket: tag, dir: "recv", t: Date.now() - t0, payload: String(d.payload).slice(0, 3000) }));
  });

  await page.goto(`https://app.roll20.net/editor/setcampaign/${camp.roll20CampaignId}/`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForFunction(() => typeof (window as any).Campaign?.get === "function", undefined, { timeout: 30_000, polling: 500 }).catch(() => console.error("[send] Campaign global not seen; sending anyway"));
  await page.waitForTimeout(3000);

  // Full UI send (mirrors roll20.ts sendToChat): focus chat tab, fill, synthetic keydown + Enter.
  console.error(`[send] sending marker message: ${marker}`);
  await page.evaluate(() => { document.querySelector<HTMLElement>("a[href='#textchat']")?.click(); });
  const ta = await page.waitForSelector("#textchat-input textarea", { state: "attached", timeout: 15_000 });
  await ta.fill(marker);
  await page.evaluate(() => {
    const el = document.querySelector<HTMLTextAreaElement>("#textchat-input textarea");
    el?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, keyCode: 13, which: 13 }));
  });
  await ta.press("Enter").catch(() => {});

  await page.waitForTimeout(6000);

  const mine = frames.filter((f) => f.payload.includes(marker));
  console.error("\n=== CHAT SEND PATH ===");
  if (!mine.length) {
    console.error("marker not found in ANY socket frame — send may have gone via XHR, or didn't fire.");
  } else {
    for (const f of mine) {
      console.error(`>>> ${f.socket} [${f.dir} +${f.t}ms]`);
      console.error("    " + f.payload.replace(/\s+/g, " ").slice(0, 600));
    }
  }
  console.error(`\nframe counts: FIREBASE=${frames.filter(f => f.socket === "FIREBASE").length} SIGNAL2=${frames.filter(f => f.socket === "SIGNAL2").length}`);

  const dumpDir = path.resolve("./.tmp-test-data");
  mkdirSync(dumpDir, { recursive: true });
  const out = path.join(dumpDir, `chat-send-${t0}.json`);
  writeFileSync(out, JSON.stringify({ marker, frames }, null, 2), "utf-8");
  console.error(`full frames → ${out}`);
  await page.close().catch(() => {});
}

main().then(() => process.exit(0), (e) => { console.error("FAILED:", e); process.exit(1); });
