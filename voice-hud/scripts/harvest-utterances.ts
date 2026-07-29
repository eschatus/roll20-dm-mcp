// Mines the voice HUD's own run log (hud.log, JSONL) for OBSERVED DM SPEECH STYLE —
// filler/hedge phrases and disfluency patterns — to feed scripts/utterance-render.ts's
// renderer banks. Deliberately does NOT harvest labels: the log's `[agent] turn start:`
// lines are raw STT transcripts of what the DM said, never what tool the agent called
// (that's Haiku's/the teacher's output and may be wrong) — so this script only touches
// the human's words, never any downstream action.
//
// It also deliberately avoids harvesting literal player/campaign-specific proper nouns
// (character names, module content) into the committed patterns file — those are real
// people's data sitting in a personal log. What it DOES keep:
//   - generic English discourse markers (hedges/fillers) — not identifying
//   - a small set of MODULE/MECHANIC mishears that already appear near-verbatim in the
//     repo's own dictation glossary (memory) or literally in the log (e.g. "Phandelver"
//     fragmenting into "Fan Dover"/"Van Delver") — proper-noun mishears of a published
//     module title, not personal data.
//
//   npx tsx scripts/harvest-utterances.ts [path-to-hud.log]
//   DMW_HUD_LOG=/custom/path npx tsx scripts/harvest-utterances.ts
//
// Writes voice-hud/data/utterance-patterns.json, consumed by utterance-render.ts (with
// a hardcoded fallback bank, so nothing downstream breaks if this hasn't been run).

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const DEFAULT_LOG = path.join(os.homedir(), "AppData", "Roaming", "DM Whisper", "hud.log");
const LOG_PATH = process.argv[2] || process.env.DMW_HUD_LOG || DEFAULT_LOG;
// scripts/ (not data/) deliberately — see utterance-render.ts's loadUtterancePatterns
// comment: data/ is gitignored wholesale, but this bank must survive as a checked-in
// fallback resource.
const OUT_PATH = path.join(__dirname, "utterance-patterns.json");

// Generic English discourse markers — safe to keep verbatim regardless of source.
const HEDGE_CANDIDATES = [
  "okay so", "alright,", "alright so", "let's see", "actually,", "actually make that",
  "hold on", "wait,", "so,", "well,", "hang on,", "right, so", "ok so", "hmm,",
];
const FILLER_CANDIDATES = ["um,", "uh,", "like,", "you know,"];

// Module/mechanic mishears already visible near-verbatim in this codebase's own
// dictation glossary (memory) or observed live in the log for a PUBLISHED module
// title (not a person's name) — kept as a curated seed, extended by whatever the log
// itself corroborates.
const SEED_MISHEAR_PAIRS: [string, string][] = [
  ["Phandelver", "Fandelver"],
  ["Phandelver", "Fan Dover"],
  ["Phandelver", "Van Delver"],
  ["Beyond Phandelver", "Beyond Fentelner"],
  ["DDB", "d4 Beyond"],
  ["send", "Zeond"],
  ["Curse of Strahd", "cursive strat"],
  ["Cali", "Kelly"],
  ["Zeno casts", "Xenocast"],
  ["Flameskull the Gaunt", "Flamesgoldagaunt"],
  ["for", "four"], ["to", "too"], ["won", "one"], ["ate", "eight"],
  ["hit points", "aitch pee"],
];

function readTranscripts(logPath: string): string[] {
  let raw: string;
  try {
    raw = fs.readFileSync(logPath, "utf8");
  } catch {
    console.warn(`[harvest-utterances] no log at ${logPath} — writing seed-only patterns file.`);
    return [];
  }
  const out: string[] = [];
  for (const line of raw.split("\n")) {
    if (!line.includes("[agent] turn start:")) continue;
    let obj: { msg?: string } | null = null;
    try { obj = JSON.parse(line); } catch { continue; }
    const msg = obj?.msg;
    if (!msg) continue;
    const m = msg.match(/^\[agent\] turn start: "([\s\S]*)"$/);
    if (!m) continue;
    // The logged msg has already been JSON-decoded once by JSON.parse above (escapes like
    // \n resolved) — the captured group is the raw transcript text.
    out.push(m[1]);
  }
  return out;
}

function main() {
  const transcripts = readTranscripts(LOG_PATH);

  const hedgesSeen = new Set<string>();
  const fillersSeen = new Set<string>();
  for (const t of transcripts) {
    const lower = t.toLowerCase();
    for (const h of HEDGE_CANDIDATES) if (lower.includes(h)) hedgesSeen.add(h);
    for (const f of FILLER_CANDIDATES) if (lower.includes(f)) fillersSeen.add(f);
  }

  // Corroborate the seed mishear pairs against the log: keep a pair only if either its
  // canonical or mangled form actually appears (so the committed file reflects real
  // observed usage, not a purely invented bank), but ALWAYS keep the curated seed as a
  // floor even with zero transcripts (fresh checkout / no log on this machine).
  const corroborated: [string, string][] = SEED_MISHEAR_PAIRS.filter(([canon, heard]) =>
    transcripts.length === 0 || transcripts.some((t) => t.includes(canon) || t.includes(heard)));

  const patterns = {
    hedges: hedgesSeen.size ? [...hedgesSeen] : HEDGE_CANDIDATES,
    fillers: fillersSeen.size ? [...fillersSeen] : FILLER_CANDIDATES,
    mishearPairs: corroborated.length ? corroborated : SEED_MISHEAR_PAIRS,
    meta: {
      // Basename only — the full path is machine-local (contains the OS username) and
      // has no business in a committed file.
      sourceLog: transcripts.length ? path.basename(LOG_PATH) : null,
      transcriptsScanned: transcripts.length,
      generatedAt: new Date().toISOString().slice(0, 10),
    },
  };

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(patterns, null, 2) + "\n");
  console.log(`[harvest-utterances] scanned ${transcripts.length} transcripts from ${LOG_PATH}`);
  console.log(`  hedges: ${patterns.hedges.length}, fillers: ${patterns.fillers.length}, mishear pairs: ${patterns.mishearPairs.length}`);
  console.log(`  wrote ${OUT_PATH}`);
}

if (require.main === module) main();

export { readTranscripts };
