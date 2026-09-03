import { describe, expect, it } from "vitest";
import {
  generateInvitationCode,
  invitationHash,
  normalizeEmail,
  normalizeInvitationCode,
} from "./invitation-code.ts";

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
