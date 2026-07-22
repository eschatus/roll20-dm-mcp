// RECON SPIKE — discover the D&D Beyond dice/game-log surface so we can build a
// browserless DDB-roll → Roll20-chat pump. READ-ONLY: it observes traffic while
// YOU roll; it writes nothing to DDB or Roll20.
//
// The DDB dice roller posts to a campaign "Game Log" keyed by the DDB game id.
// We don't yet know the endpoint, whether the cobalt→JWT authorizes it, or the
// transport (REST poll vs WebSocket/Pusher). This finds all three by capturing
// every request + WS frame on the logged-in campaign page while a roll happens,
// then flagging anything that looks like game-log / dice / realtime traffic.
//
// Run (active campaign, or pass a slug):
//   npx tsx src/recon/ddb-gamelog-probe.ts [slug] [seconds]
// Then, within the capture window, ROLL A DIE in that campaign (DDB app, the
// site's dice roller, or a character sheet). The report names the endpoint and
// shows the roll payload.

import { writeFileSync, mkdirSync } from "fs";
import path from "path";
import type { Page, Request as PWRequest, WebSocket as PWWebSocket } from "playwright";
import { getPage } from "../bridge/browser.js";
import { getActiveCampaign, listCampaigns } from "../registry/campaigns.js";

// Hosts/paths that smell like a game-log, dice, or realtime channel.
const INTEREST = /(gamelog|game-log|game_log|dice|roll|pusher|ably|signalr|message-broker|messagebroker|realtime|ws-|websocket|broadcast|game-service|gameservice|game\/log|\/games?\/)/i;
// DDB-owned or realtime hosts worth keeping even without a keyword hit.
const DDB_HOST = /(dndbeyond\.com|ddb\.ac|pusher\.com|pusherapp\.com|ably\.io)/i;

interface Req { t: number; method: string; url: string; status?: number; type: string; reqBody?: string; resSnippet?: string }
interface Frame { t: number; url: string; dir: "sent" | "recv"; payload: string }

