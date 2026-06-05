// Diagnose the "fetch failed" against character-service.dndbeyond.com. We don't need auth to learn
// WHY the socket dies — print the undici error cause, then try node's https (HTTP/1.1) which often
// succeeds where undici's HTTP/2 negotiation fails. If https works, the bridge uses that.
import { request as httpsRequest } from "https";

const URL = "https://character-service.dndbeyond.com/character/v5/character/142697619";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

async function viaFetch() {
  try {
    const res = await fetch(URL, { headers: { "User-Agent": UA, Accept: "application/json" } });
    console.error(`[fetch] status=${res.status} len=${(await res.text()).length}`);
  } catch (err) {
    console.error(`[fetch] threw: ${String(err)}`);
    const cause = (err as { cause?: unknown }).cause;
    console.error(`[fetch] cause: ${cause ? JSON.stringify(cause, Object.getOwnPropertyNames(cause)) : "(none)"}`);
  }
}

function viaHttps(): Promise<void> {
  return new Promise((resolve) => {
    const req = httpsRequest(URL, { method: "GET", headers: { "User-Agent": UA, Accept: "application/json" } }, (res) => {
      let len = 0; res.on("data", (c) => (len += c.length));
      res.on("end", () => { console.error(`[https/1.1] status=${res.statusCode} len=${len}`); resolve(); });
    });
    req.on("error", (e) => { console.error(`[https/1.1] error: ${e.message}`); resolve(); });
    req.setTimeout(15000, () => { req.destroy(); console.error("[https/1.1] timeout"); resolve(); });
    req.end();
  });
}

async function main() {
  console.error(`node ${process.version}\nGET ${URL}\n`);
  await viaFetch();
  await viaHttps();
}
main().then(() => process.exit(0));
