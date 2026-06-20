// ─────────────────────────────────────────────────────────────────────────────
// PC token-bar invariant — single-target HP path.
//
// The project rule: "never write a PC's token bar" (Beyond20 owns it). PC HP
// must be tracked exclusively in relay state via the adjustPcHp relay action
// (a %%PCHP=…%% block in the token's gmnotes). The visible bar1_value must
// remain exactly what it was before the call, regardless of the HP delta.
//
// This test suite drives the REAL update_token_hp MCP handler against the
// emulator (mod-scripts/ai-relay.js in a vm sandbox) and asserts that:
//   1. A PC token's bar1_value is NEVER mutated on damage, heal, or setHp.
//   2. The relay state (gmnotes PCHP block) IS updated with the correct value.
//   3. The tool's return text is annotated "(tracked)" for PCs.
//   4. NPC tokens continue to write bar1_value directly (control group).
//
// Routing is by controlledby — a player id makes it a PC; empty string = NPC.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupHarness, type Harness } from "./harness.js";

let h: Harness;

/** Read bar1_value from the in-memory token store. */
const bar = (id: string) => Number(h.emu.tokenProps(id).bar1_value);

/** Read raw gmnotes string from the in-memory token store. */
const gmnotes = (id: string) => String(h.emu.tokenProps(id).gmnotes ?? "");

/**
 * Parse the %%PCHP={…}%% block out of a gmnotes string.
 * Returns null when no block is present.
 */
function parsePcHp(notes: string): { current: number; max: number } | null {
  const m = notes.match(/%%PCHP=(\{[\s\S]*?\})%%/);
  if (!m) return null;
  try { return JSON.parse(m[1]) as { current: number; max: number }; }
  catch { return null; }
}

beforeAll(() => {
  h = setupHarness({ seed: 42 });

  // Create a dedicated page for these tests.
  const pageId = h.emu.createPage("PC Bar Invariant Tests");
  h.emu.setPlayerPage(pageId);

  // ── PC token ──────────────────────────────────────────────────────────────
  // controlledby is set to a real player id → isPcToken() returns true.
  h.emu.createToken({
    pageid: pageId,
    name: "Test PC",
    controlledby: "player-test-1",
    bar1_value: 30,
    bar1_max: 30,
  });

  // ── NPC token (control group) ─────────────────────────────────────────────
  h.emu.createToken({
    pageid: pageId,
    name: "Test NPC",
    controlledby: "",
    bar1_value: 20,
    bar1_max: 20,
  });
});

afterAll(() => h.teardown());

// ── helpers ───────────────────────────────────────────────────────────────────

/** Find the token id of the first token with the given name. */
function tokenId(name: string): string {
  // Access the emulator's store indirectly — relay getTokens returns all tokens
  // on the player page, which is set in beforeAll above.
  const page = h.emu.campaignModel.get("playerpageid") as string;
  const tokens = h.emu.relay<Array<{ id: string; name: string }>>(
    { action: "getTokens", pageId: page }
  );
  const tok = tokens.find((t) => t.name === name);
  if (!tok) throw new Error(`Token not found in emulator: ${name}`);
  return tok.id;
}

// ── PC tests ──────────────────────────────────────────────────────────────────

describe("update_token_hp — PC token (bar must NEVER be written)", () => {
  it("damage does not mutate bar1_value and writes relay state instead", async () => {
    const id = tokenId("Test PC");
    const barBefore = bar(id);

    const { text } = await h.callTool("update_token_hp", {
      tokenId: id,
      damage: 8,
    });

    // Bar must be exactly unchanged.
    expect(bar(id)).toBe(barBefore);

    // Relay state must reflect the deducted HP.
    const pchp = parsePcHp(gmnotes(id));
    expect(pchp).not.toBeNull();
    expect(pchp!.current).toBe(barBefore - 8); // 30 - 8 = 22

    // Tool output must be annotated with "(tracked)".
    expect(text).toMatch(/\(tracked\)/);
  });

  it("heal does not mutate bar1_value and writes relay state instead", async () => {
    const id = tokenId("Test PC");
    // After the previous test the relay state has current=22; verify healing.
    const barBefore = bar(id); // should still be 30 (untouched)

    const { text } = await h.callTool("update_token_hp", {
      tokenId: id,
      heal: 5,
    });

    expect(bar(id)).toBe(barBefore); // bar still untouched
    const pchp = parsePcHp(gmnotes(id));
    expect(pchp).not.toBeNull();
    // Previous state was 22, heal 5 → 27 (capped at max 30).
    expect(pchp!.current).toBe(27);

    expect(text).toMatch(/\(tracked\)/);
  });

  it("setHp does not mutate bar1_value and writes relay state instead", async () => {
    const id = tokenId("Test PC");
    const barBefore = bar(id);

    const { text } = await h.callTool("update_token_hp", {
      tokenId: id,
      setHp: 15,
    });

    expect(bar(id)).toBe(barBefore); // bar unmoved
    const pchp = parsePcHp(gmnotes(id));
    expect(pchp).not.toBeNull();
    expect(pchp!.current).toBe(15);

    expect(text).toMatch(/\(tracked\)/);
  });
});

// ── NPC control group ─────────────────────────────────────────────────────────

describe("update_token_hp — NPC token (bar IS written, control group)", () => {
  it("damage writes to bar1_value directly for an NPC", async () => {
    const id = tokenId("Test NPC");
    const barBefore = bar(id); // 20

    const { text } = await h.callTool("update_token_hp", {
      tokenId: id,
      damage: 6,
    });

    // NPC bar must drop.
    expect(bar(id)).toBe(barBefore - 6); // 14

    // No PCHP relay block for NPCs.
    expect(parsePcHp(gmnotes(id))).toBeNull();

    // Output must NOT carry "(tracked)" (that annotation is PC-only).
    expect(text).not.toMatch(/\(tracked\)/);
  });

  it("heal writes to bar1_value directly for an NPC", async () => {
    const id = tokenId("Test NPC");
    const barBefore = bar(id); // 14 after previous test

    await h.callTool("update_token_hp", { tokenId: id, heal: 4 });

    expect(bar(id)).toBe(Math.min(20, barBefore + 4)); // 18
  });
});
