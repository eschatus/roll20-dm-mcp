// Stateful tool-loop harness. Unlike eval-tools.ts (single-shot, shape only), this plays a
// THREADED combat scenario: one conversation, a persistent in-memory Board, the agent's tool calls
// routed to a stub that MUTATES the board and feeds realistic results back, looping until the model
// stops calling tools. Grades on BOARD EFFECT (did the ogre's bar drop? PC bar untouched + PCHP
// tracked? web created then cleared? token advanced?) — not just the call shape.
//
//   Terminal 1: npm run serve      (combat server, for the real tool schemas the model sees)
//   Terminal 2: npm run eval:arc
//
// State model mirrors the real distribution (see rt-helpers.ts): NPC HP on bar1, PC HP in the
// %%PCHP%% gmnotes block, conditions in statusmarkers, turn order + zones their own objects. No
// Roll20 is touched — execution is fully stubbed.

import * as path from "path";
import * as dotenv from "dotenv";
import Ajv, { ValidateFunction } from "ajv";
import { McpRoll20 } from "../src/mcp";
import { buildSystemPrompt, buildTurnContext } from "../src/persona";
import { AnthropicProvider } from "../src/llm/anthropic";
import { OllamaProvider } from "../src/llm/ollama";
import { LLMProvider, ToolSpec } from "../src/llm/provider";
import { CONFIG } from "../src/config";
import { decideTerminal, isMutatingTool, LoopMode } from "../src/loop-policy";

dotenv.config({ path: path.join(__dirname, "..", "..", ".env") });
dotenv.config({ path: path.join(__dirname, "..", ".env") });
dotenv.config({ path: path.join(__dirname, "..", "data", ".env") });

// Routes through the gem's LLMProvider abstraction → swap Anthropic ↔ local Ollama/Qwen with a
// flag, testing the SAME tuned prompt + tool path on each. DMW_EVAL_PROVIDER=ollama to go local.
const PROVIDER = process.env.DMW_EVAL_PROVIDER || "anthropic";
const MODEL = process.env.DMW_EVAL_MODEL || (PROVIDER === "ollama" ? "qwen2.5:14b-instruct" : "claude-haiku-4-5");
const REPS = Number(process.env.DMW_EVAL_REPS) || 3;
const MAX_STEPS = 6;
// Mirror the live agent's terminal policy so the harness measures the SAME loop.
// DMW_AGENTIC_LOOP=off|nudge|full — compare correctness/latency/nudge-cost across modes.
const MODE = (process.env.DMW_AGENTIC_LOOP || "off") as LoopMode;
const makeProvider = (): LLMProvider => PROVIDER === "ollama" ? new OllamaProvider(MODEL, CONFIG.ollamaUrl) : new AnthropicProvider(MODEL);

// Real-schema validators (the -32602 boundary). Populated in main() from the served
// tool schemas; consulted in playthrough BEFORE the stub so a malformed call (string
// number, stringified array, wrong param name) fails faithfully instead of being
// silently coerced by the stub — the blind spot that hid the 0.1.5 live failures.
const ajv = new Ajv({ strict: false, allErrors: true });
const validators = new Map<string, ValidateFunction>();

// ── Board model ──────────────────────────────────────────────────────────────
interface Tok {
  id: string; name: string; controlledby: string; // non-empty = PC
  bar1_value: number; bar1_max: number; statusmarkers: string; gmnotes: string;
  layer: string; left: number; top: number;
}
interface Board { tokens: Tok[]; turnorder: { id: string; pr: string }[]; zones: { name: string }[]; chat: string[] }

// Minimal mirror of rt-helpers.ts PCHP encoding (the single source of truth for PC HP lives in
// the token's gmnotes; bar1 is Beyond20's and must never be written for a PC).
const PCHP_RE = /%%PCHP=({[\s\S]*?})%%/;
const writePcHp = (gm: string, e: { current: number; max: number; name: string }) =>
  (gm.replace(PCHP_RE, "").trim() + ` %%PCHP=${JSON.stringify({ ...e, updated: 0 })}%%`).trim();
