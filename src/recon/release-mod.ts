// One-command Mod release: deploy mod-scripts/ai-relay.js to the ACTIVE campaign,
// then run the live soak and propagate its pass/fail as the exit code.
//
// Red-team #2: the manual paste-into-the-Roll20-console deploy is the project's
// central "works-on-my-machine" hazard, and nothing verified the live copy matched
// the repo. This makes "ship the relay" a single audited step:
//
//     npm run release:mod          (or: tsx src/recon/release-mod.ts)
//
// Deploy is browser-automation (background page; does NOT disturb a live session);
// the soak runs over RT. Exits non-zero if the deploy throws or the soak fails — so
// it's safe to gate a "relay is live and healthy" claim on it.
process.env.ROLL20_TRANSPORT = "rt";

import { resolve } from "path";
import * as campaigns from "../registry/campaigns.js";
import { deployModScript } from "../bridge/mod-editor.js";
import { runSoak } from "./soak-test.js";

async function main(): Promise<void> {
  const { roll20CampaignId, slug } = campaigns.getActiveCampaign();
  const scriptPath = resolve("mod-scripts/ai-relay.js");

  console.error(`[release] deploying ai-relay.js → campaign ${roll20CampaignId} (${slug})`);
  // requireExisting: a release must only ever OVERWRITE the relay tab, never create a
  // second one. getModPage now waits for the tab bar to render (the real fix); this is
  // the belt-and-suspenders — if the match still fails, throw instead of duplicating.
  const r = await deployModScript(roll20CampaignId, scriptPath, { requireExisting: true });
  console.error(`[release] deployed ${r.linesWritten} lines (created=${r.created}).`);

  // The save REBOOTS the sandbox. Wait for it to warm before soaking — a cold sandbox
  // races RTDB propagation on the first writes and false-fails. Do NOT open an RT
  // connection here to poll: the soak runs as a child with its OWN RT connection, and
  // a second listener on the same campaign collides with it. A fixed settle keeps this
  // process RT-free so the child soak is the sole connection.
  const settleMs = 12_000;
  console.error(`[release] letting the rebooted sandbox warm up (${settleMs / 1000}s)…`);
  await new Promise((res) => setTimeout(res, settleMs));

  // Run the soak IN-PROCESS — share this process's browser + RT connection (the
  // deploy already opened the browser). A child process can't share the browser
  // profile, so it can't bootstrap RT and false-fails.
  console.error(`[release] running soak against ${slug}…`);
  const fail = await runSoak();
  const code = fail === 0 ? 0 : 1;
  console.error(`[release] ${code === 0 ? "OK — relay deployed and soaked clean." : "SOAK FAILED — investigate before relying on the live relay."}`);
  process.exit(code);
}

main().catch((e) => {
  console.error("[release] FAILED:", e instanceof Error ? e.message : e);
  process.exit(1);
});
