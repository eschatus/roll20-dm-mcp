// Probe what the automation editor page actually sees — is the Roll20 editor loaded+authed,
// or is it blank/login (which makes navigateToCard fail fast → capture-failed)?
process.env.ROLL20_TRANSPORT ??= "rt";
import { getEditorPage } from "../bridge/roll20.js";

(async () => {
  const page = await getEditorPage().catch((e) => { console.error("getEditorPage FAILED:", String(e).slice(0, 200)); return null; });
  if (!page) { console.error("no editor page"); process.exit(1); }
  const before = await page.evaluate(() => ({
    cards: document.querySelectorAll("div.page-card[data-page-id]").length,
    icons: Array.from(document.querySelectorAll("span.grimoire__roll20-icon")).map(s => s.textContent?.trim()).filter(Boolean),
    searchInputs: document.querySelectorAll(".page-search-input input, input.page-search-input").length,
  }));
  console.error("BEFORE open:", JSON.stringify(before));
  // try the current panel-open click (icon text 'pageList'), then alternates
  const opened = await page.evaluate(() => {
    const tries = ["pageList", "pages", "page", "pagetoolbar", "Page Toolbar"];
    for (const name of tries) {
      const t = Array.from(document.querySelectorAll("span.grimoire__roll20-icon")).find(s => s.textContent?.trim() === name);
      if (t) { (t.closest("button") ?? (t as HTMLElement)).dispatchEvent(new MouseEvent("click", { bubbles: true })); return `clicked icon '${name}'`; }
    }
    // fallback: any button whose aria/title mentions page
    const btn = Array.from(document.querySelectorAll("button,[role=button]")).find(b => /page/i.test((b.getAttribute("aria-label") || b.getAttribute("title") || "")));
    if (btn) { (btn as HTMLElement).click(); return `clicked aria/title page button`; }
    return "NO page-toggle found";
  });
  await page.waitForTimeout(2500);
  const after = await page.evaluate(() => ({
    cards: document.querySelectorAll("div.page-card[data-page-id]").length,
    searchInputs: document.querySelectorAll(".page-search-input input, input.page-search-input").length,
  }));
  console.error("OPEN ATTEMPT:", opened);
  console.error("AFTER open:", JSON.stringify(after));
  process.exit(0);
})();
