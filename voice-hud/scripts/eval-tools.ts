// Tool-call shape smoke test. Fires utterances that RESEMBLE the ones Haiku
// fumbled in the 0.1.4 release test at the live model, with the real persona +
// the real tool schemas pulled from the running combat server, and validates each
// emitted tool call against its OWN JSON schema (the same contract that returns
// -32602). No Roll20 execution — we only inspect the calls the model produces.
//
//   Terminal 1: npm run serve         (combat HTTP server, port 39200)
//   Terminal 2: npm run eval:tools    (DMW_EVAL_MODEL to change tier; default Haiku)
//
// Shape-valid = the call would have been ACCEPTED by the MCP boundary. That's the
// whole failure class from the test (stringified arrays, string booleans, wrong
// param names all surface as schema-invalid). Intent correctness (LLM-judge) is a
// later layer; this answers "did the new prompts stop the malformed args?".

import * as path from "path";
import * as dotenv from "dotenv";
import Ajv, { ValidateFunction } from "ajv";
import { McpRoll20 } from "../src/mcp";
import { buildSystemPrompt, buildTurnContext } from "../src/persona";
import { AnthropicProvider } from "../src/llm/anthropic";
import { OllamaProvider } from "../src/llm/ollama";
import { LLMProvider, ToolSpec } from "../src/llm/provider";
import { CONFIG } from "../src/config";

// Env: root .env first (the combat server's ROLL20_MCP_TOKEN), then the HUD-local
// and data-dir .env (ANTHROPIC_API_KEY). dotenv is first-wins.
dotenv.config({ path: path.join(__dirname, "..", "..", ".env") });
dotenv.config({ path: path.join(__dirname, "..", ".env") });
dotenv.config({ path: path.join(__dirname, "..", "data", ".env") });

const PROVIDER = process.env.DMW_EVAL_PROVIDER || "anthropic";
const MODEL = process.env.DMW_EVAL_MODEL || (PROVIDER === "ollama" ? "qwen2.5:14b-instruct" : "claude-haiku-4-5");
const REPS = Number(process.env.DMW_EVAL_REPS) || 3;
const makeProvider = (): LLMProvider => PROVIDER === "ollama" ? new OllamaProvider(MODEL, CONFIG.ollamaUrl) : new AnthropicProvider(MODEL);

const ROSTER = [
  "PCs (player-controlled):",
  "- Thorne",
  "OTHER TOKENS (NPCs):",
  "- Ogre",
  "- Goblin A",
  "- Goblin B",
  "- Goblin C",
  "- Goblin D",
  "- Mastermind",
].join("\n");

interface Case { utterance: string; expect: string; need?: Record<string, unknown>; note?: string }
// The model-facing combat utterances from docs/e2e-human-test-script.html (Phase 5
// turn loop + the voice turns). `expect` is the tool the script's "expected" column
// calls for; `need` are key args that must also be right.
const CASES: Case[] = [
  { utterance: "Thorne takes 12 slashing from the ogre.", expect: "update_token_hp", need: { characterName: "Thorne", damage: 12 } },
  { utterance: "The ogre takes 20 from Thorne's maul.", expect: "update_token_hp", need: { characterName: "Ogre", damage: 20 } },
  { utterance: "Thorne is poisoned.", expect: "set_token_marker", need: { condition: "poisoned", active: true } },
  { utterance: "Goblin A is prone.", expect: "set_token_marker", need: { condition: "prone", active: true } },
  { utterance: "Fireball on the goblins — 8d6 fire, DEX save DC 15, half on save.", expect: "resolve_aoe" },
  { utterance: "Mass cure on the goblins, 2d8 plus 3.", expect: "resolve_aoe" },
  { utterance: "Web fills a 20-ft cube by the door.", expect: "create_zone" },
  { utterance: "Cloudkill, 20-ft radius circle, centered on the ogre.", expect: "create_zone" },
  { utterance: "The web is gone.", expect: "clear_zone", need: { name: "Web" } },
  { utterance: "The ogre drops.", expect: "kill_token", note: "atomic dead + map layer" },
  { utterance: "Next turn.", expect: "advance_turn" },
  { utterance: "the ogre takes ten damage", expect: "update_token_hp", need: { characterName: "Ogre", damage: 10 } },
  { utterance: "goblin A takes 3", expect: "update_token_hp", need: { characterName: "Goblin A", damage: 3 } },
  // Messy multi-clause STT phrasings that broke in the live 0.1.5 session — the model
  // picked the right tool but emitted a STRING number / stringified array / invented
  // param name (-32602). These reproduce that class; types in `need` must match exactly.
  { utterance: "and the ogre takes 12 points of psychic damage when it fails its Wisdom save", expect: "update_token_hp", need: { characterName: "Ogre", damage: 12 } },
  { utterance: "Mastermind casts hunger of hadar on goblin A, goblin B, and goblin C — roll their saves and do 3d6, DEX save DC 15", expect: "resolve_aoe" },
  { utterance: "4 cold damage to goblin A, goblin B, and goblin C", expect: "update_hp_many", need: { damage: 4 } },
];

