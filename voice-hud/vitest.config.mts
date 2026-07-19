import { defineConfig } from "vitest/config";

// voice-hud has its own build (not in the root CI). These tests run offline with
// deterministic fakes — no Electron, no live MCP, no model calls.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
