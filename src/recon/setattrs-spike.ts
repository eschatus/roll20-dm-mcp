// ─────────────────────────────────────────────────────────────────────────────
// #206 — does an API-side `setAttrs` fire the sheet's own workers?
//
// Two workarounds in this repo exist because sheet workers never observe an attribute created
// through `createObj("attribute")`:
//   1. the hand-written `rollbase` + companion-field scaffolding for repeating_npcaction rows
//      (attack_tohitrange, attack_onhit, damage_flag, attack_crit, attack_crit2), and
//   2. the <ability>_mod derivation inside ACTIONS["createCharacter"].
// Roll20 documents `setAttrs(charId, attrs, options)` on both sandbox versions, and it defaults to
// `setWithWorker`. If the sheet's workers really do run, BOTH workarounds are dead weight.
//
// The emulator cannot answer this — it has no character sheet. So: run it against a live campaign.
//
// RUN:  npx tsx src/recon/setattrs-spike.ts [--keep]
// Needs a deployed relay that carries ACTIONS["setAttrs"] (probed up front, not inferred from a
// version number) and a furnished <data dir>/roll20-rt-token.json for the active campaign.
// --keep leaves the scratch character behind for inspection; by default it is deleted.
//
// READBACK IS OFF RTDB, NOT OVER CHAT. `rollbase` is a macro template full of literal `@{` and
// `[[`; Roll20 live-evaluates those on every outgoing chat message and a malformed one disables
// the whole Mod sandbox asynchronously. Relay >= 2.7.0 percent-encodes its result payload, which
// makes the chat path structurally safe again — but reading the RTDB `char-blobs` node never
// touches chat at all, so that is what this uses. Do not "simplify" it to
// getCharacterAttributes.
// ─────────────────────────────────────────────────────────────────────────────
import { relayCommand } from "../bridge/roll20.js";
import { rtGet } from "../bridge/roll20-rt.js";

const KEEP = process.argv.includes("--keep");

/**
 * A Roll20-shaped repeating-row id (Firebase push-id alphabet, 20 chars, leading "-"). The
 * relay's `$0` index syntax needs a row to already exist to address; on a character with zero
 * rows the safe move is to mint the id ourselves, exactly as a sheet's generateRowID() would.
 * Note the alphabet CONTAINS "_", so nothing downstream may split a row id on underscores.
 */
function mintRowId(): string {
  const alphabet = "-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz";
  let id = "-";
  for (let i = 0; i < 19; i++) id += alphabet[Math.floor(Math.random() * alphabet.length)];
  return id;
}

const SCORES: Record<string, number> = {
  strength: 16, dexterity: 12, constitution: 15,
  intelligence: 7, wisdom: 11, charisma: 9,
};
// Math.floor((score - 10) / 2) — what createCharacter currently computes by hand.
const EXPECTED_MODS: Record<string, number> = {
  strength: 3, dexterity: 1, constitution: 2,
  intelligence: -2, wisdom: 0, charisma: -1,
};

// What we write into the minted npcaction row. Every one of these must read back before a verdict.
const ROW_INPUTS: Record<string, string | number> = {
  name: "Greatclub",
  attack_tohit: 5,
  attack_damage: "2d8+3",
  attack_damagetype: "bludgeoning",
  "npc_options-flag": 0,
};

// The fields the 5e OGL sheet's own worker is supposed to generate for an attack row. We write
// NONE of them; if any appears, a worker ran.
const COMPANION_FIELDS = [
  "attack_tohitrange", "attack_onhit", "damage_flag",
  "attack_crit", "attack_crit2", "rollbase",
];

type SetAttrsResult = {
  written: string[];
  silent: boolean;
  workersExecuted: boolean | null;
  note: string | null;
  sheet: { sandbox: string | null; sheetName: string | null; beacon: boolean };
};

type Attr = { name?: string; current?: unknown; max?: unknown };

/**
 * Read every attribute off the RTDB char-blob, keyed by LOWER-CASED name — Roll20 folds attribute
 * names case-insensitively, so a minted mixed-case row id may read back in another case.
 * Chat-free, so a rollbase value is harmless.
 */
async function readAttrs(charId: string): Promise<Map<string, Attr>> {
  const blob = await rtGet<Record<string, unknown>>(`char-blobs/${charId}`).catch(() => null);
  const raw = (blob?.attribs ?? blob?.attributes) as Record<string, Attr> | undefined;
  const out = new Map<string, Attr>();
  for (const [key, a] of Object.entries(raw ?? {})) {
    // The node is keyed by attribute id and each entry carries its own `name`; fall back to the
    // key if this campaign's backend shape differs (the schema was probed, not documented).
    out.set(String(a?.name ?? key).toLowerCase(), a ?? {});
  }
  return out;
}

