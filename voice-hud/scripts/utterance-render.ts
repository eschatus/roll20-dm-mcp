// Utterance-diversity rendering layer for the SFT gold-trajectory generator
// (scripts/gen-traces.ts). SEPARATES INTENT FROM SURFACE: an axis in gen-traces.ts
// builds a small structured Intent (who/what/how much), and this module renders it to
// natural-language text in one of several observed DM speech styles. The gold
// `expectedCalls`/`check()` logic in gen-traces.ts is keyed off the INTENT's captured
// values (target names, amounts, before/after state) — never off this module's output —
// so rendering can vary completely freely without touching ground truth. That's also
// why this module never needs to know anything about tool schemas or grading.
//
// Why this exists: a 7B student trained on 2,487 terse-templated records hit
// near-zero training loss inside half an epoch — trivial memorization. Real DM speech
// is flavor-wrapped, compound, hedged, occasionally STT-mangled, and sometimes refers
// to a token by description rather than name. See docs/table-mechanics-golden-pairs.md
// for the calibrated examples this renderer targets.
//
// Styles (see RenderStyle below) are picked per-step by the generator's own seeded
// RNG — nothing in here calls Math.random.

import * as fs from "fs";
import * as path from "path";
import { Board, Klass, Tok } from "./golden-lib";

export type RenderStyle =
  | "terse"               // today's behaviour — real DMs are sometimes terse
  | "flavored"             // verb-rich action clause wrapping the mechanical payload
  | "compound"              // two+ clauses joined naturally in one breath
  | "trailing-flavor"      // mechanics first, evocative clause after — must add NO new tool calls
  | "indirect-reference"   // refer to a token by description, not name
  | "stt-noisy"            // realistic mishears applied to proper nouns
  | "hedged";               // natural disfluency/hedging

export const ALL_STYLES: RenderStyle[] = [
  "terse", "flavored", "compound", "trailing-flavor", "indirect-reference", "stt-noisy", "hedged",
];

// ── Harvested vocabulary (scripts/harvest-utterances.ts) with a safe hardcoded
// fallback so the renderer never depends on a machine-local log having been mined. ──
interface UtterancePatterns {
  hedges: string[];
  fillers: string[];
  mishearPairs: [string, string][]; // [canonical substring, plausible STT mishearing]
}

const FALLBACK_PATTERNS: UtterancePatterns = {
  hedges: [
    "okay so", "alright,", "let's see —", "actually, make that —", "hold on —",
    "wait,", "so,", "well,", "hang on,", "right, so",
  ],
  fillers: ["um,", "uh,", "like,"],
  mishearPairs: [
    // Module/campaign-name mishears observed live (hud.log) — module names, not player data.
    ["Phandelver", "Fandelver"], ["Phandelver", "Fan Dover"], ["Phandelver", "Van Delver"],
    ["Beyond Phandelver", "Beyond Fentelner"], ["DDB", "d4 Beyond"], ["send", "Zeond"],
    // Curated dictation-glossary mishears (docs/dictation glossary memory).
    ["Curse of Strahd", "cursive strat"], ["Cali", "Kelly"], ["Zeno casts", "Xenocast"],
    ["Flameskull the Gaunt", "Flamesgoldagaunt"],
    // Generic homophone/near-homophone confusions common in D&D STT.
    ["for", "four"], ["to", "too"], ["won", "one"], ["ate", "eight"],
    ["hit points", "aitch pee"], ["hit point", "hit points"],
  ],
};

let cachedPatterns: UtterancePatterns | null = null;
export function loadUtterancePatterns(): UtterancePatterns {
  if (cachedPatterns) return cachedPatterns;
  // NOTE: lives in scripts/ (not data/) deliberately — voice-hud/.gitignore excludes
  // data/ wholesale (live credentials + generated traces), but this bank is a checked-in
  // fallback resource the renderer needs even on a fresh checkout with no hud.log.
  const p = path.join(__dirname, "utterance-patterns.json");
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf8")) as Partial<UtterancePatterns>;
    cachedPatterns = {
      hedges: raw.hedges?.length ? raw.hedges : FALLBACK_PATTERNS.hedges,
      fillers: raw.fillers?.length ? raw.fillers : FALLBACK_PATTERNS.fillers,
      mishearPairs: raw.mishearPairs?.length ? raw.mishearPairs : FALLBACK_PATTERNS.mishearPairs,
    };
  } catch {
    cachedPatterns = FALLBACK_PATTERNS;
  }
  return cachedPatterns;
}

