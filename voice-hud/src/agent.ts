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

  private ensureStarted(): void {
    if (this.started) return;
    // Local (small) models choke on the full 60-tool schema (~9.9k tokens), so
    // filter to the live-combat allow-list. Cloud Claude gets everything.
    const allow = this.providerName === "ollama" ? new Set(CONFIG.localToolAllowlist) : null;
    const tools: ToolSpec[] = this.mcp.getTools()
      .filter((t) => !allow || allow.has(t.name))
      .map((t) => ({
        name: t.name,
        description: t.description,
        parameters: (t.inputSchema && Object.keys(t.inputSchema).length
          ? t.inputSchema
          : { type: "object", properties: {} }) as Record<string, unknown>,
      }));
    this.llm.start(buildSystemPrompt(this.roster, this.providerName), tools);
    this.started = true;
  }

  async handle(transcript: string, cb: AgentCallbacks): Promise<void> {
    if (this.busy) {
      cb.onText("(still working — finish or confirm/cancel the current action first)");
      return;
    }
    this.busy = true;
    try {
      this.ensureStarted();
      this.llm.repair();
      this.llm.pushUser(transcript);

      const turnStart = Date.now();
      for (let step = 0; step < 12; step++) {
        const t0 = Date.now();
        const turn = await this.llm.run();
        console.error(`[agent] step ${step} gen ${Date.now() - t0}ms (text:${turn.text.length} tools:${turn.toolCalls.length})`);
        if (turn.text) cb.onText(turn.text);

        // Truncated mid-thought without a tool call → nudge and continue, so it
        // actually acts instead of ending on prose ("said firing, nothing happened").
        if (turn.truncated && turn.toolCalls.length === 0) {
          this.llm.pushContinue("Continue — keep narration brief and call the tools now to carry out the plan.");
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
        this.llm.pushToolResults(results);
      }
      cb.onText("(stopped after too many tool steps)");
    } catch (e) {
      cb.onText("agent error: " + (e as Error).message);
    } finally {
      this.busy = false;
    }
  }
}
