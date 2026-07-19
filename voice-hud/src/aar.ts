// After-Action Review — the reinforcement loop's analysis half.
//
// Post-combat, parse the durable hud.log over the last combat window and surface
// (a) TURN EFFICIENCY (steps/turn, struggled turns, tool errors, escalations) and
// (b) CLARIFICATIONS (ambiguous targets / mishears). From the clarifications it
// PROPOSES learned spoken→canonical corrections (never auto-applied — the Training
// panel lets the DM accept/rerank, which persists them via addCorrection()).
//
// Everything here is deterministic + pure over the log lines (so it's unit-tested);
// the optional prose summary is a separate cheap LLM pass fed these structured
// metrics, not the raw log.
import * as fs from "fs";
import * as path from "path";
import { CONFIG } from "./config";

export interface LogLine { ts: number; msg: string }

export interface TurnStat { ms: number; steps: number; struggled: boolean }
export interface ToolError { tool: string; detail: string }
export interface Clarification { spoken: string; candidates: string[] }
export interface CorrectionProposal {
  spoken: string;      // lowercased misheard form
  suggested: string;   // best candidate (the DM can re-pick in the panel)
  candidates: string[];
  reason: string;
  count: number;       // how often it recurred — the rerank/priority signal
}
export interface AarReport {
  turns: number;
  totalSteps: number;
  avgSteps: number;
  struggledTurns: TurnStat[];   // > STRUGGLE_STEPS, the inefficient ones
  toolErrors: ToolError[];
  escalations: number;
  correctionsApplied: { from: string; to: string }[];
  clarifications: Clarification[];
  proposals: CorrectionProposal[];
}

const STRUGGLE_STEPS = 4;

// Read hud.log (durable JSONL: {ts, level, kind, msg}) into {ts, msg} lines.
export function loadHudLog(): LogLine[] {
  try {
    const file = path.join(CONFIG.dataDir, "hud.log");
    const raw = fs.readFileSync(file, "utf-8");
    return parseLog(raw);
  } catch {
    return [];
  }
}

export function parseLog(raw: string): LogLine[] {
  const out: LogLine[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line) as { ts?: number; msg?: unknown };
      if (typeof ev.msg === "string") out.push({ ts: ev.ts ?? 0, msg: ev.msg });
    } catch { /* skip malformed */ }
  }
  return out;
}

// Slice to the LAST combat window: from the final "combat: begin" (emitted by the
// BEGIN-COMBAT backbone) up to the next "combat: end" (emitted by CLEANUP), or the
// end of the log. If no markers are present, analyze everything.
export function combatWindow(lines: LogLine[]): LogLine[] {
  const isEnter = (m: string) => /\[agent\] combat: begin/.test(m);
  const isExit = (m: string) => /\[agent\] combat: end/.test(m);
  let start = -1;
  for (let i = lines.length - 1; i >= 0; i--) { if (isEnter(lines[i].msg)) { start = i; break; } }
  if (start === -1) return lines;
  let end = lines.length - 1;
  for (let i = start + 1; i < lines.length; i++) { if (isExit(lines[i].msg)) { end = i; break; } }
  return lines.slice(start, end + 1); // inclusive of the enter + exit markers
}

const ERROR_HINT = /\b(error|not found|ambiguous|invalid|timeout|failed|no result)\b/i;

function bestCandidate(spoken: string, candidates: string[]): string {
  const s = spoken.toLowerCase().replace(/[^a-z0-9]/g, "");
  let best = candidates[0] ?? spoken, bestD = Infinity;
  for (const c of candidates) {
    const d = lev(s, c.toLowerCase().replace(/[^a-z0-9]/g, ""));
    if (d < bestD) { bestD = d; best = c; }
  }
  return best;
}
function lev(a: string, b: string): number {
  const m = a.length, n = b.length; if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i), cur = new Array(n + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    [prev, cur] = [cur, prev];
  }
  return prev[n];
}