// ── RNG helpers (caller's mulberry32 — never unseeded Math.random) ──────────────
const pick = <T>(rng: () => number, arr: T[]): T => arr[Math.floor(rng() * arr.length)];

// ── Intent — the structured, style-free ground truth an axis builds ─────────────
export type Intent =
  | { kind: "damage"; target: string; amount: number; dtype: string; klass: Klass }
  | { kind: "damage-condition"; target: string; amount: number; dtype: string; cond: string }
  | { kind: "damage-flavor"; target: string; amount: number; dtype: string; klass: Klass }
  | { kind: "pure-flavor"; actor: string; other: string }
  | { kind: "aoe"; targets: string[]; amounts: number[]; dtype: string; failNames: string[]; saveNames: string[]; label: string }
  | { kind: "zone-create"; name: string; damaging: boolean }
  | { kind: "zone-transition"; oldName: string }
  | { kind: "round-rollover" }
  | { kind: "retcon"; target: string; oldAmount: number; newAmount: number; klass: Klass }
  | { kind: "fudge-drop"; target: string }
  | { kind: "drop"; target: string; klass: Klass }
  | { kind: "revival"; target: string; setHp: number }
  | { kind: "concentration-hit"; target: string; amount: number; dtype: string; klass: Klass }
  | { kind: "followup"; failed: boolean };

// Which styles make sense for a given intent kind — genStep()'s style picker draws
// only from this list, so we never e.g. try to apply "indirect-reference" to a
// two-word "Failed."/"Passed." follow-up.
export function stylesFor(kind: Intent["kind"]): RenderStyle[] {
  switch (kind) {
    case "followup":
      return ["terse", "hedged"];
    case "round-rollover":
      return ["terse", "flavored", "hedged"];
    case "pure-flavor":
      return ["terse", "flavored", "hedged", "stt-noisy", "indirect-reference"];
    case "zone-create":
    case "zone-transition":
    case "fudge-drop":
      return ["terse", "flavored", "hedged", "stt-noisy"];
    default:
      return ALL_STYLES;
  }
}

// ── Shared vocabulary ─────────────────────────────────────────────────────────
const HIT_VERBS = [
  "carves into", "hurls damage at", "tears into", "slams into", "rips into",
  "drives a blade into", "cracks", "lands a solid hit on", "catches", "buries a strike in",
];
const HIT_VERBS_TRAILING = [
  (dtype: string) => `for ${dtype} damage`,
  (dtype: string) => `— ${dtype}`,
];
const TRAILING_FLAVOR = [
  "it's looking ragged now.", "that one's not getting up soon.", "it staggers but holds.",
  "it's fading fast.", "that's going to leave a mark.", "the fight's turning.",
  "it's on its last legs.", "still standing, barely.",
];
const PURE_FLAVOR_CLOSERS = [
  "staggers back off balance", "reels but keeps its footing", "grunts and plants its feet",
  "wobbles but holds its ground",
];

// Condition phrasing that stays grammatical across the condition set and carries no
// gender assumption. "knocked" belongs to prone alone; the rest take plain copulas.
function condClause(cond: string, rng: () => number): string {
  const c = cond.toLowerCase();
  // No leading "and" — callers already supply their own connector.
  if (c === "prone") return pick(rng, ["they're knocked prone", "that knocks them prone", "they go down prone"]);
  if (c === "restrained" || c === "grappled") return pick(rng, [`they're ${c}`, `that leaves them ${c}`]);
  return pick(rng, [`they're ${c}`, `that's ${c} on them`, `${c} sticks`]);
}

