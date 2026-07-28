// ─────────────────────────────────────────────────────────────────────────────
// Zone terrain/duration semantics (issue #134).
//
//  - metadata round-trips through create_zone/list_zones (terrain + duration)
//  - rounds(1) zones survive the remainder of their creation round and expire
//    exactly at the next round boundary
//  - process_round_end_zones returns what it deleted (for round-end narration)
//  - the substance x trigger transition table resolves the documented cases
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { setupHarness, type Harness } from "./harness.js";
import { defaultZoneColor, lookupZoneTransition, ZONE_TRANSITIONS } from "../src/tools/zones.js";

let h: Harness;
let pageId: string;

beforeEach(() => {
  h = setupHarness({ seed: 42 });
  pageId = h.emu.createPage("Zone Test Map");
  h.emu.setPlayerPage(pageId);
});

afterEach(() => {
  h.teardown();
});

describe("zone metadata round-trip", () => {
  it("stores and returns terrain + duration on create_zone", async () => {
    const created = await h.callTool("create_zone", {
      name: "Web",
      terrain: "difficult",
      duration: { type: "rounds", n: 2 },
      centerX: 100,
      centerY: 100,
      radiusFeet: 15,
      pageId,
    });
    const data = created.json as { terrain: string; duration: { type: string; n: number } };
    expect(data.terrain).toBe("difficult");
    expect(data.duration.type).toBe("rounds");
    expect(data.duration.n).toBe(2);

    const listed = await h.callTool("list_zones", { pageId });
    const zones = listed.json as Array<{ name: string; meta: { terrain: string; duration: { type: string } } }>;
    const web = zones.find((z) => z.name.includes("Web"));
    expect(web).toBeTruthy();
    expect(web!.meta.terrain).toBe("difficult");
    expect(web!.meta.duration.type).toBe("rounds");
  });

  it("defaults duration to instant and terrain to null when omitted", async () => {
    const created = await h.callTool("create_zone", { name: "Plain Circle", centerX: 0, centerY: 0, pageId });
    const data = created.json as { terrain: string | null; duration: { type: string } };
    expect(data.terrain).toBeNull();
    expect(data.duration.type).toBe("instant");
  });

  it("stores concentration duration with the caster linkage", async () => {
    const created = await h.callTool("create_zone", {
      name: "Spirit Guardians",
      terrain: "damaging",
      duration: { type: "concentration", caster: "Zeno" },
      centerX: 50,
      centerY: 50,
      pageId,
    });
    const data = created.json as { duration: { type: string; caster: string } };
    expect(data.duration.type).toBe("concentration");
    expect(data.duration.caster).toBe("Zeno");
  });
});

describe("color defaults by terrain", () => {
  it("does not hard-fail on an explicit color even when terrain is set", async () => {
    const created = await h.callTool("create_zone", {
      name: "Custom Color",
      terrain: "damaging",
      color: "#123456",
      centerX: 0,
      centerY: 0,
      pageId,
    });
    // The relay echoes back terrain/duration, not color, so assert via list_zones meta.
    const listed = await h.callTool("list_zones", { pageId });
    const zones = listed.json as Array<{ name: string; meta: { color: string } }>;
    const zone = zones.find((z) => z.name.includes("Custom Color"));
    expect(zone!.meta.color).toBe("#123456");
    void created;
  });

  it("defaultZoneColor picks green for difficult, red for damaging, purple otherwise", () => {
    expect(defaultZoneColor("difficult")).toBe("#00aa44");
    expect(defaultZoneColor("damaging")).toBe("#cc0000");
    expect(defaultZoneColor(undefined)).toBe("#aa00ff");
    expect(defaultZoneColor(null)).toBe("#aa00ff");
  });
});

