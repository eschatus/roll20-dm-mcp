import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import Anthropic from "@anthropic-ai/sdk";
import * as roll20 from "../bridge/roll20.js";
import * as ddb from "../bridge/dndbeyond.js";

// ─── Types ────────────────────────────────────────────────────────────────────

interface TacticalEntry {
  round: number;
  summary: string;
}

interface TacticalState {
  tokenId: string;
  tokenName: string;
  intScore: number;
  wisScore: number;
  entries: TacticalEntry[];
  mediumTermPlan?: string;
  longTermGoal?: string;
  createdAt: number;
}

interface TokenData {
  id: string;
  name: string;
  represents: string;
  bar1_value: number;
  bar1_max: number;
  statusmarkers: string;
  left: number;
  top: number;
  layer: string;
  controlledby: string;
}

interface NearbyToken {
  id: string;
  name: string;
  layer: string;
  distanceFeet: number;
  bar1_value: number;
  bar1_max: number;
  controlledby: string;
}

interface TurnOrderEntry {
  id: string;
  pr: string;
  custom: string;
  _pageid: string;
}

// ─── Tier Config ──────────────────────────────────────────────────────────────

interface TierConfig {
  tier: number;
  label: string;
  model: string;
  thinkingBudget: number | null;
  maxResponseTokens: number;
  includeAllies: boolean;
  maxNearbyTokens: number;
  memoryEntries: number;
  cascade: "none" | "medium" | "full";
}

const TIER_CONFIGS: TierConfig[] = [
  { tier: 0, label: "Feral",      model: "claude-haiku-4-5-20251001", thinkingBudget: null, maxResponseTokens: 150,  includeAllies: false, maxNearbyTokens: 1, memoryEntries: 0, cascade: "none" },
  { tier: 1, label: "Dim",        model: "claude-haiku-4-5-20251001", thinkingBudget: null, maxResponseTokens: 250,  includeAllies: false, maxNearbyTokens: 2, memoryEntries: 1, cascade: "none" },
  { tier: 2, label: "Average",    model: "claude-sonnet-4-6",          thinkingBudget: null, maxResponseTokens: 400,  includeAllies: false, maxNearbyTokens: 3, memoryEntries: 2, cascade: "none" },
  { tier: 3, label: "Sharp",      model: "claude-sonnet-4-6",          thinkingBudget: 3000, maxResponseTokens: 1000, includeAllies: true,  maxNearbyTokens: 5, memoryEntries: 3, cascade: "none" },
  { tier: 4, label: "Brilliant",  model: "claude-sonnet-4-6",          thinkingBudget: 8000, maxResponseTokens: 1500, includeAllies: true,  maxNearbyTokens: 8, memoryEntries: 5, cascade: "medium" },
  { tier: 5, label: "Mastermind", model: "claude-opus-4-7",            thinkingBudget: 16000, maxResponseTokens: 2000, includeAllies: true, maxNearbyTokens: 12, memoryEntries: 8, cascade: "full" },
];

function resolveTier(intScore: number, wisScore: number): TierConfig {
  const effective = Math.floor((intScore + wisScore) / 2);
  if (effective <= 5)  return TIER_CONFIGS[0];
  if (effective <= 8)  return TIER_CONFIGS[1];
  if (effective <= 11) return TIER_CONFIGS[2];
  if (effective <= 15) return TIER_CONFIGS[3];
  if (effective <= 20) return TIER_CONFIGS[4];
  return TIER_CONFIGS[5];
}

function awarenessRadius(wisScore: number, requestedRadius: number): number {
  const wisMod = Math.floor((wisScore - 10) / 2);
  const computed = 30 + wisMod * 10;
  return Math.max(10, Math.min(requestedRadius, Math.max(computed, 10)));
}

// ─── DDB Monster Stats Cache ─────────────────────────────────────────────────

// Keyed by lowercased token name. Avoids repeated DDB calls for same monster type.
const monsterStatsCache = new Map<string, { intelligence: number; wisdom: number }>();

