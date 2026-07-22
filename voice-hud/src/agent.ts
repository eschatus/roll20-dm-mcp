// Agent loop — turns a transcript into reasoning + Roll20 tool calls.
//
// Provider-agnostic: it drives an LLMProvider (Ollama, Anthropic, …) through the
// polymorphic interface and knows nothing about any specific backend. Read-only
// tools run immediately; write tools are gated via onProposeWrite. Turns are
// serialized so concurrent utterances can't corrupt provider history.
//
// STATELESS with respect to capability: the model always sees the full cloud
// toolset, so what the DM can do never depends on what was said earlier. Three
// explicit commands ("roll initiative", "start combat", "combat's over") run a
// code-driven backbone of must-happen steps — but only the steps; the DM's own
// words are always routed to the model afterwards, so a command can never
// swallow the rest of the utterance.
//
// This replaced a DmPhase state machine that gated tools into 1 of 5 phases;
// see docs/phase-removal.md for the harms and the before/after evidence.

import type { McpTool } from "./mcp";
import { buildSystemPrompt, buildTurnContext } from "./persona";
import { createProvider, LLMProvider, ToolSpec, ProviderName } from "./llm";
import { CONFIG } from "./config";
import { decideTerminal, isMutatingTool, isSentinel, looksComplex } from "./loop-policy";

// The narrow MCP surface the agent actually uses: list tools + call one. The
// real McpRoll20 satisfies this structurally; tests inject a recording fake.
// (McpRoll20 has private fields, so depending on the concrete class would block
// a structural test double — the interface is the seam.)
export interface Roll20McpLike {
  getTools(): McpTool[];
  call(name: string, args: Record<string, unknown>): Promise<string>;
}

/** Factory that builds an LLMProvider for a given backend name. Injectable so
 *  tests can supply a deterministic FakeProvider instead of a live model. */
export type ProviderFactory = (name: ProviderName) => LLMProvider;

// ---------------------------------------------------------------------------
// Command detectors
// ---------------------------------------------------------------------------
//
// These recognize EXPLICIT DM commands ("roll initiative", "start combat",
// "combat's over") and run the matching choreography backbone. They are NOT a
// state machine: there are no phases, no transition table, and no gating of the
// tool set. The model always sees the full cloud toolset, so a command that
// isn't recognized costs nothing — the DM's words still route to the model,
// which can call the same tools directly.
//
// Deliberately removed (see docs/phase-removal.md): the IDLE/SCENE_SET/
// INIT_PREP/COMBAT_LOOP/CLEANUP machine and the fuzzy `detectSceneSet` entry.
// The machine gated live-combat tools into 1 of 5 phases, so the DM could be
// locked out of HP/conditions mid-fight with no single utterance to escape;
// and the fuzzy entry keyed on word FORM, not meaning ("the goblin swings"
// entered a scene, "the vampires close in" did not).
/**
 * Appended to the DM's transcript after the CLEANUP backbone. Steps 4–5 of the
 * close sequence need a token list (aura targets + PC ids), so the model does
 * them — but as part of the DM's own turn, not a turn that replaces it.
 */
const CLEANUP_SWEEP =
  "Combat is ending. Clear auras (set aura1_radius=0) on any token that has one, " +
  "then sync_character_state for each PC on the board.";

/** Detect the DM calling for initiative → runs the INIT-PREP backbone. */
export function detectCallForInit(t: string): boolean {
  const s = t.toLowerCase();
  return /\b(roll(ing)?\s+initiative|call(ing)?\s+for\s+initiative|everyone\s+roll|roll\s+for\s+init)\b/.test(s);
}

/** Detect the DM starting combat → runs the BEGIN-COMBAT backbone. */
export function detectBeginCombat(t: string): boolean {
  const s = t.toLowerCase();
  return /\b(sort\s+(it|the\s+(order|initiative))|start(ing)?\s+(combat|the\s+(fight|round|battle))|begin(ning)?\s+(combat|the\s+(fight|round|battle))|let('|')?s\s+go|combat\s+starts|round\s+one|first\s+turn)\b/.test(s);
}

/**
 * HIGH-PRECISION EXIT — explicit DM phrase only. Two locks on the irreversible
 * cleanup sequence: this detector must fire AND each step prompts for confirmation.
 */
