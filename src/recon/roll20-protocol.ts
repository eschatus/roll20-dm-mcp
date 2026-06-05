// Roll20 realtime-transport RECON spike (read-only capture; changes nothing in the campaign).
//
// Goal: determine whether we can replace the Playwright chat-typing relay with a raw realtime
// socket client that injects the `!ai-relay` chat message and reads the `AIBRIDGE_RESULT` whisper
// back — keeping the Mod script (mod-scripts/ai-relay.js) byte-for-byte unchanged.
//
// What it captures while driving ONE harmless round-trip (!ai-relay getTurnOrder):
//   1. Every WebSocket: url + all frames (sent/received), so we can see the realtime endpoint,
//      the auth handshake frame, the chat-write frame, and the whisper-read frame.
//   2. Bootstrap XHR/fetch traffic to roll20/firebase/google auth endpoints (where the realtime
//      auth token / firebase config is minted).
//   3. A snapshot of candidate window globals (firebase config, any token-ish fields).
//
// Run:  npx tsx src/recon/roll20-protocol.ts
// Output: .tmp-test-data/roll20-recon-<timestamp>.json  (full, local-only) + a redacted summary
//         to stderr. The dump is what we analyze to design the socket transport.

import { mkdirSync, writeFileSync } from "fs";
import path from "path";
import type { Page, WebSocket as PWWebSocket } from "playwright";
import { getPage } from "../bridge/browser.js";
import { getActiveCampaign } from "../registry/campaigns.js";

const FRAME_CAP = 8000; // per-frame payload chars kept in the dump
const SETTLE_MS = 8000; // how long to keep capturing after the chat send

// Domains whose XHR/fetch traffic is interesting for the auth/transport picture.
const NET_DOMAINS = [
  "roll20.net",
  "firebaseio.com",
  "googleapis.com",
  "identitytoolkit",
  "firebase",
  "d20.io",
];

// Markers that flag a frame as part of OUR round-trip so the summary can point right at it.
function tagFrame(payload: string, nonce: number): string[] {
  const tags: string[] = [];
  const p = payload.toLowerCase();
  if (payload.includes(String(nonce))) tags.push("OUR_NONCE");
  if (p.includes("ai-relay")) tags.push("AI_RELAY_CMD");
  if (payload.includes("AIBRIDGE_RESULT")) tags.push("AIBRIDGE_RESULT");
  if (p.includes('"a":"auth"') || p.includes('"action":"auth"') || p.includes("gauth")) tags.push("AUTH_HANDSHAKE");
  if (p.includes("turnorder")) tags.push("TURNORDER");
  return tags;
}

interface FrameRec {
  dir: "sent" | "recv";
  t: number;
  len: number;
  tags: string[];
  payload: string; // truncated to FRAME_CAP
}
interface SocketRec {
  url: string;
  openedAt: number;
  frames: FrameRec[];
}
interface NetRec {
  t: number;
  method: string;
  url: string;
  status?: number;
  reqHeaders?: Record<string, string>;
  respBodySample?: string;
}

