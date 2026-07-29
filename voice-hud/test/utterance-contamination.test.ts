// Contamination guard: the 13 utterances in scripts/eval-golden.ts's SCENARIO are the
// HELD-OUT test set for the SFT experiment. If the corpus generator ever renders one of
// them verbatim, every golden-suite score after that is train-on-test and meaningless.
//
// This test regenerates a slice of the corpus and asserts no exact (normalized) overlap.
// It also guards the rendering defects found by hand-inspection: a "flavored" hit with no
// attacker ("cracks Glint — that's 12 cold"), a doubled connector ("and and stunned
// sticks"), and gendered pronouns the board has no basis for.
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();

function goldenUtterances(): string[] {
  const src = fs.readFileSync(path.join(__dirname, "..", "scripts", "eval-golden.ts"), "utf8");
  // SCENARIO steps carry `utterance: "..."` (single-line string literals).
  return [...src.matchAll(/^\s*utterance:\s*"((?:[^"\\]|\\.)*)"/gm)].map((m) => m[1].replace(/\\"/g, '"'));
}

function generate(seed: number, scenarios: number): string[] {
  const out = path.join(process.env.TEMP || "/tmp", `contam-${seed}.jsonl`);
  execFileSync("npx", ["tsx", path.join(__dirname, "..", "scripts", "gen-traces.ts"),
    "--seed", String(seed), "--scenarios", String(scenarios), "--mode", "gold", "--out", out],
    { env: { ...process.env, DMW_GEN_DRY: "1" }, stdio: "pipe", shell: true });
  return fs.readFileSync(out, "utf8").trim().split("\n").filter(Boolean).map((l) => {
    const r = JSON.parse(l);
    const u = (r.messages || []).filter((m: { role: string }) => m.role === "user").pop();
    return ((u && u.content) || "").split("\n").pop().trim();
  });
}

describe("corpus utterance quality", () => {
  const held = goldenUtterances().map(norm).filter(Boolean);
  const utts = generate(101, 12);

  it("extracts the held-out golden utterances", () => {
    expect(held.length).toBeGreaterThanOrEqual(10);
  });

  it("never reproduces a DISTINCTIVE held-out golden-suite utterance verbatim", () => {
    // Protocol tokens ("Failed.", "Passed.", "Next turn.") necessarily appear in both —
    // they're the one-word answers the interaction contract is built on, and they leak
    // nothing: the model still has to infer WHICH token to act on from board state. Only
    // multi-word, content-bearing utterances constitute real train-on-test leakage.
    const distinctive = new Set(held.filter((h) => h.split(" ").length >= 3));
    const overlap = utts.filter((u) => distinctive.has(norm(u)));
    expect(overlap).toEqual([]);
  });

  it("emits no subjectless flavored fragments", () => {
    // A hit clause must not OPEN with the verb — that's the missing-attacker bug.
    const verbFirst = utts.filter((u) => /^(cracks|carves into|tears into|slams into|rips into|catches|buries a strike in|lands a solid hit on|hurls damage at)\b/i.test(u));
    expect(verbFirst).toEqual([]);
  });

  it("emits no doubled connectors", () => {
    expect(utts.filter((u) => /\b(and|but)\s+\1\b/i.test(u))).toEqual([]);
  });

  it("assumes no gender for board tokens", () => {
    // The board carries no gender; rendered condition//damage clauses must stay neutral.
    // (DM-voice "he drops" in fudge templates is fine — this targets the generated
    // condition clauses specifically.)
    expect(utts.filter((u) => /\b(he's|she's) (knocked|poisoned|stunned|frightened|restrained)\b/i.test(u))).toEqual([]);
  });
});
