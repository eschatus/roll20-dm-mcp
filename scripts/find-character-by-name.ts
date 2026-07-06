/**
 * Find Roll20 character ids by name substring, read live from the browser's
 * Campaign.characters collection (no chat round-trip, no crash risk from
 * macro-syntax attribute values).
 * Run: npx tsx scripts/find-character-by-name.ts <name-substring>
 */
import { chromium } from "playwright";
async function main() {
  const nameQuery = process.argv[2] || "Vampire";
  const browser = await chromium.connectOverCDP("http://localhost:9222");
  const ctx = browser.contexts()[0];
  const editorPage = ctx.pages().find(p => p.url().includes("app.roll20.net/editor"));
  if (!editorPage) throw new Error("not found");
  const result = await editorPage.evaluate((q) => {
    const w = window as any;
    const camp = w.Campaign;
    const matches: any[] = [];
    camp.characters.each((c: any) => {
      const name = c.get("name");
      if (name && name.toLowerCase().includes(q.toLowerCase())) {
        matches.push({ id: c.id, name });
      }
    });
    return matches;
  }, nameQuery);
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
