import { readFileSync } from "fs";
import type { Page } from "playwright";
import { newBrowserPage } from "./browser.js";

let _modPage: Page | null = null;

// Match an API-editor tab by filename. Tab text is icon-prefixed (e.g. "G\n\nai-relay.js"), so we
// split on whitespace and match by TOKEN equality — `includes` (substring) is too broad and would
// match "old-ai-relay.js" when looking for "ai-relay.js" (the #87 fix). We accept EITHER the full
// name ("ai-relay.js") or its base name with the extension stripped ("ai-relay"): Roll20 strips the
// extension when it auto-names a script tab whose filename contains a dot (bug #98), so the tab text
// tokenizes to ["ai-relay"] and would never equal "ai-relay.js".
export function tabNameMatches(tabText: string, name: string): boolean {
  const tokens = tabText.trim().toLowerCase().split(/\s+/);
  const want = name.toLowerCase();
  const wantBase = want.replace(/\.[^.]+$/, ""); // "ai-relay.js" -> "ai-relay"
  return tokens.includes(want) || tokens.includes(wantBase);
}

export async function getModPage(campaignId: string): Promise<Page> {
  const modUrl = `https://app.roll20.net/campaigns/scripts/${campaignId}`;

  let page: Page;
  if (_modPage && !_modPage.isClosed()) {
    page = _modPage;
    if (!page.url().includes(`/campaigns/scripts/${campaignId}`)) {
      await page.goto(modUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    }
  } else {
    // Open a fresh page (won't disturb the game-editor page cache)
    page = await newBrowserPage();
    await page.goto(modUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    _modPage = page;
  }

  // CRITICAL: the #scriptorder tabs render via Roll20's JS AFTER `domcontentloaded`.
  // A cold page (e.g. a fresh standalone process, vs. the server's warm reused page)
  // that queries tabs too early sees NONE and wrongly takes deployModScript's
  // "create new script" path → a DUPLICATE relay that jams the sandbox. Always wait
  // for the tab bar to actually render before any caller inspects it.
  await page.waitForSelector('#scriptorder a[data-toggle="tab"]', { timeout: 20_000 });
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
export async function deployModScript(
  campaignId: string,
  scriptPath: string,
  opts: { requireExisting?: boolean; tabName?: string } = {}
): Promise<{ saved: boolean; linesWritten: number; created: boolean }> {
  const content = readFileSync(scriptPath, "utf-8");
  const page = await getModPage(campaignId);

  // tabName overrides the default (basename of scriptPath) — used when deploying a minified
  // artifact (.ai-relay.deploy.js) that should update the canonical "ai-relay.js" tab.
  const scriptName = opts.tabName ?? scriptPath.split(/[\\/]/).pop() ?? "ai-relay.js";

  // Pull the raw tab list (href + text) out of the page as plain data, then do all name-matching
  // in Node via `tabNameMatches`. Keeping the matcher Node-side (not inside page.evaluate, which
  // can't reference Node functions) makes `tabNameMatches` the single source of truth shared with
  // delete-duplicate-relay.ts.
  const userTabs: Array<{ href: string; text: string }> = await page.evaluate(() => {
    return [...document.querySelectorAll('#scriptorder a[data-toggle="tab"]')]
      .filter(a => {
        const href = a.getAttribute("href") ?? "";
        return href.startsWith("#script-") && href !== "#script-library" && href !== "#script-new";
      })
      .map(a => ({ href: a.getAttribute("href") ?? "", text: a.textContent ?? "" }));
  });

  const byName = userTabs.find(t => tabNameMatches(t.text, scriptName));
  let resolvedTabHref: string | null;
  let isFallback: boolean;
  if (byName) {
    resolvedTabHref = byName.href;
    isFallback = false;
  } else if (userTabs.length === 1) {
    // If exactly one user tab exists and we can't match by name, use it — the tab may have been
    // created under a different name (e.g. "api-relay.js" or a Roll20 auto-name). The caller still
    // controls whether to accept this via requireExisting semantics.
    resolvedTabHref = userTabs[0].href;
    isFallback = true;
  } else {
    resolvedTabHref = null;
    isFallback = false;
  }
  if (isFallback) {
    // Bug #85: refuse the fallback when requireExisting is set — the single existing tab is not
    // the relay and overwriting it would clobber an unrelated Mod.
    if (opts.requireExisting) {
      throw new Error(
        `deployModScript: no tab named "${scriptName}" found; single-tab fallback refused because requireExisting is set — ` +
        `the existing tab is not the relay. Deploy the first copy via the MCP deploy_mod_script tool, then retry.`
      );
    }
    console.error(`[mod-editor] no tab named "${scriptName}" found; updating the only existing user script tab (single-tab fallback)`);
  }

  // --- Update path: an ai-relay.js tab already exists (or single-tab fallback) ---
  if (resolvedTabHref) {
    await page.click(`a[href="${resolvedTabHref}"]`);
    const paneId = resolvedTabHref.slice(1);
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

  // Safety valve for redeploys (e.g. release scripts): refuse to create a duplicate.
  // If we expected an existing tab but didn't find one, that's almost always a cold
  // page that rendered tabs late — fail LOUD rather than spawn a second relay.
  if (opts.requireExisting) {
    throw new Error(
      `deployModScript: no existing "${scriptName}" tab found, and requireExisting is set — ` +
      `refusing to create a duplicate. Deploy the first copy via the MCP deploy_mod_script tool, then retry.`
    );
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