export function detectCombatOver(t: string): boolean {
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
  /**
   * Optional: fired when the CLEANUP backbone closes a fight. Replaces the old
   * onPhaseChange("CLEANUP") hook — the After-Action Review hangs off this, so
   * it survives the removal of the phase machine.
   */
  onCombatEnd?: () => void;
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

  constructor(
    private mcp: Roll20McpLike,
    initial?: ProviderName,
    private makeProvider: ProviderFactory = createProvider,
  ) {
    this.providerName = initial ?? CONFIG.provider;
    this.llm = this.makeProvider(this.providerName);
  }

  currentProvider(): ProviderName { return this.providerName; }

  // Hot-swap the active LLM backend. Histories aren't cross-compatible, so this
  // starts a fresh conversation (clean slate) on the new provider — the right
  // behavior when bailing out of a model that's giving bad results. Refused mid-turn.
  switchProvider(name: ProviderName): { ok: boolean; reason?: string } {
    if (name === this.providerName) return { ok: true };
    if (this.busy) return { ok: false, reason: "busy — finish the current action first" };
    this.providerName = name;
    this.llm = this.makeProvider(name);
    this.started = false; // re-seed system prompt + tools on next handle()
    return { ok: true };
  }

  setRoster(roster: string) {
    this.roster = roster;
    // Roster is injected per-turn via buildTurnContext (kept out of the cached,
    // frozen system prompt), so there's nothing to refresh on the live provider.
  }
  reset() { this.llm.reset(); this.started = false; this.busy = false; }
  isBusy() { return this.busy; }

  // ---------------------------------------------------------------------------
  // Tool schema
  // ---------------------------------------------------------------------------

  /**
   * Return the tool specs to expose. Cloud gets the FULL cloud allowlist, always
   * — capability never depends on conversational state. (This used to be gated
   * by phase, which put the HP/condition/AoE tools in 1 of 5 phases and could
   * lock the DM out mid-fight; see docs/phase-removal.md.)
   *
   * Local (Ollama) still intersects with LOCAL_TOOLS: small models genuinely do
   * pick badly from a 48-tool schema, and that pressure is real only there.
   */
  private toolSpecs(provider: ProviderName): ToolSpec[] {
    const cloudList = CONFIG.cloudToolAllowlist;
    let allow: Set<string>;
    if (provider === "ollama") {
      const local = new Set(CONFIG.localToolAllowlist);
      allow = new Set(cloudList.filter((t) => local.has(t)));
    } else {
      allow = new Set(cloudList);
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
    this.llm.start(buildSystemPrompt(this.providerName), this.toolSpecs(this.providerName));
    this.started = true;
  }

  // ---------------------------------------------------------------------------
  // Choreography backbones
  // ---------------------------------------------------------------------------
  // Each runs a code-driven sequence of must-happen steps, calling the MCP
  // directly, so the ordering-critical bits (npcOnly initiative, turn hook,
  // cleanup sweep) can't be fumbled by the model. All write steps go through the
  // confirmation gate.
  //
  // They are BACKBONE-ONLY: none of them routes a turn to the model. handle()
  // always runs the DM's transcript afterwards, so invoking a backbone can never
  // swallow whatever else the DM said in the same breath.
  //
  // The old SCENE-SET macro is gone: it had no backbone at all (it only set the
  // phase and printed a banner), and its fuzzy trigger was the worst offender —
  // it hijacked ordinary mid-combat narration. See docs/phase-removal.md.

  /**
   * INIT-PREP macro backbone.
   * Fires when the DM calls for initiative.
   * 1. roll_initiative npcOnly=true clearFirst=false   (gated write)
   * 2. batch_exec nameplate reveal across NPCs          (gated write)
   * 3. plan_all_tactics                                 (gated write — may take time)
   * Player inits are NEVER touched.
   */
  async initPrep(cb: AgentCallbacks): Promise<void> {
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
    // Anchors the After-Action Review's "combat window" in the log (aar.ts).
    console.error("[agent] combat: begin");
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
    // Anchors the After-Action Review's "combat window" in the log (aar.ts).
    console.error("[agent] combat: end");
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

    // Steps 4–5 need a token list (aura targets + PC ids), so they're left to the
    // model. handle() appends CLEANUP_SWEEP to the DM's transcript rather than
    // running a turn here — that way the sweep happens AND anything else the DM
    // said in the same breath still reaches the model.
    if (cb.onCombatEnd) cb.onCombatEnd();
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

  /** Run one agent turn with the full cloud toolset + prompt. */
  private async runTurn(transcript: string, cb: AgentCallbacks): Promise<void> {
    // Per-turn provider: escalate complex narration to cloud Haiku (unless the
    // active provider is already cloud, or auto-escalate is off). The escalated
    // turn runs on a FRESH cloud provider seeded with just this transcript —
    // combat commands are self-contained, so we don't need local's history.
    const escalate = CONFIG.autoEscalate && this.providerName === "ollama" && looksComplex(transcript);
    let turnLlm = this.llm;
    if (escalate) {
      cb.onToolResult("↑escalate", "complex narration → cloud (haiku)");
      turnLlm = this.makeProvider("anthropic");
      turnLlm.start(buildSystemPrompt("anthropic"), this.toolSpecs("anthropic"));
      turnLlm.pushUser(buildTurnContext(this.roster) + "\n\n" + transcript);
    } else {
      this.ensureStarted();
      this.llm.repair();
      this.llm.pushUser(buildTurnContext(this.roster) + "\n\n" + transcript);
    }

    // Agentic-loop bookkeeping (see loop-policy.ts). Tracks whether the turn has
    // actually changed the table and whether we've already spent our one-shot
    // persistence re-prompts — so "done" becomes a structural decision, not silence.
    const mode = CONFIG.agenticLoop;
    let mutationsThisTurn = 0;
    let nudgedAlready = false;
    let completenessCheckedAlready = false;

    const turnStart = Date.now();
    // +2 headroom over the legacy 12 so the bounded one-shot nudges can't starve a
    // genuinely long tool chain.
    for (let step = 0; step < 14; step++) {
      const t0 = Date.now();
      const turn = await turnLlm.run();
      console.error(`[agent] step ${step} (${escalate ? "haiku" : this.providerName}) gen ${Date.now() - t0}ms (text:${turn.text.length} tools:${turn.toolCalls.length})`);
      // Suppress the bare DONE/NOACTION sentinel a nudge can elicit — it's a loop
      // control token, not a reply for the DM.
      if (turn.text && !isSentinel(turn.text)) cb.onText(turn.text);

      // Truncated mid-thought without a tool call → nudge and continue, so it
      // actually acts instead of ending on prose ("said firing, nothing happened").
      if (turn.truncated && turn.toolCalls.length === 0) {
        turnLlm.pushContinue("Continue — keep narration brief and call the tools now to carry out the plan.");
        continue;
      }
      if (turn.toolCalls.length === 0) {
        // Done, or one bounded re-prompt? The policy decides from what actually
        // happened this turn (mode "off" always returns done → legacy behaviour).
        const action = decideTerminal({ transcript, mutationsThisTurn, nudgedAlready, completenessCheckedAlready, mode });
        if (action.kind === "done") { console.error(`[agent] turn DONE ${Date.now() - turnStart}ms, ${step + 1} steps (mut=${mutationsThisTurn})`); return; }
        if (action.tag === "persist") nudgedAlready = true; else completenessCheckedAlready = true;
        console.error(`[agent] persist:${action.tag} — model stopped before work complete, re-prompting`);
        cb.onToolResult(`↻${action.tag}`, action.tag === "persist" ? "no table change — re-prompting" : "verifying all effects applied");
        turnLlm.pushContinue(action.text);
        continue;
      }

      const results: { id: string; name: string; content: string }[] = [];
      for (const call of turn.toolCalls) {
        cb.onToolStart(call.name, call.args);
        // Count any attempted state-changer (even one the DM cancels) as "the model
        // acted" — a cancelled write still means it didn't flake into pure prose.
        if (isMutatingTool(call.name)) mutationsThisTurn++;

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
      // -- Explicit DM commands --
      // Recognized ANYWHERE: there is no phase, so a command is never rejected
      // for being "in the wrong state". Each runs a tool backbone only; the DM's
      // transcript is ALWAYS routed to the model afterwards, so a command can
      // never swallow whatever else was said in the same breath.
      let extra = "";
      if (detectCombatOver(transcript)) {
        await this.cleanup(cb);
        extra = CLEANUP_SWEEP;
      } else if (detectBeginCombat(transcript)) {
        await this.beginCombat(cb);
      } else if (detectCallForInit(transcript)) {
        await this.initPrep(cb);
      }

      await this.runTurn(extra ? `${transcript}\n\n${extra}` : transcript, cb);
    } catch (e) {
      cb.onText("agent error: " + (e as Error).message);
    } finally {
      this.busy = false;
    }
  }
}
