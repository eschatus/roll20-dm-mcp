import http, { IncomingMessage } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

import { buildCombatServer } from "./server-combat.js";
import { onRtdbEvent, startRtdbSubscriptions } from "./bridge/roll20-rt.js";

// Long-running HTTP MCP server. One process owns the shared Playwright browser
// (via src/bridge/browser.ts singletons) and serves multiple clients — the Voice
// HUD app and Claude Code both connect here, so there's a single relay queue and
// no browser-lock conflict.
//
// Stateful sessions: each client's `initialize` mints a session + its own McpServer
// instance. All instances share the same browser/relay module singletons, so the
// tools behave identically regardless of which session calls them.

const PORT = Number(process.env.ROLL20_HTTP_PORT) || 39200;
const HOST = process.env.ROLL20_HTTP_HOST || "127.0.0.1";
const MAX_BODY_BYTES = 8 * 1024 * 1024;

// Shared-secret bearer token. Auto-generated on first run if not set.
function bootstrapToken(): string {
  const token = randomUUID();
  // Write to .env
  const envPath = resolve(ROOT, ".env");
  let envContent = "";
  try { envContent = readFileSync(envPath, "utf-8"); } catch {}
  if (!/^ROLL20_MCP_TOKEN=.+/m.test(envContent)) {
    if (envContent && !envContent.endsWith("\n")) envContent += "\n";
    writeFileSync(envPath, envContent + `ROLL20_MCP_TOKEN=${token}\n`, "utf-8");
  }
  // Inject the bearer header into .mcp.json so Claude Code picks it up on next restart.
  const mcpJsonPath = resolve(ROOT, ".mcp.json");
  try {
    const mcpJson = JSON.parse(readFileSync(mcpJsonPath, "utf-8"));
    if (mcpJson?.mcpServers?.["roll20-dm"]) {
      mcpJson.mcpServers["roll20-dm"].headers = { Authorization: `Bearer ${token}` };
      writeFileSync(mcpJsonPath, JSON.stringify(mcpJson, null, 2) + "\n", "utf-8");
    }
  } catch {}
  console.error(
    "\n[roll20-dm] First-time setup: ROLL20_MCP_TOKEN generated and saved to .env and .mcp.json.\n" +
    "[roll20-dm] Restart Claude Code to pick up the new header.\n",
  );
  process.env.ROLL20_MCP_TOKEN = token;
  return token;
}

const AUTH_TOKEN = process.env.ROLL20_MCP_TOKEN || bootstrapToken();
const AUTH_TOKEN_BUF = Buffer.from(AUTH_TOKEN, "utf8");

// DNS-rebinding protection allowlists. A malicious web page could otherwise point
// a victim's browser at http://127.0.0.1:39200 via a rebound DNS name; the MCP
// transport rejects requests whose Host/Origin aren't on these lists.
const ALLOWED_HOSTS = [
  `${HOST}:${PORT}`,
  `localhost:${PORT}`,
  `127.0.0.1:${PORT}`,
];
const ALLOWED_ORIGINS = [
  `http://${HOST}:${PORT}`,
  `http://localhost:${PORT}`,
  `http://127.0.0.1:${PORT}`,
];

// Constant-time bearer-token check. Guards the length mismatch up front because
// timingSafeEqual throws on unequal-length buffers.
function isAuthorized(req: IncomingMessage): boolean {
  const header = req.headers["authorization"];
  if (!header || Array.isArray(header)) return false;
  const m = /^Bearer (.+)$/.exec(header);
  if (!m) return false;
  const presented = Buffer.from(m[1], "utf8");
  if (presented.length !== AUTH_TOKEN_BUF.length) return false;
  return timingSafeEqual(presented, AUTH_TOKEN_BUF);
}

const transports: Record<string, StreamableHTTPServerTransport> = {};

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = "";
    let aborted = false;
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > MAX_BODY_BYTES) {
        aborted = true;
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (aborted) return;
      if (!data) return resolve(undefined);
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

const httpServer = http.createServer(async (req, res) => {
  if (!req.url) { res.writeHead(404).end("Not found"); return; }

  // SSE event stream for the gem HUD (RTDB push events for turn order, plans, inbox)
  if (req.url === "/events") {
    if (!isAuthorized(req)) { res.writeHead(401).end("Unauthorized"); return; }
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    });
    res.write(":\n\n"); // handshake comment

    const sendEvent = (name: string, data: unknown) => {
      try { res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* client gone */ }
    };
    const unsub = onRtdbEvent((e) => sendEvent(e.type, e));
    req.on("close", unsub);

    // Start RTDB subscriptions unconditionally — combat-update/plan/inbox events
    // are independent of the relay transport. rtEnabled() only gates the relay path.
    startRtdbSubscriptions().catch((e) =>
      sendEvent("error", { message: (e as Error).message })
    );
    return;
  }

  if (!req.url.startsWith("/mcp")) {
    res.writeHead(404).end("Not found");
    return;
  }

  // Bearer-token gate in front of all MCP handling.
  if (!isAuthorized(req)) {
    res
      .writeHead(401, {
        "Content-Type": "application/json",
        "WWW-Authenticate": "Bearer",
      })
      .end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32001, message: "Unauthorized" },
          id: null,
        }),
      );
    return;
  }

  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  try {
    if (req.method === "POST") {
      const body = await readJsonBody(req);
      let transport = sessionId ? transports[sessionId] : undefined;

      if (!transport) {
        if (!isInitializeRequest(body)) {
          res.writeHead(400, { "Content-Type": "application/json" }).end(
            JSON.stringify({
              jsonrpc: "2.0",
              error: { code: -32000, message: "Bad Request: no valid session ID provided" },
              id: null,
            }),
          );
          return;
        }

        // New session — create transport + a fresh server bound to it.
        const newTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          enableDnsRebindingProtection: true,
          allowedHosts: ALLOWED_HOSTS,
          allowedOrigins: ALLOWED_ORIGINS,
          onsessioninitialized: (sid) => {
            transports[sid] = newTransport;
          },
        });
        newTransport.onclose = () => {
          if (newTransport.sessionId) delete transports[newTransport.sessionId];
        };

        const server = buildCombatServer();
        await server.connect(newTransport);
        transport = newTransport;
      }

      await transport.handleRequest(req, res, body);
    } else if (req.method === "GET" || req.method === "DELETE") {
      // GET = open the server→client SSE stream; DELETE = terminate session.
      const transport = sessionId ? transports[sessionId] : undefined;
      if (!transport) {
        res.writeHead(400).end("Invalid or missing session ID");
        return;
      }
      await transport.handleRequest(req, res);
    } else {
      res.writeHead(405).end("Method not allowed");
    }
  } catch (err) {
    console.error("[roll20-dm http] request error:", err);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" }).end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        }),
      );
    }
  }
});

httpServer.listen(PORT, HOST, () => {
  // stderr so it never pollutes any stdio JSON-RPC consumer.
  console.error(`[roll20-dm http] MCP server listening on http://${HOST}:${PORT}/mcp`);
});
