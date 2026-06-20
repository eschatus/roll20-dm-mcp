import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    setupFiles: ["./test/setup.ts"],
    // Run test files sequentially. The integration suites share file-based registries under
    // .tmp-test-data/w<pid>; serializing avoids cross-file worker-state races (e.g. combat-round's
    // PC-attribute read resolving against another file's registry write).
    fileParallelism: false,
  },
});
