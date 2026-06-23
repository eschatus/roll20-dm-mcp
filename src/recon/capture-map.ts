// Capture a page's full-res map image from Roll20 for the wall dataset.
//
// Roll20 serves map textures CORS-clean (WebGL needs that), so we read the image off a <canvas>
// in-page. TWO paths:
//   1. DIRECT (no navigation): for uploaded art (files.d20.io/images/…) the service worker serves
//      the CORS-clean original from ANY editor view — so we just load the imgsrc-derived URL via a
//      crossOrigin <Image> and read it. No toolbar, no per-page nav, no plan-gates. Fast + robust.
//   2. NAV fallback: gated marketplace art is only retrievable after Roll20 renders the page, so we
//      drive the page-toolbar to display it, then read back. Used only when (1) returns nothing.
//
// Bytes are the exact placed asset, so wall page-pixels register 1:1. Re-encoded JPEG q0.92
// (visually lossless, avoids OOM on very large canvases). Run OUTSIDE a live session (path 2
// navigates the GM's active page).
import type { Page } from "playwright";

export interface CapturedImage { buf: Buffer; w: number; h: number; url: string }

// In-page crossOrigin canvas readback of the map's files.d20.io variants. Returns the largest
// readable variant, or null (gated art that isn't cached/servable from the current view).
async function readbackInPage(page: Page, imgsrc: string): Promise<CapturedImage | null> {
  const res: any = await page.evaluate(async (imgsrcIn) => {
    const raw: string[] = [];
    for (const i of Array.from(document.querySelectorAll("img"))) {
      const u = (i as HTMLImageElement).currentSrc || (i as HTMLImageElement).src;
      if (u && /files\.d20\.io\/(images|marketplace)\//.test(u) && /\/(original|max)\./.test(u)) { raw.push(u); raw.push(u.split("?")[0]); }
    }
    if (imgsrcIn && imgsrcIn.indexOf("files.d20.io/") >= 0) {
      const q = imgsrcIn.indexOf("?") >= 0 ? imgsrcIn.slice(imgsrcIn.indexOf("?")) : "";
      const tail = imgsrcIn.split("files.d20.io/")[1].split("?")[0];
      const base = "https://files.d20.io/" + tail.replace(/\/(original|max|thumb|med|min)\.(jpg|jpeg|png|webp)$/i, "");
      for (const v of ["original", "max"]) for (const e of ["jpg", "webp", "png", "jpeg"]) { raw.push(`${base}/${v}.${e}${q}`); raw.push(`${base}/${v}.${e}`); }
    }
    const urls = Array.from(new Set(raw.filter((u) => u)));
    let best: any = null;
    for (const u of urls.slice(0, 24)) {
      const r: any = await new Promise((resolve) => {
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.onload = () => {
          try {
            const c = document.createElement("canvas"); c.width = img.naturalWidth; c.height = img.naturalHeight;
            (c.getContext("2d") as CanvasRenderingContext2D).drawImage(img, 0, 0);
            resolve({ url: u, ok: true, w: img.naturalWidth, h: img.naturalHeight, data: c.toDataURL("image/jpeg", 0.92) });
          } catch { resolve({ url: u, ok: false }); }
        };
        img.onerror = () => resolve({ url: u, ok: false });
        img.src = u;
        setTimeout(() => resolve({ url: u, ok: false }), 20000);
      });
      if (r.ok && (!best || r.w * r.h > best.w * best.h)) best = r;
    }
    return best;
  }, imgsrc);
  if (!res?.ok || !res.data) return null;
  return { buf: Buffer.from(res.data.split(",")[1], "base64"), w: res.w, h: res.h, url: res.url };
}

// Drive the page-toolbar to display a page (fallback for gated marketplace art that must render
// first). Filters the (virtualised) list to the target, neutralises vue-virtual-scroller transforms,
// and dblclicks the card.
async function navigateToCard(page: Page, pid: string, name: string): Promise<void> {
  await page.evaluate(() => {
    if (document.querySelector("div.page-card[data-page-id]")) return;
    const t = Array.from(document.querySelectorAll("span.grimoire__roll20-icon")).find((s) => s.textContent?.trim() === "pageList");
    (t?.closest("button") ?? (t as HTMLElement))?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await page.waitForTimeout(1200);
  const search = page.locator(".page-search-input input, input.page-search-input").first();
  await search.fill("").catch(() => {});
  await search.fill(name).catch(() => {});
  await page.waitForTimeout(1000);
  await page.evaluate((id) => {
    const c = document.querySelector(`div.page-card[data-page-id="${id}"]`) as HTMLElement | null;
    for (let el: HTMLElement | null = c; el; el = el.parentElement) { el.scrollTop = 0; const tf = getComputedStyle(el).transform; if (tf && tf !== "none") el.style.transform = "none"; }
  }, pid);
  await page.locator(`div.page-card[data-page-id="${pid}"] .vtt-page-card.is-page`).first().dblclick({ timeout: 10_000 });
}

export async function captureMapImage(
  page: Page,
  pageId: string,
  pageName: string,
  imgsrc: string,
  expected?: { w: number; h: number },
  opts: { settleMs?: number } = {},
): Promise<CapturedImage | null> {
  void expected;
  try {
    // 1. DIRECT readback — no navigation. Works for uploaded art from any editor view.
    const direct = await readbackInPage(page, imgsrc);
    if (direct) return direct;

    // 2. NAV fallback — gated marketplace art: render the page, then read back.
    await navigateToCard(page, pageId, pageName);
    const deadline = Date.now() + (opts.settleMs ?? 8000);
    let active = "";
    while (Date.now() < deadline) {
      active = await page.evaluate(() => (window as any).Campaign?.activePage?.()?.id).catch(() => "");
      if (active === pageId) break;
      await page.waitForTimeout(500);
    }
    if (active !== pageId) { console.error(`[capture] NAV FAIL ${pageName}: active=${active}`); return null; }
    await page.waitForTimeout(3500);
    const navd = await readbackInPage(page, imgsrc);
    if (!navd) console.error(`[capture] NO READABLE URL ${pageName}`);
    return navd;
  } catch (e) {
    console.error(`[capture] EXCEPTION ${pageName}: ${String(e).slice(0, 160)}`);
    return null;
  }
}
