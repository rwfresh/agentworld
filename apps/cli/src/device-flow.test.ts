import { describe, expect, it, vi } from "vitest";
import { loginWithDevice, parseDeviceAuthorization } from "./device-flow.ts";

const authorization = {
  device_code: "device-secret",
  user_code: "ABCD-EFGH",
  verification_uri: "https://play.example.test/device",
};

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

  it("falls back to the RFC 8628 defaults when timing fields are absent", () => {
    expect(parseDeviceAuthorization(authorization)).toMatchObject({
      expiresIn: 600,
      interval: 5,
    });
  });

  it.each([
    [0, 5],
    [-3, 5],
    [2.5, 5],
    [Number.NaN, 5],
    [Number.POSITIVE_INFINITY, 5],
    [Number.MAX_SAFE_INTEGER + 2, 5],
    ["5", 5],
    [1, 1],
    [30, 30],
    [60, 60],
    [61, 60],
    [2 ** 31, 60],
  ])("bounds a polling interval of %p to %i seconds", (interval, expected) => {
    expect(parseDeviceAuthorization({ ...authorization, interval }).interval).toBe(expected);
  });

  it.each([
    [0, 600],
    [-1, 600],
    [1.5, 600],
    [Number.NaN, 600],
    [Number.POSITIVE_INFINITY, 600],
    [2 ** 53, 600],
    ["600", 600],
    [1, 30],
    [30, 30],
    [900, 900],
    [1_800, 1_800],
    [1_801, 1_800],
    [1e12, 1_800],
  ])("bounds a code lifetime of %p to %i seconds", (expiresIn, expected) => {
    expect(parseDeviceAuthorization({ ...authorization, expires_in: expiresIn }).expiresIn).toBe(
      expected,
    );
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
    for (const [, init] of fetchMock.mock.calls) {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it("caps slow_down back-off at the polling ceiling", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({})))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ...authorization, expires_in: 600, interval: 58 })),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "slow_down" }), { status: 400 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "slow_down" }), { status: 400 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "access" })));
    const sleeps: number[] = [];
    let clock = 0;

    await loginWithDevice({
      server: "https://play.example.test",
      scopes: ["world:read"],
      fetchImplementation: fetchMock,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
        clock += milliseconds;
      },
      now: () => clock,
    });

    expect(sleeps).toEqual([58_000, 60_000, 60_000]);
  });

  it.each([
    [600, 600],
    [1.5, undefined],
    [0, undefined],
    [Number.MAX_SAFE_INTEGER + 2, undefined],
  ])(
    "keeps a token lifetime of %p only when it is a positive safe integer",
    async (expiresIn, expected) => {
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(new Response(JSON.stringify({})))
        .mockResolvedValueOnce(new Response(JSON.stringify({ ...authorization, interval: 1 })))
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ access_token: "access", expires_in: expiresIn })),
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

      expect(token.expiresIn).toBe(expected);
    },
  );

  it("reports an authorization server that exceeds the deadline as a retryable timeout", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      if (String(input).endsWith("/.well-known/agentworld")) {
        return new Response(JSON.stringify({}));
      }
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    });

    await expect(
      loginWithDevice({
        server: "https://play.example.test",
        scopes: ["world:read"],
        fetchImplementation: fetchMock,
        timeoutMs: 1_000,
      }),
    ).rejects.toMatchObject({
      exitCode: 6,
      problem: {
        title: "Could not reach the authorization server",
        code: "request_timeout",
        detail: "No response within 1000 ms.",
        retryable: true,
      },
    });
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
