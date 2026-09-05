import { describe, expect, it } from "vitest";

import { hostilityWindowState, tick } from "../src/index.ts";

/** beta-v1's windows: the aggressor waits 900 ticks, the defender keeps 900 ticks after a withdrawal. */
const beta = { hostilityWarmupTicks: 900, retaliationAfterWithdrawalTicks: 900 };

describe("hostilityWindowState", () => {
  it("leaves warmup exactly when the engine lets the aggressor attack", () => {
    expect(hostilityWindowState(tick(100), undefined, tick(100), beta)).toBe("warmup");
    expect(hostilityWindowState(tick(100), undefined, tick(999), beta)).toBe("warmup");
    expect(hostilityWindowState(tick(100), undefined, tick(1_000), beta)).toBe("active");
    expect(hostilityWindowState(tick(100), undefined, tick(50_000), beta)).toBe("active");
  });

  it("keeps the retaliation window open through its final tick and then ends", () => {
    expect(hostilityWindowState(tick(100), tick(1_500), tick(1_500), beta)).toBe(
      "retaliation_window",
    );
    expect(hostilityWindowState(tick(100), tick(1_500), tick(2_400), beta)).toBe(
      "retaliation_window",
    );
    expect(hostilityWindowState(tick(100), tick(1_500), tick(2_401), beta)).toBe("ended");
  });

  it("never reports a withdrawn gap when the windows are equal", () => {
    // Withdrawn during warmup: the retaliation window closes no earlier than the warmup elapses.
    expect(hostilityWindowState(tick(100), tick(110), tick(1_000), beta)).toBe(
      "retaliation_window",
    );
    expect(hostilityWindowState(tick(100), tick(110), tick(1_010), beta)).toBe(
      "retaliation_window",
    );
    expect(hostilityWindowState(tick(100), tick(110), tick(1_011), beta)).toBe("ended");
  });

  it("stays withdrawn while the original warmup still binds the aggressor", () => {
    const longWarmup = { hostilityWarmupTicks: 1_800, retaliationAfterWithdrawalTicks: 900 };
    expect(hostilityWindowState(tick(0), tick(10), tick(910), longWarmup)).toBe(
      "retaliation_window",
    );
    expect(hostilityWindowState(tick(0), tick(10), tick(911), longWarmup)).toBe("withdrawn");
    expect(hostilityWindowState(tick(0), tick(10), tick(1_799), longWarmup)).toBe("withdrawn");
    expect(hostilityWindowState(tick(0), tick(10), tick(1_800), longWarmup)).toBe("ended");
  });
});
