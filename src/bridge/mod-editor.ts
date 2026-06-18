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

// Replace the relay script in the Ace editor for the first user-created script tab and click Save.
// scriptPath should be the absolute path to ai-relay.js.
export async function deployModScript(campaignId: string, scriptPath: string): Promise<{ saved: boolean; linesWritten: number }> {
  const content = readFileSync(scriptPath, "utf-8");
  const page = await getModPage(campaignId);

  // Find the correct user-script tab. Try to match by script filename first
  // (e.g. "relay.js"), then fall back to the first non-library, non-new tab.
  const scriptName = scriptPath.split(/[\\/]/).pop() ?? "";
  const tabHref: string | null = await page.evaluate((name: string) => {
    const tabs = [...document.querySelectorAll('#scriptorder a[data-toggle="tab"]')];
    const userTabs = tabs.filter(a => {
      const href = a.getAttribute("href") ?? "";
      return href.startsWith("#script-") && href !== "#script-library" && href !== "#script-new";
    });
    const byName = name
      ? userTabs.find(a => a.textContent?.trim().toLowerCase() === name.toLowerCase())
      : null;
    const chosen = byName ?? userTabs[0] ?? null;
    return chosen ? chosen.getAttribute("href") : null;
  }, scriptName);

  if (!tabHref) throw new Error("No user script tab found in #scriptorder");

  // Click the tab to make its pane active
  await page.click(`a[href="${tabHref}"]`);

  // Wait for its pane to become visible
  const paneId = tabHref.slice(1); // strip leading #
  await page.waitForFunction(
    (id: string) => document.getElementById(id)?.classList.contains("active"),
    paneId,
    { timeout: 5_000, polling: 200 }
  );

  // Set the Ace editor value in that specific pane
  const linesWritten: number = await page.evaluate(({ id, script }: { id: string; script: string }) => {
    const pane = document.getElementById(id) as any;
    const aceEl = pane?.querySelector(".ace_editor") as any;
    const editor = aceEl?.env?.editor ?? (window as any).ace?.edit(aceEl);
    if (!editor) throw new Error(`Ace editor not found in #${id}`);
    editor.setValue(script, -1);
    return editor.session.getLength() as number;
  }, { id: paneId, script: content });

  // Click the save button scoped to this pane
  await page.click(`#${paneId} .savescript`);

  // Brief pause for the save round-trip
  await page.waitForTimeout(1_500);

  return { saved: true, linesWritten };
}

// Convenience: get the campaign's API editor URL for diagnostics
export function modEditorUrl(campaignId: string): string {
  return `https://app.roll20.net/campaigns/scripts/${campaignId}`;
}
