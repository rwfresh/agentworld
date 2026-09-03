import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
    },
    include: ["{apps,packages}/**/*.test.ts"],
    passWithNoTests: false,
    restoreMocks: true,
    testTimeout: 15_000,
  },
});
