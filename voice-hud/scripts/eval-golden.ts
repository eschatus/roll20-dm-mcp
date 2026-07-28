// Golden-pairs harness — the DM-calibrated conventions as a stateful eval.
//
// Source of truth: docs/table-mechanics-golden-pairs.md (2026-07-28 calibration with the
// DM). Same skeleton as eval-arc.ts (threaded conversation, in-memory Board, stubbed
// execution behind the real -32602 schema boundary), but the board models the calibrated
// table physics: THREE token classes (pc / sidekick / npc — the stub routes HP by class,
// i.e. it simulates the #132-fixed server; the eval grades the MODEL's behavior), token
// auras, zone replacement, and gem-initiated micro-questions.
//
// What each step tests is the CONVENTION, not just the call:
//   bloodied = threshold automation (and only that) · negative space (no tool for flavor
//   clauses) · zone transitions as delete+create · round-boundary expiry · retcon as
//   compensating delta · stated outcomes override arithmetic (fudge-respect) · sidekicks
//   die like NPCs, true PCs get the dying state · revival = absolute-set + unconscious
//   off + prone stays · concentration micro-question then teardown cascade on "Failed."
//
//   Terminal 1: npm run serve      (combat server, for the real tool schemas)
//   Terminal 2: npm run eval:golden
//
// Expect a LOW baseline until issues #132–#136 land — that is the point: this suite is
// the acceptance test for that work and the regression floor afterward.

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

const PROVIDER = process.env.DMW_EVAL_PROVIDER || "anthropic";
const MODEL = process.env.DMW_EVAL_MODEL || (PROVIDER === "ollama" ? "qwen2.5:14b-instruct" : "claude-haiku-4-5");
const REPS = Number(process.env.DMW_EVAL_REPS) || 3;
const MAX_STEPS = 6;
const MODE = (process.env.DMW_AGENTIC_LOOP || "nudge") as LoopMode; // production default
const makeProvider = (): LLMProvider => PROVIDER === "ollama" ? new OllamaProvider(MODEL, CONFIG.ollamaUrl) : new AnthropicProvider(MODEL);

const ajv = new Ajv({ strict: false, allErrors: true });
const validators = new Map<string, ValidateFunction>();

// ── Board model — three token classes, auras, zones with color ───────────────
type Klass = "pc" | "sidekick" | "npc";
interface Tok {
  id: string; name: string; klass: Klass; controlledby: string;
  bar1_value: number; bar1_max: number; statusmarkers: string; gmnotes: string;
  layer: string; aura1_radius: number;
}
interface Zone { name: string; color?: string }
interface Board { tokens: Tok[]; turnorder: { id: string; pr: string }[]; zones: Zone[]; chat: string[] }

const PCHP_RE = /%%PCHP=({[\s\S]*?})%%/;
const writePcHp = (gm: string, e: { current: number; max: number; name: string }) =>
  (gm.replace(PCHP_RE, "").trim() + ` %%PCHP=${JSON.stringify({ ...e, updated: 0 })}%%`).trim();
const readPcHp = (gm: string): { current: number; max: number } | null => {
  const m = gm.match(PCHP_RE); if (!m) return null; try { return JSON.parse(m[1]); } catch { return null; }
};

function seedBoard(): Board {
  const mk = (name: string, hp: number, klass: Klass): Tok => ({
    id: "tok-" + name.replace(/\s+/g, ""), name, klass,
    controlledby: klass === "npc" ? "" : "player-" + name.split(" ")[0].toLowerCase(),
    bar1_value: hp, bar1_max: hp, statusmarkers: "", layer: "objects", aura1_radius: 0,
    gmnotes: klass === "pc" ? writePcHp("", { current: hp, max: hp, name }) : "",
  });
  const tokens = [
    mk("Glint Klinkinski", 30, "pc"),
    mk("Tua", 27, "sidekick"),
    mk("Salros Eventide", 24, "sidekick"),
    mk("Water Elemental the Surging", 90, "npc"),
    mk("Kraken Priest A", 33, "npc"),
    mk("Kraken Priest B", 33, "npc"),
  ];
  // Glint acted last round, so he sits on top; "top of the order" = one advance → Salros.
  const order = ["Glint Klinkinski", "Salros Eventide", "Water Elemental the Surging", "Tua", "Kraken Priest A", "Kraken Priest B"];
  return {
    tokens,
    turnorder: order.map((n, i) => ({ id: tokens.find((t) => t.name === n)!.id, pr: String(20 - i) })),
    zones: [{ name: "Grease", color: "#88aa00" }],
    chat: [],
  };
}

