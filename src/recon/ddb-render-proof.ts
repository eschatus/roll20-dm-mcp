// Deterministic render proof: pull Broo's REAL rolls from REST history and run them
// through the production renderer — the exact string the pump posts to Roll20.
import { rtAuthToken, rtRawFetch } from "../bridge/ddb-rt.js";
import { renderRollForRoll20, type DdbGameLogMessage } from "../bridge/ddb-gamelog.js";

async function main() {
  const { userId } = await rtAuthToken();
  const res = await rtRawFetch(`https://game-log-rest-live.dndbeyond.com/v1/getmessages?gameId=1117568&userId=${userId}`, { auth: "bearer" });
  const body = await res.json() as { data: DdbGameLogMessage[] };
  const broo = body.data.filter((m) => m.entityId === "130003005" && m.eventType === "dice/roll/fulfilled");
  console.error(`Broo rolls in recent history: ${broo.length}\n`);
  for (const m of broo.slice(0, 4)) {
    const { speakAs, message } = renderRollForRoll20(m);
    console.error(`speakAs: ${speakAs}`);
    console.error(`message: ${message}\n`);
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error("FAILED:", (e as Error).message); process.exit(1); });
