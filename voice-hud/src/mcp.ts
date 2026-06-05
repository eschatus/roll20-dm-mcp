// MCP client — connects to the long-running roll20-dm HTTP server (Component A)
// and exposes its tools to the agent loop. One server instance owns the shared
// Playwright browser, so the HUD and Claude Code can both drive Roll20.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CONFIG } from "./config";

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export class McpRoll20 {
  private client: Client | null = null;
  private tools: McpTool[] = [];

  async connect(): Promise<McpTool[]> {
    const token = process.env.ROLL20_MCP_TOKEN || "";
    const transport = new StreamableHTTPClientTransport(new URL(CONFIG.mcpUrl), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });
    this.client = new Client({ name: "dm-whisper-hud", version: "0.1.0" }, { capabilities: {} });
    await this.client.connect(transport);
    const list = await this.client.listTools();
    this.tools = list.tools.map((t) => ({
      name: t.name,
      description: t.description ?? "",
      inputSchema: t.inputSchema as Record<string, unknown>,
    }));
    return this.tools;
  }

  getTools(): McpTool[] {
    return this.tools;
  }

  // Convert MCP tool list into Anthropic tool-use schema.
  toAnthropicTools() {
    return this.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as { type: "object"; properties?: Record<string, unknown> },
    }));
  }

  // Convert MCP tool list into OpenAI-compatible tool schema (used by Ollama).
  toOpenAITools() {
    return this.tools.map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: (t.inputSchema && Object.keys(t.inputSchema).length
          ? t.inputSchema
          : { type: "object", properties: {} }) as Record<string, unknown>,
      },
    }));
  }

  async call(name: string, args: Record<string, unknown>): Promise<string> {
    if (!this.client) throw new Error("MCP client not connected");
    const res = await this.client.callTool({ name, arguments: args });
    // Flatten text content blocks into a single string for the model.
    const content = (res.content ?? []) as Array<{ type: string; text?: string }>;
    return content.filter((c) => c.type === "text").map((c) => c.text).join("\n") || "(no output)";
  }

  async close() {
    await this.client?.close();
    this.client = null;
  }
}
