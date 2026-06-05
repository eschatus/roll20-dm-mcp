// NON-DESTRUCTIVE write-path probe. Goal: learn whether browserless WRITES to D&D Beyond are
// viable (the "replace Beyond20" question) WITHOUT mutating any live sheet.
//   - OPTIONS preflight: never mutates; reveals the endpoint exists + which methods it allows.
//   - empty/invalid body with a valid bearer: a 400/422 means "authenticated, bad input" (endpoint
//     live + auth accepted); 401/403 = auth rejected; 404 = wrong path; 405 = wrong method.
// Nothing here sends a well-formed mutating body, so no character data changes.
import { getPage } from "../bridge/browser.js";

const CHAR_SVC = "https://character-service.dndbeyond.com/character/v5";
const CHAR_ID = 142697619; // path-only; never receives a valid mutating body
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

async function harvestJwt(): Promise<{ jwt: string; cobalt: string }> {
  const page = await getPage("ddb");
  const cobalt = (await page.context().cookies()).find((c) => c.name === "CobaltSession" && c.domain.includes("dndbeyond"))?.value;
  await page.close().catch(() => {});
  if (!cobalt) throw new Error("no cobalt");
  const ex = await fetch("https://auth-service.dndbeyond.com/v1/cobalt-token", { method: "POST", headers: { "User-Agent": UA, "Content-Type": "application/json", Cookie: `CobaltSession=${cobalt}` } });
  return { jwt: (await ex.json()).token as string, cobalt };
}

async function probe(label: string, method: string, url: string, jwt: string, body?: string) {
  try {
    const headers: Record<string, string> = { "User-Agent": UA, Authorization: `Bearer ${jwt}` };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const res = await fetch(url, { method, headers, ...(body !== undefined ? { body } : {}) });
    const allow = res.headers.get("allow") || res.headers.get("access-control-allow-methods") || "";
    const text = (await res.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 160);
    const verdict =
      res.status === 401 || res.status === 403 ? "AUTH-REJECTED"
      : res.status === 404 ? "NOT-FOUND"
      : res.status === 405 ? "METHOD-NOT-ALLOWED"
      : res.status >= 400 && res.status < 500 ? "AUTH-OK/bad-input"
      : res.ok ? "ACCEPTED" : `status ${res.status}`;
    console.error(`[${verdict}] ${label}: ${method} → ${res.status}${allow ? ` allow=${allow}` : ""} ${text ? `body="${text}"` : ""}`);
  } catch (e) { console.error(`[ERR] ${label}: ${String(e).slice(0, 120)}`); }
}

async function main() {
  const { jwt } = await harvestJwt();
  console.error(`jwt len=${jwt.length}; probing (non-destructive)…\n`);

  // Historical endpoints used by this repo before DDB writes were removed.
  await probe("char PATCH (repo-historical)", "OPTIONS", `${CHAR_SVC}/character/${CHAR_ID}`, jwt);
  await probe("char PATCH empty-body",         "PATCH",   `${CHAR_SVC}/character/${CHAR_ID}`, jwt, "{}");
  await probe("condition (repo-historical)",   "OPTIONS", `${CHAR_SVC}/condition`, jwt);
  await probe("condition empty-body",          "POST",    `${CHAR_SVC}/condition`, jwt, "{}");

  // Candidate granular life endpoints (what the modern sheet / Beyond20 likely use).
  for (const seg of ["life/hp", "life/temp-hp", "life/death-saves", "hp"]) {
    await probe(`${seg} OPTIONS`, "OPTIONS", `${CHAR_SVC}/${seg}`, jwt);
    await probe(`${seg} empty-PUT`, "PUT", `${CHAR_SVC}/${seg}`, jwt, "{}");
  }
}
main().then(() => process.exit(0), (e) => { console.error("FAILED:", e); process.exit(1); });
