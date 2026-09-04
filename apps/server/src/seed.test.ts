import { BETA_V1_RULESET } from "@agentworld/game-rules";
import { describe, expect, it } from "vitest";
import {
  deriveSeasonSeed,
  resolveInstallationIdentity,
  seasonDurationMilliseconds,
} from "./seed.ts";

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

describe("resolveInstallationIdentity", () => {
  it("creates a fresh UUIDv7 identity only when no installation row exists", () => {
    const identity = resolveInstallationIdentity(undefined, "Local AgentWorld", () => "generated");
    expect(identity).toEqual({ id: "generated", name: "Local AgentWorld", change: "create" });
    const generated = resolveInstallationIdentity(undefined, "Local AgentWorld");
    expect(generated.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("keeps the persisted id when the configured name is unchanged", () => {
    const existing = { id: "0192f1a0-0000-7000-8000-000000000001", name: "AgentWorld" };
    expect(resolveInstallationIdentity(existing, "AgentWorld", () => "unused")).toEqual({
      ...existing,
      change: "keep",
    });
  });

  it("treats the name as mutable metadata and never mints a second identity on rename", () => {
    const existing = { id: "0192f1a0-0000-7000-8000-000000000001", name: "Local AgentWorld" };
    expect(resolveInstallationIdentity(existing, "Renamed World", () => "unused")).toEqual({
      id: existing.id,
      name: "Renamed World",
      change: "rename",
    });
  });

  it("does not depend on the name for two operators using the default name", () => {
    const first = resolveInstallationIdentity(undefined, "Local AgentWorld");
    const second = resolveInstallationIdentity(undefined, "Local AgentWorld");
    expect(first.id).not.toBe(second.id);
  });
});

describe("seasonDurationMilliseconds", () => {
  it("converts the beta ruleset exactly", () => {
    expect(seasonDurationMilliseconds(BETA_V1_RULESET)).toBe(2_419_200_000);
    expect(seasonDurationMilliseconds({ ticksPerSecond: 4, season: { durationTicks: 10 } })).toBe(
      2_500,
    );
  });

  it("rejects durations that would round when expressed in milliseconds", () => {
    expect(() =>
      seasonDurationMilliseconds({ ticksPerSecond: 3, season: { durationTicks: 10 } }),
    ).toThrow(/exactly representable/);
    expect(() =>
      seasonDurationMilliseconds({ ticksPerSecond: 1, season: { durationTicks: 0 } }),
    ).toThrow(/exactly representable/);
    expect(() =>
      seasonDurationMilliseconds({
        ticksPerSecond: 1,
        season: { durationTicks: Number.MAX_SAFE_INTEGER },
      }),
    ).toThrow(/exactly representable/);
  });
});