export function analyzeCombat(lines: LogLine[]): AarReport {
  const turns: TurnStat[] = [];
  const toolErrors: ToolError[] = [];
  const correctionsApplied: { from: string; to: string }[] = [];
  const clarMap = new Map<string, { candidates: string[]; count: number }>();
  let escalations = 0;

  for (const { msg } of lines) {
    let m: RegExpMatchArray | null;

    if ((m = msg.match(/\[agent\] turn DONE (\d+)ms, (\d+) steps/))) {
      const steps = Number(m[2]);
      turns.push({ ms: Number(m[1]), steps, struggled: steps > STRUGGLE_STEPS });
      continue;
    }
    if (/↑escalate/.test(msg)) { escalations++; continue; }
    if ((m = msg.match(/\[correct\] "(.*?)" → "(.*?)"/))) {
      correctionsApplied.push({ from: m[1], to: m[2] }); continue;
    }
    // Ambiguous-target clarifications surface in tool results / agent prose.
    if ((m = msg.match(/[Aa]mbiguous target "(.+?)"\.?\s*Did you mean:?\s*([^?]+)\??/))) {
      const spoken = m[1].toLowerCase().trim();
      const candidates = m[2].split(/,|\bor\b/).map((s) => s.trim()).filter(Boolean);
      const e = clarMap.get(spoken) ?? { candidates, count: 0 };
      e.count++; e.candidates = candidates.length ? candidates : e.candidates;
      clarMap.set(spoken, e);
      continue;
    }
    // Tool errors (logged with ✓ but carrying an error payload, e.g. MCP validation).
    if ((m = msg.match(/\[agent\] tool [✓✗⚠] (\w+): (.+)/)) && ERROR_HINT.test(m[2])) {
      toolErrors.push({ tool: m[1], detail: m[2].slice(0, 120) });
    }
  }

  const clarifications: Clarification[] = [...clarMap.entries()].map(([spoken, e]) => ({ spoken, candidates: e.candidates }));
  const proposals: CorrectionProposal[] = [...clarMap.entries()]
    .map(([spoken, e]) => ({
      spoken,
      suggested: bestCandidate(spoken, e.candidates),
      candidates: e.candidates,
      reason: "ambiguous target — the agent couldn't resolve this spoken name",
      count: e.count,
    }))
    .sort((a, b) => b.count - a.count); // most-recurring first (the rerank default)

  const totalSteps = turns.reduce((s, t) => s + t.steps, 0);
  return {
    turns: turns.length,
    totalSteps,
    avgSteps: turns.length ? Math.round((totalSteps / turns.length) * 10) / 10 : 0,
    struggledTurns: turns.filter((t) => t.struggled),
    toolErrors,
    escalations,
    correctionsApplied,
    clarifications,
    proposals,
  };
}

export function renderReport(r: AarReport): string {
  const L: string[] = ["# After-Action Review", ""];
  L.push(`**Turns:** ${r.turns} · **avg ${r.avgSteps} steps/turn** · ${r.escalations} escalation(s)`);
  if (r.struggledTurns.length) {
    L.push("", `**Struggled turns** (> ${STRUGGLE_STEPS} steps):`);
    for (const t of r.struggledTurns) L.push(`- ${t.steps} steps, ${t.ms}ms`);
  }
  if (r.toolErrors.length) {
    L.push("", "**Tool errors:**");
    for (const e of r.toolErrors) L.push(`- \`${e.tool}\` — ${e.detail}`);
  }
  if (r.correctionsApplied.length) {
    L.push("", `**STT corrections applied:** ${r.correctionsApplied.length}`);
    for (const c of r.correctionsApplied.slice(0, 10)) L.push(`- "${c.from}" → "${c.to}"`);
  }
  if (r.proposals.length) {
    L.push("", "**Proposed learned corrections** (accept in the Training panel):");
    for (const p of r.proposals) L.push(`- "${p.spoken}" → **${p.suggested}** ${p.candidates.length > 1 ? `(or ${p.candidates.filter((c) => c !== p.suggested).join(", ")})` : ""} ×${p.count}`);
  } else {
    L.push("", "_No clarifications to learn from — clean combat._");
  }
  return L.join("\n");
}

// Run the AAR end to end: analyze the last combat in hud.log, write a dated report,
// return the structured report (the Training panel consumes report.proposals).
export function runAar(slug: string): AarReport {
  const report = analyzeCombat(combatWindow(loadHudLog()));
  try {
    const dir = path.join(CONFIG.dataDir, "aar");
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    fs.writeFileSync(path.join(dir, `${slug || "session"}-${stamp}.md`), renderReport(report), "utf-8");
  } catch { /* best-effort write */ }
  return report;
}
