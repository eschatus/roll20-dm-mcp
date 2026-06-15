import Anthropic from "@anthropic-ai/sdk";
import * as roll20 from "./roll20.js";
import * as ddb from "./dndbeyond.js";
import * as characters from "../registry/characters.js";
import { lookupDoctrine, resolveTier, awarenessRadius, rangeBand, MODELS } from "../tools/tactics.js";
import { setPlayerCommandListener, rtEnabled, rtUpdate, type PlayerChatCommand } from "./roll20-rt.js";
import {
  callModel as sharedCallModel,
  extractJson as sharedExtractJson,
  __setAnthropicForTest as llmSetAnthropicForTest,
} from "../llm.js";

// ─── Player chat commands ─────────────────────────────────────────────────────
//
// Players type !tactics / !recall / !recap / !options / !rules in Roll20 chat.
// Detection is transport-side: the RTDB chat subscription (roll20-rt.ts) forwards
// live !-prefixed messages here via setPlayerCommandListener — no Mod redeploy
// needed. Replies go back as whispers through the existing whisperPlayer relay
// action. The GM-only !ai-relay boundary is untouched: players never gain any
// campaign-mutation power, every handler is read-only plus whispers.
//
// Information discipline (table policy):
// - Other creatures' stats are NEVER given as numbers to players — wound state
//   and ranges are qualitative words only.
// - !tactics quality scales with the PC's own Int/Wis via the same tier table
//   the monster tactical AI uses.
// - !rules answers only when confident; otherwise it escalates to the DM
//   (whisper + dmInbox entry) instead of guessing.

const KNOWN_COMMANDS = ["tactics", "recall", "recap", "options", "rules", "help"] as const;
type CommandName = (typeof KNOWN_COMMANDS)[number];

export interface ParsedCommand {
  command: CommandName;
  arg: string;
}

// "!recall Strahd von Zarovich" → { command: "recall", arg: "Strahd von Zarovich" }.
// Unknown commands (Beyond20, other mods, !dm, !ai-relay) → null.
export function parsePlayerCommand(content: string): ParsedCommand | null {
  const m = /^!(\w+)(?:\s+([\s\S]*))?$/.exec(content.trim());
  if (!m) return null;
  const command = m[1].toLowerCase() as CommandName;
  if (!KNOWN_COMMANDS.includes(command)) return null;
  return { command, arg: (m[2] ?? "").trim() };
}

// ─── Cooldowns ────────────────────────────────────────────────────────────────
// Per player per command. Recorded at dispatch (not completion) so a slow
// in-flight !tactics can't be stacked. Mainly a cost guard: high-tier !tactics
// reaches Sonnet/Opus with thinking enabled.

const COOLDOWN_SECONDS: Record<CommandName, number> = {
  tactics: 90,
  recall: 30,
  recap: 60,
  options: 30,
  rules: 45,
  help: 10,
};

const lastUsed = new Map<string, number>();

// Returns remaining cooldown in whole seconds (0 = allowed) and records the use
// when allowed. `now` injectable for tests.
export function cooldownRemaining(playerid: string, command: CommandName, now = Date.now()): number {
  const key = `${playerid}:${command}`;
  const prev = lastUsed.get(key) ?? 0;
  const elapsed = (now - prev) / 1000;
  const limit = COOLDOWN_SECONDS[command];
  if (elapsed < limit) return Math.ceil(limit - elapsed);
  lastUsed.set(key, now);
  return 0;
}

export function __resetCooldownsForTest(): void {
  lastUsed.clear();
}

// ─── Anthropic client (test seam delegates to llm.ts) ────────────────────────
//
// The private callModel and extractJson have moved to src/llm.ts.
// __setAnthropicForTest is kept exported here so existing test imports compile
// and work unchanged — it delegates to the shared llm.ts seam.

export function __setAnthropicForTest(client: Pick<Anthropic, "messages">): void {
  llmSetAnthropicForTest(client);
}

const callModel = sharedCallModel;

