import type {
  ActionReceipt,
  AllianceInviteResponse,
  InventoryResponse,
  LeaderboardResponse,
  LookResponse,
  ScanActionReceipt,
} from "@agentworld/api-contract";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { AgentWorldApiError, createClient } from "../src/index.ts";

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
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify(scanReceipt), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
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
      .mockResolvedValueOnce(
        new Response(JSON.stringify(scanReceipt), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    const client = createClient({ baseUrl: "https://play.example.test", fetch: fetchMock });

    const receipt = client.setHostility("world-one", "player-two", true, "hostility-once");

    expectTypeOf(receipt).toEqualTypeOf<Promise<ActionReceipt>>();
    await expect(receipt).resolves.toEqual(scanReceipt);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [, init] of fetchMock.mock.calls) {
      expect(init?.method).toBe("PUT");
      expect(new Headers(init?.headers).get("idempotency-key")).toBe("hostility-once");
    }
  });
});
