// ─────────────────────────────────────────────────────────────────────────────
// Layer 1 — relay action tests (the spine).
//
// Drives `!ai-relay` commands straight into the real ai-relay.js running in the
// emulator and asserts on game state + emitted whispers. No bridge, no tools —
// this is the fastest, most direct coverage of the 1,800-line relay, including
// the security/robustness fixes (GM gate, nonce replay, atomic turn-order merge).
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect, beforeEach } from "vitest";
import { Roll20Emulator } from "./roll20-emulator.js";

let emu: Roll20Emulator;

beforeEach(() => {
  emu = new Roll20Emulator({ seed: 42 });
  emu.load();
});

describe("GM-only sender gate", () => {
  it("rejects !ai-relay from a non-GM player (no result produced)", () => {
    const pageId = emu.createPage();
    emu.createToken({ pageid: pageId, name: "Goblin", bar1_value: 7, bar1_max: 7 });
    // A non-GM sender must be ignored — the handler returns before writeResult,
    // so relay() sees no result and throws.
    expect(() =>
      emu.relay({ action: "getTokens", pageId }, { playerid: "player-evil" })
    ).toThrow(/no result/i);
  });

  it("allows a GM sender", () => {
    const pageId = emu.createPage();
    emu.createToken({ pageid: pageId, name: "Goblin", bar1_value: 7, bar1_max: 7 });
    const tokens = emu.relay<unknown[]>({ action: "getTokens", pageId });
    expect(tokens.length).toBe(1);
  });
});

describe("atomic mergeTurnOrder", () => {
  it("preserves a player entry added out-of-band and sorts pr-descending", () => {
    // Simulate a player having set their own initiative in the Roll20 UI.
    emu.campaignModel.set("turnorder", JSON.stringify([{ id: "pc-1", pr: "17", custom: "" }]));

    const res = emu.relay<{ ok: boolean; turnorder: Array<{ id: string; pr: string }> }>({
      action: "mergeTurnOrder",
      entries: [
        { id: "gob-1", pr: "9", custom: "" },
        { id: "gob-2", pr: "21", custom: "" },
      ],
    });

    expect(res.ok).toBe(true);
    const ids = res.turnorder.map((e) => e.id);
    // Player entry survived the merge (the documented player-wipe race is closed).
    expect(ids).toContain("pc-1");
    // pr-descending, numeric (21 > 17 > 9).
    expect(res.turnorder.map((e) => e.pr)).toEqual(["21", "17", "9"]);
    expect(ids).toEqual(["gob-2", "pc-1", "gob-1"]);
  });

  it("upserts an existing id in place rather than duplicating it", () => {
    emu.campaignModel.set("turnorder", JSON.stringify([{ id: "gob-1", pr: "9", custom: "" }]));
    const res = emu.relay<{ turnorder: Array<{ id: string; pr: string }> }>({
      action: "mergeTurnOrder",
      entries: [{ id: "gob-1", pr: "25", custom: "" }],
    });
    expect(res.turnorder.filter((e) => e.id === "gob-1")).toHaveLength(1);
    expect(res.turnorder[0].pr).toBe("25");
  });
});

describe("same-nonce replay idempotency", () => {
  it("a resent nonce echoes the prior result and does NOT re-run advanceTurn", () => {
    emu.campaignModel.set(
      "turnorder",
      JSON.stringify([
        { id: "a", pr: "20", custom: "" },
        { id: "b", pr: "15", custom: "" },
        { id: "c", pr: "10", custom: "" },
      ])
    );

    const NONCE = 999001;
    const first = emu.relayWithNonce({ action: "advanceTurn" }, NONCE);
    const orderAfterFirst = emu.turnOrder().map((e) => e.id);
    expect(orderAfterFirst).toEqual(["b", "c", "a"]); // rotated once

    // Resend the SAME nonce — must be a no-op echo, order unchanged.
    const second = emu.relayWithNonce({ action: "advanceTurn" }, NONCE);
    const orderAfterSecond = emu.turnOrder().map((e) => e.id);
    expect(orderAfterSecond).toEqual(["b", "c", "a"]); // NOT rotated again
    expect(second).toEqual(first); // identical echoed result
  });
});

