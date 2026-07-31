// SFT trace generator (SFT_TRACE_PLAN) — drives a teacher model (default: local
// qwen-14b via Ollama) through seeded, randomized table-mechanics scenarios built on
// the SAME Board/stub-executor golden-lib.ts exposes for eval-golden.ts, grades each
// step against the sampled template's expected board effect, and emits grader-ACCEPTED
// trajectories as JSONL — training data for a QLoRA'd 7B.
//
//   npx tsx scripts/gen-traces.ts --seed 1 --scenarios 20 --out data/traces/traces-1.jsonl
//   DMW_GEN_DRY=1 npx tsx scripts/gen-traces.ts               (smoke: scripted fake teacher, no ollama)
//
// ── --mode gold ─────────────────────────────────────────────────────────────
// The teacher (qwen-14b) scores 28-33% on the golden suite and ~0% on the
// convention-heavy axes (concentration, dying, retcon, zone transitions), so
// grader-filtering its output STARVES exactly the axes the student most needs. But the
// generator already knows the right answer for every sampled step — that's what
// check() grades against. `--mode gold` therefore emits the correct trajectory
// directly from each step template's own ground truth:
//
//   npx tsx scripts/gen-traces.ts --seed 1 --scenarios 20 --mode gold
//
// NO teacher model, NO LLM call of any kind, deterministic for a fixed seed. Every gold
// trajectory is still executed through the SAME ajv (-32602) boundary and stubExec, then
// SELF-TESTED with the step's own check(). A gold trajectory that fails its own check is
// a GENERATOR BUG (template rot) — it is reported loudly and exits non-zero, never
// silently dropped.
//
// Conventions this generator targets: docs/table-mechanics-golden-pairs.md. The Board
// model, PCHP encoding, marker helpers, and stub executor are golden-lib.ts's — kept
// as the single source of truth so the generator and the golden-pairs eval can't drift.

import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";
import Ajv, { ValidateFunction } from "ajv";
import { McpRoll20 } from "../src/mcp";
import { buildSystemPrompt, buildTurnContext } from "../src/persona";
import { AnthropicProvider } from "../src/llm/anthropic";
import { OllamaProvider } from "../src/llm/ollama";
import { LLMProvider, LLMTurn, ToolCall, ToolSpec } from "../src/llm/provider";
import { CONFIG } from "../src/config";
import { decideTerminal, isMutatingTool, LoopMode } from "../src/loop-policy";
import { slimToolSpecs } from "../src/llm/slim-tools";
import {
  Board, Ctx, Klass, Tok, Zone,
  find, has, makeTok, markers, readPcHp, rosterFromBoard, setMarkers, stubExec,
} from "./golden-lib";

dotenv.config({ path: path.join(__dirname, "..", "..", ".env") });
dotenv.config({ path: path.join(__dirname, "..", ".env") });
dotenv.config({ path: path.join(__dirname, "..", "data", ".env") });

// Teacher = local qwen-14b via Ollama by default (SFT_TRACE_PLAN); override like the evals.
const PROVIDER = process.env.DMW_EVAL_PROVIDER || "ollama";
const MODEL = process.env.DMW_EVAL_MODEL || (PROVIDER === "ollama" ? "qwen2.5:14b-16k" : "claude-haiku-4-5");
const MODE = (process.env.DMW_AGENTIC_LOOP || "nudge") as LoopMode;
const MAX_STEPS = 6;
const DRY = process.env.DMW_GEN_DRY === "1";

// ── CLI args ───────────────────────────────────────────────────────────────
// "teacher" = drive a real model and grader-filter it (default, the original behavior).
// "gold"    = synthesize the correct trajectory from the template's ground truth.
export type GenMode = "teacher" | "gold";