function hedgeOpener(rng: () => number): string {
  const { hedges } = loadUtterancePatterns();
  return pick(rng, hedges);
}

function withHedge(s: string, rng: () => number): string {
  const opener = hedgeOpener(rng);
  const lead = /[,—]$/.test(opener) ? `${opener} ` : `${opener}, `;
  return lead + s.charAt(0).toLowerCase() + s.slice(1);
}

// Generic proper-noun split — simulates STT breaking one word into two, the way the
// real log shows "Phandelver" fragmenting into "Fan Dover"/"Van Delver". Operates on
// the first sufficiently-long capitalized word so it works on any generated name,
// not just ones in the mishear bank.
function splitLongWord(word: string, rng: () => number): string {
  if (word.length < 7) return word;
  const cut = 2 + Math.floor(rng() * (word.length - 4));
  return word.slice(0, cut) + " " + word.slice(cut);
}

function applyMishearing(text: string, rng: () => number): string {
  const { mishearPairs } = loadUtterancePatterns();
  let out = text;
  // One literal known-pattern swap, if a canonical phrase is present in this utterance.
  const shuffled = [...mishearPairs].sort(() => rng() - 0.5);
  for (const [canon, heard] of shuffled) {
    if (out.includes(canon) && rng() < 0.6) { out = out.replace(canon, heard); break; }
  }
  // One generic name-split, applied to the first long capitalized word (a proper noun
  // in every intent this renders — token names, epithets).
  if (rng() < 0.5) {
    out = out.replace(/\b[A-Z][a-z]{6,}\b/, (m) => splitLongWord(m, rng));
  }
  return out;
}

// ── Indirect reference — describe a token instead of naming it, only when the
// board makes the reference unambiguous. Returns null (never fabricates) when no
// safe descriptor exists, so the caller falls back to naming the token. ──────────
function poolFor(board: Board, klass: Klass): Tok[] {
  return board.tokens.filter((t) => t.klass === klass && t.layer === "objects" && !t.statusmarkers.split(",").includes("dead"));
}
function baseWord(name: string): string {
  const core = name.split(/ the /i)[0].trim();
  // Trailing disambiguators ("Kraken Priest A", "Skeleton 2") are not describable nouns —
  // drop them so we never emit "the a" / "the 2".
  const words = core.split(/\s+/).filter((w) => !/^(?:\d+|[A-Za-z])$/.test(w));
  return (words.length ? words[words.length - 1] : core).toLowerCase();
}
export function indirectDescriptor(board: Board, name: string, klass: Klass, rng: () => number): string | null {
  const pool = poolFor(board, klass);
  const t = pool.find((x) => x.name === name);
  if (!t) return null;
  const candidates: string[] = [];
  const uniqueBase = pool.filter((x) => baseWord(x.name) === baseWord(name)).length === 1;
  if (uniqueBase) candidates.push(`the ${baseWord(name)}`, `that ${baseWord(name)}`);
  const isWounded = (x: Tok) => x.bar1_value > 0 && x.bar1_value * 2 <= x.bar1_max;
  if (isWounded(t) && pool.filter((x) => x !== t).every((x) => !isWounded(x))) {
    candidates.push("the hurt one", "the one that's already hurting");
  }
  if (pool.length === 1) candidates.push("the last one up");
  return candidates.length ? pick(rng, candidates) : null;
}

// ── Per-kind renderers ────────────────────────────────────────────────────────

function nameOrDescriptor(board: Board, name: string, klass: Klass, style: RenderStyle, rng: () => number): string {
  if (style === "indirect-reference") {
    const d = indirectDescriptor(board, name, klass, rng);
    if (d) return d;
  }
  return style === "stt-noisy" ? applyMishearing(name, rng) : name;
}

