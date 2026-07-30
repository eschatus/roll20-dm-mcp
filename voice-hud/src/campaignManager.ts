// Campaign picker/maker — direct MCP tool calls, no LLM in the loop.
//
// WHY: campaign switching used to happen only via the agent calling switch_campaign (voice), which
// is fragile (a mishear picks the wrong campaign) and about to be flatly unavailable on the local
// fine-tuned combat specialist (its tool scope deliberately excludes switch_campaign/
// register_campaign/list_campaigns). This module is the result-shaping layer the gem.html "Campaign"
// section's ipcMain handlers delegate to — factored out of main.ts so it's testable without Electron
// (mock the McpLike client; no BrowserWindow/app import needed).

import { extractRoll20Id, extractDdbId } from "./campaignIds";

export interface McpLike {
  call(name: string, args: Record<string, unknown>): Promise<string>;
}

export type Result<T> = { ok: true; data: T } | { ok: false; error: string };

// register_campaign/switch_campaign/list_campaigns/ddb_list_campaigns all throw
// "MCP client not connected" (mcp.ts) before a connect() has succeeded — surface a readable
// message instead of the raw Error text.
function mcpErrorMessage(err: unknown): string {
  const msg = (err instanceof Error ? err.message : String(err)) || "unknown error";
  return /not connected/i.test(msg) ? "not connected — connect to the MCP server first" : msg;
}

export interface CampaignSummary {
  slug: string;
  name: string;
  active: boolean;
  roll20CampaignId?: string;
  ddbCampaignId?: string;
  notes?: string;
}

export async function listCampaigns(mcp: McpLike): Promise<Result<CampaignSummary[]>> {
  try {
    const raw = await mcp.call("list_campaigns", {});
    // list_campaigns returns a JSON array normally, but a friendly sentence
    // ("No campaigns registered yet. Use register_campaign to add one.") when empty.
    let list: CampaignSummary[] = [];
    try { list = JSON.parse(raw); } catch { list = []; }
    return { ok: true, data: Array.isArray(list) ? list : [] };
  } catch (err) {
    return { ok: false, error: mcpErrorMessage(err) };
  }
}

export async function switchCampaign(mcp: McpLike, slugOrName: string): Promise<Result<{ slug: string }>> {
  const s = (slugOrName || "").trim();
  if (!s) return { ok: false, error: "no campaign selected" };
  try {
    await mcp.call("switch_campaign", { slugOrName: s });
    return { ok: true, data: { slug: s } };
  } catch (err) {
    return { ok: false, error: mcpErrorMessage(err) };
  }
}

export interface RegisterCampaignInput {
  name: string;
  roll20: string; // bare numeric id OR a Roll20 details URL
  ddb: string;    // bare numeric id OR a D&D Beyond campaign URL
  notes?: string;
}

export async function registerCampaign(mcp: McpLike, input: RegisterCampaignInput): Promise<Result<{ slug: string }>> {
  const name = (input?.name || "").trim();
  if (!name) return { ok: false, error: "campaign name is required" };
  const roll20Id = extractRoll20Id(input?.roll20 || "");
  if (!roll20Id) return { ok: false, error: "couldn't find a Roll20 campaign id — paste the numeric id or the campaign URL" };
  const ddbId = extractDdbId(input?.ddb || "");
  if (!ddbId) return { ok: false, error: "couldn't find a D&D Beyond campaign id — paste the numeric id or the campaign URL" };
  try {
    const raw = await mcp.call("register_campaign", {
      name,
      roll20CampaignId: roll20Id,
      ddbCampaignId: ddbId,
      ...(input.notes?.trim() ? { notes: input.notes.trim() } : {}),
    });
    // register_campaign's tool reply is a sentence: `Registered campaign "X" as slug "y-z".`
    const m = raw.match(/slug "([^"]+)"/);
    if (!m) return { ok: false, error: `registered, but couldn't parse the slug from the server's reply: ${raw.slice(0, 160)}` };
    const slug = m[1];
    await mcp.call("switch_campaign", { slugOrName: slug });
    return { ok: true, data: { slug } };
  } catch (err) {
    return { ok: false, error: mcpErrorMessage(err) };
  }
}

export interface DdbCampaignSummary { id: string; name: string; }

// Best-effort — the maker form falls back to plain text entry when this errors (DDB not
// connected: needs a harvested CobaltSession) or the DDB campaigns page shape ever changes.
export async function listDdbCampaigns(mcp: McpLike): Promise<Result<DdbCampaignSummary[]>> {
  try {
    const raw = await mcp.call("ddb_list_campaigns", {});
    let list: DdbCampaignSummary[] = [];
    try { list = JSON.parse(raw); } catch { list = []; }
    return { ok: true, data: Array.isArray(list) ? list : [] };
  } catch (err) {
    return { ok: false, error: mcpErrorMessage(err) };
  }
}
