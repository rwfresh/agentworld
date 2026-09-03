import { describe, expect, it } from "vitest";
import { deriveSeasonSeed } from "./seed.ts";

describe("season seed custody", () => {
  it("cannot be derived from public installation, world, season, and ruleset identifiers", () => {
    const publicInputs = ["installation-id", "world-id", 1, "beta-v1"] as const;
    const first = deriveSeasonSeed("private-season-secret-one-32-bytes-minimum", ...publicInputs);
    const second = deriveSeasonSeed("private-season-secret-two-32-bytes-minimum", ...publicInputs);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(first).not.toBe(second);
    expect(first).not.toContain(publicInputs[1]);
    expect(first).not.toBe(`${publicInputs[3]}-${publicInputs[1]}`);
  });
});
