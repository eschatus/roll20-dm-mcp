// App-level (not per-campaign) settings, persisted to voice-hud/data/settings.json.
// Currently just the agent-whisper notification sound toggle.

import * as fs from "fs";
import * as path from "path";
import { CONFIG } from "./config";

export interface GemTheme {
  gemPrimary: string;    // main gem body color
  textColor: string;     // DM transcript text
  textShadow: string;    // DM transcript glow/shadow
  respColor: string;     // agent reply text
  respShadow: string;    // agent reply glow/shadow
}

export interface AppSettings {
  agentSound: boolean; // play a random whisper clip when the agent responds
  theme: GemTheme;
  provider?: "ollama" | "anthropic"; // persisted brain selection; falls back to DMW_PROVIDER env
}

const FILE = () => path.join(CONFIG.dataDir, "settings.json");

const defaultTheme: GemTheme = {
  gemPrimary: "#b43c5a",   // crimson gem
  textColor:  "#fff2f5",   // pale rose (DM)
  textShadow: "#50101a",   // deep wine glow
  respColor:  "#b8f0c2",   // eldritch green (agent)
  respShadow: "#1e7a3c",   // green glow
};

const defaults: AppSettings = {
  // env DMW_AGENT_SOUND=0 disables by default; otherwise on.
  agentSound: process.env.DMW_AGENT_SOUND !== "0",
  theme: { ...defaultTheme },
};

export function loadSettings(): AppSettings {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE(), "utf-8")) as Partial<AppSettings>;
    return { ...defaults, ...raw, theme: { ...defaultTheme, ...(raw.theme || {}) } };
  } catch {
    return { ...defaults, theme: { ...defaultTheme } };
  }
}

export function saveSettings(s: AppSettings): void {
  if (!fs.existsSync(CONFIG.dataDir)) fs.mkdirSync(CONFIG.dataDir, { recursive: true });
  fs.writeFileSync(FILE(), JSON.stringify(s, null, 2), "utf-8");
}