// Re-export so existing tests that import extractJson from this module continue
// to work without any test changes.
export const extractJson = sharedExtractJson;

// ─── Global cost guard ────────────────────────────────────────────────────────
//
// Per-player cooldowns (above) are bypassable by spoofing playerid in chat.
// These two global limits enforce a hard ceiling across ALL players:
//   1. Token bucket: max 10 model-calling commands per 60-second sliding window.
//   2. Concurrency cap: max 3 in-flight handlers at once.
// When either fires, the player gets a brief whisper and the handler exits early.
//
// Both guards are implemented as small pure-testable functions using the same
// injectable-clock pattern as cooldownRemaining.

const GLOBAL_BUCKET_MAX = 10;
const GLOBAL_BUCKET_WINDOW_MS = 60_000;
const GLOBAL_MAX_CONCURRENT = 3;

// Sliding-window call timestamps (oldest-first).
let globalBucketTimestamps: number[] = [];
let globalInFlight = 0;

// Returns true if the call is allowed and records it, false if rate-limited.
// `now` is injectable for deterministic tests.
export function globalBucketAllowed(now = Date.now()): boolean {
  // Drop timestamps older than the window.
  const cutoff = now - GLOBAL_BUCKET_WINDOW_MS;
  globalBucketTimestamps = globalBucketTimestamps.filter((t) => t > cutoff);
  if (globalBucketTimestamps.length >= GLOBAL_BUCKET_MAX) return false;
  globalBucketTimestamps.push(now);
  return true;
}

// Returns true if there is room for one more concurrent handler.
export function concurrencyAllowed(): boolean {
  return globalInFlight < GLOBAL_MAX_CONCURRENT;
}

export function __resetGlobalBucketForTest(): void {
  globalBucketTimestamps = [];
  globalInFlight = 0;
}

// ─── Whisper helper ───────────────────────────────────────────────────────────

async function whisper(who: string, message: string): Promise<void> {
  // Quote multi-word display names so the Mod's `/w <name> <msg>` targets correctly.
  const target = who === "gm" || !who.includes(" ") ? who : `"${who}"`;
  await roll20.relayCommand({
    action: "whisperPlayer",
    playerName: target,
    message: message.replace(/\n/g, "<br>"),
  });
}

// ─── PC resolution ────────────────────────────────────────────────────────────

export interface PageToken {
  id: string;
  name: string;
  controlledby?: string;
  represents?: string;
  layer?: string;
  bar1_value?: number | string;
  bar1_max?: number | string;
  statusmarkers?: string;
}