function renderDamageLike(
  board: Board, style: RenderStyle, rng: () => number,
  target: string, klass: Klass, amount: number, dtype: string, extraClause?: string,
): string {
  const who = nameOrDescriptor(board, target, klass, style, rng);
  let base: string;
  switch (style) {
    case "flavored": {
      // A flavored hit needs an ATTACKER — "cracks Glint — that's 12 cold" is a
      // subjectless fragment no DM would say. Pick any other token on the board;
      // if the board somehow has only the target, fall back to a subjectless-but-
      // grammatical passive rather than emitting a fragment.
      const verb = pick(rng, HIT_VERBS);
      const others = board.tokens.filter((t) => t.name !== target && t.layer !== "map");
      base = others.length
        ? `${pick(rng, others).name} ${verb} ${who} — that's ${amount} ${dtype}${extraClause ? `, ${extraClause}` : ""}.`
        : `${who} takes ${amount} ${dtype} square on${extraClause ? `, ${extraClause}` : ""}.`;
      break;
    }
    case "trailing-flavor": {
      base = `${who} takes ${amount} ${dtype}${extraClause ? ` and ${extraClause}` : ""} — ${pick(rng, TRAILING_FLAVOR)}`;
      break;
    }
    case "compound": {
      const tail = pick(rng, TRAILING_FLAVOR);
      base = `${who} takes ${amount} ${dtype}${extraClause ? ` and ${extraClause}` : ""} — and ${tail.replace(/\.$/, "")}.`;
      break;
    }
    case "indirect-reference":
    case "terse":
    default:
      base = `${who} takes ${amount} ${dtype}${extraClause ? ` and ${extraClause}` : ""}.`;
      break;
    case "stt-noisy":
      base = applyMishearing(`${who} takes ${amount} ${dtype}${extraClause ? ` and ${extraClause}` : ""}.`, rng);
      break;
    case "hedged":
      base = withHedge(`${who} takes ${amount} ${dtype}${extraClause ? ` and ${extraClause}` : ""}.`, rng);
      break;
  }
  return base;
}

function renderDamage(board: Board, style: RenderStyle, rng: () => number, i: { target: string; amount: number; dtype: string; klass: Klass }): string {
  return renderDamageLike(board, style, rng, i.target, i.klass, i.amount, i.dtype);
}

function renderDamageCondition(board: Board, style: RenderStyle, rng: () => number, i: { target: string; amount: number; dtype: string; cond: string }): string {
  // "knocked X" only reads correctly for prone; "he's knocked poisoned" is nonsense.
  // Also never assume the target's gender — the board doesn't carry one, so use
  // they/them or drop the pronoun entirely.
  return renderDamageLike(board, style, rng, i.target, "pc", i.amount, i.dtype, condClause(i.cond, rng));
}

function renderDamageFlavor(board: Board, style: RenderStyle, rng: () => number, i: { target: string; amount: number; dtype: string; klass: Klass }): string {
  const flavor = pick(rng, PURE_FLAVOR_CLOSERS);
  // negative-space steps must never mention a real condition word — the flavor bank is
  // deliberately positional/colour-only (see gen-traces.ts's axisNegativeSpace comment).
  return renderDamageLike(board, style, rng, i.target, i.klass, i.amount, i.dtype, flavor);
}

function renderPureFlavor(board: Board, style: RenderStyle, rng: () => number, i: { actor: string; other: string }): string {
  const actor = nameOrDescriptor(board, i.actor, "npc", style, rng);
  const other = poolFor(board, "pc").some((t) => t.name === i.other) || poolFor(board, "sidekick").some((t) => t.name === i.other)
    ? nameOrDescriptor(board, i.other, poolFor(board, "pc").some((t) => t.name === i.other) ? "pc" : "sidekick", style, rng)
    : i.other;
  const variants = [
    `${actor} circles around behind ${other} — I've already slid the token over.`,
    `${actor} shoulders ${other} back a couple of squares; I moved him by hand.`,
    `${actor} kicks the brazier over and the hall lights up orange.`,
    `${actor} snarls something in Aquan at ${other}, and the water churns around its feet.`,
  ];
  let base = pick(rng, variants);
  if (style === "stt-noisy") base = applyMishearing(base, rng);
  if (style === "hedged") base = withHedge(base, rng);
  return base;
}

