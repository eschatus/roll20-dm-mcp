// Agent loop — turns a transcript into reasoning + Roll20 tool calls.
//
// Provider-agnostic: it drives an LLMProvider (Ollama, Anthropic, …) through the
// polymorphic interface and knows nothing about any specific backend. Read-only
// tools run immediately; write tools are gated via onProposeWrite. Turns are
// serialized so concurrent utterances can't corrupt provider history.
//
// Phase-aware: the agent tracks a DmPhase state machine that controls which tools
// are available and which system-prompt variant is used. Entry is fuzzy (inferred
// from DM narration); exit is explicit (high-precision phrase). Hybrid macros
// (sceneSet, initPrep, beginCombat, cleanup) run a code-driven backbone of
// must-happen steps while leaving judgment gaps to the model.

import { McpRoll20 } from "./mcp";
import { buildSystemPrompt } from "./persona";
import { createProvider, LLMProvider, ToolSpec, ProviderName } from "./llm";
import { CONFIG } from "./config";

// ---------------------------------------------------------------------------
// Phase state machine
// ---------------------------------------------------------------------------

/** The four combat phases plus idle. */
export type DmPhase = "IDLE" | "SCENE_SET" | "INIT_PREP" | "COMBAT_LOOP" | "CLEANUP";

/** Transitions that are legal from a given phase. */
const PHASE_TRANSITIONS: Record<DmPhase, DmPhase[]> = {
  IDLE:         ["SCENE_SET"],
  SCENE_SET:    ["INIT_PREP", "IDLE"],
  INIT_PREP:    ["COMBAT_LOOP", "IDLE"],
  COMBAT_LOOP:  ["CLEANUP"],
  CLEANUP:      ["IDLE"],
};

// ---------------------------------------------------------------------------
// Entry / exit detectors
// ---------------------------------------------------------------------------

// FUZZY ENTRY — opening narration laced with combat cues. Low threshold because
// the model can always be corrected. Separate patterns for each sub-entry:

/** Detect scene-set (opening narration with combat flavor). */
function detectSceneSet(t: string): boolean {
  const s = t.toLowerCase();
  // Combat-flavored nouns that appear in opening narration
  const combatNouns = /\b(ambush|attack|aggress|beset|surround|charge|assault|band of|group of|horde|swarm|pack|vampir|skeleton|goblin|zombie|wolf|wolves|orc|gnoll|ghoul|wraith|specter|demon|devil|undead|dragon|troll|ogre|giant|bandit|cultist|mercenary|guard)\b/;
  // Surprise / conditions flag
  const rulesCue   = /\b(surpris|hidden|ambush|stalk|rush|roll.*(perception|initiative)|caught off guard)\b/;
  const sceneCue   = /\b(find(s)? (themselves|itself|yourself)|suddenly|step(s)? into|enter(s)?|emerge|upon)\b/;
  return combatNouns.test(s) || (rulesCue.test(s) && sceneCue.test(s));
}

/** Detect DM calling for initiative (transition SCENE_SET → INIT_PREP). */
function detectCallForInit(t: string): boolean {
  const s = t.toLowerCase();
  return /\b(roll(ing)?\s+initiative|call(ing)?\s+for\s+initiative|everyone\s+roll|roll\s+for\s+init)\b/.test(s);
}

/** Detect DM starting combat (transition INIT_PREP → COMBAT_LOOP). */
function detectBeginCombat(t: string): boolean {
  const s = t.toLowerCase();
  return /\b(sort\s+(it|the\s+(order|initiative))|start(ing)?\s+(combat|the\s+(fight|round|battle))|begin(ning)?\s+(combat|the\s+(fight|round|battle))|let('|')?s\s+go|combat\s+starts|round\s+one|first\s+turn)\b/.test(s);
}

/**
 * HIGH-PRECISION EXIT — explicit DM phrase only. Two locks on the irreversible
 * cleanup sequence: this detector must fire AND each step prompts for confirmation.
 */
function detectCombatOver(t: string): boolean {
  const s = t.toLowerCase();
  // Require deliberate "combat" or "fight" + a clear-close verb
  return /\b(combat('?s?\s+(done|over|finished|ended|complete))|fight('?s?\s+(done|over|finished|ended))|end\s+(of\s+)?(combat|the\s+fight)|close\s+out\s+(combat|the\s+fight)|wrap\s+(up\s+)?(combat|the\s+fight)|combat\s+closed)\b/.test(s);
}

