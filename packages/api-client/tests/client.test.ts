import type {
  ActionReceipt,
  AllianceAdministrationResponse,
  AllianceInviteAcceptResponse,
  AllianceInviteResponse,
  InventoryResponse,
  LeaderboardResponse,
  LookResponse,
  ScanActionReceipt,
} from "@agentworld/api-contract";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { AgentWorldApiError, createClient, defaultTimeoutMs } from "../src/index.ts";

const scanResult: LookResponse = {
  origin: { x: 12, y: 9 },
  radius: 3,
  tick: 41,
  tiles: [],
};

const scanReceipt: ScanActionReceipt = {
  actionId: "01991e7a-7d33-7f41-801c-1e9b5c82ef71",
  idempotencyKey: "scan-once",
  status: "completed",
  effectiveTick: 41,
  result: scanResult,
  events: [],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A transport that only ever finishes when its attempt signal aborts. */
function hangingFetch() {
  return vi.fn<typeof fetch>(
    (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) {
          reject(new Error("expected an attempt signal"));
          return;
        }
        if (signal.aborted) {
          reject(signal.reason);
          return;
        }
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
  );
}

describe("AgentWorld API client", () => {
  it("rejects credential-bearing cleartext remote origins", () => {
    expect(() =>
      createClient({ baseUrl: "http://play.example.test", accessToken: "secret" }),
    ).toThrow(/HTTPS/);
    expect(() => createClient({ baseUrl: "https://user:secret@play.example.test" })).toThrow(
      /credentials/,
    );
    expect(() => createClient({ baseUrl: "http://localhost:3000" })).not.toThrow();
  });

  it("returns the typed visibility result from scan", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(scanReceipt));
    const client = createClient({
      baseUrl: "https://play.example.test/",
      accessToken: "access-token",
      fetch: fetchMock,
    });

    const receipt = await client.scan("world/one", "scan-once");

    expectTypeOf(receipt.result).toEqualTypeOf<LookResponse>();
    expect(receipt.result).toEqual(scanResult);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://play.example.test/v1/worlds/world%2Fone/actions/scan");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer access-token");
    expect(new Headers(init?.headers).get("idempotency-key")).toBe("scan-once");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("throws structured API problems", async () => {
    const problem = {
      type: "about:blank",
      title: "Not enough inference",
      status: 409,
      code: "INSUFFICIENT_RESOURCES",
      detail: "Scan requires five Inference.",
      requestId: "request-one",
      retryable: false,
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify(problem), { status: 409 }));
    const client = createClient({ baseUrl: "https://play.example.test", fetch: fetchMock });

    await expect(client.scan("world-one", "scan-once")).rejects.toEqual(
      new AgentWorldApiError(problem),
    );
  });

  it("synthesizes a problem when a gateway answers with HTML", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("<html><body>502 Bad Gateway</body></html>", {
        status: 502,
        headers: { "content-type": "text/html", "x-request-id": "edge-502" },
      }),
    );
    const client = createClient({ baseUrl: "https://play.example.test", fetch: fetchMock });

    const failure = await client.status("world-one").catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AgentWorldApiError);
    expect(failure).toMatchObject({
      problem: {
        type: "about:blank",
        title: "Request failed (502)",
        status: 502,
        code: "HTTP_502",
        requestId: "edge-502",
        retryable: true,
      },
    });
    const apiError = failure as AgentWorldApiError;
    expect(apiError.status).toBe(502);
    expect(apiError.code).toBe("HTTP_502");
    expect(apiError.requestId).toBe("edge-502");
    expect(apiError.retryable).toBe(true);
  });

  it("synthesizes a non-retryable problem for an empty 401", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 401 }));
    const client = createClient({ baseUrl: "https://play.example.test", fetch: fetchMock });

    await expect(client.worlds()).rejects.toMatchObject({
      name: "AgentWorldApiError",
      problem: {
        title: "Request failed (401)",
        status: 401,
        code: "HTTP_401",
        requestId: "",
        retryable: false,
      },
    });
  });

  it("marks empty 429 and 500 failures retryable", async () => {
    for (const status of [429, 500]) {
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response("", { status }));
      const client = createClient({ baseUrl: "https://play.example.test", fetch: fetchMock });
      await expect(client.worlds()).rejects.toMatchObject({
        problem: { status, code: `HTTP_${status}`, retryable: true },
      });
    }
  });

  it("takes the status from the response when a problem body omits it", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        jsonResponse({ title: "Expired", code: "INVALID_ACCESS_TOKEN", retryAfter: -1 }, 401),
      );
    const client = createClient({ baseUrl: "https://play.example.test", fetch: fetchMock });

    const failure = await client.worlds().catch((error: unknown) => error);

    expect(failure).toMatchObject({
      problem: { title: "Expired", status: 401, code: "INVALID_ACCESS_TOKEN", retryable: false },
    });
    expect((failure as AgentWorldApiError).problem).not.toHaveProperty("retryAfter");
  });

  it("resolves empty successful bodies without parsing", async () => {
    for (const response of [
      new Response(null, { status: 204 }),
      new Response("", { status: 200 }),
      new Response(null, { status: 205 }),
    ]) {
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response);
      const client = createClient({ baseUrl: "https://play.example.test", fetch: fetchMock });
      await expect(client.setBlock("world-one", "player-two", false, "block-once")).resolves.toBe(
        undefined,
      );
    }
  });

  it("treats a non-JSON success body as a transport failure, not an API problem", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("<html>captive portal</html>", { status: 200 }));
    const client = createClient({ baseUrl: "https://play.example.test", fetch: fetchMock });

    const failure = await client.worlds().catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(TypeError);
    expect(failure).not.toBeInstanceOf(AgentWorldApiError);
  });

  it("uses canonical inventory and leaderboard response types", () => {
    const client = createClient({ baseUrl: "https://play.example.test" });

    expectTypeOf(client.inventory("world-one")).toEqualTypeOf<Promise<InventoryResponse>>();
    expectTypeOf(client.leaderboard("world-one")).toEqualTypeOf<Promise<LeaderboardResponse>>();
  });

  it("returns the typed alliance invitation receipt", () => {
    const client = createClient({ baseUrl: "https://play.example.test" });

    expectTypeOf(
      client.inviteToAlliance(
        "world-one",
        "alliance-one",
        { playerId: "player-two" },
        "invite-once",
      ),
    ).toEqualTypeOf<Promise<AllianceInviteResponse>>();
  });

  it("sends an idempotency key for hostility and returns its action receipt", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("connection reset"))
      .mockResolvedValueOnce(jsonResponse(scanReceipt));
    const client = createClient({ baseUrl: "https://play.example.test", fetch: fetchMock });

    const receipt = client.setHostility("world-one", "player-two", true, "hostility-once");

    expectTypeOf(receipt).toEqualTypeOf<Promise<ActionReceipt>>();
    await expect(receipt).resolves.toEqual(scanReceipt);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [, init] of fetchMock.mock.calls) {
      expect(init?.method).toBe("PUT");
      expect(new Headers(init?.headers).get("idempotency-key")).toBe("hostility-once");
    }
    const [first, second] = fetchMock.mock.calls.map(([, init]) => init?.signal);
    expect(first).toBeInstanceOf(AbortSignal);
    expect(second).toBeInstanceOf(AbortSignal);
    expect(second).not.toBe(first);
  });

  describe("alliance administration", () => {
    const acceptance: AllianceInviteAcceptResponse = {
      accepted: true,
      allianceId: "01991e7a-7d33-7f41-801c-1e9b5c82ef72",
    };
    const administration: AllianceAdministrationResponse = {
      ok: true,
      operation: "leadership",
      allianceId: "01991e7a-7d33-7f41-801c-1e9b5c82ef72",
      playerId: "01991e7a-7d33-7f41-801c-1e9b5c82ef73",
    };

    it("accepts an invitation with an empty body and the mutation key", async () => {
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(acceptance));
      const client = createClient({ baseUrl: "https://play.example.test", fetch: fetchMock });

      const receipt = client.acceptAllianceInvite("world-one", "invite/one", "accept-once");

      expectTypeOf(receipt).toEqualTypeOf<Promise<AllianceInviteAcceptResponse>>();
      await expect(receipt).resolves.toEqual(acceptance);
      const [url, init] = fetchMock.mock.calls[0] ?? [];
      expect(String(url)).toBe(
        "https://play.example.test/v1/worlds/world-one/alliance-invites/invite%2Fone/accept",
      );
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({});
      expect(new Headers(init?.headers).get("idempotency-key")).toBe("accept-once");
    });

    it("leaves, transfers leadership, and disbands through the canonical routes", async () => {
      // A Response body is single-use, so every call gets its own instance.
      const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(jsonResponse(administration)));
      const client = createClient({ baseUrl: "https://play.example.test", fetch: fetchMock });

      const leave = client.leaveAlliance("world-one", "alliance-one", "leave-once");
      expectTypeOf(leave).toEqualTypeOf<Promise<AllianceAdministrationResponse>>();
      await expect(leave).resolves.toEqual(administration);
      await client.transferAllianceLeadership(
        "world-one",
        "alliance-one",
        "player-two",
        "lead-once",
      );
      await client.disbandAlliance("world-one", "alliance-one", "disband-once");

      const calls = fetchMock.mock.calls.map(([url, init]) => ({
        url: String(url),
        method: init?.method,
        body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
        key: new Headers(init?.headers).get("idempotency-key"),
      }));
      expect(calls).toEqual([
        {
          url: "https://play.example.test/v1/worlds/world-one/alliances/alliance-one/leave",
          method: "POST",
          body: {},
          key: "leave-once",
        },
        {
          url: "https://play.example.test/v1/worlds/world-one/alliances/alliance-one/leadership",
          method: "POST",
          body: { playerId: "player-two" },
          key: "lead-once",
        },
        {
          url: "https://play.example.test/v1/worlds/world-one/alliances/alliance-one",
          method: "DELETE",
          body: undefined,
          key: "disband-once",
        },
      ]);
    });
  });

  describe("deadlines and cancellation", () => {
    it("defaults to a thirty second attempt deadline and validates overrides", () => {
      expect(defaultTimeoutMs).toBe(30_000);
      for (const timeoutMs of [0, -1, 1.5, Number.NaN, 2 ** 31, Number.MAX_SAFE_INTEGER + 1]) {
        expect(() => createClient({ baseUrl: "https://play.example.test", timeoutMs })).toThrow(
          TypeError,
        );
      }
      expect(() =>
        createClient({ baseUrl: "https://play.example.test", timeoutMs: 2 ** 31 - 1 }),
      ).not.toThrow();
    });

    it("gives each attempt its own deadline and retries a timeout once", async () => {
      const fetchMock = hangingFetch();
      const client = createClient({
        baseUrl: "https://play.example.test",
        fetch: fetchMock,
        timeoutMs: 5,
      });

      await expect(
        client.move("world-one", { direction: "north" }, "move-once"),
      ).rejects.toMatchObject({ name: "TimeoutError" });

      expect(fetchMock).toHaveBeenCalledTimes(2);
      const [first, second] = fetchMock.mock.calls.map(([, init]) => init?.signal);
      expect(first?.aborted).toBe(true);
      expect(second?.aborted).toBe(true);
      expect(second).not.toBe(first);
      for (const [, init] of fetchMock.mock.calls) {
        expect(new Headers(init?.headers).get("idempotency-key")).toBe("move-once");
      }
    });

    it("propagates a caller abort without retrying", async () => {
      const controller = new AbortController();
      const fetchMock = vi.fn<typeof fetch>((_input, init) => {
        controller.abort();
        return Promise.reject(init?.signal?.reason);
      });
      const client = createClient({ baseUrl: "https://play.example.test", fetch: fetchMock });

      await expect(client.worlds({ signal: controller.signal })).rejects.toMatchObject({
        name: "AbortError",
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    });

    it("propagates a custom abort reason and never contacts the server once aborted", async () => {
      const controller = new AbortController();
      controller.abort(new Error("user cancelled"));
      const fetchMock = vi.fn<typeof fetch>();
      const client = createClient({ baseUrl: "https://play.example.test", fetch: fetchMock });

      await expect(client.status("world-one", { signal: controller.signal })).rejects.toThrow(
        "user cancelled",
      );

      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});
