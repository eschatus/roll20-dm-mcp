// LLM-as-judge helper for the subjective narration rules (N4/N5/N6) that have no
// structural signal — "doesn't balloon into a scene", "refuses to over-narrate",
// "terse round-end". A second model grades an OUTPUT against a binary RULE.
//
// The model call is injected (AskFn) so the parsing + k-of-n threshold logic is
// unit-tested hermetically (judge.test.ts, a per-PR gate) while the real judging
// is opt-in (narration-judge-eval.test.ts). Binary verdicts + temperature 0 keep
// the judge as stable as an LLM gets; majority voting absorbs the residual wobble.

import Anthropic from "@anthropic-ai/sdk";

export interface Verdict {
  pass: boolean;
  reason: string;
}

/** Abstracts the model call: (system, user) → raw text. */
export type AskFn = (system: string, user: string) => Promise<string>;

const JUDGE_SYSTEM =
  "You are a strict test judge for a D&D voice assistant. Decide whether an OUTPUT " +
  "obeys a RULE. Be literal and conservative: if the OUTPUT clearly violates the " +
  "RULE, fail it. Reply with ONLY a compact JSON object and nothing else: " +
  '{"pass": <true|false>, "reason": "<one short sentence>"}.';

/** Real Anthropic judge call — temperature 0, small model, tight output. */
export function anthropicAsk(model = process.env.DMW_JUDGE_MODEL || "claude-haiku-4-5"): AskFn {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return async (system, user) => {
    const res = await client.messages.create({
      model,
      max_tokens: 200,
      temperature: 0,
      system,
      messages: [{ role: "user", content: user }],
    });
    return res.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
  };
}

/** Pull the first JSON object out of a raw judge reply and normalize it. */
export function parseVerdict(raw: string): Verdict {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("judge returned no JSON object: " + raw.slice(0, 160));
  const obj = JSON.parse(m[0]) as { pass?: unknown; reason?: unknown };
  if (typeof obj.pass !== "boolean") throw new Error("judge verdict missing boolean 'pass': " + m[0].slice(0, 160));
  return { pass: obj.pass, reason: String(obj.reason ?? "") };
}

/** Single judgment of one OUTPUT against one RULE. */
export async function judge(rule: string, output: string, ask: AskFn): Promise<Verdict> {
  const user =
    `RULE:\n${rule}\n\n` +
    `OUTPUT TO GRADE:\n"""${output}"""\n\n` +
    "Does the OUTPUT obey the RULE? Reply with JSON only.";
  return parseVerdict(await ask(JUDGE_SYSTEM, user));
}

export interface MajorityVerdict {
  pass: boolean;
  passes: number;
  total: number;
  reasons: string[];
}

/**
 * k-of-n majority vote for the fuzziest rules. `pass` iff strictly more than half
 * the samples pass. Use for N5-style judgments where a lone sample can wobble.
 */
export async function judgeMajority(rule: string, output: string, ask: AskFn, n = 3): Promise<MajorityVerdict> {
  const verdicts = await Promise.all(Array.from({ length: n }, () => judge(rule, output, ask)));
  const passes = verdicts.filter((v) => v.pass).length;
  return { pass: passes * 2 > n, passes, total: n, reasons: verdicts.map((v) => v.reason) };
}
