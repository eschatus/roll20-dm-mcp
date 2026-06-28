// A/B STT harness — faster-whisper vs whisper.cpp on the same clips.
//
// Drives the PRODUCTION engine classes headlessly (no Electron), with the same vocab
// prompt + the same deterministic correction layer the gem uses — so you're comparing
// the real pipeline, not a toy.
//
// Run:   npm run ab:stt
// Clips: voice-hud/data/ab-clips/*.{wav,mp3,ogg,flac}
//        - record real ones by running the gem with DMW_SAVE_CLIPS=1, or drop any file in.
//        - optional ground-truth reference next to a clip as <clip>.txt → enables WER +
//          proper-noun recall. (A <clip>.draft.txt written by the gem is IGNORED — it's
//          the STT's own guess; edit it to truth and rename to .txt.)
// Vocab:  base vocab + DMW_AB_VOCAB="Strahd, Ireena, Haregon, ..." (campaign names).
import * as fs from "fs";
import * as path from "path";
import { FasterWhisperEngine } from "../src/stt/fasterWhisper";
import { WhisperCppEngine } from "../src/stt/whisperCpp";
import { WhisperServerEngine } from "../src/stt/whisperServer";
import { SttEngine } from "../src/stt/engine";
import { CONFIG } from "../src/config";
import { loadBaseVocab } from "../src/baseVocab";
import { correctTranscript } from "../src/correction";

const CLIP_DIR = process.env.DMW_AB_CLIPS || path.join(__dirname, "..", "data", "ab-clips");