// Find the token this player controls on the player page. "all"-controlled
// tokens are not anyone's PC. With multiple matches (familiars, mounts), prefer
// a token registered in the characters registry.
export function pickPcToken(
  tokens: PageToken[],
  playerid: string,
  isRegistered: (name: string) => boolean,
): PageToken | null {
  const mine = tokens.filter((t) => {
    if ((t.layer ?? "objects") !== "objects") return false;
    const controllers = (t.controlledby ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    return controllers.includes(playerid);
  });
  if (mine.length === 0) return null;
  if (mine.length === 1) return mine[0];
  return mine.find((t) => isRegistered(t.name)) ?? mine[0];
}

async function findPcToken(playerid: string): Promise<PageToken | null> {
  // No pageId → the transport resolves the player page itself.
  const tokens = (await roll20.relayCommand<PageToken[]>({ action: "getTokens" })) ?? [];
  return pickPcToken(tokens, playerid, (name) => characters.lookup(name) !== null);
}

interface PcStats {
  int: number;
  wis: number;
  ddbStats: ddb.DdbCharacterStats | null;
}

async function getPcStats(token: PageToken): Promise<PcStats> {
  const entry = characters.lookup(token.name);
  if (entry) {
    try {
      const s = await ddb.getCharacterStats(entry.ddbCharId);
      return {
        int: s.abilityScores["intelligence"] ?? 10,
        wis: s.abilityScores["wisdom"] ?? 10,
        ddbStats: s,
      };
    } catch {
      // fall through to sheet read
    }
  }
  if (token.represents) {
    try {
      const attrs = await roll20.relayCommand<Record<string, { current: unknown }>>({
        action: "getCharacterAttributes",
        charId: token.represents,
        names: ["intelligence", "wisdom"],
      });
      const num = (v: unknown) => (v !== undefined && v !== null && Number(v) > 0 ? Number(v) : 10);
      return { int: num(attrs?.["intelligence"]?.current), wis: num(attrs?.["wisdom"]?.current), ddbStats: null };
    } catch {
      // fall through to defaults
    }
  }
  return { int: 10, wis: 10, ddbStats: null };
}

// ─── Qualitative wound states (numbers never reach players) ──────────────────

export function woundState(current: number, max: number): string {
  if (max <= 0) return "condition unknown";
  if (current <= 0) return "down";
  const pct = current / max;
  if (pct > 0.9) return "unhurt";
  if (pct > 0.6) return "lightly wounded";
  if (pct > 0.35) return "bloodied";
  if (pct > 0.15) return "badly wounded";
  return "near death";
}

function markersToWords(statusmarkers?: string): string {
  if (!statusmarkers || statusmarkers === "{}") return "";
  const names = statusmarkers.split(",").map((m) => m.split("::")[0]).filter((m) => m && m !== "dead");
  return names.join(", ");
}

// ─── !tactics ─────────────────────────────────────────────────────────────────

const PLAYER_TACTICS_SYSTEM = `You are the battle instincts of a D&D 5e player character — the character's own judgment speaking, not an outside narrator.

VOICE — match the mind tier provided:
- Feral or Dim: one blunt gut instinct. A single short sentence.
- Average: simple, direct advice. 1-2 sentences.
- Sharp: solid tactical reasoning. 2-3 sentences.
- Brilliant or Mastermind: incisive, reads the whole field, up to 4 sentences, may include one contingency.

RULES:
- Use only the information provided. Never invent creatures, abilities, or positions.
- Never state numbers about other creatures — no hit points, armor, or totals. Their condition is given in words; keep it in words.
- Creatures under "OTHERS ON THE FIELD" are not controlled by players — judge friend or foe from their names and the situation.
- Suggest; don't command. The player decides. No dice math, no rules citations.
- Plain text only. No markdown, no lists, no headers.`;

async function handleTactics(cmd: PlayerChatCommand): Promise<void> {
  const token = await findPcToken(cmd.playerid);
  if (!token) {
    await whisper(cmd.who, "🧠 I can't find a token you control on the current page.");
    return;
  }
  await whisper(cmd.who, `🧠 ${token.name} reads the battlefield…`);

  const { int, wis, ddbStats } = await getPcStats(token);
  const tier = resolveTier(int, wis);
  const radius = awarenessRadius(wis, 60);

  interface Nearby {
    id: string; name: string; layer: string; distanceFeet: number;
    bar1_value: number; bar1_max: number; controlledby: string;
  }
  const nearby = (await roll20.relayCommand<Nearby[]>({
    action: "findTokensInRange",
    centerTokenId: token.id,
    radiusFeet: radius,
    layerFilter: "objects",
  })) ?? [];

  const companions = nearby.filter((t) => t.controlledby && t.id !== token.id);
  const others = nearby.filter((t) => !t.controlledby);

  const lines: string[] = [];
  lines.push(`[YOU] ${token.name} — mind tier: ${tier.label}`);
  if (ddbStats) lines.push(`Level ${ddbStats.level} ${ddbStats.classes}, speed ${ddbStats.walkSpeed}ft`);
  const selfHp = Number(token.bar1_value), selfMax = Number(token.bar1_max);
  if (selfMax > 0) lines.push(`Your condition: ${woundState(selfHp, selfMax)}`);
  const selfMarkers = markersToWords(token.statusmarkers);
  if (selfMarkers) lines.push(`Your active effects: ${selfMarkers}`);

  lines.push("", "[COMPANIONS IN VIEW]");
  if (companions.length === 0) lines.push("  none nearby");
  for (const c of companions.slice(0, 8)) {
    lines.push(`  ${c.name}: ${woundState(c.bar1_value, c.bar1_max)}, ${rangeBand(c.distanceFeet)}`);
  }

  lines.push("", "[OTHERS ON THE FIELD]");
  if (others.length === 0) lines.push("  none in view");
  for (const o of others.slice(0, tier.maxNearbyTokens + 4)) {
    lines.push(`  ${o.name}: ${woundState(o.bar1_value, o.bar1_max)}, ${rangeBand(o.distanceFeet)}`);
  }

  lines.push("", "[TASK]", `It is nearly ${token.name}'s turn. What do their instincts say?`);

  // Cap thinking for player calls — interactive latency matters more than depth here.
  const thinking = tier.thinkingBudget !== null ? Math.min(tier.thinkingBudget, 4000) : null;
  const advice = await callModel(tier.model, PLAYER_TACTICS_SYSTEM, lines.join("\n"), Math.min(tier.maxResponseTokens, 400), thinking);
  await whisper(cmd.who, `🧠 ${advice}`);
}

// ─── !recall ──────────────────────────────────────────────────────────────────

const RECALL_CLASSIFY_SYSTEM = `Given a D&D 5e creature name, respond with ONLY a JSON object:
{"skill": "<arcana|history|nature|religion>", "crEstimate": <number>}
Skill follows the usual convention: religion for celestials/fiends/undead; nature for beasts/dragons/fey/giants/monstrosities/oozes/plants; history for humanoids; arcana for aberrations/constructs/elementals and anything magical. crEstimate is your best guess at its challenge rating (use 1 if unknown).`;

const RECALL_LORE_SYSTEM = `You narrate what a D&D 5e character recalls about a creature after a knowledge check. Second person ("You recall…"). Plain text, no markdown.
- NEVER include numbers or game-mechanical values — no AC, HP, DCs, damage dice, or modifiers. Everything qualitative ("notoriously hard to wound", "recoils from running water").
- Only well-established lore for this creature; invent nothing novel.
Result bands:
- vague: at most 2 sentences of common folklore — possibly including one small inaccuracy a tavern storyteller might believe. No weaknesses, no tactics.
- solid: 3-4 sentences. Real traits, defenses, and dangers, in words.
- expert: 4-5 sentences. Everything in solid, plus how it tends to fight and how seasoned hunters exploit it.`;

// "1/2" → 0.5, "5" → 5. DC = 10 + floor(CR/2), clamped to a sane band.
export function crToDc(cr: string | number | undefined): number {
  let n = 1;
  if (typeof cr === "number") n = cr;
  else if (typeof cr === "string" && cr.trim()) {
    const frac = /^(\d+)\s*\/\s*(\d+)$/.exec(cr.trim());
    n = frac ? Number(frac[1]) / Number(frac[2]) : Number(cr);
    if (!isFinite(n)) n = 1;
  }
  return Math.max(10, Math.min(22, 10 + Math.floor(n / 2)));
}

const SKILL_ABILITY: Record<string, "intelligence" | "wisdom"> = {
  arcana: "intelligence", history: "intelligence", nature: "intelligence", religion: "intelligence",
};

async function handleRecall(cmd: PlayerChatCommand, arg: string): Promise<void> {
  if (!arg) {
    await whisper(cmd.who, "📖 Usage: !recall <creature name> — e.g. !recall vampire spawn");
    return;
  }
  const token = await findPcToken(cmd.playerid);
  if (!token) {
    await whisper(cmd.who, "📖 I can't find a token you control on the current page.");
    return;
  }
  const creature = arg.replace(/\s+\d+$/, ""); // "Zombie 3" → "Zombie"

  // Which knowledge skill applies + a CR guess (used only if DDB has no entry).
  const classifyRaw = await callModel(MODELS.haiku, RECALL_CLASSIFY_SYSTEM, creature, 100);
  const classify = extractJson(classifyRaw);
  const skill = String(classify?.skill ?? "arcana").toLowerCase();

  let dc = crToDc(classify?.crEstimate as number | undefined);
  let abilitySummary = "";
  try {
    const monster = await ddb.getMonster(creature);
    dc = crToDc(monster.challengeRating);
    abilitySummary = ddb.getMonsterAbilities(monster);
  } catch {
    // homebrew/renamed — model lore only
  }
  const doctrine = lookupDoctrine(creature);

  const { int, wis, ddbStats } = await getPcStats(token);
  const abilityMod = Math.floor(((SKILL_ABILITY[skill] === "wisdom" ? wis : int) - 10) / 2);
  const bonus = ddbStats?.skills[skill]?.bonus ?? abilityMod;

  const skillLabel = skill.charAt(0).toUpperCase() + skill.slice(1);
  const sign = bonus >= 0 ? "+" : "";
  const rolls = await roll20.relayCommand<{ total: number; error?: string }[]>({
    action: "rollFormulas",
    items: [{ label: `${token.name} — ${skillLabel} (recall: ${creature})`, formula: `1d20${sign}${bonus}` }],
    speakAs: token.name,
    silent: false,
  });
  const total = rolls?.[0]?.total;
  if (total === undefined || rolls?.[0]?.error) {
    await whisper(cmd.who, "📖 The dice failed to land — try again.");
    return;
  }

  const band = total >= dc + 5 ? "expert" : total >= dc ? "solid" : "vague";
  const loreLines = [
    `Creature: ${creature}`,
    `Result band: ${band}`,
    abilitySummary ? `[STAT FACTS — translate to qualitative words]\n${abilitySummary.slice(0, 1500)}` : "",
    doctrine ? `[TACTICAL DOCTRINE — expert band only]\n${doctrine.slice(0, 1000)}` : "",
  ].filter(Boolean);
  const lore = await callModel(
    band === "vague" ? MODELS.haiku : MODELS.sonnet,
    RECALL_LORE_SYSTEM,
    loreLines.join("\n\n"),
    350,
  );
  await whisper(cmd.who, `📖 ${lore}`);
}

// ─── !recap ───────────────────────────────────────────────────────────────────

export interface ChatEntry {
  who: string;
  type: string;
  content: string;
  inlinerolls?: { expression: string; total: number | null }[];
  timestamp: number;
}

const RECAP_NOISE_WHO = new Set(["GM-AI-Bridge", "The Bones"]);
const RECAP_NOISE_TYPES = new Set(["rollresult", "gmrollresult", "whisper", "api"]);

// Keep narration and declarations; drop dice mechanics, templates, and bridge noise.
export function filterRecapEntries(entries: ChatEntry[]): ChatEntry[] {
  return entries.filter((e) => {
    if (RECAP_NOISE_TYPES.has(e.type)) return false;
    if (RECAP_NOISE_WHO.has(e.who)) return false;
    const text = (e.content ?? "").trim();
    if (!text || text.startsWith("&{template")) return false;
    // Pure inline-roll spam: nothing left once roll markup is stripped
    if (!text.replace(/\$\[\[\d+\]\]|\[\[[^\]]*\]\]/g, "").trim()) return false;
    return true;
  });
}

