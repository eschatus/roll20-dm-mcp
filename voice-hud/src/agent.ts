// Agent loop — turns a transcript into reasoning + Roll20 tool calls.
//
// Provider-agnostic: it drives an LLMProvider (Ollama, Anthropic, …) through the
// polymorphic interface and knows nothing about any specific backend. Read-only
// tools run immediately; write tools are gated via onProposeWrite. Turns are
// serialized so concurrent utterances can't corrupt provider history.

import { McpRoll20 } from "./mcp";
import { buildSystemPrompt } from "./persona";
import { createProvider, LLMProvider, ToolSpec, ProviderName } from "./llm";
import { CONFIG } from "./config";

// Tools that mutate the live tabletop — these require DM confirmation.
const WRITE_TOOLS = new Set<string>([
  "apply_damage", "heal_character", "update_token_hp", "set_token_marker",
  "set_token_props", "set_character_attribute", "full_sync_character",
  "sync_character_state", "ddb_update_hp", "batch_exec", "send_narration",
  "roll_dice", "roll_initiative", "advance_turn", "clear_turn_order",
  "update_turn_order", "inject_round_marker", "create_zone", "clear_zone",
  "remove_object", "set_turn_hook", "whisper_player", "create_handout",
  "create_character_stub", "set_journal_folder", "upload_image",
]);

export interface AgentCallbacks {
  onText: (text: string) => void;
  onToolStart: (name: string, args: unknown) => void;
  onToolResult: (name: string, result: string) => void;
  onProposeWrite: (name: string, args: Record<string, unknown>) => Promise<boolean>;
}

export class DmAgent {
  private llm: LLMProvider;
  private providerName: ProviderName;
  private roster = "";
  private started = false;
  private busy = false;

  constructor(private mcp: McpRoll20, initial?: ProviderName) {
    this.providerName = initial ?? CONFIG.provider;
    this.llm = createProvider(this.providerName);
  }

  currentProvider(): ProviderName { return this.providerName; }

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
    if (this.started) this.llm.setSystem(buildSystemPrompt(this.roster, this.providerName));
  }
  reset() { this.llm.reset(); this.started = false; this.busy = false; }
  isBusy() { return this.busy; }

  // Tool schema for a provider. Both providers get a stripped live-combat
  // allow-list (the full 61-tool schema is ~10k tokens — it tanks the 7B's tool
  // selection and was a real chunk of cloud turn latency). Local gets the lean
  // primitives-only set; cloud gets that plus the heavier combat tools (batch,
  // DDB-syncing HP, turn-order). Neither sees vision/map/prep tools.
  private toolSpecs(provider: ProviderName): ToolSpec[] {
    const allow = new Set(provider === "ollama" ? CONFIG.localToolAllowlist : CONFIG.cloudToolAllowlist);
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
    this.llm.start(buildSystemPrompt(this.roster, this.providerName), this.toolSpecs(this.providerName));
    this.started = true;
  }

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

  async handle(transcript: string, cb: AgentCallbacks): Promise<void> {
    if (this.busy) {
      cb.onText("(still working — finish or confirm/cancel the current action first)");
      return;
    }
    this.busy = true;
    try {
      // Per-turn provider: escalate complex narration to cloud Haiku (unless the
      // active provider is already cloud, or auto-escalate is off). The escalated
      // turn runs on a FRESH cloud provider seeded with just this transcript —
      // combat commands are self-contained, so we don't need local's history.
      const escalate = CONFIG.autoEscalate && this.providerName === "ollama" && this.looksComplex(transcript);
      let turnLlm = this.llm;
      if (escalate) {
        cb.onToolResult("↑escalate", "complex narration → cloud (haiku)");
        turnLlm = createProvider("anthropic");
        turnLlm.start(buildSystemPrompt(this.roster, "anthropic"), this.toolSpecs("anthropic"));
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
    } catch (e) {
      cb.onText("agent error: " + (e as Error).message);
    } finally {
      this.busy = false;
    }
  }
}
