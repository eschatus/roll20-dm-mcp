// Pinpoint the Firebase custom-token source + what's harvestable for browserless auth.
// Writes token VALUES only to a local gitignored file; prints presence/shape/source to stderr.

import { writeFileSync, mkdirSync } from "fs";
import path from "path";
import { getPage } from "../bridge/browser.js";
import { getActiveCampaign } from "../registry/campaigns.js";

function shape(tok?: string | null) {
  if (!tok) return { present: false };
  return { present: true, len: tok.length, dotSegments: tok.split(".").length };
}

async function main() {
  const camp = getActiveCampaign();
  const page = await getPage("roll20");

  // Capture the custom token the browser POSTs to signInWithCustomToken (the input we need).
  let customToken: string | null = null;
  page.on("request", (req) => {
    if (req.url().includes("signInWithCustomToken")) {
      try {
        const body = JSON.parse(req.postData() || "{}");
        if (body.token) customToken = body.token;
      } catch { /* ignore */ }
    }
  });

  await page.goto(`https://app.roll20.net/editor/setcampaign/${camp.roll20CampaignId}/`, {
    waitUntil: "domcontentloaded", timeout: 30_000,
  });
  // Wait for firebase auth to settle, but don't hard-fail if the probe selector never matches.
  await page.waitForFunction(
    () => { try { return !!(window as any).firebase?.auth?.().currentUser; } catch { return false; } },
    undefined, { timeout: 30_000, polling: 500 },
  ).catch(() => console.error("[probe] firebase currentUser not detected in 30s — probing anyway"));
  await page.waitForTimeout(2000);

  // Probe page globals for custom/refresh/id tokens and where they live.
  const probe = await page.evaluate(() => {
    const w = window as any;
    const out: Record<string, unknown> = {};
    const tokenKeys: string[] = [];
    for (const k of Object.keys(w)) {
      if (/token|gntoken|gtoken|cred|firebase/i.test(k)) tokenKeys.push(k);
    }
    out.windowTokenKeys = tokenKeys;
    // Common classic locations.
    out.gntoken = typeof w.gntoken === "string" ? "<string>" : typeof w.gntoken;
    // Firebase compat: current user id/refresh tokens.
    try {
      const u = w.firebase?.auth?.().currentUser;
      if (u) {
        out.firebaseUser = { uid: u.uid, hasStsTokenManager: !!u.stsTokenManager };
        out.refreshToken = u.refreshToken ? "<present>" : "<none>";
        out.__refreshTokenValue = u.refreshToken || null;
        out.__idTokenValue = (u.stsTokenManager && u.stsTokenManager.accessToken) || null;
      } else {
        out.firebaseUser = null;
      }
    } catch (e) { out.firebaseUserErr = String(e); }
    return out;
  });

  const idTokenValue = (probe as any).__idTokenValue as string | null;
  const refreshTokenValue = (probe as any).__refreshTokenValue as string | null;

  const dumpDir = path.resolve("./.tmp-test-data");
  mkdirSync(dumpDir, { recursive: true });
  const outPath = path.join(dumpDir, `roll20-tokens-${Date.now()}.json`);
  writeFileSync(outPath, JSON.stringify({ customToken, idTokenValue, refreshTokenValue, probe }, null, 2), "utf-8");

  console.error("=== TOKEN SOURCE PROBE ===");
  console.error("window token-ish keys:", JSON.stringify((probe as any).windowTokenKeys));
  console.error("gntoken global:", (probe as any).gntoken);
  console.error("firebase.auth().currentUser:", JSON.stringify((probe as any).firebaseUser));
  console.error("\nharvestable (values saved locally, not printed):");
  console.error("  custom token (POSTed to signInWithCustomToken):", JSON.stringify(shape(customToken)));
  console.error("  firebase ID token (currentUser):", JSON.stringify(shape(idTokenValue)));
  console.error("  firebase refresh token (currentUser):", JSON.stringify(shape(refreshTokenValue)));
  console.error(`\nvalues → ${outPath}`);
  await page.close().catch(() => {});
}

main().then(() => process.exit(0), (e) => { console.error("probe FAILED:", e); process.exit(1); });
