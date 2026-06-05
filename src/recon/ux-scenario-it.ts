// LIVE UX / scenario test: drives a realistic combat lifecycle and asserts invariants after each
// step (no weird state), PLUS a dead-end / error-path audit (malformed calls must fail LOUDLY —
// never a silent success, never a sandbox-wedging crash). Uses hidden gmlayer SCRATCH tokens only;
// never touches turn order or real tokens; deletes everything at the end.
//
// Run:  npx tsx src/recon/ux-scenario-it.ts
process.env.ROLL20_TRANSPORT = "rt";

import { relayCommand } from "../bridge/roll20.js";
import { rtGet, rtRemove } from "../bridge/roll20-rt.js";

let pass = 0, fail = 0;
const check = (label: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.error(`  ✓ ${label}${detail ? " — " + detail : ""}`); }
  else { fail++; console.error(`  ✗ FAIL: ${label}${detail ? " — " + detail : ""}`); }
};
// Assert a relay call REJECTS (loud failure) rather than silently succeeding.
async function expectError(label: string, p: Promise<unknown>) {
  try { const r = await p; check(label + " (should error)", false, "resolved: " + JSON.stringify(r)); }
  catch { pass++; console.error(`  ✓ ${label} → rejected as expected`); }
}

async function main() {
  const pid = (await rtGet<{ playerpageid?: string }>("campaign"))?.playerpageid!;
  const graphics = await rtGet<Record<string, { imgsrc?: string }>>(`graphics/page/${pid}`);
  const imgsrc = Object.values(graphics || {}).map((g) => g.imgsrc).find(Boolean);
  const made: string[] = [];
  const mk = async (name: string, controlledby = "") => {
    const { id } = await relayCommand<{ id: string }>({ action: "createToken", pageId: pid, name, imgsrc, left: 35, top: 35, width: 70, height: 70, layer: "gmlayer", ...(controlledby ? {} : {}) });
    if (controlledby) await relayCommand({ action: "setTokenProps", tokenId: id, props: { controlledby } });
    made.push(id);
    return id;
  };
  const tok = async (id: string) => rtGet<Record<string, unknown>>(`graphics/page/${pid}/${id}`);

  try {
    console.error("== combat lifecycle ==");
    const npc = await mk("UX-Goblin");
    const pc = await mk("UX-Hero", "soak-fake-player");
    check("two scratch tokens created", made.length === 2);

    // NPC HP on the bar; PC HP in the gmnotes block (routing).
    await relayCommand({ action: "setTokenBar", tokenId: npc, value: 7, max: 7 });
    await relayCommand({ action: "adjustPcHp", tokenId: pc, setHp: 24 });
    const npcT = await tok(npc); const pcHp = await relayCommand<{ current: number }>({ action: "getPcHp", tokenId: pc });
    check("NPC HP on bar", Number(npcT?.bar1_value) === 7, `bar1=${npcT?.bar1_value}`);
    check("PC HP in gmnotes block", Number(pcHp?.current) === 24, `pc=${pcHp?.current}`);
    check("INVARIANT: NPC hp within [0,max]", Number(npcT?.bar1_value) >= 0 && Number(npcT?.bar1_value) <= Number(npcT?.bar1_max));

    // Condition on, then off — marker appears then clears (no orphan).
    await relayCommand({ action: "toggleCondition", tokenId: npc, condition: "poisoned", active: true });
    check("condition marker applied", String((await tok(npc))?.statusmarkers || "").includes("Poisoned::4444329"));
    await relayCommand({ action: "toggleCondition", tokenId: npc, condition: "poisoned", active: false });
    check("INVARIANT: condition marker cleared (no orphan)", !String((await tok(npc))?.statusmarkers || "").includes("Poisoned::4444329"));

    // Death transition: damage to 0 → mark dead + move to map layer (the dead-token rule).
    await relayCommand({ action: "setTokenBar", tokenId: npc, value: 0 });
    await relayCommand({ action: "batchExec", ops: [
      { id: "d", action: "toggleCondition", args: { tokenId: npc, condition: "dead", active: true } },
      { id: "l", action: "setTokenProps", args: { tokenId: npc, props: { layer: "map" } } },
    ] });
    const dead = await tok(npc);
    check("dead marker set", String(dead?.statusmarkers || "").includes("Unconscious::4444317"));
    check("INVARIANT: dead token moved to map layer", dead?.layer === "map", `layer=${dead?.layer}`);
    check("INVARIANT: HP floored at 0 (no negative)", Number(dead?.bar1_value) === 0);

    console.error("== dead-end / error-path audit (must fail loudly, not silently) ==");
    await expectError("setTokenProps with empty props", relayCommand({ action: "setTokenProps", tokenId: npc, props: {} }));
    await expectError("setTokenBar with non-finite value", relayCommand({ action: "setTokenBar", tokenId: npc, value: "NaN-ish" as unknown as number }));
    await expectError("adjustPcHp with no damage/heal/setHp", relayCommand({ action: "adjustPcHp", tokenId: pc }));
    await expectError("toggleCondition on bogus token", relayCommand({ action: "toggleCondition", tokenId: "-bogusXYZ", condition: "poisoned", active: true, __forceMod: true }));
    // getTokenById on a bogus id is a READ — should resolve to null (handled), not crash.
    const bogus = await relayCommand({ action: "getTokenById", tokenId: "-bogusXYZ", __forceMod: true });
    check("getTokenById(bogus) → null (handled, no crash)", bogus === null, JSON.stringify(bogus));

    console.error(`\n${fail === 0 ? "✅" : "❌"} UX SCENARIO: ${pass} passed, ${fail} failed`);
  } finally {
    for (const id of made) await rtRemove(`graphics/page/${pid}/${id}`).catch(() => {});
    console.error(`[cleanup] removed ${made.length} scratch tokens`);
  }
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error("❌ ux scenario crashed:", e); process.exit(1); });