describe("conditions & status markers", () => {
  it("toggleCondition applies a true 5e condition marker and tracks it on the sheet", () => {
    const pageId = emu.createPage();
    const charId = emu.createCharacter("Goblin", {});
    const tok = emu.createToken({ pageid: pageId, name: "Goblin", represents: charId, bar1_value: 7, bar1_max: 7 });

    const res = emu.relay<{ ok: boolean; marker: string; tier: string }>({
      action: "toggleCondition",
      tokenId: tok.id,
      charId,
      condition: "poisoned",
      active: true,
    });
    expect(res.tier).toBe("condition");
    expect(emu.getObj("graphic", tok.id)!.get("statusmarkers")).toContain("Poisoned");

    // Clearing removes it.
    emu.relay({ action: "toggleCondition", tokenId: tok.id, charId, condition: "poisoned", active: false });
    expect(emu.getObj("graphic", tok.id)!.get("statusmarkers")).not.toContain("Poisoned");
  });

  it("an invented state becomes a tracked custom marker", () => {
    const pageId = emu.createPage();
    const tok = emu.createToken({ pageid: pageId, name: "Aldric", bar1_value: 30, bar1_max: 30 });
    const res = emu.relay<{ tier: string; marker: string }>({
      action: "toggleCondition",
      tokenId: tok.id,
      condition: "hunters-mark",
      active: true,
    });
    expect(res.tier).toBe("custom");
    expect(emu.getObj("graphic", tok.id)!.get("statusmarkers")).toContain(res.marker);
  });

  // ───────────────────────────────────────────────────────────────────────
  // Regression coverage for issue #133 — the DM sometimes hand-clicks a
  // marker onto a token before the voice gem processes the same instruction.
  // "toggleCondition" is a misleading name: the handler must behave as
  // set-true/set-false, NOT a flip. Applying an already-set condition is a
  // no-op (stays set); clearing an absent condition is a no-op (stays
  // clear). Cover all three marker tiers, plus the batchExec path and the
  // legacy update_token_hp addConditions/removeConditions relay calls,
  // since all of them ultimately hit the same "toggleCondition" action.
  // ───────────────────────────────────────────────────────────────────────
  describe("idempotent set/clear semantics (issue #133)", () => {
    const markerCountOf = (statusmarkers: string, tag: string): number =>
      statusmarkers.split(",").filter((m) => m === tag).length;

    it.each([
      ["condition", "poisoned", "Poisoned::4444329"],
      ["pseudo", "concentrating", "Concentrating::4444313"],
      ["custom", "hunters-mark", null], // ad-hoc tag is hashed; resolved at runtime
    ] as const)("%s tier: applying twice stays set (no flip-off)", (tier, condition) => {
      const pageId = emu.createPage();
      const charId = emu.createCharacter("Target", {});
      const tok = emu.createToken({ pageid: pageId, name: "Target", represents: charId, bar1_value: 10, bar1_max: 10 });

      const first = emu.relay<{ tier: string; marker: string }>({
        action: "toggleCondition", tokenId: tok.id, charId, condition, active: true,
      });
      expect(first.tier).toBe(tier);

      // Simulate the DM having already hand-applied the marker: the gem then
      // issues the SAME apply again. It must remain set — not flip off.
      const second = emu.relay<{ tier: string; marker: string }>({
        action: "toggleCondition", tokenId: tok.id, charId, condition, active: true,
      });
      expect(second.marker).toBe(first.marker);

      const sm = String(emu.getObj("graphic", tok.id)!.get("statusmarkers"));
      expect(markerCountOf(sm, first.marker)).toBe(1); // set, not duplicated
      expect(sm).toContain(first.marker);
    });

    it("removing an already-cleared condition is a no-op", () => {
      const pageId = emu.createPage();
      const charId = emu.createCharacter("Target", {});
      const tok = emu.createToken({ pageid: pageId, name: "Target", represents: charId, bar1_value: 10, bar1_max: 10 });

      // Never applied — clear should just do nothing.
      const res = emu.relay<{ ok: boolean; marker: string }>({
        action: "toggleCondition", tokenId: tok.id, charId, condition: "prone", active: false,
      });
      expect(res.ok).toBe(true);
      const sm = String(emu.getObj("graphic", tok.id)!.get("statusmarkers"));
      expect(sm).not.toContain(res.marker);
    });

    it("explicit removal is the only way a marker comes off — apply, apply again, then clear once", () => {
      const pageId = emu.createPage();
      const charId = emu.createCharacter("Target", {});
      const tok = emu.createToken({ pageid: pageId, name: "Target", represents: charId, bar1_value: 10, bar1_max: 10 });

      emu.relay({ action: "toggleCondition", tokenId: tok.id, charId, condition: "stunned", active: true });
      emu.relay({ action: "toggleCondition", tokenId: tok.id, charId, condition: "stunned", active: true }); // hand-click + gem race
      let sm = String(emu.getObj("graphic", tok.id)!.get("statusmarkers"));
      expect(sm).toContain("Stunned::4444331");

      emu.relay({ action: "toggleCondition", tokenId: tok.id, charId, condition: "stunned", active: false });
      sm = String(emu.getObj("graphic", tok.id)!.get("statusmarkers"));
      expect(sm).not.toContain("Stunned::4444331");
    });

    it("condition tier keeps active_conditions sheet attr idempotent across repeated applies", () => {
      const pageId = emu.createPage();
      const charId = emu.createCharacter("Target", {});
      const tok = emu.createToken({ pageid: pageId, name: "Target", represents: charId, bar1_value: 10, bar1_max: 10 });

      emu.relay({ action: "toggleCondition", tokenId: tok.id, charId, condition: "blinded", active: true });
      emu.relay({ action: "toggleCondition", tokenId: tok.id, charId, condition: "blinded", active: true });
      const attrs = emu.relay<Record<string, unknown>>({ action: "getCharacterAttributes", charId });
      const list = String(attrs.active_conditions || "").split(",").filter(Boolean);
      expect(list.filter((c) => c === "blinded")).toHaveLength(1);
    });

    it("custom tier: getCustomStates does not duplicate the token holder on repeated applies", () => {
      const pageId = emu.createPage();
      const tok = emu.createToken({ pageid: pageId, name: "Aldric", bar1_value: 30, bar1_max: 30 });

      emu.relay({ action: "toggleCondition", tokenId: tok.id, condition: "hunters-mark", active: true });
      emu.relay({ action: "toggleCondition", tokenId: tok.id, condition: "hunters-mark", active: true });
      const states = emu.relay<{ state: string; tokens: { id: string }[] }[]>({ action: "getCustomStates" });
      const entry = states.find((s) => s.state === "hunters-mark");
      expect(entry).toBeTruthy();
      expect(entry!.tokens.filter((t) => t.id === tok.id)).toHaveLength(1);

      // Clear it — it should disappear from the tracked list entirely (no leftover empty entry).
      emu.relay({ action: "toggleCondition", tokenId: tok.id, condition: "hunters-mark", active: false });
      const after = emu.relay<{ state: string }[]>({ action: "getCustomStates" });
      expect(after.find((s) => s.state === "hunters-mark")).toBeUndefined();
    });

    it("batchExec toggleCondition op is idempotent too (batch path mirrors the top-level action)", () => {
      const pageId = emu.createPage();
      const charId = emu.createCharacter("Target", {});
      const tok = emu.createToken({ pageid: pageId, name: "Target", represents: charId, bar1_value: 10, bar1_max: 10 });

      emu.relay({ action: "batchExec", ops: [
        { id: "a", action: "toggleCondition", args: { tokenId: tok.id, charId, condition: "grappled", active: true } },
      ] });
      emu.relay({ action: "batchExec", ops: [
        { id: "b", action: "toggleCondition", args: { tokenId: tok.id, charId, condition: "grappled", active: true } },
      ] });
      const sm = String(emu.getObj("graphic", tok.id)!.get("statusmarkers"));
      expect(markerCountOf(sm, "Grappled::4444314")).toBe(1);

      emu.relay({ action: "batchExec", ops: [
        { id: "c", action: "toggleCondition", args: { tokenId: tok.id, charId, condition: "grappled", active: false } },
      ] });
      const smAfter = String(emu.getObj("graphic", tok.id)!.get("statusmarkers"));
      expect(smAfter).not.toContain("Grappled::4444314");

      // Removing again (already absent) must be a no-op, not throw.
      expect(() => emu.relay({ action: "batchExec", ops: [
        { id: "d", action: "toggleCondition", args: { tokenId: tok.id, charId, condition: "grappled", active: false } },
      ] })).not.toThrow();
    });

    it("setStatusMarker (used by free/pseudo marker application) is also idempotent", () => {
      const pageId = emu.createPage();
      emu.setPlayerPage(pageId);
      const tok = emu.createToken({ pageid: pageId, name: "Goblin", bar1_value: 7, bar1_max: 7 });

      emu.relay({ action: "setStatusMarker", tokenId: tok.id, marker: "red", active: true });
      emu.relay({ action: "setStatusMarker", tokenId: tok.id, marker: "red", active: true });
      const sm = String(emu.getObj("graphic", tok.id)!.get("statusmarkers"));
      expect(markerCountOf(sm, "red")).toBe(1);

      // Remove an absent marker → no-op, no throw.
      expect(() => emu.relay({ action: "setStatusMarker", tokenId: tok.id, marker: "blue", active: false })).not.toThrow();
      expect(String(emu.getObj("graphic", tok.id)!.get("statusmarkers"))).not.toContain("blue");

      emu.relay({ action: "setStatusMarker", tokenId: tok.id, marker: "red", active: false });
      expect(String(emu.getObj("graphic", tok.id)!.get("statusmarkers"))).not.toContain("red");
    });
  });
});

