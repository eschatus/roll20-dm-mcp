// Find the endpoint that mints the Firebase custom token (the input to signInWithCustomToken).
// Fresh page → record every response body + the signInWithCustomToken request body → locate which
// response CONTAINS that exact custom token. Prints only the SOURCE endpoint (never the token).

import { getPage } from "../bridge/browser.js";
import { getActiveCampaign } from "../registry/campaigns.js";

async function main() {
  const camp = getActiveCampaign();
  const seed = await getPage("roll20");
  const ctx = seed.context();
  const page = await ctx.newPage();

  const responses: { url: string; body: string }[] = [];
  let customToken: string | null = null;

  page.on("response", async (resp) => {
    const url = resp.url();
    if (!/roll20\.net|firebaseio|googleapis|identitytoolkit|d20\.io/.test(url)) return;
    if (["image", "media", "font", "stylesheet"].includes(resp.request().resourceType())) return;
    try { responses.push({ url, body: (await resp.text()).slice(0, 200_000) }); } catch { /* opaque */ }
  });
  page.on("request", (req) => {
    if (req.url().includes("signInWithCustomToken")) {
      try { const b = JSON.parse(req.postData() || "{}"); if (b.token) customToken = b.token; } catch { /* */ }
    }
  });

  await page.goto(`https://app.roll20.net/editor/setcampaign/${camp.roll20CampaignId}/`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForTimeout(12_000); // let the full auth handshake run

  console.error("=== CUSTOM TOKEN MINT SOURCE ===");
  if (!customToken) {
    console.error("custom token POST not observed (page may have authed before listener attached — re-run).");
  } else {
    const ct: string = customToken;
    console.error(`custom token captured: len=${ct.length}, dotSegments=${ct.split(".").length}`);
    // Search response bodies for the exact token (or a long unique prefix).
    const probe = ct.slice(0, 60);
    const hits = responses.filter((r) => r.body.includes(ct) || r.body.includes(probe));
    if (hits.length) {
      console.error("FOUND in response(s):");
      for (const h of hits) console.error("  <-- " + h.url);
    } else {
      console.error("NOT found in any captured response body.");
      console.error("→ Likely embedded in the editor HTML/startjs we didn't fully capture, or derived client-side.");
    }
  }
  // Also report which endpoints were POSTed during auth (candidates for a token-mint call).
  console.error("\nPOST/relevant endpoints seen:");
  for (const r of responses) {
    if (/oauth_token|token|auth|customtoken|gntoken|firebase|startjs/i.test(r.url))
      console.error("  " + r.url + "  (bodyLen=" + r.body.length + ")");
  }
  await page.close().catch(() => {});
}

main().then(() => process.exit(0), (e) => { console.error("FAILED:", e); process.exit(1); });
