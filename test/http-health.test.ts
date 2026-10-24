import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import { handleHealth } from "../src/http-health.js";
import { BUILD_VERSION } from "../src/build-version.js";
import * as roll20 from "../src/bridge/roll20.js";

// GET /health (#247): lets a client compare the server's data dir with its own to catch a
// split-brain reuse. Bearer-gated like /mcp and /events; pure local info, no relay call.
const TOKEN = "test-token";
let server: http.Server;
let base: string;
const savedDir = process.env.ROLL20_DATA_DIR;

const authorized = (req: http.IncomingMessage) => req.headers.authorization === `Bearer ${TOKEN}`;
const auth = { Authorization: `Bearer ${TOKEN}` };

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (!handleHealth(req, res, authorized)) res.writeHead(404).end("Not found");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.close();
  if (savedDir === undefined) delete process.env.ROLL20_DATA_DIR;
  else process.env.ROLL20_DATA_DIR = savedDir;
});

describe("GET /health", () => {
  it("returns ok, version and the resolved ROLL20_DATA_DIR with a valid bearer", async () => {
    process.env.ROLL20_DATA_DIR = "./some/relative/dir";
    const r = await fetch(`${base}/health`, { headers: auth });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("application/json");
    expect(await r.json()).toEqual({
      ok: true,
      version: BUILD_VERSION,
      dataDir: path.resolve("./some/relative/dir"),
    });
  });

  it("resolves per request, so a changed env is honoured", async () => {
    process.env.ROLL20_DATA_DIR = "./other";
    const r = await fetch(`${base}/health`, { headers: auth });
    expect(((await r.json()) as { dataDir: string }).dataDir).toBe(path.resolve("./other"));
  });

  it("rejects a missing or wrong bearer with 401 and leaks no path", async () => {
    process.env.ROLL20_DATA_DIR = "./secret-dir";
    for (const headers of [{}, { Authorization: "Bearer nope" }] as Record<string, string>[]) {
      const r = await fetch(`${base}/health`, { headers });
      expect(r.status).toBe(401);
      expect(await r.text()).not.toContain("secret-dir");
    }
  });

  it("ignores a query string and rejects non-GET with 405", async () => {
    expect((await fetch(`${base}/health?x=1`, { headers: auth })).status).toBe(200);
    expect((await fetch(`${base}/health`, { method: "POST", headers: auth })).status).toBe(405);
  });

  it("does not claim other paths", async () => {
    expect((await fetch(`${base}/healthz`, { headers: auth })).status).toBe(404);
  });

  it("makes no relay call", async () => {
    const spy = vi.spyOn(roll20, "relayCommand");
    await fetch(`${base}/health`, { headers: auth });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