const find = (b: Board, n: unknown) =>
  b.tokens.find((t) => t.name.toLowerCase() === String(n ?? "").toLowerCase()) ||
  b.tokens.find((t) => t.name.toLowerCase().includes(String(n ?? "").toLowerCase()) && String(n ?? "").length > 2);
const byRef = (b: Board, a: Record<string, unknown>) => find(b, a.characterName) || b.tokens.find((x) => x.id === a.tokenId) || find(b, a.tokenId);
const has = (t: Tok, cond: string) => t.statusmarkers.split(",").some((m) => m.toLowerCase().includes(cond));
const markers = (t: Tok) => new Set(t.statusmarkers.split(",").filter(Boolean));
const setMarkers = (t: Tok, s: Set<string>) => { t.statusmarkers = [...s].join(","); };

const rosterFromBoard = (b: Board) => {
  const line = (t: Tok) => `- ${t.name}${has(t, "concentrating") ? " (concentrating on Bless)" : ""}`;
  return "PCs (true player characters — HP tracked, bar is Beyond20's):\n" +
    b.tokens.filter((t) => t.klass === "pc").map(line).join("\n") +
    "\nSIDEKICKS (player-controlled, but HP lives on token bar1):\n" +
    b.tokens.filter((t) => t.klass === "sidekick").map(line).join("\n") +
    "\nOTHER TOKENS (NPCs):\n" +
    b.tokens.filter((t) => t.klass === "npc").map(line).join("\n");
};