describe("AoE / emanation geometry (findTokensInRange)", () => {
  it("returns only tokens within the radius, nearest-first", () => {
    const pageId = emu.createPage();
    // scale 5 → 70px = 5ft. Center at (700,700).
    const center = emu.createToken({ pageid: pageId, name: "Zeno", left: 700, top: 700, bar1_value: 45, bar1_max: 45 });
    const near = emu.createToken({ pageid: pageId, name: "Cleric", left: 700 + 70, top: 700, bar1_value: 24, bar1_max: 24 });   // 5ft
    const mid  = emu.createToken({ pageid: pageId, name: "Fighter", left: 700 + 140, top: 700, bar1_value: 30, bar1_max: 30 }); // 10ft
    const far  = emu.createToken({ pageid: pageId, name: "Archer", left: 700 + 70 * 6, top: 700, bar1_value: 18, bar1_max: 18 }); // 30ft

    const hits = emu.relay<Array<{ id: string; distanceFeet: number }>>({
      action: "findTokensInRange",
      centerTokenId: center.id,
      radiusFeet: 15, // Spirit Guardians emanation
      pageId,
      layerFilter: "objects",
    });
    const ids = hits.map((h) => h.id);
    expect(ids).toContain(near.id);
    expect(ids).toContain(mid.id);
    expect(ids).not.toContain(far.id); // 30ft is outside a 15ft emanation
    expect(ids).not.toContain(center.id); // the center never returns itself
    // Sorted nearest-first.
    expect(hits[0].id).toBe(near.id);
    expect(hits[0].distanceFeet).toBeCloseTo(5, 1);
  });
});