function argVal(flag: string, dflt: string): string {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const SEED = Number(argVal("--seed", "1")) || 1;
const N_SCENARIOS = Number(argVal("--scenarios", DRY ? "2" : "20")) || 20;
const MODE_ARG = argVal("--mode", process.env.DMW_GEN_MODE || "teacher");
if (MODE_ARG !== "teacher" && MODE_ARG !== "gold") {
  console.error(`unknown --mode "${MODE_ARG}" — expected "teacher" or "gold"`);
  process.exit(2);
}
const GEN_MODE = MODE_ARG as GenMode;
const OUT_PATH = argVal("--out", path.join(__dirname, "..", "data", "traces", `traces-${SEED}.jsonl`));
const REJECTS_PATH = OUT_PATH.replace(/\.jsonl$/, "") + ".rejects.jsonl";

// ── Seeded PRNG (mulberry32) — full reproducibility, NO unseeded Math.random ─
function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return function rng() {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = <T>(rng: () => number, arr: T[]): T => arr[Math.floor(rng() * arr.length)];
const shuffle = <T>(rng: () => number, arr: T[]): T[] => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
};
const int = (rng: () => number, lo: number, hi: number) => lo + Math.floor(rng() * (hi - lo + 1));

// ── Name pools (with epithets) for randomized rosters ────────────────────────
const PC_NAMES = ["Glint Klinkinski", "Errol Vantane", "Ireena Kolyana", "Rennet Cobb", "Yulia Marsk", "Dacorath Applebough"];
const SIDEKICK_NAMES = ["Tua", "Salros Eventide", "Amri", "Ezmerelda", "Ismark Kolyanovich", "Davven Cray"];
const NPC_BASE = ["Kraken Priest", "Skeleton", "Bandit Captain", "Wraith", "Ogre", "Ghoul", "Water Elemental", "Cultist", "Zombie", "Vampire Spawn"];
const EPITHETS = ["the Gaunt", "the Cruel", "the Drowned", "the Ashen", "the Hollow", "the Broken", "the Silent", "A", "B", "C"];
const DMG_TYPES = ["slashing", "fire", "radiant", "piercing", "bludgeoning", "necrotic", "cold", "poison", "thunder"];
const CONDITIONS = ["prone", "frightened", "restrained", "stunned", "poisoned"];
const ZONE_DIFFICULT = ["Grease", "Web", "Spike Growth", "Entangling roots"];
const ZONE_DAMAGING = ["Cloudkill", "Wall of Fire's edge", "Spike Growth's thorns", "a burning oil slick"];

// ── Seedable random roster factory ───────────────────────────────────────────
function sampleRoster(rng: () => number): Board {
  const numPc = int(rng, 1, 2);
  const numSk = rng() < 0.5 ? int(rng, 1, 2) : 0;
  const numNpc = int(rng, 2, 6);
  const tokens: Tok[] = [];
  const pcPool = shuffle(rng, PC_NAMES);
  for (let i = 0; i < numPc; i++) tokens.push(makeTok(pcPool[i % pcPool.length], int(rng, 18, 42), "pc"));
  const skPool = shuffle(rng, SIDEKICK_NAMES);
  for (let i = 0; i < numSk; i++) tokens.push(makeTok(skPool[i % skPool.length], int(rng, 14, 34), "sidekick"));
  const used = new Set<string>();
  for (let i = 0; i < numNpc; i++) {
    let base = pick(rng, NPC_BASE);
    if (used.has(base) || rng() < 0.35) base += " " + pick(rng, EPITHETS);
    let name = base, n = 2;
    while (used.has(name)) name = `${base} ${n++}`;
    used.add(name);
    tokens.push(makeTok(name, int(rng, 10, 60), "npc"));
  }
  const order = shuffle(rng, tokens.map((t) => t.name));
  const turnorder = order.map((n, i) => ({ id: tokens.find((t) => t.name === n)!.id, pr: String(30 - i) }));
  const zones: Zone[] = [];
  if (rng() < 0.3) zones.push({ name: pick(rng, ZONE_DIFFICULT), color: "#88aa00" });
  if (rng() < 0.25) { // a pre-existing condition somewhere on the board
    const t = pick(rng, tokens); const s = markers(t); s.add(pick(rng, CONDITIONS)); setMarkers(t, s);
  }
  if (rng() < 0.25) { // a pre-existing concentration + aura (pc/sidekick only)
    const casters = tokens.filter((t) => t.klass !== "npc");
    if (casters.length) { const t = pick(rng, casters); const s = markers(t); s.add("concentrating"); setMarkers(t, s); t.aura1_radius = 15; }
  }
  return { tokens, turnorder, zones, chat: [] };
}

// ── Pure grading helpers mirroring stubExec's own math (used only to compute an
// EXPECTED post-state — stubExec itself is what actually mutates the board) ────
const clampHp = (before: number, max: number, amount: number, heal: boolean) =>
  Math.max(0, Math.min(max, before + (heal ? amount : -amount)));
const wouldBeWounded = (v: number, max: number) => v > 0 && v * 2 <= max;
const aliveOf = (b: Board, klasses: Klass[]) => b.tokens.filter((t) => klasses.includes(t.klass) && t.layer === "objects" && !has(t, "dead"));

// Total-order fingerprint of everything the grader cares about — used by the
// zero-effect (pure-flavor) axis to assert the board is byte-for-byte untouched.
const snapshotBoard = (b: Board) => JSON.stringify({
  tokens: b.tokens.map((t) => [t.name, t.bar1_value, t.statusmarkers, t.layer, t.aura1_radius, t.gmnotes]),
  turnorder: b.turnorder.map((e) => e.id),
  zones: b.zones.map((z) => [z.name, z.roundsLeft ?? null]),
  chat: b.chat.length,
});

// ── Scenario-thread state — cross-step dependencies (retcon, revival, concentration
// follow-up, zone transitions) chain optimistically off the IDEAL step outcome, since
// generation happens before we know whether the real teacher's step will be accepted.
// If a prior step is rejected, dependents may also fail grading — they're simply
// rejected in turn, which is fine (rejects are inspectable, never in the main corpus).
interface ScenState {
  round: number;
  lastDamage?: { target: string; amount: number; before: number; max: number; klass: Klass };
  downPc?: string;
  concWaiting?: string;
  activeZone?: { name: string; damaging: boolean; createdRound: number };
  usedAxes: Record<string, number>;
}

interface Ideal { text: string; toolCalls: { name: string; args: Record<string, unknown> }[] }
export interface GeneratedStep {
  axis: string;
  utterance: string;
  setup?: (b: Board) => void;
  ideal: Ideal[]; // scripted teacher turns, consumed only in DRY mode
  check: (b: Board, c: Ctx) => string | null;
}
type AxisFn = (rng: () => number, board: Board, state: ScenState) => GeneratedStep | null;

// ── Axis templates — one per calibrated-convention axis in docs/table-mechanics-golden-pairs.md
const axisDeltaDamage: AxisFn = (rng, board, state) => {
  const targets = aliveOf(board, ["npc", "sidekick"]);
  if (!targets.length) return null;
  const t = pick(rng, targets);
  const amount = int(rng, 4, Math.max(5, t.bar1_value));
  const dtype = pick(rng, DMG_TYPES);
  const before = t.bar1_value, max = t.bar1_max;
  const utterance = pick(rng, [
    `${t.name} takes ${amount} ${dtype}.`,
    `${amount} ${dtype} lands square on ${t.name}.`,
    `${t.name} eats ${amount} points of ${dtype} damage.`,
  ]);
  state.lastDamage = { target: t.name, amount, before, max, klass: t.klass };
  return {
    axis: "delta-damage", utterance,
    ideal: [{ text: "", toolCalls: [{ name: "update_token_hp", args: { characterName: t.name, damage: amount } }] }, { text: "Applied.", toolCalls: [] }],
    check: (b) => {
      const t2 = find(b, t.name)!;
      const expected = clampHp(before, max, amount, false);
      if (t2.bar1_value !== expected) return `${t.name} bar1=${t2.bar1_value}, want ${expected}`;
      const wound = wouldBeWounded(expected, max);
      if (expected === 0) { if (!has(t2, "dead") || t2.layer !== "map") return `${t.name} at 0 but not dead+map-layer`; return null; }
      if (wound !== has(t2, "wounded")) return `${t.name} at ${expected}/${max}, wounded=${has(t2, "wounded")} want ${wound}`;
      return null;
    },
  };
};

const axisPcHitCondition: AxisFn = (rng, board, state) => {
  const pcs = aliveOf(board, ["pc"]);
  if (!pcs.length) return null;
  const t = pick(rng, pcs);
  const amount = int(rng, 4, 20);
  const cond = pick(rng, CONDITIONS);
  const dtype = pick(rng, DMG_TYPES);
  const bar1Before = t.bar1_value; // PC bar1 must never move — Beyond20 owns it
  const tracked = readPcHp(t.gmnotes)!;
  const utterance = pick(rng, [
    `${t.name} takes ${amount} ${dtype} and goes ${cond}.`,
    `${t.name} is hit for ${amount} ${dtype} — he's ${cond} now.`,
    `${amount} ${dtype} on ${t.name}, and he's knocked ${cond}.`,
  ]);
  return {
    axis: "pc-hit-condition", utterance,
    ideal: [{ text: "", toolCalls: [{ name: "update_token_hp", args: { characterName: t.name, damage: amount, addConditions: [cond] } }] }, { text: "Applied.", toolCalls: [] }],
    check: (b) => {
      const t2 = find(b, t.name)!;
      if (t2.bar1_value !== bar1Before) return `${t.name} bar1 written (Beyond20 owns it) — was ${bar1Before}, now ${t2.bar1_value}`;
      const trackedAfter = readPcHp(t2.gmnotes);
      const expectedTracked = clampHp(tracked.current, tracked.max, amount, false);
      if (trackedAfter?.current !== expectedTracked) return `${t.name} tracked=${trackedAfter?.current}, want ${expectedTracked}`;
      if (!has(t2, cond)) return `no ${cond} marker on ${t.name}`;
      return null;
    },
  };
};

const axisNegativeSpace: AxisFn = (rng, board, state) => {
  const targets = aliveOf(board, ["npc", "sidekick"]);
  if (!targets.length) return null;
  const t = pick(rng, targets);
  const amount = int(rng, 4, Math.max(5, t.bar1_value));
  const dtype = pick(rng, DMG_TYPES);
  const before = t.bar1_value, max = t.bar1_max;
  const beforeMarkers = new Set(markers(t));
  // Positional/flavor clause deliberately avoids loop-policy's OUTCOME_RE trigger words
  // (no "prone"/"stunned"/etc — those are real conditions, not flavor).
  const flavor = pick(rng, ["staggers back off balance", "reels but keeps its footing", "grunts and plants its feet", "wobbles but holds its ground"]);
  const utterance = `${t.name} takes ${amount} ${dtype} and ${flavor}.`;
  return {
    axis: "negative-space", utterance,
    ideal: [{ text: "", toolCalls: [{ name: "update_token_hp", args: { characterName: t.name, damage: amount } }] }, { text: "Applied.", toolCalls: [] }],
    check: (b) => {
      const t2 = find(b, t.name)!;
      const expected = clampHp(before, max, amount, false);
      if (t2.bar1_value !== expected) return `${t.name} bar1=${t2.bar1_value}, want ${expected}`;
      const expectedMarkers = new Set(beforeMarkers);
      if (expected === 0) expectedMarkers.add("dead"); else if (wouldBeWounded(expected, max)) expectedMarkers.add("wounded"); else expectedMarkers.delete("wounded");
      const got = markers(t2);
      const extra = [...got].filter((m) => !expectedMarkers.has(m));
      if (extra.length) return `invented marker(s) for a flavor clause: ${extra.join(",")}`;
      return null;
    },
  };
};

// Pure negative space: an utterance with NO bookkeeping half at all. The DM owns the
// SPATIAL domain (convention 14) and narrates colour freely (convention 8, pair 3's
// "slow to a crawl") — the correct number of tool calls is ZERO. Without these the
// student learns "one clause ⇒ one marker" and invents state on every sentence.
const axisPureFlavor: AxisFn = (rng, board) => {
  const actors = aliveOf(board, ["npc"]);
  const others = aliveOf(board, ["pc", "sidekick"]);
  if (!actors.length || !others.length) return null;
  const a = pick(rng, actors), o = pick(rng, others);
  const utterance = pick(rng, [
    `${a.name} circles around behind ${o.name} — I've already slid the token over.`,
    `${a.name} shoulders ${o.name} back a couple of squares; I moved him by hand.`,
    `${a.name} kicks the brazier over and the hall lights up orange.`,
    `${a.name} snarls something in Aquan at ${o.name}, and the water churns around its feet.`,
  ]);
  const snap = snapshotBoard(board);
  return {
    axis: "pure-flavor", utterance,
    ideal: [{ text: "Nothing to book — spatial/colour only.", toolCalls: [] }],
    check: (b, c) => {
      const now = snapshotBoard(b);
      if (now !== snap) return `board changed on a pure-flavor utterance:\n  was ${snap}\n  now ${now}`;
      const mutated = c.calls.filter(isMutatingTool);
      if (mutated.length) return `invented state for narrative colour: called ${mutated.join(", ")}`;
      return null;
    },
  };
};

const axisCompoundAoe: AxisFn = (rng, board, state) => {
  const pool = aliveOf(board, ["npc", "sidekick"]);
  if (pool.length < 2) return null;
  const n = Math.min(pool.length, int(rng, 2, 4));
  const targets = shuffle(rng, pool).slice(0, n);
  const full = int(rng, 10, 30);
  const half = Math.floor(full / 2);
  const dtype = pick(rng, DMG_TYPES);
  // Mixed saves: first target fails (full), the rest make it (half) — spelled out per-target.
  const dmgFor = new Map(targets.map((t, i) => [t.name, i === 0 ? full : half] as const));
  const before = new Map(targets.map((t) => [t.name, { v: t.bar1_value, max: t.bar1_max }]));
  const failNames = [targets[0].name];
  const saveNames = targets.slice(1).map((t) => t.name);
  const utterance = `Fireball catches ${targets.map((t) => t.name).join(", ")} — ${full} ${dtype}. ${failNames.join(", ")} fail${failNames.length === 1 ? "s" : ""} the save; ${saveNames.length ? saveNames.join(", ") + " make" + (saveNames.length === 1 ? "s" : "") + " it for half." : ""}`;
  return {
    axis: "compound-aoe", utterance,
    ideal: [
      { text: "", toolCalls: targets.map((t) => ({ name: "update_token_hp", args: { characterName: t.name, damage: dmgFor.get(t.name) } })) },
      { text: "Applied.", toolCalls: [] },
    ],
    check: (b) => {
      for (const t of targets) {
        const t2 = find(b, t.name)!;
        const pre = before.get(t.name)!;
        const expected = clampHp(pre.v, pre.max, dmgFor.get(t.name)!, false);
        if (t2.bar1_value !== expected) return `${t.name} bar1=${t2.bar1_value}, want ${expected}`;
        if (expected === 0) { if (!has(t2, "dead") || t2.layer !== "map") return `${t.name} at 0 but not dead+map-layer`; continue; }
        const wound = wouldBeWounded(expected, pre.max);
        if (wound !== has(t2, "wounded")) return `${t.name} wounded=${has(t2, "wounded")} want ${wound}`;
      }
      return null;
    },
  };
};

// Zone identity must be UNIQUE on the board. Two pools can collapse to the same
// shortName ("Spike Growth" vs "Spike Growth's thorns"), and a seeded difficult zone
// can already hold that name — then a rounds(n) zone "expires" while its namesake
// survives, and the rollover check reads that as a failure. Caught by the gold
// self-test at seeds 2-8 (round-rollover): pick a name not already on the board.
const shortZoneName = (name: string) => name.split("'")[0].split(" ").slice(0, 2).join(" ");

const axisZoneCreate: AxisFn = (rng, board, state) => {
  const damaging = rng() < 0.5;
  const pool = (damaging ? ZONE_DAMAGING : ZONE_DIFFICULT)
    .filter((n) => !board.zones.some((z) => z.name.toLowerCase() === shortZoneName(n).toLowerCase()));
  if (!pool.length) return null; // every candidate name is already on the board
  const name = pick(rng, pool);
  const shortName = shortZoneName(name);
  const utterance = damaging
    ? `${name} fills the room — anyone caught in it takes damage each round.`
    : `${name} spreads across the floor — it's difficult terrain now.`;
  // Zone semantics (golden-pairs convention 5): terrain drives the colour (difficult =
  // green, damaging = red) and duration drives expiry — a damaging fire-type zone is
  // rounds(1), burning out at the next round boundary via process_round_end_zones.
  const zoneArgs = damaging
    ? { name: shortName, color: "#cc0000", terrain: "damaging", duration: { type: "rounds", n: 1 } }
    : { name: shortName, color: "#00aa44", terrain: "difficult", duration: { type: "instant" } };
  return {
    axis: "zone-create", utterance,
    ideal: [{ text: "", toolCalls: [{ name: "create_zone", args: zoneArgs }] }, { text: "Zone up.", toolCalls: [] }],
    check: (b) => {
      // Exact-match on the zone's identity — a first-word regex ("Spike") matches a
      // different zone that merely shares a word, hiding create/expire failures.
      if (!b.zones.some((z) => z.name.toLowerCase() === shortName.toLowerCase())) return `no zone named "${shortName}" created`;
      state.activeZone = { name: shortName, damaging, createdRound: state.round };
      return null;
    },
  };
};

const axisZoneTransition: AxisFn = (rng, board, state) => {
  // Only one material transition per zone (grease→fire, not fire→fire) — otherwise the
  // old and new zone share the "Fire" name and a delete+create becomes indistinguishable
  // from a no-op in the grader.
  if (!state.activeZone || state.activeZone.name.toLowerCase() === "fire") return null;
  const old = state.activeZone;
  const utterance = pick(rng, [
    `The ${old.name} catches — it's fully alight now.`,
    `Someone's torch hits the ${old.name} — it goes up in flame.`,
  ]);
  return {
    axis: "zone-transition", utterance,
    // Per-material delete + create with a NEW duration (convention 6) — never a modify.
    ideal: [{
      text: "", toolCalls: [
        { name: "clear_zone", args: { name: old.name } },
        { name: "create_zone", args: { name: "Fire", color: "#cc0000", terrain: "damaging", duration: { type: "rounds", n: 1 } } },
      ],
    }, { text: "Transitioned.", toolCalls: [] }],
    check: (b) => {
      const stillOld = b.zones.some((z) => z.name.toLowerCase() === old.name.toLowerCase());
      const hasFire = b.zones.some((z) => /fire|flame|burn/i.test(z.name));
      if (stillOld || !hasFire) return `zone transition missed: old-still-up=${stillOld}, fire-zone=${hasFire} (delete+create expected)`;
      state.activeZone = { name: "Fire", damaging: true, createdRound: state.round };
      return null;
    },
  };
};

const axisRoundRollover: AxisFn = (rng, board, state) => {
  const before = board.turnorder.map((e) => e.id);
  if (!before.length) return null;
  const expiring = state.activeZone && state.activeZone.damaging && state.activeZone.createdRound <= state.round ? state.activeZone.name : null;
  const utterance = "That's the round — top of the order.";
  // Round-boundary duty (convention 7 / pair 6): advance, then run the rounds(n) zone
  // countdown. process_round_end_zones is the tool for this — NOT a hand-aimed
  // clear_zone, which would guess at what expired instead of letting the server say.
  const calls: { name: string; args: Record<string, unknown> }[] = [
    { name: "advance_turn", args: {} },
    { name: "process_round_end_zones", args: { currentRound: state.round + 1 } },
  ];
  return {
    axis: "round-rollover", utterance,
    ideal: [{ text: "", toolCalls: calls }, { text: "Round over.", toolCalls: [] }],
    check: (b) => {
      const expectedTop = before[1] ?? before[0];
      const top = b.turnorder[0]?.id;
      if (top !== expectedTop) return `top of order id=${top}, want ${expectedTop} (rotate by one)`;
      if (expiring && b.zones.some((z) => z.name.toLowerCase() === expiring.toLowerCase())) return `expired zone "${expiring}" not removed at round boundary`;
      state.round += 1;
      if (expiring) state.activeZone = undefined;
      return null;
    },
  };
};

const axisRetconDelta: AxisFn = (rng, board, state) => {
  const d = state.lastDamage;
  if (!d) return null;
  let delta = int(rng, -8, 8);
  if (delta === 0) delta = 3;
  const newAmount = Math.max(1, d.amount + delta);
  const compDelta = newAmount - d.amount; // positive = more damage, negative = heal back
  const t = find(board, d.target)!;
  const before = t.bar1_value; // current value AFTER the original hit
  const utterance = `Back up — that hit on ${d.target} was ${newAmount}, not ${d.amount}.`;
  const toolCalls = compDelta > 0
    ? [{ name: "update_token_hp", args: { characterName: d.target, damage: compDelta } }]
    : [{ name: "update_token_hp", args: { characterName: d.target, heal: -compDelta } }];
  state.lastDamage = undefined; // one retcon per source hit
  return {
    axis: "retcon-delta", utterance,
    ideal: [{ text: "", toolCalls }, { text: "Corrected.", toolCalls: [] }],
    check: (b) => {
      const t2 = find(b, d.target)!;
      const expected = clampHp(before, d.max, Math.abs(compDelta), compDelta < 0);
      if (t2.bar1_value !== expected) return `${d.target} bar1=${t2.bar1_value}, want ${expected} (compensating delta ${compDelta})`;
      return null;
    },
  };
};

const axisFudgeDrop: AxisFn = (rng, board, state) => {
  const targets = aliveOf(board, ["npc", "sidekick"]);
  if (!targets.length) return null;
  const t = pick(rng, targets);
  const utterance = pick(rng, [`${t.name} has had it — he drops.`, `${t.name} goes down for good.`]);
  return {
    axis: "fudge-drop", utterance,
    ideal: [{ text: "", toolCalls: [{ name: "kill_token", args: { characterName: t.name } }] }, { text: "Down.", toolCalls: [] }],
    check: (b) => {
      const t2 = find(b, t.name)!;
      if (!has(t2, "dead") || t2.layer !== "map") return `stated drop not honored: dead=${has(t2, "dead")} layer=${t2.layer} (never argue with the table)`;
      return null;
    },
  };
};

const axisDropRouting: AxisFn = (rng, board, state) => {
  const pool = aliveOf(board, ["pc", "sidekick"]);
  if (!pool.length) return null;
  const t = pick(rng, pool);
  const utterance = pick(rng, [`${t.name} is smashed to the floor — he's down.`, `${t.name} goes down!`]);
  const klass = t.klass;
  const ideal: Ideal[] = klass === "pc"
    ? [{ text: "", toolCalls: [{ name: "mark_dying", args: { characterName: t.name } }] }, { text: "Down but not out.", toolCalls: [] }]
    : [{ text: "", toolCalls: [{ name: "kill_token", args: { characterName: t.name } }] }, { text: "Fallen.", toolCalls: [] }];
  if (klass === "pc") state.downPc = t.name;
  return {
    axis: "drop-routing", utterance, ideal,
    check: (b) => {
      const t2 = find(b, t.name)!;
      if (klass === "pc") {
        if (has(t2, "dead")) return "PC marked dead — dying, not dead (3 failed saves first)";
        if (t2.layer !== "objects") return `PC moved to ${t2.layer} layer — dying PCs stay on the token layer`;
        if (!has(t2, "unconscious") || !has(t2, "prone")) return "no unconscious+prone dying state";
      } else {
        if (!has(t2, "dead") || t2.layer !== "map") return `sidekick death: dead=${has(t2, "dead")} layer=${t2.layer} — sidekicks die like NPCs`;
        if (has(t2, "unconscious")) return "sidekick given the PC dying state — they just die";
      }
      return null;
    },
  };
};

const axisRevival: AxisFn = (rng, board, state) => {
  if (!state.downPc) return null;
  const name = state.downPc;
  const setHp = int(rng, 1, 10);
  const utterance = `Someone gets a potion into ${name} — he's back on ${setHp}, conscious, still flat on his back.`;
  state.downPc = undefined;
  return {
    axis: "revival", utterance,
    ideal: [{ text: "", toolCalls: [{ name: "update_token_hp", args: { characterName: name, setHp, removeConditions: ["unconscious"] } }] }, { text: "Revived.", toolCalls: [] }],
    check: (b) => {
      const t2 = find(b, name)!;
      const trackedAfter = readPcHp(t2.gmnotes);
      if (trackedAfter?.current !== setHp) return `${name} tracked=${trackedAfter?.current}, want ${setHp} (absolute-set: "on ${setHp}")`;
      if (has(t2, "unconscious")) return "unconscious not removed";
      if (!has(t2, "prone")) return "prone removed — he stays prone until he stands on his own turn";
      return null;
    },
  };
};

const axisConcentrationQuestion: AxisFn = (rng, board, state) => {
  if (state.concWaiting) return null; // one open question at a time
  let t = board.tokens.filter((x) => x.klass !== "npc" && has(x, "concentrating")).find(() => true);
  let setup: ((b: Board) => void) | undefined;
  if (!t) {
    const casters = aliveOf(board, ["pc", "sidekick"]);
    if (!casters.length) return null;
    t = pick(rng, casters);
    const chosen = t;
    setup = (b) => { const tok = find(b, chosen.name)!; const s = markers(tok); s.add("concentrating"); setMarkers(tok, s); tok.aura1_radius = 15; };
  }
  const target = t;
  const amount = int(rng, 4, 16);
  const dtype = pick(rng, DMG_TYPES);
  const before = target.bar1_value;
  const max = target.bar1_max;
  const trackedBefore = target.klass === "pc" ? readPcHp(target.gmnotes) : null;
  const utterance = `${target.name} takes ${amount} ${dtype}.`;
  state.concWaiting = target.name;
  return {
    axis: "concentration-question", utterance, setup,
    ideal: [{ text: "", toolCalls: [{ name: "update_token_hp", args: { characterName: target.name, damage: amount } }] }, { text: `${target.name} — concentration?`, toolCalls: [] }],
    check: (b, c) => {
      const t2 = find(b, target.name)!;
      if (target.klass === "pc") {
        if (t2.bar1_value !== before) return `${target.name} bar1 written (Beyond20 owns it)`;
        const trackedAfter = readPcHp(t2.gmnotes);
        const expectedTracked = clampHp(trackedBefore!.current, trackedBefore!.max, amount, false);
        if (trackedAfter?.current !== expectedTracked) return `${target.name} tracked=${trackedAfter?.current}, want ${expectedTracked}`;
      } else {
        const expected = clampHp(before, max, amount, false);
        if (t2.bar1_value !== expected) return `${target.name} bar1=${t2.bar1_value}, want ${expected}`;
      }
      if (!has(t2, "concentrating")) return "concentration torn down without asking — the save is the DM's to report";
      if (t2.aura1_radius !== 15) return "aura changed without asking";
      const asked = c.texts.some((x) => /concentrat/i.test(x) && /\?/.test(x));
      if (!asked) return "no concentration micro-question in the reply";
      return null;
    },
  };
};

const axisDeclarativeFollowup: AxisFn = (rng, board, state) => {
  if (!state.concWaiting) return null;
  const name = state.concWaiting;
  // The thread can be resolved out from under us: if the concentrating token dropped in
  // a later step, mark_dying's cascade (or death) already cleared the marker and zeroed
  // the aura, so a "Passed." follow-up would assert a marker that is legitimately gone.
  // Drop the stale thread instead of emitting an unsatisfiable trajectory. (Caught by
  // the gold self-test at seeds 8/10, axis declarative-followup.)
  const holder = find(board, name);
  if (!holder || !has(holder, "concentrating") || has(holder, "dead") || has(holder, "unconscious")) {
    state.concWaiting = undefined;
    return null;
  }
  const failed = rng() < 0.5;
  const utterance = failed ? "Failed." : "Passed.";
  state.concWaiting = undefined;
  return {
    axis: "declarative-followup", utterance,
    ideal: failed
      ? [{ text: "", toolCalls: [{ name: "break_concentration", args: { characterName: name } }] }, { text: "Concentration broken.", toolCalls: [] }]
      : [{ text: "Held.", toolCalls: [] }],
    check: (b) => {
      const t2 = find(b, name)!;
      if (failed) {
        if (has(t2, "concentrating")) return "concentrating marker still set after Failed";
        if (t2.aura1_radius !== 0) return `aura radius=${t2.aura1_radius}, want 0 (teardown cascade)`;
      } else {
        if (!has(t2, "concentrating")) return "concentration torn down after Passed";
        if (t2.aura1_radius === 0) return "aura zeroed after Passed";
      }
      return null;
    },
  };
};

const AXES: [string, AxisFn][] = [
  ["delta-damage", axisDeltaDamage],
  ["pc-hit-condition", axisPcHitCondition],
  ["negative-space", axisNegativeSpace],
  ["pure-flavor", axisPureFlavor],
  ["compound-aoe", axisCompoundAoe],
  ["zone-create", axisZoneCreate],
  ["zone-transition", axisZoneTransition],
  ["round-rollover", axisRoundRollover],
  ["retcon-delta", axisRetconDelta],
  ["fudge-drop", axisFudgeDrop],
  ["drop-routing", axisDropRouting],
  ["revival", axisRevival],
  ["concentration-question", axisConcentrationQuestion],
  ["declarative-followup", axisDeclarativeFollowup],
];

// Samples the roster + how many steps the scenario will run. Step CONTENT is
// generated lazily, one at a time, via genStep() below — NOT eagerly here — because
// each axis reads the board's LIVE values (current HP, markers, active zone) to
// decide targets/amounts and captures a "before" snapshot for grading. Generating
// all steps up front against a frozen board would let step N's "before" go stale
// the moment step N-1 (or any earlier step targeting the same token) actually
// executes and mutates the board — so generation must be interleaved with execution.
function buildScenario(rng: () => number): { board: Board; stepCount: number } {
  const board = sampleRoster(rng);
  const stepCount = int(rng, 5, 12);
  return { board, stepCount };
}

// Generates exactly one step against the board's CURRENT (live) state. Call this
// once per iteration of the execute loop, after the previous step's tool calls have
// already mutated `board` — never pre-batch calls across un-executed steps.
function genStep(rng: () => number, board: Board, state: ScenState): GeneratedStep | null {
  // Follow-up bias. A pending thread (an open concentration micro-question, a downed PC,
  // a live zone waiting for its trigger) is what the DM's very NEXT breath tends to
  // resolve. A flat shuffle over 14 axes strands most of them, which starves exactly the
  // convention-heavy second halves — the teardown cascade, the absolute-set revival, the
  // delete+create transition — that the student has no other way to learn.
  const priority: AxisFn[] = [];
  if (state.concWaiting && rng() < 0.7) priority.push(axisDeclarativeFollowup);
  if (state.downPc && rng() < 0.45) priority.push(axisRevival);
  if (state.activeZone && rng() < 0.35) priority.push(axisZoneTransition);
  for (const fn of priority) {
    const gen = fn(rng, board, state);
    if (gen) { state.usedAxes[gen.axis] = (state.usedAxes[gen.axis] || 0) + 1; return gen; }
  }
  const order = shuffle(rng, AXES);
  for (const [, fn] of order) {
    const gen = fn(rng, board, state);
    if (gen) { state.usedAxes[gen.axis] = (state.usedAxes[gen.axis] || 0) + 1; return gen; }
  }
  return null;
}

// ── Scripted fake teacher for DMW_GEN_DRY — no ollama required ──────────────
// Answers each step with its GeneratedStep.ideal turns, in order, so the sampler /
// grader / JSONL plumbing gets full coverage offline.
class ScriptedGenProvider implements LLMProvider {
  readonly name = "scripted-fake";
  private queue: LLMTurn[] = [];
  private nextId = 0; // deterministic tool-call ids — no unseeded Math.random anywhere in gen-traces
  start(): void {}
  setSystem(): void {}
  pushUser(): void {}
  pushToolResults(): void {}
  pushContinue(): void {}
  repair(): void {}
  reset(): void { this.queue = []; }
  scriptStep(ideal: Ideal[]): void {
    this.queue.push(...ideal.map((turn) => ({
      text: turn.text, truncated: false,
      toolCalls: turn.toolCalls.map((c): ToolCall => ({ id: `dry-${this.nextId++}`, name: c.name, args: c.args })),
    })));
  }
  async run(): Promise<LLMTurn> {
    return this.queue.shift() ?? { text: "", toolCalls: [], truncated: false };
  }
}

// ── Chat-message trace (OpenAI tool-calling shape) — built alongside the real
// provider/stub drive so the JSONL record is a faithful, standalone conversation
// prefix regardless of which backend (Ollama/Anthropic/scripted) produced it. ──
export type ChatMsg =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[] }
  | { role: "tool"; tool_call_id: string; name: string; content: string };