// ── Stub executor — routes HP by token CLASS (simulating the #132-fixed server) ──
function stubExec(name: string, a: Record<string, unknown>, b: Board): string {
  const hpDelta = (t: Tok, amount: number, heal = false) => {
    if (t.klass === "pc") {
      const h = readPcHp(t.gmnotes)!;
      const nv = Math.max(0, Math.min(h.max, h.current + (heal ? amount : -amount)));
      t.gmnotes = writePcHp(t.gmnotes, { ...h, current: nv });
      return `${t.name} ${nv}/${h.max} (tracked)`;
    }
    t.bar1_value = Math.max(0, Math.min(t.bar1_max, t.bar1_value + (heal ? amount : -amount)));
    return `${t.name} ${t.bar1_value}/${t.bar1_max}`;
  };
  const applyConds = (t: Tok, add?: unknown, remove?: unknown) => {
    const s = markers(t);
    for (const c of (Array.isArray(add) ? add : [])) s.add(String(c).toLowerCase());
    for (const c of (Array.isArray(remove) ? remove : [])) for (const m of [...s]) if (m.includes(String(c).toLowerCase())) s.delete(m);
    setMarkers(t, s);
  };
  switch (name) {
    case "list_tokens": return JSON.stringify(b.tokens.map((t) => ({ id: t.id, name: t.name, controlledby: t.controlledby, layer: t.layer, hp: `${t.bar1_value}/${t.bar1_max}`, statusmarkers: t.statusmarkers })));
    case "get_token": { const t = byRef(b, a); return t ? JSON.stringify({ ...t }) : "not found"; }
    case "get_turn_order": return JSON.stringify(b.turnorder.map((e) => ({ ...e, name: b.tokens.find((t) => t.id === e.id)?.name })));
    case "get_token_markers": return JSON.stringify({ reserved: [], available: [] });
    case "list_zones": return JSON.stringify(b.zones);
    case "find_tokens_in_range": return JSON.stringify(b.tokens.filter((t) => t.klass === "npc" && t.layer === "objects").map((t) => t.name));
    case "update_token_hp": {
      const t = byRef(b, a); if (!t) return "token not found";
      applyConds(t, a.addConditions, a.removeConditions);
      if (a.damage != null) return hpDelta(t, Number(a.damage));
      if (a.heal != null) return hpDelta(t, Number(a.heal), true);
      if (a.setHp != null) {
        if (t.klass === "pc") { const h = readPcHp(t.gmnotes)!; t.gmnotes = writePcHp(t.gmnotes, { ...h, current: Number(a.setHp) }); return `${t.name} ${a.setHp} (tracked)`; }
        t.bar1_value = Number(a.setHp); return `${t.name} ${t.bar1_value}/${t.bar1_max}`;
      }
      return a.addConditions || a.removeConditions ? `${t.name} conditions updated` : "no hp op";
    }
    case "update_hp_many": {
      const names = (a.names as string[]) || b.tokens.filter((t) => a.nameMatch && t.name.toLowerCase().includes(String(a.nameMatch).toLowerCase())).map((t) => t.name);
      return names.map((n) => { const t = find(b, n); return t ? hpDelta(t, Number(a.damage ?? a.heal ?? 0), a.heal != null) : `${n}?`; }).join(", ");
    }
    case "set_token_marker": {
      const t = byRef(b, a); if (!t) return "token not found";
      const cond = String(a.condition).toLowerCase(); const s = markers(t);
      // Set-semantics (per #133): active=true adds (idempotent), false removes.
      if (a.active === false) { for (const m of [...s]) if (m.includes(cond)) s.delete(m); } else s.add(cond);
      setMarkers(t, s);
      return `${t.name}: ${cond} ${a.active === false ? "cleared" : "applied"}`;
    }
    case "kill_token": {
      const t = byRef(b, a); if (!t) return "token not found";
      const s = markers(t); s.add("dead"); setMarkers(t, s); t.layer = "map";
      return `${t.name} marked dead + moved to map layer`;
    }
    case "resolve_aoe": {
      const targets = (a.targetNames as string[]) || b.tokens.filter((t) => t.klass === "npc").map((t) => t.name);
      const dmgN = Number(a.damage) || 0;
      return `${a.label ?? "AoE"}: ` + targets.map((n) => { const t = find(b, n); return t ? hpDelta(t, dmgN) : `${n}?`; }).join("; ");
    }
    case "create_zone": b.zones.push({ name: String(a.name), color: a.color ? String(a.color) : undefined }); return `zone "${a.name}" created`;
    case "clear_zone": { const before = b.zones.length; b.zones = b.zones.filter((z) => z.name.toLowerCase() !== String(a.name).toLowerCase()); return b.zones.length < before ? `zone "${a.name}" cleared` : `no zone "${a.name}"`; }
    case "advance_turn": { const e = b.turnorder.shift(); if (e) b.turnorder.push(e); const cur = b.tokens.find((t) => t.id === b.turnorder[0]?.id); return `advanced — now ${cur?.name ?? "?"}`; }
    case "set_token_props": {
      const t = byRef(b, a); if (!t) return "token not found";
      if (a.layer != null) t.layer = String(a.layer);
      if (a.aura1_radius != null) t.aura1_radius = Number(a.aura1_radius) || 0;
      return `${t.name} props set`;
    }
    case "roll_dice": return "rolled (see chat)";
    case "send_narration": b.chat.push(String(a.text ?? "")); return "(narrated)";
    case "batch_exec": {
      // Execute faithfully — a swallowed batch would hide exactly the mutations we grade.
      const arr = Object.values(a).find((v) => Array.isArray(v) && v.every((x) => x && typeof x === "object")) as Record<string, unknown>[] | undefined;
      if (!arr) return "(batch: nothing to run)";
      return arr.map((c) => {
        const tool = String(c.tool ?? c.name ?? c.action ?? "");
        const args = (c.args ?? c.params ?? c.input ?? c) as Record<string, unknown>;
        return tool ? stubExec(tool, args, b) : "(?)";
      }).join(" | ");
    }
    case "roll_initiative": return "(initiative rolled)";
    case "plan_all_tactics": case "get_mob_plans": return "(tactics ready)";
    default: return `(stub: ${name} ok)`;
  }
}

