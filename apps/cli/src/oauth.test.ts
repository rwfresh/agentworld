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
});