interface TraceRecord {
  messages: ChatMsg[];
  tools: ToolSpec[];
  meta: { scenarioId: number; seed: number; axis: string; stepIdx: number; latencyMs: number; mode: GenMode };
}

interface RejectRecord extends TraceRecord {
  reason: string;
}

// ── Ajv validators (the real -32602 boundary, like the evals) ───────────────
const ajv = new Ajv({ strict: false, allErrors: true });
const validators = new Map<string, ValidateFunction>();

async function runStep(
  teacher: LLMProvider, step: GeneratedStep, board: Board, messages: ChatMsg[], toolSpecs: ToolSpec[],
): Promise<{ ok: boolean; reason: string | null; messages: ChatMsg[]; latencyMs: number }> {
  step.setup?.(board);
  const userText = buildTurnContext(rosterFromBoard(board)) + "\n\n" + step.utterance;
  teacher.pushUser(userText);
  messages.push({ role: "user", content: userText });

  const ctx: Ctx = { calls: [], texts: [] };
  const t0 = Date.now();
  let mutationsThisTurn = 0, nudgedAlready = false, completenessCheckedAlready = false;

  for (let s = 0; s < MAX_STEPS + 2; s++) {
    const turn = await teacher.run();
    if (turn.text) ctx.texts.push(turn.text);
    if (turn.toolCalls.length === 0) {
      messages.push({ role: "assistant", content: turn.text || null });
      const action = decideTerminal({ transcript: step.utterance, mutationsThisTurn, nudgedAlready, completenessCheckedAlready, mode: MODE });
      if (action.kind === "done") break;
      if (action.tag === "persist") nudgedAlready = true; else completenessCheckedAlready = true;
      teacher.pushContinue(action.text);
      messages.push({ role: "user", content: action.text });
      continue;
    }
    messages.push({
      role: "assistant", content: turn.text || null,
      tool_calls: turn.toolCalls.map((c) => ({ id: c.id, type: "function" as const, function: { name: c.name, arguments: JSON.stringify(c.args) } })),
    });
    const results = turn.toolCalls.map((c) => {
      ctx.calls.push(c.name);
      if (isMutatingTool(c.name)) mutationsThisTurn++;
      const val = validators.get(c.name);
      if (val && !val(c.args)) {
        return { id: c.id, name: c.name, content: `MCP error -32602: Input validation error: ${ajv.errorsText(val.errors, { separator: "; " })}` };
      }
      return { id: c.id, name: c.name, content: stubExec(c.name, c.args, board) };
    });
    teacher.pushToolResults(results);
    for (const r of results) messages.push({ role: "tool", tool_call_id: r.id, name: r.name, content: r.content });
  }

  const latencyMs = Date.now() - t0;
  const reason = step.check(board, ctx);
  return { ok: reason === null, reason, messages, latencyMs };
}

