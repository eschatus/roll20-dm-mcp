import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import Anthropic from "@anthropic-ai/sdk";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import * as roll20 from "../bridge/roll20.js";
import * as ddb from "../bridge/dndbeyond.js";
import { rtEnabled, rtWriteMobPlan } from "../bridge/roll20-rt.js";
import { callModel as sharedCallModel, __setAnthropicForTest as llmSetAnthropicForTest } from "../llm.js";

// ─── Doctrine Index (Ammann book) ────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DOCTRINE_PATH = path.resolve(__dirname, "../../data/tactics/monster-tactics-index.json");

let doctrineIndex: Record<string, string> = {};
try {
  doctrineIndex = JSON.parse(fs.readFileSync(DOCTRINE_PATH, "utf-8"));
} catch {
  // not available — doctrine lookups will silently return nothing
}

export function lookupDoctrine(creatureName: string): string | undefined {
  const n = creatureName.toLowerCase().trim();
  if (doctrineIndex[n]) return doctrineIndex[n];

  // Try plural/singular forms
  const forms = [n + "s", n + "es", n + "ies"];
  if (n.endsWith("y")) forms.push(n.slice(0, -1) + "ies");
  if (n.endsWith("es")) forms.push(n.slice(0, -2));
  if (n.endsWith("s")) forms.push(n.slice(0, -1));
  for (const f of forms) {
    if (doctrineIndex[f]) return doctrineIndex[f];
  }

  // Multi-word: try last-word pluralization, then recurse on first word
  const words = n.split(" ");
  if (words.length > 1) {
    const lastPlural = [...words.slice(0, -1), words[words.length - 1] + "s"].join(" ");
    if (doctrineIndex[lastPlural]) return doctrineIndex[lastPlural];
    const lastEs = [...words.slice(0, -1), words[words.length - 1] + "es"].join(" ");
    if (doctrineIndex[lastEs]) return doctrineIndex[lastEs];
    // Fall back to first word
    return lookupDoctrine(words[0]);
  }

  // Substring: any key that contains this name
  for (const [k, v] of Object.entries(doctrineIndex)) {
    if (k.includes(n)) return v;
  }

  return undefined;
}

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
  gmnotes: string;
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

// ─── Model IDs ──────────────────────────────────────────────────────────────
// Single source of truth for the model identifiers used across tactics + vision.
// Update here when migrating model versions.
export const MODELS = {
  haiku: "claude-haiku-4-5-20251001",
  sonnet: "claude-sonnet-4-6",
  opus: "claude-opus-4-8",
} as const;

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
  { tier: 0, label: "Feral",      model: MODELS.haiku,  thinkingBudget: null, maxResponseTokens: 150,  includeAllies: false, maxNearbyTokens: 1, memoryEntries: 0, cascade: "none" },
  { tier: 1, label: "Dim",        model: MODELS.haiku,  thinkingBudget: null, maxResponseTokens: 250,  includeAllies: false, maxNearbyTokens: 2, memoryEntries: 1, cascade: "none" },
  { tier: 2, label: "Average",    model: MODELS.sonnet, thinkingBudget: null, maxResponseTokens: 400,  includeAllies: false, maxNearbyTokens: 3, memoryEntries: 2, cascade: "none" },
  { tier: 3, label: "Sharp",      model: MODELS.sonnet, thinkingBudget: 3000, maxResponseTokens: 1000, includeAllies: true,  maxNearbyTokens: 5, memoryEntries: 3, cascade: "none" },
  { tier: 4, label: "Brilliant",  model: MODELS.sonnet, thinkingBudget: 8000, maxResponseTokens: 1500, includeAllies: true,  maxNearbyTokens: 8, memoryEntries: 5, cascade: "medium" },
  { tier: 5, label: "Mastermind", model: MODELS.opus,   thinkingBudget: 16000, maxResponseTokens: 2000, includeAllies: true, maxNearbyTokens: 12, memoryEntries: 8, cascade: "full" },
];