function cur(attrs: Map<string, Attr>, name: string): string | null {
  const a = attrs.get(name.toLowerCase());
  if (!a) return null;
  return a.current === undefined || a.current === null ? "" : String(a.current);
}

async function main() {
  const ping = await relayCommand<Record<string, unknown>>({ action: "ping" });
  console.error(`relay v${ping.version} · sandbox ${ping.sandbox ?? "?"} · node ${ping.node ?? "?"}`
    + ` · sheet ${ping.sheetName ?? "?"} · beacon ${ping.beacon}`);
  // Capability probe: a relay without the action answers "Unknown action"; one with it answers
  // "charId is required". Neither touches any character.
  try {
    await relayCommand({ action: "setAttrs" });
    throw new Error("setAttrs probe unexpectedly succeeded with no charId");
  } catch (e) {
    const text = String(e);
    if (/Unknown action/i.test(text)) {
      throw new Error(`this campaign is on relay ${ping.version}, which has no ACTIONS["setAttrs"] — `
        + "paste mod-scripts/ai-relay.js into the campaign API console first");
    }
    if (!/charId is required/.test(text)) throw e;
  }

  const { id: charId } = await relayCommand<{ id: string }>({
    action: "createCharacter",
    name: `SETATTRS-SPIKE-${process.pid}`,
    // NO attributes: createCharacter's own _mod derivation only fires for scores passed here, so
    // an empty character leaves the derivation question entirely to setAttrs.
    gmnotes: "#206 setAttrs spike — scratch character, safe to delete.",
  });
  console.error(`scratch character: ${charId}`);

  try {
    // ── Arm 1: ability scores, no _mod written ───────────────────────────────
    const abilityWrite = await relayCommand<SetAttrsResult>({
      action: "setAttrs",
      charId,
      attributes: { ...SCORES, npc: 1, npc_name: "Spike Dummy" },
    });
    console.error(`\nability write → workersExecuted=${abilityWrite.workersExecuted}`
      + (abilityWrite.note ? ` (${abilityWrite.note})` : "")
      + ` · beacon=${abilityWrite.sheet.beacon}`);

    // ── Arm 2: one npcaction row, none of the companion fields ───────────────
    const mintedRow = mintRowId();
    const rowWrite = await relayCommand<SetAttrsResult>({
      action: "setAttrs",
      charId,
      attributes: Object.fromEntries(
        Object.entries(ROW_INPUTS).map(([field, v]) => [`repeating_npcaction_${mintedRow}_${field}`, v]),
      ),
    });
    console.error(`npcaction row id minted: ${mintedRow}`);
    console.error(`npcaction write → workersExecuted=${rowWrite.workersExecuted}`
      + (rowWrite.note ? ` (${rowWrite.note})` : ""));

    // Sheet workers are async even once the queue reports drained; give them room.
    await new Promise((r) => setTimeout(r, 4000));

    const attrs = await readAttrs(charId);
    if (attrs.size === 0) {
      throw new Error("RTDB readback returned no attributes — cannot judge. Check char-blobs "
        + `shape for this campaign (src/recon/rtdb-schema.ts) and inspect ${charId} by hand.`);
    }

    // ── Precondition: did the INPUT writes land? ─────────────────────────────
    // Sheet defaults can make the blob non-empty even when nothing we wrote arrived. A verdict
    // computed on top of that would blame the workers for a failed write, so demand every input
    // first and treat any gap as inconclusive rather than NEGATIVE.
    const missingInputs: string[] = [];
    for (const [name, want] of Object.entries(SCORES)) {
      const got = cur(attrs, name);
      if (got === null || Number(got) !== want) missingInputs.push(`${name}=${got === null ? "<absent>" : JSON.stringify(got)} (want ${want})`);
    }
    // Row ids can contain "_", so split on the KNOWN field suffixes rather than on underscores.
    const rowFieldRe = new RegExp(`^repeating_npcaction_(.+)_(${[...Object.keys(ROW_INPUTS), ...COMPANION_FIELDS]
      .map((f) => f.replace(/[-$]/g, "\\$&")).join("|")})$`, "i");
    const candidateRows = new Set<string>();
    for (const name of attrs.keys()) {
      const m = rowFieldRe.exec(name);
      if (m) candidateRows.add(m[1]);
    }
    const rowIds = [...candidateRows].filter((rowId) =>
      Object.entries(ROW_INPUTS).every(([field, want]) =>
        cur(attrs, `repeating_npcaction_${rowId}_${field}`) === String(want)));
    if (!rowIds.some((r) => r.toLowerCase() === mintedRow.toLowerCase())) {
      console.error(`⚠ minted row ${mintedRow} not among rows carrying the inputs (${rowIds.join(", ") || "<none>"})`);
    }
    if (rowIds.length === 0) {
      missingInputs.push(`no npcaction row carries all of {${Object.keys(ROW_INPUTS).join(", ")}}`
        + ` (rows seen: ${candidateRows.size ? [...candidateRows].join(", ") : "<none>"})`);
    }
    if (missingInputs.length) {
      throw new Error("INCONCLUSIVE — the setAttrs inputs did not land, so worker behaviour cannot be judged:\n  "
        + missingInputs.join("\n  ")
        + `\n  Inspect ${charId} by hand (rerun with --keep) before reading anything into this.`);
    }
    console.error(`\ninputs landed: ${Object.keys(SCORES).length} scores · npcaction row ${rowIds.join(", ")}`);

    // ── Verdict 1: <ability>_mod derivation ──────────────────────────────────
    console.error("\n<ability>_mod derivation:");
    let modsDerived = 0;
    for (const ability of Object.keys(SCORES)) {
      const got = cur(attrs, `${ability}_mod`);
      const want = EXPECTED_MODS[ability];
      const ok = got !== null && got !== "" && Number(got) === want;
      if (ok) modsDerived++;
      console.error(`  ${ability}_mod: ${got === null ? "<absent>" : JSON.stringify(got)} (want ${want}) ${ok ? "✅" : "❌"}`);
    }

    // ── Verdict 2: the rollbase scaffolding ──────────────────────────────────
    console.error(`\nnpcaction rows materialised: ${rowIds.join(", ")}`);
    let companionsPresent = 0;
    for (const rowId of rowIds) {
      for (const field of COMPANION_FIELDS) {
        const name = `repeating_npcaction_${rowId}_${field}`;
        const got = cur(attrs, name);
        const present = got !== null && got !== "";
        if (present) companionsPresent++;
        // Print rollbase's LENGTH, never its text — it is full of @{ and [[ and this output can
        // end up pasted into places that evaluate them.
        const shown = got === null ? "<absent>" : field === "rollbase" ? `<${got.length} chars>` : JSON.stringify(got);
        console.error(`  ${field}: ${shown} ${present ? "✅" : "❌"}`);
      }
    }

    // ── Conclusion ───────────────────────────────────────────────────────────
    const modsWork = modsDerived === Object.keys(SCORES).length;
    const rollbaseWorks = companionsPresent === COMPANION_FIELDS.length * rowIds.length;
    console.error("\n──────── verdict ────────");
    console.error(`_mod derivation by sheet worker:  ${modsWork ? "YES ✅" : `NO ❌ (${modsDerived}/${Object.keys(SCORES).length})`}`);
    console.error(`rollbase scaffolding by worker:   ${rollbaseWorks ? "YES ✅" : `NO ❌ (${companionsPresent}/${COMPANION_FIELDS.length * rowIds.length})`}`);
    console.error(
      modsWork && rollbaseWorks
        ? "\n→ POSITIVE. Route createCharacter/setCharacterAttributes through setAttrs, delete the\n"
          + "  ABILITY_NAMES derivation block and the rollbase template, and cut both CLAUDE.md gotchas."
        : "\n→ NEGATIVE (or partial). Record this in docs/roll20-api-coverage.md under #206 with the\n"
          + "  relay/sandbox/sheet versions printed above, and KEEP both workarounds."
    );
    console.error("\nReproduce the readback by hand: rtGet(`char-blobs/" + charId + "`)");
  } finally {
    if (KEEP) {
      console.error(`\n--keep: scratch character ${charId} left in place.`);
    } else {
      await relayCommand({ action: "removeObject", objectType: "character", objectId: charId })
        .then(() => console.error(`\ncleaned up scratch character ${charId}`))
        .catch((e) => console.error(`\n⚠ could not delete scratch character ${charId}: ${e}`));
    }
  }
}

main().then(() => process.exit(process.exitCode || 0), (e) => { console.error("❌ spike FAILED:", e); process.exit(1); });
