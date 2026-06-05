// Pinpoint the browserless HP-write endpoint (non-destructive). death-saves proved the pattern is
// PUT character/v5/life/<segment> with a JSON body the server validates; an empty PUT yields a 400
// that NAMES the required fields without changing anything. Enumerate HP-ish segments and report
// which one is live (400/auth-ok) vs 404/405.
import { getPage } from "../bridge/browser.js";

const CHAR_SVC = "https://character-service.dndbeyond.com/character/v5";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

async function jwt(): Promise<string> {
  const page = await getPage("ddb");
  const cobalt = (await page.context().cookies()).find((c) => c.name === "CobaltSession" && c.domain.includes("dndbeyond"))?.value;
  await page.close().catch(() => {});
  const ex = await fetch("https://auth-service.dndbeyond.com/v1/cobalt-token", { method: "POST", headers: { "User-Agent": UA, "Content-Type": "application/json", Cookie: `CobaltSession=${cobalt}` } });
  return (await ex.json()).token as string;
}

async function emptyPut(seg: string, token: string) {
  try {
    const res = await fetch(`${CHAR_SVC}/${seg}`, { method: "PUT", headers: { "User-Agent": UA, Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: "{}" });
    const t = (await res.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 200);
    const v = res.status === 404 ? "404" : res.status === 405 ? "405" : res.status === 400 ? "LIVE(400)" : res.ok ? "OK" : String(res.status);
    console.error(`[${v}] PUT ${seg} → ${res.status}${res.status === 400 ? ` fields="${t}"` : ""}`);
  } catch (e) { console.error(`[ERR] ${seg}: ${String(e).slice(0, 80)}`); }
}

async function main() {
  const t = await jwt();
  console.error("probing HP segments (empty PUT, non-destructive)…\n");
  for (const seg of [
    "hit-points", "hitpoints", "life/hp", "health", "damage", "damage-taken",
    "temporary-hit-points", "temp-hit-points", "bonus-hit-points", "override-hit-points",
    "condition",
  ]) {
    await emptyPut(seg, t);
  }
}
main().then(() => process.exit(0), (e) => { console.error("FAILED:", e); process.exit(1); });