async function main() {
  const arg = process.argv[2];
  const slug = arg && !/^\d+$/.test(arg) ? arg : undefined;
  const seconds = Number(process.argv[3] || (arg && /^\d+$/.test(arg) ? arg : "") || 90);
  const camp = slug
    ? listCampaigns().find((c) => c.slug === slug || c.slug.includes(slug))
    : getActiveCampaign();
  if (!camp) throw new Error(`campaign not found: ${slug} (try one of: ${listCampaigns().map((c) => c.slug).join(", ")})`);
  if (!camp.ddbCampaignId || camp.ddbCampaignId === "0") {
    throw new Error(`campaign "${(camp as { slug?: string }).slug ?? slug}" has no ddbCampaignId — the game log is keyed by it. Pick a DDB-linked campaign.`);
  }
  const gameId = camp.ddbCampaignId;
  console.error(`[gamelog-probe] campaign=${(camp as { slug?: string }).slug ?? slug} ddbGameId=${gameId} window=${seconds}s`);

  const seed = await getPage("ddb");         // logged-in DDB context (CobaltSession present)
  const ctx = seed.context();
  const page: Page = await ctx.newPage();
  const t0 = Date.now();

  const reqs: Req[] = [];
  const frames: Frame[] = [];
  const wsUrls = new Set<string>();

  // --- capture every request + response (REST/XHR/fetch) ---
  page.on("request", (r: PWRequest) => {
    const url = r.url();
    if (!DDB_HOST.test(url) && !INTEREST.test(url)) return;
    let reqBody: string | undefined;
    try { reqBody = r.postData() || undefined; } catch { /* binary/none */ }
    reqs.push({ t: Date.now() - t0, method: r.method(), url, type: r.resourceType(), reqBody: reqBody?.slice(0, 2000) });
  });
  page.on("response", async (res) => {
    const url = res.url();
    if (!DDB_HOST.test(url) && !INTEREST.test(url)) return;
    const rec = reqs.find((q) => q.url === url && q.status === undefined);
    if (!rec) return;
    rec.status = res.status();
    if (INTEREST.test(url)) {
      try {
        const ct = res.headers()["content-type"] || "";
        if (/json|text/.test(ct)) rec.resSnippet = (await res.text()).slice(0, 4000);
      } catch { /* streamed/opaque */ }
    }
  });

  // --- capture every websocket + its frames (dice often arrive here) ---
  page.on("websocket", (ws: PWWebSocket) => {
    const url = ws.url();
    wsUrls.add(url);
    ws.on("framesent", (d) => frames.push({ t: Date.now() - t0, url, dir: "sent", payload: String(d.payload).slice(0, 3000) }));
    ws.on("framereceived", (d) => frames.push({ t: Date.now() - t0, url, dir: "recv", payload: String(d.payload).slice(0, 3000) }));
  });

  // Land on the campaign page — the game log lives here and its history + realtime channel load here.
  const campUrl = `https://www.dndbeyond.com/campaigns/${gameId}`;
  console.error(`[gamelog-probe] opening ${campUrl}`);
  await page.goto(campUrl, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch((e) => console.error("[gamelog-probe] nav warn:", (e as Error).message));

  // History mode: the log history XHR fires as the game-log panel renders. Nudge it open and scroll
  // so any lazy-loaded pages fetch too. Selectors are best-effort — capture works regardless.
  await page.waitForTimeout(4000);
  for (const sel of ["[class*='gameLog' i] button", "[class*='game-log' i]", "a[href*='game-log']", "button[aria-label*='log' i]", "[data-testid*='log' i]"]) {
    try { const el = await page.$(sel); if (el) { await el.click({ timeout: 1500 }).catch(() => {}); } } catch { /* not present */ }
  }
  // Scroll the tallest scrollable panel a few times to trigger history pagination.
  for (let i = 0; i < 4; i++) {
    await page.evaluate(() => {
      const els = [...document.querySelectorAll<HTMLElement>("*")].filter((e) => e.scrollHeight > e.clientHeight + 40);
      els.sort((a, b) => b.scrollHeight - a.scrollHeight);
      if (els[0]) els[0].scrollTop = 0; // scroll UP → older log entries page in
    }).catch(() => {});
    await page.waitForTimeout(1500);
  }

  console.error(`>>> Reading game-log history. (Roll on Broo's sheet now too, if you like — it'll be captured.)`);
  console.error(`>>> Watching for ${seconds}s…\n`);

  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    await page.waitForTimeout(3000);
    const hits = [...reqs.filter((r) => INTEREST.test(r.url)), ...frames.filter((f) => /roll|dice|"?result"?|d20|"?total"?/i.test(f.payload))];
    process.stderr.write(`\r[gamelog-probe] captured: ${reqs.length} reqs · ${frames.length} ws-frames · ${hits.length} interesting   `);
  }
  console.error("");

  // --- report ---
  const interestingReqs = reqs.filter((r) => INTEREST.test(r.url));
  const rollFrames = frames.filter((f) => /roll|dice|d20|"result"|"total"|"dieType"|notification/i.test(f.payload));

  console.error("\n══════════ WEBSOCKETS SEEN ══════════");
  for (const u of wsUrls) console.error("  " + u);

  console.error("\n══════════ GAME-LOG / DICE REST CANDIDATES ══════════");
  const seen = new Set<string>();
  for (const r of interestingReqs) {
    const key = r.method + " " + r.url.split("?")[0];
    if (seen.has(key)) continue; seen.add(key);
    console.error(`  ${r.method} ${r.status ?? "?"}  ${r.url.slice(0, 140)}`);
    if (r.resSnippet) console.error("      ↳ " + r.resSnippet.replace(/\s+/g, " ").slice(0, 240));
  }
  if (!interestingReqs.length) console.error("  (none — the roll likely arrives over a WebSocket; see frames below)");

  console.error("\n══════════ ROLL-SHAPED WS FRAMES ══════════");
  for (const f of rollFrames.slice(0, 12)) {
    console.error(`  [${f.dir} +${f.t}ms] ${f.url.split("?")[0].slice(0, 60)}`);
    console.error("      " + f.payload.replace(/\s+/g, " ").slice(0, 400));
  }
  if (!rollFrames.length) console.error("  (none matched roll keywords — inspect the full dump)");

  // Full dump for offline analysis (endpoint, auth headers, payload schema).
  const outDir = path.join(process.cwd(), "data", "recon");
  mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `ddb-gamelog-${gameId}-${t0}.json`);
  writeFileSync(outFile, JSON.stringify({ gameId, campUrl, wsUrls: [...wsUrls], reqs, frames }, null, 2));
  console.error(`\n[gamelog-probe] full capture → ${outFile}`);
  console.error(`[gamelog-probe] reqs=${reqs.length} frames=${frames.length}. Analyze the file for the endpoint + payload, then we design the browserless read.`);

  await page.close().catch(() => {});
}

main().then(() => process.exit(0)).catch((e) => { console.error("[gamelog-probe] FAILED:", (e as Error).message); process.exit(1); });
