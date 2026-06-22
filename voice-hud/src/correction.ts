// Post-STT correction layer for a BOUNDED domain (combat narration). Whisper's
// initial_prompt biasing helps but still mangles names + mechanics; this fixes the
// residue deterministically in microseconds, against the same glossary (base vocab
// + roster + campaign vocab + nicknames).
//
// Built for PRECISION, not recall — a missed correction is cheap, a wrong one
// corrupts the downstream parse. Three ordered, independently-toggleable passes:
//   1. notation  — regex dice/mechanics ("two dee six" → "2d6", "nat twenty" → "nat 20")
//   2. literal   — exact phrase swaps you define ("dee see" → "DC")
//   3. fuzzy     — phonetic (Double Metaphone) PRIMARY gate + fuzzy ratio secondary,
//                  greedy longest-match over 1–3 word windows, length-aware
//                  thresholds, and a common-word guard so real English is left alone.
//
// The phonetic gate is what makes split names work: a despaced multi-word span
// ("hair gone") and a single glossary term ("Haregon") share a metaphone code
// (HRKN) despite low character overlap — while "cave" (KF) ≠ "save" (SF) is left.
import doubleMetaphone from "double-metaphone";

export interface CorrectionConfig {
  glossary: string[];                  // terms to correct toward
  literalMap?: Record<string, string>; // exact phrase → replacement (pass 2)
  notation?: boolean;                  // pass 1 (default on)
  literal?: boolean;                   // pass 2 (default on)
  fuzzy?: boolean;                     // pass 3 (default on)
}

// Spoken phrases Whisper reliably produces for mechanics. Exact, zero-risk swaps.
export const DEFAULT_LITERAL_MAP: Record<string, string> = {
  "dee see": "DC",
  "ay see": "AC",
  "hit point": "hit points",
  "saving roll": "saving throw",
};

const NUM_WORD: Record<string, string> = {
  one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7",
  eight: "8", nine: "9", ten: "10", eleven: "11", twelve: "12", twenty: "20", hundred: "100",
};

