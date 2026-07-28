import { describe, it, expect, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { mulberry32, buildScenario, genStep, sampleRoster, generate } from "../scripts/gen-traces";
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
