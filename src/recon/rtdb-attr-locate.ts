// ─────────────────────────────────────────────────────────────────────────────
// #230 / #225 — WHERE in the campaign's Firebase RTDB do character attributes live?
//
// Two things are blocked on this one fact:
//   • #225's setAttrs spike reads back from `char-blobs/<id>`, which the repo's own schema probes
//     show carries only `defaulttoken` — so it can never reach a verdict;
//   • #230, the browserless replacement for the deleted CDP attribute-dump scripts — the only
//     chat-free way to verify a `rollbase`-class write (see the CLAUDE.md sandbox-killer gotcha).
//
// RUN (active campaign, furnished <data dir>/roll20-rt-token.json):
//   npx tsx src/recon/rtdb-attr-locate.ts                  read-only survey, writes nothing
//   npx tsx src/recon/rtdb-attr-locate.ts --sentinel       + write a sentinel, find its exact path
//   options:  --char=<characterId>   survey this character instead of the first one listed
//             --keep                 (sentinel mode) leave the scratch character for inspection
//
// SURVEY (default): shallow-lists the storage root, then every root key that looks sheet-related,
// then a list of candidate per-character paths for a real character id. Shallow reads return keys
// only, so nothing large is downloaded and nothing is written.
//
// SENTINEL (--sentinel): creates a scratch character over the relay, writes three attributes whose
// values contain a unique plain-text marker (a plain attribute, a current/max pair, and a
// repeating_npcaction row field), then full-reads each candidate per-character subtree and
// searches for the marker. A hit gives the exact node, the record shape, and how `_max` and
// repeating rows are stored. The scratch character is removed afterwards unless --keep.
// The marker is alphanumeric — no `[[`, `@{`, `%{`, `&{` — so the relay's chat echo is harmless
// even before the 2.7.0 percent-encoding; the readback itself never touches chat.
//
// Output: stderr summary + JSON under the gitignored .tmp-test-data/.
// ─────────────────────────────────────────────────────────────────────────────
import { writeFileSync, mkdirSync } from "fs";
import path from "path";
import { relayCommand } from "../bridge/roll20.js";
import { rtGet } from "../bridge/roll20-rt.js";
import { CHAR_KEY_HINT, candidatePaths, childCount, findValuePaths, templatize, type Hit } from "./rtdb-attr-locate-lib.js";

const argv = process.argv.slice(2);
const SENTINEL = argv.includes("--sentinel");
const KEEP = argv.includes("--keep");
const CHAR_ARG = argv.find((a) => a.startsWith("--char="))?.slice("--char=".length);

type Probe = { path: string; ok: boolean; children: number | null; sampleKeys: string[]; keys: string[]; error?: string };

async function shallow(p: string): Promise<Probe> {
  try {
    const v = await rtGet<Record<string, unknown> | null>(p, { shallow: true });
    const keys = v && typeof v === "object" ? Object.keys(v) : [];
    return { path: p || "<root>", ok: v !== null, children: childCount(v), sampleKeys: keys.slice(0, 8), keys };
  } catch (e) {
    return { path: p || "<root>", ok: false, children: null, sampleKeys: [], keys: [], error: String((e as Error)?.message ?? e).slice(0, 200) };
  }
}

function line(p: Probe): string {
  if (p.error) return `  ✗ ${p.path}  ERROR ${p.error}`;
  if (!p.ok) return `  · ${p.path}  <absent>`;
  return `  ✓ ${p.path}  ${p.children} children  e.g. ${JSON.stringify(p.sampleKeys.slice(0, 5))}`;
}

async function survey(charId: string) {
  console.error("── storage root ──");
  const root = await shallow("");
  console.error(line(root));
  const rootKeys = root.keys;
  if (rootKeys.length) console.error(`  root keys: ${JSON.stringify(rootKeys)}`);

  // Every root key that smells like sheet data: list it, and if it's keyed by `char`, look for
  // this character under both `<key>/char/<id>` and `<key>/<id>`.
  const hinted = rootKeys.filter((k) => CHAR_KEY_HINT.test(k));
  const discovered: string[] = [];
  console.error(`\n── sheet-related root keys (${hinted.length}) ──`);
  for (const k of hinted) {
    const p = await shallow(k);
    console.error(line(p));
    if (p.keys.includes("char")) discovered.push(`${k}/char/${charId}`);
    discovered.push(`${k}/${charId}`);
  }

  const paths = [...new Set([...candidatePaths(charId), ...discovered])];
  console.error(`\n── per-character candidates for ${charId} (${paths.length}) ──`);
  const probes: Probe[] = [];
  for (const p of paths) {
    const r = await shallow(p);
    probes.push(r);
    console.error(line(r));
  }
  return { root, rootKeys, hinted, probes, candidateList: paths };
}

async function pickCharacter(): Promise<string> {
  if (CHAR_ARG) return CHAR_ARG;
  const list = await rtGet<Record<string, unknown> | null>("characters", { shallow: true });
  const first = list ? Object.keys(list)[0] : undefined;
  if (!first) throw new Error("no characters in this campaign's RTDB `characters` node — pass --char=<id>");
  return first;
}

