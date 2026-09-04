import { createHash, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createEmailDigester,
  generateInvitationCode,
  invitationHash,
  legacyEmailHash,
  normalizeEmail,
  normalizeInvitationCode,
} from "./invitation-code.ts";

const authSecret = "unit-test-auth-secret-with-at-least-32-characters";
const rotatedSecret = "rotated-unit-test-auth-secret-32-characters-long";
const normalizedEmail = "player@example.com";

describe("invitation codes", () => {
  it("normalizes user input before hashing", () => {
    const canonical = "AW-2345-6789-ABCD-EFGH-JKLM-NPQR";
    expect(normalizeInvitationCode(`  ${canonical.toLowerCase()}  `)).toBe(canonical);
    expect(invitationHash(`  ${canonical.toLowerCase()}  `)).toBe(invitationHash(canonical));
  });

  it("generates a grouped code with 120 bits of random symbol input", () => {
    const code = generateInvitationCode((size) => {
      expect(size).toBe(24);
      return Uint8Array.from({ length: size }, (_, index) => index);
    });
    expect(code).toBe("AW-2345-6789-ABCD-EFGH-JKLM-NPQR");
  });

  it("normalizes email addresses used for reservations", () => {
    expect(normalizeEmail("  PLAYER@Example.COM  ")).toBe("player@example.com");
  });
});

describe("reservation email digests", () => {
  it("uses HMAC-SHA-256 under a key derived from the auth secret with a fixed label", () => {
    const key = createHmac("sha256", authSecret)
      .update("agentworld:invitation-reservation:v1")
      .digest();
    const expected = createHmac("sha256", key).update(normalizedEmail).digest("hex");
    const digest = createEmailDigester(authSecret)("  PLAYER@Example.COM  ");
    expect(digest.current).toBe(expected);
    expect(digest.current).toMatch(/^[0-9a-f]{64}$/);
    // The secret itself never keys a digest.
    expect(digest.current).not.toBe(
      createHmac("sha256", authSecret).update(normalizedEmail).digest("hex"),
    );
  });

  it("is deterministic for one secret and differs across secrets and addresses", () => {
    const digest = createEmailDigester(authSecret);
    const rotated = createEmailDigester(rotatedSecret);
    expect(digest("player@example.com").current).toBe(digest(" Player@Example.com ").current);
    expect(digest(normalizedEmail).current).not.toBe(rotated(normalizedEmail).current);
    expect(digest(normalizedEmail).current).not.toBe(digest("other@example.com").current);
    // The legacy digest is unkeyed, so a rotation leaves it recognisable until it expires.
    expect(digest(normalizedEmail).accepted[1]).toBe(rotated(normalizedEmail).accepted[1]);
  });

  it("differs from the legacy unkeyed digest and accepts it for lookups only", () => {
    const digest = createEmailDigester(authSecret)(normalizedEmail);
    const legacy = createHash("sha256").update(normalizedEmail).digest("hex");
    expect(legacyEmailHash("  Player@Example.COM ")).toBe(legacy);
    expect(digest.current).not.toBe(legacy);
    expect(digest.accepted).toEqual([digest.current, legacy]);
  });
});
