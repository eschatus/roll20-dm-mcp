// Scrape the user's full Roll20 campaign list from the dashboard and diff against what we've
// harvested, so we can spot any campaign that was missed. tsx src/recon/list-roll20-campaigns.ts
process.env.ROLL20_TRANSPORT ??= "rt";
import { readdirSync, existsSync, readFileSync } from "fs";
import { newBrowserPage } from "../bridge/browser.js";
import { dataDir } from "../dataDir.js";
import path from "path";

const page = await newBrowserPage();
await page.goto("https://app.roll20.net/campaigns/", { waitUntil: "domcontentloaded", timeout: 60000 }).catch((e) => console.error("goto:", String(e).slice(0, 80)));
await page.waitForTimeout(6000);
// Collect campaigns across all pages. "My Games" paginates via ?page=N (and/or lazy-loads),
// so walk pages until no new campaign ids appear.
const byId: Record<string, { id: string; name: string }> = {};
const collect = async () => {
  // scroll to trigger any lazy-load on this page
  for (let s = 0; s < 4; s++) { await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {}); await page.waitForTimeout(700); }
  const found: { id: string; name: string }[] = await page.evaluate(() => {
    const m: Record<string, string> = {};
    for (const a of Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href*='/campaigns/details/']"))) {
      const mm = (a.getAttribute("href") || "").match(/\/campaigns\/details\/(\d+)/);
      if (!mm) continue;
      const id = mm[1];
      let name = (a.textContent || "").trim();
      if (!name) { const card = a.closest("li, [class*='card'], [class*='listing'], [class*='game']"); name = (card?.querySelector("h1,h2,h3,h4,[class*='title'],[class*='name']")?.textContent || "").trim(); }
      if (!m[id] || (name && name.length > m[id].length)) m[id] = name;
    }
    return Object.entries(m).map(([id, name]) => ({ id, name }));
  });
  let added = 0;
  for (const c of found) { if (!byId[c.id]) added++; if (!byId[c.id] || (c.name && c.name.length > byId[c.id].name.length)) byId[c.id] = c; }
  return added;
};
await collect();
for (let pg = 2; pg <= 12; pg++) {
  await page.goto(`https://app.roll20.net/campaigns/search/?p=${pg}`, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
  await page.waitForTimeout(2500);
  const added = await collect();
  console.error(`  page ${pg}: +${added} new (total ${Object.keys(byId).length})`);
  if (added === 0 && pg > 7) break; // 7 pages expected; stop after a couple empties past that
}
const campaigns = Object.values(byId);
await page.close().catch(() => {});

// Harvested roll20 IDs: read each campaign dir's manifest for its roll20CampaignId.
const rawDir = path.join(dataDir(), "wall-dataset", "raw");
const harvestedIds = new Set<string>();
if (existsSync(rawDir)) {
  for (const d of readdirSync(rawDir)) {
    const man = path.join(rawDir, d, "_manifest.json");
    if (existsSync(man)) { try { harvestedIds.add(JSON.parse(readFileSync(man, "utf-8")).campaign?.roll20CampaignId); } catch {} }
  }
}

console.error(`\n=== ${campaigns.length} Roll20 campaigns on the account ===`);
for (const c of campaigns.sort((a, b) => a.name.localeCompare(b.name))) {
  const done = harvestedIds.has(c.id);
  console.error(`  [${done ? "✓ harvested" : "  MISSED   "}] ${c.id}  ${c.name}`);
}
console.error(`\nharvested ${harvestedIds.size} campaigns; ${campaigns.filter(c => !harvestedIds.has(c.id)).length} not yet harvested.`);
process.exit(0);