const readPcHp = (gm: string): { current: number; max: number } | null => {
  const m = gm.match(PCHP_RE); if (!m) return null; try { return JSON.parse(m[1]); } catch { return null; }
};

function seedBoard(): Board {
  const mk = (name: string, hp: number, pc: boolean, x: number): Tok => ({
    id: "tok-" + name.replace(/\s+/g, ""), name, controlledby: pc ? "player1" : "",
    bar1_value: hp, bar1_max: hp, statusmarkers: "", layer: "objects", left: x * 70, top: 350,
    gmnotes: pc ? writePcHp("", { current: hp, max: hp, name }) : "",
  });
  const tokens = [
    mk("Thorne", 40, true, 5), mk("Ogre", 59, false, 8),
    mk("Goblin A", 7, false, 10), mk("Goblin B", 7, false, 11),
    mk("Goblin C", 7, false, 12), mk("Goblin D", 7, false, 13),
  ];
  return { tokens, turnorder: tokens.map((t, i) => ({ id: t.id, pr: String(20 - i) })), zones: [], chat: [] };
}

const find = (b: Board, n: unknown) => b.tokens.find((t) => t.name.toLowerCase() === String(n ?? "").toLowerCase());
const isPc = (t: Tok) => !!t.controlledby;
const rollFormula = (f: unknown): number => {
  const m = String(f ?? "").replace(/\s/g, "").match(/^(\d*)d(\d+)([+-]\d+)?$/i);
  if (!m) return parseInt(String(f)) || 0;
  let total = parseInt(m[3] || "0"); const n = parseInt(m[1] || "1"), faces = parseInt(m[2]);
  for (let i = 0; i < n; i++) total += 1 + Math.floor(Math.random() * faces);
  return total;
};
const rosterFromBoard = (b: Board) =>
  "PCs (player-controlled):\n" + b.tokens.filter(isPc).map((t) => `- ${t.name}`).join("\n") +
  "\nOTHER TOKENS (NPCs):\n" + b.tokens.filter((t) => !isPc(t)).map((t) => `- ${t.name}`).join("\n");