describe("setTokenBar write", () => {
  it("sets absolute HP on the token", () => {
    const pageId = emu.createPage();
    const tok = emu.createToken({ pageid: pageId, name: "Goblin", bar1_value: 7, bar1_max: 7 });
    emu.relay({ action: "setTokenBar", tokenId: tok.id, value: 2, max: 7 });
    expect(Number(emu.getObj("graphic", tok.id)!.get("bar1_value"))).toBe(2);
  });
});

// Issue #141: bloodied/wounded + auto-death threshold automation lives at this
// exact relay chokepoint (ACTIONS["setTokenBar"] + the runBatchOp case batchExec
// uses) so every NPC/sidekick bar1 write — update_token_hp, update_hp_many,
// resolve_aoe — inherits it without the model having to remember set_token_marker.
describe("setTokenBar threshold automation (issue #141)", () => {
  it("crossing at/below half applies Wounded::4444333", () => {
    const pageId = emu.createPage();
    const tok = emu.createToken({ pageid: pageId, name: "Priest B", bar1_value: 33, bar1_max: 33 });
    const res = emu.relay<{ ok: boolean; wounded: boolean; dead: boolean }>({
      action: "setTokenBar", tokenId: tok.id, value: 5, max: 33,
    });
    expect(res.wounded).toBe(true);
    expect(res.dead).toBe(false);
    expect(String(emu.getObj("graphic", tok.id)!.get("statusmarkers"))).toContain("Wounded::4444333");
  });

  it("healing back above half REMOVES the Wounded marker (symmetric)", () => {
    const pageId = emu.createPage();
    const tok = emu.createToken({ pageid: pageId, name: "Priest B", bar1_value: 5, bar1_max: 33, statusmarkers: "Wounded::4444333" });
    const res = emu.relay<{ wounded: boolean; dead: boolean }>({
      action: "setTokenBar", tokenId: tok.id, value: 20, max: 33,
    });
    expect(res.wounded).toBe(false);
    expect(String(emu.getObj("graphic", tok.id)!.get("statusmarkers"))).not.toContain("Wounded");
  });

  it("exact half boundary (current*2 <= max) counts as wounded", () => {
    const pageId = emu.createPage();
    const tok = emu.createToken({ pageid: pageId, name: "Half", bar1_value: 30, bar1_max: 30 });
    const res = emu.relay<{ wounded: boolean }>({ action: "setTokenBar", tokenId: tok.id, value: 15, max: 30 });
    expect(res.wounded).toBe(true);
  });

  it("dropping to 0 auto-applies the dead marker AND moves the token to the map layer", () => {
    const pageId = emu.createPage();
    const tok = emu.createToken({ pageid: pageId, name: "Ogre", bar1_value: 20, bar1_max: 20, layer: "objects" });
    const res = emu.relay<{ wounded: boolean; dead: boolean }>({
      action: "setTokenBar", tokenId: tok.id, value: 0, max: 20,
    });
    expect(res.dead).toBe(true);
    expect(res.wounded).toBe(false);
    const t = emu.getObj("graphic", tok.id)!;
    expect(String(t.get("statusmarkers"))).toContain("dead"); // built-in dead marker
    expect(String(t.get("statusmarkers"))).not.toContain("Wounded");
    expect(t.get("layer")).toBe("map");
  });

  it("a barless token (no max established) is never automated", () => {
    const pageId = emu.createPage();
    const tok = emu.createToken({ pageid: pageId, name: "Scenery", bar1_value: 0, bar1_max: 0 });
    const res = emu.relay<{ wounded: boolean; dead: boolean }>({ action: "setTokenBar", tokenId: tok.id, value: 0 });
    expect(res).toEqual({ ok: true, wounded: false, dead: false });
    expect(emu.getObj("graphic", tok.id)!.get("layer")).not.toBe("map");
  });

  it("carries max forward from the token when the caller omits it (matches the RT-direct mirror)", () => {
    const pageId = emu.createPage();
    const tok = emu.createToken({ pageid: pageId, name: "Priest B", bar1_value: 33, bar1_max: 33 });
    const res = emu.relay<{ wounded: boolean }>({ action: "setTokenBar", tokenId: tok.id, value: 5 });
    expect(res.wounded).toBe(true);
  });

  it("the SAME automation fires through batchExec (update_hp_many / resolve_aoe's path)", () => {
    const pageId = emu.createPage();
    const tok = emu.createToken({ pageid: pageId, name: "Skeleton", bar1_value: 12, bar1_max: 12 });
    const results = emu.relay<Array<{ id: string; ok: boolean; data?: { wounded?: boolean; dead?: boolean } }>>({
      action: "batchExec",
      ops: [{ id: tok.id, action: "setTokenBar", args: { tokenId: tok.id, value: 0, max: 12 } }],
    });
    expect(results[0].ok).toBe(true);
    expect(results[0].data?.dead).toBe(true);
    const t = emu.getObj("graphic", tok.id)!;
    expect(String(t.get("statusmarkers"))).toContain("dead");
    expect(t.get("layer")).toBe("map");
  });

  it("explicit removeConditions after the automation wins (DM override beats server automation)", () => {
    // Mirrors update_token_hp's ordering: the HP write (+ automation) happens first,
    // then any explicit addConditions/removeConditions from the same call run after.
    const pageId = emu.createPage();
    const tok = emu.createToken({ pageid: pageId, name: "Priest B", bar1_value: 33, bar1_max: 33 });
    emu.relay({ action: "setTokenBar", tokenId: tok.id, value: 5, max: 33 }); // auto-applies Wounded
    expect(String(emu.getObj("graphic", tok.id)!.get("statusmarkers"))).toContain("Wounded::4444333");
    emu.relay({ action: "toggleCondition", tokenId: tok.id, condition: "wounded", active: false }); // explicit DM override
    expect(String(emu.getObj("graphic", tok.id)!.get("statusmarkers"))).not.toContain("Wounded");
  });
});

