import { Page } from "playwright";
import { getPage } from "./browser.js";
import { getActiveCampaign } from "../registry/campaigns.js";

const RELAY_ATTR_CMD = "GM_AI_Bridge_cmd";
const RELAY_ATTR_RESULT = "GM_AI_Bridge_result";
const RELAY_POLL_MS = 100;
const RELAY_TIMEOUT_MS = 30_000;

let _editorPage: Page | null = null;
let _loadedCampaignId: string | null = null;

async function getEditorPage(): Promise<Page> {
  const { roll20CampaignId } = getActiveCampaign();

  // Re-navigate if campaign has changed since the page was loaded
  if (_editorPage && _loadedCampaignId === roll20CampaignId) return _editorPage;

  const page = _editorPage ?? (await getPage("roll20"));
  const url = `https://app.roll20.net/editor/setcampaign/${roll20CampaignId}/`;
  // "domcontentloaded" fires quickly; "load" can hang forever on Roll20's WebSocket connections.
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15_000 });
  await page.waitForFunction(
    () => typeof (window as any).Campaign !== "undefined" &&
          typeof (window as any).Campaign.get === "function",
    undefined,
    { timeout: 15_000, polling: 500 }
  );

  _editorPage = page;
  _loadedCampaignId = roll20CampaignId;
  return page;
}

export async function evaluate<T>(fn: () => T): Promise<T> {
  const page = await getEditorPage();
  return page.evaluate(fn);
}

export async function evaluateWithArgs<T>(fn: (args: unknown) => T, args: unknown): Promise<T> {
  const page = await getEditorPage();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return page.evaluate(fn as any, args);
}

async function relayCommandOnce<T>(page: Awaited<ReturnType<typeof getEditorPage>>, cmd: Record<string, unknown>, nonce: number): Promise<T | null> {
  const payload = JSON.stringify({ ...cmd, nonce });

  await page.evaluate(() => {
    const chatTab = document.querySelector<HTMLElement>("a[href='#textchat']");
    chatTab?.click();
  });

  const chatInput = await page.waitForSelector("#textchat-input textarea", { state: "attached", timeout: 15_000 });
  await chatInput.fill("!ai-relay " + payload);
  await page.evaluate(() => {
    const ta = document.querySelector<HTMLTextAreaElement>("#textchat-input textarea");
    ta?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, keyCode: 13, which: 13 }));
  });
  await chatInput.press("Enter");

  const deadline = Date.now() + RELAY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, RELAY_POLL_MS));

    const result = await page.evaluate((searchNonce: number) => {
      function extractBalancedJson(text: string, start: number): string | null {
        let depth = 0, inStr = false, esc = false;
        for (let i = start; i < text.length; i++) {
          const c = text[i];
          if (esc) { esc = false; continue; }
          if (inStr) { if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
          if (c === '"') { inStr = true; continue; }
          if (c === "{") depth++;
          if (c === "}") { if (--depth === 0) return text.slice(start, i + 1); }
        }
        return null;
      }

      const marker = "AIBRIDGE_RESULT:";
      const candidates: string[] = [];
      document.querySelectorAll(".message .content, .message.whisper, .message.api").forEach((el) => {
        candidates.push(el.textContent ?? "");
      });
      candidates.push((document.querySelector("#textchat") ?? document.body).textContent ?? "");

      for (const text of candidates) {
        let pos = text.indexOf(marker);
        while (pos !== -1) {
          const jsonStart = pos + marker.length;
          if (text[jsonStart] === "{") {
            const jsonStr = extractBalancedJson(text, jsonStart);
            if (jsonStr) {
              try {
                const parsed = JSON.parse(jsonStr);
                if (parsed.nonce === searchNonce) return jsonStr;
              } catch { /* malformed */ }
            }
          }
          pos = text.indexOf(marker, pos + 1);
        }
      }
      return null;
    }, nonce);

    if (result) {
      const parsed = JSON.parse(result as string) as { nonce: number; data?: T; error?: string };
      if (parsed.nonce === nonce) {
        if (parsed.error) throw new Error(`Relay error: ${parsed.error}`);
        return parsed.data as T;
      }
    }
  }
  return null;
}

