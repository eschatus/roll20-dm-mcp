// Unit tests for campaignManager.ts — the result-shaping layer behind the Setup tab's Campaign
// picker/maker. Mocks McpLike (no Electron, no real MCP server) to cover: success, tool error, and
// "not connected" (the shape mcp.ts throws before connect() has succeeded).

import { describe, it, expect, vi } from "vitest";
import { listCampaigns, switchCampaign, registerCampaign, listDdbCampaigns, McpLike } from "../src/campaignManager";

function mockMcp(impl: (name: string, args: Record<string, unknown>) => Promise<string>): McpLike {
  return { call: vi.fn(impl) };
}

const NOT_CONNECTED = new Error("MCP client not connected");

describe("listCampaigns", () => {
  it("parses a successful JSON array response", async () => {
    const mcp = mockMcp(async () => JSON.stringify([
      { slug: "cos", name: "Curse of Strahd", active: true },
      { slug: "bp", name: "Beyond Phandelver", active: false },
    ]));
    const r = await listCampaigns(mcp);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data).toHaveLength(2);
      expect(r.data[0].slug).toBe("cos");
      expect(r.data[0].active).toBe(true);
    }
  });

  it("treats the friendly 'none registered' sentence as an empty list, not an error", async () => {
    const mcp = mockMcp(async () => "No campaigns registered yet. Use register_campaign to add one.");
    const r = await listCampaigns(mcp);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data).toEqual([]);
  });

  it("surfaces a readable message when the MCP client isn't connected", async () => {
    const mcp = mockMcp(async () => { throw NOT_CONNECTED; });
    const r = await listCampaigns(mcp);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/not connected/i);
  });

  it("surfaces a generic tool error verbatim", async () => {
    const mcp = mockMcp(async () => { throw new Error("relay timeout"); });
    const r = await listCampaigns(mcp);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("relay timeout");
  });
});

describe("switchCampaign", () => {
  it("calls switch_campaign with the given slug and returns it", async () => {
    const mcp = mockMcp(async (name, args) => {
      expect(name).toBe("switch_campaign");
      expect(args).toEqual({ slugOrName: "cos" });
      return `Active campaign set to "Curse of Strahd"`;
    });
    const r = await switchCampaign(mcp, "cos");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.slug).toBe("cos");
  });

  it("rejects an empty selection without calling MCP", async () => {
    const call = vi.fn();
    const r = await switchCampaign({ call }, "");
    expect(r.ok).toBe(false);
    expect(call).not.toHaveBeenCalled();
  });

  it("surfaces disconnected state readably", async () => {
    const mcp = mockMcp(async () => { throw NOT_CONNECTED; });
    const r = await switchCampaign(mcp, "cos");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/not connected/i);
  });
});

describe("registerCampaign", () => {
  it("extracts ids from full URLs, registers, then switches to the parsed slug", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const mcp = mockMcp(async (name, args) => {
      calls.push({ name, args });
      if (name === "register_campaign") return `Registered campaign "Test Camp" as slug "test-camp". Use switch_campaign("test-camp") to make it active.`;
      if (name === "switch_campaign") return `Active campaign set to "Test Camp"`;
      throw new Error(`unexpected tool: ${name}`);
    });
    const r = await registerCampaign(mcp, {
      name: "Test Camp",
      roll20: "https://app.roll20.net/campaigns/details/8675309/test-camp",
      ddb: "https://www.dndbeyond.com/campaigns/5201061",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.slug).toBe("test-camp");
    expect(calls[0]).toEqual({
      name: "register_campaign",
      args: { name: "Test Camp", roll20CampaignId: "8675309", ddbCampaignId: "5201061" },
    });
    expect(calls[1]).toEqual({ name: "switch_campaign", args: { slugOrName: "test-camp" } });
  });

  it("accepts bare numeric ids too", async () => {
    const mcp = mockMcp(async (name) => {
      if (name === "register_campaign") return `Registered campaign "X" as slug "x".`;
      return "ok";
    });
    const r = await registerCampaign(mcp, { name: "X", roll20: "111", ddb: "222" });
    expect(r.ok).toBe(true);
  });

  it("passes notes through when provided", async () => {
    let seenArgs: Record<string, unknown> | undefined;
    const mcp = mockMcp(async (name, args) => {
      if (name === "register_campaign") { seenArgs = args; return `Registered campaign "X" as slug "x".`; }
      return "ok";
    });
    await registerCampaign(mcp, { name: "X", roll20: "111", ddb: "222", notes: "  AL group 1  " });
    expect(seenArgs?.notes).toBe("AL group 1");
  });

  it("rejects an empty name before calling MCP", async () => {
    const call = vi.fn();
    const r = await registerCampaign({ call }, { name: "  ", roll20: "111", ddb: "222" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/name/i);
    expect(call).not.toHaveBeenCalled();
  });

  it("rejects an unparsable Roll20 id before calling MCP", async () => {
    const call = vi.fn();
    const r = await registerCampaign({ call }, { name: "X", roll20: "not a url", ddb: "222" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/roll20/i);
    expect(call).not.toHaveBeenCalled();
  });

  it("rejects an unparsable D&D Beyond id before calling MCP", async () => {
    const call = vi.fn();
    const r = await registerCampaign({ call }, { name: "X", roll20: "111", ddb: "garbage" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/d&d beyond/i);
    expect(call).not.toHaveBeenCalled();
  });

  it("fails soft if the slug can't be parsed out of the tool's reply", async () => {
    const mcp = mockMcp(async () => "something unexpected happened");
    const r = await registerCampaign(mcp, { name: "X", roll20: "111", ddb: "222" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/couldn't parse/i);
  });

  it("surfaces disconnected state readably", async () => {
    const mcp = mockMcp(async () => { throw NOT_CONNECTED; });
    const r = await registerCampaign(mcp, { name: "X", roll20: "111", ddb: "222" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/not connected/i);
  });
});

describe("listDdbCampaigns", () => {
  it("parses a successful JSON array response", async () => {
    const mcp = mockMcp(async () => JSON.stringify([{ id: "5201061", name: "Firebirds" }]));
    const r = await listDdbCampaigns(mcp);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data).toEqual([{ id: "5201061", name: "Firebirds" }]);
  });

  it("fails soft (readable error, no throw) when DDB isn't connected", async () => {
    const mcp = mockMcp(async () => { throw new Error("no CobaltSession cookie cached"); });
    const r = await listDdbCampaigns(mcp);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("no CobaltSession cookie cached");
  });

  it("surfaces disconnected MCP state readably", async () => {
    const mcp = mockMcp(async () => { throw NOT_CONNECTED; });
    const r = await listDdbCampaigns(mcp);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/not connected/i);
  });
});