describe("editCharacter relay action", () => {
  it("updates name on an existing character", () => {
    const charId = emu.createCharacter("Old Name", {});
    const res = emu.relay<{ ok: boolean; updated: string[] }>({
      action: "editCharacter",
      charId,
      name: "New Name",
    });
    expect(res.ok).toBe(true);
    expect(res.updated).toContain("name");
    expect(emu.getObj("character", charId)!.get("name")).toBe("New Name");
  });

  it("updates multiple fields at once and reports all updated keys", () => {
    const charId = emu.createCharacter("Hero", {});
    const res = emu.relay<{ ok: boolean; updated: string[] }>({
      action: "editCharacter",
      charId,
      controlledby: "all",
      inplayerjournals: "all",
      archived: false,
    });
    expect(res.ok).toBe(true);
    expect(res.updated).toContain("controlledby");
    expect(res.updated).toContain("inplayerjournals");
    expect(res.updated).toContain("archived");
    expect(emu.getObj("character", charId)!.get("controlledby")).toBe("all");
    expect(emu.getObj("character", charId)!.get("inplayerjournals")).toBe("all");
  });

  it("throws when no fields are passed", () => {
    const charId = emu.createCharacter("Stub", {});
    expect(() =>
      emu.relay({ action: "editCharacter", charId })
    ).toThrow(/no fields to edit/i);
  });

  it("throws when the character id does not exist", () => {
    expect(() =>
      emu.relay({ action: "editCharacter", charId: "nonexistent-id", name: "X" })
    ).toThrow(/character not found/i);
  });

  it("is GM-gated — non-GM sender gets no result", () => {
    const charId = emu.createCharacter("Protected", {});
    expect(() =>
      emu.relay({ action: "editCharacter", charId, name: "Hacked" }, { playerid: "player-evil" })
    ).toThrow(/no result/i);
    // Character should be unchanged.
    expect(emu.getObj("character", charId)!.get("name")).toBe("Protected");
  });
});

