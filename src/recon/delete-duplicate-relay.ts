// One-shot: delete any ai-relay tab whose name is NOT "ai-relay.js" on DRW-Original.
// Run: tsx src/recon/delete-duplicate-relay.ts
import { newBrowserPage } from "../bridge/browser.js";

const CAMPAIGN = "17491327";
const KEEP_NAME = "ai-relay.js";

const page = await newBrowserPage();
await page.goto(`https://app.roll20.net/campaigns/scripts/${CAMPAIGN}`, { waitUntil: "domcontentloaded" });
await page.waitForSelector('#scriptorder a[data-toggle="tab"]', { timeout: 20_000 });

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

// Only delete tabs whose name looks like a relay artifact (contains "ai-relay"), NOT other scripts.
const toDelete = tabs.filter(t =>
  t.text.toLowerCase().includes("ai-relay") &&
  !t.text.toLowerCase().includes(KEEP_NAME.toLowerCase()),
);
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