describe("rounds(n) expiry at the round boundary", () => {
  it("a rounds(1) zone created in round 1 survives round 1 and expires entering round 2", async () => {
    // The relay's own turn hook (which stamps the round counter) fires off a
    // Backbone "change:campaign:turnorder" event the in-memory emulator doesn't
    // simulate — so drive the round counter directly via the same persistent
    // `state.GM_AI_Bridge` bag createZone reads (B() in ai-relay.js), exactly as
    // a real session's turn hook would have left it after round 1 started.
    (h.emu.state as Record<string, unknown>).GM_AI_Bridge = {
      round: 1,
      turnHookEnabled: false,
      dmInbox: [],
      mobPlans: {},
      pcHp: {},
    };

    await h.callTool("create_zone", {
      name: "Grease Fire",
      terrain: "damaging",
      duration: { type: "rounds", n: 1 },
      centerX: 0,
      centerY: 0,
      pageId,
    });

    // Still round 1 — processing round-end for round 1 must NOT expire it
    // (n=1 lasts the remainder of the round it was created in).
    let processed = await h.callTool("process_round_end_zones", { currentRound: 1, pageId });
    let result = processed.json as { expired: Array<{ name: string }>; round: number };
    expect(result.expired).toHaveLength(0);

    const stillThere = await h.callTool("list_zones", { pageId });
    expect((stillThere.json as Array<{ name: string }>).some((z) => z.name.includes("Grease Fire"))).toBe(true);

    // Round rolls over to 2 — now it must expire.
    processed = await h.callTool("process_round_end_zones", { currentRound: 2, pageId });
    result = processed.json as { expired: Array<{ name: string }>; round: number };
    expect(result.expired).toHaveLength(1);
    expect(result.expired[0].name).toContain("Grease Fire");
    expect(result.round).toBe(2);

    const gone = await h.callTool("list_zones", { pageId });
    expect((gone.json as Array<{ name: string }>).some((z) => z.name.includes("Grease Fire"))).toBe(false);
  });

  it("leaves instant and concentration zones alone", async () => {
    await h.callTool("create_zone", { name: "Instant Blast", duration: { type: "instant" }, centerX: 0, centerY: 0, pageId });
    await h.callTool("create_zone", {
      name: "Ongoing Guardians",
      duration: { type: "concentration", caster: "Zeno" },
      centerX: 0,
      centerY: 0,
      pageId,
    });

    const processed = await h.callTool("process_round_end_zones", { currentRound: 5, pageId });
    const result = processed.json as { expired: Array<{ name: string }> };
    expect(result.expired).toHaveLength(0);

    const listed = await h.callTool("list_zones", { pageId });
    const names = (listed.json as Array<{ name: string }>).map((z) => z.name);
    expect(names.some((n) => n.includes("Instant Blast"))).toBe(true);
    expect(names.some((n) => n.includes("Ongoing Guardians"))).toBe(true);
  });
});

describe("substance x trigger transition table", () => {
  it("resolves web + fire to an instant damaging replacement", () => {
    const spec = lookupZoneTransition("web", "fire");
    expect(spec).toBeTruthy();
    expect(spec!.terrain).toBe("damaging");
    expect(spec!.duration).toEqual({ type: "instant" });
  });

  it("resolves grease + fire to a rounds(1) damaging replacement", () => {
    const spec = lookupZoneTransition("grease", "fire");
    expect(spec).toBeTruthy();
    expect(spec!.terrain).toBe("damaging");
    expect(spec!.duration).toEqual({ type: "rounds", n: 1 });
  });

  it("is case-insensitive and returns undefined for unknown pairs", () => {
    expect(lookupZoneTransition("WEB", "FIRE")).toBeTruthy();
    expect(lookupZoneTransition("water", "fire")).toBeUndefined();
    expect(lookupZoneTransition("web", "cold")).toBeUndefined();
  });

  it("table is exported for prompt/tool use and is non-empty", () => {
    expect(Object.keys(ZONE_TRANSITIONS).length).toBeGreaterThan(0);
  });
});
