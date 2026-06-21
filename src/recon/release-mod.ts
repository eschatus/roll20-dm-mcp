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
import { spawnSync } from "child_process";
import * as campaigns from "../registry/campaigns.js";
import { deployModScript } from "../bridge/mod-editor.js";

async function main(): Promise<void> {
  const { roll20CampaignId, slug } = campaigns.getActiveCampaign();
  const scriptPath = resolve("mod-scripts/ai-relay.js");

  console.error(`[release] deploying ai-relay.js → campaign ${roll20CampaignId} (${slug})`);
  const r = await deployModScript(roll20CampaignId, scriptPath);
  console.error(`[release] deployed ${r.linesWritten} lines (created=${r.created}).`);

  console.error(`[release] running soak against ${slug}…`);
  const soak = spawnSync(
    process.platform === "win32" ? "npx.cmd" : "npx",
    ["tsx", "src/recon/soak-test.ts"],
    { stdio: "inherit" }
  );
  const code = soak.status ?? 1;
  console.error(`[release] ${code === 0 ? "OK — relay deployed and soaked clean." : "SOAK FAILED — investigate before relying on the live relay."}`);
  process.exit(code);
}

main().catch((e) => {
  console.error("[release] FAILED:", e instanceof Error ? e.message : e);
  process.exit(1);
});