// ── Stub executor: mutate the board, return a realistic result string ────────
function stubExec(name: string, a: Record<string, unknown>, b: Board): string {
  const dmg = (t: Tok, amount: number, heal = false) => {
    if (isPc(t)) { const h = readPcHp(t.gmnotes)!; const nv = Math.max(0, Math.min(h.max, h.current + (heal ? amount : -amount))); t.gmnotes = writePcHp(t.gmnotes, { ...h, current: nv }); return `${t.name} ${nv}/${h.max} (tracked)`; }
    t.bar1_value = Math.max(0, Math.min(t.bar1_max, t.bar1_value + (heal ? amount : -amount))); return `${t.name} ${t.bar1_value}/${t.bar1_max}`;
  };
  switch (name) {
    case "list_tokens": return JSON.stringify(b.tokens.map((t) => ({ id: t.id, name: t.name, controlledby: t.controlledby, layer: t.layer, hp: `${t.bar1_value}/${t.bar1_max}`, statusmarkers: t.statusmarkers })));
    case "get_token": { const t = find(b, a.characterName) || b.tokens.find((x) => x.id === a.tokenId); return t ? JSON.stringify({ ...t }) : "not found"; }
    case "get_turn_order": return JSON.stringify(b.turnorder.map((e) => ({ ...e, name: b.tokens.find((t) => t.id === e.id)?.name })));
    case "get_token_markers": return JSON.stringify({ reserved: [], available: [] });
    case "list_zones": return JSON.stringify(b.zones);
    case "find_tokens_in_range": return JSON.stringify(b.tokens.filter((t) => !isPc(t)).map((t) => t.name));
    case "update_token_hp": {
      const t = find(b, a.characterName); if (!t) return "token not found";
      if (a.damage != null) return dmg(t, Number(a.damage));
      if (a.heal != null) return dmg(t, Number(a.heal), true);
      if (a.setHp != null) { if (isPc(t)) { const h = readPcHp(t.gmnotes)!; t.gmnotes = writePcHp(t.gmnotes, { ...h, current: Number(a.setHp) }); return `${t.name} ${a.setHp} (tracked)`; } t.bar1_value = Number(a.setHp); return `${t.name} ${t.bar1_value}/${t.bar1_max}`; }
      return "no hp op";
    }
    case "update_hp_many": {
      const names = (a.names as string[]) || b.tokens.filter((t) => a.nameMatch && t.name.toLowerCase().includes(String(a.nameMatch).toLowerCase())).map((t) => t.name);
      return names.map((n) => { const t = find(b, n); return t ? dmg(t, Number(a.damage ?? a.heal ?? 0), a.heal != null) : `${n}?`; }).join(", ");
    }
    case "set_token_marker": {
      const t = find(b, a.characterName) || b.tokens.find((x) => x.id === a.tokenId); if (!t) return "token not found";
      const cond = String(a.condition).toLowerCase(); const set = new Set(t.statusmarkers.split(",").filter(Boolean));
      if (a.active === true) set.add(cond); else set.delete(cond); t.statusmarkers = [...set].join(",");
      return `${t.name}: ${cond} ${a.active ? "applied" : "cleared"}`;
    }
    case "kill_token": {
      const t = find(b, a.characterName) || b.tokens.find((x) => x.id === a.tokenId); if (!t) return "token not found";
      const set = new Set(t.statusmarkers.split(",").filter(Boolean)); set.add("dead"); t.statusmarkers = [...set].join(",");
      t.layer = "map";
      return `${t.name} marked dead + moved to map layer`;
    }
    case "resolve_aoe": {
      const targets = (a.targetNames as string[]) || b.tokens.filter((t) => !isPc(t)).map((t) => t.name);
      const roll = rollFormula(a.damageFormula); const heal = a.healing === true;
      const lines = targets.map((n) => { const t = find(b, n); if (!t) return `${n}?`; if (isPc(t) && !heal) return `${t.name}: roll your save`; return dmg(t, heal ? roll : roll, heal); });
      return `${a.label ?? "AoE"} (${heal ? "heal" : "dmg"} ${roll}): ` + lines.join("; ");
    }
    case "create_zone": b.zones.push({ name: String(a.name) }); return `zone "${a.name}" created`;
    case "clear_zone": { const before = b.zones.length; b.zones = b.zones.filter((z) => z.name.toLowerCase() !== String(a.name).toLowerCase()); return b.zones.length < before ? `zone "${a.name}" cleared` : `no zone "${a.name}"`; }
    case "advance_turn": { const e = b.turnorder.shift(); if (e) b.turnorder.push(e); const cur = b.tokens.find((t) => t.id === b.turnorder[0]?.id); return `advanced — now ${cur?.name ?? "?"}`; }
    case "set_token_props": {
      const t = find(b, a.characterName) || b.tokens.find((x) => x.id === a.tokenId) || find(b, a.tokenId); if (!t) return "token not found";
      if (a.layer != null) t.layer = String(a.layer);
      return `${t.name} props set`;
    }
    case "roll_dice": { const rolls = (a.rolls as { label: string; formula: string }[]) || []; return rolls.map((r) => `${r.label}: ${rollFormula(r.formula)}`).join("; ") || "rolled"; }
    case "send_narration": b.chat.push(String(a.text ?? "")); return "(narrated)";
    case "batch_exec": return "(batch applied)";
    case "roll_initiative": return "(initiative rolled)";
    case "plan_all_tactics": case "get_mob_plans": return "(tactics ready)";
    default: return `(stub: ${name} ok)`;
  }
}