// ── Pass 1: notation ──────────────────────────────────────────────────────────
export function normalizeNotation(s: string): string {
  // "natural twenty" / "nat twenty" → "nat 20"; same for one.
  s = s.replace(/\bnat(?:ural)?\s+(twenty|one)\b/gi, (_m, n) => `nat ${NUM_WORD[n.toLowerCase()]}`);
  // [count] (dee|d) <sides> → <count>d<sides>. The count+space is one optional group
  // (so a bare "dee"/"d" doesn't swallow the preceding space), and "d" must be a
  // standalone token so we never touch a real word like "had". Sides = real die faces.
  s = s.replace(
    /\b(?:(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+)?d(?:ee)?\b\s*(\d+|four|six|eight|ten|twelve|twenty|hundred)\b/gi,
    (_m, count, sides) => {
      const c = count ? (NUM_WORD[String(count).toLowerCase()] ?? count) : "";
      const sd = NUM_WORD[String(sides).toLowerCase()] ?? sides;
      return `${c}d${sd}`;
    },
  );
  return s;
}

// ── Pass 2: literal map ───────────────────────────────────────────────────────
function escapeRegex(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
export function applyLiteralMap(s: string, map: Record<string, string>): string {
  for (const [from, to] of Object.entries(map)) {
    s = s.replace(new RegExp(`\\b${escapeRegex(from)}\\b`, "gi"), to);
  }
  return s;
}

// ── Pass 3: fuzzy + phonetic ──────────────────────────────────────────────────

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let cur = new Array(n + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[n];
}

function similarity(a: string, b: string): number {
  const max = Math.max(a.length, b.length) || 1;
  return 1 - levenshtein(a, b) / max;
}

// Length-aware fuzzy floor: short spans false-positive easily, so demand more.
function fuzzyFloor(len: number): number {
  if (len <= 4) return 0.85;
  if (len <= 7) return 0.78;
  return 0.68;
}

// High-frequency English words that should never be "corrected" into a glossary
// term — defense-in-depth behind the phonetic gate (e.g. don't turn ordinary
// narration into a roster name just because the metaphone happens to collide).
const COMMON_WORDS = new Set([
  "the","be","to","of","and","a","in","that","have","i","it","for","not","on","with","he","as","you",
  "do","at","this","but","his","by","from","they","we","say","her","she","or","an","will","my","one",
  "all","would","there","their","what","so","up","out","if","about","who","get","which","go","me","when",
  "make","can","like","time","no","just","him","know","take","people","into","year","your","good","some",
  "could","them","see","other","than","then","now","look","only","come","its","over","think","also","back",
  "after","use","two","how","our","work","first","well","way","even","new","want","because","any","these",
  "give","day","most","us","is","are","was","were","been","has","had","did","got","goes","went","said",
  "more","much","many","let","still","down","off","here","where","why","again","away","through","around",
  "before","big","small","old","right","left","near","far","next","last","each","both","few","own","same",
  "such","being","does","yes","okay","ok","cave","wave","gave","brave","grave","crave","name","game","came",
  // Combat verbs/nouns that must never be "corrected" into a name — they collide
  // phonetically with short character names (e.g. kill↔Quill, both metaphone KL).
  // A real glossary term equal to one of these still matches (the !G guard below).
  "kill","kills","killed","hit","hits","miss","misses","missed","heal","heals","healed",
  "cast","casts","move","moves","moved","attack","attacks","damage","save","saves",
  "roll","rolls","rolled","drop","drops","dead","die","dies","died","hurt","stun","prone",
]);

const despace = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

interface GlossEntry { term: string; key: string; codes: [string, string] }

export function fuzzyPhoneticCorrect(text: string, glossary: string[]): string {
  const G: GlossEntry[] = [];
  const seen = new Set<string>();
  for (const term of glossary) {
    const key = despace(term);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    G.push({ term, key, codes: doubleMetaphone(key) });
  }
  if (!G.length) return text;

  // Atoms: alternating word / non-word runs, so we can rebuild verbatim.
  const atoms = text.match(/[A-Za-z']+|[^A-Za-z']+/g) ?? [];
  const wordIdx: number[] = [];
  atoms.forEach((a, i) => { if (/[A-Za-z']/.test(a)) wordIdx.push(i); });

  let w = 0;
  while (w < wordIdx.length) {
    // Evaluate every window length (1→3) and pick the BEST-SCORING match, not merely
    // the longest that clears the floor. Tiebreak → longer span (so multi-word terms
    // and split names still win over a fragment). This stops a longer window from
    // swallowing a trailing common word when a shorter window already matches better:
    // "Ireena is" scored 0.75 vs "Ireena" exact 1.0 → take span 1, keep "is".
    let winner: { span: number; entry: GlossEntry; score: number } | null = null;
    for (let span = Math.min(3, wordIdx.length - w); span >= 1; span--) {
      const windowWords = [];
      for (let k = 0; k < span; k++) windowWords.push(atoms[wordIdx[w + k]]);
      const key = despace(windowWords.join(""));
      if (key.length < 2) continue;

      // Common-word guard: a single ordinary English word is left untouched unless
      // it's literally a glossary term already (then a correction is a no-op anyway).
      if (span === 1 && COMMON_WORDS.has(key) && !G.some((g) => g.key === key)) continue;

      const codes = doubleMetaphone(key);
      let best: { entry: GlossEntry; score: number } | null = null;
      for (const g of G) {
        if (g.key === key) { best = { entry: g, score: 1 }; break; } // exact → canonicalize casing
        const [a1, a2] = codes, [b1, b2] = g.codes;
        if (!a1 || !b1) continue;
        const primary = a1 === b1;                                   // strongest phonetic signal
        if (!primary && !(a1 === b2 || a2 === b1 || a2 === b2)) continue; // PRIMARY gate
        // A solid primary-metaphone match (the split-name case, where characters
        // diverge but sound matches) gets a lenient fuzzy floor; a weaker secondary/
        // cross match must clear the strict length-aware bar.
        const floor = primary ? 0.5 : fuzzyFloor(Math.min(key.length, g.key.length));
        const score = similarity(key, g.key);
        if (score >= floor && (!best || score > best.score)) best = { entry: g, score };
      }
      // Strictly-better shorter span overrides; equal score keeps the longer (first-seen).
      if (best && (!winner || best.score > winner.score)) winner = { span, entry: best.entry, score: best.score };
      // INTENTIONAL NON-FIX: merged-common-word cases like "his mark" → "Ismark" are NOT
      // handled here. Both "his" and "mark" are common English words protected by COMMON_WORDS,
      // and forcing their merger would risk false positives in ordinary narration
      // (e.g. "the wolf bears his mark"). Campaign-specific merges like "his mark"→"Ismark"
      // belong in the per-campaign literalMap or the learned-corrections loop, not this layer.
    }

    if (winner) {
      // Replace the window: first word → canonical term, blank the rest + their leading
      // gaps. (Exact same-casing match rewrites identical text; a name match also
      // canonicalizes casing, e.g. "haregon" → "Haregon".)
      atoms[wordIdx[w]] = winner.entry.term;
      for (let k = 1; k < winner.span; k++) {
        atoms[wordIdx[w + k]] = "";
        atoms[wordIdx[w + k] - 1] = ""; // the gap before it
      }
      w += winner.span;
    } else w += 1;
  }
  return atoms.join("");
}

// ── Orchestrator ──────────────────────────────────────────────────────────────
export function correctTranscript(text: string, cfg: CorrectionConfig): string {
  let out = text;
  if (cfg.notation !== false) out = normalizeNotation(out);
  if (cfg.literal !== false) out = applyLiteralMap(out, cfg.literalMap ?? DEFAULT_LITERAL_MAP);
  if (cfg.fuzzy !== false) out = fuzzyPhoneticCorrect(out, cfg.glossary);
  return out;
}
