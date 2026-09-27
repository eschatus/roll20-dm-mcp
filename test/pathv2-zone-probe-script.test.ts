// ─────────────────────────────────────────────────────────────────────────────
// src/recon/pathv2-zone-probe.ts driven OFFLINE: relayCommand goes to the emulator
// through roll20.__setBridgeTestTransport (the relay-fallback.test.ts seam) and the
// direct RTDB read (rtGet) is mocked, so each test decides what Roll20 "persisted".
//
// What this pins is the SCRIPT's logic, not Roll20's behaviour:
//   - verdicts come from the RTDB record, never the Mod's obj.get() echo, and a
//     disagreement between the two is reported as MISMATCH;
//   - a missing RTDB record is UNKNOWN, not a pass on the echo's say-so;
//   - any failed cleanup exits non-zero;
//   - --rm-last clears the relay's id stash.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Roll20Emulator } from "./roll20-emulator.js";
import * as roll20 from "../src/bridge/roll20.js";

const rtGet = vi.fn();
vi.mock("../src/bridge/roll20-rt.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/bridge/roll20-rt.js")>()),
  rtGet: (...a: unknown[]) => rtGet(...a),
}));

const { main } = await import("../src/recon/pathv2-zone-probe.js");

interface Variant { key: string; id?: string; stored?: Record<string, unknown>; storedAfterSet?: Record<string, unknown> }

let emu: Roll20Emulator;
let pageId: string;
let lastProbe: { variants: Variant[] } | null;
let failing: Set<string>;
let out: string[];

beforeEach(() => {
  emu = new Roll20Emulator({ seed: 222 });
  emu.load();
  pageId = emu.createPage("Probe", { width: 30, height: 30 });
  emu.setPlayerPage(pageId);
  lastProbe = null;
  failing = new Set();
  out = [];
  rtGet.mockReset();
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => { out.push(a.map(String).join(" ")); });
  roll20.__setBridgeTestTransport({
    relay: <T>(cmd: Record<string, unknown>) => {
      if (cmd.action === "removeObject" && failing.has(String(cmd.objectId))) {
        return Promise.reject(new Error("injected removal failure"));
      }
      const r = emu.relay<T>(cmd);
      if (cmd.action === "pathv2ZoneProbe" && !cmd.clearLast) lastProbe = r as unknown as { variants: Variant[] };
      return Promise.resolve(r);
    },
    evaluate: <T>(fn: (args?: unknown) => T, args?: unknown) => Promise.resolve(fn(args)),
  });
});

afterEach(() => {
  roll20.__setBridgeTestTransport(null);
  vi.restoreAllMocks();
});

/** RTDB answers with what the Mod echoed, minus `drop`ped fields — the "Mod says yes, record says no" case. */
function rtdbMirrorsModExcept(drop: string[] = []) {
  rtGet.mockImplementation(async (path: string) => {
    const id = path.split("/").pop();
    const v = lastProbe?.variants.find(x => x.id === id);
    if (!v) return null;
    const rec: Record<string, unknown> = { ...v.stored, ...(v.storedAfterSet ?? {}) };
    for (const k of drop) delete rec[k];
    return rec;
  });
}

const verdict = (q: string) => out.find(l => l.startsWith(q)) ?? "";

