// Capture how the UI sends an !ai-relay COMMAND (type api) — which may differ from a plain message
// — and WHERE the Mod's AIBRIDGE_RESULT response lands. The old Playwright relay works by typing
// the command, so this path DOES trigger the Mod. We watch both sockets + XHR, send the real
// command via the full UI path, and hunt for our nonce (outbound) and AIBRIDGE_RESULT (response).

import { writeFileSync, mkdirSync } from "fs";
import path from "path";
import type { Page, WebSocket as PWWebSocket } from "playwright";
import { getPage } from "../bridge/browser.js";
import { getActiveCampaign } from "../registry/campaigns.js";

async function main() {
  const camp = getActiveCampaign();
  const nonce = Date.now();
  const seed = await getPage("roll20");
  const ctx = seed.context();
  const page: Page = await ctx.newPage();
  const t0 = Date.now();

  interface Frame { ch: string; dir: string; t: number; payload: string }
  const frames: Frame[] = [];
  const xhrs: { t: number; method: string; url: string; status?: number; body?: string }[] = [];

  page.on("websocket", (ws: PWWebSocket) => {
    const url = ws.url();
    const ch = url.includes("firebaseio") ? "FIREBASE" : url.includes("signal2") ? "SIGNAL2" : url.slice(0, 40);
    ws.on("framesent", (d) => frames.push({ ch, dir: "sent", t: Date.now() - t0, payload: String(d.payload).slice(0, 4000) }));
    ws.on("framereceived", (d) => frames.push({ ch, dir: "recv", t: Date.now() - t0, payload: String(d.payload).slice(0, 4000) }));
  });
  page.on("response", async (resp) => {
    const url = resp.url();
    if (!/roll20\.net\/(editor|campaigns|v2)/.test(url) || /analytics|\.js|\.css|\.png/.test(url)) return;
    let body: string | undefined;
    try { body = (await resp.text()).slice(0, 2000); } catch { /* */ }
    xhrs.push({ t: Date.now() - t0, method: resp.request().method(), url, status: resp.status(), body });
  });

  await page.goto(`https://app.roll20.net/editor/setcampaign/${camp.roll20CampaignId}/`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForFunction(() => typeof (window as any).Campaign?.get === "function", undefined, { timeout: 30_000, polling: 500 }).catch(() => {});
  await page.waitForTimeout(3000);

  const cmd = `!ai-relay {"action":"getTurnOrder","nonce":${nonce}}`;
  console.error(`[cmd] sending: ${cmd}`);
  await page.evaluate(() => { document.querySelector<HTMLElement>("a[href='#textchat']")?.click(); });
  const ta = await page.waitForSelector("#textchat-input textarea", { state: "attached", timeout: 15_000 });
  await ta.fill(cmd);
  await page.evaluate(() => {
    const el = document.querySelector<HTMLTextAreaElement>("#textchat-input textarea");
    el?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, keyCode: 13, which: 13 }));
  });
  await ta.press("Enter").catch(() => {});

  await page.waitForTimeout(8000);

  console.error("\n=== OUTBOUND (our nonce " + nonce + ") ===");
  for (const f of frames.filter((x) => x.payload.includes(String(nonce)))) {
    console.error(`>>> ${f.ch} [${f.dir} +${f.t}ms] ${f.payload.replace(/\s+/g, " ").slice(0, 500)}`);
  }
  for (const x of xhrs.filter((x) => (x.body || "").includes(String(nonce)) || x.url.includes(String(nonce)))) {
    console.error(`>>> XHR ${x.method} ${x.status} ${x.url}`);
  }

  console.error("\n=== AIBRIDGE_RESULT response location ===");
  const resp = frames.filter((f) => f.payload.includes("AIBRIDGE_RESULT"));
  if (resp.length) {
    for (const f of resp) console.error(`<<< ${f.ch} [${f.dir} +${f.t}ms] ${f.payload.replace(/\s+/g, " ").slice(0, 600)}`);
  } else {
    console.error("AIBRIDGE_RESULT not seen in any socket frame within window.");
  }
  const respXhr = xhrs.filter((x) => (x.body || "").includes("AIBRIDGE_RESULT"));
  for (const x of respXhr) console.error(`<<< XHR ${x.method} ${x.status} ${x.url}`);

  console.error(`\nframe counts: FIREBASE=${frames.filter(f => f.ch === "FIREBASE").length} SIGNAL2=${frames.filter(f => f.ch === "SIGNAL2").length}`);
  const dumpDir = path.resolve("./.tmp-test-data");
  mkdirSync(dumpDir, { recursive: true });
  const out = path.join(dumpDir, `command-send-${t0}.json`);
  writeFileSync(out, JSON.stringify({ nonce, frames, xhrs }, null, 2), "utf-8");
  console.error(`full → ${out}`);
  await page.close().catch(() => {});
}

main().then(() => process.exit(0), (e) => { console.error("FAILED:", e); process.exit(1); });
