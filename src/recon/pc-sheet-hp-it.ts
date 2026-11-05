// Live half of test/pc-sheet-hp.test.ts: what the emulator cannot show about PC HP on a real sheet.
//   1. Does this campaign's sheet read and write its HP field through the sheet carriers?
//   2. Does a token bar linked to that field follow a Mod-side sheet write?
//   3. Is a write the sheet silently drops caught? (setSheetItem reports it as written.)
//   4. Do the character primitives work on a real sheet: journal list, blob read, ability
//      round trip, and a repeating row added and deleted?
//
// Run on a TEST campaign with someone in the game (an empty game has no Mod):
//   npx tsx src/recon/pc-sheet-hp-it.ts [field]
// Creates a scratch character and token on the player page and removes both on the way out.
process.env.ROLL20_TRANSPORT = "rt";
import { relayCommand } from "../bridge/roll20.js";
import { rtGet } from "../bridge/roll20-rt.js";
import { newRowId } from "../tools/character.js";
import { adjustSheetHp } from "../tools/pcHp.js";

type Read = { values: Record<string, unknown>; failed: string[]; reasons: Record<string, string>; sheet: unknown };
type Attr = { id: string; name?: string };

const field = process.argv[2] ?? "hp";
let bad = 0;
function check(what: string, ok: boolean, detail: unknown): void {
  if (!ok) bad++;
  console.error(`${ok ? "PASS" : "FAIL"}  ${what}: ${JSON.stringify(detail)}`);
}
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const campaign = await rtGet<{ playerpageid?: string }>("campaign");
  const pid = campaign?.playerpageid;
  if (!pid) throw new Error("campaign has no player page");
  const summary = await relayCommand<{ sandbox: string | null; sheetName: string | null; beacon: boolean }>({ action: "getSheetSummary" });
  console.error(`sheet: ${JSON.stringify(summary)}`);

  const graphics = await rtGet<Record<string, { imgsrc?: string }>>(`graphics/page/${pid}`);
  const imgsrc = Object.values(graphics ?? {}).map((g) => g.imgsrc).find(Boolean);
  const { id: charId } = await relayCommand<{ id: string }>({ action: "createCharacter", name: "RT-SHEET-HP-TEST" });
  let tokenId: string | undefined;
  try {
    // setSheetItem can't create a field on a Beacon sheet; setAttrs can.
    await relayCommand({ action: "setAttrs", charId, attributes: { [field]: { current: 30, max: 44 } } });
    await pause(2500);
    const cur = await relayCommand<Read>({ action: "getSheetItem", charId, names: [field], valtype: "current" });
    const max = await relayCommand<Read>({ action: "getSheetItem", charId, names: [field], valtype: "max" });
    check("reads back current", Number(cur.values[field]) === 30, cur.values);
    check("reads back max", Number(max.values[field]) === 44, max.values);

    const made = await relayCommand<{ id: string }>({
      action: "createToken", pageId: pid, name: "RT-SHEET-HP-TEST", imgsrc, layer: "gmlayer",
      left: 35, top: 35, width: 70, height: 70,
    });
    tokenId = made.id;
    await relayCommand({ action: "linkToken", tokenId, charId, bars: [{ bar: 1, attribute: field }] });
    const res = await adjustSheetHp({ id: tokenId, name: "scratch", represents: charId }, field, { damage: 12 });
    check("damage goes through the real path", res.current === 18 && res.max === 44, res);
    await pause(2500);
    const tok = await rtGet<{ bar1_value?: unknown; bar1_link?: string }>(`graphics/page/${pid}/${tokenId}`);
    check("linked bar follows the sheet write", Number(tok?.bar1_value) === 18, tok);

    const dropped = await adjustSheetHp({ id: tokenId, name: "scratch", represents: charId }, "rt_no_such_field", { setHp: 5 })
      .then((v) => ({ threw: false, v }), (e: Error) => ({ threw: true, v: e.message }));
    check("a dropped write is caught, not reported as done", dropped.threw, dropped);

    await relayCommand({ action: "editCharacter", charId, bio: "<p>scratch @{bio}</p>", gmnotes: "scratch gm" });
    await pause(1500);
    const listed = await relayCommand<{ id: string }[]>({ action: "listCharacters" });
    check("journal list holds it", listed.some((c) => c.id === charId), listed.length);
    const char = await relayCommand<{ bio?: string; gmnotes?: string }>({ action: "getCharacter", charId });
    check("reads bio and gmnotes", String(char.bio).includes("scratch") && String(char.gmnotes).includes("scratch"), char);

    const ability = await relayCommand<{ id: string }>({ action: "setAbility", charId, name: "RT test", abilityAction: "/me @{selected|token_name} [[1d20]]" });
    await relayCommand({ action: "setAbility", charId, abilityId: ability.id, description: "updated by id" });
    const abilities = await relayCommand<{ id: string; action: string; description: string }[]>({ action: "listAbilities", charId });
    const stored = abilities.find((a) => a.id === ability.id);
    check("ability updates by id", stored?.description === "updated by id", stored);
    check("ability text round-trips", stored?.action.includes("[[1d20]]") === true, stored);
    await relayCommand({ action: "removeObject", objectType: "ability", objectId: ability.id });

    const rowId = newRowId();
    await relayCommand({ action: "setAttrs", charId, attributes: { [`repeating_npcaction_${rowId}_name`]: "Bite" } });
    await pause(1500);
    const row = await rtGet<Record<string, Attr>>(`char-attribs/char/${charId}`);
    check("row landed under its id", Object.values(row ?? {}).some((a) => a.name?.toLowerCase().includes(rowId.toLowerCase())), rowId);
    const del = await relayCommand<{ removed: string[] }>({ action: "deleteAttributes", charId, prefix: `repeating_npcaction_${rowId}_` });
    check("row deleted", del.removed.length > 0, del);
  } finally {
    if (tokenId) await relayCommand({ action: "removeObject", objectType: "graphic", objectId: tokenId });
    await relayCommand({ action: "removeObject", objectType: "character", objectId: charId });
  }
  console.error(bad ? `${bad} check(s) failed` : "all checks passed");
  process.exit(bad ? 1 : 0);
}

main().catch((e) => {
  console.error("FAILED:", e instanceof Error ? e.message : e);
  process.exit(1);
});
