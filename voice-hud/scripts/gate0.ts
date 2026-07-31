// Gate-0 miner — historical first-pass completion over hud.log (read-only).
//
// Answers "how often does the live agent get a turn right on the first pass?"
// from the durable JSONL log alone, ahead of any specialist-model work. All
// classification is on `msg` content (never `kind` — the console→agent kind
// shift mid-corpus makes `kind` unreliable); all temporal logic is on `ts`.
//
// Known blind spots it compensates for (see SPECIALIST_MODEL_DECISION.md):
//   - onToolResult logged "tool ✓" unconditionally in historical logs (fixed
//     live since Gate-2) → errors are detected by result TEXT ("MCP error",
//     error hints), never the glyph, and both glyphs are accepted;
//   - ↻persist/↑escalate masquerade as tool names → excluded from tool stats;
//   - 14-step-cap turns exit without a "turn DONE" line → counted as capped.
//
// Usage: npx tsx scripts/gate0.ts [hud.log path] [--json out.json]
import * as fs from "fs";
import { parseLog, LogLine } from "../src/aar";
import { statesOutcome, isMutatingTool } from "../src/loop-policy";

const RE_SESSION = /\[ptt\] PTT armed/;
// Transcripts may span lines and the closing quote can be cut by truncation;
// old-format DONE lines (pre-mut logging) lack the "(mut=N)" suffix.
const RE_TURN_START = /\[agent\] turn start: "([\s\S]*?)"?( \(LOW CONF\))?$/;
const RE_TURN_DONE = /\[agent\] turn DONE (\d+)ms, (\d+) steps(?: \(mut=(\d+)\))?/;
const RE_TOOL_CALL = /\[agent\] tool → ([^(]+)\(/;
// Both glyphs: historical logs are ✓-only (the unconditional-✓ bug), sessions
// recorded after the Gate-2 fix mark failures ✗ — skipping those would drop
// exactly the error lines this miner counts.
const RE_TOOL_RESULT = /\[agent\] tool [✓✗⚠] ([^:]+): ([\s\S]*)$/;
const RE_NUDGE = /\[agent\] persist:(persist|complete) —/;
const RE_MCP_ERROR = /MCP error (-?\d+)/;
const ERROR_HINT = /\b(error|not found|ambiguous|invalid|timeout|failed|no result)\b/i;
const PSEUDO_TOOL = /^[↻↑]/; // loop-policy nudges / escalations logged via onToolResult

interface Turn {
  session: number;
  startTs: number;
  endTs: number;
  transcript: string;
  declarative: boolean;
  done: boolean;      // saw "turn DONE"
  capped: boolean;    // started but never DONE before next start/session
  ms: number;
  steps: number;
  mut: number;
  tools: string[];
  mcpErrors: { tool: string; code: string }[];
  hintErrors: { tool: string; text: string }[];
  nudged: boolean;
}

function mine(lines: LogLine[]) {
  const turns: Turn[] = [];
  let session = 0;
  let cur: Turn | null = null;
  const close = (capped: boolean) => {
    if (cur) { cur.capped = capped && !cur.done; turns.push(cur); cur = null; }
  };

  let sanity = { toolCalls: 0, toolResults: 0, mcp32602: 0, turnStarts: 0, turnDones: 0 };
  const perTool32602 = new Map<string, number>();
  const perToolCalls = new Map<string, number>();

  for (const { ts, msg } of lines) {
    if (RE_SESSION.test(msg)) { close(true); session++; continue; }
    let m: RegExpMatchArray | null;
    if ((m = msg.match(RE_TURN_START))) {
      close(true);
      sanity.turnStarts++;
      cur = {
        session, startTs: ts, endTs: ts, transcript: m[1], declarative: statesOutcome(m[1]),
        done: false, capped: false, ms: 0, steps: 0, mut: 0, tools: [],
        mcpErrors: [], hintErrors: [], nudged: false,
      };
      continue;
    }
    if (cur) cur.endTs = ts;
    if ((m = msg.match(RE_TOOL_CALL))) {
      const tool = m[1].trim();
      if (!PSEUDO_TOOL.test(tool)) {
        sanity.toolCalls++;
        perToolCalls.set(tool, (perToolCalls.get(tool) ?? 0) + 1);
        cur?.tools.push(tool);
      }
      continue;
    }
    if ((m = msg.match(RE_TOOL_RESULT))) {
      const tool = m[1].trim(), text = m[2];
      if (PSEUDO_TOOL.test(tool)) { if (cur) cur.nudged = true; continue; }
      sanity.toolResults++;
      const mcp = text.match(RE_MCP_ERROR);
      if (mcp) {
        if (mcp[1] === "-32602") { sanity.mcp32602++; perTool32602.set(tool, (perTool32602.get(tool) ?? 0) + 1); }
        cur?.mcpErrors.push({ tool, code: mcp[1] });
      } else if (ERROR_HINT.test(text)) {
        cur?.hintErrors.push({ tool, text: text.slice(0, 60) });
      }
      continue;
    }
    if ((m = msg.match(RE_NUDGE))) { if (cur) cur.nudged = true; continue; }
    if ((m = msg.match(RE_TURN_DONE))) {
      sanity.turnDones++;
      if (cur) {
        cur.done = true; cur.ms = +m[1]; cur.steps = +m[2];
        // Old-format lines carry no mut count — fall back to counting mutating
        // tool calls seen in the span (same READ_ONLY_TOOLS split as the agent).
        cur.mut = m[3] !== undefined ? +m[3] : cur.tools.filter(isMutatingTool).length;
        close(false);
      }
      continue;
    }
  }
  close(true);
  return { turns, sanity, perTool32602, perToolCalls, sessions: session };
}

// A turn "failed" for repair-chain purposes if it capped, threw an MCP error, or
// stated an outcome yet mutated nothing (the Failure-A flake).
const failed = (t: Turn) => t.capped || t.mcpErrors.length > 0 || (t.declarative && t.mut === 0);

function repairFlags(turns: Turn[], nSec: number): boolean[] {
  return turns.map((t, i) => {
    if (i === 0) return false;
    const p = turns[i - 1];
    return p.session === t.session && failed(p) && (t.startTs - p.endTs) <= nSec * 1000;
  });
}

function chains(flags: boolean[]): number[] {
  const out: number[] = [];
  let run = 0;
  for (const f of flags) { if (f) run++; else { if (run) out.push(run); run = 0; } }
  if (run) out.push(run);
  return out;
}

const pct = (n: number, d: number) => d ? `${((100 * n) / d).toFixed(1)}% (${n}/${d})` : "n/a";
const quantile = (xs: number[], q: number) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};

function report(label: string, file: string) {
  const raw = fs.readFileSync(file, "utf8");
  const lines = parseLog(raw);
  const { turns, sanity, perTool32602, perToolCalls, sessions } = mine(lines);

  const decl = turns.filter((t) => t.declarative);
  const capped = turns.filter((t) => t.capped);
  const doneTurns = turns.filter((t) => t.done);
  const mut0Decl = decl.filter((t) => t.done && t.mut === 0);
  const nudgedTurns = turns.filter((t) => t.nudged);
  const anyMcp = turns.filter((t) => t.mcpErrors.length > 0);

  const sweep: Record<string, { rate: string; chains: number[] }> = {};
  for (const n of [30, 45, 60, 90]) {
    const flags = repairFlags(turns, n);
    sweep[`${n}s`] = { rate: pct(flags.filter(Boolean).length, turns.length), chains: chains(flags) };
  }
  const repair45 = repairFlags(turns, 45);

  // First-pass complete: the turn finished, threw no MCP error, needed no nudge,
  // and (if it stated an outcome) actually mutated the table.
  const cleanPass = (t: Turn) =>
    t.done && t.mcpErrors.length === 0 && !t.nudged && (!t.declarative || t.mut > 0);
  const lenient = turns.filter(cleanPass);
  const strict = turns.filter((t, i) => cleanPass(t) && !(i + 1 < turns.length && repair45[i + 1]));

  const stepsArr = doneTurns.map((t) => t.steps);
  const msArr = doneTurns.map((t) => t.ms);

  const md: string[] = [];
  md.push(`\n## Gate 0 — ${label}`);
  md.push(`corpus: \`${file}\` — ${lines.length} parsed lines, ${sessions} sessions, ${sanity.turnStarts} turn starts / ${sanity.turnDones} turn DONE`);
  md.push(`sanity: tool calls ${sanity.toolCalls}, tool results ${sanity.toolResults}, -32602 ${sanity.mcp32602}`);
  md.push(``);
  md.push(`| metric | value |`);
  md.push(`|---|---|`);
  md.push(`| first-pass complete (lenient) | ${pct(lenient.length, turns.length)} |`);
  md.push(`| first-pass complete (strict: +no repair follows @45s) | ${pct(strict.length, turns.length)} |`);
  md.push(`| first-pass complete, declarative turns only (lenient) | ${pct(decl.filter(cleanPass).length, decl.length)} |`);
  md.push(`| declarative turns | ${pct(decl.length, turns.length)} |`);
  md.push(`| declarative turns that mutated NOTHING (Failure A) | ${pct(mut0Decl.length, decl.length)} |`);
  md.push(`| turns with ≥1 MCP error | ${pct(anyMcp.length, turns.length)} |`);
  md.push(`| -32602 per tool call | ${pct(sanity.mcp32602, sanity.toolCalls)} |`);
  md.push(`| nudged turns (↻persist) | ${pct(nudgedTurns.length, turns.length)} |`);
  md.push(`| capped turns (started, never DONE) | ${pct(capped.length, turns.length)} |`);
  md.push(`| steps/turn median / p90 | ${quantile(stepsArr, 0.5)} / ${quantile(stepsArr, 0.9)} |`);
  md.push(`| ms/turn median / p90 | ${quantile(msArr, 0.5)} / ${quantile(msArr, 0.9)} |`);
  md.push(``);
  md.push(`repair-rate sweep: ` + Object.entries(sweep)
    .map(([k, v]) => `${k}=${v.rate} chains[${v.chains.join(",")}]`).join("  ·  "));

  const toolTable = [...perTool32602.entries()].sort((a, b) => b[1] - a[1]);
  if (toolTable.length) {
    md.push(`\n-32602 by tool (errors / calls):`);
    for (const [tool, n] of toolTable) md.push(`- ${tool}: ${n} / ${perToolCalls.get(tool) ?? "?"}`);
  }
  console.log(md.join("\n"));

  return { label, file, sessions, sanity, turns, sweep };
}

const args = process.argv.slice(2);
const jsonIdx = args.indexOf("--json");
const jsonOut = jsonIdx >= 0 ? args[jsonIdx + 1] : null;
const files = args.filter((a, i) => a !== "--json" && i !== jsonIdx + 1);
if (!files.length) {
  files.push(
    "C:\\Users\\escha\\AppData\\Roaming\\DM Whisper\\hud.log",
    require("path").join(__dirname, "..", "data", "hud.log"),
  );
}

const results = files.filter((f) => fs.existsSync(f)).map((f, i) => report(i === 0 ? "live corpus" : "dev corpus", f));
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(results, null, 2));