// ── Scenario: the Phase-5 arc, incl. the stateful "Fireball clears the Web" + a death ───────────
interface Step { utterance: string; expect?: string; check: (b: Board) => string | null } // returns failure reason or null
const SCENARIO: Step[] = [
  { utterance: "The ogre takes 20 from Thorne's maul.", expect: "update_token_hp",
    check: (b) => find(b, "Ogre")!.bar1_value === 39 ? null : `ogre bar1=${find(b, "Ogre")!.bar1_value}, expected 39` },
  { utterance: "Thorne takes 12 slashing from the ogre.", expect: "update_token_hp",
    check: (b) => { const t = find(b, "Thorne")!; return t.bar1_value === 40 && readPcHp(t.gmnotes)?.current === 28 ? null : `Thorne bar1=${t.bar1_value} (want 40, untouched), PCHP=${readPcHp(t.gmnotes)?.current} (want 28)`; } },
  { utterance: "Thorne is poisoned.", expect: "set_token_marker",
    check: (b) => find(b, "Thorne")!.statusmarkers.includes("poisoned") ? null : "no poisoned marker on Thorne" },
  { utterance: "Web fills the doorway — a 20-ft cube.", expect: "create_zone",
    check: (b) => b.zones.some((z) => /web/i.test(z.name)) ? null : "no Web zone" },
  { utterance: "Fireball on the goblins — 8d6 fire, DEX save DC 15, half on save — and the blast burns the web away.", expect: "resolve_aoe",
    check: (b) => { const burned = !b.zones.some((z) => /web/i.test(z.name)); const hurt = find(b, "Goblin A")!.bar1_value < 7; return burned && hurt ? null : `web ${burned ? "gone" : "STILL UP"}, goblinA hp=${find(b, "Goblin A")!.bar1_value}`; } },
  { utterance: "The ogre drops.", expect: "kill_token",
    check: (b) => { const t = find(b, "Ogre")!; return t.statusmarkers.includes("dead") && t.layer === "map" ? null : `dead=${t.statusmarkers.includes("dead")}, layer=${t.layer} (want map)`; } },
  { utterance: "Next turn.", expect: "advance_turn",
    check: (b) => b.turnorder[0].id !== "tok-Thorne" ? null : "turn did not advance" },
];

// ── One threaded playthrough ─────────────────────────────────────────────────
interface StepResult { ok: boolean; ms: number; calls: number; nudges: number }
async function playthrough(system: string, toolSpecs: ToolSpec[]): Promise<StepResult[]> {
  const board = seedBoard();
  const llm = makeProvider();
  llm.start(system, toolSpecs);
  const steps: StepResult[] = [];

  for (const step of SCENARIO) {
    llm.pushUser(buildTurnContext(rosterFromBoard(board)) + "\n\n" + step.utterance);
    const calls: string[] = [];
    const t0 = Date.now(); let apiCalls = 0, nudges = 0;
    // Mirror agent.ts runTurn terminal bookkeeping.
    let mutationsThisTurn = 0, nudgedAlready = false, completenessCheckedAlready = false;
    for (let s = 0; s < MAX_STEPS + 2; s++) {
      const turn = await llm.run(); apiCalls++;
      if (turn.toolCalls.length === 0) {
        const action = decideTerminal({ transcript: step.utterance, mutationsThisTurn, nudgedAlready, completenessCheckedAlready, mode: MODE });
        if (action.kind === "done") break;
        if (action.tag === "persist") nudgedAlready = true; else completenessCheckedAlready = true;
        nudges++;
        llm.pushContinue(action.text);
        continue;
      }
      llm.pushToolResults(turn.toolCalls.map((c) => {
        calls.push(c.name);
        if (isMutatingTool(c.name)) mutationsThisTurn++;
        // FAITHFUL boundary: validate against the real tool schema before executing,
        // exactly like the MCP server (-32602). No coercion — a "39" or stringified
        // array fails here as it does live, instead of the stub Number()-ing it away.
        const val = validators.get(c.name);
        if (val && !val(c.args)) {
          return { id: c.id, name: c.name, content: `MCP error -32602: Input validation error: ${ajv.errorsText(val.errors, { separator: "; " })}` };
        }
        return { id: c.id, name: c.name, content: stubExec(c.name, c.args, board) };
      }));
    }
    const ms = Date.now() - t0;
    const why = step.check(board);
    const pass = why === null && (!step.expect || calls.includes(step.expect));
    steps.push({ ok: pass, ms, calls: apiCalls, nudges });
    console.log(`  ${pass ? "✓" : "✗"} ${String(ms).padStart(6)}ms ${apiCalls}c${nudges ? `+${nudges}↻` : "  "}  "${step.utterance.slice(0, 40)}…"  [${calls.join(",") || "none"}]${pass ? "" : "  ⚠ " + (why || `expected ${step.expect}`)}`);
  }
  return steps;
}