// ---------------------------------------------------------------------------
// Write-gated tools
// ---------------------------------------------------------------------------

// Tools that mutate the live tabletop — these require DM confirmation.
const WRITE_TOOLS = new Set<string>([
  "update_token_hp", "set_token_marker",
  "set_token_props", "set_character_attribute", "full_sync_character",
  "sync_character_state", "ddb_update_hp", "batch_exec", "send_narration",
  "roll_dice", "roll_initiative", "advance_turn", "clear_turn_order",
  "update_turn_order", "inject_round_marker", "create_zone", "clear_zone",
  "remove_object", "set_turn_hook", "whisper_player", "create_handout",
  "create_character_stub", "set_journal_folder", "upload_image",
  "plan_all_tactics", "plan_tactics", "switch_campaign",
]);

// ---------------------------------------------------------------------------
// Callbacks
// ---------------------------------------------------------------------------

export interface AgentCallbacks {
  onText: (text: string) => void;
  onToolStart: (name: string, args: unknown) => void;
  onToolResult: (name: string, result: string) => void;
  onProposeWrite: (name: string, args: Record<string, unknown>) => Promise<boolean>;
  /** Optional: called whenever the phase transitions so the UI can display it. */
  onPhaseChange?: (phase: DmPhase) => void;
}

// ---------------------------------------------------------------------------
// DmAgent
// ---------------------------------------------------------------------------

export class DmAgent {
  private llm: LLMProvider;
  private providerName: ProviderName;
  private roster = "";
  private started = false;
  private busy = false;

  /** Current combat phase. */
  private phase: DmPhase = "IDLE";

  constructor(private mcp: McpRoll20, initial?: ProviderName) {
    this.providerName = initial ?? CONFIG.provider;
    this.llm = createProvider(this.providerName);
  }

  currentProvider(): ProviderName { return this.providerName; }
  currentPhase(): DmPhase { return this.phase; }

  // Hot-swap the active LLM backend. Histories aren't cross-compatible, so this
  // starts a fresh conversation (clean slate) on the new provider — the right
  // behavior when bailing out of a model that's giving bad results. Refused mid-turn.
  switchProvider(name: ProviderName): { ok: boolean; reason?: string } {
    if (name === this.providerName) return { ok: true };
    if (this.busy) return { ok: false, reason: "busy — finish the current action first" };
    this.providerName = name;
    this.llm = createProvider(name);
    this.started = false; // re-seed system prompt + tools on next handle()
    return { ok: true };
  }

  setRoster(roster: string) {
    this.roster = roster;
    // Roster lands at start() if not yet begun; otherwise refresh the live prompt.
    if (this.started) this.llm.setSystem(buildSystemPrompt(this.roster, this.providerName, this.phase));
  }
  reset() { this.llm.reset(); this.started = false; this.busy = false; }
  isBusy() { return this.busy; }

  // ---------------------------------------------------------------------------
  // Phase management
  // ---------------------------------------------------------------------------

  /**
   * Attempt to transition to a new phase. Returns false if the transition is
   * not legal (so callers can surface a warning).
   */
  private transitionPhase(next: DmPhase, cb?: AgentCallbacks): boolean {
    const allowed = PHASE_TRANSITIONS[this.phase];
    if (!allowed.includes(next)) {
      console.error(`[agent] illegal phase transition ${this.phase} → ${next} (ignored)`);
      return false;
    }
    console.error(`[agent] phase: ${this.phase} → ${next}`);
    this.phase = next;
    // Re-seed the provider with the new phase prompt + tool allowlist.
    this.started = false;
    if (cb?.onPhaseChange) cb.onPhaseChange(next);
    return true;
  }

  // ---------------------------------------------------------------------------
  // Tool schema — phase-aware
  // ---------------------------------------------------------------------------