describe("pathv2-zone-probe script — verdicts from the RTDB record", () => {
  it("reports PERSISTED when the RTDB record agrees with the Mod echo", async () => {
    rtdbMirrorsModExcept();
    expect(await main([pageId])).toBe(0);
    expect(verdict("Q1 8-digit")).toMatch(/PERSISTED \(#aa00ff40\)/);
    expect(verdict("Q1 fill_opacity")).toMatch(/fill_opacity PERSISTED as 0\.25/);
    expect(verdict("Q3 name/gmnotes")).toMatch(/ARE carried/);
    expect(out.join("\n")).not.toMatch(/MISMATCH/);
  });

  it("does NOT trust the Mod echo when the RTDB record lacks the property — and says MISMATCH", async () => {
    rtdbMirrorsModExcept(["fill_opacity", "name", "gmnotes"]);
    expect(await main([pageId])).toBe(0);
    expect(verdict("Q1 fill_opacity")).toMatch(/did NOT persist/);
    expect(verdict("Q1 fill_opacity")).toMatch(/MISMATCH: Mod echoes fill_opacity=0\.25 but RTDB has undefined/);
    expect(verdict("Q3 name/gmnotes")).toMatch(/did NOT persist/);
    expect(verdict("Q3 name/gmnotes")).toMatch(/MISMATCH: Mod echoes name="ZONE PROBE set-after"/);
    // Unaffected field still passes, with no mismatch.
    expect(verdict("Q1 8-digit")).toMatch(/^Q1 8-digit #RRGGBBAA fill : PERSISTED \(#aa00ff40\)[^—]*— look/);
    expect(verdict("Q1 8-digit")).not.toMatch(/MISMATCH/);
  });

  it("is UNKNOWN, not a pass, when the RTDB read fails", async () => {
    rtGet.mockRejectedValue(new Error("rt down"));
    expect(await main([pageId])).toBe(0);
    expect(verdict("Q1 8-digit")).toMatch(/UNKNOWN — no RTDB record/);
    expect(verdict("Q1 fill_opacity")).toMatch(/UNKNOWN/);
    expect(verdict("Q3 name/gmnotes")).toMatch(/UNKNOWN/);
    expect(out.join("\n")).toMatch(/rtGet FAILED/);
  });

  it("prints the --rm-last cleanup command", async () => {
    rtdbMirrorsModExcept();
    await main([pageId]);
    expect(out.join("\n")).toMatch(/pathv2-zone-probe\.ts --rm-last/);
    expect(out.join("\n")).toMatch(/the relay stashed 8 id\(s\)/);
  });
});

describe("pathv2-zone-probe script — cleanup exit codes", () => {
  it("--rm exits 0 when every removal succeeds", async () => {
    rtdbMirrorsModExcept();
    await main([pageId]);
    const ids = lastProbe!.variants.map(v => v.id!).join(",");
    expect(await main(["--rm", ids])).toBe(0);
  });

  it("--rm exits NON-ZERO if any removal failed", async () => {
    rtdbMirrorsModExcept();
    await main([pageId]);
    const ids = lastProbe!.variants.map(v => v.id!);
    failing.add(ids[3]);
    expect(await main(["--rm", ids.join(",")])).toBe(1);
    expect(out.join("\n")).toMatch(/1\/8 removal\(s\) FAILED/);
  });

  it("--rm-last removes the stashed shapes and clears the stash; a second run finds nothing", async () => {
    rtdbMirrorsModExcept();
    await main([pageId]);
    expect(await main(["--rm-last"])).toBe(0);
    expect(out.filter(l => l.includes("removed ")).length).toBe(8);
    expect((emu.state.GM_AI_Bridge as Record<string, unknown>).pathv2Probe).toBeUndefined();
    out.length = 0;
    expect(await main(["--rm-last"])).toBe(0);
    expect(out.join("\n")).toMatch(/nothing stashed/);
  });

  it("--rm-last exits NON-ZERO when the relay reports a failed removal", async () => {
    roll20.__setBridgeTestTransport({
      relay: <T>() => Promise.resolve({
        cleared: false,
        stash: { pageId, ids: ["-Na", "-Nb"], at: 0 },
        removed: ["-Na"], alreadyGone: [], failed: [{ id: "-Nb", error: "boom" }],
      } as unknown as T),
      evaluate: <T>(fn: (args?: unknown) => T, args?: unknown) => Promise.resolve(fn(args)),
    });
    expect(await main(["--rm-last"])).toBe(1);
    expect(out.join("\n")).toMatch(/FAILED -Nb: boom/);
  });
});
