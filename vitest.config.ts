import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    setupFiles: ["./test/setup.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "text", "html"],
      include: ["src/**/*.ts"],
      // Exclude what v8 can't or shouldn't measure in-process:
      // - test files themselves
      // - recon/* are manual live scripts (excluded from the prod build)
      // - index-*.ts are thin transport/bootstrap entrypoints
      // NOTE: mod-scripts/ai-relay.js is loaded into a vm by the emulator, so v8
      // does not instrument it — its breadth is tracked by test/relay-actions.
      exclude: ["src/**/*.test.ts", "src/recon/**", "src/index-*.ts"],
    },
  },
});
