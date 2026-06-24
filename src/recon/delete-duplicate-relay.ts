// One-shot: delete any ai-relay tab whose name is NOT "ai-relay.js" on DRW-Original.
// Run: tsx src/recon/delete-duplicate-relay.ts
import { getModPage, tabNameMatches } from "../bridge/mod-editor.js";

const CAMPAIGN = "17491327";

// Only tabs whose name is exactly one of these artifact filenames should ever be deleted.
// This prevents broad substring matching from wiping ai-relay-v2.js, ai-relay-backup, etc.
const ARTIFACT_NAMES = [".ai-relay.deploy.js", "ai-relay.deploy.js"];

// getModPage handles the goto + the cold-page tab-render wait (#85) and caches the page.
const page = await getModPage(CAMPAIGN);

const tabs: Array<{ href: string; text: string }> = await page.evaluate(() => {
  const all = [...document.querySelectorAll('#scriptorder a[data-toggle="tab"]')];
  return all
    .filter(a => {
      const h = a.getAttribute("href") ?? "";
      return h.startsWith("#script-") && h !== "#script-library" && h !== "#script-new";
    })
    .map(a => ({ href: a.getAttribute("href") ?? "", text: (a.textContent ?? "").trim().replace(/\s+/g, " ") }));
});

console.log("User tabs:", JSON.stringify(tabs, null, 2));

// Only delete tabs whose name is exactly one of the known artifact names (token-matched via the
// shared helper). Never use a broad substring match — that would silently wipe ai-relay-v2.js, etc.
const toDelete = tabs.filter(t => ARTIFACT_NAMES.some(name => tabNameMatches(t.text, name)));
console.log("Tabs to delete:", JSON.stringify(toDelete, null, 2));
if (!toDelete.length) {
  console.log("No duplicate tabs found — nothing to delete.");
  process.exit(0);
}

for (const tab of toDelete) {
  console.log(`Deleting tab: ${tab.href} ("${tab.text}")`);
  await page.click(`a[href="${tab.href}"]`);
  const paneId = tab.href.slice(1);
  await page.waitForFunction(
    (id: string) => document.getElementById(id)?.classList.contains("active"),
    paneId,
    { timeout: 5_000, polling: 200 },
  );
  await page.click(`#${paneId} .deletescript`);
  await page.waitForTimeout(1_500);
  console.log(`Deleted ${tab.href}.`);
}

console.log("Done — restart the sandbox to pick up the clean script.");
process.exit(0);
