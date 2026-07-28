import { describe, it, expect, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { mulberry32, buildScenario, genStep, sampleRoster, generate, AXES } from "../scripts/gen-traces";
import { stubExec as stubExecFor } from "../scripts/golden-lib";

// DMW_GEN_DRY plumbing smoke test — runs the real sampler + grader + JSONL writer
// against a scripted fake teacher (GeneratedStep.ideal), so no Ollama/MCP server is
// required. Covers: seeded reproducibility, scenario/roster sampling, the threaded
// stub-execution + grading loop, and the accepted/rejects JSONL split.

describe("mulberry32", () => {
  it("is deterministic for a given seed", () => {
    const a = mulberry32(42), b = mulberry32(42);
    const seqA = Array.from({ length: 5 }, () => a());
    const seqB = Array.from({ length: 5 }, () => b());
    expect(seqA).toEqual(seqB);
  });
  it("different seeds diverge", () => {
    const a = mulberry32(1)(), b = mulberry32(2)();
    expect(a).not.toBe(b);
  });
});

describe("sampleRoster", () => {
  it("builds a reproducible roster of 4-10 tokens with at least one PC", () => {
    const rng = mulberry32(7);
    const board = sampleRoster(rng);
    expect(board.tokens.length).toBeGreaterThanOrEqual(3);
    expect(board.tokens.length).toBeLessThanOrEqual(10);
    expect(board.tokens.some((t) => t.klass === "pc")).toBe(true);
    expect(board.turnorder.length).toBe(board.tokens.length);
  });
});

describe("buildScenario + genStep", () => {
  it("samples a 5-12 step count, and genStep produces valid steps drawn from the calibrated axes", () => {
    const rng = mulberry32(3);
    const { board, stepCount } = buildScenario(rng);
    expect(stepCount).toBeGreaterThanOrEqual(5);
    expect(stepCount).toBeLessThanOrEqual(12);
    const state = { round: 1, usedAxes: {} as Record<string, number> };
    let produced = 0;
    for (let i = 0; i < stepCount; i++) {
      const s = genStep(rng, board, state);
      if (!s) continue;
      produced++;
      expect(s.utterance.length).toBeGreaterThan(0);
      expect(typeof s.check).toBe("function");
      expect(Array.isArray(s.ideal)).toBe(true);
      // Immediately "execute" the step's ideal tool calls against the SAME board so the
      // next genStep() call sees live state — mirrors what generate()'s real loop does.
      for (const turn of s.ideal) for (const c of turn.toolCalls) stubExecFor(c.name, c.args, board);
    }
    expect(produced).toBeGreaterThan(0);
  });

  it("is fully reproducible for the same seed (utterance sequence)", () => {
    const runOnce = (seed: number) => {
      const rng = mulberry32(seed);
      const { board, stepCount } = buildScenario(rng);
      const state = { round: 1, usedAxes: {} as Record<string, number> };
      const utterances: string[] = [];
      for (let i = 0; i < stepCount; i++) {
        const s = genStep(rng, board, state);
        if (!s) continue;
        utterances.push(s.utterance);
        for (const turn of s.ideal) for (const c of turn.toolCalls) stubExecFor(c.name, c.args, board);
      }
      return utterances;
    };
    expect(runOnce(9)).toEqual(runOnce(9));
  });
});

describe("generate (DMW_GEN_DRY plumbing)", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gen-traces-test-"));
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it("runs scenarios end-to-end with a scripted fake teacher and writes valid JSONL", async () => {
    const outPath = path.join(tmpDir, "traces.jsonl");
    const rejectsPath = path.join(tmpDir, "traces.rejects.jsonl");
    const summary = await generate({
      seed: 1, scenarios: 2, outPath, rejectsPath,
      dry: true, provider: "ollama", model: "scripted-fake",
    });

    // The scripted teacher answers every step with its own "ideal" (correct-by-
    // construction) response, so acceptance should be total.
    expect(summary.accepted).toBeGreaterThan(0);
    expect(summary.rejected).toBe(0);
    expect(fs.existsSync(outPath)).toBe(true);
    expect(fs.existsSync(rejectsPath)).toBe(true);

    const lines = fs.readFileSync(outPath, "utf-8").trim().split("\n").filter(Boolean);
    expect(lines.length).toBe(summary.accepted);

    for (const line of lines) {
      const rec = JSON.parse(line);
      expect(Array.isArray(rec.messages)).toBe(true);
      expect(rec.messages[0].role).toBe("system");
      expect(rec.messages.some((m: { role: string }) => m.role === "user")).toBe(true);
      expect(Array.isArray(rec.tools)).toBe(true);
      expect(rec.tools.length).toBeGreaterThan(0);
      expect(typeof rec.meta.scenarioId).toBe("number");
      expect(typeof rec.meta.axis).toBe("string");
      expect(typeof rec.meta.stepIdx).toBe("number");
      expect(typeof rec.meta.latencyMs).toBe("number");
      expect(rec.meta.seed).toBe(1);
    }

    // Rejects file exists but should be empty (scripted teacher never fails its own grader).
    const rejLines = fs.readFileSync(rejectsPath, "utf-8").trim();
    expect(rejLines).toBe("");
  });

  it("is byte-identical across two runs with the same seed", async () => {
    const outA = path.join(tmpDir, "a.jsonl"), rejA = path.join(tmpDir, "a.rej.jsonl");
    const outB = path.join(tmpDir, "b.jsonl"), rejB = path.join(tmpDir, "b.rej.jsonl");
    await generate({ seed: 5, scenarios: 2, outPath: outA, rejectsPath: rejA, dry: true, provider: "ollama", model: "scripted-fake" });
    await generate({ seed: 5, scenarios: 2, outPath: outB, rejectsPath: rejB, dry: true, provider: "ollama", model: "scripted-fake" });
    // Strip latencyMs (wall-clock, not seed-determined) before comparing.
    const strip = (p: string) => fs.readFileSync(p, "utf-8").split("\n").filter(Boolean)
      .map((l) => { const r = JSON.parse(l); r.meta.latencyMs = 0; return r; });
    expect(strip(outA)).toEqual(strip(outB));
  });
});