async function resolveMonsterScores(name: string): Promise<{ intelligence: number; wisdom: number } | null> {
  const key = name.toLowerCase();
  if (monsterStatsCache.has(key)) return monsterStatsCache.get(key)!;
  try {
    const monster = await ddb.getMonster(name);
    const scores = ddb.getMonsterAbilityScores(monster);
    const result = { intelligence: scores.intelligence ?? 10, wisdom: scores.wisdom ?? 10 };
    monsterStatsCache.set(key, result);
    return result;
  } catch {
    return null;
  }
}

// ─── Tactical Memory ──────────────────────────────────────────────────────────

const tacticMemory = new Map<string, TacticalState>();

function getOrCreateState(tokenId: string, tokenName: string, intScore: number, wisScore: number): TacticalState {
  const existing = tacticMemory.get(tokenId);
  if (existing) return existing;
  const state: TacticalState = { tokenId, tokenName, intScore, wisScore, entries: [], createdAt: Date.now() };
  tacticMemory.set(tokenId, state);
  return state;
}

function addEntry(state: TacticalState, round: number, summary: string): void {
  state.entries.unshift({ round, summary });
  if (state.entries.length > 10) state.entries.pop();
}

// ─── Anthropic Client ─────────────────────────────────────────────────────────

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  defaultHeaders: { "anthropic-beta": "prompt-caching-2024-07-31" },
});

const TACTICS_SYSTEM_PROMPT = `You are the tactical AI for a D&D 5e dungeon master's monsters and NPCs. Your job is to recommend the best action sequence for a creature's turn based on its intelligence tier.

Rules you must follow:
- Recommend exactly one Action, one Bonus Action (if available), and a Movement plan.
- Apply D&D 5e action economy correctly. Note available reactions if relevant.
- Scale your reasoning to the creature's intelligence: feral/dim creatures act on instinct; average creatures fight reasonably; sharp/brilliant/mastermind creatures use positioning, focus fire, and resource management.
- Be concise and immediately actionable. No rulebook citations.
- Never break character or reference game mechanics meta-textually.

Output format: Lead with the action itself, then one or two sentences of reasoning. For cascade tiers, structure your response clearly under the heading provided.`;

async function callAI(
  model: string,
  thinkingBudget: number | null,
  userContent: string,
  maxTokens: number,
): Promise<string> {
  const systemBlock = {
    type: "text" as const,
    text: TACTICS_SYSTEM_PROMPT,
    cache_control: { type: "ephemeral" as const },
  };

  const params: Anthropic.MessageCreateParams = {
    model,
    max_tokens: thinkingBudget !== null ? thinkingBudget + maxTokens : maxTokens,
    system: [systemBlock],
    messages: [{ role: "user", content: userContent }],
  };

  if (thinkingBudget !== null) {
    (params as unknown as Record<string, unknown>).thinking = { type: "enabled", budget_tokens: thinkingBudget };
    params.temperature = 1;
  }

  const response = await anthropic.messages.create(params);
  for (const block of response.content) {
    if (block.type === "text") return block.text.trim();
  }
  return "(no response)";
}

// ─── Context Builders ─────────────────────────────────────────────────────────

function formatHP(current: number, max: number): string {
  const pct = max > 0 ? Math.round((current / max) * 100) : 0;
  const label = pct > 75 ? "healthy" : pct > 50 ? "bloodied" : pct > 25 ? "badly wounded" : "critical";
  return `${current}/${max} HP (${label})`;
}

function formatConditions(statusmarkers: string): string {
  if (!statusmarkers || statusmarkers === "{}") return "none";
  // statusmarkers is a comma-separated list of marker::id strings
  const markers = statusmarkers.split(",").map(m => m.split("::")[0]).filter(Boolean);
  return markers.length > 0 ? markers.join(", ") : "none";
}

