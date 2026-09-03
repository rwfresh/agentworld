import { describe, expect, it } from "vitest";
import { safeRequestLog } from "./app.ts";

describe("request log privacy", () => {
  it("allowlists only the method and drops URL, network, headers, and body canaries", () => {
    const canary = "never-log-device-oauth-magic-invite-email-or-token";
    const serialized = JSON.stringify(
      safeRequestLog({
        method: "POST",
        url: `/api/auth/callback?code=${canary}`,
        remoteAddress: `203.0.113.1-${canary}`,
        headers: { authorization: `Bearer ${canary}` },
        body: { email: `${canary}@example.test`, inviteCode: canary },
      } as { method: string }),
    );
    expect(serialized).toBe('{"method":"POST"}');
    expect(serialized).not.toContain(canary);
  });
});
