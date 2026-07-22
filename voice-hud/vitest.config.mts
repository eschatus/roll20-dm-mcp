import { defineConfig } from "vitest/config";

// voice-hud has its own build (not in the root CI). These tests run offline with
// deterministic fakes — no Electron, no live MCP, no model calls.
//
// Two projects: the existing node suite (agent/STT logic) and a jsdom suite for the
// renderer's pure helpers (they touch WAV/typed-array/DOM-adjacent code).
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "node",
          include: ["test/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        test: {
          name: "renderer",
          include: ["renderer/**/*.test.{ts,js}"],
          environment: "jsdom",
        },
      },
    ],
  },
});