function renderAoe(board: Board, style: RenderStyle, rng: () => number, i: {
  targets: string[]; amounts: number[]; dtype: string; failNames: string[]; saveNames: string[]; label: string;
}): string {
  const nameFor = (n: string) => {
    const klass = board.tokens.find((x) => x.name === n)?.klass ?? "npc";
    return nameOrDescriptor(board, n, klass, style === "indirect-reference" && n !== i.failNames[0] ? style : "terse", rng);
  };
  // Only non-primary targets get the indirect treatment (the primary/failed target
  // stays named — mirrors how a DM actually calls out the one that mattered).
  const targetList = i.targets.map(nameFor).join(", ");
  const fails = i.failNames.map(nameFor);
  const saves = i.saveNames.map(nameFor);
  const failClause = `${fails.join(", ")} fail${fails.length === 1 ? "s" : ""} the save`;
  const saveClause = saves.length ? `; ${saves.join(", ")} make${saves.length === 1 ? "s" : ""} it for half` : "";
  switch (style) {
    case "flavored":
      return `${i.label} — it catches ${targetList} for ${i.amounts[0]} ${i.dtype}. ${failClause}${saveClause}.`;
    case "compound":
      return `${i.label} rips through ${targetList} — ${i.amounts[0]} ${i.dtype}, and ${failClause}${saveClause ? `, and ${saveClause.replace(/^; /, "")}` : ""}.`;
    case "trailing-flavor":
      return `${i.label} catches ${targetList} — ${i.amounts[0]} ${i.dtype}. ${failClause}${saveClause} — the back rank's a mess now.`;
    case "hedged":
      return withHedge(`${i.label} catches ${targetList} — ${i.amounts[0]} ${i.dtype}. ${failClause}${saveClause}.`, rng);
    case "stt-noisy":
      return applyMishearing(`${i.label} catches ${targetList} — ${i.amounts[0]} ${i.dtype}. ${failClause}${saveClause}.`, rng);
    case "indirect-reference":
    case "terse":
    default:
      return `${i.label} catches ${targetList} — ${i.amounts[0]} ${i.dtype}. ${failClause}${saveClause}.`;
  }
}

function renderZoneCreate(style: RenderStyle, rng: () => number, i: { name: string; damaging: boolean }): string {
  const base = i.damaging
    ? `${i.name} fills the room — anyone caught in it takes damage each round.`
    : `${i.name} spreads across the floor — it's difficult terrain now.`;
  if (style === "hedged") return withHedge(base, rng);
  if (style === "stt-noisy") return applyMishearing(base, rng);
  if (style === "flavored") return i.damaging
    ? `${i.name} roars up across the room — step in it and you're burning.`
    : `${i.name} spreads thick across the floor — nobody's moving fast through that.`;
  return base;
}

function renderZoneTransition(style: RenderStyle, rng: () => number, i: { oldName: string }): string {
  const variants = [
    `The ${i.oldName} catches — it's fully alight now.`,
    `Someone's torch hits the ${i.oldName} — it goes up in flame.`,
  ];
  let base = pick(rng, variants);
  if (style === "hedged") base = withHedge(base, rng);
  if (style === "stt-noisy") base = applyMishearing(base, rng);
  return base;
}

function renderRoundRollover(style: RenderStyle, rng: () => number): string {
  if (style === "flavored") return "Round's over — everyone shake it off, back to the top of the order.";
  if (style === "hedged") return withHedge("That's the round — top of the order.", rng);
  return "That's the round — top of the order.";
}

function renderRetcon(board: Board, style: RenderStyle, rng: () => number, i: { target: string; oldAmount: number; newAmount: number; klass: Klass }): string {
  const who = nameOrDescriptor(board, i.target, i.klass, style, rng);
  let base: string;
  switch (style) {
    case "flavored":
      base = `Hold on — I had the die wrong on ${who}. That hit was ${i.newAmount}, not ${i.oldAmount}.`;
      break;
    case "hedged":
      base = withHedge(`Back up — that hit on ${who} was ${i.newAmount}, not ${i.oldAmount}.`, rng);
      break;
    case "stt-noisy":
      base = applyMishearing(`Back up — that hit on ${who} was ${i.newAmount}, not ${i.oldAmount}.`, rng);
      break;
    default:
      base = `Back up — that hit on ${who} was ${i.newAmount}, not ${i.oldAmount}.`;
  }
  return base;
}

