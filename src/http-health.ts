import type { IncomingMessage, ServerResponse } from "node:http";
import { dataDir } from "./dataDir.js";
import { BUILD_VERSION } from "./build-version.js";

// GET /health (#247). Tells a client which data dir (ROLL20_DATA_DIR -> dataDir()) this server
// reads its credentials and state from. The gem reuses whatever already listens on :39200, so
// a stale dev server with a different data dir silently split-brained token harvesting from
// token reading; a TCP probe can't see that, this can.
//
// Pure local info: no Roll20, no RT, no relay call. Kept out of index-http.ts (which listens on
// import) so it is testable. Contract with another repo: keep the shape small and stable.
//
// Returns true when it handled the request (any status), false when the path isn't /health.
export function handleHealth(
  req: IncomingMessage,
  res: ServerResponse,
  isAuthorized: (req: IncomingMessage) => boolean,
): boolean {
  const pathname = (req.url ?? "").split("?")[0];
  if (pathname !== "/health") return false;
  // Same bearer gate as /mcp and /events: the path reveals the local username.
  if (!isAuthorized(req)) {
    res.writeHead(401, { "WWW-Authenticate": "Bearer" }).end("Unauthorized");
    return true;
  }
  if (req.method !== "GET") {
    res.writeHead(405, { Allow: "GET" }).end("Method not allowed");
    return true;
  }
  res
    .writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" })
    .end(JSON.stringify({ ok: true, version: BUILD_VERSION, dataDir: dataDir() }));
  return true;
}
