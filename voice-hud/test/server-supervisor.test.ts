import { describe, it, expect, vi, afterEach } from "vitest";

// serverSupervisor imports electron's `app`; mock it so the module loads under vitest.
vi.mock("electron", () => ({ app: { isPackaged: false } }));

import * as net from "net";
import { shouldSupervise, portUp, buildServerSpawn } from "../src/serverSupervisor";

const norm = (p: string) => p.replace(/\\/g, "/");

describe("shouldSupervise", () => {
  const orig = process.env.DMW_SUPERVISE_SERVER;
  afterEach(() => {
    if (orig === undefined) delete process.env.DMW_SUPERVISE_SERVER;
    else process.env.DMW_SUPERVISE_SERVER = orig;
  });
  it("is OFF in dev (not packaged, env unset) — external server owns it", () => {
    delete process.env.DMW_SUPERVISE_SERVER;
    expect(shouldSupervise()).toBe(false);
  });
  it("is ON with DMW_SUPERVISE_SERVER=1", () => {
    process.env.DMW_SUPERVISE_SERVER = "1";
    expect(shouldSupervise()).toBe(true);
  });
});

describe("portUp (TCP liveness probe)", () => {
  it("true when a server is listening, false once it's closed", async () => {
    const srv = net.createServer();
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    const port = (srv.address() as net.AddressInfo).port;
    expect(await portUp(port)).toBe(true);
    await new Promise<void>((r) => srv.close(() => r()));
    expect(await portUp(port)).toBe(false);
  });
});

describe("buildServerSpawn", () => {
  it("dev → repo dist/index-http.js, cwd repo root", () => {
    const { entry, cwd } = buildServerSpawn(false, "/res", "/repo");
    expect(norm(entry)).toBe("/repo/dist/index-http.js");
    expect(norm(cwd)).toBe("/repo");
  });
  it("packaged → bundled resources/server/dist/index-http.js", () => {
    const { entry, cwd } = buildServerSpawn(true, "/res", "/repo");
    expect(norm(entry)).toBe("/res/server/dist/index-http.mjs");
    expect(norm(cwd)).toBe("/res/server");
  });
});