// Serial queue — concurrent callers wait their turn so they never race for the chat input.
let _relayQueue: Promise<unknown> = Promise.resolve();

// Mod relay: write a JSON command to the GM_AI_Bridge attribute and wait for result.
// Retries once after a short delay to handle the Roll20 API sandbox restart window.
export function relayCommand<T>(cmd: Record<string, unknown>): Promise<T> {
  const queued = _relayQueue.then(() => _relayCommandRaw<T>(cmd));
  _relayQueue = queued.catch(() => {});
  return queued;
}

async function _relayCommandRaw<T>(cmd: Record<string, unknown>): Promise<T> {
  const page = await getEditorPage();

  const nonce = Date.now();
  const result = await relayCommandOnce<T>(page, cmd, nonce);
  if (result !== null) return result;

  // First attempt timed out — relay may have been restarting. Wait and retry with a fresh nonce.
  await new Promise((r) => setTimeout(r, 4_000));
  const retryNonce = Date.now();
  const retryResult = await relayCommandOnce<T>(page, cmd, retryNonce);
  if (retryResult !== null) return retryResult;

  const chatDump = await page.evaluate(() => {
    const el = document.querySelector("#textchat") ?? document.body;
    return el.textContent?.slice(-800) ?? "(empty)";
  });
  throw new Error(`Relay timeout after ${RELAY_TIMEOUT_MS}ms for command: ${cmd.action}\nChat tail: ${chatDump}`);
}

export async function uploadArt(localAbsPath: string): Promise<string> {
  const page = await getEditorPage();

  // Step 1: open the art library panel (#imagedialog tab)
  await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>("a[href='#imagedialog']");
    if (!el) throw new Error("Art library tab not found");
    el.click();
  });
  await new Promise(r => setTimeout(r, 600));

  // Force-click the showuploaddialog button even if not visible
  await page.evaluate(() => {
    const btn = document.querySelector<HTMLElement>("button.btn.showuploaddialog");
    if (!btn) throw new Error("showuploaddialog button not found");
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await new Promise(r => setTimeout(r, 800));

  // Snapshot all current Roll20 CDN URLs in the page before upload.
  const beforeUrls = new Set(await page.evaluate(() => {
    const urls: string[] = [];
    document.querySelectorAll("*").forEach(el => {
      for (const attr of Array.from(el.attributes)) {
        if ((attr.value.includes("d20.io") || attr.value.includes("files.roll20")) && attr.value.startsWith("http")) {
          urls.push(attr.value);
        }
      }
    });
    return urls;
  }));

  // Click "Browse Files" and intercept the file chooser Dropzone opens.
  const [fileChooser] = await Promise.all([
    page.waitForEvent("filechooser", { timeout: 15_000 }),
    page.click("button.file-uploader__dropzone-button"),
  ]);
  await fileChooser.setFiles(localAbsPath);

  // Poll every attribute on every element for a new CDN URL that appeared after upload.
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 500));
    const newUrl = await page.evaluate((before: string[]) => {
      const beforeSet = new Set(before);
      const els = Array.from(document.querySelectorAll("*"));
      for (const el of els) {
        for (const attr of Array.from(el.attributes)) {
          const v = attr.value;
          if ((v.includes("d20.io") || v.includes("files.roll20")) && v.startsWith("http") && !beforeSet.has(v)) {
            return v;
          }
        }
        // Also check img src directly
        if (el instanceof HTMLImageElement) {
          const src = el.src;
          if ((src.includes("d20.io") || src.includes("files.roll20")) && !beforeSet.has(src)) return src;
        }
      }
      return null;
    }, Array.from(beforeUrls));
    if (newUrl) return newUrl;
  }

  throw new Error("Art upload timed out — could not find new CDN URL after upload. The file may have uploaded — check Roll20 art library and use place_map_image with the URL manually.");
}