export function resolveTier(intScore: number, wisScore: number): TierConfig {
  const effective = Math.floor((intScore + wisScore) / 2);
  if (effective <= 5)  return TIER_CONFIGS[0];
  if (effective <= 8)  return TIER_CONFIGS[1];
  if (effective <= 11) return TIER_CONFIGS[2];
  if (effective <= 15) return TIER_CONFIGS[3];
  if (effective <= 20) return TIER_CONFIGS[4];
  return TIER_CONFIGS[5];
}

export function awarenessRadius(wisScore: number, requestedRadius: number): number {
  const wisMod = Math.floor((wisScore - 10) / 2);
  const computed = 60 + wisMod * 15;
  return Math.max(15, Math.min(requestedRadius, Math.max(computed, 15)));
}

// ─── DDB Monster Stats Cache ─────────────────────────────────────────────────

interface MonsterData {
  strength: number;
  dexterity: number;
  constitution: number;
  intelligence: number;
  wisdom: number;
  charisma: number;
  abilitySummary: string;  // pre-formatted for prompt injection
}

// Keyed by lowercased token name. Avoids repeated DDB calls for same monster type.
const monsterStatsCache = new Map<string, MonsterData>();

async function resolveMonsterData(name: string): Promise<MonsterData | null> {
  const key = name.toLowerCase();
  if (monsterStatsCache.has(key)) return monsterStatsCache.get(key)!;
  try {
    const monster = await ddb.getMonster(name);
    const scores = ddb.getMonsterAbilityScores(monster);
    const result: MonsterData = {
      strength: scores.strength ?? 10,
      dexterity: scores.dexterity ?? 10,
      constitution: scores.constitution ?? 10,
      intelligence: scores.intelligence ?? 10,
      wisdom: scores.wisdom ?? 10,
      charisma: scores.charisma ?? 10,
      abilitySummary: ddb.getMonsterAbilities(monster),
    };
    monsterStatsCache.set(key, result);
    return result;
  } catch {
    return null;
  }
}

// ─── Pure stat resolution cascade ────────────────────────────────────────────
//
// Resolves a creature's six ability scores + ability summary from up to three
// already-fetched sources, in priority order:
//   1. Explicit Int/Wis overrides (caller-supplied, e.g. for unlinked tokens).
//   2. Character-sheet attributes + NPC action rows (source of truth if actions present).
//   3. DDB compendium fallback (only consulted when the sheet had no actions).
//   4. Hard defaults (physical/CHA → 10, INT/WIS → 8).
//
// This function performs NO I/O — all data is passed in. That makes the whole
// cascade deterministic and unit-testable. The relay/network fetches stay in
// internalPlanToken.

export interface StatResolutionInputs {
  intOverride?: number;
  wisOverride?: number;
  // Character-sheet ability scores (0 / undefined when absent). Already merged
  // npc_* → pc fallback by the caller.
  sheet?: {
    strength?: number;
    dexterity?: number;
    constitution?: number;
    intelligence?: number;
    wisdom?: number;
    charisma?: number;
    // Pre-formatted "Actions:\n…" block from the npcaction repeating section.
    // Presence makes the sheet the source of truth (DDB fallback is skipped).
    abilitySummary?: string;
  };
  // DDB compendium data (null when the lookup failed or wasn't attempted).
  ddb?: MonsterData | null;
}