// ── The golden pairs as steps ────────────────────────────────────────────────
interface Ctx { calls: string[]; texts: string[] }
interface Step { pair: string; utterance: string; setup?: (b: Board) => void; check: (b: Board, c: Ctx) => string | null }

const S = (b: Board) => find(b, "the Surging")!;
const PA = (b: Board) => find(b, "Kraken Priest A")!;
const PB = (b: Board) => find(b, "Kraken Priest B")!;
const GLINT = (b: Board) => find(b, "Glint")!;
const TUA = (b: Board) => find(b, "Tua")!;
const SALROS = (b: Board) => find(b, "Salros")!;

const SCENARIO: Step[] = [
  { pair: "1 threshold-not-flavor",
    utterance: "Salros carves into the Surging — that's 19 slashing, and it's looking ragged now.",
    check: (b) => {
      const t = S(b);
      if (t.bar1_value !== 71) return `Surging bar1=${t.bar1_value}, want 71`;
      if (has(t, "wounded") || has(t, "bloodied")) return "wounded marker applied on flavor — 71 > 45, threshold not crossed";
      return null;
    } },
  { pair: "2 pc-routing+prone",
    utterance: "The Surging slams into Glint — he takes 14 bludgeoning and he's knocked prone.",
    check: (b) => {
      const t = GLINT(b);
      if (t.bar1_value !== 30) return `Glint bar1=${t.bar1_value} — PC bar written (Beyond20 owns it)`;
      if (readPcHp(t.gmnotes)?.current !== 16) return `Glint tracked=${readPcHp(t.gmnotes)?.current}, want 16`;
      if (!has(t, "prone")) return "no prone marker";
      return null;
    } },
  { pair: "3 negative-space",
    utterance: "Tua wades forward, guardians spinning — Priest A fails the wisdom save, takes 11 radiant, and the spirits slow him to a crawl.",
    check: (b) => {
      const t = PA(b);
      if (t.bar1_value !== 22) return `Priest A bar1=${t.bar1_value}, want 22`;
      if (t.statusmarkers !== "") return `invented marker(s) for a flavor clause: "${t.statusmarkers}"`;
      return null;
    } },
  { pair: "4 aoe+thresholds+death+zone-transition",
    utterance: "Glint hurls a fireball into the back rank — 28 fire. Both priests fail the save; the Surging fails too and takes 28. And the grease catches — it's all flame back there now.",
    check: (b) => {
      const a = PA(b), pb = PB(b), s = S(b);
      if (a.bar1_value !== 0) return `Priest A bar1=${a.bar1_value}, want 0`;
      if (!has(a, "dead") || a.layer !== "map") return `Priest A at 0 but dead=${has(a, "dead")} layer=${a.layer} — NPCs just die`;
      if (pb.bar1_value !== 5) return `Priest B bar1=${pb.bar1_value}, want 5`;
      if (!has(pb, "wounded") && !has(pb, "bloodied")) return "Priest B at 5/33 — below half, no wounded marker";
      if (s.bar1_value !== 43) return `Surging bar1=${s.bar1_value}, want 43`;
      if (!has(s, "wounded") && !has(s, "bloodied")) return "Surging at 43/90 — crossed half, no wounded marker";
      const grease = b.zones.some((z) => /grease/i.test(z.name) && !/burn|fire|flame/i.test(z.name));
      const fire = b.zones.some((z) => /burn|fire|flame/i.test(z.name));
      if (grease || !fire) return `zone transition missed: grease-still-plain=${grease}, fire-zone=${fire} (delete+create expected)`;
      return null;
    } },
  { pair: "6 round-boundary-expiry",
    utterance: "That's the round — the flames burn themselves out. Top of the order: Salros, you're up.",
    check: (b) => {
      if (b.zones.some((z) => /burn|fire|flame/i.test(z.name))) return "fire zone not removed at round boundary";
      const top = b.tokens.find((t) => t.id === b.turnorder[0]?.id);
      if (top?.name !== "Salros Eventide") return `top of order is ${top?.name}, want Salros`;
      return null;
    } },
  { pair: "7 retcon-delta",
    utterance: "Ah — back up. That slam on Glint was 9, not 14. Bill had the die wrong.",
    check: (b) => {
      const t = GLINT(b);
      if (t.bar1_value !== 30) return `Glint bar1=${t.bar1_value} — PC bar written`;
      const cur = readPcHp(t.gmnotes)?.current;
      return cur === 21 ? null : `Glint tracked=${cur}, want 21 (compensating +5)`;
    } },
  { pair: "9 fudge-respect",
    utterance: "Priest B has had it — he drops.",
    check: (b) => {
      const t = PB(b);
      if (!has(t, "dead") || t.layer !== "map") return `stated drop not honored: dead=${has(t, "dead")} layer=${t.layer} (HP was 5 — never argue with the table)`;
      return null;
    } },
  { pair: "9b sidekick-death",
    utterance: "The Surging crushes Salros flat — he's gone.",
    check: (b) => {
      const t = SALROS(b);
      if (!has(t, "dead") || t.layer !== "map") return `sidekick death: dead=${has(t, "dead")} layer=${t.layer} — sidekicks die like NPCs`;
      if (has(t, "unconscious")) return "sidekick given the PC dying state (unconscious) — they just die";
      return null;
    } },
  { pair: "10 pc-dying-state",
    utterance: "The Surging turns on Glint and smashes him to the floor — he's down, he's dying.",
    check: (b) => {
      const t = GLINT(b);
      if (has(t, "dead")) return "PC marked dead — dying, not dead (3 failed saves first)";
      if (t.layer !== "objects") return `PC moved to ${t.layer} layer — dying PCs stay on the token layer`;
      if (!has(t, "unconscious")) return "no unconscious marker";
      if (!has(t, "prone")) return "no prone marker";
      return null;
    } },
  { pair: "11 revival-set+prone-stays",
    utterance: "Tua gets a potion into Glint — he's back on 6 hit points, conscious, still flat on his back.",
    check: (b) => {
      const t = GLINT(b);
      if (t.bar1_value !== 30) return `Glint bar1=${t.bar1_value} — PC bar written`;
      const cur = readPcHp(t.gmnotes)?.current;
      if (cur !== 6) return `Glint tracked=${cur}, want 6 (absolute-set: "on 6")`;
      if (has(t, "unconscious")) return "unconscious not removed";
      if (!has(t, "prone")) return "prone removed — he stays prone until he stands on his turn";
      return null;
    } },
  { pair: "13a concentration-micro-question",
    utterance: "The Surging backhands Tua — 8 bludgeoning.",
    setup: (b) => { const t = TUA(b); const s = markers(t); s.add("concentrating"); setMarkers(t, s); t.aura1_radius = 20; },
    check: (b, c) => {
      const t = TUA(b);
      if (t.bar1_value !== 19) return `Tua bar1=${t.bar1_value}, want 19 (sidekick → bar1)`;
      if (!has(t, "concentrating")) return "concentration torn down without asking — the save is the DM's to report";
      if (t.aura1_radius !== 20) return "aura changed without asking";
      const asked = c.texts.some((x) => /concentrat/i.test(x) && /\?/.test(x));
      if (!asked) return "no concentration micro-question in the reply";
      return null;
    } },
  { pair: "13b teardown-on-Failed",
    utterance: "Failed.",
    check: (b) => {
      const t = TUA(b);
      if (has(t, "concentrating")) return "concentrating marker still set after Failed";
      if (t.aura1_radius !== 0) return `aura radius=${t.aura1_radius}, want 0 (teardown cascade)`;
      return null;
    } },
];

