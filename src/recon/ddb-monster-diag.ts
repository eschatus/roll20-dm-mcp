// Rediscover the browserless monster endpoint. The old www.dndbeyond.com/api/v5/monster path 404s.
// Probe the known DDB content services (monster-service by id/search, www search) with the
// exchanged JWT bearer. Harvest cobalt -> JWT first (one browser touch), then plain fetch.
import { writeFileSync, mkdirSync } from "fs";
import path from "path";
import { getPage } from "../bridge/browser.js";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const GOBLIN_ID = 16927; // well-known SRD goblin id on DDB; confirm shape if it resolves

async function get(name: string, url: string, headers: Record<string, string>) {
  try {
    const res = await fetch(url, { headers });
    const body = await res.text();
    const ct = res.headers.get("content-type") || "";
    let keys: unknown;
    if (/json/i.test(ct)) { try { const j = JSON.parse(body); const d = (j as { data?: unknown }).data ?? j; keys = Array.isArray(d) ? `array[${d.length}]` : (d && typeof d === "object" ? Object.keys(d as object).slice(0, 12) : typeof d); } catch { /* */ } }
    console.error(`[${res.ok ? "OK" : "--"}] ${name} status=${res.status} ct=${ct.slice(0, 30)} len=${body.length}${keys ? ` keys=${JSON.stringify(keys)}` : ""}`);
    return body;
  } catch (e) { console.error(`[ERR] ${name}: ${String(e).slice(0, 100)}`); return ""; }
}

async function main() {
  const page = await getPage("ddb");
  const cobalt = (await page.context().cookies()).find((c) => c.name === "CobaltSession" && c.domain.includes("dndbeyond"))?.value;
  await page.close().catch(() => {});
  if (!cobalt) throw new Error("no cobalt");
  const ex = await fetch("https://auth-service.dndbeyond.com/v1/cobalt-token", { method: "POST", headers: { "User-Agent": UA, "Content-Type": "application/json", Cookie: `CobaltSession=${cobalt}` } });
  const jwt = (await ex.json()).token as string;
  console.error(`[harvest] jwt len=${jwt.length}; browser closed.\n`);
  const H = { "User-Agent": UA, Accept: "application/json", Authorization: `Bearer ${jwt}` };

  const dump: Record<string, string> = {};
  dump.a = await get("monster-service by id",      `https://monster-service.dndbeyond.com/v1/Monster?ids=${GOBLIN_ID}`, H);
  dump.b = await get("monster-service id-bracket",  `https://monster-service.dndbeyond.com/v1/Monster?ids[]=${GOBLIN_ID}`, H);
  dump.c = await get("monster-service search",      `https://monster-service.dndbeyond.com/v1/Monster?search=goblin&take=5&skip=0`, H);
  dump.d = await get("monster-service take/skip",   `https://monster-service.dndbeyond.com/v1/Monster?skip=0&take=5&search=goblin`, H);
  dump.e = await get("www api monster (old path)",  `https://www.dndbeyond.com/api/v5/monster?name=goblin`, H);
  dump.f = await get("www api monsters search",     `https://www.dndbeyond.com/api/monsters/search?query=goblin`, H);
  dump.g = await get("staging monster-service",     `https://monster-service.dndbeyond.com/v1/Monster`, H);

  const dir = path.resolve("./.tmp-test-data"); mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `ddb-monster-${Date.now()}.json`);
  writeFileSync(out, JSON.stringify(dump, null, 2), "utf-8");
  console.error(`\nbodies → ${out}`);
}
main().then(() => process.exit(0), (e) => { console.error("FAILED:", e); process.exit(1); });
