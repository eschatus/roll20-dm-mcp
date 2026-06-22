// Per-campaign local state for relay bookkeeping that used to live in the Mod's `state` object.
// File-backed so it survives restarts. Currently: tier-2 custom-state tracking (which tokens hold
// each ad-hoc marker), moved here so toggleCondition can run direct (off chat) yet getCustomStates
// still reports the bindings. Keyed per campaign.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import path from "path";
import { dataPath } from "../dataDir.js";

interface CustomStateEntry { tag: string; tokens: string[] }
interface RelayState { customStates: Record<string, CustomStateEntry> }

const cache = new Map<string, RelayState>();

function file(campaignId: string): string {
  return dataPath(`relay-state-${campaignId}.json`);
}

function load(campaignId: string): RelayState {
  const cached = cache.get(campaignId);
  if (cached) return cached;
  let state: RelayState = { customStates: {} };
  try {
    if (existsSync(file(campaignId))) {
      const parsed = JSON.parse(readFileSync(file(campaignId), "utf-8")) as Partial<RelayState>;
      state = { customStates: parsed.customStates || {} };
    }
  } catch { /* corrupt → fresh */ }
  cache.set(campaignId, state);
  return state;
}

function save(campaignId: string, state: RelayState): void {
  cache.set(campaignId, state);
  mkdirSync(path.dirname(file(campaignId)), { recursive: true });
  writeFileSync(file(campaignId), JSON.stringify(state), "utf-8");
}

// Mirror of the Mod's trackCustomState: record which tokens hold a tier-2 ad-hoc state.
export function trackCustomState(campaignId: string, key: string, tag: string, tokenId: string, active: boolean): void {
  const state = load(campaignId);
  const entry = state.customStates[key] || { tag, tokens: [] };
  const set = new Set(entry.tokens);
  if (active) set.add(tokenId); else set.delete(tokenId);
  entry.tokens = Array.from(set);
  entry.tag = tag;
  if (entry.tokens.length === 0) delete state.customStates[key];
  else state.customStates[key] = entry;
  save(campaignId, state);
}

export function getCustomStates(campaignId: string): Record<string, CustomStateEntry> {
  return load(campaignId).customStates;
}