// ── Playthrough (threaded; identical loop discipline to eval-arc) ────────────
interface StepResult { ok: boolean; ms: number; calls: number; nudges: number }
async function playthrough(system: string, toolSpecs: ToolSpec[]): Promise<StepResult[]> {
  const board = seedBoard();
  const llm = makeProvider();
  llm.start(system, toolSpecs);
  const results: StepResult[] = [];

  for (const step of SCENARIO) {
    step.setup?.(board);
    llm.pushUser(buildTurnContext(rosterFromBoard(board)) + "\n\n" + step.utterance);
    const ctx: Ctx = { calls: [], texts: [] };
    const t0 = Date.now(); let apiCalls = 0, nudges = 0;
    let mutationsThisTurn = 0, nudgedAlready = false, completenessCheckedAlready = false;
    for (let s = 0; s < MAX_STEPS + 2; s++) {
      const turn = await llm.run(); apiCalls++;
      if (turn.text) ctx.texts.push(turn.text);
      if (turn.toolCalls.length === 0) {
        const action = decideTerminal({ transcript: step.utterance, mutationsThisTurn, nudgedAlready, completenessCheckedAlready, mode: MODE });
        if (action.kind === "done") break;
        if (action.tag === "persist") nudgedAlready = true; else completenessCheckedAlready = true;
        nudges++;
        llm.pushContinue(action.text);
        continue;
      }
      llm.pushToolResults(turn.toolCalls.map((c) => {
        ctx.calls.push(c.name);
        if (isMutatingTool(c.name)) mutationsThisTurn++;
        const val = validators.get(c.name);
        if (val && !val(c.args)) {
          return { id: c.id, name: c.name, content: `MCP error -32602: Input validation error: ${ajv.errorsText(val.errors, { separator: "; " })}` };
        }
        return { id: c.id, name: c.name, content: stubExec(c.name, c.args, board) };
      }));
    }
    const ms = Date.now() - t0;
    const why = step.check(board, ctx);
    const ok = why === null;
    results.push({ ok, ms, calls: apiCalls, nudges });
    console.log(`  ${ok ? "✓" : "✗"} ${String(ms).padStart(6)}ms ${apiCalls}c${nudges ? `+${nudges}↻` : "  "}  [${step.pair}]  [${ctx.calls.join(",") || "none"}]${ok ? "" : "  ⚠ " + why}`);
  }
  return results;
}

