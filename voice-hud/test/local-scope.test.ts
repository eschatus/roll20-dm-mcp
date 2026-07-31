// Train/serve parity is keyed on the MODEL, not the provider.
//
// The scope trim + slimmed descriptions exist because the fine-tuned specialist
// (dmw-*) was trained on exactly that catalog. A stock local model never saw it, so it
// must keep the full local allowlist and the verbose anti- -32602 descriptions.
// And whatever catalog is served, the system prompt must advertise the same tools —
// a prompt that names a tool absent from the schema buys the DM a tool error.

import { describe, it, expect, afterEach } from "vitest";
import { DmAgent, isTrainedSpecialist } from "../src/agent";
import { CONFIG } from "../src/config";
import { FakeMcp, FakeProvider, fakeFactory, recordingCallbacks } from "./fakes";
import type { LLMTurn, ToolSpec } from "../src/llm";

/** FakeProvider that keeps what it was started with. */
class CapturingProvider extends FakeProvider {
  system = "";
  tools: ToolSpec[] = [];
  override start(system: string, tools: ToolSpec[]): void {
    this.system = system;
    this.tools = tools;
  }
}

const CATALOG = [...CONFIG.localToolAllowlist].map((name) => ({
  name,
  description: `Do ${name}. Damage is a bare NUMBER — damage:39, never damage:"39".`,
  inputSchema: { type: "object", properties: {} },
}));

async function serve(model: string): Promise<CapturingProvider> {
  CONFIG.ollamaModel = model;
  const provider = new CapturingProvider([] as LLMTurn[]);
  const agent = new DmAgent(new FakeMcp(CATALOG), "ollama", fakeFactory(provider));
  await agent.handle("who's hurt?", recordingCallbacks());
  return provider;
}

const ORIGINAL_MODEL = CONFIG.ollamaModel;
afterEach(() => { CONFIG.ollamaModel = ORIGINAL_MODEL; });

describe("isTrainedSpecialist", () => {
  it("recognizes the in-house fine-tunes only", () => {
    expect(isTrainedSpecialist("dmw-7b-v2")).toBe(true);
    expect(isTrainedSpecialist("dmw-7b-v2:latest")).toBe(true);
    expect(isTrainedSpecialist("qwen2.5:7b-instruct")).toBe(false);
    expect(isTrainedSpecialist("llama3.1:8b")).toBe(false);
  });
});

describe("local tool scope", () => {
  it("serves the specialist the trained scope, slimmed", async () => {
    const p = await serve("dmw-7b-v2");
    const names = p.tools.map((t) => t.name);
    expect(names).not.toContain("get_recent_chat");
    expect(names).not.toContain("whisper_player");
    expect(names).toContain("update_token_hp");
    expect(p.tools[0].description).not.toMatch(/never damage/i);
  });

  it("leaves the stock local model the full local catalog at full verbosity", async () => {
    const p = await serve("qwen2.5:7b-instruct");
    const names = p.tools.map((t) => t.name);
    expect(names).toContain("get_recent_chat");
    expect(names).toContain("whisper_player");
    expect(p.tools[0].description).toMatch(/never damage/i);
  });
});

describe("prompt matches the served catalog", () => {
  it("does not advertise tools the specialist is not served", async () => {
    const p = await serve("dmw-7b-v2");
    expect(p.system).not.toMatch(/get_recent_chat|whisper_player/);
  });

  it("still advertises them to the stock local model, which is served them", async () => {
    const p = await serve("qwen2.5:7b-instruct");
    expect(p.system).toMatch(/get_recent_chat/);
    expect(p.system).toMatch(/whisper_player/);
  });
});