function buildBaseContext(
  token: TokenData,
  intScore: number,
  wisScore: number,
  tierLabel: string,
  nearby: NearbyToken[],
  config: TierConfig,
  state: TacticalState,
  notes?: string,
): string {
  const hp = formatHP(Number(token.bar1_value), Number(token.bar1_max));
  const conditions = formatConditions(token.statusmarkers);

  const lines: string[] = [
    "[CREATURE]",
    `Name: ${token.name}  HP: ${hp}  Conditions: ${conditions}`,
    `Intelligence: ${intScore}  Wisdom: ${wisScore}  Tier: ${tierLabel}`,
  ];

  const enemies = nearby.filter(t => t.controlledby !== "").slice(0, config.maxNearbyTokens);
  const allies = config.includeAllies ? nearby.filter(t => t.controlledby === "" && t.id !== token.id) : [];

  if (enemies.length > 0 || allies.length > 0) {
    lines.push("", "[BATTLEFIELD]");
    for (const e of enemies) {
      lines.push(`  Enemy — ${e.name}: ${formatHP(e.bar1_value, e.bar1_max)}, ${e.distanceFeet}ft away, conditions: ${formatConditions("")}`);
    }
    if (allies.length > 0) {
      lines.push("  Allies:");
      for (const a of allies.slice(0, config.maxNearbyTokens)) {
        lines.push(`    ${a.name}: ${formatHP(a.bar1_value, a.bar1_max)}, ${a.distanceFeet}ft away`);
      }
    }
  } else {
    lines.push("", "[BATTLEFIELD]", "  No tokens detected in range.");
  }

  const recentEntries = state.entries.slice(0, config.memoryEntries);
  if (recentEntries.length > 0) {
    lines.push("", "[MEMORY — RECENT ACTIONS]");
    for (const e of recentEntries) {
      lines.push(`  Round ${e.round}: ${e.summary}`);
    }
  }

  if (notes) {
    lines.push("", "[DM NOTES]", `  ${notes}`);
  }

  return lines.join("\n");
}

// ─── Cascade Planners ─────────────────────────────────────────────────────────

async function planSingle(
  config: TierConfig,
  baseContext: string,
  tokenName: string,
): Promise<{ shortTermPlan: string }> {
  const prompt = `${baseContext}\n\n[TASK]\nIt is ${tokenName}'s turn. What should it do right now?`;
  const shortTermPlan = await callAI(config.model, config.thinkingBudget, prompt, config.maxResponseTokens);
  return { shortTermPlan };
}

async function planMediumCascade(
  baseContext: string,
  tokenName: string,
  state: TacticalState,
  onStage?: OnStage,
): Promise<{ shortTermPlan: string; mediumTermPlan: string }> {
  const shortPrompt = `${baseContext}\n\n[TASK]\nIt is ${tokenName}'s turn. State its Action, Bonus Action, and Movement in 2-3 sentences. Be direct.`;
  const shortTermPlan = await callAI("claude-haiku-4-5-20251001", null, shortPrompt, 300);
  await onStage?.("short", shortTermPlan);

  const mediumLines = [baseContext, "", "[SHORT-TERM PLAN (THIS TURN)]", shortTermPlan];
  if (state.mediumTermPlan) mediumLines.push("", "[PRIOR MEDIUM-TERM PLAN]", state.mediumTermPlan);
  mediumLines.push("", "[TASK]", `Given the immediate action above, what is ${tokenName}'s tactical plan for the next 2-3 rounds? Consider positioning, resource conservation, focus fire, and contingencies.`);
  const mediumTermPlan = await callAI("claude-sonnet-4-6", 8000, mediumLines.join("\n"), 1500);
  await onStage?.("medium", mediumTermPlan);

  return { shortTermPlan, mediumTermPlan };
}