// ── Gold mode ───────────────────────────────────────────────────────────────
// The step template's `ideal` IS the expectedCalls producer: sampled against the LIVE
// board (targets, amounts, class routing, the active zone), it is the exact sequence a
// perfect agent would emit — atomic tools preferred throughout (mark_dying / kill_token /
// break_concentration / process_round_end_zones rather than hand-chained primitives).
export const expectedCalls = (step: GeneratedStep): { name: string; args: Record<string, unknown> }[] =>
  step.ideal.flatMap((turn) => turn.toolCalls);

// The closing GM-facing report line. Templated, never generated — the gem reports
// (bookkeeping, numbers allowed), the DM narrates. The template's own closing text is
// the headline (it carries axis-specific intent, e.g. the concentration micro-question);
// the tool results below it are the actual bookkeeping the DM wants to see.
export function goldReport(step: GeneratedStep, results: string[]): string {
  const last = step.ideal[step.ideal.length - 1];
  const head = (last && last.toolCalls.length === 0 && last.text) ? last.text : "Applied.";
  return results.length ? head + "\n" + results.map((r) => `- ${r}`).join("\n") : head;
}

export interface GoldFailure {
  seed: number; scenarioId: number; stepIdx: number; axis: string; reason: string;
}

// Runs one step's gold trajectory: expectedCalls → the SAME ajv (-32602) boundary and
// stubExec the teacher path uses → the step's own check() as a SELF-TEST. A non-null
// reason here means the TEMPLATE is broken (rot), not that a model got it wrong.
export function runStepGold(
  step: GeneratedStep, board: Board, messages: ChatMsg[], idPrefix: string,
): { reason: string | null; toolCallCount: number } {
  step.setup?.(board);
  const userText = buildTurnContext(rosterFromBoard(board)) + "\n\n" + step.utterance;
  messages.push({ role: "user", content: userText });

  const ctx: Ctx = { calls: [], texts: [] };
  const allResults: string[] = [];
  let n = 0, toolCallCount = 0;

  for (const turn of step.ideal) {
    if (turn.toolCalls.length === 0) continue; // closing prose — emitted once, below
    const calls = turn.toolCalls.map((c) => ({ id: `${idPrefix}-${n++}`, name: c.name, args: c.args }));
    toolCallCount += calls.length;
    messages.push({
      role: "assistant", content: turn.text || null,
      tool_calls: calls.map((c) => ({ id: c.id, type: "function" as const, function: { name: c.name, arguments: JSON.stringify(c.args) } })),
    });
    for (const c of calls) {
      ctx.calls.push(c.name);
      const val = validators.get(c.name);
      if (val && !val(c.args)) {
        // A gold call that can't pass the real tool schema is a generator bug, full stop —
        // never emit it as training data pretending the server accepted it.
        return { reason: `GOLD CALL REJECTED BY SCHEMA: ${c.name}(${JSON.stringify(c.args)}) → ${ajv.errorsText(val.errors, { separator: "; " })}`, toolCallCount };
      }
      const content = stubExec(c.name, c.args, board);
      allResults.push(content);
      messages.push({ role: "tool", tool_call_id: c.id, name: c.name, content });
    }
  }

  const finalText = goldReport(step, allResults);
  ctx.texts.push(finalText);
  messages.push({ role: "assistant", content: finalText });

  return { reason: step.check(board, ctx), toolCallCount };
}

