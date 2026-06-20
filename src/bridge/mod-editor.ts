import { readFileSync } from "fs";
import { Page } from "playwright";
import { newBrowserPage } from "./browser.js";

let _modPage: Page | null = null;

async function getModPage(campaignId: string): Promise<Page> {
  const modUrl = `https://app.roll20.net/campaigns/scripts/${campaignId}`;

  // Reuse existing page if it's already on the right URL
  if (_modPage && !_modPage.isClosed()) {
    if (_modPage.url().includes(`/campaigns/scripts/${campaignId}`)) return _modPage;
    await _modPage.goto(modUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    return _modPage;
  }

  // Open a fresh page (won't disturb the game-editor page cache)
  const page = await newBrowserPage();
  await page.goto(modUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
  _modPage = page;
  return page;
}

// Dump the DOM IDs/classes near the console section for selector discovery.
export async function dumpModPageStructure(campaignId: string): Promise<string> {
  const page = await getModPage(campaignId);
  return page.evaluate(() => {
    const result: string[] = [];
    // Skip the navbar — focus on content after #new-navbar
    const content = document.querySelector("main, #app, .content, body");
    const root = content ?? document.body;
    root.querySelectorAll("[id], [class]").forEach(el => {
      // Skip navbar children
      if (el.closest("#new-navbar") || el.closest("nav")) return;
      const id = el.id ? `#${el.id}` : "";
      const cls = el.className && typeof el.className === "string"
        ? "." + el.className.trim().replace(/\s+/g, ".")
        : "";
      if (id || cls) result.push(`${el.tagName.toLowerCase()}${id}${cls}`);
    });
    return result.slice(0, 300).join("\n");
  });
}

// Read lines from the Mod Output Console (#apiconsole is an Ace editor).
export async function readModConsole(campaignId: string): Promise<string[]> {
  const page = await getModPage(campaignId);
  return page.evaluate(() => {
    // The console is an Ace editor — read via its text layer lines.
    const lines = [...document.querySelectorAll("#apiconsole .ace_line")]
      .map(el => el.textContent ?? "")
      .filter(Boolean);
    if (lines.length) return lines;
    // Fallback: read via Ace API if available
    const aceEl = document.querySelector("#apiconsole") as any;
    const editor = aceEl?.env?.editor;
    if (editor) return editor.getValue().split("\n").filter((l: string) => l.trim());
    return [];
  });
}

// Deploy the relay script into the API editor. Updates the existing tab whose name matches the
// script filename (e.g. "ai-relay.js"); if no such tab exists, CREATES a new tab. It never writes
// into an unrelated existing tab — overwriting the first user tab would clobber other Mods (e.g. a
// UniversalVTTImporter), so the old first-tab fallback was removed. Returns `created` so callers
// can tell a fresh provision from an update.
// scriptPath should be the absolute path to ai-relay.js.
export async function deployModScript(campaignId: string, scriptPath: string): Promise<{ saved: boolean; linesWritten: number; created: boolean }> {
  const content = readFileSync(scriptPath, "utf-8");
  const page = await getModPage(campaignId);

  // Match an existing tab by filename. Tab text is icon-prefixed (e.g. "G\n\nai-relay.js"), so
  // compare with `includes`, not `===` (the old `===` never matched and always clobbered).
  const scriptName = scriptPath.split(/[\\/]/).pop() ?? "ai-relay.js";
  const tabHref: string | null = await page.evaluate((name: string) => {
    const tabs = [...document.querySelectorAll('#scriptorder a[data-toggle="tab"]')];
    const userTabs = tabs.filter(a => {
      const href = a.getAttribute("href") ?? "";
      return href.startsWith("#script-") && href !== "#script-library" && href !== "#script-new";
    });
    const byName = userTabs.find(a => (a.textContent ?? "").trim().toLowerCase().includes(name.toLowerCase()));
    return byName ? byName.getAttribute("href") : null;
  }, scriptName);

  // --- Update path: an ai-relay.js tab already exists ---
  if (tabHref) {
    await page.click(`a[href="${tabHref}"]`);
    const paneId = tabHref.slice(1);
    await page.waitForFunction(
      (id: string) => document.getElementById(id)?.classList.contains("active"),
      paneId,
      { timeout: 5_000, polling: 200 }
    );
    const linesWritten: number = await page.evaluate(({ id, script }: { id: string; script: string }) => {
      const pane = document.getElementById(id) as any;
      const aceEl = pane?.querySelector(".ace_editor") as any;
      const editor = aceEl?.env?.editor ?? (window as any).ace?.edit(aceEl);
      if (!editor) throw new Error(`Ace editor not found in #${id}`);
      editor.setValue(script, -1);
      return editor.session.getLength() as number;
    }, { id: paneId, script: content });
    await page.click(`#${paneId} .savescript`);
    await page.waitForTimeout(1_500);
    return { saved: true, linesWritten, created: false };
  }

  // --- Create path: no matching tab → make a NEW one (never touch existing tabs) ---
  // The #script-new pane has a name <input type=text>, an Ace editor, and a .savescript button.
  await page.click('a[href="#script-new"]');
  await page.waitForFunction(
    () => document.getElementById("script-new")?.classList.contains("active"),
    undefined,
    { timeout: 5_000, polling: 200 }
  );
  await page.fill('#script-new input[type="text"]', scriptName);
  const linesWritten: number = await page.evaluate((script: string) => {
    const pane = document.getElementById("script-new") as any;
    const aceEl = pane?.querySelector(".ace_editor") as any;
    const editor = aceEl?.env?.editor ?? (window as any).ace?.edit(aceEl);
    if (!editor) throw new Error("Ace editor not found in #script-new");
    editor.setValue(script, -1);
    return editor.session.getLength() as number;
  }, content);
  await page.click('#script-new .savescript');
  // New-script save also boots the sandbox; give it a longer beat to settle.
  await page.waitForTimeout(2_500);
  return { saved: true, linesWritten, created: true };
}

// Convenience: get the campaign's API editor URL for diagnostics
export function modEditorUrl(campaignId: string): string {
  return `https://app.roll20.net/campaigns/scripts/${campaignId}`;
}