async function planFullCascade(
  baseContext: string,
  tokenName: string,
  state: TacticalState,
  forceReplan: boolean,
  currentHpPct: number,
  onStage?: OnStage,
): Promise<{ shortTermPlan: string; mediumTermPlan: string; longTermGoal: string }> {
  const { shortTermPlan, mediumTermPlan } = await planMediumCascade(baseContext, tokenName, state, onStage);

  const needsLongReplan = !state.longTermGoal || forceReplan || currentHpPct <= 0.5;
  let longTermGoal = state.longTermGoal ?? "";

  if (needsLongReplan) {
    const longLines = [
      baseContext, "",
      "[SHORT-TERM PLAN (THIS TURN)]", shortTermPlan, "",
      "[MEDIUM-TERM PLAN (2-3 ROUNDS)]", mediumTermPlan,
    ];
    if (state.longTermGoal && !forceReplan) longLines.push("", "[PRIOR STRATEGIC GOAL]", state.longTermGoal);
    longLines.push("", "[TASK]", `What is ${tokenName}'s overarching strategic goal for this entire encounter? Consider retreat conditions, protecting allies, eliminating priority targets, and leveraging the environment. This goal should guide decisions across many rounds.`);
    longTermGoal = await callAI("claude-opus-4-7", 16000, longLines.join("\n"), 2000);
    await onStage?.("long", longTermGoal);
  }

  return { shortTermPlan, mediumTermPlan, longTermGoal };
}

// ─── GM Whisper Cards ─────────────────────────────────────────────────────────

type StageLabel = "short" | "medium" | "long";
type OnStage = (stage: StageLabel, content: string) => Promise<void>;

function buildStageCard(
  tokenName: string,
  stage: StageLabel,
  content: string,
  intScore: number,
  wisScore: number,
  tier: number,
  tierLabel: string,
  nearbyCount: number,
): string {
  const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>");

  const STAGE_META: Record<StageLabel, { icon: string; label: string; accent: string; bodyColor: string }> = {
    short:  { icon: "&#x26A1;", label: "This Turn",       accent: "#cc9944", bodyColor: "#d4b0e0" },
    medium: { icon: "&#x1F4C5;", label: "Next 2-3 Rounds", accent: "#7799bb", bodyColor: "#b09ac0" },
    long:   { icon: "&#x1F3AF;", label: "Strategic Goal",  accent: "#aa6622", bodyColor: "#a088b0" },
  };
  const { icon, label, accent, bodyColor } = STAGE_META[stage];

  let html = `<div style='background:#0a0208;border:1px solid #2a0a3a;border-radius:3px;padding:5px 10px;font-family:"Palatino Linotype",Palatino,serif;'>`;
  html += `<div style='color:#bb88cc;font-size:0.9em;margin-bottom:2px;'><b>${tokenName}</b> <span style='color:#6a4a7a;font-size:0.85em;'>Tier ${tier} (${tierLabel}) &middot; Int ${intScore}/Wis ${wisScore} &middot; ${nearbyCount} in range</span></div>`;
  html += `<div style='color:${bodyColor};font-size:0.88em;border-left:2px solid #6a2a8a;padding-left:8px;'>`;
  html += `<div style='color:${accent};font-size:0.78em;text-transform:uppercase;letter-spacing:1px;margin-bottom:2px;'>${icon} ${label}</div>`;
  html += escape(content);
  html += `</div></div>`;
  return html;
}