const RECAP_SYSTEM = `You summarize recent D&D table chat for a player who lost track. Write 3-5 short lines, each starting with "•". Only meaningful events: actions taken, narration, kills, discoveries, declarations. Never mention dice values, totals, or numbers. Plain text, no markdown beyond the bullets.`;

async function handleRecap(cmd: PlayerChatCommand): Promise<void> {
  const raw = (await roll20.relayCommand<ChatEntry[]>({ action: "getRecentChat", limit: 80 })) ?? [];
  const meaningful = filterRecapEntries(raw).slice(-40);
  if (meaningful.length === 0) {
    await whisper(cmd.who, "📜 Nothing notable has happened recently.");
    return;
  }
  const transcript = meaningful
    .map((e) => `${e.who}: ${e.content.slice(0, 300)}`)
    .join("\n");
  const summary = await callModel(MODELS.haiku, RECAP_SYSTEM, transcript, 300);
  await whisper(cmd.who, `📜 Recently:\n${summary}`);
}

// ─── !options ─────────────────────────────────────────────────────────────────

const OPTIONS_SYSTEM = `You are a D&D 5e action-economy reminder. Given a character's class, level, and known facts, list what they can typically do on a turn. Use exactly this shape, plain text:
Action: <options, comma-separated>
Bonus: <options, or — if none>
Reaction: <options>
Move: <speed>
Stick to standard options for the class/level plus the abilities listed. Invent no items or spells that aren't implied. Max 90 words.`;

