// Confirm the campaign-SET endpoint browserless. Avrae (ddb/waterdeep.py) uses
// GET /api/campaign/stt/active-campaigns. Our earlier cookie-only probe got SPA HTML; retry with
// bearer + cookie (the dual-auth that fixed active-short-characters).
import { rtRawFetch } from "../bridge/ddb-rt.js";

const WWW = "https://www.dndbeyond.com";

async function show(label: string, url: string) {
  const res = await rtRawFetch(url, { auth: "bearer", cookie: true });
  const ct = res.headers.get("content-type") || "";
  const body = await res.text();
  let info = "";
  if (/json/i.test(ct)) {
    try {
      const j = JSON.parse(body);
      const data = j.data ?? j;
      info = ` status=${j.status} count=${Array.isArray(data) ? data.length : "?"} sample=${JSON.stringify((Array.isArray(data) ? data[0] : data))?.slice(0, 240)}`;
    } catch { info = " (json parse failed)"; }
  }
  console.error(`[${res.ok ? "OK" : "--"}] ${label} → ${res.status} ct=${ct.slice(0, 25)} len=${body.length}${info}`);
}

async function main() {
  await show("stt/active-campaigns", `${WWW}/api/campaign/stt/active-campaigns`);
  await show("campaign/active-campaigns", `${WWW}/api/campaign/active-campaigns`);
}
main().then(() => process.exit(0), (e) => { console.error("FAILED:", e); process.exit(1); });
