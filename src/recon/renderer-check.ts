// Determine a campaign's renderer by navigating to its first walled page and reporting where the
// map texture loads from: files.d20.io/images/... (LEGACY → render-capturable) vs no map response
// (JUMPGATE → texture served from a service-worker, not interceptable).
// Run: tsx src/recon/renderer-check.ts [--campaign slug]
process.env.ROLL20_TRANSPORT ??= "rt";
import { getEditorPage, relayCommand } from "../bridge/roll20.js";
import { rtGet } from "../bridge/roll20-rt.js";
import { setActiveCampaign, getActiveCampaign } from "../registry/campaigns.js";

const ci = process.argv.indexOf("--campaign");
if (ci >= 0) setActiveCampaign(process.argv[ci + 1]!);
console.error("campaign:", getActiveCampaign().name, getActiveCampaign().roll20CampaignId);

const pages = await relayCommand<{ id: string; name: string }[]>({ action: "listPages" });
// find first page with walls on the walls layer
let target: { id: string; name: string } | null = null;
for (const p of pages) {
  const paths = await rtGet<Record<string, { layer?: string; path?: string }>>(`paths/page/${p.id}`).catch(() => ({}));
  if (Object.values(paths ?? {}).some((x) => x.layer === "walls" && x.path)) { target = p; break; }
}
if (!target) { console.error("no walled page found"); process.exit(1); }
console.error("walled page:", target.name, target.id);

const page = await getEditorPage();
const imgs: string[] = [];
page.on("response", async (resp) => {
  const ct = resp.headers()["content-type"] ?? "";
  if (!/image\//.test(ct)) return;
  let len = -1; try { len = (await resp.body()).length; } catch {}
  if (len > 50_000 && !/\/(thumb|min|med)\./.test(resp.url())) imgs.push(`${len}B ${resp.url().slice(0, 80)}`);
});

try { const cdp = await page.context().newCDPSession(page); await cdp.send("Network.setCacheDisabled", { cacheDisabled: true }); } catch {}
await page.evaluate(() => {
  if (document.querySelector("div.page-card[data-page-id]")) return;
  const t = Array.from(document.querySelectorAll("span.grimoire__roll20-icon")).find((s) => s.textContent?.trim() === "pageList");
  (t?.closest("button") ?? (t as HTMLElement))?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
});
await page.waitForTimeout(1200);
const nav = async (pid: string, name: string) => {
  const s = page.locator(".page-search-input input").first();
  await s.fill(""); await s.fill(name); await page.waitForTimeout(900);
  await page.evaluate((id) => { const c = document.querySelector<HTMLElement>(`div.page-card[data-page-id="${id}"]`); for (let el: HTMLElement | null = c; el; el = el.parentElement) { el.scrollTop = 0; const tf = getComputedStyle(el).transform; if (tf && tf !== "none") el.style.transform = "none"; } }, pid);
  await page.locator(`div.page-card[data-page-id="${pid}"] .vtt-page-card.is-page`).first().dblclick({ timeout: 10000 }).catch(() => {});
};
// hop away then to target to force a fresh transition
const other = await page.evaluate((pid) => { const c = Array.from(document.querySelectorAll<HTMLElement>("div.page-card[data-page-id]")).find((e) => e.getAttribute("data-page-id") !== pid); return c ? { id: c.getAttribute("data-page-id"), name: c.querySelector(".vtt-page-title")?.textContent?.trim() ?? "" } : null; }, target.id);
if (other?.id) { await nav(other.id, other.name); await page.waitForTimeout(2500); }
imgs.length = 0;
await nav(target.id, target.name);
await page.waitForTimeout(10000);
const active = await page.evaluate(() => (window as any).Campaign?.activePage?.()?.id);

const mapImg = imgs.find((s) => /files\.d20\.io\/(images|marketplace)\//.test(s) && /\/(original|max)\./.test(s));
console.error("\nactivePage:", active, "(want", target.id + ")");
console.error("big image responses:", imgs.length ? imgs.join("\n  ") : "(none)");
console.error("\nVERDICT:", mapImg ? "LEGACY — render-capturable ✓" : "JUMPGATE (or nav failed) — no interceptable map texture ✗");
process.exit(0);
