import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/integration/**/*.test.ts"],
    fileParallelism: false,
    maxWorkers: 1,
    restoreMocks: true,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
