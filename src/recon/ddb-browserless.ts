// Validate a BROWSERLESS D&D Beyond path. We touch the browser exactly once — to harvest the
// CobaltSession cookie from the persistent logged-in profile — then make every API call with
// plain Node `fetch` (no Chromium network stack) to see what actually survives without a browser:
//   - the cobalt -> short-lived JWT exchange (auth-service, Avrae-style)
//   - character-service reads (api host, bearer)
//   - monster reads on www.dndbeyond.com (Cloudflare-fronted — the real risk)
//   - campaign + campaign-character listing via API instead of DOM scraping
// Full response bodies (which contain live tokens / PII) go to gitignored .tmp-test-data only;
// stderr gets status/shape/Cloudflare verdict.

import { writeFileSync, mkdirSync } from "fs";
import path from "path";
import { getPage } from "../bridge/browser.js";

const CHAR_ID = 142697619;      // Zeno (Beyond Phandelver)
const MONSTER = "goblin";
const CAMPAIGN_ID = "7469632";  // Beyond Phandelver

const CHAR_SVC = "https://character-service.dndbeyond.com/character/v5";
const WWW = "https://www.dndbeyond.com";
const AUTH_SVC = "https://auth-service.dndbeyond.com/v1/cobalt-token";

// A realistic desktop-Chrome UA + Accept set, in case Cloudflare bot-fingerprints bare fetch.
const BROWSERISH = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept": "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
};

interface Probe {
  name: string;
  status: number | string;
  ok: boolean;
  contentType: string;
  bodyLen: number;
  cloudflare: boolean;
  note?: string;
  sample?: unknown;
}

function looksLikeCloudflare(ct: string, body: string): boolean {
  if (/text\/html/i.test(ct) && /just a moment|cf-|challenge|cloudflare|attention required/i.test(body)) return true;
  return false;
}

async function probe(name: string, url: string, init: RequestInit): Promise<{ p: Probe; body: string }> {
  try {
    const res = await fetch(url, init);
    const body = await res.text();
    const ct = res.headers.get("content-type") || "";
    const cf = looksLikeCloudflare(ct, body);
    let sample: unknown;
    if (/json/i.test(ct) && !cf) {
      try {
        const j = JSON.parse(body);
        const d = (j as { data?: unknown }).data ?? j;
        // Tiny shape sample only — never the whole sheet.
        if (d && typeof d === "object") sample = Object.keys(d as object).slice(0, 12);
      } catch { /* not json after all */ }
    }
    return {
      p: { name, status: res.status, ok: res.ok, contentType: ct.slice(0, 40), bodyLen: body.length, cloudflare: cf, sample },
      body,
    };
  } catch (err) {
    return { p: { name, status: "ERR", ok: false, contentType: "", bodyLen: 0, cloudflare: false, note: String(err) }, body: "" };
  }
}

async function main() {
  // --- the one browser touch: harvest the cobalt cookie ---
  const page = await getPage("ddb");
  const cookies = await page.context().cookies();
  const cobalt = cookies.find((c) => c.name === "CobaltSession" && c.domain.includes("dndbeyond"))?.value;
  await page.close().catch(() => {});
  if (!cobalt) throw new Error("CobaltSession cookie not found — log into DDB in the browser first");
  console.error(`[harvest] CobaltSession present (len=${cobalt.length}) — browser closed; everything below is plain fetch.\n`);

  const cookieHeader = `CobaltSession=${cobalt}`;
  const results: Probe[] = [];
  const dump: Record<string, string> = {};

  // --- A) cobalt -> short-lived JWT exchange ---
  const exchange = await probe("A exchange cobalt->JWT (auth-service)", AUTH_SVC, {
    method: "POST",
    headers: { ...BROWSERISH, "Content-Type": "application/json", Cookie: cookieHeader, Origin: WWW, Referer: `${WWW}/` },
  });
  results.push(exchange.p);
  dump["A-exchange"] = exchange.body;
  let jwt: string | null = null;
  try { jwt = JSON.parse(exchange.body).token ?? null; } catch { /* */ }
  console.error(`[A] JWT minted: ${jwt ? `yes (len=${jwt.length}, segs=${jwt.split(".").length})` : "NO"}`);

  const bearer = (t: string) => ({ ...BROWSERISH, Authorization: `Bearer ${t}` });

  // --- B) character read, cobalt value used directly as bearer (current code's assumption) ---
  results.push((await probe("B char read (cobalt-as-bearer)", `${CHAR_SVC}/character/${CHAR_ID}`, { headers: bearer(cobalt) })).p);

  // --- C) character read with the exchanged JWT bearer ---
  if (jwt) results.push((await probe("C char read (JWT bearer)", `${CHAR_SVC}/character/${CHAR_ID}`, { headers: bearer(jwt) })).p);

  // --- C2) character read with NO auth (public/shared sheets) ---
  results.push((await probe("C2 char read (no auth)", `${CHAR_SVC}/character/${CHAR_ID}`, { headers: BROWSERISH })).p);

  // --- D) monster read on the Cloudflare-fronted www host ---
  const monUrl = `${WWW}/api/v5/monster?name=${encodeURIComponent(MONSTER)}`;
  if (jwt) results.push((await probe("D monster (www, JWT bearer)", monUrl, { headers: bearer(jwt) })).p);
  results.push((await probe("D2 monster (www, cobalt cookie)", monUrl, { headers: { ...BROWSERISH, Cookie: cookieHeader } })).p);
  results.push((await probe("D3 monster (www, no auth)", monUrl, { headers: BROWSERISH })).p);

  // --- E) campaigns list via API (replace DOM scrape) ---
  const camps = await probe("E active-campaigns (cobalt cookie)", `${WWW}/api/campaign/stt/active-campaigns`, {
    headers: { ...BROWSERISH, Cookie: cookieHeader },
  });
  results.push(camps.p); dump["E-campaigns"] = camps.body;

  // --- F) campaign characters via API (replace DOM scrape) ---
  for (const [label, url] of [
    ["F1 campaign chars (character-service)", `${CHAR_SVC}/campaign/${CAMPAIGN_ID}/characters`],
    ["F2 campaign chars (www api)", `${WWW}/api/campaign/stt/active-short-characters/${CAMPAIGN_ID}`],
  ] as const) {
    const r = await probe(label, url, { headers: { ...BROWSERISH, Authorization: jwt ? `Bearer ${jwt}` : "", Cookie: cookieHeader } });
    results.push(r.p); dump[label.slice(0, 2)] = r.body;
  }

  // --- report ---
  console.error("\n=== BROWSERLESS PROBE RESULTS ===");
  for (const r of results) {
    const flags = [r.ok ? "OK" : "FAIL", r.cloudflare ? "CLOUDFLARE" : ""].filter(Boolean).join(" ");
    console.error(`[${flags}] ${r.name} — status=${r.status} ct=${r.contentType} len=${r.bodyLen}${r.sample ? ` keys=${JSON.stringify(r.sample)}` : ""}${r.note ? ` note=${r.note.slice(0, 120)}` : ""}`);
  }

  const dir = path.resolve("./.tmp-test-data");
  mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `ddb-browserless-${Date.now()}.json`);
  writeFileSync(out, JSON.stringify({ results, dump }, null, 2), "utf-8");
  console.error(`\nfull bodies → ${out}`);
}

main().then(() => process.exit(0), (e) => { console.error("recon FAILED:", e); process.exit(1); });
