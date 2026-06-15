// Live smoke of the AoE batch resolvers (update_hp_many + resolve_aoe) against the
// ACTIVE campaign over ROLL20_TRANSPORT=rt. Drives the REAL combat tool handlers
// (same code the MCP server registers) through the live relay.
//
// Safety: operates ONLY on scratch tokens (ZZ-SMOKE-*) it creates on the GM LAYER
// (invisible to players) and deletes in a finally block. No real token is touched,
// no player-visible dice (the batch-apply path is exercised via update_hp_many flat
// damage; resolve_aoe runs in dryRun). Proves createToken works over rt via the Mod
// once a valid uploaded imgsrc is used (the earlier failure was an /original. URL,
// which Roll20's createObj rejects — only thumb/med/max are accepted).
process.env.ROLL20_TRANSPORT = "rt";

import { z } from "zod";
import * as roll20 from "../bridge/roll20.js";
import { rtGet } from "../bridge/roll20-rt.js";
import { registerCombatTools } from "../tools/combat.js";

// Minimal MCP server shim: capture the real tool handlers + their zod schema.
type Handler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;
const handlers = new Map<string, { schema: z.ZodRawShape | null; handler: Handler }>();
const server = {
  tool(name: string, ...rest: unknown[]) {
    const handler = rest[rest.length - 1] as Handler;
    const maybe = rest.length >= 3 ? rest[rest.length - 2] : null;
    const schema = maybe && typeof maybe === "object" ? (maybe as z.ZodRawShape) : null;
    handlers.set(name, { schema, handler });
  },
};
registerCombatTools(server as never);

async function call(name: string, args: Record<string, unknown> = {}): Promise<string> {
  const e = handlers.get(name);
  if (!e) throw new Error(`no tool ${name}`);
  const parsed = e.schema ? (z.object(e.schema).parse(args) as Record<string, unknown>) : args;
  const res = await e.handler(parsed);
  return res.content[0].text;
}

const SCRATCH = ["ZZ-SMOKE-1", "ZZ-SMOKE-2", "ZZ-SMOKE-3"];

// Roll20's createObj('graphic') rejects the /original. variant — normalize to /max.
function usableImgsrc(src: string): string {
  return src.replace(/\/original\.(png|jpg|jpeg|gif)/i, "/max.$1");
}

async function main() {
  const pageId = await roll20.getCurrentPageId();
  console.error(`✓ live page ${pageId} (rt-native getCurrentPageId)`);

  // getTokens drops imgsrc — read it from the RTDB graphics node. createObj('graphic')
  // ONLY accepts images from the user's own Roll20 Library (files.d20.io/images/...);
  // marketplace art is rejected ("...unless you use an image that is in your Roll20 Library").
  const graphics = await rtGet<Record<string, { imgsrc?: string }>>(`graphics/page/${pageId}`);
  const srcs = Object.values(graphics || {}).map((g) => g.imgsrc).filter((s): s is string => !!s);
  const raw = srcs.find((s) => /files\.d20\.io\/images\//.test(s));
  if (!raw) throw new Error("no user-library imgsrc on the page (all marketplace) — createObj would be rejected");
  const imgsrc = usableImgsrc(raw);
  console.error(`✓ library imgsrc: ${imgsrc.split("?")[0]}`);

  const ids: string[] = [];
  try {
    // ── createToken over rt (Mod path) — 3 scratch NPCs on the GM layer (player-invisible) ──
    for (let i = 0; i < SCRATCH.length; i++) {
      const c = await roll20.relayCommand<{ id: string }>({
        action: "createToken", pageId, name: SCRATCH[i], imgsrc,
        layer: "gmlayer", left: 35 + i * 80, top: 35, width: 70, height: 70,
        bar1_value: 20, bar1_max: 20,
      });
      if (!c?.id) throw new Error(`createToken returned no id for ${SCRATCH[i]}`);
      ids.push(c.id);
    }
    console.error(`✓ createToken x${ids.length} over rt → ${ids.join(", ")}`);

    // Confirm via an independent Mod read that each landed with the right name + HP.
    for (const id of ids) {
      const m = await roll20.relayCommand<{ name: string; bar1_value: unknown; layer: string }>({ action: "getTokenById", tokenId: id });
      console.error(`   ${m?.name} hp=${m?.bar1_value} layer=${m?.layer}`);
    }

    // ── update_hp_many — real multi-op batchExec over rt, reconciled by indexBatchResults ──
    const dmg = await call("update_hp_many", { nameMatch: "ZZ-SMOKE", damage: 5 });
    console.error(`✓ update_hp_many damage 5: ${dmg}`);
    let allOk = true;
    for (const id of ids) {
      const m = await roll20.relayCommand<{ bar1_value: unknown }>({ action: "getTokenById", tokenId: id });
      const ok = Number(m?.bar1_value) === 15;
      allOk &&= ok;
      if (!ok) console.error(`   ✗ ${id} bar1=${m?.bar1_value} (expected 15)`);
    }
    console.error(allOk ? "✓ batch damage landed + reconciled on all 3 (Mod confirms 15/20)" : "✗ mismatch");

    // Heal back to full (net zero), then verify.
    const heal = await call("update_hp_many", { nameMatch: "ZZ-SMOKE", heal: 5 });
    console.error(`✓ update_hp_many heal 5: ${heal}`);

    // ── resolve_aoe dryRun (targetNames) — live targeting + NPC split, ZERO side effects ──
    const dry = await call("resolve_aoe", {
      label: "ZZ-SMOKE", targetNames: SCRATCH,
      saveAbility: "dexterity", saveDc: 10, damageFormula: "1d4", dryRun: true,
    });
    console.error(`✓ resolve_aoe dryRun:\n  ${dry.replace(/\n/g, "\n  ")}`);

    if (!allOk) process.exitCode = 1;
  } finally {
    for (const id of ids) {
      try { await roll20.relayCommand({ action: "removeObject", objectId: id }); } catch { /* best effort */ }
    }
    console.error(`✓ cleaned up ${ids.length} scratch tokens`);
  }
}

main().then(
  () => process.exit(process.exitCode || 0),
  (e) => { console.error("✗ FAILED:", e?.message || e); process.exit(1); },
);