// Tools that act on a token need a target; the schema marks both optional, so a
// call with neither passes ajv but fails the handler. Flag it as a soft miss.
const NEEDS_TARGET = new Set(["set_token_marker", "update_token_hp"]);

async function main() {
  if (PROVIDER === "anthropic" && !process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not set");

  const mcp = new McpRoll20();
  const tools = await mcp.connect();
  // Mirror the gem: it sends the full cloud allowlist. DMW_EVAL_SCOPE=full to compare.
  const SCOPE = process.env.DMW_EVAL_SCOPE || "lean";
  const allow = SCOPE === "full" ? null : new Set(CONFIG.cloudToolAllowlist);
  const sent = tools.filter((t) => !allow || allow.has(t.name));
  console.log(`Connected — ${tools.length} served, ${sent.length} sent (scope=${SCOPE}). provider=${PROVIDER} model=${MODEL}, reps=${REPS}\n`);

  const ajv = new Ajv({ strict: false, allErrors: true });
  const validators = new Map<string, ValidateFunction>();
  for (const t of tools) {
    try { validators.set(t.name, ajv.compile(t.inputSchema)); } catch { /* unschemable tool — skip */ }
  }

  const system = buildSystemPrompt("anthropic");
  const toolSpecs: ToolSpec[] = sent.map((t) => ({ name: t.name, description: t.description, parameters: t.inputSchema }));

  let reps = 0, passReps = 0, toolReps = 0, shapeOkCalls = 0, allCalls = 0, noCallReps = 0;

  const needsMet = (input: Record<string, unknown>, need?: Record<string, unknown>): boolean =>
    Object.entries(need || {}).every(([k, want]) => {
      const got = input[k];
      if (typeof want === "string") return typeof got === "string" && got.toLowerCase() === String(want).toLowerCase();
      return got === want;
    });

  for (const c of CASES) {
    console.log(`▸ "${c.utterance}"  (expect ${c.expect}${c.note ? "; " + c.note : ""})`);
    for (let rep = 0; rep < REPS; rep++) {
      reps++;
      const llm = makeProvider();
      llm.start(system, toolSpecs);
      llm.pushUser(buildTurnContext(ROSTER) + "\n\n" + c.utterance);
      const turn = await llm.run();
      const calls = turn.toolCalls;
      if (calls.length === 0) {
        noCallReps++;
        console.log(`    rep${rep}: ✗ no call — said: "${turn.text.replace(/\s+/g, " ").slice(0, 90)}"`);
        continue;
      }

      // Shape-validity across EVERY emitted call — the -32602 reproduction.
      let shapeNote = "";
      for (const call of calls) {
        allCalls++;
        const val = validators.get(call.name);
        const okShape = val ? !!val(call.args) : true;
        if (okShape) shapeOkCalls++;
        else if (val) shapeNote += ` [${call.name}: ${ajv.errorsText(val.errors, { separator: "; " })}]`;
      }
      // Did it pick the expected tool, with valid shape, a target, and the key args?
      const match = calls.find((cc) => cc.name === c.expect);
      if (match) toolReps++;
      const mv = match ? validators.get(match.name) : undefined;
      const matchValid = match ? (mv ? !!mv(match.args) : true) : false;
      const input = (match?.args ?? {}) as Record<string, unknown>;
      const targetOk = !match || !NEEDS_TARGET.has(match.name) || !!input.characterName || !!input.tokenId;
      const pass = !!match && matchValid && targetOk && needsMet(input, c.need);
      if (pass) passReps++;

      const got = calls.map((cc) => `${cc.name}(${JSON.stringify(cc.args).slice(0, 70)})`).join(" + ");
      console.log(`    rep${rep}: ${pass ? "✓ PASS" : "✗ FAIL"}  ${got}${shapeNote}${match && !targetOk ? "  ⚠ no target" : ""}`);
    }
  }

  await mcp.close();
  const pct = (n: number, d: number) => d ? ((n / d) * 100).toFixed(0) + "%" : "—";
  console.log("\n──────── SUMMARY ────────  " + PROVIDER + "/" + MODEL);
  console.log(`reps:            ${reps}  (${noCallReps} produced no tool call)`);
  console.log(`shape-valid:     ${shapeOkCalls}/${allCalls} calls (${pct(shapeOkCalls, allCalls)}) — would pass the -32602 boundary`);
  console.log(`expected tool:   ${toolReps}/${reps} reps (${pct(toolReps, reps)})`);
  console.log(`FULLY CORRECT:   ${passReps}/${reps} reps (${pct(passReps, reps)}) — right tool + valid shape + key args`);
}

main().catch((e) => { console.error(e); process.exit(1); });