describe("createCharacter relay action", () => {
  it("auto-derives ability _mod attributes from raw scores", () => {
    const res = emu.relay<{ id: string }>({
      action: "createCharacter",
      name: "Vex",
      attributes: [
        { name: "strength", current: 14 },
        { name: "dexterity", current: 16 },
        { name: "wisdom", current: 9 },
      ],
    });
    const attrs = emu.relay<Record<string, unknown>>({
      action: "getCharacterAttributes",
      charId: res.id,
    });
    expect(attrs.strength_mod).toBe(2);
    expect(attrs.dexterity_mod).toBe(3);
    expect(attrs.wisdom_mod).toBe(-1);
  });

  it("does not override an explicitly-provided _mod", () => {
    const res = emu.relay<{ id: string }>({
      action: "createCharacter",
      name: "Custom",
      attributes: [
        { name: "strength", current: 14 },
        { name: "strength_mod", current: 99 },
      ],
    });
    const attrs = emu.relay<Record<string, unknown>>({
      action: "getCharacterAttributes",
      charId: res.id,
    });
    expect(attrs.strength_mod).toBe(99);
  });
});

describe("getCharacterAttributes — sandbox-crash guard (writeResult escaping)", () => {
  // Regression for a real incident: a character attribute containing literal "@{pbd_safe}",
  // "%{Vampire|kingdom-culture-action}", or "[[1d20]]"-shaped text crashed the WHOLE Mod sandbox
  // when echoed back, because Roll20's own chat pipeline live-evaluates "@{...}"/"%{...}"/"[[...]]"
  // in any outgoing sendChat message — including ones that are just data being relayed back to the
  // caller, not meant to be interpreted at all.
  it("never sends a raw '@{', '%{', or '[[' to sendChat when an attribute contains that text", () => {
    const charId = emu.createCharacter("Vex", { strength: 14 });
    emu.relay({
      action: "setCharacterAttributes",
      charId,
      attributes: { npc_skills: "@{pbd_safe} %{Vampire|kingdom-culture-action} Perception [[1d20]]" },
    });
    emu.relay({ action: "getCharacterAttributes", charId });

    const resultMessages = emu.chatLog.filter((m) => m.content.includes("AIBRIDGE_RESULT:"));
    expect(resultMessages.length).toBeGreaterThan(0);
    for (const m of resultMessages) {
      expect(m.content).not.toContain("@{");
      expect(m.content).not.toContain("%{");
      expect(m.content).not.toContain("[[");
    }
  });

  it("round-trips the original text exactly despite the escaping", () => {
    const charId = emu.createCharacter("Vex", { strength: 14 });
    const original = "@{pbd_safe} %{Vampire|kingdom-culture-action} Perception [[1d20]]";
    emu.relay({
      action: "setCharacterAttributes",
      charId,
      attributes: { npc_skills: original },
    });
    const attrs = emu.relay<Record<string, unknown>>({ action: "getCharacterAttributes", charId });
    expect(attrs.npc_skills).toBe(original);
  });
});