// ── --mode gold ─────────────────────────────────────────────────────────────
// Gold trajectories are built from each step template's own ground truth (no teacher
// model, no network), executed through the SAME stub executor, then SELF-TESTED with
// the template's check(). These tests are the standing guard against template rot: if
// a convention changes on one side of a template and not the other, the self-test
// fails here rather than quietly poisoning the training corpus.

interface GoldRec {
  messages: { role: string; content: string | null; tool_calls?: unknown[] }[];
  tools: unknown[];
  meta: { scenarioId: number; seed: number; axis: string; stepIdx: number; latencyMs: number; mode: string };
}

describe("generate --mode gold", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gen-traces-gold-"));
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  const runGold = async (tag: string, seed = 1, scenarios = 20) => {
    const outPath = path.join(tmpDir, `${tag}.jsonl`);
    const rejectsPath = path.join(tmpDir, `${tag}.rejects.jsonl`);
    const summary = await generate({
      seed, scenarios, outPath, rejectsPath,
      dry: true, provider: "ollama", model: "none", mode: "gold",
    });
    const recs: GoldRec[] = fs.readFileSync(outPath, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    return { summary, recs, outPath, rejectsPath };
  };

  it("passes every axis's own check() — a failure here is a GENERATOR bug, not a model miss", async () => {
    const { summary, rejectsPath } = await runGold("selftest");
    // The loud-failure contract: nothing is silently dropped, so any rot shows up as
    // both a non-empty goldFailures list AND a non-empty rejects file.
    expect(summary.goldFailures).toEqual([]);
    expect(summary.rejected).toBe(0);
    expect(fs.readFileSync(rejectsPath, "utf-8").trim()).toBe("");
    expect(summary.accepted).toBeGreaterThan(100);
  });

  it("covers every calibrated axis at seed 1 / 20 scenarios", async () => {
    const { summary } = await runGold("coverage");
    for (const [axis] of AXES) {
      expect(summary.accByAxis[axis], `axis "${axis}" produced no gold trajectories`).toBeGreaterThan(0);
    }
  });

  it("is byte-identical across two runs with the same seed", async () => {
    const a = await runGold("detA", 3, 8);
    const b = await runGold("detB", 3, 8);
    // No latency stripping needed: gold records carry latencyMs 0 by construction.
    expect(fs.readFileSync(a.outPath, "utf-8")).toBe(fs.readFileSync(b.outPath, "utf-8"));
    expect(a.summary.accByAxis).toEqual(b.summary.accByAxis);
  });

  it("emits ZERO tool calls on pure negative-space steps", async () => {
    const { summary, recs } = await runGold("negspace");
    const flavor = recs.filter((r) => r.meta.axis === "pure-flavor");
    expect(flavor.length).toBeGreaterThan(0);
    for (const r of flavor) {
      // Only the messages appended by THIS step matter — earlier steps in the same
      // scenario share the conversation prefix and legitimately carry tool calls.
      const lastUser = r.messages.map((m) => m.role).lastIndexOf("user");
      const thisStep = r.messages.slice(lastUser);
      expect(thisStep.some((m) => m.role === "tool")).toBe(false);
      expect(thisStep.some((m) => (m.tool_calls?.length ?? 0) > 0)).toBe(false);
      // …and it still closes with a GM-facing report line rather than silence.
      const closing = thisStep[thisStep.length - 1];
      expect(closing.role).toBe("assistant");
      expect(String(closing.content ?? "").length).toBeGreaterThan(0);
    }
    expect(summary.zeroCallRecords).toBeGreaterThanOrEqual(flavor.length);
  });

  it("writes JSONL with the training record shape, tagged meta.mode=gold", async () => {
    const { recs } = await runGold("shape");
    expect(recs.length).toBeGreaterThan(0);
    for (const rec of recs) {
      expect(Array.isArray(rec.messages)).toBe(true);
      expect(rec.messages[0].role).toBe("system");
      expect(rec.messages.some((m) => m.role === "user")).toBe(true);
      expect(rec.messages[rec.messages.length - 1].role).toBe("assistant");
      expect(Array.isArray(rec.tools)).toBe(true);
      expect(rec.tools.length).toBeGreaterThan(0);
      expect(rec.meta.mode).toBe("gold");
      expect(rec.meta.seed).toBe(1);
      expect(typeof rec.meta.axis).toBe("string");
      expect(typeof rec.meta.scenarioId).toBe("number");
      expect(typeof rec.meta.stepIdx).toBe("number");
      expect(rec.meta.latencyMs).toBe(0); // deterministic — no wall clock in a gold record
    }
  });

  it("prefers the ATOMIC tools over hand-chained primitives", async () => {
    const { recs } = await runGold("atomic");
    const callsFor = (axis: string) => recs.filter((r) => r.meta.axis === axis).flatMap((r) => {
      const lastUser = r.messages.map((m) => m.role).lastIndexOf("user");
      return r.messages.slice(lastUser).filter((m) => m.role === "tool").map((m) => (m as unknown as { name: string }).name);
    });
    // A dying PC is mark_dying, never set_token_marker×2; a dead NPC is kill_token,
    // never set_token_marker + set_token_props(layer).
    const drop = callsFor("drop-routing");
    expect(drop.length).toBeGreaterThan(0);
    expect(drop.every((n) => n === "mark_dying" || n === "kill_token")).toBe(true);
    expect(callsFor("fudge-drop").every((n) => n === "kill_token")).toBe(true);
    // Round boundary runs the zone countdown tool, not a guessed clear_zone.
    const rollover = callsFor("round-rollover");
    expect(rollover).toContain("advance_turn");
    expect(rollover).toContain("process_round_end_zones");
    expect(rollover).not.toContain("clear_zone");
    // Concentration teardown is one call, and only on a FAILED save.
    expect(callsFor("declarative-followup").every((n) => n === "break_concentration")).toBe(true);
    // Zone transitions are delete + create with a new material, never a modify.
    const trans = callsFor("zone-transition");
    expect(trans).toContain("clear_zone");
    expect(trans).toContain("create_zone");
  });
});