export function resolveMonsterStats(inputs: StatResolutionInputs): MonsterData {
  const { intOverride, wisOverride, sheet, ddb: ddbData } = inputs;

  // Stage 2: seed from character sheet (0 means "absent").
  let strScore = sheet?.strength ?? 0;
  let dexScore = sheet?.dexterity ?? 0;
  let conScore = sheet?.constitution ?? 0;
  let intScore = intOverride ?? sheet?.intelligence ?? 0;
  let wisScore = wisOverride ?? sheet?.wisdom ?? 0;
  let chaScore = sheet?.charisma ?? 0;

  const sheetSummary = sheet?.abilitySummary ?? "";
  const wroteFromSheet = sheetSummary.length > 0;
  let abilitySummary = sheetSummary;

  // Stage 3: DDB compendium fallback — only when the sheet had no actions.
  if (!wroteFromSheet && ddbData) {
    if (strScore === 0) strScore = ddbData.strength;
    if (dexScore === 0) dexScore = ddbData.dexterity;
    if (conScore === 0) conScore = ddbData.constitution;
    if (intScore === 0 && intOverride === undefined) intScore = ddbData.intelligence;
    if (wisScore === 0 && wisOverride === undefined) wisScore = ddbData.wisdom;
    if (chaScore === 0) chaScore = ddbData.charisma;
    abilitySummary = ddbData.abilitySummary;
  }

  // Stage 4: defaults.
  if (strScore === 0) strScore = 10;
  if (dexScore === 0) dexScore = 10;
  if (conScore === 0) conScore = 10;
  if (intScore === 0) intScore = 8;
  if (wisScore === 0) wisScore = 8;
  if (chaScore === 0) chaScore = 10;

  return Object.freeze({
    strength: strScore,
    dexterity: dexScore,
    constitution: conScore,
    intelligence: intScore,
    wisdom: wisScore,
    charisma: chaScore,
    abilitySummary,
  });
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
//
// The client and callModel are now provided by src/llm.ts.
// The __setAnthropicForTest export is kept here so existing test imports
// (and any external callers) continue to compile and work — it delegates to
// the shared llm.ts seam which actually owns the client instance.

export function __setAnthropicForTest(client: Pick<Anthropic, "messages">): void {
  llmSetAnthropicForTest(client);
}

const TACTICS_SYSTEM_PROMPT = `You are the tactical AI for a D&D 5e dungeon master. Your job is to recommend the best action sequence for a creature's turn. Recommendations must reflect how this specific creature actually behaves — not generic "smart monster" advice.

═══ SURVIVAL ═══
Every creature wants to survive. Flee when HP drops to 40% or below unless the creature is (a) undead, a construct, or a fanatic, or (b) intelligent enough to know it will be hunted down if it flees.
Wisdom governs when the creature recognizes danger: Wis ≤ 7 may wait too long to flee; Wis 8–11 knows to flee but picks bad moments; Wis 12+ recognizes a losing fight early.

═══ INTELLIGENCE ═══
Int ≤ 7: One modus operandi. Uses its feature effectively but cannot adapt when it stops working.
Int 8–11: Unsophisticated. Can tell when things go wrong and adjust slightly.
Int 12+: Plans and coordinates with allies. Picks the right attack for the situation.
Int 14+: Accurately reads enemy weaknesses and targets accordingly.

═══ WISDOM ═══
Wis ≤ 7: Indiscriminate target selection.
Wis 8–11: Knows to flee but does not choose targets carefully.
Wis 12+: Chooses targets carefully; may attempt parley if clearly outmatched.
Wis 14+: Only fights when it believes it will win, or when it has no other option.

═══ PHYSICAL ABILITY FIGHTING STYLES ═══
Low STR: Compensate with numbers. Scatter if outnumbered below 3:1 ratio.
Low CON: Attack from hiding. Avoid taking hits at all costs.
Low DEX: Needs a compensatory advantage before engaging.
High STR + High CON + Low DEX: Welcome the close-quarters slugfest.
High STR + Low CON + High DEX: Stealth approach, go for high-damage opening strike.
Low STR + High DEX + High CON: Scrappy — harass and outlast.
Low STR + High DEX + Low CON: Stay at range, snipe.
All physical abilities low: Avoid combat, lay traps, flee if cornered.

═══ ACTION ECONOMY ═══
Always maximize movement + action + bonus action + reaction.
A feature that grants advantage (or imposes disadvantage) is worth ~±4 on a d20. A creature that has such a feature will always prefer to set it up first — it may even forgo attacking to position for advantage.
Features requiring saving throws are preferred over attack rolls: the presumption is success; the burden is on the defender to avoid. Features that deal damage even on a save are especially valuable.
Low-STR mobs need 3:1 numerical advantage; smarter creatures account for armor and behavior.

═══ ALIGNMENT ═══
Evil creatures are aggressive and lethal. Lawful creatures may capture rather than kill (especially lawful good). Good creatures default to friendly unless territorial or provoked. Nearly all creatures are territorial.

═══ ABILITIES ═══
The [ABILITIES] section in the context lists this creature's actual special traits, actions, and resistances. Use these. If a feature gives the creature advantage on attacks (e.g. Pack Tactics), the creature will always try to set that up. If a feature requires a saving throw, prefer it over a basic attack.

═══ OUTPUT ═══
One line, no newlines. Use this exact format:
**Move:** [5 words] · **Action:** [attack and target] · **BA:** [bonus action or omit] · **Note:** [one phrase if unusual, else omit]

Bold labels, · separator. No newlines anywhere. No prose. Under 40 words.`;

async function callAI(
  model: string,
  thinkingBudget: number | null,
  userContent: string,
  maxTokens: number,
): Promise<string> {
  const result = await sharedCallModel(model, TACTICS_SYSTEM_PROMPT, userContent, maxTokens, thinkingBudget);
  return result || "(no response)";
}

// ─── Context Builders ─────────────────────────────────────────────────────────

function formatHP(current: number, max: number): string {
  const pct = max > 0 ? Math.round((current / max) * 100) : 0;
  const label = pct > 75 ? "healthy" : pct > 50 ? "bloodied" : pct > 25 ? "badly wounded" : "critical";
  return `${current}/${max} HP (${label})`;
}

export function rangeBand(feet: number): string {
  if (feet <= 5)   return `adjacent (${Math.round(feet)}ft)`;
  if (feet <= 30)  return `near (${Math.round(feet)}ft)`;
  if (feet <= 60)  return `mid (${Math.round(feet)}ft)`;
  if (feet <= 120) return `far (${Math.round(feet)}ft)`;
  return `distant (${Math.round(feet)}ft)`;
}

function formatConditions(statusmarkers: string): string {
  if (!statusmarkers || statusmarkers === "{}") return "none";
  // statusmarkers is a comma-separated list of marker::id strings
  const markers = statusmarkers.split(",").map(m => m.split("::")[0]).filter(Boolean);
  return markers.length > 0 ? markers.join(", ") : "none";
}

function buildBaseContext(
  token: TokenData,
  monsterData: MonsterData,
  tierLabel: string,
  nearby: NearbyToken[],
  config: TierConfig,
  state: TacticalState,
  currentHpPct: number,
  notes?: string,
  doctrineName?: string,
): string {
  const { strength: strScore, dexterity: dexScore, constitution: conScore,
          intelligence: intScore, wisdom: wisScore, charisma: chaScore } = monsterData;
  const hp = formatHP(Number(token.bar1_value), Number(token.bar1_max));
  const conditions = formatConditions(token.statusmarkers);

  const lines: string[] = [];

  if (currentHpPct <= 0.4) {
    const pct = Math.round(currentHpPct * 100);
    lines.push(
      "[SURVIVAL ALERT]",
      `  HP is at ${pct}% — below the 40% survival threshold. Unless this creature is undead/construct/fanatic or knows it will be hunted if it flees, it should be trying to Disengage and flee.`,
      "",
    );
  }

  if (monsterData.abilitySummary) {
    lines.push("[ABILITIES]", monsterData.abilitySummary, "");
  }

  const doctrine = lookupDoctrine(doctrineName ?? token.name);
  if (doctrine) {
    // Truncate to ~1200 chars to keep context tight
    const snippet = doctrine.length > 1200 ? doctrine.slice(0, 1200) + "…" : doctrine;
    lines.push("[TACTICAL DOCTRINE]", snippet, "");
  }

  lines.push(
    "[CREATURE]",
    `Name: ${token.name}  HP: ${hp}  Conditions: ${conditions}`,
    `STR ${strScore} / DEX ${dexScore} / CON ${conScore} / INT ${intScore} / WIS ${wisScore} / CHA ${chaScore}  Tier: ${tierLabel}`,
  );

  const enemies = nearby.filter(t => t.controlledby !== "").slice(0, config.maxNearbyTokens);
  // Always show nearby allies (capped tighter for low-Int tiers); higher tiers get full picture.
  const allyLimit = config.includeAllies ? config.maxNearbyTokens : 3;
  const allies = nearby.filter(t => t.controlledby === "" && t.id !== token.id).slice(0, allyLimit);

  lines.push("", "[BATTLEFIELD]");
  if (enemies.length === 0 && allies.length === 0) {
    lines.push("  No tokens detected in range.");
  } else {
    for (const e of enemies) {
      lines.push(`  Enemy — ${e.name}: ${formatHP(e.bar1_value, e.bar1_max)}, ${rangeBand(e.distanceFeet)}`);
    }
    if (allies.length > 0) {
      lines.push("  Allies:");
      for (const a of allies) {
        lines.push(`    ${a.name}: ${formatHP(a.bar1_value, a.bar1_max)}, ${rangeBand(a.distanceFeet)}`);
      }
    }
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
  const shortTermPlan = await callAI(MODELS.haiku, null, shortPrompt, 300);
  await onStage?.("short", shortTermPlan);

  const mediumLines = [baseContext, "", "[SHORT-TERM PLAN (THIS TURN)]", shortTermPlan];
  if (state.mediumTermPlan) mediumLines.push("", "[PRIOR MEDIUM-TERM PLAN]", state.mediumTermPlan);
  mediumLines.push("", "[TASK]", `Given the immediate action above, what is ${tokenName}'s tactical plan for the next 2-3 rounds? Consider positioning, resource conservation, focus fire, and contingencies.`);
  const mediumTermPlan = await callAI(MODELS.sonnet, 8000, mediumLines.join("\n"), 1500);
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

  // Opus tier-5 long-term strategy is expensive: fire it at most once per encounter per mob.
  // Skip when a goal already exists AND we're not force-replanning AND the mob is healthy (hp > 50%).
  // This means round 1 pays Opus once to establish the goal; later rounds reuse the stored goal,
  // and we only re-strategize on an explicit forceReplan or when the mob drops to/below half HP.
  const hasUsableGoal = !!state.longTermGoal && !forceReplan && currentHpPct > 0.5;
  const needsLongReplan = !hasUsableGoal;
  let longTermGoal = state.longTermGoal ?? "";

  if (needsLongReplan) {
    const longLines = [
      baseContext, "",
      "[SHORT-TERM PLAN (THIS TURN)]", shortTermPlan, "",
      "[MEDIUM-TERM PLAN (2-3 ROUNDS)]", mediumTermPlan,
    ];
    if (state.longTermGoal && !forceReplan) longLines.push("", "[PRIOR STRATEGIC GOAL]", state.longTermGoal);
    longLines.push("", "[TASK]", `What is ${tokenName}'s overarching strategic goal for this entire encounter? Consider retreat conditions, protecting allies, eliminating priority targets, and leveraging the environment. This goal should guide decisions across many rounds.`);
    longTermGoal = await callAI(MODELS.opus, 16000, longLines.join("\n"), 2000);
    await onStage?.("long", longTermGoal);
  }

  return { shortTermPlan, mediumTermPlan, longTermGoal };
}

// ─── GM Whisper Cards ─────────────────────────────────────────────────────────

type StageLabel = "short" | "medium" | "long";
type OnStage = (stage: StageLabel, content: string) => Promise<void>;

// Escape characters that would break Roll20's &{template:default} parser.
function tmplEsc(s: string): string {
  return s.replace(/\n/g, " · ").replace(/\}\}/g, "]").replace(/\{\{/g, "[");
}

function buildStageCard(
  tokenName: string,
  stage: StageLabel,
  content: string,
  intScore: number,
  wisScore: number,
  tier: number,
  tierLabel: string,
  _nearbyCount: number,
): string {
  const STAGE_ICONS:  Record<StageLabel, string> = { short: "⚡", medium: "📅", long: "🎯" };
  const STAGE_LABELS: Record<StageLabel, string> = { short: "This Turn", medium: "Next 2-3 Rounds", long: "Strategic Goal" };
  const header = tmplEsc(`${tokenName} — ${tierLabel} · Int ${intScore}/Wis ${wisScore}`);
  const body   = tmplEsc(content);
  return `&{template:default} {{name=🧠 ${header}}} {{${STAGE_ICONS[stage]} ${STAGE_LABELS[stage]}=${body}}}`;
}

function buildWhisperCard(
  tokenName: string,
  tier: number,
  tierLabel: string,
  intScore: number,
  wisScore: number,
  _nearbyCount: number,
  shortTermPlan: string,
  mediumTermPlan?: string,
  longTermGoal?: string,
): string {
  const header = tmplEsc(`${tokenName} — ${tierLabel} · Int ${intScore}/Wis ${wisScore}`);
  let out = `&{template:default} {{name=🧠 ${header}}} {{⚡ This Turn=${tmplEsc(shortTermPlan)}}}`;
  if (mediumTermPlan) out += ` {{📅 2-3 Rounds=${tmplEsc(mediumTermPlan)}}}`;
  if (longTermGoal)   out += ` {{🎯 Goal=${tmplEsc(longTermGoal)}}}`;
  return out;
}

// ─── Core Planner (shared by plan_tactics and plan_all_tactics) ───────────────

interface PlanOptions {
  intOverride?: number;
  wisOverride?: number;
  radiusFeet?: number;
  notes?: string;
  forceReplan?: boolean;
  postToChat?: boolean;
  debug?: boolean;
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
  debug?: { baseContext: string; prompt: string; rawResponse: string };
}

// Exported so the live test harness (src/recon/fake-combat-it.ts) can drive a
// specific tier directly (e.g. force tier-5 Opus to verify the adaptive-thinking
// path doesn't 400). Production callers go through the MCP tools / fireTacticsForPage.
export async function internalPlanToken(
  tokenId: string,
  activePage: string,
  opts: PlanOptions,
): Promise<PlanResult> {
  const { intOverride, wisOverride, radiusFeet = 60, notes, forceReplan = false, postToChat = true, debug = false } = opts;

  const token = await roll20.relayCommand<TokenData>({ action: "getTokenById", tokenId });
  if (!token) throw new Error(`Token not found: ${tokenId}`);

  const TACDATA = "TACDATA:";

  // 1. Check gmnotes for cached tactical data (persists across MCP restarts)
  let monsterData: MonsterData | null = null;
  if (token.gmnotes?.startsWith(TACDATA)) {
    try { monsterData = JSON.parse(token.gmnotes.slice(TACDATA.length)); } catch { /* stale */ }
  }

  if (!monsterData) {
    // ── I/O: gather raw inputs from the character sheet (linked tokens) ──
    let sheet: StatResolutionInputs["sheet"];
    if (token.represents) {
      const attrs = await roll20.relayCommand<Record<string, { current: unknown }>>({
        action: "getCharacterAttributes",
        charId: token.represents,
        names: ["npc_strength", "npc_dexterity", "npc_constitution",
                "npc_intelligence", "npc_wisdom", "npc_charisma",
                "strength", "dexterity", "constitution",
                "intelligence", "wisdom", "charisma"],
      });
      const readAttr = (npc: string, pc: string): number => {
        const raw = attrs?.[npc]?.current ?? attrs?.[pc]?.current;
        return (raw !== undefined && raw !== null) ? Number(raw) : 0;
      };

      // Read NPC actions repeating section — if populated, the sheet is our source of truth
      const actionRows = await roll20.relayCommand<Record<string, Record<string, string>>>({
        action: "getRepeatingSection",
        charId: token.represents,
        section: "npcaction",
      }) ?? {};
      const actionLines = Object.values(actionRows)
        .filter(r => r.name)
        .map(r => {
          const desc = r.description || r.desc || "";
          return `  ${r.name}${desc ? `: ${desc.slice(0, 300)}` : ""}`;
        });

      sheet = {
        strength: readAttr("npc_strength", "strength"),
        dexterity: readAttr("npc_dexterity", "dexterity"),
        constitution: readAttr("npc_constitution", "constitution"),
        intelligence: readAttr("npc_intelligence", "intelligence"),
        wisdom: readAttr("npc_wisdom", "wisdom"),
        charisma: readAttr("npc_charisma", "charisma"),
        abilitySummary: actionLines.length > 0 ? `Actions:\n${actionLines.join("\n")}` : "",
      };
    }

    // ── I/O: DDB compendium fallback — only when the sheet had no actions ──
    const sheetHasActions = (sheet?.abilitySummary ?? "").length > 0;
    const ddbData = sheetHasActions ? null : await resolveMonsterData(token.name);

    // ── Pure: run the 4-tier resolution cascade ──
    monsterData = resolveMonsterStats({ intOverride, wisOverride, sheet, ddb: ddbData });

    // Persist to token gmnotes — only if gmnotes is empty or already ours
    if (!token.gmnotes || token.gmnotes.startsWith(TACDATA)) {
      await roll20.relayCommand({
        action: "setTokenProps",
        tokenId,
        props: { gmnotes: TACDATA + JSON.stringify(monsterData) },
      });
    }
  }

  const intScore = intOverride ?? monsterData.intelligence;
  const wisScore = wisOverride ?? monsterData.wisdom;

  const config = resolveTier(intScore, wisScore);
  const scanRadius = awarenessRadius(wisScore, radiusFeet);

  const nearby = await roll20.relayCommand<NearbyToken[]>({
    action: "findTokensInRange",
    centerTokenId: tokenId,
    radiusFeet: scanRadius,
    pageId: activePage,
    layerFilter: "objects",
  }) ?? [];

  const state = getOrCreateState(tokenId, token.name, intScore, wisScore);
  const currentHp = Number(token.bar1_value);
  const maxHp = Number(token.bar1_max);
  const currentHpPct = maxHp > 0 ? currentHp / maxHp : 1;

  const baseContext = buildBaseContext(token, monsterData, config.label, nearby, config, state, currentHpPct, notes, token.name);

  let shortTermPlan = "";
  let mediumTermPlan: string | undefined;
  let longTermGoal: string | undefined;
  let debugPrompt = "";

  if (config.cascade === "none") {
    debugPrompt = `${baseContext}\n\n[TASK]\nIt is ${token.name}'s turn. What should it do right now?`;
    ({ shortTermPlan } = await planSingle(config, baseContext, token.name));
  } else if (config.cascade === "medium") {
    debugPrompt = baseContext;
    ({ shortTermPlan, mediumTermPlan } = await planMediumCascade(baseContext, token.name, state));
    state.mediumTermPlan = mediumTermPlan;
  } else {
    debugPrompt = baseContext;
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
    await roll20.relayCommand({
      action: "setMobPlan",
      tokenId,
      html: card,
      plan: { name: token.name, shortTerm: shortTermPlan, mediumTerm: mediumTermPlan, longGoal: longTermGoal },
    });
    if (rtEnabled()) {
      void rtWriteMobPlan(tokenId, { name: token.name, shortTerm: shortTermPlan, mediumTerm: mediumTermPlan, longGoal: longTermGoal });
    }
  }

  const result: PlanResult = {
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

  if (debug) {
    result.debug = {
      baseContext,
      prompt: debugPrompt,
      rawResponse: [shortTermPlan, mediumTermPlan, longTermGoal].filter(Boolean).join("\n\n---\n\n"),
    };
  }

  return result;
}

// ─── Exported helpers ────────────────────────────────────────────────────────

// Fire tactics planning for every eligible mob on a page — same logic as the
// plan_all_tactics tool but callable internally (e.g., auto-triggered at combat
// start from roll_initiative). Runs in background; whispers arrive as each
// mob's cascading plan completes.
export async function fireTacticsForPage(
  pageId: string,
  opts: { notes?: string; forceReplan?: boolean } = {},
): Promise<void> {
  const allTokens = await roll20.relayCommand<TokenData[]>({ action: "getTokens", pageId }) ?? [];
  const mobs = allTokens.filter((t) =>
    !t.controlledby && t.layer === "objects" && Number(t.bar1_max) > 0,
  );
  if (mobs.length === 0) return;
  await Promise.allSettled(
    mobs.map((mob) =>
      internalPlanToken(mob.id, pageId, {
        notes: opts.notes,
        forceReplan: opts.forceReplan ?? false,
        postToChat: true,
      }),
    ),
  );
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
      debug: z.boolean().default(false).describe("Return raw context, full prompt, and raw model response in the result"),
    },
    async ({ tokenId, intScore: intOverride, wisScore: wisOverride, radiusFeet, pageId, notes, forceReplan, postToChat, debug }) => {
      const activePage = pageId ?? (await roll20.getCurrentPageId());
      const result = await internalPlanToken(tokenId, activePage, { intOverride, wisOverride, radiusFeet, notes, forceReplan, postToChat, debug });
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
        t.layer === "objects" &&
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
