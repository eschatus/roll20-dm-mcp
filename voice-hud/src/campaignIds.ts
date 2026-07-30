// Pure helpers for extracting numeric campaign IDs from either a bare ID or a pasted
// Roll20/D&D Beyond URL. No I/O, no Electron — kept separate so the campaign-maker form
// (gem.html "Campaign" section) can accept whatever the DM pastes in without depending on
// exact formatting, and so the extraction logic is trivially unit-testable.

/**
 * Extract a Roll20 campaign id from a bare numeric id or a details URL, e.g.:
 *   "8675309"
 *   "https://app.roll20.net/campaigns/details/8675309"
 *   "https://app.roll20.net/campaigns/details/8675309/curse-of-strahd" (trailing slug tolerated)
 * Returns null for anything that doesn't resolve to a numeric id.
 */
export function extractRoll20Id(input: string): string | null {
  const s = (input || "").trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) return s;
  const m = s.match(/campaigns\/details\/(\d+)/);
  return m ? m[1] : null;
}

/**
 * Extract a D&D Beyond campaign id from a bare numeric id or a campaigns URL, e.g.:
 *   "5201061"
 *   "https://www.dndbeyond.com/campaigns/5201061"
 *   "https://www.dndbeyond.com/campaigns/5201061/some-campaign-name" (trailing slug tolerated)
 * Returns null for anything that doesn't resolve to a numeric id.
 */
export function extractDdbId(input: string): string | null {
  const s = (input || "").trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) return s;
  const m = s.match(/campaigns\/(\d+)/);
  return m ? m[1] : null;
}