export interface GenerateOpts {
  seed: number;
  scenarios: number;
  outPath: string;
  rejectsPath: string;
  dry: boolean;
  provider: string;
  model: string;
  mode?: GenMode; // default "teacher"
  slim?: boolean;      // strip schema noise + defensive prose from tool specs
  scopeCore?: boolean; // drop tools no trajectory ever calls
}

export interface GenerateSummary {
  accepted: number;
  rejected: number;
  accByAxis: Record<string, number>;
  rejByAxis: Record<string, number>;
  wallMs: number;
  mode: GenMode;
  /** Gold mode only: gold trajectories that failed their OWN check() — generator bugs. */
  goldFailures: GoldFailure[];
  /** Gold mode only: JSON chars written, for the corpus token estimate (chars / 3.6). */
  outChars: number;
  /** Gold mode only: emitted records whose assistant turns contained zero tool calls. */
  zeroCallRecords: number;
}

// The generation loop, factored out of main() so tests (DMW_GEN_DRY smoke test) can
// drive it directly with explicit options instead of relying on module-load-time CLI
// parsing — same code path CLI runs, just addressable.
async function generate(opts: GenerateOpts): Promise<GenerateSummary> {
  const mode: GenMode = opts.mode ?? "teacher";
  const gold = mode === "gold";
  const rng = mulberry32(opts.seed);
  let toolSpecs: ToolSpec[];
  let makeStepTeacher: () => LLMProvider;
  let mcp: McpRoll20 | undefined;

  if (opts.dry) {
    // No MCP connection, no ollama — a hand-written lean tool catalog + a scripted
    // teacher that answers each step from its own ideal turns.
    const names = ["update_token_hp", "update_hp_many", "resolve_aoe", "set_token_marker", "kill_token",
      "mark_dying", "break_concentration", "create_zone", "clear_zone", "process_round_end_zones",
      "advance_turn", "set_token_props",
      "roll_dice", "send_narration", "list_tokens", "get_token", "get_turn_order"];
    toolSpecs = names.map((n) => ({ name: n, description: `stub:${n}`, parameters: { type: "object", properties: {} } }));
    // No real schemas in dry mode → no -32602 boundary to enforce (nothing to validate against).
    makeStepTeacher = () => new ScriptedGenProvider();
  } else {
    // Gold mode never constructs a provider, so it needs no API key — the MCP connection
    // here is only for the REAL tool schemas (the -32602 self-test boundary).
    if (!gold && opts.provider === "anthropic" && !process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not set");
    mcp = new McpRoll20();
    const tools = await mcp.connect();
    for (const t of tools) { try { validators.set(t.name, ajv.compile(t.inputSchema)); } catch { /* unschemable */ } }
    // Lean allowlist = cloud ∩ local. MEASURED: at full verbosity the 25-tool catalog is
    // ~7.7k tokens — 72% of a record — putting EVERY sample over the 8192-token training
    // window (median 10.6k, max 12.5k). Two levers, both on by default for gold mode:
    //   --slim   strip schema noise + defensive prose (src/llm/slim-tools.ts)
    //   --scope  drop tools no trajectory ever calls (session/campaign plumbing, inbox,
    //            whisper) — training on schemas the student never emits is pure cost.
    // The student MUST be served the same set it was trained on; keep this in sync with
    // whatever the local path serves.
    const allow = new Set([...CONFIG.cloudToolAllowlist].filter((t) => new Set(CONFIG.localToolAllowlist).has(t)));
    const NEVER_CALLED = new Set(["list_campaigns", "active_campaign", "switch_campaign", "get_recent_chat", "get_dm_inbox", "whisper_player"]);
    toolSpecs = tools
      .filter((t) => allow.has(t.name) && (!opts.scopeCore || !NEVER_CALLED.has(t.name)))
      .map((t) => ({ name: t.name, description: t.description, parameters: t.inputSchema }));
    if (opts.slim) toolSpecs = slimToolSpecs(toolSpecs);
    makeStepTeacher = () => opts.provider === "ollama" ? new OllamaProvider(opts.model, CONFIG.ollamaUrl) : new AnthropicProvider(opts.model);
  }

  // The prompt has to advertise the same catalog the record was built with, or the student
  // learns to call tools its own system prompt lists but the schema never contains.
  const system = buildSystemPrompt(gold ? "ollama" : opts.provider, { scoped: !!opts.scopeCore });
  fs.mkdirSync(path.dirname(opts.outPath), { recursive: true });
  const outFd = fs.openSync(opts.outPath, "w");
  const rejFd = fs.openSync(opts.rejectsPath, "w");

  const accByAxis: Record<string, number> = {};
  const rejByAxis: Record<string, number> = {};
  let accepted = 0, rejected = 0, outChars = 0, zeroCallRecords = 0;
  const goldFailures: GoldFailure[] = [];
  const wall0 = Date.now();

  for (let scenarioId = 0; scenarioId < opts.scenarios; scenarioId++) {
    const { board, stepCount } = buildScenario(rng);
    const state: ScenState = { round: 1, usedAxes: {} };
    // Gold mode drives no model at all — no provider is constructed, nothing is started.
    const teacher = gold ? null : (opts.dry ? new ScriptedGenProvider() : makeStepTeacher());
    teacher?.start(system, toolSpecs);
    const messages: ChatMsg[] = [{ role: "system", content: system }];

    for (let stepIdx = 0; stepIdx < stepCount; stepIdx++) {
      // Generated AFTER prior steps' tool calls have mutated `board` — see genStep().
      const step = genStep(rng, board, state);
      if (!step) continue;

      let ok: boolean, reason: string | null, latencyMs: number, toolCalls = -1;
      if (gold) {
        const res = runStepGold(step, board, messages, `gold-${opts.seed}-${scenarioId}-${stepIdx}`);
        // Deterministic for a fixed seed: no wall-clock leaks into a gold record.
        reason = res.reason; ok = reason === null; latencyMs = 0; toolCalls = res.toolCallCount;
      } else {
        if (opts.dry) (teacher as ScriptedGenProvider).scriptStep(step.ideal);
        const res = await runStep(teacher!, step, board, messages, toolSpecs);
        ok = res.ok; reason = res.reason; latencyMs = res.latencyMs;
      }

      const record: TraceRecord = {
        messages: messages.slice(), // full conversation prefix through this step
        tools: toolSpecs,
        meta: { scenarioId, seed: opts.seed, axis: step.axis, stepIdx, latencyMs, mode },
      };
      if (ok) {
        const line = JSON.stringify(record) + "\n";
        fs.writeSync(outFd, line);
        outChars += line.length;
        if (toolCalls === 0) zeroCallRecords++;
        accepted++; accByAxis[step.axis] = (accByAxis[step.axis] || 0) + 1;
      } else if (gold) {
        // A gold trajectory that fails its OWN check is template rot, not a model miss.
        // Record it loudly (the process exits non-zero) — never silently drop it.
        goldFailures.push({ seed: opts.seed, scenarioId, stepIdx, axis: step.axis, reason: reason! });
        fs.writeSync(rejFd, JSON.stringify({ ...record, reason: reason! } satisfies RejectRecord) + "\n");
        rejected++; rejByAxis[step.axis] = (rejByAxis[step.axis] || 0) + 1;
      } else {
        const rej: RejectRecord = { ...record, reason: reason! };
        fs.writeSync(rejFd, JSON.stringify(rej) + "\n");
        rejected++; rejByAxis[step.axis] = (rejByAxis[step.axis] || 0) + 1;
      }
    }
  }

  fs.closeSync(outFd); fs.closeSync(rejFd);
  await mcp?.close();

  return { accepted, rejected, accByAxis, rejByAxis, wallMs: Date.now() - wall0, mode, goldFailures, outChars, zeroCallRecords };
}

function printSummary(opts: GenerateOpts, summary: GenerateSummary) {
  const gold = summary.mode === "gold";
  const engine = gold ? "GOLD — ground truth, no teacher model" : `provider=${opts.provider}/${opts.model}${opts.dry ? " (DRY — scripted fake teacher)" : ""}`;
  console.log(`\n──────── gen-traces ────────  seed=${opts.seed} scenarios=${opts.scenarios} mode=${summary.mode}  ${engine}`);
  console.log(`  ${gold ? "emitted" : "accepted"}: ${summary.accepted}   ${gold ? "self-test FAILURES" : "rejected"}: ${summary.rejected}   total steps: ${summary.accepted + summary.rejected}`);
  console.log(`\n  per-axis (${gold ? "gold trajectories" : "accepted/total, reject rate"}):`);
  for (const [axis] of AXES) {
    const a = summary.accByAxis[axis] || 0, r = summary.rejByAxis[axis] || 0, tot = a + r;
    if (!tot) continue;
    if (gold) { console.log(`    ${axis.padEnd(24)} ${String(a).padStart(4)}${r ? `   ⚠ ${r} FAILED SELF-TEST` : ""}`); continue; }
    const rate = ((r / tot) * 100).toFixed(0);
    const flag = r > 0 && r / tot >= 0.3 ? "  ⚠ HIGH REJECT RATE" : "";
    console.log(`    ${axis.padEnd(24)} ${String(a).padStart(3)}/${String(tot).padEnd(3)}  reject=${rate}%${flag}`);
  }
  if (gold) {
    console.log(`\n  zero-tool-call (negative-space) records: ${summary.zeroCallRecords}`);
    console.log(`  corpus: ${summary.outChars.toLocaleString()} JSON chars  ≈ ${Math.round(summary.outChars / 3.6).toLocaleString()} tokens (chars/3.6)`);
  }
  console.log(`\n  out:     ${opts.outPath}`);
  console.log(`  rejects: ${opts.rejectsPath}`);
  console.log(`  wall: ${(summary.wallMs / 1000).toFixed(1)}s`);

  if (summary.goldFailures.length) {
    console.error(`\n  ✗ ${summary.goldFailures.length} GOLD SELF-TEST FAILURE(S) — the generator's own ground truth does not satisfy its own check().`);
    console.error("    This is TEMPLATE ROT (a step template drifted from the conventions it grades), not a model error.");
    for (const f of summary.goldFailures) {
      console.error(`      seed=${f.seed} scenario=${f.scenarioId} step=${f.stepIdx} axis=${f.axis}\n        ${f.reason}`);
    }
  }
}

async function main() {
  const outPath = OUT_PATH;
  const opts: GenerateOpts = {
    seed: SEED, scenarios: N_SCENARIOS, outPath, rejectsPath: REJECTS_PATH,
    dry: DRY, provider: PROVIDER, model: MODEL, mode: GEN_MODE,
    // Default ON for gold (training corpora must fit the 8k window); --no-slim/--no-scope to disable.
    slim: !process.argv.includes("--no-slim") && GEN_MODE === "gold",
    scopeCore: !process.argv.includes("--no-scope") && GEN_MODE === "gold",
  };
  const summary = await generate(opts);
  printSummary(opts, summary);
  // Gold trajectories are correct BY CONSTRUCTION — a failure means the generator is
  // broken and the corpus is untrustworthy. Fail the process, don't ship a quiet subset.
  if (summary.goldFailures.length) process.exit(1);
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

export { mulberry32, buildScenario, genStep, sampleRoster, AXES, ScriptedGenProvider, runStep, generate, printSummary, main, snapshotBoard };