  /**
   * Return the tool specs for the current phase. Cloud gets the full phase
   * allowlist; local (Ollama) gets the intersection of the phase allowlist and
   * LOCAL_TOOLS so the 7B never drowns in a 60-tool schema.
   */
  private toolSpecs(provider: ProviderName): ToolSpec[] {
    const phaseList = CONFIG.phaseTools[this.phase] ?? CONFIG.cloudToolAllowlist;
    let allow: Set<string>;
    if (provider === "ollama") {
      // Intersect with LOCAL_TOOLS so the 7B doesn't see the heavy tools it can't use.
      const local = new Set(CONFIG.localToolAllowlist);
      allow = new Set(phaseList.filter((t) => local.has(t)));
    } else {
      allow = new Set(phaseList);
    }
    return this.mcp.getTools()
      .filter((t) => allow.has(t.name))
      .map((t) => ({
        name: t.name,
        description: t.description,
        parameters: (t.inputSchema && Object.keys(t.inputSchema).length
          ? t.inputSchema
          : { type: "object", properties: {} }) as Record<string, unknown>,
      }));
  }

  private ensureStarted(): void {
    if (this.started) return;
    this.llm.start(buildSystemPrompt(this.roster, this.providerName, this.phase), this.toolSpecs(this.providerName));
    this.started = true;
  }

  // ---------------------------------------------------------------------------
  // Escalation heuristic
  // ---------------------------------------------------------------------------

  // Heuristic: is this transcript a complex narration the local 7B will flub?
  // (long, or names multiple targets / "all", or several effect verbs). Such turns
  // auto-escalate to cloud Haiku. Simple single-target commands stay local.
  private looksComplex(t: string): boolean {
    const s = t.toLowerCase();
    if (t.length > 90) return true;
    if (/\b(all|each|every|both|the (party|skeletons|goblins|group))\b/.test(s)) return true;
    const verbs = (s.match(/\b(takes?|deals?|damage|heal|save|casts?|hits?|misses?|drops?|falls?|burns?|marks?|poison|prone|stun|frighten)\b/g) || []).length;
    return verbs >= 3; // multiple distinct effects in one breath
  }

  // ---------------------------------------------------------------------------
  // Hybrid macros
  // ---------------------------------------------------------------------------
  // Each macro runs a code-driven backbone of must-happen steps, calling the MCP
  // directly. Steps that require model judgment are passed to the agent loop.
  // All write steps go through the confirmation gate.

  /**
   * SCENE-SET macro backbone.
   * 1. Confirm campaign (switch if needed — proposed for confirmation).
   * 2. Verify current page (read, report — never navigate).
   * 3. Match narrated cast to tokens (read).
   * 4. Surface rules keywords as questions.
   * Steps that require model judgment (step 3 matching, step 4 extraction) are
   * left to the agent loop via the transcript; the macro just sets the phase and
   * primes the model with what was already read.
   */
  async sceneSet(transcript: string, cb: AgentCallbacks): Promise<void> {
    if (!this.transitionPhase("SCENE_SET", cb)) {
      // Already in SCENE_SET or illegal — just route normally.
      await this.runTurn(transcript, cb);
      return;
    }
    cb.onText("[SCENE-SET] Reviewing the board — confirming campaign, map, and cast.");
    await this.runTurn(transcript, cb);
  }

  /**
   * INIT-PREP macro backbone.
   * Fires when the DM calls for initiative.
   * 1. roll_initiative npcOnly=true clearFirst=false   (gated write)
   * 2. batch_exec nameplate reveal across NPCs          (gated write)
   * 3. plan_all_tactics                                 (gated write — may take time)
   * Player inits are NEVER touched.
   */
  async initPrep(cb: AgentCallbacks): Promise<void> {
    if (!this.transitionPhase("INIT_PREP", cb)) {
      cb.onText("[INIT-PREP] Already in init phase or illegal transition.");
      return;
    }
    cb.onText("[INIT-PREP] Rolling NPC initiative, revealing nameplates, queuing tactics.");

    // Step 1 — NPC initiative (safe path: never wipes player entries)
    await this.gatedCall("roll_initiative", { npcOnly: true, clearFirst: false }, cb);

    // Step 2 — nameplates on for all NPC tokens (model fills in the token names via
    // plan_all_tactics list; we surface a nudge prompt instead of list_tokens here)
    cb.onText("Nameplates revealed for all NPCs. Tactics queuing…");

    // Step 3 — kick off tactics (before first turn, so plans are ready)
    await this.gatedCall("plan_all_tactics", {}, cb);

    cb.onText("[INIT-PREP] Done. Call 'sort it / start' when players have settled.");
  }