// Defensive extraction from the raw DDB character blob — every field optional.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function extractDdbOptionFacts(raw: any): { slots: string[]; abilities: string[]; weapons: string[] } {
  const slots: string[] = [];
  for (const s of [...(raw?.spellSlots ?? []), ...(raw?.pactMagic ?? [])]) {
    const total = Number(s?.available ?? 0);
    if (total > 0) slots.push(`L${s.level}: ${Math.max(0, total - Number(s?.used ?? 0))}/${total} remaining`);
  }
  const abilities: string[] = [];
  for (const group of ["race", "class", "feat"]) {
    for (const a of raw?.actions?.[group] ?? []) {
      if (a?.name) abilities.push(String(a.name));
    }
  }
  const weapons: string[] = [];
  for (const item of raw?.inventory ?? []) {
    if (item?.equipped && item?.definition?.filterType === "Weapon" && item?.definition?.name) {
      weapons.push(String(item.definition.name));
    }
  }
  return { slots, abilities: abilities.slice(0, 15), weapons: weapons.slice(0, 6) };
}

async function handleOptions(cmd: PlayerChatCommand): Promise<void> {
  const token = await findPcToken(cmd.playerid);
  if (!token) {
    await whisper(cmd.who, "⚔️ I can't find a token you control on the current page.");
    return;
  }
  const entry = characters.lookup(token.name);
  if (!entry) {
    await whisper(cmd.who, `⚔️ ${token.name} isn't linked to a D&D Beyond sheet — ask the DM to register it.`);
    return;
  }
  const stats = await ddb.getCharacterStats(entry.ddbCharId);
  const rawChar = await ddb.getRawCharacter(entry.ddbCharId).catch(() => null);
  const facts = rawChar ? extractDdbOptionFacts(rawChar) : { slots: [], abilities: [], weapons: [] };

  const lines = [
    `Character: ${stats.name}, level ${stats.level} ${stats.classes}`,
    `Speed: ${stats.walkSpeed}ft`,
    facts.weapons.length ? `Equipped weapons: ${facts.weapons.join(", ")}` : "",
    facts.abilities.length ? `Special abilities: ${facts.abilities.join(", ")}` : "",
    facts.slots.length ? `Spell slots: ${facts.slots.join("; ")}` : "",
    stats.conditions.length ? `Active conditions: ${stats.conditions.join(", ")}` : "",
  ].filter(Boolean);

  const reminder = await callModel(MODELS.haiku, OPTIONS_SYSTEM, lines.join("\n"), 250);
  await whisper(cmd.who, `⚔️ ${reminder}`);
}

