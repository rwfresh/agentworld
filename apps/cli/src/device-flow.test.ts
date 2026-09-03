import { describe, expect, it, vi } from "vitest";
import { loginWithDevice, parseDeviceAuthorization } from "./device-flow.ts";

describe("device authorization", () => {
  it("accepts standard OAuth device response fields", () => {
    expect(
      parseDeviceAuthorization({
        device_code: "device-secret",
        user_code: "ABCD-EFGH",
        verification_uri: "https://play.example.test/device",
        expires_in: 600,
        interval: 2,
      }),
    ).toMatchObject({ deviceCode: "device-secret", userCode: "ABCD-EFGH", interval: 2 });
  });

  it("discovers endpoints, tolerates pending, and returns tokens", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            device_authorization_endpoint: "/auth/device",
            token_endpoint: "/auth/token",
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            device_code: "device-secret",
            user_code: "ABCD-EFGH",
            verification_uri: "https://play.example.test/device",
            expires_in: 60,
            interval: 1,
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "authorization_pending" }), { status: 400 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: "access", refresh_token: "refresh" })),
      );
    let clock = 0;
    const token = await loginWithDevice({
      server: "https://play.example.test",
      scopes: ["world:read"],
      fetchImplementation: fetchMock,
      sleep: async (milliseconds) => {
        clock += milliseconds;
      },
      now: () => clock,
    });
    expect(token).toEqual({ accessToken: "access", refreshToken: "refresh" });
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe("https://play.example.test/auth/device");
    const authorizationBody = fetchMock.mock.calls[1]?.[1]?.body;
    expect(new URLSearchParams(String(authorizationBody)).get("scope")).toBe(
      "world:read offline_access",
    );
  });

  it("rejects authorization and verification downgrades from an HTTPS server", async () => {
    const issuerDowngrade = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          authIssuer: "http://auth.example.test",
          device_authorization_endpoint: "http://auth.example.test/device",
        }),
      ),
    );
    await expect(
      loginWithDevice({
        server: "https://play.example.test",
        scopes: ["world:read"],
        fetchImplementation: issuerDowngrade,
      }),
    ).rejects.toMatchObject({ problem: { code: "invalid_authorization_endpoint" } });

    const verificationDowngrade = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            authIssuer: "https://auth.example.test",
            device_authorization_endpoint: "https://auth.example.test/device",
            token_endpoint: "https://auth.example.test/token",
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            device_code: "device",
            user_code: "CODE",
            verification_uri: "http://auth.example.test/device",
            expires_in: 600,
            interval: 5,
          }),
        ),
      );
    await expect(
      loginWithDevice({
        server: "https://play.example.test",
        scopes: ["world:read"],
        fetchImplementation: verificationDowngrade,
      }),
    ).rejects.toMatchObject({ problem: { code: "invalid_authorization_endpoint" } });
  });
});
