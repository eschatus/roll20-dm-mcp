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
// readable variant, or null. `includeDom` scrapes DOM <img> srcs too — ONLY safe AFTER navigating
// to the target page (then the DOM shows the correct map's full-res rendered texture, which for
// huge maps is bigger than the imgsrc-derived `original` thumbnail). Pre-navigation it must be false
// (the static editor view would yield the SAME wrong image for every non-displayed page).
async function readbackInPage(page: Page, imgsrc: string, includeDom = false): Promise<CapturedImage | null> {
  const res: any = await page.evaluate(async ({ imgsrcIn, dom }: { imgsrcIn: string; dom: boolean }) => {
    const raw: string[] = [];
    if (dom) {
      for (const i of Array.from(document.querySelectorAll("img"))) {
        const u = (i as HTMLImageElement).currentSrc || (i as HTMLImageElement).src;
        if (u && /files\.d20\.io\/(images|marketplace)\//.test(u) && /\/(original|max)\./.test(u)) { raw.push(u); raw.push(u.split("?")[0]); }
      }
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
            // Keep full resolution; only guard against Chromium's hard canvas limit (~16k).
            const MAX = 16384; const nw = img.naturalWidth, nh = img.naturalHeight;
            const s = Math.max(nw, nh) > MAX ? MAX / Math.max(nw, nh) : 1;
            const cw = Math.round(nw * s), ch = Math.round(nh * s);
            const c = document.createElement("canvas"); c.width = cw; c.height = ch;
            (c.getContext("2d") as CanvasRenderingContext2D).drawImage(img, 0, 0, cw, ch);
            resolve({ url: u, ok: true, w: cw, h: ch, data: c.toDataURL("image/jpeg", 0.92) });
          } catch { resolve({ url: u, ok: false }); }
        };
        img.onerror = () => resolve({ url: u, ok: false });
        img.src = u;
        setTimeout(() => resolve({ url: u, ok: false }), 20000);
      });
      if (r.ok && (!best || r.w * r.h > best.w * best.h)) best = r;
    }
    return best;
  }, { imgsrcIn: imgsrc, dom: includeDom });
  if (!res?.ok || !res.data) return null;
  return { buf: Buffer.from(res.data.split(",")[1], "base64"), w: res.w, h: res.h, url: res.url };
}

// Drive the page-toolbar to display a page (fallback for gated marketplace art that must render
// first). Filters the (virtualised) list to the target, neutralises vue-virtual-scroller transforms,
// and dblclicks the card.
async function navigateToCard(page: Page, pid: string, name: string): Promise<void> {
  // Open the page toolbar (idempotent).
  await page.evaluate(() => {
    if (document.querySelector(".vtt-page-card.is-page, div.page-card")) return;
    const t = Array.from(document.querySelectorAll("span.grimoire__roll20-icon")).find((s) => s.textContent?.trim() === "pageList");
    (t?.closest("button") ?? (t as HTMLElement))?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await page.waitForTimeout(1200);
  const search = page.locator(".page-search-input input, input.page-search-input").first();
  await search.fill("").catch(() => {});
  await search.fill(name).catch(() => {});
  await page.waitForTimeout(1100);
  // Find the target card by data-page-id (older UI) OR by title text (newer UI lacks data-page-id),
  // neutralise vue-virtual-scroller transforms, and TAG it so Playwright can click it reliably.
  const found = await page.evaluate(({ id, nm }: { id: string; nm: string }) => {
    const cards = Array.from(document.querySelectorAll<HTMLElement>(".vtt-page-card.is-page, div.page-card"));
    let target: HTMLElement | null = null;
    for (const c of cards) { const w = c.closest("[data-page-id]"); if (w && w.getAttribute("data-page-id") === id) { target = c; break; } }
    if (!target) target = cards.find(c => (c.querySelector(".vtt-page-title")?.textContent || "").trim() === nm) ?? null;
    if (!target) target = cards.find(c => { const t = (c.querySelector(".vtt-page-title")?.textContent || "").trim(); return !!t && !!nm && t.includes(nm); }) ?? null;
    if (!target) return false;
    for (let el: HTMLElement | null = target; el; el = el.parentElement) { el.scrollTop = 0; const tf = getComputedStyle(el).transform; if (tf && tf !== "none") el.style.transform = "none"; }
    document.querySelectorAll("[data-harvest-target]").forEach(e => e.removeAttribute("data-harvest-target"));
    target.setAttribute("data-harvest-target", "1");
    return true;
  }, { id: pid, nm: name });
  if (!found) throw new Error(`card not found: ${name}`);
  await page.locator("[data-harvest-target='1']").first().dblclick({ timeout: 10_000 });
}

export async function captureMapImage(
  page: Page,
  pageId: string,
  pageName: string,
  imgsrc: string,
  expected?: { w: number; h: number },
  opts: { settleMs?: number } = {},
): Promise<CapturedImage | null> {
  // A readback is "full-res enough" if its long side reaches ~60% of the placed-graphic long side
  // (capped at the 4096 readback limit). Rejects thumbnails (e.g. a 73x100 `original` for a huge map)
  // → triggers the nav-fallback to fetch the rendered full-res texture.
  const fullRes = (c: CapturedImage | null) => {
    if (!c) return false;
    if (!expected?.w) return true;
    const want = Math.min(Math.max(expected.w, expected.h), 4096) * 0.6;
    return Math.max(c.w, c.h) >= want;
  };
  try {
    // 1. DIRECT readback — no navigation, imgsrc-only. Works for uploaded art whose `original` is
    //    full-res (most maps). Accept only if it's not a thumbnail.
    const direct = await readbackInPage(page, imgsrc, false);
    if (fullRes(direct)) return direct;

    // 2. NAV fallback — gated art, or huge maps whose imgsrc `original` is a thumbnail: render the
    //    page so the correct full-res texture is in the DOM/SW, then read back (DOM now safe).
    await navigateToCard(page, pageId, pageName);
    const deadline = Date.now() + (opts.settleMs ?? 8000);
    let active = "";
    while (Date.now() < deadline) {
      active = await page.evaluate(() => (window as any).Campaign?.activePage?.()?.id).catch(() => "");
      if (active === pageId) break;
      await page.waitForTimeout(500);
    }
    if (active !== pageId) { console.error(`[capture] NAV FAIL ${pageName}: active=${active}`); return direct; }
    await page.waitForTimeout(3500);
    const navd = await readbackInPage(page, imgsrc, true);
    // Prefer whichever is larger (the rendered DOM texture is usually the full-res one).
    const best = [direct, navd].filter(Boolean).sort((a, b) => (b!.w * b!.h) - (a!.w * a!.h))[0] ?? null;
    if (!best) console.error(`[capture] NO READABLE URL ${pageName}`);
    return best;
  } catch (e) {
    console.error(`[capture] EXCEPTION ${pageName}: ${String(e).slice(0, 160)}`);
    return null;
  }
}