// ─── !rules ───────────────────────────────────────────────────────────────────

const RULES_SYSTEM = `You are a D&D 5e (2014 rules) reference. Answer the player's rules question.

Respond with ONLY a JSON object, no other text. Either:
{"confident": true, "answer": "<concise answer, max 100 words, plain text>", "citation": "<source, e.g. PHB ch. 9, 'Moving Around Other Creatures'>"}
or, if the question is ambiguous, edition- or table-dependent, contested between sources, about this specific campaign, or you are not certain:
{"confident": false, "reason": "<one line why>"}

Be conservative — when in doubt, confident=false. House rules and DM rulings always override printed rules.`;

async function handleRules(cmd: PlayerChatCommand, arg: string): Promise<void> {
  if (!arg) {
    await whisper(cmd.who, "⚖️ Usage: !rules <question> — e.g. !rules does opportunity attack trigger on teleport?");
    return;
  }
  const raw = await callModel(MODELS.sonnet, RULES_SYSTEM, arg, 500);
  const parsed = extractJson(raw);

  if (parsed?.confident === true && typeof parsed.answer === "string") {
    const citation = typeof parsed.citation === "string" && parsed.citation ? ` — ${parsed.citation}` : "";
    await whisper(cmd.who, `⚖️ ${parsed.answer}${citation}\n(Unofficial — the DM's ruling prevails.)`);
    return;
  }

  // Low confidence → escalate to the DM rather than guess.
  const reason = typeof parsed?.reason === "string" ? parsed.reason : "couldn't answer with confidence";
  await whisper(cmd.who, "⚖️ Good question — that one needs the DM. I've passed it along.");
  await whisper("gm", `❓ Rules question from ${cmd.who}: "${arg}" (assistant unsure: ${reason})`);
  if (rtEnabled()) {
    const key = `rq-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    await rtUpdate("aibridge/dmInbox", {
      [key]: { who: cmd.who, playerid: cmd.playerid, content: `[rules] ${arg}`, type: "query", timestamp: Date.now() },
    }).catch(() => {});
  }
}

// ─── !help ────────────────────────────────────────────────────────────────────

const HELP_TEXT = [
  "❔ Player commands (replies are whispered to you):",
  "!tactics — read the battlefield through your character's eyes",
  "!recall <creature> — what does your character know about it? (rolls a knowledge check)",
  "!options — quick reminder of your action economy",
  "!recap — short summary of recent events",
  "!rules <question> — quick 5e rules lookup (DM's ruling always prevails)",
  "!dm <note or question> — leave a note for the DM's assistant",
].join("\n");

// ─── Dispatcher ───────────────────────────────────────────────────────────────

export async function handlePlayerCommand(cmd: PlayerChatCommand): Promise<void> {
  const parsed = parsePlayerCommand(cmd.content);
  if (!parsed) return; // not one of ours (Beyond20 etc.)

  const wait = cooldownRemaining(cmd.playerid, parsed.command);
  if (wait > 0) {
    await whisper(cmd.who, `⏳ Easy — !${parsed.command} again in ${wait}s.`).catch(() => {});
    return;
  }

  // Global cost guards (apply to all model-calling commands; !help is free).
  if (parsed.command !== "help") {
    if (!concurrencyAllowed()) {
      await whisper(cmd.who, "⏳ The assistant is busy — try again shortly.").catch(() => {});
      return;
    }
    if (!globalBucketAllowed()) {
      await whisper(cmd.who, "⏳ The assistant is busy — try again shortly.").catch(() => {});
      return;
    }
  }

  console.error(`[player-commands] !${parsed.command} from ${cmd.who}${parsed.arg ? ` (${parsed.arg})` : ""}`);
  globalInFlight++;
  try {
    switch (parsed.command) {
      case "tactics": await handleTactics(cmd); break;
      case "recall": await handleRecall(cmd, parsed.arg); break;
      case "recap": await handleRecap(cmd); break;
      case "options": await handleOptions(cmd); break;
      case "rules": await handleRules(cmd, parsed.arg); break;
      case "help": await whisper(cmd.who, HELP_TEXT); break;
    }
  } catch (err) {
    console.error(`[player-commands] !${parsed.command} failed:`, err);
    await whisper(cmd.who, `⚠️ Couldn't complete !${parsed.command} — tell the DM if it keeps happening.`).catch(() => {});
  } finally {
    if (parsed.command !== "help") globalInFlight--;
  }
}

// Composition-root entry point (index-http.ts). Registers with the RTDB chat
// subscription; actual delivery starts once startRtdbSubscriptions() connects.
export function initPlayerCommands(): void {
  setPlayerCommandListener((cmd) => { void handlePlayerCommand(cmd); });
  console.error("[player-commands] registered: " + KNOWN_COMMANDS.map((c) => "!" + c).join(" "));
}