async function main() {
  if (PROVIDER === "anthropic" && !process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not set");
  const mcp = new McpRoll20();
  const tools = await mcp.connect();
  // Compile a validator per served tool from its real JSON schema (the -32602 contract).
  for (const t of tools) { try { validators.set(t.name, ajv.compile(t.inputSchema)); } catch { /* unschemable — skip */ } }
  // Mirror the gem: it now sends the FULL cloud allowlist every turn (no phase scoping).
  const SCOPE = process.env.DMW_EVAL_SCOPE || "lean";
  let allow: Set<string> | null = null;
  if (SCOPE !== "full") {
    allow = new Set(CONFIG.cloudToolAllowlist);
    // Mirror the agent: Ollama gets cloud ∩ LOCAL_TOOLS so the small model isn't drowned in schemas.
    if (PROVIDER === "ollama") { const local = new Set(CONFIG.localToolAllowlist); allow = new Set([...allow].filter((t) => local.has(t))); }
  }
  const toolSpecs: ToolSpec[] = tools.filter((t) => !allow || allow.has(t.name)).map((t) => ({ name: t.name, description: t.description, parameters: t.inputSchema }));
  console.log(`Connected — ${tools.length} served, ${toolSpecs.length} sent (scope=${SCOPE}). provider=${PROVIDER} model=${MODEL}, loop=${MODE}, ${SCENARIO.length} steps × ${REPS}\n`);
  const system = buildSystemPrompt("anthropic"); // the tuned prompt — identical for every model

  const perStep = SCENARIO.map(() => 0);
  const turnMs: number[] = [];
  let totalNudges = 0;
  const wall0 = Date.now();
  for (let r = 0; r < REPS; r++) {
    console.log(`── playthrough ${r + 1} ──`);
    const steps = await playthrough(system, toolSpecs);
    steps.forEach((s, i) => { if (s.ok) perStep[i]++; turnMs.push(s.ms); totalNudges += s.nudges; });
  }
  const wallMs = Date.now() - wall0;
  await mcp.close();

  const sorted = [...turnMs].sort((a, b) => a - b);
  const mean = turnMs.reduce((a, b) => a + b, 0) / turnMs.length;
  const median = sorted[Math.floor(sorted.length / 2)];
  const p90 = sorted[Math.floor(sorted.length * 0.9)];

  console.log("\n──────── SUMMARY ────────  " + PROVIDER + "/" + MODEL);
  const pct = (n: number) => ((n / REPS) * 100).toFixed(0) + "%";
  SCENARIO.forEach((s, i) => console.log(`  ${perStep[i]}/${REPS} ${pct(perStep[i]).padStart(4)}  ${s.utterance.slice(0, 50)}`));
  const totalPass = perStep.reduce((a, b) => a + b, 0), totalSteps = SCENARIO.length * REPS;
  console.log(`\n  ARC CORRECT:      ${totalPass}/${totalSteps} (${((totalPass / totalSteps) * 100).toFixed(0)}%) — board-verified`);
  console.log(`  PER-TURN LATENCY: mean ${mean.toFixed(0)}ms · median ${median}ms · p90 ${p90}ms  (n=${turnMs.length})`);
  console.log(`  PERSISTENCE:      loop=${MODE}, ${totalNudges} re-prompt${totalNudges === 1 ? "" : "s"} over ${totalSteps} turns (${((totalNudges / totalSteps) * 100).toFixed(0)}% — extra-call cost / false-nudge watch)`);
  console.log(`  total wall: ${(wallMs / 1000).toFixed(1)}s`);
}

main().catch((e) => { console.error(e); process.exit(1); });
