// Unit tests for the native-Ollama provider (/api/chat) — no live Ollama needed,
// fetch is stubbed. Covers: request shaping (format = tool schema, options.num_ctx
// actually sent), the schema→format constrained-args path, and the "degrade
// safely" fallback when the constrained re-ask fails.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OllamaNativeProvider, resetConstrainWarningLatch } from "../src/llm/ollama-native";
import { ToolSpec } from "../src/llm/provider";

const TOOLS: ToolSpec[] = [
  {
    name: "update_token_hp",
    description: "Update a token's HP.",
    parameters: {
      type: "object",
      properties: { characterName: { type: "string" }, damage: { type: "number" } },
      required: ["characterName", "damage"],
    },
  },
];

function jsonResponse(body: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

describe("OllamaNativeProvider", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    resetConstrainWarningLatch();
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    delete process.env.DMW_CONSTRAIN_TOOLS;
    delete process.env.DMW_OLLAMA_NUM_CTX;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.DMW_CONSTRAIN_TOOLS;
    delete process.env.DMW_OLLAMA_NUM_CTX;
  });

  it("posts to /api/chat with options.num_ctx (unlike the /v1 shim, this actually takes effect)", async () => {
    process.env.DMW_OLLAMA_NUM_CTX = "16384";
    fetchMock.mockResolvedValueOnce(jsonResponse({
      message: { role: "assistant", content: "hi there" },
      done_reason: "stop",
    }));

    const p = new OllamaNativeProvider("qwen2.5-7b-16k", "http://127.0.0.1:11434");
    p.start("sys prompt", TOOLS);
    p.pushUser("hello");
    const turn = await p.run();

    expect(turn.text).toBe("hi there");
    expect(turn.toolCalls).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:11434/api/chat");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.options.num_ctx).toBe(16384);
    expect(body.tools).toHaveLength(1);
    expect(body.tools[0].function.name).toBe("update_token_hp");
  });

  it("parses stringified tool-call arguments (defensive — native ollama already returns objects)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      message: {
        role: "assistant", content: "",
        tool_calls: [{ id: "call_1", function: { name: "update_token_hp", arguments: '{"characterName":"Ogre","damage":10}' } }],
      },
      done_reason: "stop",
    }));

    const p = new OllamaNativeProvider("qwen2.5-7b-16k", "http://127.0.0.1:11434");
    p.start("sys", TOOLS);
    p.pushUser("the ogre takes 10");
    const turn = await p.run();

    expect(turn.toolCalls).toEqual([{ id: "call_1", name: "update_token_hp", args: { characterName: "Ogre", damage: 10 } }]);
    expect(fetchMock).toHaveBeenCalledTimes(1); // no second (constrain) call when the flag is off
  });

  describe("DMW_CONSTRAIN_TOOLS=1 — schema→format constrained arg re-ask", () => {
    beforeEach(() => { process.env.DMW_CONSTRAIN_TOOLS = "1"; });

    it("re-asks with format = the called tool's inputSchema and splices in the constrained args", async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ // stage 1: draft call with a mangled arg (string damage)
          message: {
            role: "assistant", content: "",
            tool_calls: [{ id: "call_1", function: { name: "update_token_hp", arguments: { characterName: "ogre", damage: "10" } } }],
          },
          done_reason: "stop",
        }))
        .mockResolvedValueOnce(jsonResponse({ // stage 2: constrained re-ask returns valid JSON
          message: { role: "assistant", content: '{"characterName":"Ogre","damage":10}' },
          done_reason: "stop",
        }));

      const p = new OllamaNativeProvider("qwen2.5-7b-16k", "http://127.0.0.1:11434");
      p.start("sys", TOOLS);
      p.pushUser("the ogre takes 10 damage");
      const turn = await p.run();

      expect(turn.toolCalls).toEqual([{ id: "call_1", name: "update_token_hp", args: { characterName: "Ogre", damage: 10 } }]);
      expect(fetchMock).toHaveBeenCalledTimes(2);

      const stage2Body = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string);
      expect(stage2Body.format).toEqual(TOOLS[0].parameters);
      expect(stage2Body.tools).toBeUndefined(); // stage 2 is a plain completion, not another tool decision
    });

    it("degrades to the stage-1 draft args and logs once if the constrained re-ask errors", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      fetchMock
        .mockResolvedValueOnce(jsonResponse({
          message: {
            role: "assistant", content: "",
            tool_calls: [{ id: "call_1", function: { name: "update_token_hp", arguments: { characterName: "Ogre", damage: 10 } } }],
          },
          done_reason: "stop",
        }))
        .mockResolvedValueOnce(jsonResponse({ error: "format not supported" }, false, 400));

      const p = new OllamaNativeProvider("qwen2.5-7b-16k", "http://127.0.0.1:11434");
      p.start("sys", TOOLS);
      p.pushUser("the ogre takes 10 damage");
      const turn = await p.run();

      // Fell back to the unconstrained stage-1 args rather than dropping the call.
      expect(turn.toolCalls).toEqual([{ id: "call_1", name: "update_token_hp", args: { characterName: "Ogre", damage: 10 } }]);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      warnSpy.mockRestore();
    });

    it("logs the fallback warning only once across multiple failing turns", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const draftTurn = () => jsonResponse({
        message: {
          role: "assistant", content: "",
          tool_calls: [{ id: "call_x", function: { name: "update_token_hp", arguments: { characterName: "Ogre", damage: 5 } } }],
        },
        done_reason: "stop",
      });
      fetchMock
        .mockResolvedValueOnce(draftTurn())
        .mockResolvedValueOnce(jsonResponse({ error: "nope" }, false, 400))
        .mockResolvedValueOnce(draftTurn())
        .mockResolvedValueOnce(jsonResponse({ error: "nope" }, false, 400));

      const p = new OllamaNativeProvider("qwen2.5-7b-16k", "http://127.0.0.1:11434");
      p.start("sys", TOOLS);
      p.pushUser("first");
      await p.run();
      p.pushUser("second");
      await p.run();

      expect(warnSpy).toHaveBeenCalledTimes(1);
      warnSpy.mockRestore();
    });

    it("does not attempt to constrain a tool call with no matching schema (unknown tool)", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({
        message: {
          role: "assistant", content: "",
          tool_calls: [{ id: "call_1", function: { name: "some_unlisted_tool", arguments: { a: 1 } } }],
        },
        done_reason: "stop",
      }));

      const p = new OllamaNativeProvider("qwen2.5-7b-16k", "http://127.0.0.1:11434");
      p.start("sys", TOOLS); // TOOLS doesn't include some_unlisted_tool
      p.pushUser("hi");
      const turn = await p.run();

      expect(turn.toolCalls).toEqual([{ id: "call_1", name: "some_unlisted_tool", args: { a: 1 } }]);
      expect(fetchMock).toHaveBeenCalledTimes(1); // no stage-2 call fired
    });
  });

  it("reports truncated turns from done_reason=length", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ message: { role: "assistant", content: "cut off" }, done_reason: "length" }));
    const p = new OllamaNativeProvider("qwen2.5-7b-16k", "http://127.0.0.1:11434");
    p.start("sys", TOOLS);
    p.pushUser("hi");
    const turn = await p.run();
    expect(turn.truncated).toBe(true);
  });
});
