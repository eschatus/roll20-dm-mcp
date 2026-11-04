// Read the art-upload credential out of a DevTools "Copy as cURL" paste, the no-gem route to
// roll20-upload-cache.json.
//
// A Console line can't do this: Roll20's session cookies are HttpOnly, so a page script never sees
// them. A copied request carries the whole jar and the browser's User-Agent, which Cloudflare binds
// cf_clearance to, so it needs nothing else. Errors never quote the paste: it is a login.
import { ROLL20_ORIGIN, type UploadCredential } from "./art-upload.js";

const quoted = (flags: string) => new RegExp(`(?:${flags})\\s+(['"])([\\s\\S]*?)\\1`, "i");

export function parseCurlCredential(paste: string): Required<UploadCredential> {
  // Chrome's "Copy as cURL (cmd)" escapes with carets.
  const text = paste.includes('^"') ? paste.replace(/\^(.)/g, "$1") : paste;
  const url = text.match(/curl\s+(?:-\S+\s+)*['"]?(https?:\/\/[^'"\s]+)/i)?.[1];
  if (!url) throw new Error("that isn't a copied cURL command. In the Network tab, right-click a request → Copy → Copy as cURL.");
  if (!url.startsWith(`${ROLL20_ORIGIN}/`)) {
    throw new Error(`that request isn't to app.roll20.net, so it carries the wrong cookies. Use the top request after reloading the editor.`);
  }
  const jar = text.match(quoted("-b|--cookie"))?.[2]
    ?? text.match(/-H\s+(['"])cookie:\s*([\s\S]*?)\1/i)?.[2];
  const userAgent = text.match(/-H\s+(['"])user-agent:\s*([\s\S]*?)\1/i)?.[2];
  if (!jar) throw new Error("that request carries no cookies. Use the top request after reloading the editor.");
  if (!userAgent) throw new Error("that request carries no User-Agent, which Cloudflare needs to match.");

  const cookies: Record<string, string> = {};
  for (const pair of jar.split(/;\s*/)) {
    const eq = pair.indexOf("=");
    if (eq > 0) cookies[pair.slice(0, eq).trim()] = pair.slice(eq + 1);
  }
  if (!cookies["rack.session"]) throw new Error("that request has no rack.session cookie, so it isn't a logged-in Roll20 page.");
  return { cookies, userAgent };
}
