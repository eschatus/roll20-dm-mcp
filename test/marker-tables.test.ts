// ─────────────────────────────────────────────────────────────────────────────
// The condition→marker map lives in THREE hand-synced copies (the Mod can't import
// TS): src/tools/combat.ts (array), src/bridge/markers.ts (Record), and
// mod-scripts/ai-relay.js (sandbox copy). They drift silently — this locks them.
//
// Known intentional difference (per CLAUDE.md): `wounded`/`bloodied` is a *condition*
// in combat.ts but a *pseudo-marker* in markers.ts + the relay. The tests below
// account for it explicitly rather than asserting blanket equality.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect, beforeEach } from "vitest";
import { CONDITION_MARKERS as COMBAT_CM } from "../src/tools/combat.js";
import { CONDITION_MARKERS as BRIDGE_CM, PSEUDO_MARKERS } from "../src/bridge/markers.js";
import { Roll20Emulator } from "./roll20-emulator.js";

// combat.ts array → name→marker lookup.
const combatByName = new Map(COMBAT_CM.map((c) => [c.name, c.marker]));

describe("combat.ts ↔ markers.ts condition tables agree", () => {
  it("every markers.ts 5e condition has the SAME tag in combat.ts", () => {
    for (const [cond, tag] of Object.entries(BRIDGE_CM)) {
      expect(combatByName.get(cond), `condition '${cond}'`).toBe(tag);
    }
  });

  it("the only combat.ts entries NOT in markers.ts conditions are pseudo-markers there", () => {
    for (const { name, marker } of COMBAT_CM) {
      if (Object.prototype.hasOwnProperty.call(BRIDGE_CM, name)) continue;
      // e.g. combat.ts 'wounded' → markers.ts PSEUDO_MARKERS['wounded']
      expect(PSEUDO_MARKERS[name], `combat-only '${name}' must be a known pseudo-marker`).toBe(marker);
    }
  });
});

describe("relay (ai-relay.js) ↔ markers.ts condition tables agree", () => {
  let emu: Roll20Emulator;
  let pageId: string;
  beforeEach(() => {
    emu = new Roll20Emulator({ seed: 7 });
    emu.load();
    pageId = emu.createPage();
  });

  // For every 5e condition markers.ts knows, the Mod's toggleCondition must set the
  // exact same marker tag — proving the sandbox's copy hasn't drifted from the TS one.
  for (const [condition, tag] of Object.entries(BRIDGE_CM)) {
    it(`relay toggleCondition('${condition}') sets ${tag}`, () => {
      const charId = emu.createCharacter(condition, {});
      const tok = emu.createToken({ pageid: pageId, name: condition, represents: charId, bar1_value: 9, bar1_max: 9 });
      const res = emu.relay<{ marker: string; tier: string }>({
        action: "toggleCondition", tokenId: tok.id, charId, condition, active: true,
      });
      expect(res.marker).toBe(tag);
      expect(emu.getObj("graphic", tok.id)!.get("statusmarkers")).toContain(tag);
    });
  }
});