async function main() {
  const camp = getActiveCampaign();
  const t0 = Date.now();
  const nonce = Date.now();

  console.error(`[recon] active campaign: ${camp.name} (roll20 ${camp.roll20CampaignId})`);

  // Ensure logged-in + get the context. Use a FRESH page so we attach listeners before the
  // realtime socket is established (the cached editor page already has an open socket).
  const seed = await getPage("roll20");
  const ctx = seed.context();
  const page: Page = await ctx.newPage();

  const sockets: SocketRec[] = [];
  const net: NetRec[] = [];

  page.on("websocket", (ws: PWWebSocket) => {
    const rec: SocketRec = { url: ws.url(), openedAt: Date.now() - t0, frames: [] };
    sockets.push(rec);
    console.error(`[recon] websocket opened: ${ws.url()}`);
    const push = (dir: "sent" | "recv", data: string | Buffer) => {
      const s = typeof data === "string" ? data : `<binary ${data.length}b>`;
      rec.frames.push({
        dir,
        t: Date.now() - t0,
        len: s.length,
        tags: tagFrame(s, nonce),
        payload: s.slice(0, FRAME_CAP),
      });
    };
    ws.on("framesent", (d) => push("sent", d.payload));
    ws.on("framereceived", (d) => push("recv", d.payload));
    ws.on("close", () => console.error(`[recon] websocket closed: ${ws.url()}`));
  });

  // XHR/fetch capture for auth-token / firebase-config endpoints.
  page.on("response", async (resp) => {
    const url = resp.url();
    if (!NET_DOMAINS.some((d) => url.includes(d))) return;
    const req = resp.request();
    if (req.resourceType() === "image" || req.resourceType() === "media" || req.resourceType() === "font") return;
    let respBodySample: string | undefined;
    try {
      const ct = resp.headers()["content-type"] || "";
      if (ct.includes("json") || ct.includes("text") || url.includes("token") || url.includes("auth")) {
        respBodySample = (await resp.text()).slice(0, 4000);
      }
    } catch { /* body unavailable (redirect / opaque) */ }
    net.push({
      t: Date.now() - t0,
      method: req.method(),
      url,
      status: resp.status(),
      reqHeaders: req.headers(),
      respBodySample,
    });
  });

  // --- Drive the connection ---
  const editorUrl = `https://app.roll20.net/editor/setcampaign/${camp.roll20CampaignId}/`;
  console.error(`[recon] navigating: ${editorUrl}`);
  await page.goto(editorUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForFunction(
    () => typeof (window as any).Campaign !== "undefined" && typeof (window as any).Campaign.get === "function",
    undefined,
    { timeout: 30_000, polling: 500 }
  );
  console.error("[recon] Campaign ready — snapshotting globals");

  // Snapshot candidate globals: anything that smells like firebase config or an auth token.
  const globals = await page.evaluate(() => {
    const out: Record<string, unknown> = {};
    const w = window as any;
    const probe = ["d20", "Campaign", "firebase", "gtoken", "FIREBASE", "_firebase", "currentPlayer"];
    for (const k of probe) {
      try { out[k] = typeof w[k] === "undefined" ? "<undefined>" : "<present>"; } catch { out[k] = "<err>"; }
    }
    // Scan top-level window keys for token/firebase/realtime-ish names (names only — values may be huge).
    const interesting: string[] = [];
    for (const k of Object.keys(w)) {
      if (/token|firebase|realtime|gauth|cred|campaign|d20/i.test(k)) interesting.push(k);
    }
    out.__interestingWindowKeys = interesting.slice(0, 80);
    // If firebase SDK is present, try to read the app options (config, no secrets).
    try {
      if (w.firebase?.apps?.length) {
        out.__firebaseAppOptions = w.firebase.apps.map((a: any) => a.options);
      }
    } catch { /* ignore */ }
    // d20 sometimes carries the campaign/firebase wiring.
    try {
      if (w.d20) out.__d20Keys = Object.keys(w.d20).slice(0, 80);
    } catch { /* ignore */ }
    return out;
  });

  // --- Trigger ONE relay round-trip (read-only Mod action) to capture chat-write + whisper-read frames.
  const payload = JSON.stringify({ action: "getTurnOrder", nonce });
  console.error(`[recon] sending !ai-relay getTurnOrder (nonce ${nonce})`);
  await page.evaluate(() => {
    const chatTab = document.querySelector<HTMLElement>("a[href='#textchat']");
    chatTab?.click();
  });
  const chatInput = await page.waitForSelector("#textchat-input textarea", { state: "attached", timeout: 15_000 });
  await chatInput.fill("!ai-relay " + payload);
  await chatInput.press("Enter");

  console.error(`[recon] capturing frames for ${SETTLE_MS}ms...`);
  await page.waitForTimeout(SETTLE_MS);

  // --- Persist + summarize ---
  const dumpDir = path.resolve("./.tmp-test-data");
  mkdirSync(dumpDir, { recursive: true });
  const outPath = path.join(dumpDir, `roll20-recon-${t0}.json`);
  writeFileSync(outPath, JSON.stringify({
    capturedAt: new Date(t0).toISOString(),
    campaign: { name: camp.name, roll20CampaignId: camp.roll20CampaignId },
    nonce,
    globals,
    sockets,
    net,
  }, null, 2), "utf-8");

  // Redacted stderr summary.
  console.error("\n=== RECON SUMMARY ===");
  console.error(`dump: ${outPath}`);
  console.error(`\nWebSockets (${sockets.length}):`);
  for (const s of sockets) {
    const tagged = s.frames.filter((f) => f.tags.length);
    console.error(`  ${s.url}`);
    console.error(`    frames: ${s.frames.length} (sent ${s.frames.filter(f => f.dir === "sent").length}, recv ${s.frames.filter(f => f.dir === "recv").length}); tagged: ${tagged.length}`);
    for (const f of tagged) {
      console.error(`      [${f.dir} +${f.t}ms ${f.len}b] ${f.tags.join(",")}  ${f.payload.slice(0, 200).replace(/\s+/g, " ")}`);
    }
  }
  console.error(`\nInteresting XHR/fetch (${net.length}):`);
  for (const n of net) {
    const authish = /token|auth|firebase|cred/i.test(n.url) || (n.respBodySample && /token|cred/i.test(n.respBodySample));
    console.error(`  [${n.method} ${n.status} +${n.t}ms]${authish ? " ***AUTH?***" : ""} ${n.url}`);
  }
  console.error(`\nGlobals: ${JSON.stringify(globals.__interestingWindowKeys)}`);
  console.error(`firebase app options: ${JSON.stringify(globals.__firebaseAppOptions ?? "n/a")}`);
  console.error("\n(Full frames + headers + bodies are in the dump file. Nothing in the campaign was modified.)");

  await page.close();
}

main().then(
  () => process.exit(0),
  (err) => { console.error("[recon] FAILED:", err); process.exit(1); }
);
