// Shared per-campaign CONTEXT: proper-noun vocab (STT biasing), spoken-alias nicknames,
// and durable DM notes. Stored in data/campaign-context.json keyed by slug — the SAME file
// the voice-HUD reads/writes, so the HUD and this MCP server (and Claude Code via the tools
// below) share one source of truth. Token↔character↔DDB mappings stay in characters.json;
// campaign IDs stay in campaigns.json. This layers the voice/agent extras on top.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import path from "path";

const CONTEXT_PATH = path.resolve("./data/campaign-context.json");

export interface NicknameAlias {
  nickname: string; // what the DM says, e.g. "Z", "the big guy"
  target: string;   // canonical token/character name it resolves to
}

export interface CampaignContext {
  vocab: string[];
  nicknames: NicknameAlias[];
  notes: string;
}

type ContextStore = Record<string, CampaignContext>; // key = slug

function normalize(c?: Partial<CampaignContext> | null): CampaignContext {
  return {
    vocab: Array.isArray(c?.vocab) ? c!.vocab : [],
    nicknames: Array.isArray(c?.nicknames) ? c!.nicknames : [],
    notes: typeof c?.notes === "string" ? c!.notes : "",
  };
}

function load(): ContextStore {
  if (!existsSync(CONTEXT_PATH)) return {};
  try {
    return JSON.parse(readFileSync(CONTEXT_PATH, "utf-8")) as ContextStore;
  } catch {
    return {}; // corrupt file — start fresh rather than throw on every read
  }
}

function save(store: ContextStore): void {
  const dir = path.dirname(CONTEXT_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(CONTEXT_PATH, JSON.stringify(store, null, 2), "utf-8");
}

export function getContext(slug: string): CampaignContext {
  return normalize(load()[slug]);
}

export function setContext(slug: string, ctx: Partial<CampaignContext>): CampaignContext {
  const store = load();
  store[slug] = normalize(ctx);
  save(store);
  return store[slug];
}

export function addVocab(slug: string, term: string): CampaignContext {
  const store = load();
  const ctx = normalize(store[slug]);
  const t = term.trim();
  if (t && !ctx.vocab.some((v) => v.toLowerCase() === t.toLowerCase())) ctx.vocab.push(t);
  store[slug] = ctx;
  save(store);
  return ctx;
}

export function removeVocab(slug: string, term: string): CampaignContext {
  const store = load();
  const ctx = normalize(store[slug]);
  const t = term.trim().toLowerCase();
  ctx.vocab = ctx.vocab.filter((v) => v.toLowerCase() !== t);
  store[slug] = ctx;
  save(store);
  return ctx;
}

// Add or update an alias (keyed by nickname, case-insensitive — re-pointing an existing
// nickname just updates its target).
export function addNickname(slug: string, nickname: string, target: string): CampaignContext {
  const store = load();
  const ctx = normalize(store[slug]);
  const n = nickname.trim();
  const tgt = target.trim();
  if (n && tgt) {
    const existing = ctx.nicknames.find((a) => a.nickname.toLowerCase() === n.toLowerCase());
    if (existing) existing.target = tgt;
    else ctx.nicknames.push({ nickname: n, target: tgt });
  }
  store[slug] = ctx;
  save(store);
  return ctx;
}

export function removeNickname(slug: string, nickname: string): CampaignContext {
  const store = load();
  const ctx = normalize(store[slug]);
  const n = nickname.trim().toLowerCase();
  ctx.nicknames = ctx.nicknames.filter((a) => a.nickname.toLowerCase() !== n);
  store[slug] = ctx;
  save(store);
  return ctx;
}

export function setNotes(slug: string, notes: string): CampaignContext {
  const store = load();
  const ctx = normalize(store[slug]);
  ctx.notes = notes;
  store[slug] = ctx;
  save(store);
  return ctx;
}