function buildWhisperCard(
  tokenName: string,
  tier: number,
  tierLabel: string,
  intScore: number,
  wisScore: number,
  nearbyCount: number,
  shortTermPlan: string,
  mediumTermPlan?: string,
  longTermGoal?: string,
): string {
  const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>");

  let html = `<div style='background:#0a0208;border:1px solid #2a0a3a;border-radius:3px;padding:6px 10px;font-family:"Palatino Linotype",Palatino,serif;'>`;
  html += `<div style='color:#bb88cc;font-size:1em;margin-bottom:4px;'><b>&#x1F9E0; ${tokenName}</b> &mdash; Tier ${tier} <span style='color:#8855aa;'>(${tierLabel})</span></div>`;
  html += `<div style='color:#6a4a7a;font-size:0.78em;margin-bottom:6px;'>Int ${intScore} / Wis ${wisScore} &middot; ${nearbyCount} token${nearbyCount !== 1 ? "s" : ""} in range</div>`;

  html += `<div style='color:#d4b0e0;font-size:0.88em;border-left:2px solid #6a2a8a;padding-left:8px;margin-bottom:4px;'>`;
  html += `<div style='color:#cc9944;font-size:0.8em;text-transform:uppercase;letter-spacing:1px;margin-bottom:2px;'>&#x26A1; This Turn</div>`;
  html += escape(shortTermPlan);
  html += `</div>`;

  if (mediumTermPlan) {
    html += `<div style='color:#b09ac0;font-size:0.85em;border-left:2px solid #4a1a6a;padding-left:8px;margin-top:6px;margin-bottom:4px;'>`;
    html += `<div style='color:#7799bb;font-size:0.8em;text-transform:uppercase;letter-spacing:1px;margin-bottom:2px;'>&#x1F4C5; Next 2-3 Rounds</div>`;
    html += escape(mediumTermPlan);
    html += `</div>`;
  }

  if (longTermGoal) {
    html += `<div style='color:#a088b0;font-size:0.82em;border-left:2px solid #3a0a5a;padding-left:8px;margin-top:6px;'>`;
    html += `<div style='color:#aa6622;font-size:0.8em;text-transform:uppercase;letter-spacing:1px;margin-bottom:2px;'>&#x1F3AF; Strategic Goal</div>`;
    html += escape(longTermGoal);
    html += `</div>`;
  }

  html += `</div>`;
  return html;
}

// ─── Core Planner (shared by plan_tactics and plan_all_tactics) ───────────────

interface PlanOptions {
  intOverride?: number;
  wisOverride?: number;
  radiusFeet?: number;
  notes?: string;
  forceReplan?: boolean;
  postToChat?: boolean;
}

interface PlanResult {
  tokenId: string;
  tokenName: string;
  tier: number;
  tierLabel: string;
  intScore: number;
  wisScore: number;
  nearbyTokens: number;
  shortTermPlan: string;
  mediumTermPlan?: string;
  longTermGoal?: string;
  whispered: boolean;
  error?: string;
}

async function internalPlanToken(
  tokenId: string,
  activePage: string,
  opts: PlanOptions,
): Promise<PlanResult> {
  const { intOverride, wisOverride, radiusFeet = 60, notes, forceReplan = false, postToChat = true } = opts;

  const token = await roll20.relayCommand<TokenData>({ action: "getTokenById", tokenId });
  if (!token) throw new Error(`Token not found: ${tokenId}`);

  let intScore = intOverride ?? 0;
  let wisScore = wisOverride ?? 0;

  // 1. Roll20 character sheet attributes (linked tokens)
  if ((intOverride === undefined || wisOverride === undefined) && token.represents) {
    const attrs = await roll20.relayCommand<Record<string, { current: unknown; max: unknown }>>({
      action: "getCharacterAttributes",
      charId: token.represents,
      names: ["npc_intelligence", "npc_wisdom", "intelligence", "wisdom"],
    });
    if (intOverride === undefined) {
      const raw = attrs?.npc_intelligence?.current ?? attrs?.intelligence?.current;
      if (raw !== undefined && raw !== null) intScore = Number(raw);
    }
    if (wisOverride === undefined) {
      const raw = attrs?.npc_wisdom?.current ?? attrs?.wisdom?.current;
      if (raw !== undefined && raw !== null) wisScore = Number(raw);
    }
  }

  // 2. DDB monster compendium lookup (unlinked tokens — lookup by token name)
  if (intScore === 0 || wisScore === 0) {
    const ddbScores = await resolveMonsterScores(token.name);
    if (ddbScores) {
      if (intScore === 0) intScore = ddbScores.intelligence;
      if (wisScore === 0) wisScore = ddbScores.wisdom;
    }
  }

  // 3. Default fallback
  if (intScore === 0) intScore = 8;
  if (wisScore === 0) wisScore = 8;

  const config = resolveTier(intScore, wisScore);
  const scanRadius = awarenessRadius(wisScore, radiusFeet);

  const nearby = await roll20.relayCommand<NearbyToken[]>({
    action: "findTokensInRange",
    centerTokenId: tokenId,
    radiusFeet: scanRadius,
    pageId: activePage,
    layerFilter: "tokens",
  }) ?? [];

  const state = getOrCreateState(tokenId, token.name, intScore, wisScore);
  const currentHp = Number(token.bar1_value);
  const maxHp = Number(token.bar1_max);
  const currentHpPct = maxHp > 0 ? currentHp / maxHp : 1;

  const baseContext = buildBaseContext(token, intScore, wisScore, config.label, nearby, config, state, notes);

  let shortTermPlan = "";
  let mediumTermPlan: string | undefined;
  let longTermGoal: string | undefined;

  if (config.cascade === "none") {
    ({ shortTermPlan } = await planSingle(config, baseContext, token.name));
  } else if (config.cascade === "medium") {
    ({ shortTermPlan, mediumTermPlan } = await planMediumCascade(baseContext, token.name, state));
    state.mediumTermPlan = mediumTermPlan;
  } else {
    ({ shortTermPlan, mediumTermPlan, longTermGoal } = await planFullCascade(baseContext, token.name, state, forceReplan, currentHpPct));
    state.mediumTermPlan = mediumTermPlan;
    state.longTermGoal = longTermGoal;
  }

  if (postToChat) {
    const card = buildWhisperCard(
      token.name, config.tier, config.label,
      intScore, wisScore, nearby.length,
      shortTermPlan, mediumTermPlan, longTermGoal,
    );
    await roll20.relayCommand({ action: "setMobPlan", tokenId, html: card });
  }

  return {
    tokenId,
    tokenName: token.name,
    tier: config.tier,
    tierLabel: config.label,
    intScore,
    wisScore,
    nearbyTokens: nearby.length,
    shortTermPlan,
    mediumTermPlan,
    longTermGoal,
    whispered: postToChat,
  };
}

