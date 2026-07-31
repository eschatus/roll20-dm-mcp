// Gate-2 session instrumentation — the live agent's structured, replayable
// event stream (events.jsonl). Regression guard for the four fixes called out
// in toolEvents.ts's header: full-fidelity args/results, true ok/error,
// loop-tags kept out of the tool-event stream, and repairOf linkage — plus the
// pre-turn snapshot's soft-fail contract and numbered rotation.
//
// aar.test.ts (unchanged) is the regression guard that the PROSE lines these
// features sit alongside still parse correctly.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import type { Roll20McpLike } from "../src/agent";

describe("Gate-2 session instrumentation", () => {
  let dataDir: string;
  let logger: typeof import("../src/logger");
  let toolEvents: typeof import("../src/toolEvents");
  let snapshot: typeof import("../src/snapshot");
  const prevDataDir = process.env.DMW_DATA_DIR;

  beforeEach(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dmw-events-"));
    process.env.DMW_DATA_DIR = dataDir;
    // Fresh module instances per test: logger.ts reads DMW_DATA_DIR (and caches
    // an open write stream) at first use, so each test needs its own isolated
    // data dir + its own module graph. resetModules() + re-import gives every
    // test a clean logger (and, since toolEvents/snapshot import it statically,
    // they resolve to that same fresh instance).
    vi.resetModules();
    logger = await import("../src/logger");
    toolEvents = await import("../src/toolEvents");
    snapshot = await import("../src/snapshot");
  });

  afterEach(() => {
    if (prevDataDir === undefined) delete process.env.DMW_DATA_DIR;
    else process.env.DMW_DATA_DIR = prevDataDir;
  });

  function eventsPath(): string { return path.join(dataDir, "events.jsonl"); }
  function readEvents(): Array<Record<string, unknown>> {
    if (!fs.existsSync(eventsPath())) return [];
    return fs.readFileSync(eventsPath(), "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  }

  // -------------------------------------------------------------------------
  // #1 — structured tool events: full round-trip + the 8KB cap
  // -------------------------------------------------------------------------
  describe("structured tool events", () => {
    it("round-trips FULL args (no 77-char console truncation)", () => {
      const args = { tokenId: "-Nabc123def456", hp: -12, reason: "fireball splash damage to the back row" };
      toolEvents.emitToolEvent({ turnId: "t-1", seq: 1, tool: "update_token_hp", args, ok: true, durMs: 42, resultText: "HP set to 18" });

      const [rec] = readEvents();
      expect(rec.kind).toBe("tool");
      expect(rec.turnId).toBe("t-1");
      expect(rec.seq).toBe(1);
      expect(rec.tool).toBe("update_token_hp");
      expect(rec.args).toEqual(args); // the whole thing, not a 77-char slice
      expect(rec.argsTruncated).toBeUndefined();
      expect(rec.ok).toBe(true);
      expect(rec.durMs).toBe(42);
      expect(rec.resultPreview).toBe("HP set to 18");
    });

    it("caps args at ~8KB and sets argsTruncated:true on overflow", () => {
      const huge = { ops: Array.from({ length: 3000 }, (_, i) => `token-${i}-set-hp-and-condition`) };
      toolEvents.emitToolEvent({ turnId: "t-2", seq: 1, tool: "batch_exec", args: huge, ok: true, durMs: 5, resultText: "ok" });

      const [rec] = readEvents();
      expect(rec.argsTruncated).toBe(true);
      expect(typeof rec.args).toBe("string");
      expect((rec.args as string).length).toBeLessThanOrEqual(8 * 1024);
    });

    it("small args are NOT flagged truncated", () => {
      toolEvents.emitToolEvent({ turnId: "t-3", seq: 1, tool: "roll_dice", args: { formula: "2d6+3" }, ok: true, durMs: 5, resultText: "9" });
      expect(readEvents()[0].argsTruncated).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // #2 — success/failure lie, fixed
  // -------------------------------------------------------------------------
  describe("success/failure detection", () => {
    it("isToolError recognizes an MCP error result", () => {
      expect(toolEvents.isToolError("MCP error -32602: Input validation error")).toBe(true);
      expect(toolEvents.isToolError("HP set to 18")).toBe(false);
    });

    it("isToolError also catches failures with no numbered MCP code", () => {
      // agent.ts's own throw path, and McpRoll20.call()'s flattened isError text.
      expect(toolEvents.isToolError("ERROR: MCP client not connected")).toBe(true);
      expect(toolEvents.isToolError("Error: request timed out")).toBe(true);
      expect(toolEvents.isToolError("Token 'Strahd' not found")).toBe(true);
      expect(toolEvents.isToolError("anything", true)).toBe(true);
      // A success whose payload merely mentions the word deeper in stays ok.
      expect(toolEvents.isToolError("Narration sent\nThe ritual failed, said the DM")).toBe(false);
      expect(toolEvents.isToolError("(cancelled)")).toBe(false);
    });

    it("resultGlyph picks ✗ for a failure, ✓ for success — this is what the live prose line now uses", () => {
      expect(toolEvents.resultGlyph("MCP error -32601: Method not found")).toBe("✗");
      expect(toolEvents.resultGlyph("HP set to 18")).toBe("✓");
    });

    it("an MCP-error result produces ok:false + a captured error field in the structured event", () => {
      const resultText = "MCP error -32602: Input validation error: hp must be a number";
      const ok = !toolEvents.isToolError(resultText);
      toolEvents.emitToolEvent({ turnId: "t-4", seq: 1, tool: "update_token_hp", args: { hp: "twelve" }, ok, durMs: 8, resultText });

      const [rec] = readEvents();
      expect(rec.ok).toBe(false);
      expect(rec.error).toContain("MCP error -32602");
    });

    it("a successful result carries ok:true and no error field", () => {
      const resultText = "HP set to 18";
      toolEvents.emitToolEvent({ turnId: "t-5", seq: 1, tool: "update_token_hp", args: { hp: 18 }, ok: !toolEvents.isToolError(resultText), durMs: 3, resultText });
      const [rec] = readEvents();
      expect(rec.ok).toBe(true);
      expect(rec.error).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // #3 — loop-control tags never masquerade as tool events
  // -------------------------------------------------------------------------
  describe("loop-control tags", () => {
    it("parseLoopTag recognizes the exact names agent.ts emits", () => {
      expect(toolEvents.parseLoopTag("↻persist")).toBe("persist");
      expect(toolEvents.parseLoopTag("↻complete")).toBe("complete");
      expect(toolEvents.parseLoopTag("↑escalate")).toBe("escalate");
      expect(toolEvents.parseLoopTag("update_token_hp")).toBeNull();
    });

    it("emitLoopEvent writes kind:\"loop\", never kind:\"tool\"", () => {
      toolEvents.emitLoopEvent("t-6", "persist");
      toolEvents.emitLoopEvent("t-6", "escalate", "t-5");

      const recs = readEvents();
      expect(recs).toHaveLength(2);
      for (const r of recs) {
        expect(r.kind).toBe("loop");
        expect(r.tool).toBeUndefined(); // never shaped like a tool-event record
      }
      expect(recs[0].tag).toBe("persist");
      expect(recs[1].tag).toBe("escalate");
      expect(recs[1].repairOf).toBe("t-5");
    });

    it("a mixed sequence of real tools + loop tags separates cleanly by kind", () => {
      toolEvents.emitToolEvent({ turnId: "t-7", seq: 1, tool: "get_turn_order", args: {}, ok: true, durMs: 10, resultText: "[]" });
      toolEvents.emitLoopEvent("t-7", "persist");
      toolEvents.emitToolEvent({ turnId: "t-7", seq: 2, tool: "update_token_hp", args: { hp: 5 }, ok: true, durMs: 12, resultText: "ok" });

      const recs = readEvents();
      const tools = recs.filter((r) => r.kind === "tool");
      const loops = recs.filter((r) => r.kind === "loop");
      expect(tools.map((t) => t.tool)).toEqual(["get_turn_order", "update_token_hp"]);
      expect(loops).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // #4 — repairOf linkage
  // -------------------------------------------------------------------------
  describe("repairOf linkage", () => {
    it("links a turn that starts 10s after a FAILED prior turn", () => {
      const prev = { turnId: "turn-A", endTs: 100_000, mcpErrorCount: 1, statesOutcome: false, mutations: 0 };
      expect(toolEvents.isRepairOf(prev, 100_000 + 10_000, 45)).toBe(true);
    });

    it("does NOT link when the gap exceeds the window (120s > 45s)", () => {
      const prev = { turnId: "turn-A", endTs: 100_000, mcpErrorCount: 1, statesOutcome: false, mutations: 0 };
      expect(toolEvents.isRepairOf(prev, 100_000 + 120_000, 45)).toBe(false);
    });

    it("does NOT link even within the window if the prior turn did not fail", () => {
      const prev = { turnId: "turn-A", endTs: 100_000, mcpErrorCount: 0, statesOutcome: true, mutations: 3 };
      expect(toolEvents.isRepairOf(prev, 100_000 + 5_000, 45)).toBe(false);
    });

    it("turnFailed: a stated outcome with zero mutations is a Failure-A flake", () => {
      expect(toolEvents.turnFailed({ mcpErrorCount: 0, statesOutcome: true, mutations: 0 })).toBe(true);
      expect(toolEvents.turnFailed({ mcpErrorCount: 0, statesOutcome: true, mutations: 2 })).toBe(false);
      expect(toolEvents.turnFailed({ mcpErrorCount: 2, statesOutcome: false, mutations: 5 })).toBe(true);
      expect(toolEvents.turnFailed({ mcpErrorCount: 0, statesOutcome: false, mutations: 0 })).toBe(false);
    });

    it("respects a custom window", () => {
      const prev = { turnId: "turn-A", endTs: 0, mcpErrorCount: 1, statesOutcome: false, mutations: 0 };
      expect(toolEvents.isRepairOf(prev, 89_000, 90)).toBe(true);
      expect(toolEvents.isRepairOf(prev, 91_000, 90)).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // #5 — pre-turn snapshot: soft failure
  // -------------------------------------------------------------------------
  describe("board snapshot", () => {
    it("captures a compact board from tokens/turn-order/zones reads", async () => {
      const fakeMcp: Roll20McpLike = {
        getTools: () => [],
        call: async (name) => {
          if (name === "list_tokens") return JSON.stringify([{ id: "-tok1", name: "Strahd", controlledby: "", hp: 144, statusmarkers: "", layer: "objects" }]);
          if (name === "get_turn_order") return JSON.stringify([{ id: "-tok1", pr: 20 }]);
          if (name === "list_zones") return JSON.stringify([]);
          return "{}";
        },
      };
      const board = await snapshot.captureBoardSnapshot(fakeMcp);
      expect(board.tokens).toEqual([{ id: "-tok1", name: "Strahd", controlledby: "", hp: 144, statusmarkers: "", layer: "objects" }]);
      expect(board.turnOrder).toEqual([{ id: "-tok1", pr: 20 }]);
      expect(board.zones).toEqual([]);
    });

    it("a stalled read rejects at the timeout instead of holding the turn", async () => {
      const hangingMcp: Roll20McpLike = {
        getTools: () => [],
        call: () => new Promise<string>(() => { /* never settles */ }),
      };
      const t0 = Date.now();
      await expect(snapshot.captureBoardSnapshot(hangingMcp, 30)).rejects.toThrow(/timed out after 30ms/);
      expect(Date.now() - t0).toBeLessThan(2000);
    });

    it("a throwing client rejects captureBoardSnapshot — the CALLER's catch is what makes the turn continue (soft fail)", async () => {
      const throwingMcp: Roll20McpLike = {
        getTools: () => [],
        call: async () => { throw new Error("RTDB timeout"); },
      };

      let caught: string | undefined;
      // Mirrors main.ts's runAgent: snapshot capture wrapped in its own try/catch
      // so a broken read is logged and swallowed, never allowed to break the turn.
      try {
        const board = await snapshot.captureBoardSnapshot(throwingMcp);
        toolEvents.emitSnapshotEvent("t-8", board, 3);
      } catch (e) {
        caught = (e as Error).message;
        toolEvents.emitSnapshotEvent("t-8", null, 3, { error: caught });
      }
      // Execution reached past the catch — the turn "continues" (nothing rethrown).
      expect(caught).toBe("RTDB timeout");

      const [rec] = readEvents();
      expect(rec.kind).toBe("snapshot");
      expect(rec.board).toBeNull();
      expect(rec.error).toBe("RTDB timeout");
      expect(typeof rec.ms).toBe("number");
    });

    it("a successful snapshot is timed and carries no error", () => {
      toolEvents.emitSnapshotEvent("t-9", { tokens: [], turnOrder: [], zones: [] }, 47);
      const [rec] = readEvents();
      expect(rec.ms).toBe(47);
      expect(rec.error).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // #6 — size management: numbered rotation, NOT the single-.1-overwrite logger.ts
  // uses for the other three channels (that would silently drop generations here).
  // -------------------------------------------------------------------------
  describe("events.jsonl rotation", () => {
    it("keeps numbered generations (.1 newest .. N oldest) instead of overwriting a single .1", () => {
      const p = eventsPath();
      // Seed an over-limit base file plus a full set of existing generations.
      fs.writeFileSync(p, "x".repeat(6 * 1024 * 1024));
      for (let i = 1; i <= 5; i++) fs.writeFileSync(`${p}.${i}`, `gen-${i}`);

      toolEvents.emitToolEvent({ turnId: "t-10", seq: 1, tool: "roll_dice", args: {}, ok: true, durMs: 1, resultText: "ok" });

      // Oldest generation (gen-5) is dropped; everything else shifts by one.
      expect(fs.existsSync(`${p}.6`)).toBe(false);
      expect(fs.readFileSync(`${p}.2`, "utf-8")).toBe("gen-1");
      expect(fs.readFileSync(`${p}.3`, "utf-8")).toBe("gen-2");
      expect(fs.readFileSync(`${p}.4`, "utf-8")).toBe("gen-3");
      expect(fs.readFileSync(`${p}.5`, "utf-8")).toBe("gen-4");
      // The oversized base became .1 (NOT dropped — this is the data-loss bug
      // logger.ts's other channels have today, fixed here).
      expect(fs.readFileSync(`${p}.1`, "utf-8").length).toBe(6 * 1024 * 1024);
      // New content lands in a fresh base file.
      const rec = JSON.parse(fs.readFileSync(p, "utf-8").trim());
      expect(rec.tool).toBe("roll_dice");
    });
  });
});