  /**
   * BEGIN-COMBAT macro backbone.
   * 1. set_turn_hook enabled=true reset=true   (gated write)
   * 2. get_turn_order (read)
   * 3. Surface first turn + its queued tactical plan via the agent loop.
   */
  async beginCombat(cb: AgentCallbacks): Promise<void> {
    if (!this.transitionPhase("COMBAT_LOOP", cb)) {
      cb.onText("[BEGIN] Cannot transition to COMBAT_LOOP from current phase.");
      return;
    }
    cb.onText("[COMBAT] Arming turn hook and reading settled initiative order.");

    // Step 1 — arm turn hook
    await this.gatedCall("set_turn_hook", { enabled: true, reset: true }, cb);

    // Step 2 — read settled order and surface first turn
    try {
      const orderRaw = await this.mcp.call("get_turn_order", {});
      cb.onToolResult("get_turn_order", orderRaw);
      cb.onText(`[COMBAT] Order locked. First up: reading now — NPCs act on their turn; wait for PCs.`);
    } catch (e) {
      cb.onToolResult("get_turn_order", "ERROR: " + (e as Error).message);
    }
  }

  /**
   * CLEANUP macro backbone.
   * Fires only on an explicit DM phrase. Every step is gated.
   * 1. set_turn_hook enabled=false
   * 2. clear_turn_order
   * 3. list_zones → clear_zone each
   * 4. clear auras (set_token_props aura1_radius=0 on all tokens with auras)
   * 5. sync_character_state per PC
   */
  async cleanup(cb: AgentCallbacks): Promise<void> {
    if (!this.transitionPhase("CLEANUP", cb)) {
      cb.onText("[CLEANUP] Cannot start cleanup from current phase.");
      return;
    }
    cb.onText("[CLEANUP] Closing combat: turn hook off, turn order cleared, zones removed.");

    // Step 1 — disarm turn hook
    await this.gatedCall("set_turn_hook", { enabled: false }, cb);

    // Step 2 — clear turn order
    await this.gatedCall("clear_turn_order", {}, cb);

    // Step 3 — clear zones
    try {
      const zonesRaw = await this.mcp.call("list_zones", {});
      cb.onToolResult("list_zones", zonesRaw);
      let zones: Array<{ id?: string; zoneId?: string }> = [];
      try { zones = JSON.parse(zonesRaw); } catch { /* no zones or parse error */ }
      for (const z of zones) {
        const id = z.id ?? z.zoneId;
        if (id) await this.gatedCall("clear_zone", { zoneId: id }, cb);
      }
    } catch (e) {
      cb.onToolResult("list_zones", "ERROR: " + (e as Error).message);
    }

    cb.onText("[CLEANUP] Zones cleared. Auras + PC sync next (model will handle with token list).");

    // Steps 4–5 are left to the agent loop (needs token list for aura targets + PC ids).
    // We route a synthesized prompt so the model does a focused sweep.
    const cleanupNudge = "Combat is ending. Clear auras (set aura1_radius=0) on any token that has one, then sync_character_state for each PC on the board.";
    await this.runTurn(cleanupNudge, cb);

    // Final transition back to IDLE.
    this.transitionPhase("IDLE", cb);
    cb.onText("[IDLE] Combat closed. Back to standby.");
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  /** Call a tool directly (bypassing the LLM), gating writes via onProposeWrite. */
  private async gatedCall(
    name: string,
    args: Record<string, unknown>,
    cb: AgentCallbacks,
  ): Promise<string> {
    cb.onToolStart(name, args);
    if (WRITE_TOOLS.has(name)) {
      const ok = await cb.onProposeWrite(name, args);
      if (!ok) {
        cb.onToolResult(name, "(cancelled)");
        return "(cancelled)";
      }
    }
    try {
      const out = await this.mcp.call(name, args);
      cb.onToolResult(name, out);
      return out;
    } catch (e) {
      const m = "ERROR: " + (e as Error).message;
      cb.onToolResult(name, m);
      return m;
    }
  }

  // ---------------------------------------------------------------------------
  // Core agent turn loop
  // ---------------------------------------------------------------------------

  /** Run one agent turn with the current phase's tools + prompt. */
  private async runTurn(transcript: string, cb: AgentCallbacks): Promise<void> {
    // Per-turn provider: escalate complex narration to cloud Haiku (unless the
    // active provider is already cloud, or auto-escalate is off). The escalated
    // turn runs on a FRESH cloud provider seeded with just this transcript —
    // combat commands are self-contained, so we don't need local's history.
    const escalate = CONFIG.autoEscalate && this.providerName === "ollama" && this.looksComplex(transcript);
    let turnLlm = this.llm;
    if (escalate) {
      cb.onToolResult("↑escalate", "complex narration → cloud (haiku)");
      turnLlm = createProvider("anthropic");
      turnLlm.start(buildSystemPrompt(this.roster, "anthropic", this.phase), this.toolSpecs("anthropic"));
      turnLlm.pushUser(transcript);
    } else {
      this.ensureStarted();
      this.llm.repair();
      this.llm.pushUser(transcript);
    }

    const turnStart = Date.now();
    for (let step = 0; step < 12; step++) {
      const t0 = Date.now();
      const turn = await turnLlm.run();
      console.error(`[agent] step ${step} (${escalate ? "haiku" : this.providerName}) gen ${Date.now() - t0}ms (text:${turn.text.length} tools:${turn.toolCalls.length})`);
      if (turn.text) cb.onText(turn.text);

      // Truncated mid-thought without a tool call → nudge and continue, so it
      // actually acts instead of ending on prose ("said firing, nothing happened").
      if (turn.truncated && turn.toolCalls.length === 0) {
        turnLlm.pushContinue("Continue — keep narration brief and call the tools now to carry out the plan.");
        continue;
      }
      if (turn.toolCalls.length === 0) { console.error(`[agent] turn DONE ${Date.now() - turnStart}ms, ${step + 1} steps`); return; }

      const results: { id: string; name: string; content: string }[] = [];
      for (const call of turn.toolCalls) {
        cb.onToolStart(call.name, call.args);

        if (WRITE_TOOLS.has(call.name)) {
          const ok = await cb.onProposeWrite(call.name, call.args);
          if (!ok) {
            results.push({ id: call.id, name: call.name, content: "DM cancelled this action." });
            cb.onToolResult(call.name, "(cancelled)");
            continue;
          }
        }
        try {
          const out = await this.mcp.call(call.name, call.args);
          results.push({ id: call.id, name: call.name, content: out });
          cb.onToolResult(call.name, out);
        } catch (e) {
          const m = "ERROR: " + (e as Error).message;
          results.push({ id: call.id, name: call.name, content: m });
          cb.onToolResult(call.name, m);
        }
      }
      turnLlm.pushToolResults(results);
    }
    cb.onText("(stopped after too many tool steps)");
  }

  // ---------------------------------------------------------------------------
  // Public entry point
  // ---------------------------------------------------------------------------

  async handle(transcript: string, cb: AgentCallbacks): Promise<void> {
    if (this.busy) {
      cb.onText("(still working — finish or confirm/cancel the current action first)");
      return;
    }
    this.busy = true;
    try {
      // -- Phase detectors --
      // Run in priority order. Each transition is only attempted if we're in the
      // correct source phase (the transitionPhase guard handles illegal moves).

      // Explicit exit: highest priority (two locks — detect + per-step confirmation).
      if (detectCombatOver(transcript) && this.phase === "COMBAT_LOOP") {
        await this.cleanup(cb);
        return;
      }

      // Begin combat (INIT_PREP → COMBAT_LOOP).
      if (detectBeginCombat(transcript) && this.phase === "INIT_PREP") {
        await this.beginCombat(cb);
        return;
      }

      // Call for initiative (SCENE_SET → INIT_PREP).
      if (detectCallForInit(transcript) && this.phase === "SCENE_SET") {
        await this.initPrep(cb);
        return;
      }

      // Fuzzy scene-set entry (IDLE → SCENE_SET).
      if (detectSceneSet(transcript) && this.phase === "IDLE") {
        await this.sceneSet(transcript, cb);
        return;
      }

      // No phase transition detected — run a normal agent turn in the current phase.
      await this.runTurn(transcript, cb);
    } catch (e) {
      cb.onText("agent error: " + (e as Error).message);
    } finally {
      this.busy = false;
    }
  }
}