// ─── Tool Registration ────────────────────────────────────────────────────────

export function registerTacticsTools(server: McpServer): void {
  server.tool(
    "plan_tactics",
    "Generate AI tactical advice for a monster or NPC token, scaled by its Intelligence and Wisdom scores. Low-Int creatures get a simple instinct; high-Int creatures trigger a cascading short/medium/long-term plan across multiple models. Reads Int/Wis from the character sheet if linked, or accepts overrides for unlinked tokens. Whispers the plan to GM in Roll20 chat.",
    {
      tokenId: z.string().describe("Roll20 token ID of the monster or NPC"),
      intScore: z.number().int().min(1).max(30).optional().describe("Intelligence score override (for unlinked tokens without a character sheet)"),
      wisScore: z.number().int().min(1).max(30).optional().describe("Wisdom score override (for unlinked tokens without a character sheet)"),
      radiusFeet: z.number().default(60).describe("Radius to scan for nearby tokens"),
      pageId: z.string().optional().describe("Page to search — defaults to current player page"),
      notes: z.string().optional().describe("Optional DM hint injected into the prompt, e.g. 'enemy cleric is concentrating on Bless'"),
      forceReplan: z.boolean().default(false).describe("Force regeneration of the long-term strategic goal even if one is stored"),
      postToChat: z.boolean().default(true).describe("Whisper the plan to GM in Roll20 chat"),
    },
    async ({ tokenId, intScore: intOverride, wisScore: wisOverride, radiusFeet, pageId, notes, forceReplan, postToChat }) => {
      const activePage = pageId ?? (await roll20.getCurrentPageId());
      const result = await internalPlanToken(tokenId, activePage, { intOverride, wisOverride, radiusFeet, notes, forceReplan, postToChat });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "plan_all_tactics",
    "Plan tactics for every mob token on the current page — call automatically at combat start and at the top of each new round. Skips player-controlled tokens. Accepts per-token Int/Wis overrides for unlinked tokens (keyed by token name). Whispers one tactical card per mob to GM.",
    {
      pageId: z.string().optional().describe("Page to scan — defaults to current player page"),
      statOverrides: z.record(
        z.string(),
        z.object({
          intScore: z.number().int().min(1).max(30),
          wisScore: z.number().int().min(1).max(30),
        })
      ).optional().describe("Map of tokenName → { intScore, wisScore } for unlinked tokens, e.g. { 'Goblin': { intScore: 8, wisScore: 8 } }"),
      notes: z.string().optional().describe("Shared DM context injected into every mob's prompt"),
      forceReplan: z.boolean().default(false).describe("Force regeneration of stored long-term goals"),
      postToChat: z.boolean().default(true).describe("Whisper plans to GM in Roll20 chat"),
    },
    async ({ pageId, statOverrides = {}, notes, forceReplan, postToChat }) => {
      const activePage = pageId ?? (await roll20.getCurrentPageId());

      const allTokens = await roll20.relayCommand<TokenData[]>({ action: "getTokens", pageId: activePage }) ?? [];
      const mobs = allTokens.filter(t =>
        !t.controlledby &&
        t.layer === "tokens" &&
        Number(t.bar1_max) > 0
      );

      if (mobs.length === 0) {
        return { content: [{ type: "text", text: JSON.stringify({ planned: 0, message: "No eligible mob tokens found on page" }) }] };
      }

      // Launch all in parallel and return immediately — whispers arrive as each mob/stage completes.
      // Errors are swallowed per-mob so one bad token doesn't block the others.
      void Promise.allSettled(
        mobs.map(mob => {
          const override = statOverrides[mob.name];
          return internalPlanToken(mob.id, activePage, {
            intOverride: override?.intScore,
            wisOverride: override?.wisScore,
            notes,
            forceReplan,
            postToChat,
          });
        })
      );

      return {
        content: [{
          type: "text",
          text: JSON.stringify({ launched: mobs.length, note: "Tactical briefings running in background — whispers will arrive as each mob and stage completes." }),
        }],
      };
    }
  );

  server.tool(
    "record_tactic_outcome",
    "Record what a monster actually did on its turn. This builds the tactical memory used in future plan_tactics calls, giving creatures continuity and avoiding repeated mistakes.",
    {
      tokenId: z.string().describe("Roll20 token ID of the monster"),
      summary: z.string().describe("What it did, e.g. 'Multiattacked Aldric for 14 dmg, moved behind pillar'"),
      round: z.number().int().optional().describe("Combat round number (defaults to 1 if not provided)"),
    },
    async ({ tokenId, summary, round = 1 }) => {
      let state = tacticMemory.get(tokenId);
      if (!state) {
        // Create a stub state if planning hasn't happened yet
        const token = await roll20.relayCommand<TokenData>({ action: "getTokenById", tokenId });
        state = getOrCreateState(tokenId, token?.name ?? tokenId, 8, 8);
      }
      addEntry(state, round, summary);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ tokenId, tokenName: state.tokenName, totalEntries: state.entries.length }),
        }],
      };
    }
  );

  server.tool(
    "get_tactic_memory",
    "Read the current tactical memory for a monster token — its recorded action history, and any stored medium/long-term plans.",
    { tokenId: z.string().describe("Roll20 token ID of the monster") },
    async ({ tokenId }) => {
      const state = tacticMemory.get(tokenId) ?? null;
      return { content: [{ type: "text", text: JSON.stringify(state, null, 2) }] };
    }
  );

  server.tool(
    "clear_tactic_memory",
    "Wipe tactical memory for one token or all tokens. Call at the end of an encounter to reset state.",
    { tokenId: z.string().optional().describe("Token ID to clear. Omit to clear all tokens.") },
    async ({ tokenId }) => {
      if (tokenId) {
        const had = tacticMemory.has(tokenId);
        tacticMemory.delete(tokenId);
        await roll20.relayCommand({ action: "setMobPlan", tokenId, html: "" });
        return { content: [{ type: "text", text: JSON.stringify({ cleared: had ? 1 : 0 }) }] };
      }
      const count = tacticMemory.size;
      tacticMemory.clear();
      await roll20.relayCommand({ action: "clearMobPlans" });
      return { content: [{ type: "text", text: JSON.stringify({ cleared: count }) }] };
    }
  );
}