function renderFudgeDrop(style: RenderStyle, rng: () => number, i: { target: string }): string {
  const variants = [`${i.target} has had it — he drops.`, `${i.target} goes down for good.`];
  let base = pick(rng, variants);
  if (style === "flavored") base = `${i.target} takes one more than he can carry and drops where he stands.`;
  if (style === "hedged") base = withHedge(base, rng);
  if (style === "stt-noisy") base = applyMishearing(base, rng);
  return base;
}

function renderDrop(board: Board, style: RenderStyle, rng: () => number, i: { target: string; klass: Klass }): string {
  const who = nameOrDescriptor(board, i.target, i.klass, style, rng);
  const variants = [`${who} is smashed to the floor — he's down.`, `${who} goes down!`];
  let base = pick(rng, variants);
  if (style === "flavored") base = `${who} crumples under the hit and hits the floor hard.`;
  if (style === "hedged") base = withHedge(base, rng);
  if (style === "stt-noisy") base = applyMishearing(base, rng);
  return base;
}

function renderRevival(board: Board, style: RenderStyle, rng: () => number, i: { target: string; setHp: number }): string {
  const who = nameOrDescriptor(board, i.target, "pc", style, rng);
  let base = `Someone gets a potion into ${who} — he's back on ${i.setHp}, conscious, still flat on his back.`;
  if (style === "flavored") base = `A potion goes down ${who}'s throat and colour rushes back — ${i.setHp} hit points, still down on one knee.`;
  if (style === "trailing-flavor") base = `${who} is stabilized at ${i.setHp} hp, conscious — he'll need his own turn to stand.`;
  if (style === "hedged") base = withHedge(base, rng);
  if (style === "stt-noisy") base = applyMishearing(base, rng);
  return base;
}

function renderConcentrationHit(board: Board, style: RenderStyle, rng: () => number, i: { target: string; amount: number; dtype: string; klass: Klass }): string {
  return renderDamageLike(board, style, rng, i.target, i.klass, i.amount, i.dtype);
}

function renderFollowup(style: RenderStyle, rng: () => number, i: { failed: boolean }): string {
  const base = i.failed ? "Failed." : "Passed.";
  if (style === "hedged") {
    return i.failed ? pick(rng, ["Yeah, he failed it.", "Nah — failed."]) : pick(rng, ["Yeah, made it.", "He held it."]);
  }
  return base;
}

// ── Entry point ───────────────────────────────────────────────────────────────
export function renderUtterance(intent: Intent, style: RenderStyle, rng: () => number, board: Board): string {
  switch (intent.kind) {
    case "damage": return renderDamage(board, style, rng, intent);
    case "damage-condition": return renderDamageCondition(board, style, rng, intent);
    case "damage-flavor": return renderDamageFlavor(board, style, rng, intent);
    case "pure-flavor": return renderPureFlavor(board, style, rng, intent);
    case "aoe": return renderAoe(board, style, rng, intent);
    case "zone-create": return renderZoneCreate(style, rng, intent);
    case "zone-transition": return renderZoneTransition(style, rng, intent);
    case "round-rollover": return renderRoundRollover(style, rng);
    case "retcon": return renderRetcon(board, style, rng, intent);
    case "fudge-drop": return renderFudgeDrop(style, rng, intent);
    case "drop": return renderDrop(board, style, rng, intent);
    case "revival": return renderRevival(board, style, rng, intent);
    case "concentration-hit": return renderConcentrationHit(board, style, rng, intent);
    case "followup": return renderFollowup(style, rng, intent);
  }
}

// Picks a style for the given intent kind from the seeded RNG — the single choke
// point gen-traces.ts calls so style selection stays deterministic per seed.
export function pickStyle(rng: () => number, kind: Intent["kind"]): RenderStyle {
  return pick(rng, stylesFor(kind));
}
