/**
 * Dump every attribute on a Roll20 character, read live from the browser's
 * Campaign.characters/attribs collections. Safe for fields containing "@{"/"[["
 * (e.g. repeating_npcaction rollbase) — bypasses the chat-echo path that
 * getCharacterAttributes uses, which errors on that syntax.
 * Run: npx tsx scripts/dump-character-attrs.ts <charId>
 */
import { chromium } from "playwright";

async function main() {
  const charId = process.argv[2];
  const browser = await chromium.connectOverCDP("http://localhost:9222");
  const ctx = browser.contexts()[0];
  const editorPage = ctx.pages().find(p => p.url().includes("app.roll20.net/editor"));
  if (!editorPage) throw new Error("not found");

  const fnBody = `
    (async function(id) {
      const w = window;
      const char = w.Campaign.characters.get(id);
      if (!char) return { error: "character not found" };
      await new Promise(function(resolve) {
        char.attribs.fetch({ success: function(){ resolve(); }, error: function(){ resolve(); } });
        setTimeout(resolve, 5000);
      });
      const attrs = char.attribs.map(function(a) {
        return { name: a.get("name"), current: a.get("current"), max: a.get("max") };
      });
      return { count: attrs.length, attrs: attrs };
    })
  `;
  const fn = eval(fnBody);
  const result = await editorPage.evaluate(fn, charId);
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
