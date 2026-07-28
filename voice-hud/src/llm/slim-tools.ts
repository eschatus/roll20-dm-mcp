// Slim tool specs for the LOCAL model path.
//
// The served schemas carry two kinds of weight a locally-served small model
// doesn't need to pay for:
//   1. Serialization noise — Zod stamps maximum: Number.MAX_SAFE_INTEGER onto
//      every integer, shipping a meaningless 16-digit literal dozens of times.
//   2. Defensive prose — the v0.1.5 anti- -32602 armor ("a bare NUMBER —
//      damage:39, never damage:\"39\"", worked examples per param). On the
//      local path arg shape is enforced structurally (grammar/constrained
//      decoding + the terse local prompt's JSON rules), so the warnings are
//      redundant; descriptions keep only their FIRST sentence (the semantic
//      one — conventions put the meaning first, the enforcement after).
//
// The CLOUD path must keep the verbose descriptions — they are the producer-side
// fix that took Haiku to 100% shape-valid, and nothing enforces shape there.
import { ToolSpec } from "./provider";

const ZOD_INT_MAX = 9007199254740991; // Number.MAX_SAFE_INTEGER as Zod emits it

// Drop shape-ENFORCEMENT sentences (the anti- -32602 armor: "never damage:\"39\"",
// "Do NOT invent…") but KEEP semantic ones — many descriptions lead with a bark
// ("USE THIS.") and put the actual meaning second, so first-sentence truncation
// destroys them (measured: 7B → 0% golden when it lost the param semantics).
const ENFORCEMENT = /\bnever\b|\bdo not\b|\bdon't\b|\bmust be\b|not a string|stringified/i;
function slimText(s: string): string {
  const sentences = s.split(/(?<=[.!?])\s+/);
  const kept = sentences.filter((x) => !ENFORCEMENT.test(x)).slice(0, 2);
  return (kept.length ? kept : sentences.slice(0, 1)).join(" ").trim();
}

function slimSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(slimSchema);
  if (node === null || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (k === "maximum" && v === ZOD_INT_MAX) continue;
    if (k === "$schema") continue;
    if (k === "description" && typeof v === "string") { out[k] = slimText(v); continue; }
    out[k] = slimSchema(v);
  }
  return out;
}

export function slimToolSpecs(specs: ToolSpec[]): ToolSpec[] {
  return specs.map((t) => ({
    name: t.name,
    description: slimText(t.description ?? ""),
    parameters: slimSchema(t.parameters) as ToolSpec["parameters"],
  }));
}
