// Capture a page's full-res map image from Roll20 for the wall dataset.
//
// Roll20 (esp. the Jumpgate WebGL renderer) signs/proxies map URLs and serves them from a
// service-worker cache, so direct fetch 403/404s and page-level network interception sees nothing.
// BUT WebGL requires CORS-clean textures, so the map is loaded crossOrigin-enabled and lives decoded
// in the browser. We exploit that: drive the editor to the page, then IN-PAGE load the map via a
// crossOrigin <Image> (the service worker serves the cached, CORS-clean bytes) and read it off a
// <canvas> at native resolution. Works for marketplace + uploaded art, Jumpgate + legacy. The bytes
// are the exact asset the walls were drawn against, so wall page-pixels register 1:1.
//
// NOTE: navigates the GM's active page — run OUTSIDE a live session.
import type { Page } from "playwright";

export interface CapturedImage { buf: Buffer; w: number; h: number; url: string }

// Double-click a page card by id+name: filter the (virtualised) list to it, neutralise the
// vue-virtual-scroller translate offset so it's on-screen, then issue a trusted dblclick.
async function navigateToCard(page: Page, pid: string, name: string): Promise<void> {
  const search = page.locator(".page-search-input input, input.page-search-input").first();
  await search.fill("").catch(() => {});
  await search.fill(name).catch(() => {});
  await page.waitForTimeout(1000);
  await page.evaluate((id) => {
    const c = document.querySelector(`div.page-card[data-page-id="${id}"]`) as HTMLElement | null;
    for (let el: HTMLElement | null = c; el; el = el.parentElement) {
      el.scrollTop = 0;
      const tf = getComputedStyle(el).transform;
      if (tf && tf !== "none") el.style.transform = "none";
    }
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
  try {
    // Open the page toolbar (idempotent).
    await page.evaluate(() => {
      if (document.querySelector("div.page-card[data-page-id]")) return;
      const t = Array.from(document.querySelectorAll("span.grimoire__roll20-icon")).find((s) => s.textContent?.trim() === "pageList");
      (t?.closest("button") ?? (t as HTMLElement))?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await page.waitForTimeout(1200);

    // The map texture only loads into the SW cache on a real page TRANSITION. If already on the
    // target, hop to another page first so navigating back re-renders (and re-caches) the map.
    const activeAtStart = await page.evaluate(() => (window as any).Campaign?.activePage?.()?.id).catch(() => "");
    if (activeAtStart === pageId) {
      const other = await page.evaluate((pid) => {
        const c = Array.from(document.querySelectorAll<HTMLElement>("div.page-card[data-page-id]")).find((e) => e.getAttribute("data-page-id") !== pid);
        return c ? { id: c.getAttribute("data-page-id"), name: c.querySelector(".vtt-page-title")?.textContent?.trim() ?? "" } : null;
      }, pageId);
      if (other?.id) { await navigateToCard(page, other.id, other.name).catch(() => {}); await page.waitForTimeout(2500); }
    }

    await navigateToCard(page, pageId, pageName);

    // Wait for the GM canvas to settle on this page so its texture is loaded/cached.
    const settle = opts.settleMs ?? 8000;
    const deadline = Date.now() + settle;
    let active = "";
    while (Date.now() < deadline) {
      active = await page.evaluate(() => (window as any).Campaign?.activePage?.()?.id).catch(() => "");
      if (active === pageId) break;
      await page.waitForTimeout(500);
    }
    if (active !== pageId) return null;
    await page.waitForTimeout(3500); // let the SW finish caching the full-res texture

    // In-page canvas readback: try files.d20.io variants of the map (the SW serves cached CORS-clean
    // bytes for the host files.d20.io even though s3.amazonaws.com/... 403s), plus any DOM originals.
    const res: any = await page.evaluate(async (imgsrcIn) => {
      const urls = new Set<string>();
      for (const i of Array.from(document.querySelectorAll("img"))) {
        const u = (i as HTMLImageElement).currentSrc || (i as HTMLImageElement).src;
        if (u && /files\.d20\.io\/(images|marketplace)\//.test(u) && /\/(original|max)\./.test(u)) urls.add(u.split("?")[0]);
      }
      if (imgsrcIn && imgsrcIn.indexOf("files.d20.io/") >= 0) {
        const tail = imgsrcIn.split("files.d20.io/")[1].split("?")[0];
        const base = "https://files.d20.io/" + tail.replace(/\/(original|max|thumb|med|min)\.(jpg|jpeg|png|webp)$/i, "");
        for (const v of ["original", "max"]) for (const e of ["jpg", "webp", "png", "jpeg"]) urls.add(`${base}/${v}.${e}`);
      }
      let best: any = null;
      for (const u of Array.from(urls).slice(0, 12)) {
        const r: any = await new Promise((resolve) => {
          const img = new Image();
          img.crossOrigin = "anonymous";
          img.onload = () => {
            try {
              const c = document.createElement("canvas"); c.width = img.naturalWidth; c.height = img.naturalHeight;
              (c.getContext("2d") as CanvasRenderingContext2D).drawImage(img, 0, 0);
              resolve({ url: u, ok: true, w: img.naturalWidth, h: img.naturalHeight, data: c.toDataURL("image/png") });
            } catch { resolve({ url: u, ok: false }); }
          };
          img.onerror = () => resolve({ url: u, ok: false });
          img.src = u;
          setTimeout(() => resolve({ url: u, ok: false }), 15000);
        });
        if (r.ok && (!best || r.w * r.h > best.w * best.h)) best = r; // keep the largest readable
      }
      return best;
    }, imgsrc);

    if (!res?.ok || !res.data) return null;
    const buf = Buffer.from(res.data.split(",")[1], "base64");
    void expected; // exact-asset readback already matches the placed graphic; kept for signature compat
    return { buf, w: res.w, h: res.h, url: res.url };
  } catch {
    return null;
  }
}