async function sentinelRun(): Promise<Record<string, unknown>> {
  const ping = await relayCommand<Record<string, unknown>>({ action: "ping" });
  console.error(`\nrelay v${ping.version} · sandbox ${ping.sandbox ?? "?"} · sheet ${ping.sheetName ?? "?"} · beacon ${ping.beacon}`);

  const marker = `ATTRPROBE${process.pid}T${Date.now()}`;
  const rowId = `-attrprobe${process.pid}`;
  const { id: charId } = await relayCommand<{ id: string }>({
    action: "createCharacter",
    name: `ATTRPROBE-${process.pid}`,
    gmnotes: "#230 RTDB attribute-locator probe — scratch character, safe to delete.",
  });
  console.error(`scratch character: ${charId}`);

  try {
    const write = await relayCommand<{ failed?: string[]; reasons?: Record<string, string> }>({
      action: "setCharacterAttributes",
      charId,
      attributes: {
        attrprobe_plain: `${marker}-plain`,
        attrprobe_pair: { current: `${marker}-cur`, max: `${marker}-max` },
        [`repeating_npcaction_${rowId}_name`]: `${marker}-row`,
      },
    });
    console.error(`write → ${JSON.stringify(write).slice(0, 300)}`);
    // A refused write is not a location finding: without this, a missing marker would print as
    // NOT FOUND and blame the RTDB node for a write that never happened (Devin, #231).
    if (write.failed?.length) {
      throw new Error(`INCONCLUSIVE — the relay refused ${write.failed.join(", ")}: `
        + `${JSON.stringify(write.reasons ?? {})}. Nothing was written to locate.`);
    }

    // Give the Mod → RTDB propagation a moment (client-direct writes land in ~150ms; be generous).
    await new Promise((r) => setTimeout(r, 2500));

    const { candidateList, ...surveyed } = await survey(charId);
    console.error(`\n── searching ${candidateList.length} candidate subtrees for "${marker}" ──`);
    const hits: Array<Hit & { root: string; template: string }> = [];
    // A subtree we could not READ is not a subtree without the marker. Some candidates are denied
    // by Roll20's rules (401), so a failed read is recorded and reported, never folded into "absent".
    const unreadable: Array<{ path: string; error: string }> = [];
    for (const p of candidateList) {
      let tree: unknown;
      try {
        tree = await rtGet<unknown>(p);
      } catch (e) {
        unreadable.push({ path: p, error: String((e as Error)?.message ?? e).slice(0, 120) });
        continue;
      }
      if (tree === null || tree === undefined) continue;
      for (const h of findValuePaths(tree, marker)) {
        const full = `${p}/${h.path}`;
        hits.push({ ...h, root: p, template: templatize(full, charId) });
      }
    }

    console.error("\n──────── result ────────");
    if (unreadable.length) {
      console.error(`UNREADABLE (not searched): ${unreadable.map((u) => u.path).join(", ")}`);
    }
    if (!hits.length) {
      console.error("NO HIT in the readable subtrees. The marker is in none of the candidate subtrees. Check the root-key list above for a\n"
        + "sheet-shaped key the heuristics missed, then re-run with that path added to candidatePaths().");
    }
    for (const h of hits) {
      console.error(`  ${h.template}`);
      if (h.record) console.error(`      record: ${JSON.stringify(h.record).slice(0, 200)}`);
    }
    const where = locateEach(hits, marker);
    console.error("");
    for (const [kind, t] of Object.entries(where)) console.error(`  ${kind.padEnd(10)} ${t ?? "NOT FOUND"}`);
    return { mode: "sentinel", charId, marker, write, ...surveyed, hits, where, unreadable };
  } finally {
    if (KEEP) {
      console.error(`\n--keep: scratch character ${charId} left in place.`);
    } else {
      await relayCommand({ action: "removeObject", objectType: "character", objectId: charId })
        .then(() => console.error(`\ncleaned up scratch character ${charId}`))
        .catch((e) => { console.error(`\n⚠ could not delete scratch character ${charId}: ${e}`); process.exitCode = 1; });
    }
  }
}

/** Where did each of the four written values land? Template path per kind, or null. */
function locateEach(hits: Array<Hit & { template: string }>, marker: string): Record<string, string | null> {
  const find = (suffix: string) => hits.find((h) => h.value === marker + suffix)?.template ?? null;
  return { plain: find("-plain"), current: find("-cur"), max: find("-max"), repeating: find("-row") };
}

async function main() {
  let result: Record<string, unknown>;
  if (SENTINEL) {
    result = await sentinelRun();
  } else {
    const charId = await pickCharacter();
    console.error(`read-only survey · character ${charId}${CHAR_ARG ? " (--char)" : " (first listed)"}\n`);
    const s = await survey(charId);
    console.error("\nNext: re-run with --sentinel to pin the exact node with a known value.");
    result = { mode: "survey", charId, ...s };
  }
  const dir = path.resolve("./.tmp-test-data");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rtdb-attr-locate-${Date.now()}.json`);
  writeFileSync(file, JSON.stringify(result, null, 2), "utf-8");
  console.error(`\nfull → ${file}`);
}

main().then(() => process.exit(process.exitCode || 0), (e) => { console.error("❌ probe FAILED:", e); process.exit(1); });
