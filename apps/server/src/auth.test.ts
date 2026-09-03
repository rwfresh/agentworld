import { describe, expect, it } from "vitest";
import { canonicalAuthRequestUrl } from "./auth.ts";

describe("auth request forwarding", () => {
  it("uses the configured public origin and preserves the request path", () => {
    const url = canonicalAuthRequestUrl(
      "https://agentworld.example",
      "/api/auth/get-session?returning=true",
    );
    expect(url.href).toBe("https://agentworld.example/api/auth/get-session?returning=true");
  });

  it("rejects an absolute request target on another origin", () => {
    expect(() =>
      canonicalAuthRequestUrl("https://agentworld.example", "https://attacker.invalid/steal"),
    ).toThrow(/invalid/);
  });
});
