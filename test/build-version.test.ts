import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { BUILD_VERSION } from "../src/build-version.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// BUILD_VERSION is compiled in (the packaged gem has no package.json beside the bundle), so it
// is a hand-synced copy of package.json's version. Lock them — a server that misreports its own
// build to callers is worse than one that says nothing, because the caller trusts it.
describe("BUILD_VERSION ↔ package.json version agree", () => {
  it("matches the version in package.json", () => {
    const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf-8")) as { version: string };
    expect(BUILD_VERSION).toBe(pkg.version);
  });

  it("is announced by both MCP servers, not a stale literal", () => {
    for (const f of ["src/server-combat.ts", "src/index-maps.ts"]) {
      const src = readFileSync(resolve(root, f), "utf-8");
      expect(src, `${f} must import BUILD_VERSION`).toMatch(/BUILD_VERSION/);
      expect(src, `${f} must not hardcode a version literal in the McpServer ctor`)
        .not.toMatch(/version:\s*["'][0-9]+\.[0-9]+\.[0-9]+["']/);
    }
  });
});