export async function getTokens(pageId: string) {
  return relayCommand<{ id: string; name: string; bar1_value: number; bar1_max: number }[]>({
    action: "getTokens",
    pageId,
  });
}

export async function getCurrentPageId(): Promise<string> {
  return evaluate(() => (window as any).Campaign.get("playerpageid") as string);
}

export async function takeScreenshot(outputPath: string): Promise<void> {
  const page = await getEditorPage();
  await page.screenshot({ path: outputPath, fullPage: false });
}

export async function createPageViaUI(
  name: string,
  widthSquares: number,
  heightSquares: number,
  scaleNumber: number,
  scaleUnits: string,
): Promise<string> {
  const page = await getEditorPage();

  // Snapshot existing page IDs so we can identify what's new after creation
  const before = await relayCommand<{ id: string; name: string }[]>({ action: "listPages" });
  const beforeIds = new Set(before.map((p) => p.id));

  // Open the page navigator by clicking the pageList icon in the toolbar
  const navOpened = await page.evaluate(() => {
    const spans = Array.from(document.querySelectorAll("span.grimoire__roll20-icon"));
    const target = spans.find((s) => s.textContent?.trim() === "pageList");
    if (!target) return false;
    const btn = target.closest("button") ?? (target as HTMLElement);
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    return true;
  });
  if (!navOpened) throw new Error("Could not find the pageList icon to open the page navigator.");
  await new Promise((r) => setTimeout(r, 600));

  // Click Create Page via JS dispatch using the stable test-id
  const createClicked = await page.evaluate(() => {
    const btn = document.querySelector<HTMLElement>('[data-test-id="test-create-page-button"]');
    if (!btn) return false;
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    return true;
  });
  if (!createClicked) throw new Error("Could not find 'Create Page' button ([data-test-id='test-create-page-button']) after opening page navigator.");
  await new Promise((r) => setTimeout(r, 800));

  // Handle dialog — Roll20 may show a jQuery UI dialog or a SweetAlert prompt for the page name
  const dialogInputSelectors = [
    ".ui-dialog input[type='text']",
    "[role='dialog'] input[type='text']",
    ".sweet-alert input",
    ".swal2-input",
    "dialog input[type='text']",
  ];
  let named = false;
  for (const sel of dialogInputSelectors) {
    const input = page.locator(sel).first();
    if (await input.isVisible({ timeout: 1500 }).catch(() => false)) {
      await input.fill(name);
      // Confirm — try common confirm button patterns
      const confirm = page.locator(
        ".ui-dialog button:has-text('OK'), [role='dialog'] button:has-text('Create'), " +
        ".sweet-alert button.confirm, .swal2-confirm, button:has-text('OK')"
      ).first();
      await confirm.click({ timeout: 5_000 });
      named = true;
      break;
    }
  }

  await new Promise((r) => setTimeout(r, 1200));

  // Find the newly created page by diffing the page list
  let newPage: { id: string; name: string } | undefined;
  for (let attempt = 0; attempt < 5; attempt++) {
    const after = await relayCommand<{ id: string; name: string }[]>({ action: "listPages" });
    newPage = after.find((p) => !beforeIds.has(p.id));
    if (newPage) break;
    await new Promise((r) => setTimeout(r, 800));
  }
  if (!newPage) throw new Error(`Page creation via UI timed out — no new page appeared in listPages after clicking Create Page`);

  // If the dialog didn't fire (Roll20 created with a default name), rename via setPageProps
  if (!named || newPage.name.toLowerCase() !== name.toLowerCase()) {
    await relayCommand({
      action: "setPageProps",
      pageId: newPage.id,
      name,
      width: widthSquares,
      height: heightSquares,
      scale_number: scaleNumber,
      scale_units: scaleUnits,
      showgrid: true,
    });
  } else {
    await relayCommand({
      action: "setPageProps",
      pageId: newPage.id,
      width: widthSquares,
      height: heightSquares,
      scale_number: scaleNumber,
      scale_units: scaleUnits,
      showgrid: true,
    });
  }

  return newPage.id;
}
