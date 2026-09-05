import { describe, expect, it, vi } from "vitest";
import { refreshCredentials, revokeCredentials, shouldRefreshCredentials } from "./oauth.ts";

describe("OAuth token lifecycle", () => {
  it("refreshes an expiring session through advertised endpoints and keeps rotation state", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/.well-known/agentworld")) {
        return new Response(
          JSON.stringify({
            authIssuer: "https://play.example.test/api/auth",
            token_endpoint: "https://play.example.test/api/auth/oauth2/token",
          }),
        );
      }
      if (url.endsWith("/.well-known/oauth-authorization-server")) {
        return new Response(
          JSON.stringify({
            token_endpoint: "https://play.example.test/api/auth/oauth2/token",
            revocation_endpoint: "https://play.example.test/api/auth/oauth2/revoke",
          }),
        );
      }
      expect(url).toBe("https://play.example.test/api/auth/oauth2/token");
      const body = new URLSearchParams(String(init?.body));
      expect(body.get("grant_type")).toBe("refresh_token");
      expect(body.get("refresh_token")).toBe("old-refresh");
      expect(body.get("client_id")).toBe("agentworld-cli");
      expect(body.get("resource")).toBe("https://play.example.test");
      return new Response(
        JSON.stringify({
          access_token: "new-access",
          refresh_token: "new-refresh",
          token_type: "Bearer",
          expires_in: 600,
          scope: "world:read offline_access",
        }),
      );
    });

    expect(
      shouldRefreshCredentials(
        {
          accessToken: "old-access",
          refreshToken: "old-refresh",
          expiresAt: "2026-09-02T12:00:20.000Z",
        },
        Date.parse("2026-09-02T12:00:00.000Z"),
      ),
    ).toBe(true);
    const refreshed = await refreshCredentials({
      server: "https://play.example.test",
      credentials: {
        accessToken: "old-access",
        refreshToken: "old-refresh",
        expiresAt: "2026-09-02T12:00:20.000Z",
      },
      fetchImplementation: fetchMock,
      now: () => Date.parse("2026-09-02T12:00:00.000Z"),
    });

    expect(refreshed).toEqual({
      accessToken: "new-access",
      refreshToken: "new-refresh",
      expiresAt: "2026-09-02T12:10:00.000Z",
      scope: "world:read offline_access",
    });
    for (const [, init] of fetchMock.mock.calls) {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it("uses the advertised revocation endpoint and prefers the refresh token", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/.well-known/agentworld")) {
        return new Response(JSON.stringify({ authIssuer: "https://auth.example.test/api/auth" }));
      }
      if (url === "https://play.example.test/.well-known/oauth-authorization-server") {
        return new Response(
          JSON.stringify({ revocation_endpoint: "https://auth.example.test/oauth2/revoke" }),
        );
      }
      expect(url).toBe("https://auth.example.test/oauth2/revoke");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      const body = new URLSearchParams(String(init?.body));
      expect(body.get("token")).toBe("refresh-secret");
      expect(body.get("token_type_hint")).toBe("refresh_token");
      return new Response(null, { status: 200 });
    });

    await expect(
      revokeCredentials({
        server: "https://play.example.test",
        credentials: { accessToken: "access-secret", refreshToken: "refresh-secret" },
        fetchImplementation: fetchMock,
      }),
    ).resolves.toBe("revoked");
  });

  it("does not follow an HTTPS server's advertised downgrade endpoint", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      if (String(input).endsWith("/.well-known/agentworld")) {
        return new Response(JSON.stringify({ token_endpoint: "http://auth.example.test/token" }));
      }
      return new Response(JSON.stringify({}));
    });

    await expect(
      refreshCredentials({
        server: "https://play.example.test",
        credentials: { accessToken: "old", refreshToken: "refresh" },
        fetchImplementation: fetchMock,
      }),
    ).rejects.toMatchObject({ problem: { code: "token_endpoint_unavailable" } });
  });

  it("reports a token endpoint that exceeds the deadline as a retryable timeout", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      if (String(input).endsWith("/.well-known/agentworld")) {
        return new Response(
          JSON.stringify({
            token_endpoint: "https://play.example.test/api/auth/oauth2/token",
            revocation_endpoint: "https://play.example.test/api/auth/oauth2/revoke",
          }),
        );
      }
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    });
    const credentials = { accessToken: "old", refreshToken: "refresh" };

    await expect(
      refreshCredentials({
        server: "https://play.example.test",
        credentials,
        fetchImplementation: fetchMock,
        timeoutMs: 750,
      }),
    ).rejects.toMatchObject({
      exitCode: 6,
      problem: {
        title: "Could not reach the authorization server",
        code: "request_timeout",
        detail: "No response within 750 ms.",
        retryable: true,
      },
    });
    await expect(
      revokeCredentials({
        server: "https://play.example.test",
        credentials,
        fetchImplementation: fetchMock,
        timeoutMs: 750,
      }),
    ).resolves.toBe("failed");
  });

  it("keeps the authorization network error code for non-deadline transport failures", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      if (String(input).endsWith("/.well-known/agentworld")) {
        return new Response(
          JSON.stringify({ token_endpoint: "https://play.example.test/api/auth/oauth2/token" }),
        );
      }
      throw new TypeError("offline");
    });

    await expect(
      refreshCredentials({
        server: "https://play.example.test",
        credentials: { accessToken: "old", refreshToken: "refresh" },
        fetchImplementation: fetchMock,
      }),
    ).rejects.toMatchObject({
      exitCode: 6,
      problem: { code: "authorization_network_error", detail: "offline", retryable: true },
    });
  });
});