// ── metrics ────────────────────────────────────────────────────────────────
const words = (s: string): string[] => s.toLowerCase().replace(/[^a-z0-9' ]+/g, " ").split(/\s+/).filter(Boolean);

function editDistance(a: string[], b: string[]): number {
  const m = a.length, n = b.length;
  const d = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = 0; i <= m; i++) d[i][0] = i;
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[m][n];
}
function wer(ref: string, hyp: string): number {
  const r = words(ref);
  if (!r.length) return words(hyp).length ? 1 : 0;
  return editDistance(r, words(hyp)) / r.length;
}
// Proper nouns in the reference (capitalized, non-sentence-initial) — the names that matter.
function keyTerms(ref: string): string[] {
  const toks = ref.split(/\s+/);
  const set = new Set<string>();
  toks.forEach((t, i) => { const w = t.replace(/[^A-Za-z'-]/g, ""); if (i > 0 && /^[A-Z][a-z]/.test(w)) set.add(w.toLowerCase()); });
  return [...set];
}
function recall(terms: string[], hyp: string): [hit: number, total: number] {
  if (!terms.length) return [0, 0];
  const h = new Set(words(hyp));
  return [terms.filter((t) => h.has(t)).length, terms.length];
}
const pct = (x: number) => (x * 100).toFixed(1) + "%";

// ── engine startup (with graceful fallback) ──────────────────────────────────
async function startFaster(): Promise<SttEngine | null> {
  const cfgs = [
    { model: CONFIG.stt.model, device: CONFIG.stt.device, computeType: CONFIG.stt.computeType },
    { model: "small", device: "cpu", computeType: "int8" },
  ];
  for (const c of cfgs) {
    const e = new FasterWhisperEngine({ python: CONFIG.stt.python, script: CONFIG.stt.script, ...c });
    try { await e.start(); console.error(`[ab] faster-whisper up: ${e.name} (${c.device})`); return e; }
    catch (err) { console.error(`[ab] faster-whisper ${c.model}/${c.device} failed: ${(err as Error).message}`); await e.stop(); }
  }
  return null;
}
async function startWhisperCpp(): Promise<SttEngine | null> {
  const e = new WhisperCppEngine({ binPath: CONFIG.whisperBin, modelPath: CONFIG.whisperModel });
  try { await e.start(); console.error(`[ab] whisper.cpp up: ${e.name}`); return e; }
  catch (err) { console.error(`[ab] whisper.cpp failed: ${(err as Error).message}`); return null; }
}
// The RESIDENT whisper-server — what the gem actually uses (model loads once). DMW_WHISPER_SERVER_BIN
// + DMW_WHISPER_MODEL + DMW_WHISPER_SERVER_PORT select the binary/model/port, so the same harness
// run can benchmark a CPU build vs a cuBLAS/Metal GPU build by swapping the bin.
async function startWhisperServer(): Promise<SttEngine | null> {
  const e = new WhisperServerEngine({ binPath: CONFIG.whisperServerBin, modelPath: CONFIG.whisperModel, port: CONFIG.whisperServerPort });
  try { await e.start(); console.error(`[ab] whisper-server up: ${e.name} (port ${CONFIG.whisperServerPort})`); return e; }
  catch (err) { console.error(`[ab] whisper-server failed: ${(err as Error).message}`); return null; }
}

interface Row { engine: string; ms: number; raw: string; corr: string; lowConf: boolean; werRaw?: number; werCorr?: number; hit?: number; tot?: number }
interface Agg { ms: number[]; werRaw: number[]; werCorr: number[]; hit: number; tot: number; low: number }

async function main(): Promise<void> {
  if (!fs.existsSync(CLIP_DIR)) fs.mkdirSync(CLIP_DIR, { recursive: true });
  const clips = fs.readdirSync(CLIP_DIR).filter((f) => /\.(wav|mp3|ogg|flac)$/i.test(f)).sort();
  if (!clips.length) {
    console.log(`\nNo clips in ${CLIP_DIR}\n  • record real ones: run the gem with DMW_SAVE_CLIPS=1, then PTT a few lines\n  • or drop any .wav/.mp3 in (optionally a same-named .txt with what you said, for WER)\n`);
    return;
  }
  const vocab = [...loadBaseVocab(), ...(process.env.DMW_AB_VOCAB ? process.env.DMW_AB_VOCAB.split(",").map((s) => s.trim()).filter(Boolean) : [])];
  const prompt = vocab.join(", ");

  const want = (process.env.DMW_AB_ENGINES || "faster-whisper,whispercpp").split(",").map((s) => s.trim()).filter(Boolean);
  console.error(`[ab] requested engines: ${want.join(", ")}`);
  const [fw, wc, ws] = await Promise.all([
    want.includes("faster-whisper") ? startFaster() : Promise.resolve(null),
    want.includes("whispercpp") ? startWhisperCpp() : Promise.resolve(null),
    want.includes("whisperserver") ? startWhisperServer() : Promise.resolve(null),
  ]);
  const engines: Array<{ label: string; eng: SttEngine }> = [];
  if (fw) engines.push({ label: "faster-whisper", eng: fw });
  if (wc) engines.push({ label: "whisper.cpp", eng: wc });
  if (ws) engines.push({ label: "whisper-server", eng: ws });
  if (!engines.length) { console.error("\n[ab] no engines started — nothing to compare.\n"); return; }

  const agg: Record<string, Agg> = {};
  engines.forEach((e) => (agg[e.label] = { ms: [], werRaw: [], werCorr: [], hit: 0, tot: 0, low: 0 }));
  let refCount = 0;

  console.log(`\nclips: ${clips.length}   vocab terms: ${vocab.length}   engines: ${engines.map((e) => e.label).join(", ")}`);

  for (const clip of clips) {
    const wavPath = path.join(CLIP_DIR, clip);
    const refPath = path.join(CLIP_DIR, clip.replace(/\.[^.]+$/, ".txt"));
    const ref = fs.existsSync(refPath) ? fs.readFileSync(refPath, "utf-8").trim() : null;
    if (ref) refCount++;
    const terms = ref ? keyTerms(ref) : [];
    console.log(`\n▸ ${clip}${ref ? "   (ref ✓)" : ""}`);
    if (ref) console.log(`   ref : "${ref}"`);

    for (const { label, eng } of engines) {
      const t0 = Date.now();
      let row: Row;
      try {
        const res = await eng.transcribe(wavPath, prompt);
        const corr = correctTranscript(res.text, { glossary: vocab }).trim();
        row = { engine: label, ms: Date.now() - t0, raw: res.text.trim(), corr, lowConf: res.low_confidence };
        if (ref) {
          row.werRaw = wer(ref, row.raw); row.werCorr = wer(ref, corr);
          const [hit, tot] = recall(terms, corr); row.hit = hit; row.tot = tot;
        }
      } catch (err) {
        console.log(`   ${label.padEnd(15)} ERROR: ${(err as Error).message}`);
        continue;
      }
      const a = agg[label];
      a.ms.push(row.ms); if (row.lowConf) a.low++;
      if (ref) { a.werRaw.push(row.werRaw!); a.werCorr.push(row.werCorr!); a.hit += row.hit!; a.tot += row.tot!; }
      const metric = ref ? `   WER ${pct(row.werRaw!)}→${pct(row.werCorr!)}   names ${row.hit}/${row.tot}` : "";
      console.log(`   ${label.padEnd(15)} ${String(row.ms).padStart(5)}ms  ${row.lowConf ? "LOW-CONF" : "conf=ok "}${metric}`);
      console.log(`      raw : "${row.raw}"`);
      if (row.corr !== row.raw) console.log(`      corr: "${row.corr}"`);
    }
  }

  // ── aggregate ──
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  console.log(`\n═══ summary (${clips.length} clips, ${refCount} with refs) ═══`);
  console.log(`${"".padEnd(15)} ${"avg ms".padStart(7)}  ${"WER raw→corr".padStart(16)}  ${"names".padStart(7)}  low-conf`);
  for (const { label } of engines) {
    const a = agg[label];
    const w = a.werRaw.length ? `${pct(avg(a.werRaw))}→${pct(avg(a.werCorr))}` : "—";
    const names = a.tot ? `${a.hit}/${a.tot}` : "—";
    console.log(`${label.padEnd(15)} ${String(Math.round(avg(a.ms))).padStart(7)}  ${w.padStart(16)}  ${names.padStart(7)}  ${a.low}`);
  }
  console.log(`\nnote: whisper.cpp one-shot RELOADS the model per clip — its latency includes model load;`);
  console.log(`      whisper-server (resident) removes that. faster-whisper is resident (load excluded).`);

  for (const e of engines) await e.eng.stop();
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