async function main() {
  if (PROVIDER === "anthropic" && !process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not set");
  const mcp = new McpRoll20();
  const tools = await mcp.connect();
  for (const t of tools) { try { validators.set(t.name, ajv.compile(t.inputSchema)); } catch { /* unschemable */ } }
  const SCOPE = process.env.DMW_EVAL_SCOPE || "lean";
  let allow: Set<string> | null = null;
  if (SCOPE !== "full") {
    allow = new Set(CONFIG.cloudToolAllowlist);
    if (PROVIDER === "ollama") { const local = new Set(CONFIG.localToolAllowlist); allow = new Set([...allow].filter((t) => local.has(t))); }
  }
  const toolSpecs: ToolSpec[] = tools.filter((t) => !allow || allow.has(t.name)).map((t) => ({ name: t.name, description: t.description, parameters: t.inputSchema }));
  console.log(`Connected — ${tools.length} served, ${toolSpecs.length} sent (scope=${SCOPE}). provider=${PROVIDER} model=${MODEL}, loop=${MODE}, ${SCENARIO.length} steps × ${REPS}\n`);
  const system = buildSystemPrompt("anthropic");

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

  console.log("\n──────── SUMMARY ────────  " + PROVIDER + "/" + MODEL + "  (golden pairs)");
  const pct = (n: number) => ((n / REPS) * 100).toFixed(0) + "%";
  SCENARIO.forEach((s, i) => console.log(`  ${perStep[i]}/${REPS} ${pct(perStep[i]).padStart(4)}  ${s.pair}`));
  const totalPass = perStep.reduce((a, b) => a + b, 0), totalSteps = SCENARIO.length * REPS;
  console.log(`\n  GOLDEN CORRECT:   ${totalPass}/${totalSteps} (${((totalPass / totalSteps) * 100).toFixed(0)}%) — board-verified against the DM's calibrated conventions`);
  console.log(`  PER-TURN LATENCY: mean ${mean.toFixed(0)}ms · median ${sorted[Math.floor(sorted.length / 2)]}ms  (n=${turnMs.length})`);
  console.log(`  PERSISTENCE:      loop=${MODE}, ${totalNudges} re-prompt${totalNudges === 1 ? "" : "s"} over ${totalSteps} turns`);
  console.log(`  total wall: ${(wallMs / 1000).toFixed(1)}s`);
}

main().catch((e) => { console.error(e); process.exit(1); });
