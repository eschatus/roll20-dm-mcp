// Prove the game-log read works browserlessly (no Playwright) via the cobalt→JWT.
// Tries each auth mode against getmessages; reports which authorizes + shows Broo's rolls.
import { rtRawFetch } from "../bridge/ddb-rt.js";

const GAME = "1117568";
const BROO = "130003005";

function userIdFromJwt(jwt: string): string | null {
  try {
    const c = JSON.parse(Buffer.from(jwt.split(".")[1], "base64").toString());
    return c["http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier"] ?? null;
  } catch { return null; }
}

async function main() {
  // Grab a JWT (bearer) once to derive userId, and reuse for the bearer attempt.
  const probe = await rtRawFetch("https://auth-service.dndbeyond.com/v1/cobalt-token", { auth: "cookie", method: "POST", body: "{}" }).catch(() => null);
  let userId = "100135749"; // DM userId seen in the probe; refined from JWT if available
  try { const j = await probe?.clone().json(); if (j?.token) userId = userIdFromJwt(j.token) ?? userId; } catch { /* keep default */ }
  console.error("[browserless] userId =", userId);

  const url = `https://game-log-rest-live.dndbeyond.com/v1/getmessages?gameId=${GAME}&userId=${userId}`;
  for (const auth of ["bearer", "cookie", "none"] as const) {
    try {
      const res = await rtRawFetch(url, { auth });
      const txt = await res.text();
      let broo = 0, total = 0;
      try {
        const d = JSON.parse(txt);
        total = (d.data ?? []).length;
        broo = (d.data ?? []).filter((m: { entityId?: string; eventType?: string }) => m.entityId === BROO && m.eventType === "dice/roll/fulfilled").length;
      } catch { /* non-json */ }
      console.error(`[browserless] auth=${auth.padEnd(6)} -> ${res.status}  msgs=${total}  broo-rolls=${broo}  ${res.status !== 200 ? txt.slice(0,120) : ""}`);
    } catch (e) {
      console.error(`[browserless] auth=${auth.padEnd(6)} -> ERROR ${(e as Error).message.slice(0,120)}`);
    }
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error("FAILED:", (e as Error).message); process.exit(1); });
