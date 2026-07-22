// Prove the game-log WebSocket accepts a Node client with our cobalt→JWT as `stt`.
// Connects, logs frames for a window; if you roll on Broo's sheet it should push instantly.
import WebSocket from "ws";
import { rtRawFetch } from "../bridge/ddb-rt.js";

const GAME = "1117568";
const BROO = "130003005";

async function mintStt(): Promise<{ token: string; userId: string }> {
  // Same cobalt→JWT the getmessages bearer used (proven). Exchange via auth-service.
  const res = await rtRawFetch("https://auth-service.dndbeyond.com/v1/cobalt-token", { auth: "cookie", method: "POST", body: "{}" });
  const { token } = await res.json() as { token: string };
  const c = JSON.parse(Buffer.from(token.split(".")[1], "base64").toString());
  return { token, userId: c["http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier"] };
}

async function main() {
  const seconds = Number(process.argv[2] || 40);
  const { token, userId } = await mintStt();
  const url = `wss://game-log-api-live.dndbeyond.com/v1?gameId=${GAME}&userId=${userId}&stt=${token}`;
  console.error(`[ws] connecting as userId=${userId} …`);

  const ws = new WebSocket(url, {
    headers: { Origin: "https://www.dndbeyond.com", "User-Agent": "Mozilla/5.0" },
  });
  let frames = 0, brooRolls = 0;

  ws.on("open", () => console.error("[ws] OPEN — connection accepted. Roll on Broo's sheet to see a live push.\n"));
  ws.on("message", (buf: Buffer) => {
    frames++;
    const s = buf.toString();
    let m: { eventType?: string; entityId?: string; data?: { action?: string; rolls?: unknown[] } } | null = null;
    try { m = JSON.parse(s); } catch { /* keepalive/binary */ }
    const isRoll = m?.eventType === "dice/roll/fulfilled";
    const isBroo = m?.entityId === BROO;
    if (isRoll && isBroo) brooRolls++;
    console.error(`[ws] frame#${frames} ${m?.eventType ?? "(non-json)"}${isBroo ? " «BROO»" : ""}${m?.data?.action ? " — " + m.data.action : ""}  ${s.slice(0, 100)}`);
  });
  ws.on("error", (e) => console.error("[ws] ERROR:", (e as Error).message));
  ws.on("close", (code, reason) => console.error(`[ws] CLOSE ${code} ${reason.toString().slice(0,80)}`));

  await new Promise((r) => setTimeout(r, seconds * 1000));
  console.error(`\n[ws] window done: ${frames} frames, ${brooRolls} Broo rolls. accepted=${ws.readyState !== WebSocket.CLOSED}`);
  ws.close();
}
main().then(() => process.exit(0)).catch((e) => { console.error("FAILED:", (e as Error).message); process.exit(1); });
